import type { Feature, Polygon } from 'geojson'
import { geodesicArea } from './geo'

export const MAX_AREA_KM2 = 100
export const MAX_VERTICES = 100

export interface ValidationResult {
  ok: boolean
  reason?: string
  areaKm2?: number
}

/** 检查多边形是否自相交（简单线段相交检测） */
export function isSelfIntersecting(polygon: Feature<Polygon>): boolean {
  const ring = polygon.geometry.coordinates[0]
  if (!ring || ring.length < 4) return false
  // 开放环（首尾相同则去掉重复末点）
  const pts = [...ring]
  if (pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts.pop()
  }
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a1 = pts[i]
    const a2 = pts[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      // 相邻边共享端点不算相交
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      const b1 = pts[j]
      const b2 = pts[(j + 1) % n]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return false
}

function segmentsIntersect(
  p1: number[],
  p2: number[],
  p3: number[],
  p4: number[],
): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  if (Math.abs(d) < 1e-12) return false
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

export function validateArea(polygon: Feature<Polygon>): ValidationResult {
  const ring = polygon.geometry.coordinates[0]
  const vertices = ring ? Math.max(0, ring.length - 1) : 0
  if (vertices > MAX_VERTICES) {
    return {
      ok: false,
      reason: `多边形顶点过多（${vertices}），最多允许 ${MAX_VERTICES} 个。`,
    }
  }
  if (vertices < 3) {
    return { ok: false, reason: '选择区域至少需要 3 个顶点。' }
  }
  if (isSelfIntersecting(polygon)) {
    return { ok: false, reason: '选择区域存在交叉，请重新绘制。' }
  }
  const areaKm2 = geodesicArea(polygon) / 1_000_000
  if (areaKm2 > MAX_AREA_KM2) {
    return {
      ok: false,
      areaKm2,
      reason: `当前区域超过 ${MAX_AREA_KM2} km²，请缩小分析范围。`,
    }
  }
  if (areaKm2 <= 0) {
    return { ok: false, reason: '选择区域无效。' }
  }
  return { ok: true, areaKm2 }
}

/** 根据面积自动选择 DEM 采样分辨率，控制总采样点数 */
export function autoResolution(areaKm2: number, bboxAreaKm2?: number): number {
  // 目标：网格总点数 <= MAX_POINTS。提高目标点数让地形图更清晰（之前 9000 偏粗）。
  const MAX_POINTS = 30000
  const sideKm = Math.sqrt(areaKm2)
  let resolution = (sideKm * 1000) / Math.sqrt(MAX_POINTS)
  // 若 bbox 远大于多边形面积（细长/狭长选区），用 bbox 反推一个更粗的下限，
  // 防止在巨大 bbox 上以极小分辨率建网格导致浏览器 OOM。
  if (bboxAreaKm2 && bboxAreaKm2 > 0) {
    const bboxRes = Math.sqrt((bboxAreaKm2 * 1_000_000) / MAX_POINTS)
    if (bboxRes > resolution) resolution = bboxRes
  }
  // 限制范围：不低于 12m，不高于 250m。Open-Meteo 数据源为 Copernicus GLO-30（30m 原生），
  // 12m 以下为插值，过细则请求量过大且易触发限流。
  resolution = Math.max(12, Math.min(250, Math.round(resolution)))
  return resolution
}
