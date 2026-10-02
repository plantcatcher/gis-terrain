import { useState, useRef, useEffect } from 'react'
import type { MapViewHandle } from './MapView'
import { AMAP_KEY, AMAP_GEOCODE_URL, NOMINATIM_SEARCH_URL, PHOTON_SEARCH_URL } from '../config'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/crs'

interface SearchBoxProps {
  mapRef: React.RefObject<MapViewHandle>
  isGcj?: boolean
}

interface SearchResult {
  display_name: string
  lat: string
  lon: string
  /** 数据来源：高德返回 GCJ-02；Photon / Nominatim（OSM 系）返回 WGS84 */
  src: 'amap' | 'photon' | 'nominatim'
}

/** 单请求超时：搜索框体验优先，挂掉的源不等它自己超时（实测 Nominatim 国内直连会挂 15s+） */
const FETCH_TIMEOUT_MS = 8000

/** fetch + 超时 + JSON；任何失败都返回 null，由调用方决定回退 */
async function fetchJSON(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// 结果缓存：同一查询不重复请求，降低限流风险。
// ⚠️ 只缓存非空结果——网络抖动导致的空结果不能被记住，
// 否则本次会话里这个词永远搜不出（用户感知就是"搜索坏了"）。
const cache = new Map<string, SearchResult[]>()

async function geocode(q: string): Promise<SearchResult[]> {
  const key = q.trim().toLowerCase()
  if (!key) return []
  const cached = cache.get(key)
  if (cached) return cached

  let results: SearchResult[] = []

  // 1) 高德地理编码（国内覆盖好，需已配置 AMAP_KEY）
  if (AMAP_KEY) {
    const data = (await fetchJSON(
      `${AMAP_GEOCODE_URL}?key=${AMAP_KEY}&address=${encodeURIComponent(q)}`,
    )) as { status?: string; geocodes?: { formatted_address?: string; location?: string }[] } | null
    if (data?.status === '1' && Array.isArray(data.geocodes)) {
      results = data.geocodes
        .map((g) => {
          const [lon, lat] = (g.location || '').split(',').map(Number)
          if (!isFinite(lon) || !isFinite(lat)) return null
          return {
            display_name: g.formatted_address || q,
            lat: String(lat),
            lon: String(lon),
            src: 'amap' as const,
          }
        })
        .filter((r): r is SearchResult => r !== null)
    }
  }

  // 2) 兜底 Photon（OSM 系，免 key，国内可达；Nominatim 国内经常整站连不上）
  if (results.length === 0) {
    const data = (await fetchJSON(
      `${PHOTON_SEARCH_URL}?q=${encodeURIComponent(q)}&limit=5`,
    )) as {
      features?: {
        geometry?: { coordinates?: [number, number] }
        properties?: Record<string, string>
      }[]
    } | null
    if (Array.isArray(data?.features)) {
      results = data!.features
        .map((f) => {
          const coord = f.geometry?.coordinates
          const p = f.properties || {}
          const name = p.name || p.street || p.district || p.city
          if (!coord || !name) return null
          // 展示名拼上行政区划（有则拼），类似 Nominatim 的 display_name
          const parts = [p.state, p.country].filter((v, i, a) => v && v !== name && a.indexOf(v) === i)
          return {
            display_name: [name, ...parts].join(', '),
            lat: String(coord[1]),
            lon: String(coord[0]),
            src: 'photon' as const,
          }
        })
        .filter((r): r is SearchResult => r !== null)
    }
  }

  // 3) 最后兜底 Nominatim（海外部署 / Photon 也挂时），返回 WGS84
  if (results.length === 0) {
    const arr = (await fetchJSON(
      `${NOMINATIM_SEARCH_URL}?format=json&limit=5&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': 'zh-CN,en' } },
    )) as Omit<SearchResult, 'src'>[] | null
    if (Array.isArray(arr)) {
      results = arr.map((r) => ({ ...r, src: 'nominatim' as const }))
    }
  }

  if (results.length > 0) cache.set(key, results)
  return results
}

export function SearchBox({ mapRef, isGcj }: SearchBoxProps) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const timer = useRef<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const onChange = (v: string) => {
    setQ(v)
    if (timer.current) window.clearTimeout(timer.current)
    if (v.trim().length < 2) {
      setResults([])
      setOpen(false)
      return
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true)
      try {
        const data = await geocode(v)
        setResults(data)
        setOpen(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 400)
  }

  const select = (r: SearchResult) => {
    setQ(r.display_name)
    setOpen(false)
    // 地图坐标 = 显示 CRS。高德底图需 GCJ-02，其余用 WGS84。
    let lng = +r.lon
    let lat = +r.lat
    if (isGcj && r.src !== 'amap') {
      // Photon / Nominatim 是 WGS84 → 高德底图需要 GCJ-02
      ;[lng, lat] = wgs84ToGcj02(lng, lat)
    } else if (!isGcj && r.src === 'amap') {
      // 高德返回 GCJ-02 → WGS84 底图需要转回
      ;[lng, lat] = gcj02ToWgs84(lng, lat)
    }
    mapRef.current?.flyTo(lng, lat, 12)
  }

  return (
    <div className="search-box" ref={boxRef}>
      <input
        type="text"
        placeholder="搜索地点（如：珠穆朗玛峰、秦岭）"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {loading && <span className="search-loading">…</span>}
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={i} onClick={() => select(r)}>
              {r.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
