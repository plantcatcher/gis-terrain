import type { Position } from 'geojson'
import { DEMError, type DEMProvider, type DEMQueryOptions } from './DEMProvider'

/**
 * Open-Meteo Elevation API
 * - 免费、无需 API Key、全球覆盖
 * - 数据源：Copernicus DEM GLO-30 (30m)，部分区域 90m
 * - 文档: https://open-meteo.com/en/docs/elevation-api
 */
export class OpenMeteoProvider implements DEMProvider {
  readonly name = 'Open-Meteo (Copernicus DEM)'
  private static readonly ENDPOINT = 'https://api.open-meteo.com/v1/elevation'
  private static readonly BATCH = 80 // 单请求点数（Open-Meteo 上限约 100+）
  private static readonly CONCURRENCY = 6

  async queryElevations(
    points: Position[],
    options: DEMQueryOptions = {},
  ): Promise<number[]> {
    const { onProgress, signal } = options
    if (points.length === 0) return []
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const result = new Array<number>(points.length).fill(NaN)

    // 分批
    const batches: { indices: number[]; lats: string; lons: string }[] = []
    for (let i = 0; i < points.length; i += OpenMeteoProvider.BATCH) {
      const slice = points.slice(i, i + OpenMeteoProvider.BATCH)
      const indices = slice.map((_, idx) => i + idx)
      batches.push({
        indices,
        lats: slice.map((p) => p[1].toFixed(5)).join(','),
        lons: slice.map((p) => p[0].toFixed(5)).join(','),
      })
    }

    // 并发控制
    let cursor = 0
    const workers = Array.from({ length: OpenMeteoProvider.CONCURRENCY }, async () => {
      while (cursor < batches.length) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const idx = cursor++
        const batch = batches[idx]
        const url = `${OpenMeteoProvider.ENDPOINT}?latitude=${batch.lats}&longitude=${batch.lons}`
        let retry = 0
        while (retry < 3) {
          try {
            const res = await fetch(url, { signal })
            if (!res.ok) {
              if (res.status === 429) {
                await sleep(800 * (retry + 1))
                retry++
                continue
              }
              throw new DEMError(`DEM 请求失败 (HTTP ${res.status})`)
            }
            const data = (await res.json()) as { elevation: number[] }
            if (!data.elevation) {
              throw new DEMError('DEM 返回数据格式错误')
            }
            for (let k = 0; k < batch.indices.length; k++) {
              result[batch.indices[k]] = data.elevation[k] ?? NaN
            }
            onProgress?.()
            break
          } catch (e) {
            // 取消信号触发的错误不再重试，直接上抛
            if (e instanceof DOMException && e.name === 'AbortError') throw e
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            if (retry >= 2) throw e
            retry++
            await sleep(500 * retry)
          }
        }
      }
    })
    await Promise.all(workers)
    return result
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
