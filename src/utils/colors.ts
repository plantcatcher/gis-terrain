/** 高程配色：低海拔绿 → 黄 → 棕 → 高海拔白 */
const ELEVATION_STOPS: { v: number; c: [number, number, number] }[] = [
  { v: 0, c: [88, 160, 96] },
  { v: 200, c: [140, 180, 110] },
  { v: 500, c: [210, 200, 130] },
  { v: 1000, c: [200, 160, 90] },
  { v: 2000, c: [170, 110, 70] },
  { v: 3000, c: [150, 90, 70] },
  { v: 4000, c: [220, 210, 200] },
  { v: 5500, c: [255, 255, 255] },
]

export function elevationColor(elev: number, min: number, max: number): [number, number, number] {
  if (!isFinite(elev)) return [120, 120, 120]
  // 归一化到 stops
  for (let i = 0; i < ELEVATION_STOPS.length - 1; i++) {
    const a = ELEVATION_STOPS[i]
    const b = ELEVATION_STOPS[i + 1]
    if (elev >= a.v && elev <= b.v) {
      const t = (elev - a.v) / (b.v - a.v || 1)
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t),
      ]
    }
  }
  if (elev < ELEVATION_STOPS[0].v) return ELEVATION_STOPS[0].c
  return ELEVATION_STOPS[ELEVATION_STOPS.length - 1].c
}

/* ------------------------------------------------------------------ */
/* 分层设色（hypsometric tints）                                        */
/* ------------------------------------------------------------------ */

/**
 * 地形图通用色带：低地深绿 → 黄绿 → 黄 → 橙 → 棕 → 灰 → 雪白。
 * t 是「在本区域高差中的相对位置」而不是绝对海拔。
 */
const HYPSO_STOPS: { t: number; c: [number, number, number] }[] = [
  { t: 0.0, c: [44, 108, 78] },
  { t: 0.12, c: [104, 156, 84] },
  { t: 0.26, c: [178, 198, 96] },
  { t: 0.38, c: [228, 218, 108] },
  { t: 0.5, c: [222, 186, 84] },
  { t: 0.62, c: [206, 148, 66] },
  { t: 0.74, c: [178, 120, 62] },
  { t: 0.85, c: [150, 100, 66] },
  { t: 0.93, c: [178, 158, 146] },
  { t: 1.0, c: [244, 242, 238] },
]

function hypsometricAt(t: number): [number, number, number] {
  const tt = t <= 0 ? 0 : t >= 1 ? 1 : t
  for (let i = 0; i < HYPSO_STOPS.length - 1; i++) {
    const a = HYPSO_STOPS[i]
    const b = HYPSO_STOPS[i + 1]
    if (tt >= a.t && tt <= b.t) {
      const k = (tt - a.t) / (b.t - a.t || 1)
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * k),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * k),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * k),
      ]
    }
  }
  return HYPSO_STOPS[HYPSO_STOPS.length - 1].c
}

/**
 * 分层设色配色。
 *
 * 按 **区域内 min~max 自适应分级**，而不是套固定海拔断点：一块只有 80m
 * 高差的平原若按固定断点取色会整片同色，分层设色就失去意义了。
 *
 * 分级（离散）而不是连续渐变，是「分层设色法」的本意 —— 色阶边界本身就
 * 是等高程线，读图时能看出台阶感。
 */
export function hypsometricColor(
  elev: number,
  min: number,
  max: number,
  levels = 14,
): [number, number, number] {
  if (!isFinite(elev)) return [120, 120, 120]
  const span = max - min
  if (!(span > 0)) return hypsometricAt(0.5)
  const t = (elev - min) / span
  const q = Math.min(levels - 1, Math.max(0, Math.floor(t * levels)))
  return hypsometricAt((q + 0.5) / levels)
}

/**
 * 晕渲明暗系数。
 *
 * hillshade 的算法是 `cos(zenith)·cos(slope) + sin(zenith)·sin(slope)·cos(az−aspect)`，
 * 天顶角固定 45°，所以**平坦地面恒等于 cos45° ≈ 0.707 → 约 180**（不是 128）。
 * 以 180 为「不改变亮度」的中性点，背光压暗、顺光提亮，平地保持分层设色原色。
 */
export function reliefFactor(hs: number): number {
  const f = 0.4 + (hs / 180) * 0.6
  return f < 0.35 ? 0.35 : f > 1.28 ? 1.28 : f
}

/** 把明暗系数乘到 RGB 上（正片叠底式晕渲） */
export function applyRelief(
  c: [number, number, number],
  f: number,
): [number, number, number] {
  const cut = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  return [cut(c[0] * f), cut(c[1] * f), cut(c[2] * f)]
}

/** 坡度配色，按等级 */
const SLOPE_COLORS: Record<string, [number, number, number]> = {
  '0–5°': [60, 150, 80],
  '5–15°': [160, 200, 80],
  '15–25°': [240, 200, 60],
  '25–35°': [230, 120, 40],
  '>35°': [200, 40, 40],
}

export function slopeColor(deg: number): [number, number, number] {
  if (!isFinite(deg)) return [120, 120, 120]
  if (deg < 5) return SLOPE_COLORS['0–5°']
  if (deg < 15) return SLOPE_COLORS['5–15°']
  if (deg < 25) return SLOPE_COLORS['15–25°']
  if (deg < 35) return SLOPE_COLORS['25–35°']
  return SLOPE_COLORS['>35°']
}

export { SLOPE_COLORS }

/** 坡向配色：按罗盘方位映射色相（北=红，东=黄，南=青，西=蓝），平坦为灰 */
export function aspectColor(deg: number): [number, number, number] {
  if (!isFinite(deg)) return [200, 200, 200]
  return hslToRgb(deg / 360, 0.62, 0.5)
}

/* ------------------------------------------------------------------ */
/* 水文 / 曲率 / 视域                                                   */
/* ------------------------------------------------------------------ */

/**
 * 河网配色：细沟浅蓝 → 主干深蓝。
 *
 * 按汇流累积量取**对数**分级，而不是线性：同一块地上小河沟的汇水面积可以
 * 相差 3 个数量级，线性映射会把除主干以外的所有河道压成同一个颜色。
 */
const STREAM_RAMP: [number, number, number][] = [
  [147, 197, 253],
  [96, 165, 250],
  [59, 130, 246],
  [37, 99, 235],
  [30, 64, 175],
]

export function streamColor(
  accKm2: number,
  thresholdKm2: number,
  maxAccKm2: number,
): [number, number, number] {
  const span = Math.log(Math.max(maxAccKm2, thresholdKm2 * 1.0001) / thresholdKm2)
  if (!(span > 0) || !isFinite(accKm2)) return STREAM_RAMP[STREAM_RAMP.length - 1]
  const t = Math.log(Math.max(accKm2, thresholdKm2) / thresholdKm2) / span
  const q = Math.min(STREAM_RAMP.length - 1, Math.max(0, Math.floor(t * STREAM_RAMP.length)))
  return STREAM_RAMP[q]
}

/**
 * 地形湿度指数配色：干（棕）→ 湿（蓝），固定阈值分级。
 * TWI 是 ln(比汇水面积/tanβ)，取值本身就有物理含义（数值越大越容易积水），
 * 所以这里用**固定断点**而不是按区域自适应 —— 换一块地也能横向比较。
 */
const TWI_BREAKS: { max: number; c: [number, number, number] }[] = [
  { max: 4, c: [198, 146, 92] }, // 干：脊部、凸坡
  { max: 6, c: [226, 205, 138] }, // 略干
  { max: 8, c: [214, 228, 192] }, // 中等
  { max: 10, c: [122, 186, 186] }, // 较湿
  { max: Infinity, c: [46, 120, 180] }, // 湿：谷底、汇水区
]

export function twiColor(twi: number): [number, number, number] {
  if (!isFinite(twi)) return [150, 150, 150]
  for (const b of TWI_BREAKS) if (twi < b.max) return b.c
  return TWI_BREAKS[TWI_BREAKS.length - 1].c
}

/**
 * 平面曲率配色：发散型 5 级。
 * 正 = 凸（水流发散，山脊/坡肩）→ 暖色；负 = 凹（水流汇聚，谷底/坡脚）→ 冷色；
 * |曲率| ≤ 0.1（1/100m）视为近线性，用近白中间色。
 */
export function curvatureColor(k: number): [number, number, number] {
  if (!isFinite(k)) return [150, 150, 150]
  if (k >= 1) return [178, 24, 43]
  if (k >= 0.3) return [239, 138, 98]
  if (k > -0.3) return [240, 240, 235]
  if (k > -1) return [103, 169, 207]
  return [33, 102, 172]
}

/** 视域覆盖：可见 / 被遮挡 */
export const VIEWSHED_VISIBLE: [number, number, number] = [190, 242, 100]
export const VIEWSHED_HIDDEN: [number, number, number] = [30, 41, 59]

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}
