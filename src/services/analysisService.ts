import type { Feature, Polygon } from 'geojson'
import type {
  TerrainAnalysisResult,
  ProgressMessage,
  DEMGrid,
  AnalysisStep,
} from '../types'
import { fetchDEMGrid, getDEMProviderName } from './dem/demService'
import { autoResolution } from '../utils/validation'
import { bboxOf, metersPerDegree } from '../utils/geo'
import TerrainWorker from '../workers/terrainWorker?worker'
import type { WorkerRequest, WorkerResult } from '../workers/terrainWorker'

export interface AnalysisOptions {
  areaKm2: number
  resolutionM?: number
  onProgress?: (p: ProgressMessage) => void
  signal?: AbortSignal
}

export async function runAnalysis(
  polygon: Feature<Polygon>,
  opts: AnalysisOptions,
): Promise<TerrainAnalysisResult> {
  const { areaKm2, onProgress, signal } = opts
  // 采样分辨率同时受“多边形面积”和“bbox 面积”约束，避免细长/狭长选区（河谷、海岸线、
  // 廊道）算出极小值分辨率，进而在 bbox 上建出数亿格的巨型网格导致浏览器 OOM 崩溃。
  const [minLon, minLat, maxLon, maxLat] = bboxOf(polygon)
  const centerLat = (minLat + maxLat) / 2
  const { lon: lonPerDeg, lat: latPerDeg } = metersPerDegree(centerLat)
  const bboxAreaKm2 =
    ((maxLon - minLon) * lonPerDeg * (maxLat - minLat) * latPerDeg) / 1_000_000
  const resolutionM = opts.resolutionM ?? autoResolution(areaKm2, bboxAreaKm2)

  const emit = (step: AnalysisStep, message: string, percent: number) =>
    onProgress?.({ step, message, percent })

  // 1. 获取 DEM
  emit('fetching', '正在获取地形数据……', 5)
  const grid: DEMGrid = await fetchDEMGrid(
    polygon,
    resolutionM,
    (p) => {
      // DEM 下载进度映射到 5%~25%
      emit('fetching', '正在获取地形数据……', 5 + p * 20)
    },
    signal,
  )
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // 检查是否有有效数据
  let hasData = false
  for (let i = 0; i < grid.mask.length; i++) {
    if (grid.mask[i] && isFinite(grid.elevations[i])) {
      hasData = true
      break
    }
  }
  if (!hasData) {
    throw new Error('当前区域暂无可用地形数据。')
  }

  // 2. 在 Worker 中执行重计算
  emit('elevation', '正在计算高程……', 25)
  const result = await runWorker(grid, areaKm2, resolutionM, (p) => {
    let step: AnalysisStep = 'slope'
    if (p.percent < 30) step = 'slope'
    else if (p.percent < 60) step = 'elevation'
    else if (p.percent < 85) step = 'slope'
    else step = 'profile'
    emit(step, p.step, 25 + (p.percent / 100) * 70)
  })

  emit('features', '正在分析地形特征……', 95)

  const final: TerrainAnalysisResult = {
    areaKm2,
    elevation: result.elevation,
    slope: result.slope,
    slopeClasses: result.slopeClasses,
    elevationHistogram: result.elevationHistogram,
    highest: result.highest,
    lowest: result.lowest,
    grid,
    slopeGrid: result.slopeGrid,
    hillshade: result.hillshade,
    aspectGrid: result.aspectGrid,
    aspectHistogram: result.aspectHistogram,
    triMean: result.triMean,
    localReliefMean: result.localReliefMean,
    landform: result.landform,
    flowAccGrid: result.flowAccGrid,
    streamMask: result.streamMask,
    twiGrid: result.twiGrid,
    curvGrid: result.curvGrid,
    hydrology: result.hydrology,
    curvature: result.curvature,
    resolutionM,
    demSource: getDEMProviderName(),
  }
  emit('done', '分析完成', 100)
  return final
}

function runWorker(
  grid: DEMGrid,
  areaKm2: number,
  resolutionM: number,
  onProgress: (p: { step: string; percent: number }) => void,
): Promise<Omit<WorkerResult, 'type'>> {
  return new Promise((resolve, reject) => {
    const worker = new TerrainWorker()
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg.type === 'progress') {
        onProgress({ step: msg.step, percent: msg.percent })
      } else if (msg.type === 'result') {
        worker.terminate()
        resolve(msg)
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || '地形计算失败'))
    }
    // 注意：不要把 grid 的缓冲区 transfer 给 Worker。
    // 主线程结果渲染（renderTerrain / 剖面）仍要读取 grid.elevations / grid.mask，
    // transfer 会把这些缓冲区在发送方“掏空”（byteLength 变 0），导致地形图与剖面全部崩溃。
    // 这里走结构化克隆（约 45KB，开销可忽略），Worker 回传 slopeGrid/hillshade 时再 transfer。
    const req: WorkerRequest = { type: 'analyze', grid, areaKm2, resolutionM }
    worker.postMessage(req)
  })
}
