import type { DEMGrid, SlopeClass, SlopeStats, AspectBin, LandformClasses, CurvatureStats } from '../../types'
import { metersPerDegree } from '../../utils/geo'

const SLOPE_CLASSES: { label: string; range: [number, number] }[] = [
  { label: '0–5°', range: [0, 5] },
  { label: '5–15°', range: [5, 15] },
  { label: '15–25°', range: [15, 25] },
  { label: '25–35°', range: [25, 35] },
  { label: '>35°', range: [35, 90] },
]

/**
 * 基于规则网格计算坡度（度）。
 * 使用 Horn 3x3 邻域方法，中心差分。
 */
export function computeSlopeGrid(
  grid: DEMGrid,
  resolutionM: number,
): Float32Array {
  const { cols, rows, elevations, mask } = grid
  const slope = new Float32Array(cols * rows).fill(NaN)
  const cellSize = resolutionM

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      // 3x3 邻域高程
      const e = elevations
      const z1 = e[idx - cols - 1]
      const z2 = e[idx - cols]
      const z3 = e[idx - cols + 1]
      const z4 = e[idx - 1]
      const z6 = e[idx + 1]
      const z7 = e[idx + cols - 1]
      const z8 = e[idx + cols]
      const z9 = e[idx + cols + 1]
      if (
        !isFinite(z1) || !isFinite(z2) || !isFinite(z3) ||
        !isFinite(z4) || !isFinite(z6) ||
        !isFinite(z7) || !isFinite(z8) || !isFinite(z9)
      ) {
        continue
      }
      const dzdx = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) / (8 * cellSize)
      const dzdy = ((z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)) / (8 * cellSize)
      const rise = Math.sqrt(dzdx * dzdx + dzdy * dzdy)
      slope[idx] = (Math.atan(rise) * 180) / Math.PI
    }
  }
  return slope
}

export function slopeStats(
  grid: DEMGrid,
  slopeGrid: Float32Array,
): SlopeStats {
  let sum = 0
  let count = 0
  let max = -Infinity
  const arr: number[] = []
  for (let i = 0; i < slopeGrid.length; i++) {
    if (!grid.mask[i]) continue
    const s = slopeGrid[i]
    if (!isFinite(s)) continue
    sum += s
    count++
    if (s > max) max = s
    arr.push(s)
  }
  if (count === 0) return { mean: NaN, max: NaN, median: NaN }
  arr.sort((a, b) => a - b)
  const mid = Math.floor(arr.length / 2)
  const median = arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid]
  return { mean: sum / count, max, median }
}

export function slopeDistribution(
  grid: DEMGrid,
  slopeGrid: Float32Array,
  areaKm2: number,
): SlopeClass[] {
  const counts = SLOPE_CLASSES.map(() => 0)
  let total = 0
  for (let i = 0; i < slopeGrid.length; i++) {
    if (!grid.mask[i]) continue
    const s = slopeGrid[i]
    if (!isFinite(s)) continue
    total++
    for (let k = 0; k < SLOPE_CLASSES.length; k++) {
      const [lo, hi] = SLOPE_CLASSES[k].range
      if (k === SLOPE_CLASSES.length - 1) {
        if (s >= lo) counts[k]++
      } else {
        if (s >= lo && s < hi) counts[k]++
      }
    }
  }
  return SLOPE_CLASSES.map((cls, k) => ({
    label: cls.label,
    range: cls.range,
    count: counts[k],
    ratio: total > 0 ? counts[k] / total : 0,
    areaKm2: total > 0 ? (counts[k] / total) * areaKm2 : 0,
  }))
}

/** Hillshade（0-255），光源方位角 315°，高度角 45° */
export function computeHillshade(
  grid: DEMGrid,
  resolutionM: number,
): Uint8Array {
  const { cols, rows, elevations, mask } = grid
  const hs = new Uint8Array(cols * rows)
  const az = (315 * Math.PI) / 180
  const alt = (45 * Math.PI) / 180
  const zenith = Math.PI / 2 - alt
  const cellSize = resolutionM

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      const e = elevations
      const z1 = e[idx - cols - 1]
      const z2 = e[idx - cols]
      const z3 = e[idx - cols + 1]
      const z4 = e[idx - 1]
      const z6 = e[idx + 1]
      const z7 = e[idx + cols - 1]
      const z8 = e[idx + cols]
      const z9 = e[idx + cols + 1]
      if (
        !isFinite(z1) || !isFinite(z2) || !isFinite(z3) ||
        !isFinite(z4) || !isFinite(z6) ||
        !isFinite(z7) || !isFinite(z8) || !isFinite(z9)
      ) {
        hs[idx] = 0
        continue
      }
      const dzdx = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) / (8 * cellSize)
      const dzdy = ((z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)) / (8 * cellSize)
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy))
      // 坡向取**下坡面所朝方位**（ESRI/QGIS 惯例），与 computeAspectGrid 同一套符号。
      //
      // ⚠️ 踩过的坑：这里原本写的是 atan2(dzdx, -dzdy)。网格第 0 行在南侧，
      // 所以 dzdy 是「向北」的导数，梯度向量 (dzdx, dzdy) 指向**上坡**方向 ——
      // 直接把它当坡向用，等于把光照方向沿南北轴镜像了一次：注释写着光源 315°(西北)，
      // 实际渲染出来是 135°(东南) 打光。因为"镜像后的山体阴影"看不出破绽，这个错
      // 一直没被肉眼发现；但把它和坡向图层并排看就不自洽了。
      // 正确的下坡方位 = atan2(-dzdx, -dzdy)（见 .workbuddy/tools/selftest-terrain.ts）
      let aspect = Math.atan2(-dzdx, -dzdy)
      if (aspect < 0) aspect += Math.PI * 2
      const value =
        Math.cos(zenith) * Math.cos(slope) +
        Math.sin(zenith) * Math.sin(slope) * Math.cos(az - aspect)
      hs[idx] = Math.max(0, Math.min(255, Math.round(value * 255)))
    }
  }
  return hs
}

/* ================================================================== */
/* 坡向 / 地形粗糙度 / 局部起伏度 / 地形位置分类                         */
/* 参考：xdem、QGIS gdaldem、Weiss(2001) TPI、Riley(1999) TRI           */
/* ================================================================== */

const ASPECT_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/**
 * 坡向网格（度）。0=正北，顺时针，范围 [0,360)；平坦（坡度极小）或边缘为 NaN。
 * 与坡度共用 Horn 3×3 邻域梯度，坡向取下坡面所朝方位（罗盘方位角）。
 */
export function computeAspectGrid(grid: DEMGrid): Float32Array {
  const { cols, rows, elevations, mask } = grid
  const aspect = new Float32Array(cols * rows).fill(NaN)
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      const e = elevations
      const z1 = e[idx - cols - 1]
      const z2 = e[idx - cols]
      const z3 = e[idx - cols + 1]
      const z4 = e[idx - 1]
      const z6 = e[idx + 1]
      const z7 = e[idx + cols - 1]
      const z8 = e[idx + cols]
      const z9 = e[idx + cols + 1]
      if (
        !isFinite(z1) || !isFinite(z2) || !isFinite(z3) ||
        !isFinite(z4) || !isFinite(z6) ||
        !isFinite(z7) || !isFinite(z8) || !isFinite(z9)
      ) {
        continue
      }
      const dzdx = (z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)
      const dzdy = (z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)
      // 坡度极小视为平坦，坡向无意义
      if (Math.hypot(dzdx, dzdy) < 1e-9) continue
      // 下坡方向（坡面所朝方位）：北=0°，东=90°
      let a = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI
      if (a < 0) a += 360
      aspect[idx] = a
    }
  }
  return aspect
}

/** 坡向分布：8 方位 + 平坦（坡度 < 1° 或坡向无效） */
export function aspectHistogram(
  grid: DEMGrid,
  aspectGrid: Float32Array,
  slopeGrid: Float32Array,
): AspectBin[] {
  const counts = new Array(ASPECT_DIRS.length + 1).fill(0) // 末位为“平坦”
  let total = 0
  for (let i = 0; i < aspectGrid.length; i++) {
    if (!grid.mask[i]) continue
    const a = aspectGrid[i]
    const s = slopeGrid[i]
    if (!isFinite(a) || !isFinite(s) || s < 1) {
      counts[ASPECT_DIRS.length]++
    } else {
      const sector = Math.floor(((a + 22.5) % 360) / 45) % ASPECT_DIRS.length
      counts[sector]++
    }
    total++
  }
  const out: AspectBin[] = ASPECT_DIRS.map((dir, k) => ({
    dir,
    count: counts[k],
    ratio: total > 0 ? counts[k] / total : 0,
  }))
  out.push({
    dir: '平坦',
    count: counts[ASPECT_DIRS.length],
    ratio: total > 0 ? counts[ASPECT_DIRS.length] / total : 0,
  })
  return out
}

/**
 * 地形粗糙度 TRI（Riley 1999）：像元与 8 邻域平均绝对高差，取全区域均值（米）。
 * 反映局部地表破碎/起伏剧烈程度。
 */
export function computeTRI(grid: DEMGrid): number {
  const { cols, rows, elevations, mask } = grid
  const nbs = [-cols - 1, -cols, -cols + 1, -1, 1, cols - 1, cols, cols + 1]
  let sum = 0
  let count = 0
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      const zc = elevations[idx]
      if (!isFinite(zc)) continue
      let dsum = 0
      let n = 0
      for (const off of nbs) {
        const j = idx + off
        const zn = elevations[j]
        if (mask[j] && isFinite(zn)) {
          dsum += Math.abs(zc - zn)
          n++
        }
      }
      if (n > 0) {
        sum += dsum / n
        count++
      }
    }
  }
  return count > 0 ? sum / count : NaN
}

/**
 * 地形起伏度（局部）：3×3 窗口内最大最小高差的平均值（米）。
 * 反映该分辨率下的地表起伏幅度（区别于整体最大高差 range）。
 */
export function computeLocalRelief(grid: DEMGrid): number {
  const { cols, rows, elevations, mask } = grid
  const nbs = [-cols - 1, -cols, -cols + 1, -1, 0, 1, cols - 1, cols, cols + 1]
  let sum = 0
  let count = 0
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      let mn = Infinity
      let mx = -Infinity
      let n = 0
      for (const off of nbs) {
        const j = idx + off
        const z = elevations[j]
        if (mask[j] && isFinite(z)) {
          if (z < mn) mn = z
          if (z > mx) mx = z
          n++
        }
      }
      if (n >= 5) {
        sum += mx - mn
        count++
      }
    }
  }
  return count > 0 ? sum / count : NaN
}

/* ================================================================== */
/* 曲率（Zevenbergen & Thorne 1987）                                   */
/* ================================================================== */

/**
 * 平面曲率 / 剖面曲率。
 *
 * - **平面曲率**：等高线的弯曲程度 —— 正=凸（水流发散，山脊、坡肩），
 *   负=凹（水流汇聚，谷底、坡脚）。判读汇水与侵蚀位置靠它。
 * - **剖面曲率**：沿坡面下滑方向的弯曲 —— 负=坡面变陡（加速），正=变缓（减速）。
 *
 * ⚠️ 网格第 0 行在南侧，而 Z&T 公式的 z1..z9 是按「z1=西北角」编号的。
 * 直接把变量套进去会让南北翻转，所以这里一律用**方位命名**的局部变量
 * （zN/zS/zE/zW/zNE…），不沿用 z1..z9 的编号。
 *
 * 输出单位取 1/100m（QGIS / ArcGIS 惯例），数值量级与人眼判读习惯一致。
 *
 * **符号约定（本工具的定义，且有自测钉死）**：
 *   平面曲率 > 0 = 凸（水流**发散**，山脊/坡肩）；< 0 = 凹（水流**汇聚**，谷底/坡脚）
 *   剖面曲率 > 0 = 沿程变缓（减速、易淤积）；< 0 = 沿程变陡（加速、易冲刷）
 * 判据来自物理事实：穹顶上的水流一定发散、碗地里的水流一定汇聚 ——
 * 见 .workbuddy/tools/selftest-terrain.ts。
 *
 * ⚠️ 文献里平面曲率的正负号是不统一的（Zevenbergen & Thorne 原文的式子与本文件
 * 差一个整体负号），所以别拿这里的数值去和别的软件直接比大小，只比**分类结果**。
 */
const CURV_CLIP = 50
/** |平面曲率| ≤ 此值视为近线性 */
export const CURV_LINEAR_THRESHOLD = 0.1

export function computeCurvature(
  grid: DEMGrid,
  resolutionM: number,
): { curv: Float32Array; stats: CurvatureStats } {
  const { cols, rows, elevations, mask } = grid
  const n = cols * rows
  const curv = new Float32Array(n).fill(NaN)
  const L = resolutionM
  const L2 = L * L

  let planSum = 0
  let profSum = 0
  let absSum = 0
  let convex = 0
  let concave = 0
  let linear = 0
  let count = 0

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c
      if (!mask[i]) continue
      const e = elevations
      const zC = e[i]
      const zN = e[i + cols]
      const zS = e[i - cols]
      const zE = e[i + 1]
      const zW = e[i - 1]
      const zNE = e[i + cols + 1]
      const zNW = e[i + cols - 1]
      const zSE = e[i - cols + 1]
      const zSW = e[i - cols - 1]
      if (
        !isFinite(zC) || !isFinite(zN) || !isFinite(zS) || !isFinite(zE) ||
        !isFinite(zW) || !isFinite(zNE) || !isFinite(zNW) ||
        !isFinite(zSE) || !isFinite(zSW)
      ) {
        continue
      }
      const D = ((zE + zW) / 2 - zC) / L2
      const E = ((zN + zS) / 2 - zC) / L2
      const F = (-zNW + zNE + zSW - zSE) / (4 * L2)
      const G = (zE - zW) / (2 * L)
      const H = (zN - zS) / (2 * L)
      // 水平面（G=H=0）上曲率无定义，按 0 处理 —— 否则会除出 ±Infinity
      const den = G * G + H * H
      let plan = 0
      let prof = 0
      if (den > 1e-12) {
        // 平面曲率取 Z&T 式子的相反数（见文件头符号约定）
        plan = (-2 * (D * H * H + E * G * G - F * G * H)) / den * 100
        prof = (2 * (D * G * G + E * H * H + F * G * H)) / den * 100
      }
      if (!isFinite(plan) || !isFinite(prof)) continue
      const clip = (v: number) => (v > CURV_CLIP ? CURV_CLIP : v < -CURV_CLIP ? -CURV_CLIP : v)
      plan = clip(plan)
      prof = clip(prof)
      curv[i] = plan

      planSum += plan
      profSum += prof
      absSum += Math.abs(plan)
      if (plan > CURV_LINEAR_THRESHOLD) convex++
      else if (plan < -CURV_LINEAR_THRESHOLD) concave++
      else linear++
      count++
    }
  }

  const stats: CurvatureStats = count
    ? {
        planMean: planSum / count,
        profileMean: profSum / count,
        meanAbs: absSum / count,
        convexRatio: convex / count,
        concaveRatio: concave / count,
        linearRatio: linear / count,
      }
    : {
        planMean: NaN,
        profileMean: NaN,
        meanAbs: NaN,
        convexRatio: NaN,
        concaveRatio: NaN,
        linearRatio: NaN,
      }
  return { curv, stats }
}

/**
 * 地形位置分类（TPI，Weiss 2001 六类）。
 * TPI = 像元高程 − 3×3 邻域均值；按 TPI 标准差标准化后划分山脊/上坡/中坡/下坡/山谷，
 * 坡度 < 5° 且 TPI 接近 0 的区域归为平地。返回各类占比。
 */
export function computeLandform(
  grid: DEMGrid,
  slopeGrid: Float32Array,
): LandformClasses {
  const { cols, rows, elevations, mask } = grid
  const tpi = new Float32Array(cols * rows).fill(NaN)
  const nbs = [-cols - 1, -cols, -cols + 1, -1, 0, 1, cols - 1, cols, cols + 1]

  // 第一遍：计算 TPI
  let ts = 0
  let tc = 0
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c
      if (!mask[idx]) continue
      let sum = 0
      let n = 0
      for (const off of nbs) {
        const j = idx + off
        const z = elevations[j]
        if (mask[j] && isFinite(z)) {
          sum += z
          n++
        }
      }
      if (n > 0) {
        const v = elevations[idx] - sum / n
        tpi[idx] = v
        ts += v
        tc++
      }
    }
  }
  const mean = tc > 0 ? ts / tc : 0
  let ss = 0
  for (let i = 0; i < tpi.length; i++) {
    if (mask[i] && isFinite(tpi[i])) ss += (tpi[i] - mean) ** 2
  }
  const std = tc > 0 ? Math.sqrt(ss / tc) : 0

  let ridge = 0
  let upper = 0
  let middle = 0
  let lower = 0
  let valley = 0
  let flat = 0
  let total = 0
  for (let i = 0; i < tpi.length; i++) {
    if (!mask[i] || !isFinite(tpi[i])) continue
    const s = slopeGrid[i]
    if (!isFinite(s)) continue
    const t = tpi[i]
    total++
    if (s < 5) {
      // 平缓区
      if (t > std) ridge++
      else if (t < -std) valley++
      else flat++
    } else {
      if (t > std) ridge++
      else if (t > 0.5 * std) upper++
      else if (t >= -0.5 * std) middle++
      else if (t >= -std) lower++
      else valley++
    }
  }
  const r = (x: number) => (total > 0 ? x / total : 0)
  return {
    ridge: r(ridge),
    upperSlope: r(upper),
    middleSlope: r(middle),
    lowerSlope: r(lower),
    valley: r(valley),
    flat: r(flat),
  }
}

/** 水面判定：3×3 邻域完全无起伏（差值阈值，米）且高程不高于海平面 */
const WATER_FLAT_EPS = 0.05

/**
 * 水面掩膜：标出「平坦且贴近海平面」的像元，并**外扩一圈**。
 *
 * 为什么需要它（实测证据，深圳大鹏外海，Open-Meteo / Copernicus）：
 *   海面返回的是**精确的 0.0**，一整片连着、毫无起伏。这种区域本身不会产生
 *   等高线 —— 四角同高时 marching squares 直接跳过。真正画错的是**紧挨水面
 *   的那一圈像元**：它一两个角在陆地上（比如 100m）、其余角在海里（0m），
 *   于是 20m 线按线性插值落在靠海那侧的 20% 处、40m 线落在 40% 处……
 *   一整套低高程等高线就这样被"插值到了水面上"，卫星底图上一眼可见。
 *
 * 判据刻意收紧成「平坦 **且** 不高于海平面」：湖泊、水库的水面在海平面之上，
 * 但它们同样完全平坦，本来就不产生等高线，不需要屏蔽；而若把"任意平坦区"
 * 都屏蔽掉，内陆平原边缘的等高线会被平白截掉一小段。
 */
function detectWater(grid: DEMGrid): Uint8Array {
  const { cols, rows, elevations, mask } = grid
  const n = cols * rows
  const flat = new Uint8Array(n)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!mask[i] || !isFinite(elevations[i])) continue
      const z = elevations[i]
      if (z > WATER_FLAT_EPS) continue
      let ok = true
      for (let dr = -1; dr <= 1 && ok; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc
          if (cc < 0 || cc >= cols) continue
          const j = rr * cols + cc
          if (
            !mask[j] ||
            !isFinite(elevations[j]) ||
            Math.abs(elevations[j] - z) > WATER_FLAT_EPS
          ) {
            ok = false
            break
          }
        }
      }
      if (ok) flat[i] = 1
    }
  }
  // 外扩一圈：把「半陆半水」的边界像元一起屏蔽，等高线到岸线为止
  const out = new Uint8Array(n)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!flat[r * cols + c]) continue
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc
          if (cc < 0 || cc >= cols) continue
          out[rr * cols + cc] = 1
        }
      }
    }
  }
  return out
}

/** 等高线生成的可调项（一般不用传） */
export interface ContourOptions {
  /**
   * 闭合小圈（"孤岛"）的最小面积（m²），小于它的直接丢掉。
   * 默认 4 个像元的面积，即 2×2 格 —— 小于这个尺度的闭合圈已经低于 DEM
   * 的分辨能力，通常是噪声尖峰而不是真实小山包。
   */
  minIslandM2?: number
  /** 是否启用水面掩膜（默认开启） */
  maskWater?: boolean
}

/**
 * 根据 DEM 网格生成等高线 GeoJSON（marching squares）。
 *
 * 三个关键点，都是踩过坑才定下来的：
 *
 * 1. **按「像元」而不是按「高程级」做外层循环。** 旧实现是
 *    `for level { for cell { ... } }`，每一级都要把全区像元扫一遍，
 *    十余级就是十余遍全区扫描。实际上绝大多数像元只被 0~1 条等高线穿过 ——
 *    先算出像元四角的高程区间 [cmin, cmax]，只枚举落在这个区间里的那几级，
 *    工作量立刻降一个数量级（1800×1800 网格上从「十几遍全区」变成「一遍」）。
 *
 * 2. **水面不画等高线。** 见 `detectWater`。
 *
 * 3. **丢掉过小的闭合圈。** 见 `ContourOptions.minIslandM2`。
 */
export function generateContours(
  grid: DEMGrid,
  interval: number,
  opts: ContourOptions = {},
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const { cols, rows, elevations, minLon, minLat, maxLon, maxLat, mask } = grid
  if (cols < 2 || rows < 2 || !(interval > 0)) {
    return { type: 'FeatureCollection', features: [] }
  }

  const lonStep = (maxLon - minLon) / cols
  const latStep = (maxLat - minLat) / rows
  // ⚠️ 不要写成 Math.min(...valid)：1800×1800 的网格就是 324 万个实参，
  // 展开成函数参数会直接 RangeError: Maximum call stack size exceeded
  // （自测里 600×600 就已经炸了）。老老实实循环。
  let vMin = Infinity
  let vMax = -Infinity
  for (let i = 0; i < elevations.length; i++) {
    if (!mask[i]) continue
    const z = elevations[i]
    if (!isFinite(z)) continue
    if (z < vMin) vMin = z
    if (z > vMax) vMax = z
  }
  if (vMin > vMax) return { type: 'FeatureCollection', features: [] }
  let eMin = Math.floor(vMin / interval) * interval
  let eMax = Math.ceil(vMax / interval) * interval
  const levels: number[] = []
  for (let v = eMin; v <= eMax + interval * 1e-6; v += interval) levels.push(v)
  if (levels.length === 0) return { type: 'FeatureCollection', features: [] }

  const water = opts.maskWater === false ? null : detectWater(grid)

  // 像元大致边长（米）：孤岛面积阈值要按地面实际尺寸定才说得通
  const mPerDeg = metersPerDegree((minLat + maxLat) / 2)
  const cellM = Math.max(
    1,
    Math.min(mPerDeg.lat * Math.abs(latStep), mPerDeg.lon * Math.abs(lonStep)),
  )
  const minIslandM2 = opts.minIslandM2 ?? 4 * cellM * cellM
  // 面积换算系数：鞋带公式在「经纬度平面」上算出的度² → 平方米
  const areaScale = Math.abs(mPerDeg.lat * mPerDeg.lon)

  // 等高线按真实经纬度绘制在地图上（不经过地形图的显示层翻转），因此节点坐标
  // 直接取数据单元 (r,c) 的地理中心：经度 = minLon+(c+0.5)*lonStep，
  // 纬度 = minLat+(r+0.5)*latStep。相比旧实现消除了约半格偏移，与渲染图对齐。
  const nodeLon = (c: number) => minLon + (c + 0.5) * lonStep
  const nodeLat = (r: number) => minLat + (r + 0.5) * latStep

  // 每条高程级一个段桶
  const buckets: number[][][][] = levels.map(() => [])

  for (let r = 0; r < rows - 1; r++) {
    const latT = nodeLat(r)
    const latB = nodeLat(r + 1)
    for (let c = 0; c < cols - 1; c++) {
      const iT = r * cols + c
      const iB = iT + cols
      const tl = elevations[iT]
      const tr = elevations[iT + 1]
      const bl = elevations[iB]
      const br = elevations[iB + 1]
      if (!isFinite(tl) || !isFinite(tr) || !isFinite(br) || !isFinite(bl)) continue
      // 任一位角落在水面上就整个像元不参与 —— 等高线到岸线为止
      if (water && (water[iT] || water[iT + 1] || water[iB] || water[iB + 1])) continue

      let cmin = tl
      let cmax = tl
      if (tr < cmin) cmin = tr
      else if (tr > cmax) cmax = tr
      if (bl < cmin) cmin = bl
      else if (bl > cmax) cmax = bl
      if (br < cmin) cmin = br
      else if (br > cmax) cmax = br
      const span = cmax - cmin
      if (span <= 1e-9) continue // 完全平坦：没有任何一级穿过

      // 角点判定用 z >= level，所以「有等高线穿过」等价于 cmin < level <= cmax
      let liStart = Math.floor((cmin - eMin) / interval) + 1
      let liEnd = Math.floor((cmax - eMin) / interval)
      if (liStart < 0) liStart = 0
      if (liEnd > levels.length - 1) liEnd = levels.length - 1

      const lonL = nodeLon(c)
      const lonR = nodeLon(c + 1)

      for (let li = liStart; li <= liEnd; li++) {
        const level = levels[li]
        const idx =
          (tl >= level ? 8 : 0) |
          (tr >= level ? 4 : 0) |
          (br >= level ? 2 : 0) |
          (bl >= level ? 1 : 0)
        if (idx === 0 || idx === 15) continue

        /**
         * 交点必须落在单元的**真实边**上：在边的两个角点之间按高程线性插值。
         *
         * 曾经这里传的是四条边的**中点**（top/right/bottom/left），于是
         * `interp(bl, br, left, bottom)` 变成「用 bl→br 的高程比去插值 left→bottom
         * 两个中点」—— 得到的是单元内部的一条弦，而不是 bl–br 边上的交点。
         * 相邻单元对同一条共享边各算各的弦，结果差约半个格子，永远接不上：
         * 图面上就成了「一小节一小节的短横线 + 缺口」，拼接函数也无从下手。
         *
         * 改成按角点插值后，共享边在两个单元里的表达式逐字相同（同样的
         * 角点高程、同样的坐标算式），浮点结果逐位相同，接缝严丝合缝。
         */
        const interp = (
          a: number,
          b: number,
          ax: number,
          ay: number,
          bx: number,
          by: number,
        ): number[] => {
          const t = Math.abs(b - a) < 1e-9 ? 0.5 : (level - a) / (b - a)
          return [ax + (bx - ax) * t, ay + (by - ay) * t]
        }
        // 四条边上的交点（惰性求值：一条边可能被两个角点共用）
        const onTop = () => interp(tl, tr, lonL, latT, lonR, latT) // TL–TR
        const onRight = () => interp(tr, br, lonR, latT, lonR, latB) // TR–BR
        const onBottom = () => interp(bl, br, lonL, latB, lonR, latB) // BL–BR
        const onLeft = () => interp(tl, bl, lonL, latT, lonL, latB) // TL–BL

        const segs = buckets[li]
        switch (idx) {
          // 约定：idx 的四个 bit 依次是 TL(8) TR(4) BR(2) BL(1)，
          // 「1」表示该角点海拔 >= 当前等高线。每条 case 后面的括号是
          // 被切掉的那个（或那些）角点。
          case 1: // BL
          case 14: // 除 BL 外全在上方 —— 同样切掉 BL 这一角
            segs.push([onLeft(), onBottom()])
            break
          case 2: // BR
          case 13: // 切掉 BR
            segs.push([onBottom(), onRight()])
            break
          case 3: // BL + BR（下方两点）→ 线横穿单元
          case 12: // TL + TR（上方两点）
            segs.push([onLeft(), onRight()])
            break
          case 4: // TR
          case 11: // 切掉 TR
            segs.push([onTop(), onRight()])
            break
          case 5: // BL + TR：鞍点，两条线
            segs.push([onLeft(), onTop()])
            segs.push([onBottom(), onRight()])
            break
          case 6: // TR + BR（右侧两点）
          case 9: // TL + BL（左侧两点）
            segs.push([onTop(), onBottom()])
            break
          case 7: // 切掉 TL
          case 8: // TL
            segs.push([onTop(), onLeft()])
            break
          case 10: // TL + BR：鞍点，两条线
            segs.push([onTop(), onRight()])
            segs.push([onLeft(), onBottom()])
            break
        }
      }
    }
  }

  const features: GeoJSON.Feature<GeoJSON.LineString>[] = []
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li]
    // 计曲线：从本区域最低一条起，每 5 条加粗一次（地形图惯例）。
    // 用「相对 eMin 的序号」而不是绝对海拔取模 —— 否则换一块区域，
    // 加粗的会是哪几条就飘了，图面节奏不稳。
    const isIndex = li % 5 === 0
    for (const line of joinSegments(buckets[li])) {
      if (line.length < 2) continue
      if (isTinyIsland(line, minIslandM2, areaScale)) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: { elevation: level, isIndex },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * 判断一条折线是否是「过小的闭合圈」（噪声孤岛）。
 *
 * DEM 里常有孤立尖峰：实测大鹏外海一整片 0.0 的海面中夹着一个 46m 的单格
 * 尖峰，marching squares 会围着它画出一圈小闭环 —— 图面上就是水上凭空多出
 * 一个"小岛"。面积低于阈值的一律丢掉。开放折线（没闭合的）一律保留：
 * 它们通常是贴着区域边界的真实等高线，不能按面积判断。
 */
function isTinyIsland(line: number[][], minIslandM2: number, areaScale: number): boolean {
  const n = line.length
  if (n < 4) return false // 三点以下的环不算"圈"，交给渲染去糙
  const a = line[0]
  const b = line[n - 1]
  if (a[0].toFixed(6) !== b[0].toFixed(6) || a[1].toFixed(6) !== b[1].toFixed(6)) return false
  // 鞋带公式（经纬度平面近似即可，这里只量"够不够大"）
  let s = 0
  for (let i = 0; i < n - 1; i++) {
    s += line[i][0] * line[i + 1][1] - line[i + 1][0] * line[i][1]
  }
  const areaM2 = Math.abs(s / 2) * areaScale
  return areaM2 < minIslandM2
}

/**
 * 把互不相连的两点线段首尾相接，拼成连续折线。
 *
 * marching squares 天然输出「一格一段」，一条等高线会被切成几十上百段。
 * 不拼接的话：① Feature 数是现在的几十倍，渲染与传输都浪费；② 每次
 * `line-dasharray`、`line-join` 都在极短的段上重新开始，视觉上毛刺、断续，
 * 这正是等高线看起来「不清楚」的直接原因之一。
 *
 * 端点用 6 位小数（约 0.1m）做 key：同一个 cell 边在相邻两个 cell 中会用
 * 相同的表达式算两次，结果逐位相同；留一点余量只为兜住极端情况下的 ULP 误差，
 * 精度远高于像元尺寸，不会把两条本该分开的线误接。
 */
function joinSegments(segs: number[][][]): number[][][] {
  if (segs.length === 0) return []
  const key = (p: number[]) => p[0].toFixed(6) + ',' + p[1].toFixed(6)

  const byPoint = new Map<string, number[]>()
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p)
      const list = byPoint.get(k)
      if (list) list.push(i)
      else byPoint.set(k, [i])
    }
  })

  const used = new Uint8Array(segs.length)
  const out: number[][][] = []

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const pts = [...segs[i]]

    // 向尾端生长
    for (;;) {
      const tail = pts[pts.length - 1]
      const k = key(tail)
      const next = (byPoint.get(k) || []).find((j) => !used[j])
      if (next === undefined) break
      used[next] = 1
      const s = segs[next]
      pts.push(key(s[0]) === k ? s[1] : s[0])
    }
    // 向首端生长
    for (;;) {
      const head = pts[0]
      const k = key(head)
      const prev = (byPoint.get(k) || []).find((j) => !used[j])
      if (prev === undefined) break
      used[prev] = 1
      const s = segs[prev]
      pts.unshift(key(s[0]) === k ? s[1] : s[0])
    }

    out.push(pts)
  }
  return out
}
