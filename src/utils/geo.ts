import * as turf from '@turf/turf'
import type { Feature, Polygon, Position } from 'geojson'

const R = 6378137 // 地球半径 m

/** 测地面积 (m²)，使用球面梯形公式，适合中小区域 */
export function geodesicArea(polygon: Feature<Polygon> | Polygon): number {
  const coords =
    'geometry' in polygon ? polygon.geometry.coordinates : polygon.coordinates
  if (!coords || coords.length === 0) return 0

  let total = 0
  // 外环面积 - 内环面积
  for (let i = 0; i < coords.length; i++) {
    const ring = coords[i]
    total += (i === 0 ? 1 : -1) * ringArea(ring)
  }
  return Math.abs(total)
}

function ringArea(ring: Position[]): number {
  if (ring.length < 3) return 0
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i]
    const [lon2, lat2] = ring[i + 1]
    area +=
      ((lon2 - lon1) * (Math.PI / 180)) *
      (2 + Math.sin((lat1 * Math.PI) / 180) + Math.sin((lat2 * Math.PI) / 180))
  }
  area = (area * R * R) / 2
  return area
}

/** 两点测地距离 (m) */
export function distanceMeters(p1: Position, p2: Position): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(p2[1] - p1[1])
  const dLon = toRad(p2[0] - p1[0])
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1[1])) * Math.cos(toRad(p2[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** 线的总长度 (km) */
export function lineLengthKm(coords: Position[]): number {
  let total = 0
  for (let i = 0; i < coords.length - 1; i++) {
    total += distanceMeters(coords[i], coords[i + 1])
  }
  return total / 1000
}

/** 多边形质心 */
export function centroid(polygon: Feature<Polygon>): Position {
  const c = turf.centroid(polygon).geometry.coordinates
  return c
}

/**
 * 环的平面质心（面积加权，鞋带公式），用于把面积标签摆在矢量正中央。
 * 面积退化时退回 bbox 中心，保证一定落在图形中部。
 * 注：环需闭合（首尾点相同），与 GeoJSON 外环一致。
 */
export function ringCentroid(ring: Position[]): Position {
  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    const cross = x1 * y2 - x2 * y1
    twiceArea += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (Math.abs(twiceArea) > 1e-12) {
    return [cx / (3 * twiceArea), cy / (3 * twiceArea)]
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

/** 多边形 bbox [minLon, minLat, maxLon, maxLat] */
export function bboxOf(polygon: Feature<Polygon>): [number, number, number, number] {
  const b = turf.bbox(polygon)
  return [b[0], b[1], b[2], b[3]]
}

/** 经纬度每度近似米数 */
export function metersPerDegree(lat: number): { lat: number; lon: number } {
  const latM = 111320
  const lonM = 111320 * Math.cos((lat * Math.PI) / 180)
  return { lat: latM, lon: lonM }
}

/** 判断点是否在多边形内（射线法） */
export function pointInPolygon(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** 在 bbox 内生成规则网格点，并标记是否落在多边形内 */
export function sampleGrid(
  polygon: Feature<Polygon>,
  resolutionM: number,
): {
  points: Position[]
  cols: number
  rows: number
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
  mask: Uint8Array
} {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(polygon)
  const centerLat = (minLat + maxLat) / 2
  const { lat: latPerDeg, lon: lonPerDeg } = metersPerDegree(centerLat)
  let dLon = resolutionM / lonPerDeg
  let dLat = resolutionM / latPerDeg
  let cols = Math.max(2, Math.ceil((maxLon - minLon) / dLon))
  let rows = Math.max(2, Math.ceil((maxLat - minLat) / dLat))
  // 安全封顶：极端细长/巨型 bbox 时，进一步粗化步长（仍覆盖整个 bbox），
  // 避免分配数亿格的 Float32Array / 对象数组导致浏览器 OOM。
  const MAX_DIM = 1800
  if (cols > MAX_DIM || rows > MAX_DIM) {
    const scale = Math.max(cols, rows) / MAX_DIM
    dLon *= scale
    dLat *= scale
    cols = Math.max(2, Math.ceil((maxLon - minLon) / dLon))
    rows = Math.max(2, Math.ceil((maxLat - minLat) / dLat))
  }
  const stepLon = (maxLon - minLon) / cols
  const stepLat = (maxLat - minLat) / rows

  const ring = polygon.geometry.coordinates[0]
  const points: Position[] = []
  const mask = new Uint8Array(cols * rows)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lon = minLon + (c + 0.5) * stepLon
      const lat = minLat + (r + 0.5) * stepLat
      points.push([lon, lat])
      if (pointInPolygon(lon, lat, ring)) {
        mask[r * cols + c] = 1
      }
    }
  }
  return { points, cols, rows, minLon, minLat, maxLon, maxLat, mask }
}

/** 沿线段按固定间距 (m) 采样点 */
export function sampleLine(
  coords: Position[],
  spacingM: number,
): Position[] {
  if (coords.length === 0) return []
  const result: Position[] = [coords[0]]
  let acc = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const segLen = distanceMeters(coords[i], coords[i + 1])
    if (segLen === 0) continue
    let remaining = segLen
    while (acc + spacingM <= remaining) {
      acc += spacingM
      const t = acc / segLen
      result.push([
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
      ])
    }
    acc -= remaining
  }
  const last = coords[coords.length - 1]
  if (
    result[result.length - 1][0] !== last[0] ||
    result[result.length - 1][1] !== last[1]
  ) {
    result.push(last)
  }
  return result
}
