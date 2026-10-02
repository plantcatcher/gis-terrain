import { useCallback, useEffect, useRef, useState } from 'react'
import type { Feature, Polygon } from 'geojson'
import {
  MapView,
  BASEMAPS,
  defaultBasemap,
  type MapViewHandle,
} from './components/MapView'
import { AreaSelector, type AreaSelectorHandle } from './components/AreaSelector'
import { SearchBox } from './components/SearchBox'
import { AnalysisProgress } from './components/AnalysisProgress'
import { ResultsPanel } from './components/ResultsPanel'
import { runAnalysis } from './services/analysisService'
import type {
  SelectedArea,
  SelectionMode,
  TerrainAnalysisResult,
  TerrainLayer,
  ProgressMessage,
  BasemapOption,
  HistoryItem,
} from './types'
import { MAX_AREA_KM2 } from './utils/validation'
import { fmtArea } from './utils/format'
import { geodesicArea } from './utils/geo'
import { isGcjBasemap } from './utils/crs'
import { useIsMobile, useIsTouch } from './utils/device'
import { loadProjects, saveProjects, MAX_PROJECTS } from './utils/storage'
import { SITE_OWNER } from './config'

type Phase = 'selecting' | 'analyzing' | 'results'

/** 地图工具：手势=拖动地图；选择=圈选 / 点选并拖动矢量 */
type MapTool = 'hand' | 'select'

export default function App() {
  const mapRef = useRef<MapViewHandle>(null)
  const selectorRef = useRef<AreaSelectorHandle>(null)
  const headerRef = useRef<HTMLElement>(null)
  // 窄屏走移动端布局；粗指针（真触屏）决定是否禁用「双击」这类鼠标专属交互
  const isMobile = useIsMobile()
  const isTouch = useIsTouch()
  const [phase, setPhase] = useState<Phase>('selecting')
  const [mode, setMode] = useState<SelectionMode>('rectangle')
  const [tool, setTool] = useState<MapTool>('select')
  const [selectedArea, setSelectedArea] = useState<SelectedArea | null>(null)
  const [result, setResult] = useState<TerrainAnalysisResult | null>(null)
  // 默认等高线：它最能读出地形结构与相对高差，也是面板里的第一项
  const [activeLayer, setActiveLayer] = useState<TerrainLayer>('contour')
  const [progress, setProgress] = useState<ProgressMessage>({
    step: 'fetching',
    message: '',
    percent: 0,
  })
  const [error, setError] = useState<string | null>(null)
  // 默认底图：高德卫星（判读地形时影像的信息量比矢量图大得多）
  const [basemap, setBasemap] = useState<BasemapOption>(defaultBasemap)
  // 高德底图的路网与文字注记：默认**打开** —— 有地名和路网，用户才认得出自己在哪
  const [basemapLabels, setBasemapLabels] = useState(true)
  const [mapReady, setMapReady] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)
  // 项目重命名：正在编辑的项 id + 草稿名（null = 不在编辑态）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  /** 防止 Enter/Esc 结束编辑后，残留的 blur 又把草稿提交一次 */
  const renameDoneRef = useRef(false)
  // 两侧面板都是浮在地图上的窗口，可以各自收起腾出地图空间。
  // 移动端初始收起左侧面板：一进来整屏被面板盖住会让地图没法看。
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [resultsOpen, setResultsOpen] = useState(true)
  /** 多边形绘制中的顶点数（驱动「完成 / 撤销」按钮） */
  const [polyPoints, setPolyPoints] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  /** 项目是否已从 IndexedDB 水合完成（未完成前禁止回写，否则空数组会抹掉已存数据） */
  const hydratedRef = useRef(false)

  // 顶栏浮在地图上，其余浮层（工具栏 / 侧栏 / 结果面板 / 提示条）都要让开它的高度。
  // 用实测值同步到 CSS 变量，而不是写死常量 —— 窗口变窄时顶栏会换行、行高也随
  // 系统字体设置变化，任何写死的数字都会在某个尺寸下露馅。
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const sync = () =>
      document.documentElement.style.setProperty(
        '--header-h',
        `${el.getBoundingClientRect().height}px`,
      )
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ---------------- 项目持久化 ---------------- */

  // 挂载时恢复；cancelled 兜住 StrictMode 的双调用
  useEffect(() => {
    let cancelled = false
    void loadProjects().then((items) => {
      if (cancelled) return
      // 只在还没有项目时填充：万一同一次挂载里已经分析出结果，别把它顶掉
      setHistory((prev) => (prev.length > 0 ? prev : items))
      hydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 变化时防抖写回。拖动选区会让 feature 连续变化，400ms 足以合并成一次写。
  useEffect(() => {
    if (!hydratedRef.current) return
    const t = window.setTimeout(() => void saveProjects(history), 400)
    return () => window.clearTimeout(t)
  }, [history])

  // 出结果 / 切换历史时自动展开结果浮窗（用户可能此前手动收起过）
  useEffect(() => {
    if (result) setResultsOpen(true)
  }, [result])

  // 窄屏：左侧面板是盖在地图上的抽屉。出结果、切项目、或从宽屏切到窄屏时
  // 自动收起，否则「抽屉 + 遮罩」会把底部的结果 sheet 整个压在下面。
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile, result])

  // 当选中区域变化时，更新地图叠加层
  useEffect(() => {
    if (selectedArea) {
      mapRef.current?.setAreaOverlay(selectedArea.feature)
    } else {
      mapRef.current?.setAreaOverlay(null)
    }
  }, [selectedArea])

  // 选区拖动开关：仅在圈选阶段、鼠标工具、且已有选区时允许
  useEffect(() => {
    mapRef.current?.setAreaDraggable(
      phase === 'selecting' && tool === 'select' && !!selectedArea,
    )
  }, [phase, selectedArea, tool])

  // 工具模式决定地图能否拖动平移：
  // 手势工具 -> 解锁平移；鼠标工具 -> 锁定平移（避免与框选/拖动矢量冲突）
  useEffect(() => {
    if (!mapReady) return
    mapRef.current?.setPanLocked(phase === 'selecting' && tool === 'select')
  }, [tool, phase, mapReady])

  // 工具模式决定默认光标
  useEffect(() => {
    if (!mapReady) return
    const cursor =
      phase === 'selecting' ? (tool === 'hand' ? 'grab' : 'crosshair') : ''
    mapRef.current?.setCursor(cursor)
  }, [tool, phase, mapReady])

  // 分析结果 + 图层变化时渲染地形
  useEffect(() => {
    if (result) {
      mapRef.current?.renderTerrain(result, activeLayer)
    }
  }, [result, activeLayer])

  // 结果出来后设置最高/最低点标记
  useEffect(() => {
    if (result) {
      mapRef.current?.setExtremeMarkers(
        { lon: result.highest.lon, lat: result.highest.lat, elev: result.highest.elevation },
        { lon: result.lowest.lon, lat: result.lowest.lat, elev: result.lowest.elevation },
      )
    }
  }, [result])

  const handleSelected = useCallback((area: SelectedArea) => {
    setSelectedArea(area)
    setError(null)
  }, [])

  const handleAnalyze = useCallback(async () => {
    if (!selectedArea) return
    setPhase('analyzing')
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await runAnalysis(selectedArea.feature, {
        areaKm2: selectedArea.areaKm2,
        onProgress: (p) => setProgress(p),
        signal: controller.signal,
      })
      // 用户可能在计算中途取消：丢弃结果，回到圈选
      if (controller.signal.aborted) {
        setPhase('selecting')
        return
      }
      // 保存到历史记录（避免重复）
      const item: HistoryItem = {
        id: `h_${Date.now()}`,
        name: `区域分析 · ${new Date().toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
        feature: selectedArea.feature,
        areaKm2: selectedArea.areaKm2,
        result: res,
        timestamp: Date.now(),
      }
      // 超出上限时淘汰最旧的：每个项目都带着几 MB 的网格，不能无限攒
      setHistory((prev) =>
        [item, ...prev.filter((h) => h.id !== item.id)].slice(0, MAX_PROJECTS),
      )
      setActiveHistoryId(item.id)
      setResult(res)
      setPhase('results')
      // 新结果与旧视域无关
      mapRef.current?.setViewshed(null)
      mapRef.current?.fitToPolygon(selectedArea.feature)
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setPhase('selecting')
        return
      }
      setError(e?.message || '分析失败，请重试')
      setPhase('selecting')
    }
  }, [selectedArea])

  const handleBack = useCallback(() => {
    abortRef.current?.abort()
    setResult(null)
    setSelectedArea(null)
    setActiveHistoryId(null)
    setPhase('selecting')
    mapRef.current?.clearTerrainLayers()
    mapRef.current?.setExtremeMarkers(null, null)
    // 视域是随结果而来的临时叠加层，退回圈选时必须一起清掉，
    // 否则换一块地分析时旧视域还挂在图上，看着像新结果的一部分
    mapRef.current?.setViewshed(null)
  }, [])

  // 新建分析：保留历史，清空当前结果回到圈选
  const handleNewAnalysis = useCallback(() => {
    abortRef.current?.abort()
    const map = mapRef.current
    map?.clearTerrainLayers()
    map?.setExtremeMarkers(null, null)
    map?.setViewshed(null)
    map?.setAreaOverlay(null)
    setResult(null)
    setSelectedArea(null)
    setActiveHistoryId(null)
    setError(null)
    setPhase('selecting')
  }, [])

  const handleClear = useCallback(() => {
    setSelectedArea(null)
    setError(null)
  }, [])

  const handleSelectHistory = useCallback((item: HistoryItem) => {
    setActiveHistoryId(item.id)
    setSelectedArea({ mode: 'rectangle', feature: item.feature, areaKm2: item.areaKm2 })
    setResult(item.result)
    // 打开历史项目统一回到默认图层（等高线），避免沿用上一个项目的图层
    setActiveLayer('contour')
    setPhase('results')
    // 换项目：上一个项目的视域与新项目无关，先清掉
    mapRef.current?.setViewshed(null)
    mapRef.current?.fitToPolygon(item.feature)
  }, [])

  const handleDeleteHistory = useCallback((id: string) => {
    setHistory((prev) => prev.filter((h) => h.id !== id))
    if (activeHistoryId === id) setActiveHistoryId(null)
    if (editingId === id) setEditingId(null)
  }, [activeHistoryId, editingId])

  /* ---------------- 项目重命名 ---------------- */

  const startRename = useCallback((item: HistoryItem) => {
    renameDoneRef.current = false
    setEditingId(item.id)
    setDraftName(item.name)
  }, [])

  const cancelRename = useCallback(() => {
    setEditingId(null)
    setDraftName('')
  }, [])

  /** 提交重命名；空名视为放弃（保留原名），避免出现无名项目 */
  const commitRename = useCallback(
    (id: string) => {
      const name = draftName.trim()
      if (name) {
        setHistory((prev) =>
          prev.map((h) => (h.id === id ? { ...h, name } : h)),
        )
      }
      setEditingId(null)
      setDraftName('')
    },
    [draftName],
  )

  // 拖动选区后更新选区分辨率数据，并同步到历史记录
  const handleAreaMoved = useCallback((feature: Feature<Polygon>) => {
    const areaKm2 = geodesicArea(feature) / 1_000_000
    setSelectedArea((prev) =>
      prev ? { ...prev, feature, areaKm2 } : { mode: 'rectangle', feature, areaKm2 },
    )
    if (activeHistoryId) {
      setHistory((prev) =>
        prev.map((h) =>
          h.id === activeHistoryId ? { ...h, feature, areaKm2 } : h,
        ),
      )
    }
  }, [activeHistoryId])

  const isGcj = isGcjBasemap(basemap.id)
  /** 当前项目（用于导出文件名与 PDF 标题）：可能被用户重命名过 */
  const activeProject = history.find((h) => h.id === activeHistoryId)

  return (
    <div className={`app ${phase === 'results' ? 'has-results' : ''}`}>
      {/* 顶部栏 */}
      <header className="app-header" ref={headerRef}>
        <div className="brand">
          <span className="brand-icon">⛰</span>
          <div>
            <h1>地形分析器</h1>
            <p>圈选区域，自动分析地形特征</p>
          </div>
        </div>

        <div className="stepper" aria-label="操作步骤">
          <Step
            n={1}
            label="圈选区域"
            state={phase === 'selecting' ? 'active' : 'done'}
          />
          <span className="stepper-line" />
          <Step
            n={2}
            label="自动分析"
            state={phase === 'analyzing' ? 'active' : phase === 'results' ? 'done' : 'todo'}
          />
          <span className="stepper-line" />
          <Step
            n={3}
            label="查看结果"
            state={phase === 'results' ? 'active' : 'todo'}
          />
        </div>
        <div className="header-tools">
          <SearchBox mapRef={mapRef} isGcj={isGcjBasemap(basemap.id)} />
          {/* 窄屏下左侧面板是抽屉，需要一个明确的开关（桌面上贴边标签更好用） */}
          <button
            className="header-panel-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="项目面板"
            aria-expanded={sidebarOpen}
          >
            ☰ 项目
          </button>
        </div>
      </header>

      <div
        className={`app-main ${sidebarOpen ? 'with-sidebar' : ''}${
          phase === 'results' && result && resultsOpen ? ' with-results' : ''
        }`}
      >
        {/* 窄屏：抽屉展开时压一层遮罩，点空白处收起。桌面端 CSS 里隐藏 */}
        {sidebarOpen && !(phase === 'results' && result) && (
          <div
            className="scrim"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* 左侧浮窗：新建分析 / 底图 / 项目列表 */}
        <aside className={`sidebar ${sidebarOpen ? '' : 'is-collapsed'}`}>
          <div className="float-head">
            <span className="float-title">项目面板</span>
            <button
              className="float-collapse"
              onClick={() => setSidebarOpen(false)}
              title="收起面板，腾出地图空间"
            >
              ‹
            </button>
          </div>

          <div className="sidebar-scroll">
            <button className="new-analysis-btn" onClick={handleNewAnalysis}>
              ＋ 新建分析
            </button>

            <div className="sidebar-section">
              <div className="sidebar-title">底图</div>
              <div className="basemap-list">
                {BASEMAPS.map((b) => (
                  <button
                    key={b.id}
                    className={`basemap-btn ${basemap.id === b.id ? 'active' : ''}`}
                    onClick={() => setBasemap(b)}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
              <label className={`layer-switch ${isGcj ? '' : 'is-disabled'}`}>
                <input
                  type="checkbox"
                  checked={basemapLabels}
                  disabled={!isGcj}
                  onChange={(e) => setBasemapLabels(e.target.checked)}
                />
                <span>路网与标注</span>
                <em>{isGcj ? (basemapLabels ? '显示' : '已隐藏') : '仅高德底图'}</em>
              </label>
              {basemap.id === 'dem' && (
                <div className="basemap-hint">
                  DEM 底图由全球高程瓦片实时生成山体阴影，无地名注记；它与分析所用的坐标系一致，
                  不会出现高德底图那几百米的偏移。
                </div>
              )}
            </div>

            <div className="sidebar-section history-section">
              <div className="sidebar-title">项目（{history.length}）</div>
              {history.length === 0 ? (
                <div className="history-empty">
                  还没有项目。圈选一块区域并分析后会自动建为项目，双击名字即可重命名。
                  项目保存在本机浏览器里，刷新或关掉页面都不会丢。
                </div>
              ) : (
                <ul className="history-list">
                  {history.map((h) => {
                    const editing = editingId === h.id
                    const meta = `${fmtArea(h.areaKm2)} · 平均海拔 ${Math.round(
                      h.result.elevation.mean,
                    )}m`
                    return (
                      <li
                        key={h.id}
                        className={`history-item ${activeHistoryId === h.id ? 'active' : ''}`}
                      >
                        {editing ? (
                          <div className="history-main is-editing">
                            <input
                              className="history-name-input"
                              value={draftName}
                              autoFocus
                              maxLength={40}
                              onChange={(e) => setDraftName(e.target.value)}
                              onFocus={(e) => e.currentTarget.select()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  renameDoneRef.current = true
                                  commitRename(h.id)
                                } else if (e.key === 'Escape') {
                                  renameDoneRef.current = true
                                  cancelRename()
                                }
                              }}
                              onBlur={() => {
                                if (renameDoneRef.current) return
                                commitRename(h.id)
                              }}
                            />
                            <span className="history-meta">{meta}</span>
                          </div>
                        ) : (
                          <button
                            className="history-main"
                            title="单击打开 · 双击重命名"
                            onClick={() => handleSelectHistory(h)}
                            onDoubleClick={() => startRename(h)}
                          >
                            <span className="history-name">{h.name}</span>
                            <span className="history-meta">{meta}</span>
                          </button>
                        )}
                        {!editing && (
                          <button
                            className="history-rename"
                            title="重命名"
                            onClick={() => startRename(h)}
                          >
                            ✎
                          </button>
                        )}
                        <button
                          className="history-del"
                          title="删除"
                          onClick={() => handleDeleteHistory(h.id)}
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* 版权署名：放在项目面板最底部 —— 它跟着面板一起收起/展开，
              既不占地图空间，也不会像页脚一样在小屏上被挤掉 */}
          <div className="sidebar-foot">
            <b>© {SITE_OWNER}</b>
            <span>地形分析器 · 数据全部在本地浏览器计算</span>
          </div>
        </aside>

        {!sidebarOpen && (
          <button
            className="float-tab left"
            onClick={() => setSidebarOpen(true)}
            title="展开项目面板"
          >
            ›
          </button>
        )}

        {/* 主体（地图铺满，两侧面板浮在其上） */}
        <div className="app-body">
          <div className="map-wrap">
            <MapView
              ref={mapRef}
              basemap={basemap}
              basemapLabels={basemapLabels}
              onMapReady={() => setMapReady(true)}
              onAreaMoved={handleAreaMoved}
              areaTag={
                selectedArea
                  ? {
                      text: fmtArea(selectedArea.areaKm2),
                      warn: selectedArea.areaKm2 > MAX_AREA_KM2 * 0.8,
                      hint: `已接近面积上限 ${MAX_AREA_KM2} km²，建议缩小范围`,
                      // 结果阶段不给「清除」，避免清掉选区却留着结果图层
                      clearable: phase === 'selecting',
                    }
                  : null
              }
              onClearArea={handleClear}
            />

            {/* 工具栏 */}
            {phase !== 'results' && (
              <div className="toolbar">
                <div className="toolbar-row">
                  {/* 工具模式：手势拖动地图 / 选择圈选与拖动矢量 */}
                  <div className="tool-group" role="group" aria-label="地图工具">
                    <button
                      className={`tool-btn ${tool === 'hand' ? 'active' : ''}`}
                      onClick={() => setTool('hand')}
                      title="手势：拖动平移地图、双指缩放"
                      aria-pressed={tool === 'hand'}
                    >
                      <HandIcon />
                      手势
                    </button>
                    <button
                      className={`tool-btn ${tool === 'select' ? 'active' : ''}`}
                      onClick={() => setTool('select')}
                      title="选择：圈选区域、点选并拖动选区"
                      aria-pressed={tool === 'select'}
                    >
                      <CursorIcon />
                      选择
                    </button>
                  </div>

                  <span className="toolbar-divider" />

                  <div className={`mode-group ${tool === 'hand' ? 'muted' : ''}`}>
                    <button
                      className={`mode-btn ${mode === 'rectangle' ? 'active' : ''}`}
                      onClick={() => {
                        setMode('rectangle')
                        setTool('select')
                      }}
                      title="拖动框选矩形区域"
                    >
                      ▭ 矩形<span className="only-wide">选择</span>
                    </button>
                    <button
                      className={`mode-btn ${mode === 'polygon' ? 'active' : ''}`}
                      onClick={() => {
                        setMode('polygon')
                        setTool('select')
                      }}
                      title="逐点绘制多边形区域"
                    >
                      ◇ 多边形<span className="only-wide">选择</span>
                    </button>
                  </div>
                </div>

                <div className="toolbar-row">
                  {/* 多边形绘制中：触屏没有可靠的双击，闭合交给按钮 */}
                  {mode === 'polygon' && tool === 'select' && polyPoints > 0 && (
                    <div className="poly-actions">
                      <span className="poly-count">
                        已选 <b>{polyPoints}</b> 点
                      </span>
                      <button
                        className="btn-secondary"
                        onClick={() => selectorRef.current?.undoPoint()}
                        title="撤销上一个顶点"
                      >
                        撤销
                      </button>
                      <button
                        className="btn-primary"
                        disabled={polyPoints < 3}
                        onClick={() => selectorRef.current?.finishPolygon()}
                        title={
                          polyPoints < 3
                            ? '至少需要 3 个点'
                            : '闭合多边形并设为分析区域'
                        }
                      >
                        完成
                      </button>
                    </div>
                  )}
                  {/* 多边形画到一半时，主操作是「完成」而不是「分析」；
                      同时显示会让工具栏涨到三行，窄屏上占地太多 */}
                  {!(mode === 'polygon' && tool === 'select' && polyPoints > 0) && (
                    <button
                      className="btn-analyze"
                      disabled={!selectedArea}
                      onClick={handleAnalyze}
                    >
                      开始分析 →
                    </button>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="error-banner">
                <span>⚠️ {error}</span>
                {selectedArea && (
                  <button className="error-retry" onClick={handleAnalyze}>
                    重试
                  </button>
                )}
                <button onClick={() => setError(null)}>×</button>
              </div>
            )}

            {/* 选择提示 */}
            {phase === 'selecting' && !selectedArea && (
              <div className="hint-banner">
                {tool === 'hand'
                  ? isTouch
                    ? '手势模式：单指拖动平移，双指缩放。切到「选择」即可圈选'
                    : '手势模式：按住拖动平移地图，滚轮缩放。切到「选择」即可圈选区域'
                  : mode === 'rectangle'
                    ? isTouch
                      ? '单指拖动框选矩形区域（双指可缩放平移）'
                      : '按住鼠标拖动框选出矩形区域'
                    : isTouch
                      ? '轻点地图添加顶点，点上方「完成」闭合多边形'
                      : '在地图上点击添加顶点，双击完成多边形'}
              </div>
            )}
            {phase === 'selecting' && selectedArea && tool === 'hand' && (
              <div className="hint-banner">
                已选中区域。切到「选择」工具可拖动矢量调整位置
              </div>
            )}
          </div>

          {/* 结果浮窗 */}
          {phase === 'results' && result && (
            <ResultsPanel
              result={result}
              mapRef={mapRef}
              activeLayer={activeLayer}
              onLayerChange={setActiveLayer}
              onBack={handleBack}
              mapReady={mapReady}
              isGcj={isGcj}
              projectName={activeProject?.name}
              collapsed={!resultsOpen}
              onToggleCollapse={() => setResultsOpen((v) => !v)}
            />
          )}
        </div>
        {phase === 'results' && result && !resultsOpen && (
          <button
            className="float-tab right"
            onClick={() => setResultsOpen(true)}
            title="展开分析结果"
          >
            ‹
          </button>
        )}
      </div>

      {/* 分析中遮罩 */}
      {phase === 'analyzing' && (
        <AnalysisProgress progress={progress} onCancel={() => abortRef.current?.abort()} />
      )}

      <AreaSelector
        ref={selectorRef}
        mapRef={mapRef}
        mode={mode}
        onSelected={handleSelected}
        onError={(m) => setError(m)}
        disabled={phase !== 'selecting' || tool === 'hand'}
        mapReady={mapReady}
        isGcj={isGcj}
        onPointsChange={setPolyPoints}
      />
    </div>
  )
}

type StepState = 'todo' | 'active' | 'done'

function Step({ n, label, state }: { n: number; label: string; state: StepState }) {
  return (
    <div className={`step step-${state}`}>
      <span className="step-dot">{state === 'done' ? '✓' : n}</span>
      <span className="step-label">{label}</span>
    </div>
  )
}

/** 手势图标（拖动平移地图） */
function HandIcon() {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

/** 指针图标（圈选 / 拖动矢量） */
function CursorIcon() {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 3.2a.6.6 0 0 0-.75.75l5.5 13.6a.6.6 0 0 0 1.13-.08l1.4-5.36a1.6 1.6 0 0 1 1.16-1.16l5.36-1.4a.6.6 0 0 0 .08-1.13z" />
    </svg>
  )
}
