import type {
  DEMGrid,
  ElevationStats,
  SlopeStats,
  SlopeClass,
  ElevationBin,
  ExtremePoint,
  AspectBin,
  LandformClasses,
  HydrologyStats,
  CurvatureStats,
} from '../types'
import { elevationStats, findExtremes } from '../services/terrain/elevation'
import {
  computeSlopeGrid,
  slopeStats,
  slopeDistribution,
  computeHillshade,
  computeAspectGrid,
  aspectHistogram,
  computeTRI,
  computeLocalRelief,
  computeLandform,
  computeCurvature,
} from '../services/terrain/slope'
import { computeHydrology } from '../services/terrain/hydrology'
import { elevationHistogram } from '../services/terrain/statistics'

export interface WorkerRequest {
  type: 'analyze'
  grid: DEMGrid
  areaKm2: number
  resolutionM: number
}

export interface WorkerResult {
  type: 'result'
  elevation: ElevationStats
  slope: SlopeStats
  slopeClasses: SlopeClass[]
  elevationHistogram: ElevationBin[]
  highest: ExtremePoint
  lowest: ExtremePoint
  slopeGrid: Float32Array
  hillshade: Uint8Array
  aspectGrid: Float32Array
  aspectHistogram: AspectBin[]
  triMean: number
  localReliefMean: number
  landform: LandformClasses
  flowAccGrid: Float32Array
  streamMask: Uint8Array
  twiGrid: Float32Array
  curvGrid: Float32Array
  hydrology: HydrologyStats
  curvature: CurvatureStats
}

export interface WorkerProgress {
  type: 'progress'
  step: string
  percent: number
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { grid, areaKm2, resolutionM } = e.data

  postProgress('计算坡度……', 8)
  const slopeGrid = computeSlopeGrid(grid, resolutionM)

  postProgress('生成山体阴影……', 20)
  const hillshade = computeHillshade(grid, resolutionM)

  postProgress('计算坡向……', 28)
  const aspectGrid = computeAspectGrid(grid)

  postProgress('统计高程……', 36)
  const elevation = elevationStats(grid)
  const extremes = findExtremes(grid)

  postProgress('统计坡度分布……', 44)
  const slope = slopeStats(grid, slopeGrid)
  const slopeClasses = slopeDistribution(grid, slopeGrid, areaKm2)

  postProgress('统计坡向分布……', 50)
  const aspectHist = aspectHistogram(grid, aspectGrid, slopeGrid)

  postProgress('计算地形起伏与粗糙度……', 56)
  const triMean = computeTRI(grid)
  const localReliefMean = computeLocalRelief(grid)
  const landform = computeLandform(grid, slopeGrid)

  // 水文：填洼 + 流向 + 汇流累积 + 河网 + TWI。
  // 依赖 slopeGrid（TWI 的分母是 tanβ），所以必须排在坡度之后。
  postProgress('填洼与汇流计算……', 66)
  const hyd = computeHydrology(grid, areaKm2, resolutionM, slopeGrid)

  postProgress('计算曲率……', 86)
  const curvature = computeCurvature(grid, resolutionM)

  postProgress('生成高程分布……', 92)
  const histogram = elevationHistogram(grid)

  const result: WorkerResult = {
    type: 'result',
    elevation,
    slope,
    slopeClasses,
    elevationHistogram: histogram,
    highest: extremes.highest,
    lowest: extremes.lowest,
    slopeGrid,
    hillshade,
    aspectGrid,
    aspectHistogram: aspectHist,
    triMean,
    localReliefMean,
    landform,
    flowAccGrid: hyd.flowAcc,
    streamMask: hyd.streamMask,
    twiGrid: hyd.twi,
    curvGrid: curvature.curv,
    hydrology: hyd.stats,
    curvature: curvature.stats,
  }
  postProgress('完成', 100)
  self.postMessage(result, [
    slopeGrid.buffer,
    hillshade.buffer,
    aspectGrid.buffer,
    hyd.flowAcc.buffer,
    hyd.streamMask.buffer,
    hyd.twi.buffer,
    curvature.curv.buffer,
  ])
}

function postProgress(step: string, percent: number) {
  const msg: WorkerProgress = { type: 'progress', step, percent }
  self.postMessage(msg)
}
