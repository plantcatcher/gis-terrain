import { useMemo, useRef, useState } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import type { MapViewHandle } from './MapView'
import type {
  TerrainAnalysisResult,
  TerrainDescription,
  ProfileResult,
  Position,
  TerrainLayer,
  ViewshedResult,
} from '../types'
import { StatCard } from './StatCard'
import { SlopeChart } from './SlopeChart'
import { ElevationHistogram } from './ElevationHistogram'
import { AspectChart } from './AspectChart'
import { ProfileChart } from './ProfileChart'
import { ProfileLineTool, type ProfileLineHandle } from './ProfileLineTool'
import { ViewshedTool } from './ViewshedTool'
import { computeProfile, makeGridElevationFn } from '../services/terrain/profile'
import { computeViewshed } from '../services/terrain/viewshed'
import { describeTerrain } from '../services/terrain/description'
import { exportReportPDF, downloadPng } from '../services/export/report'
import {
  fmtInt,
  fmtNumber,
  fmtArea,
  fmtSlope,
  fmtDist,
  exportStamp,
  safeFileName,
} from '../utils/format'
import { SITE_OWNER } from '../config'

interface ResultsPanelProps {
  result: TerrainAnalysisResult
  mapRef: React.RefObject<MapViewHandle>
  activeLayer: TerrainLayer
  onLayerChange: (l: TerrainLayer) => void
  onBack: () => void
  mapReady?: boolean
  isGcj?: boolean
  /** 当前项目名（导出文件名与 PDF 标题都用它，可能是用户重命名过的） */
  projectName?: string
  /** 浮窗是否收起（收起后只留贴边的展开标签） */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

/**
 * 图层分两组：基础地形是"看地势"，派生分析是"读数算出来的结论"。
 * 十个按钮平铺一排会让人不知道该先点哪个，所以分组 + 各自一个下拉。
 *
 * 组内顺序即推荐顺序：等高线最能读出地形结构与高差，放第一个，
 * 也是新分析的默认图层。
 */
const LAYER_GROUPS: { title: string; items: { id: TerrainLayer; label: string; title: string }[] }[] = [
  {
    title: '地形图层',
    items: [
      { id: 'contour', label: '等高线', title: '计曲线加粗，自带分层设色垫底' },
      { id: 'elevation', label: '高程', title: '连续色带，反映绝对高度' },
      { id: 'hypsometric', label: '分层设色', title: '分级色带，地形图通用配色' },
      { id: 'relief', label: '晕渲', title: '分层设色叠加山体阴影，立体感最强' },
      { id: 'hillshade', label: '山体阴影', title: '纯灰度，只看坡形不看高度' },
      { id: 'slope', label: '坡度', title: '按陡缓程度分级' },
      { id: 'aspect', label: '坡向', title: '坡面朝向（北红 / 南青）' },
    ],
  },
  {
    title: '派生分析',
    items: [
      { id: 'streams', label: '河网水系', title: 'D8 汇流累积超阈值的河道，按汇水量分级' },
      { id: 'twi', label: '湿度指数', title: 'TWI：哪里容易积水、哪里是干坡' },
      { id: 'curvature', label: '曲率', title: '平面曲率：正=凸（发散） 负=凹（汇聚）' },
    ],
  },
]

/** 图层中文名（正文顶部那行提示用） */
const LAYER_LABELS: Record<TerrainLayer, string> = {
  elevation: '高程',
  hypsometric: '分层设色',
  relief: '晕渲',
  hillshade: '山体阴影',
  slope: '坡度',
  aspect: '坡向',
  contour: '等高线',
  streams: '河网水系',
  twi: '湿度指数',
  curvature: '曲率',
}

/** 每个图层一份简短说明：切过去之后正文顶部会显示，省得用户不知道在看什么 */
const LAYER_HINTS: Record<TerrainLayer, string> = {
  elevation: '按海拔连续上色，适合看绝对高度与整体高差。',
  hypsometric: '按区域内高差分成 14 级色带，地形图通用配色，色阶边界即等高程线。',
  relief: '分层设色叠山体阴影：色相看高程，明暗看坡形，判读沟谷走向最有效。',
  hillshade: '纯灰度光照模拟，只看坡形不看高度，适合找山脊线与沟谷。',
  slope: '按 0–5°/5–15°/15–25°/25–35°/>35° 五级上色，陡缓一目了然。',
  aspect: '坡面朝向，北红南青；主导坡向直接影响日照、积雪与建设朝向。',
  contour: '计曲线每 5 条加粗一次，可数出相对高差；底色为低透明度分层设色。',
  streams: '把汇流累积超过阈值的像元连成河道，越粗越深代表汇水量越大。',
  twi: '地形湿度指数：越高越容易汇水（谷底、洼地），越低越干（脊部、凸坡）。',
  curvature: '平面曲率：暖色=凸（水流发散，山脊坡肩），冷色=凹（水流汇聚，谷底坡脚）。',
}

const LANDFORM_ITEMS: { key: keyof TerrainAnalysisResult['landform']; label: string; color: string }[] = [
  { key: 'ridge', label: '山脊 / 山脊线', color: '#dc2626' },
  { key: 'upperSlope', label: '上坡', color: '#f97316' },
  { key: 'middleSlope', label: '中坡（山坡主体）', color: '#eab308' },
  { key: 'lowerSlope', label: '下坡', color: '#65a30d' },
  { key: 'valley', label: '山谷 / 洼地', color: '#2563eb' },
  { key: 'flat', label: '平地', color: '#94a3b8' },
]

export function ResultsPanel({
  result,
  mapRef,
  activeLayer,
  onLayerChange,
  onBack,
  mapReady,
  isGcj,
  projectName,
  collapsed,
  onToggleCollapse,
}: ResultsPanelProps) {
  const description: TerrainDescription = useMemo(
    () => describeTerrain(result),
    [result],
  )
  const [profile, setProfile] = useState<ProfileResult | null>(null)
  const [drawingProfile, setDrawingProfile] = useState(false)
  /** 已画好的剖面线（WGS84）。留在图上，方便核对位置 */
  const [profileLine, setProfileLine] = useState<Position[] | null>(null)
  /** 绘制中的顶点数，驱动「撤销 / 完成」按钮 */
  const [profileDraft, setProfileDraft] = useState(0)
  const profileToolRef = useRef<ProfileLineHandle>(null)
  const slopeChartRef = useRef<InstanceType<typeof ReactEChartsCore>>(null)
  const histChartRef = useRef<InstanceType<typeof ReactEChartsCore>>(null)
  const aspectChartRef = useRef<InstanceType<typeof ReactEChartsCore>>(null)
  const profileChartRef = useRef<InstanceType<typeof ReactEChartsCore>>(null)

  /* ---------------- 视域分析 ---------------- */
  /** 是否处于「点一下设观察点」状态 */
  const [pickingViewshed, setPickingViewshed] = useState(false)
  const [viewshed, setViewshed] = useState<ViewshedResult | null>(null)
  /** 观察点离地高度 m（人眼 2m / 车顶 5m / 塔顶 30m …） */
  const [eyeHeight, setEyeHeight] = useState(2)
  const [viewRadiusKm, setViewRadiusKm] = useState(5)
  /** 观察点落不到网格内（点在选区之外）时的提示 */
  const [viewshedError, setViewshedError] = useState<string | null>(null)

  const { elevation, slope, slopeClasses, elevationHistogram, highest, lowest, areaKm2, landform, aspectHistogram } = result
  const hydrology = result.hydrology
  const curvature = result.curvature
  /** 老版本存下来的项目没有水文/曲率网格，缺失时只提示、不渲染数字 */
  const hasHydro = !!hydrology && !!result.flowAccGrid
  const hasCurv = !!curvature && !!result.curvGrid

  // 主导坡向（排除“平坦”）
  const dominantAspect = useMemo(() => {
    let best = { dir: '—', ratio: -1 }
    for (const b of aspectHistogram) {
      if (b.dir === '平坦') continue
      if (b.ratio > best.ratio) best = b
    }
    return best
  }, [aspectHistogram])

  const runViewshed = (lon: number, lat: number, radius = viewRadiusKm, eye = eyeHeight) => {
    const v = computeViewshed(result.grid, lon, lat, result.resolutionM, {
      radiusKm: radius,
      observerHeightM: eye,
    })
    if (!v) {
      setViewshed(null)
      mapRef.current?.setViewshed(null)
      setViewshedError('这个点不在本次分析的选区里（或该处没有高程数据），请在选区内部点一个位置。')
      return
    }
    setViewshedError(null)
    setViewshed(v)
    mapRef.current?.setViewshed(v)
  }

  const handleViewshedPick = (lon: number, lat: number) => {
    setPickingViewshed(false)
    runViewshed(lon, lat)
  }

  /** 改高度 / 半径后按新参数重算同一个观察点（不用重新点地图） */
  const updateViewshedParams = (radius: number, eye: number) => {
    setViewRadiusKm(radius)
    setEyeHeight(eye)
    if (viewshed) runViewshed(viewshed.lon, viewshed.lat, radius, eye)
  }

  const clearViewshed = () => {
    setViewshed(null)
    setViewshedError(null)
    mapRef.current?.setViewshed(null)
  }

  const handleProfileDrawn = (coords: Position[]) => {
    setDrawingProfile(false)
    // 线保留在地图上：剖面图只是这条线的“读数”，位置对不对得回图上看
    setProfileLine(coords)
    const fn = makeGridElevationFn(result.grid)
    const prof = computeProfile(coords, fn, Math.max(20, result.resolutionM))
    setProfile(prof)
  }

  const clearProfile = () => {
    setProfile(null)
    setProfileLine(null)
    setProfileDraft(0)
  }

  /**
   * 导出文件名统一为「项目名-时间」，PNG 与 PDF 用同一套 base ——
   * 同一个项目的图与报告放在一起时天生配对，不用再猜哪个是哪个。
   */
  const fileBase = () => `${safeFileName(projectName || '地形分析')}-${exportStamp()}`

  const handleExportPdf = () => {
    let mapDataUrl: string | undefined
    try {
      mapDataUrl = mapRef.current?.exportCanvas()
    } catch {
      mapDataUrl = undefined
    }
    const slopeDataUrl = slopeChartRef.current
      ?.getEchartsInstance()
      .getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' })
    const aspectDataUrl = aspectChartRef.current
      ?.getEchartsInstance()
      .getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' })
    const profileDataUrl = profile
      ? profileChartRef.current
          ?.getEchartsInstance()
          .getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' })
      : undefined
    exportReportPDF(
      result,
      description,
      {
        mapDataUrl,
        slopeMapDataUrl: slopeDataUrl,
        aspectMapDataUrl: aspectDataUrl,
        profileDataUrl,
      },
      { projectName, fileName: fileBase() },
    )
  }

  const handleExportMapPng = () => {
    const url = mapRef.current?.exportCanvas()
    if (url) downloadPng(url, `${fileBase()}.png`)
  }

  return (
    <div className={`results-panel ${collapsed ? 'is-collapsed' : ''}`}>
      {/* 固定头部：标题 / 图层切换，正文在下方独立滚动 */}
      <div className="results-head">
        {/*
          窄屏专用：这条横条本身就是展开/收起的开关。
          它必须是真的 <button> 而不是 CSS 伪元素 —— 伪元素点下去也会命中父元素，
          但没法只让横条区域响应（点标题也会一起触发），而且触控目标太小。
          桌面端 CSS 里 display:none。
        */}
        <button
          type="button"
          className="sheet-handle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开分析结果' : '收起分析结果'}
          title={collapsed ? '展开分析结果' : '收起分析结果'}
        >
          <span className="sheet-handle-bar" />
        </button>

        <div className="results-title">
          <div className="results-title-text">
            <h2>地形分析结果</h2>
            {projectName && (
              <span className="results-project" title={`当前项目：${projectName}`}>
                {projectName}
              </span>
            )}
          </div>
          <div className="results-head-btns">
            <button className="btn-ghost" onClick={onBack} title="回到圈选，重新选择区域">
              ← 重选
            </button>
            <button
              className="btn-ghost panel-toggle"
              onClick={onToggleCollapse}
              title="收起面板，腾出地图空间"
            >
              ›
            </button>
          </div>
        </div>

        {/*
          两个下拉并排一行：左边地形图层、右边派生分析。
          每个下拉只装自己那组的选项，当前图层不在本组时显示占位项 ——
          这样一眼能看出"现在看的是哪一组里的哪一个"，又不用把十个
          按钮挤在面板头部（窄屏上根本放不下）。
        */}
        <div className="layer-selects">
          {LAYER_GROUPS.map((g) => {
            const inGroup = g.items.some((l) => l.id === activeLayer)
            return (
              <label className="layer-select" key={g.title}>
                <span className="layer-label">{g.title}</span>
                <select
                  value={inGroup ? activeLayer : ''}
                  onChange={(e) => onLayerChange(e.target.value as TerrainLayer)}
                  title={g.title}
                >
                  <option value="" disabled>
                    选择{g.title}
                  </option>
                  {g.items.map((l) => (
                    <option key={l.id} value={l.id} title={l.title}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}
        </div>
      </div>

      <div className="results-body">
      <p className="layer-hint">
        <b>当前图层 · {LAYER_LABELS[activeLayer]}</b>
        {' — '}
        {LAYER_HINTS[activeLayer]}
      </p>
      {/* 概览：一眼看懂这块地 */}
      <section className="result-section" id="sec-overview">
        <h3>地形概览</h3>
        <p className="section-lead">
          这块区域有多大、整体多高多陡、起伏有多剧烈——先看这几个核心指标。
        </p>
        <div className="stat-grid">
          <StatCard label="区域面积" value={fmtArea(areaKm2).split(' ')[0]} unit={fmtArea(areaKm2).split(' ')[1] || ''} />
          <StatCard label="最低海拔" value={fmtInt(elevation.min)} unit="m" />
          <StatCard label="最高海拔" value={fmtInt(elevation.max)} unit="m" />
          <StatCard label="平均海拔" value={fmtInt(elevation.mean)} unit="m" />
          <StatCard label="最大高差" value={fmtInt(elevation.range)} unit="m" />
          <StatCard label="平均坡度" value={fmtNumber(slope.mean, 1)} unit="°" />
          <StatCard label="平均起伏度" value={fmtInt(result.localReliefMean)} unit="m" hint="3×3 窗口" />
          <StatCard label="地形粗糙度" value={fmtNumber(result.triMean, 1)} unit="m" hint="TRI" />
        </div>
        <p className="section-note">
          数据源：{result.demSource || 'DEM 瓦片'}；采样网格 {result.resolutionM} m
          （{result.grid.cols} × {result.grid.rows}）。
        </p>
      </section>

      {/* 最高点 / 最低点 */}
      <section className="result-section" id="sec-elevation">
        <h3>最高点 / 最低点</h3>
        <p className="section-lead">
          地图上的<b className="hint-high">红点</b>就是最高点、<b className="hint-low">蓝点</b>就是最低点，
          <b>点击图上的点</b>会弹出该点的海拔、经纬度与含义说明。
        </p>
        <div className="extreme-grid">
          <div className="extreme-card high">
            <div className="extreme-label">最高点</div>
            <div className="extreme-value">{fmtInt(highest.elevation)} m</div>
            <div className="extreme-coord">
              {highest.lat.toFixed(4)}, {highest.lon.toFixed(4)}
            </div>
          </div>
          <div className="extreme-card low">
            <div className="extreme-label">最低点</div>
            <div className="extreme-value">{fmtInt(lowest.elevation)} m</div>
            <div className="extreme-coord">
              {lowest.lat.toFixed(4)}, {lowest.lon.toFixed(4)}
            </div>
          </div>
        </div>
        <h3 style={{ marginTop: 18 }}>高程分布</h3>
        <p className="section-lead">像元按海拔分箱的分布，反映地势集中在哪个高度带。</p>
        <ElevationHistogram ref={histChartRef} bins={elevationHistogram} />
      </section>

      {/* 坡度 */}
      <section className="result-section" id="sec-slope">
        <h3>坡度：这块地有多陡？</h3>
        <div className="inline-stats">
          <span>平均坡度：<b>{fmtSlope(slope.mean)}</b></span>
          <span>最大坡度：<b>{fmtSlope(slope.max)}</b></span>
          <span>中位坡度：<b>{fmtSlope(slope.median)}</b></span>
        </div>
        <SlopeChart ref={slopeChartRef} classes={slopeClasses} />
      </section>

      {/* 坡向 */}
      <section className="result-section" id="sec-aspect">
        <h3>坡向：坡面朝哪个方向？</h3>
        <p className="section-lead">
          主导坡向为 <b>{dominantAspect.dir}</b>（占 {fmtNumber(dominantAspect.ratio * 100, 1)}%），
          关系到日照、积雪与建设朝向。
        </p>
        <AspectChart ref={aspectChartRef} bins={aspectHistogram} />
      </section>

      {/* 起伏与粗糙度 */}
      <section className="result-section" id="sec-relief">
        <h3>起伏度与粗糙度</h3>
        <p className="section-lead">
          衡量地表在局部尺度上的破碎与剧烈程度（区别于“最大高差”这种整体指标）。
        </p>
        <div className="stat-grid">
          <StatCard
            label="平均地形起伏度"
            value={fmtInt(result.localReliefMean)}
            unit="m"
            hint="3×3 窗口内最高最低差均值"
          />
          <StatCard
            label="地形粗糙度 TRI"
            value={fmtNumber(result.triMean, 1)}
            unit="m"
            hint="像元与邻域平均高差"
          />
        </div>
        <p className="section-note">
          数值越大代表地表越破碎、越“崎岖”；平原与台地通常接近 0，山地沟壑区明显偏高。
        </p>
      </section>

      {/* 地形位置 */}
      <section className="result-section" id="sec-landform">
        <h3>地形位置（TPI 分类）</h3>
        <p className="section-lead">
          按地形位置指数把区域划分为山脊、山坡、山谷与平地，直观看出“哪类地形占主体”。
        </p>
        <div className="landform-bars">
          {LANDFORM_ITEMS.map((it) => {
            const ratio = landform[it.key]
            return (
              <div className="landform-row" key={it.key}>
                <span className="landform-label">{it.label}</span>
                <div className="landform-track">
                  <div
                    className="landform-fill"
                    style={{ width: `${Math.round(ratio * 100)}%`, background: it.color }}
                  />
                </div>
                <span className="landform-val">{fmtNumber(ratio * 100, 1)}%</span>
              </div>
            )
          })}
        </div>
      </section>

      {/* 水文分析 */}
      <section className="result-section" id="sec-hydro">
        <h3>水文分析：水往哪里流</h3>
        {!hasHydro ? (
          <p className="section-note">
            这个项目是用旧版本保存的，当时还没算水文指标。点「← 重选」重新分析一次即可看到河网与汇流。
          </p>
        ) : (
          <>
            <p className="section-lead">
              按 D8 单流向模型逐像元追踪水流方向，累积出上游汇水面积；汇水面积超过
              {' '}{fmtNumber(hydrology.thresholdKm2, 2)} km² 的像元连成河网。
            </p>
            <div className="stat-grid">
              <StatCard
                label="河网密度"
                value={fmtNumber(hydrology.drainageDensity, 2)}
                unit="km/km²"
                hint="单位面积上的河道长度"
              />
              <StatCard
                label="河网总长"
                value={fmtNumber(hydrology.streamLengthKm, 1)}
                unit="km"
                hint={`${fmtInt(hydrology.streamCells)} 个河道像元`}
              />
              <StatCard
                label="最长主沟道"
                value={fmtNumber(hydrology.longestChannelKm, 2)}
                unit="km"
                hint="自源头到出口的最长流路"
              />
              <StatCard
                label="最大汇流累积"
                value={fmtNumber(hydrology.maxAccKm2, 2)}
                unit="km²"
                hint="该点上游汇集的总面积"
              />
              <StatCard
                label="平均湿度指数"
                value={fmtNumber(hydrology.twiMean, 2)}
                unit="TWI"
                hint="ln(比汇水面积 / tan 坡度)"
              />
              <StatCard
                label="易积水区"
                value={fmtNumber(hydrology.wetRatio * 100, 1)}
                unit="%"
                hint={`TWI ≥ ${fmtNumber(hydrology.twiP80, 1)}（区域 80 分位）`}
              />
            </div>
            <p className="section-note">
              河网密度是判断地表切割程度的常用指标：&gt;2 km/km² 属沟谷密集（如黄土丘陵），
              1 km/km² 上下为一般山地，&lt;0.5 km/km² 多为平缓高原或平原。
              TWI 越大越容易汇水，谷底与洼地显著高于山脊。
            </p>
            <p className="section-note">
              ⚠️ 汇流只在<b>本次选区内</b>计算（选区外的 DEM 没有取数），所以边界处的
              汇水面积偏小。要分析一条完整流域，请把分水岭以内的范围都选进来。
            </p>
          </>
        )}
      </section>

      {/* 曲率 */}
      <section className="result-section" id="sec-curv">
        <h3>曲率：坡面是凸还是凹</h3>
        {!hasCurv ? (
          <p className="section-note">
            这个项目是用旧版本保存的，没有曲率数据。重新分析一次即可查看。
          </p>
        ) : (
          <>
            <p className="section-lead">
              平面曲率描述等高线的弯曲程度 —— 凸坡水流发散（山脊、坡肩），
              凹坡水流汇集（谷底、坡脚）。判读汇水与侵蚀位置靠它。
            </p>
            <div className="inline-stats">
              <span>平均平面曲率：<b>{fmtNumber(curvature.planMean, 2)}</b></span>
              <span>平均剖面曲率：<b>{fmtNumber(curvature.profileMean, 2)}</b></span>
              <span>平均绝对曲率：<b>{fmtNumber(curvature.meanAbs, 2)}</b></span>
            </div>
            <div className="curv-bars">
              <CurvBar label="凸坡（发散）" ratio={curvature.convexRatio} color="#ef8a62" />
              <CurvBar label="近线性" ratio={curvature.linearRatio} color="#c9ccc9" />
              <CurvBar label="凹坡（汇聚）" ratio={curvature.concaveRatio} color="#67a9cf" />
            </div>
            <p className="section-note">
              单位 1/100m（|曲率| ≤ 0.1 视为近线性）；凹坡占比明显偏高说明坡面
              以汇水型为主，雨季地表径流会快速向沟谷集中。
            </p>
          </>
        )}
      </section>

      {/* 视域分析 */}
      <section className="result-section" id="sec-viewshed">
        <h3>视域分析：站在这里能看见什么</h3>
        <p className="section-lead">
          在图上点一个观察点，逐条射线做视线通高判断，算出它能看到多大范围 ——
          选址观景台、瞭望塔、通信站、光伏板遮挡核查都用得上。
        </p>
        <div className="profile-controls">
          <button
            className={`btn-secondary ${pickingViewshed ? 'active' : ''}`}
            onClick={() => setPickingViewshed((v) => !v)}
          >
            {pickingViewshed ? '取消' : viewshed ? '换个观察点' : '在地图上选观察点'}
          </button>
          {viewshed && !pickingViewshed && (
            <button className="btn-ghost" onClick={clearViewshed}>
              清除视域
            </button>
          )}
        </div>
        {pickingViewshed && (
          <p className="section-note">请在地图上单击一个位置作为观察点（建议点在选区内部）。</p>
        )}
        {viewshedError && <p className="section-note warn">{viewshedError}</p>}
        <div className="viewshed-params">
          <label>
            观察高度
            <select
              value={eyeHeight}
              onChange={(e) => updateViewshedParams(viewRadiusKm, Number(e.target.value))}
            >
              <option value={2}>2 m（人眼）</option>
              <option value={5}>5 m（车顶）</option>
              <option value={10}>10 m（屋顶）</option>
              <option value={30}>30 m（塔顶）</option>
            </select>
          </label>
          <label>
            搜索半径
            <select
              value={viewRadiusKm}
              onChange={(e) => updateViewshedParams(Number(e.target.value), eyeHeight)}
            >
              <option value={3}>3 km</option>
              <option value={5}>5 km</option>
              <option value={10}>10 km</option>
              <option value={20}>20 km</option>
            </select>
          </label>
        </div>
        {viewshed && (
          <>
            <div className="inline-stats">
              <span>观察点海拔：<b>{fmtInt(viewshed.observerElev)} m</b></span>
              <span>可见面积：<b>{fmtNumber(viewshed.visibleKm2, 2)} km²</b></span>
              <span>选区内可见：<b>{fmtNumber(viewshed.visibleRatio * 100, 1)}%</b></span>
            </div>
            <p className="section-note">
              图上<span className="swatch-vis">亮黄绿</span>为可见区域、
              <span className="swatch-hid">深灰</span>为被地形遮挡的区域，
              <span className="swatch-obs">橙点</span>是观察点。已按地球曲率（含大气折射）修正，
              远处地势低的地方会被地平线挡掉。
            </p>
          </>
        )}
      </section>

      {/* 剖面 */}
      <section className="result-section" id="sec-profile">
        <h3>高程剖面：沿一条线切开看</h3>
        <div className="profile-controls">
          <button
            className={`btn-secondary ${drawingProfile ? 'active' : ''}`}
            onClick={() => setDrawingProfile((v) => !v)}
          >
            {drawingProfile ? '取消绘制' : profile ? '重画剖面线' : '绘制剖面线'}
          </button>
          {profile && !drawingProfile && (
            <button className="btn-ghost" onClick={clearProfile}>
              清除剖面
            </button>
          )}
        </div>
        {/* 触屏上双击是地图放大，画不出剖面线 —— 靠这两个按钮结算 */}
        {drawingProfile && (
          <div className="profile-controls profile-draft">
            <span className="hint">
              在地图上点击拾取顶点（已选 <b>{profileDraft}</b> 点），双击或点「完成」结束
            </span>
            <button
              className="btn-ghost"
              disabled={profileDraft === 0}
              onClick={() => profileToolRef.current?.undoPoint()}
            >
              撤销
            </button>
            <button
              className="btn-primary"
              disabled={profileDraft < 2}
              onClick={() => profileToolRef.current?.finish()}
            >
              完成
            </button>
          </div>
        )}
        {profile && (
          <>
            <div className="inline-stats">
              <span>线路距离：<b>{fmtDist(profile.distanceKm)}</b></span>
              <span>最高点：<b>{fmtInt(profile.maxElevation)} m</b></span>
              <span>最低点：<b>{fmtInt(profile.minElevation)} m</b></span>
              <span>累计爬升：<b>{fmtInt(profile.climb)} m</b></span>
              <span>累计下降：<b>{fmtInt(profile.descent)} m</b></span>
              <span>平均坡度：<b>{fmtSlope(profile.avgSlope)}</b></span>
            </div>
            <ProfileChart ref={profileChartRef} profile={profile} />
          </>
        )}
      </section>

      {/* 结论 */}
      <section className="result-section" id="sec-desc">
        <h3>地形特征总结</h3>
        <div className="description">
          {description.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        <div className="keywords">
          {description.keywords.map((k) => (
            <span key={k} className="keyword">
              {k}
            </span>
          ))}
        </div>
      </section>

      {/* 结果导出：与其余章节平级，作为正文的最后一节 */}
      <section className="result-section" id="sec-export">
        <h3>结果导出</h3>
        <p className="section-lead">
          把当前视图与全部分析结论导出成文件：PNG 直接用于配图，PDF 是含图表与
          剖面图的完整报告。文件名统一为「项目名-时间」，同名项目不同批次的导出
          自然按时间排开。
        </p>
        <div className="export-btns">
          <button className="btn-secondary" onClick={handleExportMapPng}>
            地图 PNG
          </button>
          <button className="btn-primary" onClick={handleExportPdf}>
            PDF 报告
          </button>
        </div>
        <p className="section-note copyright">
          © {SITE_OWNER} · 地形分析器 —— 数据与报告均在浏览器本地生成，不上传任何服务器。
        </p>
      </section>

      </div>

      <ProfileLineTool
        ref={profileToolRef}
        mapRef={mapRef}
        active={drawingProfile}
        onDrawn={handleProfileDrawn}
        mapReady={mapReady}
        isGcj={isGcj}
        line={profileLine}
        onPointsChange={setProfileDraft}
      />
      <ViewshedTool
        mapRef={mapRef}
        active={pickingViewshed}
        onPick={handleViewshedPick}
        mapReady={mapReady}
        isGcj={isGcj}
      />
    </div>
  )
}

/** 曲率构成条（凸 / 线性 / 凹），复用地形位置那套横条样式 */
function CurvBar({ label, ratio, color }: { label: string; ratio: number; color: string }) {
  const r = isFinite(ratio) ? ratio : 0
  return (
    <div className="landform-row">
      <span className="landform-label">{label}</span>
      <div className="landform-track">
        <div
          className="landform-fill"
          style={{ width: `${Math.round(r * 100)}%`, background: color }}
        />
      </div>
      <span className="landform-val">{fmtNumber(r * 100, 1)}%</span>
    </div>
  )
}
