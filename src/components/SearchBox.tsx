import { useState, useRef, useEffect } from 'react'
import type { MapViewHandle } from './MapView'
import { AMAP_KEY, AMAP_GEOCODE_URL, NOMINATIM_SEARCH_URL } from '../config'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/crs'

interface SearchBoxProps {
  mapRef: React.RefObject<MapViewHandle>
  isGcj?: boolean
}

interface SearchResult {
  display_name: string
  lat: string
  lon: string
  /** 数据来源：高德返回 GCJ-02，Nominatim 返回 WGS84 */
  src: 'amap' | 'nominatim'
}

// 结果缓存：同一查询不重复请求，降低限流风险
const cache = new Map<string, SearchResult[]>()

async function geocode(q: string): Promise<SearchResult[]> {
  const key = q.trim().toLowerCase()
  if (!key) return []
  const cached = cache.get(key)
  if (cached) return cached

  let results: SearchResult[] = []

  // 1) 高德地理编码（国内覆盖好，需已配置 AMAP_KEY）
  if (AMAP_KEY) {
    try {
      const url = `${AMAP_GEOCODE_URL}?key=${AMAP_KEY}&address=${encodeURIComponent(q)}`
      const res = await fetch(url)
      const data = await res.json()
      if (data?.status === '1' && Array.isArray(data.geocodes)) {
        results = data.geocodes
          .map((g: { formatted_address?: string; location?: string }) => {
            const [lon, lat] = (g.location || '').split(',').map(Number)
            if (!isFinite(lon) || !isFinite(lat)) return null
            return {
              display_name: g.formatted_address || q,
              lat: String(lat),
              lon: String(lon),
              src: 'amap' as const,
            }
          })
          .filter((r: SearchResult | null): r is SearchResult => r !== null)
      }
    } catch {
      // 高德失败时回退 Nominatim
    }
  }

  // 2) 兜底 Nominatim（海外地名 / 高德无结果或未配置 key），返回 WGS84
  if (results.length === 0) {
    try {
      const res = await fetch(
        `${NOMINATIM_SEARCH_URL}?format=json&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'zh-CN,en' } },
      )
      const arr = (await res.json()) as Omit<SearchResult, 'src'>[]
      results = arr.map((r) => ({ ...r, src: 'nominatim' as const }))
    } catch {
      results = []
    }
  }

  cache.set(key, results)
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
    if (isGcj && r.src === 'nominatim') {
      // Nominatim 是 WGS84 → 高德底图需要 GCJ-02
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
