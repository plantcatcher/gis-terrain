import type { Feature, Polygon, Position } from 'geojson'
import type { DEMProvider } from './DEMProvider'
import { OpenMeteoProvider } from './OpenMeteoProvider'
import { TerrariumProvider } from './TerrariumProvider'
import { sampleGrid } from '../../utils/geo'
import type { DEMGrid } from '../../types'

/**
 * 默认 DEM 数据源：直接复用「DEM 底图」的同一份全球高程瓦片，
 * 前端本地解码成高程矩阵后采样。一次分析通常只要 4~36 个瓦片请求，
 * 相比逐点 REST 接口（3 万采样点 ≈ 数百次请求）快一个数量级。
 * 瓦片源整体不可用时自动回退到 Open-Meteo 逐点接口。
 */
export let defaultProvider: DEMProvider = new TerrariumProvider(new OpenMeteoProvider())

export function setDEMProvider(p: DEMProvider) {
  defaultProvider = p
}

export function getDEMProvider(): DEMProvider {
  return defaultProvider
}

/** 当前生效的数据源名（瓦片源回退时会是兜底源），用于界面提示 */
export function getDEMProviderName(): string {
  const p = defaultProvider as DEMProvider & { lastSource?: string }
  return p.lastSource ?? p.name
}

/**
 * 对多边形区域进行规则网格采样并获取高程。
 * 返回 DEMGrid（含掩膜，仅区域内像元有效）。
 */
export async function fetchDEMGrid(
  polygon: Feature<Polygon>,
  resolutionM: number,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<DEMGrid> {
  const { points, cols, rows, minLon, minLat, maxLon, maxLat, mask } =
    sampleGrid(polygon, resolutionM)

  // 只查询区域内的点以节省请求
  const insideIdx: number[] = []
  const insidePts: Position[] = []
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      insideIdx.push(i)
      insidePts.push(points[i])
    }
  }

  const elevations = new Float32Array(cols * rows).fill(NaN)

  if (insidePts.length > 0) {
    const provider = getDEMProvider()
    let done = 0
    const els = await provider.queryElevations(insidePts, {
      onProgress: () => {
        done++
        onProgress?.(done / Math.max(1, insidePts.length))
      },
      signal,
      resolutionM,
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    for (let k = 0; k < insideIdx.length; k++) {
      elevations[insideIdx[k]] = els[k]
    }
    onProgress?.(1)
  }

  return {
    minLon,
    minLat,
    maxLon,
    maxLat,
    cols,
    rows,
    elevations,
    mask,
  }
}
