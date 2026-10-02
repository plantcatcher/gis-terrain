import type { DEMGrid, ElevationBin } from '../../types'

/**
 * 生成高程分布直方图。
 * 使用 Sturges 规则或固定分箱，优先按 min-max 自动分 10 档。
 */
export function elevationHistogram(
  grid: DEMGrid,
  bins = 12,
): ElevationBin[] {
  const vals: number[] = []
  for (let i = 0; i < grid.elevations.length; i++) {
    if (grid.mask[i]) {
      const e = grid.elevations[i]
      if (isFinite(e)) vals.push(e)
    }
  }
  if (vals.length === 0) return []

  let min = Infinity
  let max = -Infinity
  for (const v of vals) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (max === min) {
    return [
      {
        label: `${Math.round(min)} m`,
        range: [min, max],
        count: vals.length,
        ratio: 1,
      },
    ]
  }

  // 把 min/max 对齐到 50/100 的倍数，使标签整齐
  const step = niceStep((max - min) / bins)
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step

  const result: ElevationBin[] = []
  for (let lo = start; lo < end; lo += step) {
    const hi = lo + step
    result.push({
      label: `${Math.round(lo)}–${Math.round(hi)}m`,
      range: [lo, hi],
      count: 0,
      ratio: 0,
    })
  }
  for (const v of vals) {
    const idx = Math.min(result.length - 1, Math.floor((v - start) / step))
    if (idx >= 0 && idx < result.length) result[idx].count++
  }
  const total = vals.length
  for (const b of result) b.ratio = b.count / total
  return result
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / pow
  let nice
  if (n < 1.5) nice = 1
  else if (n < 3) nice = 2
  else if (n < 7) nice = 5
  else nice = 10
  return nice * pow
}
