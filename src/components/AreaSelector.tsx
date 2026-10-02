import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, GeoJSON, Polygon, Position } from 'geojson'
import type { MapViewHandle } from './MapView'
import type { SelectionMode, SelectedArea } from '../types'
import { validateArea } from '../utils/validation'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/crs'
import { remainingTouches } from '../utils/device'

/** 外部（工具条按钮）驱动绘制流程的入口——触摸设备没有可靠的双击 */
export interface AreaSelectorHandle {
  /** 闭合当前多边形并提交 */
  finishPolygon: () => void
  /** 撤销最后一个顶点 */
  undoPoint: () => void
  /** 放弃当前绘制 */
  cancel: () => void
}

interface AreaSelectorProps {
  mapRef: React.RefObject<MapViewHandle>
  mode: SelectionMode
  onSelected: (area: SelectedArea) => void
  onError: (msg: string) => void
  disabled?: boolean
  mapReady?: boolean
  /** 当前底图是否为高德（GCJ-02），决定输入坐标是否需要转回 WGS84 */
  isGcj?: boolean
  /** 顶点数变化（驱动「完成/撤销」按钮的可用状态） */
  onPointsChange?: (n: number) => void
}

/** 预览图层共用一个 geojson 源，绘制过程中只 setData，不反复删/建源（否则会闪烁） */
const TEMP_SRC = 'temp-src'
const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** 拖拽判定阈值（屏幕像素）：小于它视为"轻点"，不是画框/拖地图 */
const DRAG_MIN_PX = { mouse: 4, touch: 12 }
/** 触摸时判定"轻点加点"的最大位移 */
const TAP_SLOP_PX = 12

export const AreaSelector = forwardRef<AreaSelectorHandle, AreaSelectorProps>(
  function AreaSelector(
    { mapRef, mode, onSelected, onError, disabled, mapReady, isGcj, onPointsChange },
    ref,
  ) {
    const stateRef = useRef({
      drawing: false,
      start: null as Position | null,
      startPt: null as { x: number; y: number } | null,
      points: [] as Position[],
    })

    /** 回调放进 ref：effect 依赖只保留 mode/disabled 等，避免每次渲染重绑事件 */
    const cbRef = useRef({ onSelected, onError, onPointsChange })
    cbRef.current = { onSelected, onError, onPointsChange }
    /** 多边形模式下的"轻点起点"（触摸），用于区分轻点加点 / 拖动平移 */
    const tapRef = useRef<{ lng: number; lat: number } | null>(null)
    /** 由 effect 赋值的命令实现 */
    const cmdRef = useRef({
      finish: () => {},
      undo: () => {},
      cancel: () => {},
    })

    useImperativeHandle(
      ref,
      () => ({
        finishPolygon: () => cmdRef.current.finish(),
        undoPoint: () => cmdRef.current.undo(),
        cancel: () => cmdRef.current.cancel(),
      }),
      [],
    )

    // 屏幕取到的坐标（高德底图下为 GCJ-02）-> 内部统一 WGS84
    const toWgs84 = (lng: number, lat: number): Position =>
      isGcj ? gcj02ToWgs84(lng, lat) : [lng, lat]

    // 内部 WGS84 -> 当前底图显示 CRS（绘制预览必须走这一步，
    // 否则高德底图上预览框会整体偏到左上约 500m，松手后真正的选区才回到指针处）
    const toDisplay = (p: Position): Position =>
      isGcj ? wgs84ToGcj02(p[0], p[1]) : [p[0], p[1]]

    /* ------------------------------------------------------------------ */
    /* 预览图层的增删改（显式接收 map，避免闭包捕获到过期的实例）           */
    /* ------------------------------------------------------------------ */

    /** 懒创建预览源与图层（只建一次） */
    function ensureTempLayers(m: MapLibreMap) {
      if (m.getSource(TEMP_SRC)) return
      m.addSource(TEMP_SRC, { type: 'geojson', data: EMPTY_FC })
      m.addLayer({
        id: 'temp-fill',
        type: 'fill',
        source: TEMP_SRC,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.22 },
      })
      // 折线与多边形轮廓都由此层绘制
      m.addLayer({
        id: 'temp-line',
        type: 'line',
        source: TEMP_SRC,
        filter: ['!=', ['geometry-type'], 'Point'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [4, 3] },
      })
      m.addLayer({
        id: 'temp-pts',
        type: 'circle',
        source: TEMP_SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          // 顶点稍大一点：触屏上要看得准落脚点
          'circle-radius': 5,
          'circle-color': '#2563eb',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      })
    }

    function setTempData(m: MapLibreMap, fc: FeatureCollection) {
      ensureTempLayers(m)
      const src = m.getSource(TEMP_SRC) as maplibregl.GeoJSONSource | undefined
      src?.setData(fc as unknown as GeoJSON.Feature)
    }

    /** 矩形预览：坐标为 WGS84，输出前转显示 CRS */
    function showRect(m: MapLibreMap, a: Position, b: Position) {
      const poly = rectToPolygon(a, b)
      const ring = poly.geometry.coordinates[0].map(toDisplay)
      setTempData(m, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: {},
          },
        ],
      })
    }

    /** 多边形预览：折线 + 顶点，坐标为 WGS84，输出前转显示 CRS */
    function showPolygon(m: MapLibreMap, pts: Position[]) {
      if (pts.length === 0) {
        clearTemp(m)
        return
      }
      const disp = pts.map(toDisplay)
      const features: Feature[] = []
      if (disp.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: disp },
          properties: {},
        })
      }
      for (const p of disp) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p },
          properties: {},
        })
      }
      setTempData(m, { type: 'FeatureCollection', features })
    }

    /** 清空预览（只清数据，保留源与图层，避免反复重建） */
    function clearTemp(m: MapLibreMap | undefined) {
      if (!m) return
      try {
        const src = m.getSource(TEMP_SRC) as maplibregl.GeoJSONSource | undefined
        src?.setData(EMPTY_FC as unknown as GeoJSON.Feature)
      } catch {
        // 地图已销毁 / style 已卸载（StrictMode 挂载-卸载-重挂时，MapView 的
        // map.remove() 先于本组件 cleanup 跑）：忽略，否则未捕获异常会崩掉
        // 整棵 React 树，dev 模式直接白屏。
      }
    }

    function handlePolygon(m: MapLibreMap, polygon: Feature<Polygon>) {
      const result = validateArea(polygon)
      if (!result.ok) {
        cbRef.current.onError(result.reason || '区域无效')
        clearTemp(m)
        return
      }
      const area: SelectedArea = {
        mode,
        feature: polygon,
        areaKm2: result.areaKm2!,
      }
      clearTemp(m)
      cbRef.current.onSelected(area)
    }

    /**
     * ⚠️ 必须在这里取 map，不能在渲染阶段取。
     *
     * `mapRef.current`（MapViewHandle）是 MapView 用 useImperativeHandle 挂上去的，
     * 它返回的实例又来自 MapView 内部的 ref —— 那个 ref 是 MapView 的 useEffect
     * 里才赋值的。所以在渲染阶段读，首次一定是 undefined；更坑的是后续重渲染时
     * 若 mapReady 早于实例就绪，这个值会一直卡在 undefined，于是 effect 只在
     * 「map=undefined」那次跑过一次，事件监听**从来没绑上**。
     * 正确做法：靠 mode / disabled / mapReady 触发重跑，进来后再取最新实例。
     */
    useEffect(() => {
      let raf = 0
      let cleanup: (() => void) | undefined
      let stopped = false

      const bind = (map: MapLibreMap): (() => void) => {
        clearTemp(map)
        stateRef.current.drawing = false
        stateRef.current.start = null
        stateRef.current.startPt = null
        tapRef.current = null
        if (disabled) {
          cmdRef.current = { finish: () => {}, undo: () => {}, cancel: () => {} }
          return () => {}
        }

        const emitPoints = () => cbRef.current.onPointsChange?.(stateRef.current.points.length)

        /* ---------------- 矩形：拖动框选 ---------------- */

        /** 起手：命中已有选区时让给 MapView 的拖动逻辑，不在此起矩形 */
        const beginRect = (lngLat: maplibregl.LngLat, point: maplibregl.Point) => {
          if (mapRef.current?.hitTestArea(point)) return false
          stateRef.current.drawing = true
          stateRef.current.start = toWgs84(lngLat.lng, lngLat.lat)
          stateRef.current.startPt = { x: point.x, y: point.y }
          return true
        }

        const moveRect = (lngLat: maplibregl.LngLat) => {
          const st = stateRef.current
          if (!st.drawing || !st.start) return
          showRect(map, st.start, toWgs84(lngLat.lng, lngLat.lat))
        }

        const endRect = (lngLat: maplibregl.LngLat, point: maplibregl.Point, minPx: number) => {
          const st = stateRef.current
          if (!st.drawing || !st.start || !st.startPt) return
          const moved = Math.hypot(point.x - st.startPt.x, point.y - st.startPt.y)
          const start = st.start
          st.drawing = false
          st.start = null
          st.startPt = null
          // 轻点/极短拖动视为误触，不产生选区
          if (moved < minPx) {
            clearTemp(map)
            return
          }
          handlePolygon(map, rectToPolygon(start, toWgs84(lngLat.lng, lngLat.lat)))
        }

        const abortRect = () => {
          stateRef.current.drawing = false
          stateRef.current.start = null
          stateRef.current.startPt = null
          clearTemp(map)
        }

        /* ---------------- 多边形：逐点绘制 ---------------- */

        const addPoint = (lngLat: maplibregl.LngLat) => {
          const p: Position = toWgs84(lngLat.lng, lngLat.lat)
          stateRef.current.points.push(p)
          showPolygon(map, stateRef.current.points)
          emitPoints()
        }

        const finishPolygon = () => {
          const pts = [...stateRef.current.points]
          // 双击闭合时会先触发一次 click，导致末点被加两次，去掉重复顶点
          if (pts.length >= 2) {
            const a = pts[pts.length - 1]
            const b = pts[pts.length - 2]
            if (a[0] === b[0] && a[1] === b[1]) pts.pop()
          }
          if (pts.length < 3) {
            cbRef.current.onError('多边形至少需要 3 个点，请继续添加顶点。')
            return
          }
          stateRef.current.points = []
          emitPoints()
          handlePolygon(map, pointsToPolygon([...pts, pts[0]]))
        }

        const undoPoint = () => {
          const pts = stateRef.current.points
          if (pts.length === 0) return
          pts.pop()
          showPolygon(map, pts)
          emitPoints()
        }

        const cancelDraw = () => {
          stateRef.current.points = []
          emitPoints()
          clearTemp(map)
        }

        cmdRef.current = { finish: finishPolygon, undo: undoPoint, cancel: cancelDraw }

        /* ---------------- 事件绑定 ---------------- */

        if (mode === 'rectangle') {
          // 地图能否平移由工具模式（手势/选择）统一控制（App -> MapView.setPanLocked），
          // 这里不再自己 disable/enable dragPan，避免两套逻辑互相打架。
          const onMouseDown = (e: maplibregl.MapMouseEvent) => {
            if (e.originalEvent.button !== 0) return
            beginRect(e.lngLat, e.point)
          }
          const onMouseMove = (e: maplibregl.MapMouseEvent) => moveRect(e.lngLat)
          const onMouseUp = (e: maplibregl.MapMouseEvent) =>
            endRect(e.lngLat, e.point, DRAG_MIN_PX.mouse)

          const onTouchStart = (e: maplibregl.MapTouchEvent) => {
            // 双指 = 缩放/平移地图，放弃本次框选
            if (e.points.length !== 1) {
              abortRect()
              return
            }
            beginRect(e.lngLat, e.point)
          }
          const onTouchMove = (e: maplibregl.MapTouchEvent) => {
            if (e.points.length > 1) {
              abortRect()
              return
            }
            moveRect(e.lngLat)
          }
          const onTouchEnd = (e: maplibregl.MapTouchEvent) => {
            // 还有手指按在屏幕上，等最后一根抬起再结算
            // （判断方式见 remainingTouches 的注释：不能用 e.points.length）
            if (remainingTouches(e) > 0) return
            endRect(e.lngLat, e.point, DRAG_MIN_PX.touch)
          }

          map.on('mousedown', onMouseDown)
          map.on('mousemove', onMouseMove)
          map.on('mouseup', onMouseUp)
          map.on('touchstart', onTouchStart)
          map.on('touchmove', onTouchMove)
          map.on('touchend', onTouchEnd)
          map.on('touchcancel', abortRect)
          return () => {
            map.off('mousedown', onMouseDown)
            map.off('mousemove', onMouseMove)
            map.off('mouseup', onMouseUp)
            map.off('touchstart', onTouchStart)
            map.off('touchmove', onTouchMove)
            map.off('touchend', onTouchEnd)
            map.off('touchcancel', abortRect)
            abortRect()
          }
        }

        // ---- polygon ----
        stateRef.current.points = []
        emitPoints()
        // 关闭双击缩放，避免双击结束时地图误放大
        if (map.doubleClickZoom) map.doubleClickZoom.disable()

        const onMouseClick = (e: maplibregl.MapMouseEvent) => {
          // 命中已有选区时交给拖动逻辑，不新增顶点
          if (mapRef.current?.hitTestArea(e.point)) return
          addPoint(e.lngLat)
        }
        const onDblClick = () => finishPolygon()

        /**
         * 触摸加顶点：起点与终点之间位移小于阈值才算"轻点"。
         * 否则视为拖动地图（多边形模式下拖地图用来换个位置继续画）。
         */
        const onTouchStart = (e: maplibregl.MapTouchEvent) => {
          if (e.points.length !== 1) {
            tapRef.current = null
            return
          }
          tapRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat }
        }
        const onTouchEnd = (e: maplibregl.MapTouchEvent) => {
          const start = tapRef.current
          tapRef.current = null
          // 多指操作（缩放/平移）不当作加点；手指没抬完也先不算
          if (!start || remainingTouches(e) > 0) return
          // 用投影后的屏幕距离判断，比比较经纬度可靠（纬度不同分辨率不同）
          const a = map.project([start.lng, start.lat])
          const b = map.project([e.lngLat.lng, e.lngLat.lat])
          if (Math.hypot(a.x - b.x, a.y - b.y) > TAP_SLOP_PX) return
          if (mapRef.current?.hitTestArea(b)) return
          addPoint(e.lngLat)
        }

        map.on('click', onMouseClick)
        map.on('dblclick', onDblClick)
        map.on('touchstart', onTouchStart)
        map.on('touchend', onTouchEnd)
        map.on('touchcancel', cancelDraw)
        return () => {
          map.off('click', onMouseClick)
          map.off('dblclick', onDblClick)
          map.off('touchstart', onTouchStart)
          map.off('touchend', onTouchEnd)
          map.off('touchcancel', cancelDraw)
          if (map.doubleClickZoom) map.doubleClickZoom.enable()
          clearTemp(map)
        }
      }

      /**
       * 地图实例是 MapView 在它自己的 effect 里挂到 mapRef 上的，
       * 而 mapReady（由地图 load 事件驱动，依赖瓦片网络）可能晚得多。
       * 所以这里不进 effect 就要求 map 就绪，而是拿不到就下一帧再试 ——
       * 否则一旦 load 慢半拍，事件监听就永远绑不上。
       */
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
    }, [mode, disabled, isGcj])

    return null
  },
)

function rectToPolygon(a: Position, b: Position): Feature<Polygon> {
  const minX = Math.min(a[0], b[0])
  const maxX = Math.max(a[0], b[0])
  const minY = Math.min(a[1], b[1])
  const maxY = Math.max(a[1], b[1])
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    },
    properties: {},
  }
}

function pointsToPolygon(ring: Position[]): Feature<Polygon> {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  }
}
