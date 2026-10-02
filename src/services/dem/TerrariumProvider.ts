import type { Position } from 'geojson'
import { DEMError, type DEMProvider, type DEMQueryOptions } from './DEMProvider'

/**
 * 全球 DEM 瓦片数据源（AWS Terrain Tiles · Terrarium 编码）。
 *
 * 关键点：它用的就是「DEM 底图」的同一份瓦片。
 * 底图由 MapLibre 在 GPU 上按需加载、只负责显示，页面拿不到高程数值；
 * 这里则是前端自己取同一批瓦片、在本地解码成高程矩阵，再从矩阵里采样。
 *
 * 为什么快：瓦片是「一大块数据」，一个瓦片 256×256 = 6.5 万个高程值，
 * 一次请求就能覆盖上千个采样点；而逐点调用 REST 高程接口，
 * 3 万采样点要发数百个请求（受并发与往返延迟限制，通常要几十秒）。
 * 一次分析通常只需 4~36 个瓦片请求，而且这些瓦片多半已被底图加载过、命中浏览器缓存。
 *
 * 编码：elevation = R * 256 + G + B / 256 - 32768（米）
 */

const TILE_URL_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
/** 该数据集最大缩放级别（再往上只是插值） */
const MAX_ZOOM = 15
const MIN_ZOOM = 9
/** 单次分析的瓦片数量上限，超出就逐级降 zoom */
const MAX_TILES = 36
/**
 * 硬上限：降到 MIN_ZOOM 仍超过这个数量就放弃（交给兜底数据源）。
 * 正常分析范围上限 100 km²，最多也就几十个瓦片，这里只是防极端输入的保险丝。
 */
const HARD_TILE_LIMIT = 120
const CONCURRENCY = 8
/** 解码后瓦片的缓存上限（每个 256×256 约 256KB） */
const CACHE_CAP = 120
/** Web Mercator 赤道周长（米） */
const EARTH_CIRCUMFERENCE = 40075016.686

interface DemTile {
  size: number
  data: Float32Array
}

/** 解码后的瓦片缓存。Map 的插入顺序天然可做 LRU：命中即重新插入到末尾 */
const tileCache = new Map<string, DemTile>()

function cacheGet(key: string): DemTile | undefined {
  const t = tileCache.get(key)
  if (t) {
    tileCache.delete(key)
    tileCache.set(key, t)
  }
  return t
}

function cacheSet(key: string, tile: DemTile) {
  tileCache.set(key, tile)
  while (tileCache.size > CACHE_CAP) {
    const oldest = tileCache.keys().next().value
    if (oldest === undefined) break
    tileCache.delete(oldest)
  }
}

/** 经度 -> 瓦片 X（浮点，含瓦片内的小数位置） */
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z
}

/** 纬度 -> 瓦片 Y（浮点，Web Mercator 投影） */
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/** z 级下某纬度处「每瓦片像素」对应的地面距离（米） */
function metersPerPixel(lat: number, z: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z)
}

/** 把 PNG 瓦片解码成高程 Float32Array */
async function decodeTile(buf: ArrayBuffer): Promise<DemTile> {
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/png' }))
  const w = bitmap.width
  const h = bitmap.height

  let pixels: Uint8ClampedArray
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new DEMError('无法创建离屏画布解码 DEM 瓦片')
    ctx.drawImage(bitmap, 0, 0)
    pixels = ctx.getImageData(0, 0, w, h).data
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new DEMError('无法创建画布解码 DEM 瓦片')
    ctx.drawImage(bitmap, 0, 0)
    pixels = ctx.getImageData(0, 0, w, h).data
  }
  bitmap.close?.()

  const data = new Float32Array(w * h)
  for (let i = 0; i < data.length; i++) {
    const o = i * 4
    data[i] = pixels[o] * 256 + pixels[o + 1] + pixels[o + 2] / 256 - 32768
  }
  return { size: w, data }
}

/** 读取全局像素坐标处的高程；所在瓦片未加载时返回 NaN */
function readPixel(z: number, gx: number, gy: number, tilePx: number): number {
  const tx = Math.floor(gx / tilePx)
  const ty = Math.floor(gy / tilePx)
  const tile = tileCache.get(`${z}/${tx}/${ty}`)
  if (!tile) return NaN
  const px = gx - tx * tile.size
  const py = gy - ty * tile.size
  if (px < 0 || py < 0 || px >= tile.size || py >= tile.size) return NaN
  return tile.data[py * tile.size + px]
}

/** 双线性插值采样（缺像素时按可用权重归一化，避免边缘出现 NaN） */
function sampleBilinear(z: number, lon: number, lat: number, tilePx: number): number {
  const gx = lonToTileX(lon, z) * tilePx - 0.5
  const gy = latToTileY(lat, z) * tilePx - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0

  const e00 = readPixel(z, x0, y0, tilePx)
  const e10 = readPixel(z, x0 + 1, y0, tilePx)
  const e01 = readPixel(z, x0, y0 + 1, tilePx)
  const e11 = readPixel(z, x0 + 1, y0 + 1, tilePx)

  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy

  let sum = 0
  let wsum = 0
  if (isFinite(e00)) {
    sum += e00 * w00
    wsum += w00
  }
  if (isFinite(e10)) {
    sum += e10 * w10
    wsum += w10
  }
  if (isFinite(e01)) {
    sum += e01 * w01
    wsum += w01
  }
  if (isFinite(e11)) {
    sum += e11 * w11
    wsum += w11
  }
  return wsum > 0 ? sum / wsum : NaN
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

export class TerrariumProvider implements DEMProvider {
  readonly name = '全球 DEM 瓦片（AWS Terrain Tiles）'
  /** 最近一次实际生效的数据源名，供 UI 展示（自动回退时会是兜底源） */
  lastSource: string

  constructor(private readonly fallback?: DEMProvider) {
    this.lastSource = this.name
  }

  async queryElevations(
    points: Position[],
    options: DEMQueryOptions = {},
  ): Promise<number[]> {
    if (points.length === 0) return []
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    try {
      const result = await this.queryFromTiles(points, options)
      let valid = 0
      for (const v of result) if (isFinite(v)) valid++
      // 有效点足够 -> 直接用；数据源整体异常时才走兜底，避免"悄悄变慢"
      if (valid >= points.length * 0.6 || !this.fallback) {
        this.lastSource = this.name
        return result
      }
    } catch (e) {
      if (isAbort(e)) throw e
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!this.fallback) throw e
    }

    if (!this.fallback) throw new DEMError('DEM 数据获取失败')
    this.lastSource = this.fallback.name
    return this.fallback.queryElevations(points, options)
  }

  private async queryFromTiles(
    points: Position[],
    options: DEMQueryOptions,
  ): Promise<number[]> {
    const { onProgress, signal, resolutionM = 30 } = options

    // 1. 采样点外接范围
    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity
    for (const [lon, lat] of points) {
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    const centerLat = (minLat + maxLat) / 2

    // 2. 选缩放级别：让瓦片像素比采样间距细一倍（双线性插值才不丢细节）
    const targetPixel = Math.max(4, resolutionM / 2)
    let z = Math.ceil(
      Math.log2(
        (EARTH_CIRCUMFERENCE * Math.cos((centerLat * Math.PI) / 180)) / (256 * targetPixel),
      ),
    )
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

    // 3. 瓦片数量封顶（区域很大时逐级降 zoom，保证请求数可控）
    const span = (zz: number) => {
      const x0 = Math.floor(lonToTileX(minLon, zz))
      const x1 = Math.floor(lonToTileX(maxLon, zz))
      const y0 = Math.floor(latToTileY(maxLat, zz))
      const y1 = Math.floor(latToTileY(minLat, zz))
      return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) }
    }
    let range = span(z)
    while (z > MIN_ZOOM && range.count > MAX_TILES) {
      z--
      range = span(z)
    }
    if (range.count > HARD_TILE_LIMIT) {
      throw new DEMError(`分析范围过大（需 ${range.count} 个高程瓦片）`)
    }

    const last = 2 ** z - 1
    const tx0 = Math.max(0, range.x0)
    const tx1 = Math.min(last, range.x1)
    const ty0 = Math.max(0, range.y0)
    const ty1 = Math.min(last, range.y1)
    const tiles: [number, number][] = []
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) tiles.push([tx, ty])
    }

    // 4. 并发抓取 + 解码（命中缓存则跳过网络）
    let cursor = 0
    let loaded = 0
    const run = async () => {
      while (cursor < tiles.length) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const [tx, ty] = tiles[cursor++]
        const key = `${z}/${tx}/${ty}`
        try {
          if (!cacheGet(key)) {
            const res = await fetch(`${TILE_URL_BASE}/${z}/${tx}/${ty}.png`, {
              signal,
              mode: 'cors',
            })
            if (!res.ok) throw new DEMError(`DEM 瓦片请求失败 (HTTP ${res.status})`)
            cacheSet(key, await decodeTile(await res.arrayBuffer()))
          }
          loaded++
        } catch (e) {
          if (isAbort(e)) throw e
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          // 个别瓦片失败不致命：缺失像素后面按 NaN 处理
        }
        onProgress?.()
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, () => run()),
    )

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (loaded === 0) throw new DEMError('DEM 瓦片全部获取失败')

    // 瓦片尺寸以实际解码结果为准（常规为 256）
    let tilePx = 256
    for (const [tx, ty] of tiles) {
      const t = tileCache.get(`${z}/${tx}/${ty}`)
      if (t) {
        tilePx = t.size
        break
      }
    }

    // 5. 从瓦片矩阵采样
    const out = new Array<number>(points.length)
    for (let i = 0; i < points.length; i++) {
      out[i] = sampleBilinear(z, points[i][0], points[i][1], tilePx)
    }
    return out
  }
}

/** 供 UI 提示用：当前分辨率大致会拉多少个瓦片 */
export function estimateTileCount(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  resolutionM: number,
): number {
  const centerLat = (minLat + maxLat) / 2
  const targetPixel = Math.max(4, resolutionM / 2)
  let z = Math.ceil(
    Math.log2(
      (EARTH_CIRCUMFERENCE * Math.cos((centerLat * Math.PI) / 180)) / (256 * targetPixel),
    ),
  )
  z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
  const count = (zz: number) =>
    (Math.floor(lonToTileX(maxLon, zz)) - Math.floor(lonToTileX(minLon, zz)) + 1) *
    (Math.floor(latToTileY(minLat, zz)) - Math.floor(latToTileY(maxLat, zz)) + 1)
  while (z > MIN_ZOOM && count(z) > MAX_TILES) z--
  return count(z)
}

export { metersPerPixel }
