import type { Position } from 'geojson'
import type { DEMGrid, ProfileResult } from '../../types'
import { sampleLine, distanceMeters, lineLengthKm } from '../../utils/geo'

/**
 * 沿折线采样并生成高程剖面。
 * elevationFn: 根据经纬度返回高程（从已有的 DEM 网格或外部查询）
 */
export function computeProfile(
  coords: Position[],
  elevationFn: (lon: number, lat: number) => number,
  spacingM = 50,
): ProfileResult {
  if (coords.length < 2) {
    return {
      points: [],
      distanceKm: 0,
      minElevation: NaN,
      maxElevation: NaN,
      climb: 0,
      descent: 0,
      avgSlope: 0,
      startElev: NaN,
      endElev: NaN,
    }
  }
  const samples = sampleLine(coords, spacingM)
  const points = samples.map((p, i) => ({
    distance:
      i === 0
        ? 0
        : distanceMeters(samples[i - 1], p) / 1000,
    elevation: elevationFn(p[0], p[1]),
    lon: p[0],
    lat: p[1],
  }))

  // 累加距离
  let acc = 0
  for (const p of points) {
    acc += p.distance
    p.distance = acc
  }

  const distanceKm = lineLengthKm(coords)
  const validElev = points.map((p) => p.elevation).filter((e) => isFinite(e))
  const minElevation = validElev.length ? Math.min(...validElev) : NaN
  const maxElevation = validElev.length ? Math.max(...validElev) : NaN

  let climb = 0
  let descent = 0
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].elevation
    const cur = points[i].elevation
    if (!isFinite(prev) || !isFinite(cur)) continue
    const diff = cur - prev
    if (diff > 0) climb += diff
    else descent -= diff
  }

  const avgSlope =
    distanceKm > 0 ? (Math.atan((climb + descent) / 1000 / (distanceKm || 1)) * 180) / Math.PI : 0

  return {
    points,
    distanceKm,
    minElevation,
    maxElevation,
    climb,
    descent,
    avgSlope: isFinite(avgSlope) ? avgSlope : 0,
    startElev: points[0]?.elevation ?? NaN,
    endElev: points[points.length - 1]?.elevation ?? NaN,
  }
}

/** 从 DEMGrid 构建高程查询函数（双线性插值） */
export function makeGridElevationFn(
  grid: DEMGrid,
): (lon: number, lat: number) => number {
  const { cols, rows, minLon, minLat, maxLon, maxLat, elevations } = grid
  const lonStep = (maxLon - minLon) / cols
  const latStep = (maxLat - minLat) / rows
  return (lon: number, lat: number) => {
    const fx = (lon - minLon) / lonStep - 0.5
    const fy = (lat - minLat) / latStep - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const x1 = x0 + 1
    const y1 = y0 + 1
    if (x0 < 0 || y0 < 0 || x1 >= cols || y1 >= rows) return NaN
    const tx = fx - x0
    const ty = fy - y0
    const e00 = elevations[y0 * cols + x0]
    const e10 = elevations[y0 * cols + x1]
    const e01 = elevations[y1 * cols + x0]
    const e11 = elevations[y1 * cols + x1]
    const valid = [e00, e10, e01, e11].filter((e) => isFinite(e))
    if (valid.length === 0) return NaN
    if (valid.length < 4) {
      // 退化：用最近有效值
      return valid[0]
    }
    const e =
      e00 * (1 - tx) * (1 - ty) +
      e10 * tx * (1 - ty) +
      e01 * (1 - tx) * ty +
      e11 * tx * ty
    return e
  }
}
