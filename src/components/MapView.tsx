import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, Polygon, Position, GeoJSON } from 'geojson'
import type {
  TerrainAnalysisResult,
  TerrainLayer,
  BasemapOption,
  DEMGrid,
  ViewshedResult,
} from '../types'
import {
  elevationColor,
  slopeColor,
  aspectColor,
  hypsometricColor,
  reliefFactor,
  applyRelief,
  streamColor,
  twiColor,
  curvatureColor,
  VIEWSHED_VISIBLE,
  VIEWSHED_HIDDEN,
} from '../utils/colors'
import { generateContours } from '../services/terrain/slope'
import { geodesicArea, ringCentroid } from '../utils/geo'
import { wgs84ToGcj02, gcj02ToWgs84, isGcjBasemap } from '../utils/crs'
import { remainingTouches } from '../utils/device'
import { SITE_OWNER } from '../config'

/**
 * 高德栅格瓦片（自动展开 4 个子域，避免单域限流）。栅格瓦片直连无需 key。
 *
 * `ltype` 是高德的「图层要素」开关：一旦带上，就只输出几何要素、剔除全部文字注记。
 * 实测（z13 深圳福田，同一瓦片）：
 *   style=7            → 矢量图（路网 + 注记）
 *   style=7&ltype=2    → 矢量路网，零文字注记
 *   style=8            → 路网 + 注记（透明底，叠在影像上）
 *   style=8&ltype=11   → 纯路网，零文字注记（透明底）
 * 注意 ltype 不影响坐标系，仍是 GCJ-02。
 */
const AMAP_SUBDOMAINS = ['1', '2', '3', '4']

/** 高德矢量底图：labels=false 时走 ltype=2（只有路网等地物，无注记） */
function amapVecTiles(labels: boolean): string[] {
  const lt = labels ? '' : '&ltype=2'
  return AMAP_SUBDOMAINS.map(
    (s) =>
      `https://wprd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7${lt}&x={x}&y={y}&z={z}`,
  )
}

/** 高德卫星瓦片：style=6 纯影像；style=8 叠加层（labels=false 时走 ltype=11，只留路网） */
function amapSatTiles(style: '6' | '8', labels = true): string[] {
  const lt = style === '8' && !labels ? '&ltype=11' : ''
  return AMAP_SUBDOMAINS.map(
    (s) =>
      `https://webst0${s}.is.autonavi.com/appmaptile?style=${style}&scl=1${lt}&x={x}&y={y}&z={z}`,
  )
}

/**
 * DEM 高程瓦片（AWS Terrain Tiles，Terrarium 编码：R*256+G+B/256-32768 米）。
 * 无需 key、全球覆盖，是 WGS84/Web Mercator 数据 —— 与内部坐标系完全一致，
 * 因此以 DEM 作底图时不存在高德 GCJ-02 那几百米的错位问题。
 */
const DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png']

/** 以 DEM 生成山体阴影底图：背景 + hillshade 两层 */
const DEM_BACKGROUND_PAINT = { 'background-color': '#eceff3' }
const DEM_HILLSHADE_PAINT = {
  // 光源西北 315°，与地形分析里的 hillshade 保持一致
  'hillshade-illumination-direction': 315,
  'hillshade-exaggeration': 0.45,
  'hillshade-shadow-color': '#5f5346',
  'hillshade-highlight-color': '#ffffff',
  'hillshade-accent-color': '#8d7c68',
}

export interface MapViewHandle {
  getMap: () => MapLibreMap | undefined
  fitToPolygon: (polygon: Feature<Polygon>) => void
  flyTo: (lon: number, lat: number, zoom?: number) => void
  renderTerrain: (result: TerrainAnalysisResult, layer: TerrainLayer) => void
  clearTerrainLayers: () => void
  setAreaOverlay: (polygon: Feature<Polygon> | null) => void
  setExtremeMarkers: (
    highest: { lon: number; lat: number; elev: number } | null,
    lowest: { lon: number; lat: number; elev: number } | null,
  ) => void
  /** 叠加/清除视域覆盖（null = 清除） */
  setViewshed: (viewshed: ViewshedResult | null) => void
  exportCanvas: () => string | undefined
  setAreaDraggable: (enabled: boolean) => void
  hitTestArea: (point: maplibregl.PointLike) => boolean
  /** 锁定/解锁地图平移（鼠标工具锁，手势工具解） */
  setPanLocked: (locked: boolean) => void
  /** 设置画布默认光标 */
  setCursor: (cursor: string) => void
}

/** 选区中心浮标的内容（面积文字 + 可选清除按钮） */
export interface AreaTag {
  text: string
  /** 接近面积上限等需要提醒的状态 */
  warn?: boolean
  /** 悬停提醒的文字 */
  hint?: string
  /** 是否显示清除按钮（结果阶段不给清，避免与结果面板逻辑打架） */
  clearable?: boolean
}

interface MapViewProps {
  basemap: BasemapOption
  /** 是否显示高德底图的路网与文字注记（仅对高德底图有效，默认 false = 干净无标注） */
  basemapLabels?: boolean
  onMapReady?: (map: MapLibreMap) => void
  onAreaMoved?: (feature: Feature<Polygon>) => void
  /** 选区中心浮标（面积 / 清除），null 表示隐藏 */
  areaTag?: AreaTag | null
  onClearArea?: () => void
}

/** 底图列表。**顺序即界面顺序**：高德卫星在第一位（也是默认项）—— 判读地形时
    影像比矢量图信息量大得多，用户第一眼就该看到它。 */
export const BASEMAPS: BasemapOption[] = [
  {
    id: 'amap-sat',
    name: '高德卫星',
    style: 'amap-sat',
  },
  {
    id: 'amap-vec',
    name: '高德矢量',
    style: 'amap-vec',
  },
  {
    id: 'osm',
    name: 'OSM',
    style: 'osm',
  },
  {
    id: 'dem',
    name: 'DEM 地形',
    style: 'dem',
  },
]

/** 默认底图 id（显式写出来，避免以后有人调整数组顺序时悄悄改了默认值） */
export const DEFAULT_BASEMAP_ID = 'amap-sat'

export function defaultBasemap(): BasemapOption {
  return BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP_ID) ?? BASEMAPS[0]
}

function buildStyle(basemapId: string, showLabels = false): maplibregl.StyleSpecification {
  const sources: Record<
    string,
    maplibregl.RasterSourceSpecification | maplibregl.RasterDEMSourceSpecification
  > = {}
  const layers: maplibregl.LayerSpecification[] = []

  if (basemapId === 'dem') {
    sources['dem'] = {
      type: 'raster-dem',
      tiles: DEM_TILES,
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
      attribution: 'DEM © AWS Terrain Tiles',
    }
    layers.push({ id: 'dem-bg', type: 'background', paint: DEM_BACKGROUND_PAINT })
    layers.push({
      id: 'dem-hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: DEM_HILLSHADE_PAINT,
    })
  } else if (basemapId === 'osm') {
    sources['osm'] = {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    }
    layers.push({ id: 'osm', type: 'raster', source: 'osm' })
  } else if (basemapId === 'amap-vec') {
    sources['amap-vec'] = {
      type: 'raster',
      tiles: amapVecTiles(showLabels),
      tileSize: 256,
      attribution: '© 高德地图 GS(2024)xxxx',
    }
    layers.push({ id: 'amap-vec', type: 'raster', source: 'amap-vec' })
  } else if (basemapId === 'amap-sat') {
    sources['amap-sat'] = {
      type: 'raster',
      tiles: amapSatTiles('6'),
      tileSize: 256,
      attribution: '© 高德地图',
    }
    layers.push({ id: 'amap-sat', type: 'raster', source: 'amap-sat' })
    if (showLabels) {
      // 叠加路网与注记
      sources['amap-sat-label'] = {
        type: 'raster',
        tiles: amapSatTiles('8', true),
        tileSize: 256,
      }
      layers.push({ id: 'amap-sat-label', type: 'raster', source: 'amap-sat-label' })
    }
  }

  return {
    version: 8,
    sources,
    layers,
  } as unknown as maplibregl.StyleSpecification
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
  ({ basemap, basemapLabels = false, onMapReady, onAreaMoved, areaTag, onClearArea }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const mapRef = useRef<MapLibreMap>()
    const firstBasemap = useRef(true)
    // 当前底图 id（用于决定渲染坐标是否需要 GCJ-02 变换）
    const basemapIdRef = useRef(basemap.id)
    // 已渲染状态的引用，底图切换后用新 CRS 重新渲染
    const lastAreaRef = useRef<Feature<Polygon> | null>(null)
    const lastResultRef = useRef<TerrainAnalysisResult | null>(null)
    const lastLayerRef = useRef<TerrainLayer>('elevation')
    const lastHiRef = useRef<{ lon: number; lat: number; elev: number } | null>(null)
    const lastLoRef = useRef<{ lon: number; lat: number; elev: number } | null>(null)
    /** 已算出的视域（切底图后要按新 CRS 重画，所以留在 ref 里） */
    const lastViewshedRef = useRef<ViewshedResult | null>(null)
    /** 极端点说明气泡 */
    const popupRef = useRef<maplibregl.Popup | null>(null)
    const dragEnabledRef = useRef(false)
    /** 地图平移是否被工具模式锁定（true = 鼠标工具，禁止拖拽平移） */
    const panLockRef = useRef(false)
    /** 默认光标（由工具模式决定：hand -> grab，select -> crosshair） */
    const cursorRef = useRef('')
    /** 选区中心浮标（面积标签 + 清除按钮），跟随矢量与底图 CRS 走 */
    const areaTagMarkerRef = useRef<maplibregl.Marker | null>(null)
    const areaTagElRef = useRef<HTMLDivElement | null>(null)
    const areaTagBtnRef = useRef<HTMLButtonElement | null>(null)
    const clearAreaRef = useRef(onClearArea)
    clearAreaRef.current = onClearArea
    // 浮标内容由 props 驱动，但 setAreaOverlay 是命令式调用（拖动/切底图），
    // 用 ref 让那两处也能同步到最新文案
    const areaTagPropRef = useRef<AreaTag | null>(areaTag ?? null)
    areaTagPropRef.current = areaTag ?? null

    const toDisplay = (lng: number, lat: number): [number, number] => {
      if (isGcjBasemap(basemapIdRef.current)) return wgs84ToGcj02(lng, lat)
      return [lng, lat]
    }

    const applyPanLock = (map: MapLibreMap) => {
      if (!map.dragPan) return
      if (panLockRef.current) map.dragPan.disable()
      else map.dragPan.enable()
    }

    useImperativeHandle(ref, () => ({
      getMap: () => mapRef.current,
      fitToPolygon: (polygon) => {
        const map = mapRef.current
        if (!map) return
        // bbox 需按显示 CRS 变换，否则在高德底图上会整体偏约 500m
        const ring = polygon.geometry.coordinates[0].map(([lng, lat]) => toDisplay(lng, lat))
        const bbox = bboxOfRing(ring)
        map.fitBounds(bbox as [number, number, number, number], {
          padding: 60,
          duration: 600,
        })
      },
      flyTo: (lon, lat, zoom = 13) => {
        mapRef.current?.flyTo({ center: [lon, lat], zoom, duration: 800 })
      },
      renderTerrain: (result, layer) => {
        lastResultRef.current = result
        lastLayerRef.current = layer
        renderTerrainOverlay(result, layer)
      },
      clearTerrainLayers: () => {
        clearTerrainLayers()
      },
      setAreaOverlay: (polygon) => {
        lastAreaRef.current = polygon
        setAreaOverlay(polygon)
      },
      setExtremeMarkers: (highest, lowest) => {
        lastHiRef.current = highest
        lastLoRef.current = lowest
        setExtremeMarkers(highest, lowest)
      },
      setViewshed: (viewshed) => {
        lastViewshedRef.current = viewshed
        renderViewshedOverlay(viewshed)
      },
      exportCanvas: () => {
        const c = mapRef.current?.getCanvas()
        if (!c) return undefined
        try {
          return c.toDataURL('image/png')
        } catch {
          return undefined
        }
      },
      setAreaDraggable: (enabled: boolean) => {
        dragEnabledRef.current = enabled
        if (!enabled) {
          const map = mapRef.current
          if (map && map.getCanvas().style.cursor === 'grabbing') {
            map.getCanvas().style.cursor = cursorRef.current
          }
        }
      },
      hitTestArea: (point) => {
        const map = mapRef.current
        if (!map) return false
        if (!map.getLayer('area-fill')) return false
        const feats = map.queryRenderedFeatures(point, { layers: ['area-fill'] })
        return feats.length > 0
      },
      setPanLocked: (locked) => {
        panLockRef.current = locked
        const map = mapRef.current
        if (map) applyPanLock(map)
      },
      setCursor: (cursor) => {
        cursorRef.current = cursor
        const map = mapRef.current
        if (!map) return
        const el = map.getCanvas()
        if (el.style.cursor !== 'grabbing') el.style.cursor = cursor
      },
    }))

    useEffect(() => {
      if (!containerRef.current || mapRef.current) return
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: buildStyle(basemap.id, basemapLabels),
        center: [104.0, 30.0],
        zoom: 4,
        // 底图署名之外再挂一条本站署名：地图右下角是唯一"永远在屏幕上"的角落，
        // 截图导出时也会跟着进 PNG，比页脚更难被忽略。
        attributionControl: { compact: true, customAttribution: `© ${SITE_OWNER} · 地形分析器` },
        // 关键：保留绘制缓冲区，否则 toDataURL 导出 PNG 会得到黑图
        preserveDrawingBuffer: true,
        // 底图是无旋转的电子地图（高德瓦片），偏转/倾斜只会让瓦片露边、判读变难。
        // 关掉旋转还顺手解决了触屏上双指微微打转就把整个视图拧歪的问题。
        dragRotate: false,
        touchPitch: false,
        pitchWithRotate: false,
      })
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
      map.touchZoomRotate.disableRotation()
      mapRef.current = map

      // 选区矢量拖动：仅在允许时生效（圈选阶段 + 鼠标工具 + 已有选区）
      // 鼠标与触摸共用同一套 begin/move/end，区别只在事件源和"起手判定"
      let dragging = false
      let startLngLat: { lng: number; lat: number } | null = null
      let startCoords: Position[] = []
      const overArea = (point: maplibregl.PointLike) => {
        if (!map.getLayer('area-fill')) return false
        return map.queryRenderedFeatures(point, { layers: ['area-fill'] }).length > 0
      }

      const beginDrag = (lngLat: { lng: number; lat: number }) => {
        if (!dragEnabledRef.current) return false
        if (!lastAreaRef.current) return false
        dragging = true
        startLngLat = { lng: lngLat.lng, lat: lngLat.lat }
        const ring = lastAreaRef.current.geometry.coordinates[0]
        startCoords = ring.map((p) => [p[0], p[1]] as Position)
        map.getCanvas().style.cursor = 'grabbing'
        return true
      }

      const moveDrag = (lngLat: { lng: number; lat: number }) => {
        if (!dragging || !startLngLat) return false
        const dLng = lngLat.lng - startLngLat.lng
        const dLat = lngLat.lat - startLngLat.lat
        const moved = startCoords.map(([x, y]) => [x + dLng, y + dLat] as Position)
        const ring = [...moved, moved[0]]
        const poly: Feature<Polygon> = {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: {},
        }
        setAreaOverlay(poly)
        return true
      }

      const endDrag = () => {
        if (!dragging) return
        dragging = false
        startLngLat = null
        map.getCanvas().style.cursor = cursorRef.current
        if (lastAreaRef.current && onAreaMoved) {
          onAreaMoved(lastAreaRef.current)
        }
      }

      const onDown = (e: maplibregl.MapMouseEvent) => {
        if (e.originalEvent.button !== 0) return
        if (!overArea(e.point)) return
        beginDrag(e.lngLat)
      }
      const onMove = (e: maplibregl.MapMouseEvent) => {
        if (moveDrag(e.lngLat)) return
        // 悬停在选区上时给"可移动"光标提示
        if (!dragEnabledRef.current) return
        const want = overArea(e.point) ? 'move' : cursorRef.current
        const el = map.getCanvas()
        if (el.style.cursor !== want) el.style.cursor = want
      }
      const onUp = () => endDrag()

      // 触屏：单指按住选区拖动；第二根手指落下即让位给缩放/平移
      const onTouchStart = (e: maplibregl.MapTouchEvent) => {
        if (e.points.length !== 1) return
        if (!overArea(e.point)) return
        beginDrag(e.lngLat)
      }
      const onTouchMove = (e: maplibregl.MapTouchEvent) => {
        if (e.points.length > 1) {
          // 双指：取消拖动，把控制权交回地图手势
          dragging = false
          startLngLat = null
          return
        }
        moveDrag(e.lngLat)
      }
      const onTouchEnd = (e: maplibregl.MapTouchEvent) => {
        // 不能用 e.points.length 判断（MapLibre 在 touchend 时取的是 changedTouches）
        if (remainingTouches(e) > 0) return
        endDrag()
      }

      map.on('mousedown', onDown)
      map.on('mousemove', onMove)
      map.on('mouseup', onUp)
      map.on('touchstart', onTouchStart)
      map.on('touchmove', onTouchMove)
      map.on('touchend', onTouchEnd)
      map.on('touchcancel', endDrag)

      /* ---- 最高点 / 最低点：点击弹出说明 ---- */
      // 图上只有两个彩色圆点，不说清楚是什么，用户只会看到"两个点"。
      // 命中判定把点外扩 8px：圆点半径才 7px，鼠标很难精准点中，手指基本点不到。
      const HIT_PAD = 8
      const markerLayers = () =>
        ['marker-hi', 'marker-lo'].filter((id) => map.getLayer(id))

      const onMarkerClick = (e: maplibregl.MapMouseEvent) => {
        const layers = markerLayers()
        if (!layers.length) return
        const f = map.queryRenderedFeatures(
          [
            [e.point.x - HIT_PAD, e.point.y - HIT_PAD],
            [e.point.x + HIT_PAD, e.point.y + HIT_PAD],
          ],
          { layers },
        )[0]
        if (!f) return
        const p = f.properties || {}
        if (!popupRef.current) {
          popupRef.current = new maplibregl.Popup({
            closeButton: true,
            maxWidth: '252px',
            offset: 13,
            className: 'terrain-popup',
          })
        }
        popupRef.current
          .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
          .setHTML(
            extremePopupHtml(
              String(p.kind),
              Number(p.elev),
              Number(p.lon),
              Number(p.lat),
            ),
          )
          .addTo(map)
      }

      // 悬停变手型。注册顺序在 onMove 之后 —— 后者每帧都在写 cursor，
      // 只有后注册的这个才能把它覆盖成 pointer。
      const onMarkerHover = (e: maplibregl.MapMouseEvent) => {
        const layers = markerLayers()
        if (!layers.length || dragging) return
        const hit =
          map.queryRenderedFeatures(
            [
              [e.point.x - HIT_PAD, e.point.y - HIT_PAD],
              [e.point.x + HIT_PAD, e.point.y + HIT_PAD],
            ],
            { layers },
          ).length > 0
        if (hit) map.getCanvas().style.cursor = 'pointer'
      }

      map.on('click', onMarkerClick)
      map.on('mousemove', onMarkerHover)

      map.on('load', () => {
        applyPanLock(map)
        onMapReady?.(map)
      })
      return () => {
        map.off('mousedown', onDown)
        map.off('mousemove', onMove)
        map.off('mouseup', onUp)
        map.off('touchstart', onTouchStart)
        map.off('touchmove', onTouchMove)
        map.off('touchend', onTouchEnd)
        map.off('touchcancel', endDrag)
        map.off('click', onMarkerClick)
        map.off('mousemove', onMarkerHover)
        popupRef.current?.remove()
        popupRef.current = null
        map.remove()
        mapRef.current = undefined
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 切换底图 / 切换路网注记（不使用 setStyle，避免清除分析图层）
    useEffect(() => {
      const map = mapRef.current
      if (!map) return
      const prevId = basemapIdRef.current
      const sameBasemap = prevId === basemap.id
      basemapIdRef.current = basemap.id
      if (firstBasemap.current) {
        firstBasemap.current = false
        return
      }

      // 高德瓦片是 GCJ-02 内容被当作 WGS84 加载，与 OSM(WGS84) 的地图内容
      // 本身就相差约 500m。切到另一套坐标系时，把「视图中心」做一次坐标空间互换，
      // 这样同一实地位置仍居中，画面不会突然跳动。
      const prevGcj = isGcjBasemap(prevId)
      const nextGcj = isGcjBasemap(basemap.id)
      if (prevGcj !== nextGcj) {
        const c = map.getCenter()
        const [lng, lat] = prevGcj
          ? gcj02ToWgs84(c.lng, c.lat)
          : wgs84ToGcj02(c.lng, c.lat)
        map.jumpTo({ center: [lng, lat] })
      }

      const reapply = () => {
        applyBasemap(map, basemap.id, basemapLabels)
        // 只切了注记开关：坐标系没变，已渲染图层无需重建
        if (sameBasemap) return
        // 气泡里写的是 GCJ-02 坐标，换坐标系后必须关掉，否则指着旧位置
        popupRef.current?.remove()
        // 用新 CRS 重新渲染所有图层，保证与底图对齐
        setAreaOverlay(lastAreaRef.current)
        setExtremeMarkers(lastHiRef.current, lastLoRef.current)
        renderViewshedOverlay(lastViewshedRef.current)
        if (lastResultRef.current) {
          renderTerrainOverlay(lastResultRef.current, lastLayerRef.current)
        }
      }
      if (!map.isStyleLoaded()) {
        map.once('style.load', reapply)
        return
      }
      reapply()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [basemap.id, basemapLabels])

    // 浮标文案 / 可清除状态变化时同步（选区本身没变，不必重建矢量图层）
    useEffect(() => {
      syncAreaTag()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [areaTag?.text, areaTag?.warn, areaTag?.hint, areaTag?.clearable])

    function clearTerrainLayers() {
      const map = mapRef.current
      if (!map) return
      // 只清地形栅格与等高线。选区轮廓(area-*)与极端点标记(marker-*)由各自逻辑独立管理，
      // 切换地形图层时不应被清掉，否则用户会丢失空间参照。
      for (const id of ['contour-casing', 'contour-line', 'terrain-img']) {
        if (map.getLayer(id)) map.removeLayer(id)
      }
      if (map.getSource('terrain-img')) map.removeSource('terrain-img')
      if (map.getSource('contour-src')) map.removeSource('contour-src')
    }

    // 找到第一个存在的“常驻图层”，把地形栅格插到它下方，保证选区/标记始终在地形之上
    function firstExisting(map: maplibregl.Map, ids: string[]): string | undefined {
      for (const id of ids) if (map.getLayer(id)) return id
      return undefined
    }

    function renderTerrainOverlay(
      result: TerrainAnalysisResult,
      layer: TerrainLayer,
    ) {
      const map = mapRef.current
      if (!map) return
      clearTerrainLayers()
      const { grid, slopeGrid, hillshade, aspectGrid, elevation } = result
      const { cols, rows, minLon, minLat, maxLon, maxLat, elevations, mask } = grid

      const canvas = document.createElement('canvas')
      canvas.width = cols
      canvas.height = rows
      const ctx = canvas.getContext('2d')!
      const imgData = ctx.createImageData(cols, rows)
      const data = imgData.data

      // ---- 逐像元上色 ----
      // 缺栅格就整层透明：早于本版本保存的历史项目没有水文/曲率网格，
      // 打开时不能因为读 undefined 直接崩掉。
      const missStreams = !result.streamMask || !result.flowAccGrid
      const missTwi = !result.twiGrid
      const missCurv = !result.curvGrid
      const setPx = (o: number, rgb: readonly number[] | null, alpha: number) => {
        if (!rgb) {
          data[o + 3] = 0
          return
        }
        data[o] = rgb[0]
        data[o + 1] = rgb[1]
        data[o + 2] = rgb[2]
        data[o + 3] = alpha
      }
      const hy = (e: number) => hypsometricColor(e, elevation.min, elevation.max)

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // 数据行 (rows-1-r) 与画布行 r 反向：图像源的像素行 0 对应地图北侧(maxLat)，
          // 而网格 r=0 是最南侧采样点。若不做翻转，地形图会南北镜像。
          const i = (rows - 1 - r) * cols + c
          const o = (r * cols + c) * 4
          if (!mask[i]) {
            data[o + 3] = 0
            continue
          }
          const e = elevations[i]
          switch (layer) {
            case 'elevation':
              setPx(o, elevationColor(e, elevation.min, elevation.max), 230)
              break
            case 'hypsometric':
              setPx(o, hy(e), 235)
              break
            case 'relief':
              // 分层设色 × 山体阴影：色相带高程（读地势分带），明暗带坡形（读沟谷走向）
              setPx(o, applyRelief(hy(e), reliefFactor(hillshade[i])), 240)
              break
            case 'hillshade': {
              const v = hillshade[i]
              setPx(o, [v, v, v], 220)
              break
            }
            case 'slope':
              setPx(o, slopeColor(slopeGrid[i]), 220)
              break
            case 'aspect':
              setPx(o, aspectColor(aspectGrid[i]), 230)
              break
            case 'streams': {
              if (missStreams) {
                data[o + 3] = 0
                break
              }
              const isStream = result.streamMask[i] === 1
              // 河网是细线，底下垫一层很淡的分层设色提供地势参照，
              // 否则在卫星影像上一条蓝线看不出它在哪条谷里
              setPx(
                o,
                isStream
                  ? streamColor(
                      result.flowAccGrid[i],
                      result.hydrology?.thresholdKm2 ?? 0.1,
                      result.hydrology?.maxAccKm2 ?? 1,
                    )
                  : hy(e),
                isStream ? 250 : 70,
              )
              break
            }
            case 'twi':
              setPx(o, missTwi ? null : twiColor(result.twiGrid[i]), 232)
              break
            case 'curvature':
              setPx(o, missCurv ? null : curvatureColor(result.curvGrid[i]), 228)
              break
            default:
              // 等高线：本身是细线，直接压在高德底图上会被路网与注记吃掉。
              // 垫一层低透明度分层设色，既提供高程背景，也给等高线一个对比基面。
              setPx(o, hy(e), 120)
          }
        }
      }
      ctx.putImageData(imgData, 0, 0)
      const dataUrl = canvas.toDataURL('image/png')

      // 地形栅格插到选区轮廓/标记/剖面线/圈选预览之下，保证它们始终可见。
      // viewshed-img 也排在前面：视域是「叠加在地形之上的结论」，不能被地形盖住。
      const beforeId = firstExisting(map, [
        'viewshed-img',
        'area-line',
        'marker-hi',
        'marker-lo',
        'prof-line',
        'prof-pts',
        'temp-fill',
        'temp-line',
        'temp-pts',
      ])

      // 图像源四角按显示 CRS 变换，确保与当前底图对齐（高德为 GCJ-02）
      const [nwLng, nwLat] = toDisplay(minLon, maxLat)
      const [neLng, neLat] = toDisplay(maxLon, maxLat)
      const [seLng, seLat] = toDisplay(maxLon, minLat)
      const [swLng, swLat] = toDisplay(minLon, minLat)

      map.addSource('terrain-img', {
        type: 'image',
        url: dataUrl,
        coordinates: [
          [nwLng, nwLat],
          [neLng, neLat],
          [seLng, seLat],
          [swLng, swLat],
        ],
      })
      map.addLayer(
        {
          id: 'terrain-img',
          type: 'raster',
          source: 'terrain-img',
          paint: { 'raster-fade-duration': 0 },
        },
        beforeId,
      )

      if (layer === 'contour') {
        const interval = pickContourInterval(elevation.range)
        const fc = generateContours(grid, interval)
        const transformed = transformFeatureCollection(fc, toDisplay)
        map.addSource('contour-src', {
          type: 'geojson',
          data: transformed as GeoJSON.FeatureCollection,
        })
        // 双层渲染：先铺一层白色「描边」，再压深色主线。
        // 单层 0.8px 细线在高德卫星影像或彩色路网上会被底色吃掉，
        // 加深浅两层后无论底图明暗都有对比度 —— 地形图的标准做法。
        map.addLayer(
          {
            id: 'contour-casing',
            type: 'line',
            source: 'contour-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#ffffff',
              'line-opacity': ['case', ['get', 'isIndex'], 0.9, 0.6],
              'line-width': ['case', ['get', 'isIndex'], 3.6, 2.6],
            },
          },
          beforeId,
        )
        map.addLayer(
          {
            id: 'contour-line',
            type: 'line',
            source: 'contour-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              // 计曲线（每 5 条）更深更粗，扫一眼就能数出高差
              'line-color': ['case', ['get', 'isIndex'], '#7a3d10', '#b0722c'],
              'line-width': ['case', ['get', 'isIndex'], 1.7, 1.05],
              'line-opacity': 0.95,
            },
          },
          beforeId,
        )
      }
    }

    /** 移除选区中心浮标 */
    function removeAreaTag() {
      areaTagMarkerRef.current?.remove()
      areaTagMarkerRef.current = null
      areaTagElRef.current = null
      areaTagBtnRef.current = null
    }

    /**
     * 同步选区中心浮标：文案 + 定位到多边形质心。
     * 拖动选区、切换底图（CRS 变了）、文案变化时都要调用。
     * 浮标本体的 pointer-events 为 none，只有「清除」按钮可点，
     * 这样浮标不会挡住底下的框选与矢量拖动。
     */
    function syncAreaTag() {
      const map = mapRef.current
      const tag = areaTagPropRef.current
      if (!map || !tag || !lastAreaRef.current) {
        removeAreaTag()
        return
      }

      let el = areaTagElRef.current
      if (!el) {
        el = document.createElement('div')
        el.className = 'area-tag-wrap'
        el.innerHTML =
          '<div class="area-tag">' +
          '<span class="area-tag-text"></span>' +
          '<span class="area-tag-warn" hidden>⚠</span>' +
          '<button type="button" class="area-tag-clear" title="清除选区">×</button>' +
          '</div>'
        const btn = el.querySelector('.area-tag-clear') as HTMLButtonElement
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          clearAreaRef.current?.()
        })
        // 按钮上的按下事件不再下传给地图，避免顺手起一个矩形框选
        el.addEventListener('mousedown', (e) => e.stopPropagation())
        el.addEventListener('dblclick', (e) => e.stopPropagation())
        areaTagElRef.current = el
        areaTagBtnRef.current = btn
      }

      const box = el.querySelector('.area-tag') as HTMLDivElement
      const textEl = el.querySelector('.area-tag-text') as HTMLSpanElement
      const warnEl = el.querySelector('.area-tag-warn') as HTMLSpanElement
      textEl.textContent = tag.text
      warnEl.hidden = !tag.warn
      warnEl.title = tag.hint || ''
      box.classList.toggle('warn', !!tag.warn)
      box.classList.toggle('with-clear', !!tag.clearable)
      if (areaTagBtnRef.current) areaTagBtnRef.current.hidden = !tag.clearable

      // 定位到质心：内部数据是 WGS84，Marker 需要当前底图 CRS 的坐标
      const ring = lastAreaRef.current.geometry.coordinates[0]
      const [cLng, cLat] = ringCentroid(ring)
      const [lng, lat] = toDisplay(cLng, cLat)
      if (!areaTagMarkerRef.current) {
        areaTagMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
      }
      areaTagMarkerRef.current.setLngLat([lng, lat]).addTo(map)
    }

    function setAreaOverlay(polygon: Feature<Polygon> | null) {
      const map = mapRef.current
      if (!map) return
      if (map.getLayer('area-fill')) map.removeLayer('area-fill')
      if (map.getLayer('area-line')) map.removeLayer('area-line')
      if (map.getSource('area-src')) map.removeSource('area-src')
      if (!polygon) {
        lastAreaRef.current = null
        syncAreaTag()
        return
      }
      lastAreaRef.current = polygon

      // 选区按显示 CRS 变换，确保与底图对齐
      const ring = polygon.geometry.coordinates[0].map(([lng, lat]) => {
        const [dlng, dlat] = toDisplay(lng, lat)
        return [dlng, dlat]
      })
      const displayPoly: Feature<Polygon> = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: polygon.properties,
      }
      map.addSource('area-src', {
        type: 'geojson',
        data: displayPoly as unknown as GeoJSON.Feature,
      })
      map.addLayer({
        id: 'area-fill',
        type: 'fill',
        source: 'area-src',
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.18 },
      })
      map.addLayer({
        id: 'area-line',
        type: 'line',
        source: 'area-src',
        paint: { 'line-color': '#2563eb', 'line-width': 2.5 },
      })

      syncAreaTag()
    }

    function setExtremeMarkers(
      highest: { lon: number; lat: number; elev: number } | null,
      lowest: { lon: number; lat: number; elev: number } | null,
    ) {
      const map = mapRef.current
      if (!map) return
      // 坐标变了，旧气泡就不是这块地上的信息了
      popupRef.current?.remove()
      const ids = ['marker-hi', 'marker-lo']
      for (const id of ids) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id + '-src')) map.removeSource(id + '-src')
      }
      // 属性里带上 kind / 经纬度：点击弹窗要显示"这是什么点、在哪"，
      // 单靠图层名去猜类型太脆弱
      const add = (
        id: string,
        pt: { lon: number; lat: number; elev: number },
        kind: 'high' | 'low',
      ) => {
        const [lng, lat] = toDisplay(pt.lon, pt.lat)
        map.addSource(id + '-src', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: { elev: pt.elev, kind, lon: pt.lon, lat: pt.lat },
          },
        })
        map.addLayer({
          id,
          type: 'circle',
          source: id + '-src',
          paint: {
            'circle-radius': 7,
            'circle-color': kind === 'high' ? '#dc2626' : '#2563eb',
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 2,
          },
        })
      }
      if (highest) add('marker-hi', highest, 'high')
      if (lowest) add('marker-lo', lowest, 'low')
    }

    /**
     * 视域覆盖：三态掩膜 → RGBA 贴图，叠在地形栅格之上。
     * 可见 = 亮黄绿，被遮挡 = 半透明深灰（两条信息都要给：只说"可见"的话
     * 用户无法区分"看不见"和"没算到"）。
     */
    function renderViewshedOverlay(v: ViewshedResult | null) {
      const map = mapRef.current
      if (!map) return
      for (const id of ['viewshed-img', 'viewshed-obs']) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      const grid = lastResultRef.current?.grid
      if (!v || !grid) return

      const { cols, rows, minLon, minLat, maxLon, maxLat } = grid
      const canvas = document.createElement('canvas')
      canvas.width = cols
      canvas.height = rows
      const ctx = canvas.getContext('2d')!
      const img = ctx.createImageData(cols, rows)
      const d = img.data
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // 与地形栅格同样的南北翻转，否则视域会镜像到选区另一头
          const s = v.mask[(rows - 1 - r) * cols + c]
          if (!s) continue
          const o = (r * cols + c) * 4
          const col = s === 1 ? VIEWSHED_VISIBLE : VIEWSHED_HIDDEN
          d[o] = col[0]
          d[o + 1] = col[1]
          d[o + 2] = col[2]
          d[o + 3] = s === 1 ? 118 : 76
        }
      }
      ctx.putImageData(img, 0, 0)

      const [nwLng, nwLat] = toDisplay(minLon, maxLat)
      const [neLng, neLat] = toDisplay(maxLon, maxLat)
      const [seLng, seLat] = toDisplay(maxLon, minLat)
      const [swLng, swLat] = toDisplay(minLon, minLat)
      const beforeId = firstExisting(map, [
        'area-fill',
        'area-line',
        'marker-hi',
        'marker-lo',
        'prof-line',
        'prof-pts',
        'temp-fill',
        'temp-line',
        'temp-pts',
      ])

      map.addSource('viewshed-img', {
        type: 'image',
        url: canvas.toDataURL('image/png'),
        coordinates: [
          [nwLng, nwLat],
          [neLng, neLat],
          [seLng, seLat],
          [swLng, swLat],
        ],
      })
      map.addLayer(
        {
          id: 'viewshed-img',
          type: 'raster',
          source: 'viewshed-img',
          paint: { 'raster-fade-duration': 0 },
        },
        beforeId,
      )

      const [oLng, oLat] = toDisplay(v.lon, v.lat)
      map.addSource('viewshed-obs', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [oLng, oLat] },
          properties: { elev: v.observerElev },
        },
      })
      map.addLayer({
        id: 'viewshed-obs',
        type: 'circle',
        source: 'viewshed-obs',
        paint: {
          'circle-radius': 6,
          'circle-color': '#f59e0b',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2.5,
        },
      })
    }

    return <div ref={containerRef} className="map-container" />
  },
)

MapView.displayName = 'MapView'

/**
 * 最高点 / 最低点说明气泡。
 * 图上只有两个彩色圆点，不解释一句，用户看到的就是"莫名其妙两个点"。
 * 内容全部来自数值与固定文案，不含用户输入，无需转义。
 */
export function extremePopupHtml(
  kind: string,
  elev: number,
  lon: number,
  lat: number,
): string {
  const isHigh = kind === 'high'
  const title = isHigh ? '最高点' : '最低点'
  const note = isHigh
    ? '选区内采样网格中海拔最高的像元。它与最低点的差值就是结果里的「最大高差」，是判断这块地起伏剧烈程度最直观的指标。'
    : '选区内海拔最低的像元，通常落在河谷、洼地或海岸线上。现实中的排水走向与汇水出口往往与它一致。'
  return (
    '<div class="map-popup">' +
    `<div class="map-popup-title ${isHigh ? 'high' : 'low'}">${title}</div>` +
    `<div class="map-popup-value">${Math.round(elev)}<span>m</span></div>` +
    `<div class="map-popup-coord">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>` +
    `<p class="map-popup-note">${note}</p>` +
    '<div class="map-popup-foot">红点=最高点 · 蓝点=最低点</div>' +
    '</div>'
  )
}

/** 对 GeoJSON 要素集合的每个坐标做显示 CRS 变换（WGS84 -> 当前底图 CRS） */
function transformFeatureCollection(
  fc: GeoJSON.FeatureCollection,
  toDisplay: (lng: number, lat: number) => [number, number],
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => transformFeature(f, toDisplay)),
  }
}

function transformFeature(
  f: GeoJSON.Feature,
  toDisplay: (lng: number, lat: number) => [number, number],
): GeoJSON.Feature {
  const g = f.geometry
  if (!g) return f
  if (g.type === 'LineString') {
    return {
      ...f,
      geometry: {
        ...g,
        coordinates: (g.coordinates as Position[]).map(([lng, lat]) => toDisplay(lng, lat)),
      },
    }
  }
  if (g.type === 'Polygon') {
    return {
      ...f,
      geometry: {
        ...g,
        coordinates: (g.coordinates as Position[][]).map((ring) =>
          ring.map(([lng, lat]) => toDisplay(lng, lat)),
        ),
      },
    }
  }
  return f
}

/** 计算一组坐标的经纬度包围盒 */
function bboxOfRing(ring: Position[]): number[] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

function pickContourInterval(range: number): number {
  if (range > 2000) return 200
  if (range > 1000) return 100
  if (range > 400) return 50
  if (range > 100) return 20
  return 10
}

// 供其他模块复用
export { geodesicArea }

const BASEMAP_LAYER_IDS = [
  'osm',
  'amap-vec',
  'amap-sat',
  'amap-sat-label',
  'dem-bg',
  'dem-hillshade',
]
const BASEMAP_SOURCE_IDS = ['osm', 'amap-vec', 'amap-sat', 'amap-sat-label', 'dem']

/** 切换底图：移除旧底图源/图层，添加新底图，并保持分析图层在最上层 */
function applyBasemap(map: maplibregl.Map, id: string, showLabels = false) {
  // 移除旧底图
  for (const lid of BASEMAP_LAYER_IDS) {
    if (map.getLayer(lid)) map.removeLayer(lid)
  }
  for (const sid of BASEMAP_SOURCE_IDS) {
    if (map.getSource(sid)) map.removeSource(sid)
  }

  // 找到第一个分析图层，底图插入到它之前（temp-* 是圈选预览，必须始终在底图之上）
  const analysisIds = [
    'terrain-img',
    'contour-casing',
    'contour-line',
    'viewshed-img',
    'viewshed-obs',
    'area-fill',
    'area-line',
    'marker-hi',
    'marker-lo',
    'prof-line',
    'prof-pts',
    'temp-fill',
    'temp-line',
    'temp-pts',
  ]
  let beforeId: string | undefined
  for (const aid of analysisIds) {
    if (map.getLayer(aid)) {
      beforeId = aid
      break
    }
  }

  if (id === 'dem') {
    map.addSource('dem', {
      type: 'raster-dem',
      tiles: DEM_TILES,
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
    })
    map.addLayer({ id: 'dem-bg', type: 'background', paint: DEM_BACKGROUND_PAINT }, beforeId)
    map.addLayer(
      {
        id: 'dem-hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: DEM_HILLSHADE_PAINT,
      },
      beforeId,
    )
  } else if (id === 'osm') {
    map.addSource('osm', {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
    })
    map.addLayer({ id: 'osm', type: 'raster', source: 'osm' }, beforeId)
  } else if (id === 'amap-vec') {
    map.addSource('amap-vec', {
      type: 'raster',
      tiles: amapVecTiles(showLabels),
      tileSize: 256,
    })
    map.addLayer({ id: 'amap-vec', type: 'raster', source: 'amap-vec' }, beforeId)
  } else if (id === 'amap-sat') {
    map.addSource('amap-sat', {
      type: 'raster',
      tiles: amapSatTiles('6'),
      tileSize: 256,
    })
    map.addLayer({ id: 'amap-sat', type: 'raster', source: 'amap-sat' }, beforeId)
    if (showLabels) {
      map.addSource('amap-sat-label', {
        type: 'raster',
        tiles: amapSatTiles('8', true),
        tileSize: 256,
      })
      map.addLayer({ id: 'amap-sat-label', type: 'raster', source: 'amap-sat-label' }, beforeId)
    }
  }
}
