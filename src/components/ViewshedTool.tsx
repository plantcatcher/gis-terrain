import { useEffect, useRef } from 'react'
import type { MapViewHandle } from './MapView'
import { gcj02ToWgs84 } from '../utils/crs'

interface ViewshedToolProps {
  mapRef: React.RefObject<MapViewHandle>
  /** 处于拾取状态时，单击地图即设观察点 */
  active: boolean
  onPick: (lon: number, lat: number) => void
  mapReady?: boolean
  /** 当前底图是否为高德（GCJ-02），决定是否把点击坐标转回 WGS84 */
  isGcj?: boolean
}

/**
 * 视域观察点拾取：单击地图取一个点。
 *
 * 比剖面线工具简单得多（只要一个点、不用结算），但**坐标变换这一步不能省** ——
 * 高德底图的事件坐标是 GCJ-02，内部数据一律 WGS84，少了转换视域会整体偏 500m，
 * 山脊山谷全对不上。
 */
export function ViewshedTool({ mapRef, active, onPick, mapReady, isGcj }: ViewshedToolProps) {
  const activeRef = useRef(active)
  const isGcjRef = useRef(!!isGcj)
  const onPickRef = useRef(onPick)
  activeRef.current = active
  isGcjRef.current = !!isGcj
  onPickRef.current = onPick

  useEffect(() => {
    let raf = 0
    let stopped = false
    let cleanup: (() => void) | undefined

    const bind = (map: maplibregl.Map): (() => void) | undefined => {
      if (!activeRef.current) return undefined
      const canvas = map.getCanvas()
      const prevCursor = canvas.style.cursor
      canvas.style.cursor = 'crosshair'
      const onClick = (e: maplibregl.MapMouseEvent) => {
        const [lon, lat] = isGcjRef.current
          ? gcj02ToWgs84(e.lngLat.lng, e.lngLat.lat)
          : [e.lngLat.lng, e.lngLat.lat]
        onPickRef.current(lon, lat)
      }
      map.on('click', onClick)
      return () => {
        map.off('click', onClick)
        canvas.style.cursor = prevCursor
      }
    }

    // 地图实例由 MapView 在自己的 effect 里创建，可能晚于本组件的首次渲染
    const start = () => {
      if (stopped) return
      const map = mapRef.current?.getMap()
      if (!map) {
        raf = requestAnimationFrame(start)
        return
      }
      cleanup = bind(map)
    }
    start()

    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, active, isGcj])

  return null
}
