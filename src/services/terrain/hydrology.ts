import type { DEMGrid, HydrologyStats } from '../../types'

/* =========================================================================
   水文分析（D8 单流向模型）

   流程：填洼 → 流向 → 汇流累积 → 河网提取 / 地形湿度指数

   为什么必须先填洼：DEM 里的每一个噪点坑都会把水流"关"在里面。不填洼时
   汇流累积会在一堆互不相连的局部低点上冒出一串孤立的"假源头"，河网被切得
   七零八落 —— 这是水文分析最典型的失败形态。

   填洼用 **Priority-Flood**（Barnes/Lehman/Mulla 2014）：把所有出口压进最小堆，
   按水位递增往外扩散，每个像元只在"水位首次确定"时入堆一次。单遍完成、
   O(n log n)、与地形复杂度无关。

   ⚠️ 这里原本用的是 Planchon & Darboux 迭代抬升，理由是"实现简单、网格规模下
   收敛快"。**实测证伪**：合成 300×300 起伏地形跑满 80 轮迭代仍未收敛
   （见 .workbuddy/tools/selftest-terrain.ts 的 C5 一节）。未收敛的后果不是
   "精度差一点"，而是**一部分洼地根本没被填平** —— 汇流到那里直接断流，
   河网被截成几段，而且从图上看不出任何异常。收敛所需的轮数 ≈ 流路上"扫描方向
   反转"的次数，跟网格大小同阶，所以靠调大轮数上限解决不了（大网格上会慢到不可用）。
   P&D 还踩过一个更隐蔽的坑：水位初值若直接取地形高程，平坦洼地每轮只能抬升 ε，
   一个 20m 深的平底坑要爬 2 万轮 —— 两者叠加就是"填了个寂寞"。

   ⚠️ 坐标系陷阱：grid 的**第 0 行是最南侧**（row 随纬度递增），而 GIS 里
   讲 3×3 邻域习惯把第一个当成西北角。本文件所有偏移量都按「r 变大 = 向北」
   显式推导，不要凭"看起来像"去套现成公式。
   ========================================================================= */

/**
 * 8 邻域偏移（按 N, NE, E, SE, S, SW, W, NW 罗盘顺序）。
 *
 * ⚠️⚠️ `dc` 是**必须**带上并在使用处检查的：把二维网格压成一维数组之后，
 * 跨越东西边界的偏移量会"绕"到相邻行的另一端 —— 比如 c=0 时的 `-cols-1`
 * 指向的是 (r-2, cols-1)，索引完全合法，`valid[j]` 根本查不出问题。
 * 在均匀南倾坡上那一格恰好比正南邻域更低，于是最西一列的水被凭空"传送"
 * 到东侧边缘，汇流累积量翻倍、河网在东西边缘连成一条假的南北大沟。
 * 这类越界不报错、只是结果静默变错，所以每个用到 off 的地方都要配 dc 检查。
 */
function neighborOffsets(cols: number) {
  const diag = Math.SQRT2
  return [
    { off: cols, dist: 1, dc: 0 }, // N
    { off: cols + 1, dist: diag, dc: 1 }, // NE
    { off: 1, dist: 1, dc: 1 }, // E
    { off: -cols + 1, dist: diag, dc: 1 }, // SE
    { off: -cols, dist: 1, dc: 0 }, // S
    { off: -cols - 1, dist: diag, dc: -1 }, // SW
    { off: -1, dist: 1, dc: -1 }, // W
    { off: cols - 1, dist: diag, dc: -1 }, // NW
  ]
}

type Nb = ReturnType<typeof neighborOffsets>

/** 邻域索引；越过列边界或数组范围时返回 -1（调用方必须先看返回值） */
function neighborIndex(i: number, c: number, cols: number, n: number, off: number, dc: number): number {
  const nc = c + dc
  if (nc < 0 || nc >= cols) return -1
  const j = i + off
  if (j < 0 || j >= n) return -1
  return j
}

/** 抬升步长（米）：让填洼后的平坦区域仍有严格的水流方向。
 *  Float32 在 8000m 量级的分辨率约 5e-4，1e-3 还剩 2 个 ULP，够稳。 */
const FILL_EPS = 1e-3

function validMask(grid: DEMGrid): Uint8Array {
  const { mask, elevations } = grid
  const v = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && isFinite(elevations[i])) v[i] = 1
  }
  return v
}

/**
 * 填洼诊断信息。别小看这几个字段 —— 迭代式填洼"没跑完"从结果上**看不出来**：
 * 最小松弛会让每个像元在第一轮就拿到一个有限值，所以"结果里没有 NaN/∞"
 * 完全不能证明收敛。P&D 那版就是靠这个漏掉的（详见文件头说明）。
 */
export interface FillDiagnostics {
  /** 已确定水位的像元数 */
  filledCells: number
  /** 网格内有效像元总数 */
  validCells: number
  /** 是否全覆盖。false 说明有像元没被处理到，结果不可用 */
  converged: boolean
  /** 扫描轮数。Priority-Flood 恒为 1 */
  passes: number
}

/**
 * Priority-Flood 填洼（Barnes / Lehman / Mulla 2014）：把每个洼地抬到"溢出口"的高度。
 *
 * 出口 = 网格外圈，以及域内但 8 邻域存在无效像元者（它们的水位就是地面高程）。
 * 把所有出口压进最小堆，反复弹出**水位最低**的像元，把它的未处理邻居的水位定为
 * `max(自身高程, 当前水位 + ε)` 并入堆。因为总是先处理水位低的，每个像元第一次
 * 被赋值就是它的最终值（到出口的最小溢流高度），**单遍结束**，与地形复杂度无关。
 *
 * ⚠️ 这里原本用的是 Planchon & Darboux 迭代抬升，理由是"实现简单、网格规模下
 * 收敛快"。**实测证伪**：合成 300×300 起伏地形跑满 80 轮迭代仍未收敛
 * （见 .workbuddy/tools/selftest-terrain.ts 的 C5 一节）。未收敛的后果不是
 * "精度差一点"，而是**一部分洼地根本没被填平** —— 汇流到那里直接断流，河网被
 * 截成几段，而且从图上看不出任何异常。所需轮数 ≈ 流路上"扫描方向反转"的次数，
 * 跟网格尺寸同阶，靠调大轮数上限解决不了（大网格上会慢到不可用）。
 * P&D 还踩过一个更隐蔽的坑：水位初值若直接取地形高程，平坦洼地每轮只能抬升 ε，
 * 一个 20m 深的平底坑要爬 2 万轮 —— 两者叠加就是"填了个寂寞"。
 *
 * 另一个**必须**注意的点：出口像元的水位取**自身高程**而不是 +∞/0。填洼只能
 * 抬升、不能下降 —— 否则整块地形会被拉平，坡度全丢。
 */
export function fillDepressions(grid: DEMGrid, diag?: FillDiagnostics): Float32Array {
  const { cols, rows, elevations } = grid
  const n = cols * rows
  const valid = validMask(grid)
  // 内部像元先留 +∞，等待从出口扩散过来
  const w = new Float32Array(n).fill(Infinity)
  const nbs = neighborOffsets(cols)
  const settled = new Uint8Array(n)

  // 二叉最小堆存像元索引；键直接读 w[idx]（水位一经确定不再改动），
  // 所以不需要再维护一个平行的键数组。容量 n：每个像元只入堆一次。
  const heap = new Int32Array(n + 1)
  let heapSize = 0
  const heapPush = (i: number) => {
    let p = ++heapSize
    heap[p] = i
    while (p > 1) {
      const par = p >> 1
      if (w[heap[par]] <= w[heap[p]]) break
      const t = heap[par]
      heap[par] = heap[p]
      heap[p] = t
      p = par
    }
  }
  /** 弹出并返回水位最低的像元索引（堆空时不可调用） */
  const heapPop = (): number => {
    const top = heap[1]
    heap[1] = heap[heapSize--]
    let p = 1
    for (;;) {
      const l = p << 1
      const r = l + 1
      let m = p
      if (l <= heapSize && w[heap[l]] < w[heap[m]]) m = l
      if (r <= heapSize && w[heap[r]] < w[heap[m]]) m = r
      if (m === p) break
      const t = heap[m]
      heap[m] = heap[p]
      heap[p] = t
      p = m
    }
    return top
  }

  let validCells = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!valid[i]) continue
      validCells++
      let edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1
      if (!edge) {
        for (const { off, dc } of nbs) {
          const j = neighborIndex(i, c, cols, n, off, dc)
          if (j < 0 || !valid[j]) {
            edge = true
            break
          }
        }
      }
      if (edge) {
        w[i] = elevations[i] // 出口：水位 = 地面高程
        settled[i] = 1
        heapPush(i)
      }
    }
  }

  let filledCells = 0
  while (heapSize > 0) {
    const i = heapPop()
    filledCells++
    const r = (i / cols) | 0
    const c = i - r * cols
    const t = w[i] + FILL_EPS
    for (const { off, dc } of nbs) {
      const j = neighborIndex(i, c, cols, n, off, dc)
      if (j < 0 || !valid[j] || settled[j]) continue
      settled[j] = 1
      const zj = elevations[j]
      // 地形本身高出当前水位 ⇒ 保持原高程（不被淹没，也挡住水流）；
      // 否则水位顶到「上游水位 + ε」，平坦区域由此获得一条指向出口的缓坡
      w[j] = zj >= t ? zj : t
      heapPush(j)
    }
  }

  if (diag) {
    diag.filledCells = filledCells
    diag.validCells = validCells
    diag.converged = filledCells === validCells
    diag.passes = 1
  }
  return w
}

export interface HydrologyGrids {
  /** 汇流累积 km²（含自身像元） */
  flowAcc: Float32Array
  /** 地形湿度指数 */
  twi: Float32Array
  streamMask: Uint8Array
  /** 填洼后的高程（调试/后续分析用） */
  filled: Float32Array
  stats: HydrologyStats
}

/**
 * 汇流面积阈值。
 * 取选区面积的 1%，并夹在 0.02~8 km²：阈值越大河网越稀疏。
 * 1% 是经验值 —— 固定阈值（比如一律 1 km²）在小选区上会一条河都不剩，
 * 在大选区上又会糊成一片毛细血管。
 */
export function pickStreamThreshold(areaKm2: number): number {
  if (!isFinite(areaKm2) || areaKm2 <= 0) return 0.1
  return Math.min(8, Math.max(0.02, areaKm2 * 0.01))
}

/** 平坦像元的 tan(坡度) 下限：1.15°，避免 ln(a/0) 爆成 Infinity */
const TAN_FLOOR = 0.02
const TWI_MIN = -5
const TWI_MAX = 25

export function computeHydrology(
  grid: DEMGrid,
  areaKm2: number,
  resolutionM: number,
  slopeGrid: Float32Array,
): HydrologyGrids {
  const { cols, rows } = grid
  const n = cols * rows
  const valid = validMask(grid)
  const nbs = neighborOffsets(cols)
  const cellSize = resolutionM
  const cellAreaKm2 = (cellSize / 1000) ** 2
  const filled = fillDepressions(grid)

/* ---------- 1. D8 流向：取坡度最陡的下坡邻域 ---------- */
  const down = new Int32Array(n).fill(-1)
  const stepKm = new Float32Array(n) // 到下游像元的距离 km
  const order: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!valid[i]) continue
      order.push(i)
      const z = filled[i]
      let bestDrop = 0
      let best = -1
      let bestDist = 0
      for (const { off, dist, dc } of nbs) {
        const j = neighborIndex(i, c, cols, n, off, dc)
        if (j < 0 || !valid[j]) continue
        // 按「降幅/距离」比而不是纯降幅：否则对角线总被优先选中，河网会呈现
        // 45° 锯齿
        const drop = (z - filled[j]) / dist
        if (drop > bestDrop) {
          bestDrop = drop
          best = j
          bestDist = dist
        }
      }
      down[i] = best
      if (best >= 0) stepKm[i] = (bestDist * cellSize) / 1000
    }
  }

  /* ---------- 2. 汇流累积 ---------- */
  // 按填洼后高程降序处理即为拓扑序：水流只会流向更低处，上游必然先被累加
  const sorted = new Uint32Array(order)
  sorted.sort((a, b) => filled[b] - filled[a])

  const flowAcc = new Float32Array(n)
  for (const i of order) flowAcc[i] = cellAreaKm2
  let maxAccKm2 = 0
  for (let k = 0; k < sorted.length; k++) {
    const i = sorted[k]
    const d = down[i]
    if (d >= 0) flowAcc[d] += flowAcc[i]
    if (flowAcc[i] > maxAccKm2) maxAccKm2 = flowAcc[i]
  }

  /* ---------- 3. 河网提取 ---------- */
  const thresholdKm2 = pickStreamThreshold(areaKm2)
  const streamMask = new Uint8Array(n)
  let streamCells = 0
  for (const i of order) {
    if (flowAcc[i] >= thresholdKm2) {
      streamMask[i] = 1
      streamCells++
    }
  }

  // 河网长度：只数「往东/往北」的 4 条边，每条无向边正好数一次。
  // 这样得到的不是"像元数 × 格距"的估算，而是 D8 路径的真实长度
  // （含对角段 ×√2）。
  let streamLengthKm = 0
  const edges = [
    { dr: 0, dc: 1, w: 1 }, // E
    { dr: 1, dc: 0, w: 1 }, // N
    { dr: 1, dc: 1, w: Math.SQRT2 }, // NE
    { dr: 1, dc: -1, w: Math.SQRT2 }, // NW
  ]
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!streamMask[i]) continue
      for (const { dr, dc, w } of edges) {
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue
        if (!streamMask[rr * cols + cc]) continue
        streamLengthKm += (w * cellSize) / 1000
      }
    }
  }

  // 最长主沟道：在河网内沿流向 DP
  const downLen = new Float32Array(n)
  let longestChannelKm = 0
  for (let k = sorted.length - 1; k >= 0; k--) {
    const i = sorted[k]
    const d = down[i]
    if (streamMask[i] && d >= 0 && streamMask[d]) {
      downLen[i] = stepKm[i] + downLen[d]
      if (downLen[i] > longestChannelKm) longestChannelKm = downLen[i]
    }
  }

  /* ---------- 4. 地形湿度指数 TWI ---------- */
  // TWI = ln(a / tanβ)，a 为比汇水面积（单位等高线宽度上的汇流面积 m²/m）。
  const twi = new Float32Array(n).fill(NaN)
  const twiVals: number[] = []
  let twiSum = 0
  for (const i of order) {
    const s = slopeGrid[i]
    if (!isFinite(s)) continue
    const a = (flowAcc[i] * 1e6) / cellSize
    const tanB = Math.max(TAN_FLOOR, Math.tan((s * Math.PI) / 180))
    let v = Math.log(a / tanB)
    if (!isFinite(v)) continue
    v = v < TWI_MIN ? TWI_MIN : v > TWI_MAX ? TWI_MAX : v
    twi[i] = v
    twiSum += v
    twiVals.push(v)
  }
  twiVals.sort((x, y) => x - y)
  const p80 = twiVals.length ? twiVals[Math.min(twiVals.length - 1, Math.floor(twiVals.length * 0.8))] : NaN
  let wet = 0
  for (let k = 0; k < twiVals.length; k++) if (twiVals[k] >= p80) wet++

  const stats: HydrologyStats = {
    thresholdKm2,
    streamCells,
    streamLengthKm,
    drainageDensity: areaKm2 > 0 ? streamLengthKm / areaKm2 : NaN,
    longestChannelKm,
    maxAccKm2,
    twiMean: twiVals.length ? twiSum / twiVals.length : NaN,
    twiP80: p80,
    wetRatio: twiVals.length ? wet / twiVals.length : NaN,
  }

  return { flowAcc, twi, streamMask, filled, stats }
}
