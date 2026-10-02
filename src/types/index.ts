import type { Feature, Polygon, LineString, Position } from 'geojson'

export type { Position }

/* ------------------------------------------------------------------ */
/* 区域选择                                                            */
/* ------------------------------------------------------------------ */

export type SelectionMode = 'rectangle' | 'polygon'

export interface SelectedArea {
  mode: SelectionMode
  /** GeoJSON Polygon feature (CCW exterior ring, closed) */
  feature: Feature<Polygon>
  /** 测地面积 km² */
  areaKm2: number
}

/* ------------------------------------------------------------------ */
/* DEM 原始采样数据                                                    */
/* ------------------------------------------------------------------ */

export interface DEMSample {
  lon: number
  lat: number
  elevation: number
}

/** 规则网格 DEM */
export interface DEMGrid {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
  cols: number
  rows: number
  /** 行优先 elevation 数组，长度 cols*rows；无效值用 NaN */
  elevations: Float32Array
  /** 每个像元是否落在分析区域内 */
  mask: Uint8Array
}

/* ------------------------------------------------------------------ */
/* 分析结果                                                            */
/* ------------------------------------------------------------------ */

export interface ElevationStats {
  min: number
  max: number
  mean: number
  median: number
  range: number
}

export interface SlopeStats {
  mean: number
  max: number
  median: number
}

export interface SlopeClass {
  label: string
  range: [number, number]
  /** 0-1 */
  ratio: number
  areaKm2: number
  count: number
}

export interface ElevationBin {
  label: string
  range: [number, number]
  count: number
  ratio: number
}

export interface ExtremePoint {
  elevation: number
  lon: number
  lat: number
}

export interface ProfilePoint {
  distance: number // km
  elevation: number
  lon: number
  lat: number
}

export interface ProfileResult {
  points: ProfilePoint[]
  distanceKm: number
  minElevation: number
  maxElevation: number
  climb: number
  descent: number
  avgSlope: number
  startElev: number
  endElev: number
}

/** 坡向分布（8 方位 + 平坦/无坡向） */
export interface AspectBin {
  /** N / NE / E / SE / S / SW / W / NW / 平坦 */
  dir: string
  count: number
  ratio: number
}

/** 地形位置分类（TPI，Weiss 2001 六类）占比，0-1 */
export interface LandformClasses {
  /** 山脊 / 山脊线 */
  ridge: number
  /** 上坡（上部斜坡） */
  upperSlope: number
  /** 中坡（山坡主体） */
  middleSlope: number
  /** 下坡（下部斜坡） */
  lowerSlope: number
  /** 山谷 / 洼地 */
  valley: number
  /** 平地 */
  flat: number
}

/* ------------------------------------------------------------------ */
/* 水文（D8 汇流）/ 曲率 / 视域                                        */
/* ------------------------------------------------------------------ */

/**
 * 水文分析统计。
 *
 * ⚠️ 所有汇流指标都只在**本选区内部**计算：DEM 只对选区内的像元取过数
 * （选区外是 NaN），所以选区上游的来水算不进来，边缘像元的汇流累积偏小。
 * 要分析一条完整流域，得把分水岭以内都选进选区。
 */
export interface HydrologyStats {
  /** 提取河网用的汇流面积阈值 km² */
  thresholdKm2: number
  /** 河网像元数 */
  streamCells: number
  /** 河网总长度 km（按 D8 流向路径逐段累加，含对角线段的真实长度） */
  streamLengthKm: number
  /** 河网密度 km/km² */
  drainageDensity: number
  /** 最长主沟道长度 km（自源头到出口的最长流路） */
  longestChannelKm: number
  /** 最大汇流累积 km² */
  maxAccKm2: number
  /** 平均地形湿度指数 TWI */
  twiMean: number
  /** TWI 的 80 分位（湿润区判据） */
  twiP80: number
  /** TWI ≥ P80 的面积占比 */
  wetRatio: number
}

/**
 * 曲率统计。平面曲率描述「水流在坡面上是发散还是汇聚」，
 * 剖面曲率描述「沿坡向下是加速还是减速」。
 * 单位统一为 1/100m（QGIS / ArcGIS 惯例），正=凸、负=凹。
 */
export interface CurvatureStats {
  planMean: number
  profileMean: number
  /** 平均绝对平面曲率：反映地表破碎程度 */
  meanAbs: number
  /** 凸坡（发散，山脊/坡肩）占比 */
  convexRatio: number
  /** 凹坡（汇聚，谷底/坡脚）占比 */
  concaveRatio: number
  /** 近线性（|曲率| ≤ 阈值）占比 */
  linearRatio: number
}

/**
 * 视域分析结果（不落盘：观察点由用户随时改，重算很快）。
 * mask 与 result.grid 同尺寸，1 = 可见。
 */
export interface ViewshedResult {
  lon: number
  lat: number
  observerElev: number
  visibleCells: number
  visibleKm2: number
  /** 可见像元 / 选区内有效像元 */
  visibleRatio: number
  /** 采样射线方位数 */
  rayCount: number
  /** 掩膜与 grid 同尺寸 */
  mask: Uint8Array
}

export interface TerrainAnalysisResult {
  areaKm2: number
  elevation: ElevationStats
  slope: SlopeStats
  slopeClasses: SlopeClass[]
  elevationHistogram: ElevationBin[]
  highest: ExtremePoint
  lowest: ExtremePoint
  /** 用于地图可视化的规则网格 */
  grid: DEMGrid
  /** 坡度网格（度），与 grid 同尺寸；边缘/无效为 NaN */
  slopeGrid: Float32Array
  /** Hillshade 0-255，与 grid 同尺寸 */
  hillshade: Uint8Array
  /** 坡向网格（度，0=正北，顺时针；平坦/边缘为 NaN），与 grid 同尺寸 */
  aspectGrid: Float32Array
  /** 坡向分布（8 方位 + 平坦） */
  aspectHistogram: AspectBin[]
  /** 平均地形粗糙度 TRI（米）：像元与 8 邻域平均高差 */
  triMean: number
  /** 平均地形起伏度（米）：3×3 窗口内最大最小高差的平均值 */
  localReliefMean: number
  /** 地形位置分类（TPI 六类）占比 */
  landform: LandformClasses
  /** 汇流累积网格（上游汇水面积 km²，含自身） */
  flowAccGrid: Float32Array
  /** 河网掩膜（1=河网像元），阈值见 hydrology.thresholdKm2 */
  streamMask: Uint8Array
  /** 地形湿度指数 TWI 网格 */
  twiGrid: Float32Array
  /** 平面曲率网格（1/100m，正=凸 负=凹） */
  curvGrid: Float32Array
  hydrology: HydrologyStats
  curvature: CurvatureStats
  /** 采样分辨率 m */
  resolutionM: number
  /** 本次实际使用的 DEM 数据源名（瓦片源自动回退时会显示兜底源） */
  demSource?: string
}

/* ------------------------------------------------------------------ */
/* 项目（分析记录）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 一个「项目」= 一次分析的区域 + 结果，左侧项目面板里的条目。
 * 整份对象会被存进 IndexedDB（含 Float32Array 网格），所以字段一多一重
 * 都会直接放大存储体积 —— 新增字段前先想想是否真的需要落盘。
 */
export interface HistoryItem {
  id: string
  name: string
  feature: Feature<Polygon>
  areaKm2: number
  result: TerrainAnalysisResult
  timestamp: number
}

/* ------------------------------------------------------------------ */
/* 进度                                                                */
/* ------------------------------------------------------------------ */

export type AnalysisStep =
  | 'fetching'
  | 'elevation'
  | 'slope'
  | 'profile'
  | 'features'
  | 'done'

export interface ProgressMessage {
  step: AnalysisStep
  message: string
  percent: number
}

/* ------------------------------------------------------------------ */
/* 地形描述                                                            */
/* ------------------------------------------------------------------ */

export interface TerrainDescription {
  paragraphs: string[]
  keywords: string[]
}

/* ------------------------------------------------------------------ */
/* 地图图层                                                            */
/* ------------------------------------------------------------------ */

/**
 * 地形图层：
 * - elevation   高程（连续色带，按区域内 min~max 归一化）
 * - hypsometric 分层设色（分级色带，地形图通用配色）
 * - relief      晕渲（分层设色叠山体阴影，立体感最强）
 * - hillshade   山体阴影（纯灰度，只看坡形不看高程）
 * - slope       坡度分级
 * - aspect      坡向
 * - contour     等高线（自带低透明度分层设色垫底）
 * - streams     河网水系（D8 汇流累积超阈值的像元，按汇流量分级着色）
 * - twi         地形湿度指数（湿区/干坡，5 级分类）
 * - curvature   平面曲率（正=凸 负=凹，5 级发散配色）
 */
export type TerrainLayer =
  | 'elevation'
  | 'hypsometric'
  | 'relief'
  | 'hillshade'
  | 'slope'
  | 'aspect'
  | 'contour'
  | 'streams'
  | 'twi'
  | 'curvature'

export interface BasemapOption {
  id: string
  name: string
  style: string
}
