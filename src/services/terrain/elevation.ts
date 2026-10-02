import type { DEMGrid, ElevationStats, ExtremePoint } from '../../types'

export function elevationStats(grid: DEMGrid): ElevationStats {
  const vals: number[] = []
  for (let i = 0; i < grid.elevations.length; i++) {
    if (grid.mask[i]) {
      const e = grid.elevations[i]
      if (isFinite(e)) vals.push(e)
    }
  }
  if (vals.length === 0) {
    return { min: NaN, max: NaN, mean: NaN, median: NaN, range: NaN }
  }
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const v of vals) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const mean = sum / vals.length
  vals.sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  const median =
    vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]
  return { min, max, mean, median, range: max - min }
}

export function findExtremes(grid: DEMGrid): {
  highest: ExtremePoint
  lowest: ExtremePoint
} {
  let maxE = -Infinity
  let minE = Infinity
  let maxIdx = -1
  let minIdx = -1
  for (let i = 0; i < grid.elevations.length; i++) {
    if (!grid.mask[i]) continue
    const e = grid.elevations[i]
    if (!isFinite(e)) continue
    if (e > maxE) {
      maxE = e
      maxIdx = i
    }
    if (e < minE) {
      minE = e
      minIdx = i
    }
  }
  const toLonLat = (idx: number) => {
    const r = Math.floor(idx / grid.cols)
    const c = idx % grid.cols
    const lon = grid.minLon + ((c + 0.5) * (grid.maxLon - grid.minLon)) / grid.cols
    const lat = grid.minLat + ((r + 0.5) * (grid.maxLat - grid.minLat)) / grid.rows
    return { lon, lat }
  }
  const hi = toLonLat(maxIdx)
  const lo = toLonLat(minIdx)
  return {
    highest: { elevation: maxE, lon: hi.lon, lat: hi.lat },
    lowest: { elevation: minE, lon: lo.lon, lat: lo.lat },
  }
}
