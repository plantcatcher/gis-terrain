import type { DEMGrid, ViewshedResult } from '../../types'

/* =========================================================================
   视域分析（Viewshed / 通视范围）

   做法：从观察点向四周发射射线，逐格推进并记录「到目前为止的最大仰角」，
   仰角超过历史最大值的像元即可见 —— 这是视线通高的标准判据，等价于
   逐像元做通视测试，但只需 O(射线数 × 半径) 而不是 O(像元数 × 距离)。

   两个必须显式处理的物理量，否则结果会明显偏乐观：

   1. **地球曲率**。5km 处地表已经比切平面低约 1.7m，10km 处约 6.8m。
       不做修正的话，远山会被"拉回"视野里，视域在远处虚胖一圈。
       公式 drop = (1−k)·d²/(2R)，k=0.13 是标准大气折射系数。
   2. **观察高度**。眼睛贴地时地平线距离为 0，平坦地形将"什么都看不见"。
       默认给 2m 人眼高度，平原也能算出合理的通视范围。
   ========================================================================= */

const EARTH_R = 6371000
/** 大气折射系数（标准值 0.13）：等效于把地球半径放大 1/(1−k) 倍 */
const REFRACTION_K = 0.13

export interface ViewshedOptions {
  /** 搜索半径 km，默认 5 */
  radiusKm?: number
  /** 观察点离地高度 m，默认 2（人眼） */
  observerHeightM?: number
}

/** 双线性采样；越界或无效返回 NaN */
function sampleBilinear(
  grid: DEMGrid,
  lon: number,
  lat: number,
): number {
  const { minLon, minLat, maxLon, maxLat, cols, rows, elevations, mask } = grid
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return NaN
  const sx = ((lon - minLon) / (maxLon - minLon)) * cols - 0.5
  const sy = ((lat - minLat) / (maxLat - minLat)) * rows - 0.5
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const fx = sx - x0
  const fy = sy - y0
  let sum = 0
  let wsum = 0
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const c = Math.min(cols - 1, Math.max(0, x0 + dx))
      const r = Math.min(rows - 1, Math.max(0, y0 + dy))
      const i = r * cols + c
      if (!mask[i]) continue
      const z = elevations[i]
      if (!isFinite(z)) continue
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
      sum += z * w
      wsum += w
    }
  }
  return wsum > 1e-9 ? sum / wsum : NaN
}

/**
 * 计算视域。
 * @returns 观察点落在分析网格之外（或该点无高程）时返回 null
 */
export function computeViewshed(
  grid: DEMGrid,
  lon: number,
  lat: number,
  resolutionM: number,
  opts: ViewshedOptions = {},
): ViewshedResult | null {
  const { minLon, minLat, maxLon, maxLat, cols, rows, mask } = grid
  const radiusKm = opts.radiusKm ?? 5
  const eyeM = opts.observerHeightM ?? 2

  const groundZC = sampleBilinear(grid, lon, lat)
  if (!isFinite(groundZC)) return null
  const zObs = groundZC + eyeM

  // mask 三态：0=未采样 / 1=可见 / 2=已判为被遮挡
  const out = new Uint8Array(cols * rows)
  const radiusM = radiusKm * 1000
  const cellM = resolutionM
  // 径向步长取 0.6 格：相邻采样点必然落在同一格或紧邻格，避免掩膜出现麻点
  const stepM = Math.max(1, cellM * 0.6)
  const steps = Math.max(1, Math.ceil(radiusM / stepM))
  // 方位角采样数按「最远处弧长 ≈ 1 格」定，再用下限兜住小半径的情况
  const rayCount = Math.min(
    2880,
    Math.max(720, Math.ceil((2 * Math.PI * radiusM) / Math.max(1, cellM))),
  )

  const latPerDeg = 111320
  const lonPerDeg = 111320 * Math.cos((lat * Math.PI) / 180)

  const cellAreaKm2 = (cellM / 1000) ** 2
  let visibleCells = 0
  let validCells = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) validCells++

  const toCol = (l: number) => Math.round(((l - minLon) / (maxLon - minLon)) * cols - 0.5)
  const toRow = (b: number) => Math.round(((b - minLat) / (maxLat - minLat)) * rows - 0.5)

  const obsCol = toCol(lon)
  const obsRow = toRow(lat)
  if (obsCol >= 0 && obsCol < cols && obsRow >= 0 && obsRow < rows) {
    const i = obsRow * cols + obsCol
    if (mask[i]) {
      out[i] = 1
      visibleCells++
    }
  }

  for (let a = 0; a < rayCount; a++) {
    const theta = (a / rayCount) * Math.PI * 2
    // 0° = 正北，顺时针。北向分量 cos、东向分量 sin
    const stepLat = ((stepM * Math.cos(theta)) / latPerDeg)
    const stepLon = (stepM * Math.sin(theta)) / lonPerDeg
    let curLon = lon
    let curLat = lat
    let maxAngle = -Infinity
    for (let s = 1; s <= steps; s++) {
      curLon += stepLon
      curLat += stepLat
      if (curLon < minLon || curLon > maxLon || curLat < minLat || curLat > maxLat) break
      const col = toCol(curLon)
      const row = toRow(curLat)
      if (col < 0 || col >= cols || row < 0 || row >= rows) break
      const idx = row * cols + col
      if (!mask[idx]) continue
      const z = sampleBilinear(grid, curLon, curLat)
      if (!isFinite(z)) continue
      const d = s * stepM
      const drop = ((1 - REFRACTION_K) * d * d) / (2 * EARTH_R)
      const angle = (z - drop - zObs) / d
      if (angle > maxAngle) {
        maxAngle = angle
        if (out[idx] !== 1) {
          out[idx] = 1
          visibleCells++
        }
      } else if (out[idx] === 0) {
        out[idx] = 2
      }
    }
  }

  return {
    lon,
    lat,
    observerElev: groundZC,
    visibleCells,
    visibleKm2: visibleCells * cellAreaKm2,
    visibleRatio: validCells > 0 ? visibleCells / validCells : 0,
    rayCount,
    mask: out,
  }
}
