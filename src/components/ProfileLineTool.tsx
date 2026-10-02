import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { Position } from 'geojson'
import type { MapViewHandle } from './MapView'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/crs'

/** 触屏没有可靠的双击（双击在地图上是放大），绘制由面板上的「撤销 / 完成」按钮驱动 */
export interface ProfileLineHandle {
  /** 用当前顶点结算剖面线 */
  finish: () => void
  /** 删掉最后一个顶点 */
  undoPoint: () => void
}

interface ProfileLineToolProps {
  mapRef: React.RefObject<MapViewHandle>
  active: boolean
  onDrawn: (coords: Position[]) => void
  mapReady?: boolean
  /** 当前底图是否为高德（GCJ-02），决定是否把点击坐标转回 WGS84 */
  isGcj?: boolean
  /** 已完成的剖面线（WGS84）。绘制结束后留在图上，便于核对位置 */
  line?: Position[] | null
  /** 绘制中的顶点数（驱动「撤销 / 完成」按钮） */
  onPointsChange?: (n: number) => void
}

const SRC_LINE = 'prof-line-src'
const SRC_PTS = 'prof-pts-src'

/** 双击判定：两次 click 的时间间隔与屏幕位移都小于阈值，视为同一次双击 */
const DBL_WINDOW_MS = 350
const DBL_DIST_PX = 12

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection

/**
 * WGS84 -> 当前底图 CRS。
 *
 * ⚠️ 这是本组件最容易踩的坑：内部数据一律 WGS84，但高德底图是 GCJ-02。
 * 少了这一步，剖面线会整体偏移 500~600m —— 深圳约“偏西 526m、偏北 300m”，
 * 在城市尺度上肉眼看到的就是“线跑到左上角去了”。
 */
function toDisplay(p: Position, isGcj: boolean): Position {
  if (!isGcj) return [p[0], p[1]]
  const [lng, lat] = wgs84ToGcj02(p[0], p[1])
  return [lng, lat]
}

function ensureLayers(map: maplibregl.Map) {
  if (!map.getSource(SRC_LINE)) {
    map.addSource(SRC_LINE, { type: 'geojson', data: EMPTY_FC })
    map.addLayer({
      id: 'prof-line',
      type: 'line',
      source: SRC_LINE,
      paint: { 'line-color': '#9333ea', 'line-width': 3, 'line-opacity': 0.95 },
    })
  }
  if (!map.getSource(SRC_PTS)) {
    map.addSource(SRC_PTS, { type: 'geojson', data: EMPTY_FC })
    map.addLayer({
      id: 'prof-pts',
      type: 'circle',
      source: SRC_PTS,
      paint: {
        'circle-radius': 5,
        'circle-color': '#9333ea',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    })
  }
}

/**
 * 把 WGS84 顶点写进图层（渲染前做 CRS 变换）。
 * 用 setData 而不是反复 remove/add source：后者每加一个点就重建一次图层，
 * 既闪又容易撞上 “Source already exists”。
 */
function paint(map: maplibregl.Map, pts: Position[], isGcj: boolean) {
  const disp = pts.map((p) => toDisplay(p, isGcj))
  const lineSrc = map.getSource(SRC_LINE) as maplibregl.GeoJSONSource | undefined
  const ptSrc = map.getSource(SRC_PTS) as maplibregl.GeoJSONSource | undefined
  lineSrc?.setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: disp },
    properties: {},
  })
  ptSrc?.setData({
    type: 'FeatureCollection',
    features: disp.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c },
      properties: {},
    })),
  })
}

function removeLayers(map: maplibregl.Map) {
  try {
    for (const id of ['prof-line', 'prof-pts']) {
      if (map.getLayer(id)) map.removeLayer(id)
    }
    for (const id of [SRC_LINE, SRC_PTS]) {
      if (map.getSource(id)) map.removeSource(id)
    }
  } catch {
    // 地图已销毁 / style 已卸载：忽略
  }
}

export const ProfileLineTool = forwardRef<ProfileLineHandle, ProfileLineToolProps>(
  function ProfileLineTool(
    { mapRef, active, onDrawn, mapReady, isGcj, line, onPointsChange },
    ref,
  ) {
    /** 绘制中的顶点（WGS84） */
    const ptsRef = useRef<Position[]>([])
    const mapInstanceRef = useRef<maplibregl.Map | null>(null)
    /** 上一次 click 的时间与屏幕位置，用来吃掉双击多出来的那一次 click */
    const lastClickRef = useRef({ t: 0, x: 0, y: 0 })
    const wasActiveRef = useRef(false)
    /** 对外暴露的操作（由 effect 内注入，读的都是 ref，不会过期） */
    const apiRef = useRef<ProfileLineHandle>({ finish: () => {}, undoPoint: () => {} })

    const activeRef = useRef(active)
    const isGcjRef = useRef(!!isGcj)
    const lineRef = useRef<Position[] | null>(line ?? null)
    const onDrawnRef = useRef(onDrawn)
    const onPointsChangeRef = useRef(onPointsChange)
    activeRef.current = active
    isGcjRef.current = !!isGcj
    lineRef.current = line ?? null
    onDrawnRef.current = onDrawn
    onPointsChangeRef.current = onPointsChange

    useImperativeHandle(ref, () => apiRef.current, [])

    // 开始一轮新绘制（false -> true）时清掉上一轮的顶点
    if (active && !wasActiveRef.current) {
      ptsRef.current = []
      lastClickRef.current = { t: 0, x: 0, y: 0 }
    }
    wasActiveRef.current = active

    useEffect(() => {
      let raf = 0
      let cleanup: (() => void) | undefined
      let stopped = false

      const reportPoints = (n: number) => onPointsChangeRef.current?.(n)

      const finish = () => {
        const pts = ptsRef.current
        if (pts.length < 2) return
        ptsRef.current = []
        // 结算后线由 props.line 继续渲染，这里不用删图层（避免闪一帧空白）
        reportPoints(0)
        onDrawnRef.current([...pts])
      }

      const undoPoint = () => {
        if (!ptsRef.current.length) return
        ptsRef.current = ptsRef.current.slice(0, -1)
        reportPoints(ptsRef.current.length)
        const m = mapInstanceRef.current
        if (m) paint(m, ptsRef.current, isGcjRef.current)
      }
      apiRef.current = { finish, undoPoint }

      const bind = (map: maplibregl.Map): (() => void) => {
        ensureLayers(map)
        // 绘制中显示正在拾取的顶点；否则显示已完成的剖面线。
        // 这里顺带覆盖「切底图」的情况：CRS 变了，必须用新坐标系重画一遍。
        paint(map, activeRef.current ? ptsRef.current : lineRef.current ?? [], isGcjRef.current)

        if (!activeRef.current) return () => removeLayers(map)

        map.getCanvas().style.cursor = 'crosshair'

        const onClick = (e: maplibregl.MapMouseEvent) => {
          const now = performance.now()
          const prev = lastClickRef.current
          const secondOfDouble =
            now - prev.t < DBL_WINDOW_MS &&
            Math.hypot(e.point.x - prev.x, e.point.y - prev.y) < DBL_DIST_PX
          lastClickRef.current = { t: now, x: e.point.x, y: e.point.y }
          // 浏览器在 dblclick 之前会先派发两次 click，终点会被 push 两次；
          // 命中双击特征的第二下不再加点，交给 dblclick 结算。
          if (secondOfDouble && ptsRef.current.length >= 1) return

          // 高德底图的事件坐标是 GCJ-02，内部一律存 WGS84
          const p: Position = isGcjRef.current
            ? gcj02ToWgs84(e.lngLat.lng, e.lngLat.lat)
            : [e.lngLat.lng, e.lngLat.lat]
          ptsRef.current = [...ptsRef.current, p]
          reportPoints(ptsRef.current.length)
          paint(map, ptsRef.current, isGcjRef.current)
        }
        const onDblClick = () => finish()

        map.on('click', onClick)
        map.on('dblclick', onDblClick)
        return () => {
          map.off('click', onClick)
          map.off('dblclick', onDblClick)
          map.getCanvas().style.cursor = ''
          removeLayers(map)
        }
      }

      /**
       * 地图实例由 MapView 在它自己的 effect 里挂到 handle 上，可能比本组件的
       * 首次渲染晚；while 循环里的 rAF 轮询保证实例一就绪就绑上事件。
       */
      const start = () => {
        if (stopped) return
        const map = mapRef.current?.getMap()
        if (!map) {
          raf = requestAnimationFrame(start)
          return
        }
        mapInstanceRef.current = map
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

    // 已完成的剖面线变化 / 切底图时，只更新数据、不重绑事件
    useEffect(() => {
      if (active) return
      const map = mapInstanceRef.current
      if (!map) return
      ensureLayers(map)
      paint(map, line ?? [], !!isGcj)
    }, [line, active, isGcj])

    return null
  },
)

ProfileLineTool.displayName = 'ProfileLineTool'
