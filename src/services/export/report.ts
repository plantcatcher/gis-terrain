/* =========================================================================
   地形分析报告 PDF 导出 —— 零依赖排版引擎

   原理：手写 PDF 对象结构（不依赖 jsPDF / html2canvas），正文是**真矢量文字**
   而不是整页截图，所以文字可选中、可搜索、放大不发虚，文件也小一个量级。

   字体策略（两个字体都不需要嵌入文件、不需要网络请求）：
     · 中文 + 中文标点 → STSong-Light（Adobe-GB1 / UniGB-UCS2-H），用 UTF-16BE hex 字符串
     · ASCII          → Helvetica（Type1 / WinAnsiEncoding），用单字节 hex 字符串
   之所以 ASCII 不能复用 STSong-Light：实测它的 ASCII 宽度约 0.97em（接近全角），
   长英文/数字会直接溢出右边界。Helvetica 则在字体字典里显式声明 /Widths，
   保证「换行计算」与「阅读器排版」严格一致，零误差。

   图片：canvas 重编码为 JPEG 后以 /DCTDecode 直接嵌入（不二次解码），
   与矢量文字混排。
   ========================================================================= */

import type { TerrainAnalysisResult, TerrainDescription } from '../../types'
import { fmtInt, fmtNumber } from '../../utils/format'
import { SITE_OWNER } from '../../config'

export interface ReportAssets {
  mapDataUrl?: string
  slopeMapDataUrl?: string
  aspectMapDataUrl?: string
  profileDataUrl?: string
}

export interface ReportMeta {
  /** 项目名：封面上标注、页眉里显示 */
  projectName?: string
  /** 不含扩展名的文件名主体（与 PNG 共用同一套「项目名-时间」） */
  fileName?: string
}

/** 下载单个 PNG */
export function downloadPng(dataUrl: string, filename: string) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}

/* ------------------------------------------------------------------ */
/* 页面几何（单位 pt，A4 纵向）                                        */
/* ------------------------------------------------------------------ */

const PW = 595.28
const PH = 841.89
const ML = 46
const MR = 46
const MT = 52
const MB = 50
/** 内容宽 = 503.28 */
const CW = PW - ML - MR

/* ------------------------------------------------------------------ */
/* 调色（RGB 0-1，与界面同源的冷静蓝灰）                                */
/* ------------------------------------------------------------------ */

const INK: RGB = [0.1, 0.12, 0.17]
const MUT: RGB = [0.42, 0.46, 0.52]
const FAINT: RGB = [0.62, 0.66, 0.72]
const LINE: RGB = [0.86, 0.89, 0.93]
const LINE_S: RGB = [0.93, 0.95, 0.97]
const ZEBRA: RGB = [0.968, 0.976, 0.984]
const PANEL: RGB = [0.965, 0.973, 0.984]
const TRACK: RGB = [0.902, 0.922, 0.949]
const SLATE: RGB = [0.13, 0.17, 0.24]
const BRAND: RGB = [0.145, 0.388, 0.921]
const BRAND_L: RGB = [0.929, 0.949, 0.996]
const BRAND_D: RGB = [0.114, 0.306, 0.847]
const WHITE: RGB = [1, 1, 1]

/** 各章节的主题色，用来给指标条和分布条配色 */
const C_ELEV: RGB = [0.09, 0.55, 0.45]
const C_SLOPE: RGB = [0.86, 0.47, 0.09]
const C_ASPECT: RGB = [0.47, 0.24, 0.89]
const C_LAND: RGB = [0.02, 0.52, 0.62]
const C_RELIEF: RGB = [0.79, 0.16, 0.13]
const C_WATER: RGB = [0.11, 0.45, 0.85]

type RGB = [number, number, number]

/** 嵌入 PDF 的一张图：name 必须是 PDF 资源名（Im1 / Im2 …） */
export interface ReportImage {
  name: string
  bytes: Uint8Array
  w: number
  h: number
}

/** 内部沿用短名 */
type ImgRef = ReportImage

/* ------------------------------------------------------------------ */
/* 文本：白名单 / 宽度 / 编码                                          */
/* ------------------------------------------------------------------ */

/** GB1 覆盖面之外的字符直接丢弃，避免阅读器渲染出豆腐块 */
const WIDE_RE = /[\u2E80-\u9FFF\u3000-\u303F\u3400-\u4DBF\uF900-\uFAFF\uFF00-\uFFEF]/
/** 常用且在 GB1 内的符号（° × · – — 引号 省略号 等） */
const OK_PUNCT = '\u00b0\u00b7\u00d7\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u2103\u2192\u221a\u00a0'

function sanitize(s: unknown): string {
  let out = ''
  for (const ch of normalize(String(s == null ? '' : s))) {
    const c = ch.charCodeAt(0)
    if ((c >= 0x20 && c <= 0x7e) || WIDE_RE.test(ch) || OK_PUNCT.indexOf(ch) >= 0) out += ch
  }
  return out
}

/** STSong-Light（Type0）用 UTF-16BE hex */
function esc16(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0')
  return '<' + out + '>'
}

/**
 * 交给 Helvetica 的额外字符 —— 只放「在 Adobe StandardEncoding 里同码位也有字形」的那几个。
 *
 * ⚠️ 踩过的坑：WinAnsi 的 0x80–0x9F 段（– — … 弯引号）在标准 14 字体的**内置编码**里是空的。
 * 虽然字体字典已声明 /Encoding /WinAnsiEncoding，但实测 MuPDF 与 Ghostscript 都会按字体自身
 * 编码取字形 → 渲染成空白并丢掉字宽（"0–5°" 变成 "05°"）。所以这一段一律留给中文字体（GB1 有）。
 * 而 °(0xB0) ·(0xB7) ×(0xD7) 在 StandardEncoding 里同码位有字形，可以安全走 Helvetica 拿到窄字宽。
 */
const WINANSI: Record<string, number> = {
  '\u00b0': 0xb0, // °
  '\u00b7': 0xb7, // ·
  '\u00d7': 0xd7, // ×
}

/** 该字符能否交给 Helvetica 渲染 */
function isLatin(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (c >= 0x20 && c <= 0x7e) || WINANSI[ch] != null
}

/**
 * 渲染前归一化。
 * en dash 是数据自带的（坡度分级 "0–5°"、高程分带 "1800–2150 m"），
 * 它在中文字体里是 1em 全角，做数值区间会撑出 "0– 5°" 的空档；降级成 ASCII 连字符后
 * 走 Helvetica 拿到 333/1000 的窄字宽，且渲染绝对可靠。
 * （em dash — 不改，中文正文里的破折号本来就该是全角。）
 */
function normalize(s: string): string {
  return s.replace(/\u2013/g, '-')
}

/** Helvetica（Type1）按单字节（WinAnsi）解释 */
function escLatin(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    const c = ch.charCodeAt(0)
    const b = c >= 0x20 && c <= 0x7e ? c : WINANSI[ch] ?? 0x3f
    out += b.toString(16).padStart(2, '0')
  }
  return '<' + out + '>'
}

/** Helvetica AFM 字宽（/1000 em），对应码位 0x20–0x7E，共 95 项 */
const HELV_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

/**
 * 交给 PDF 字体字典的 /Widths —— 必须覆盖**所有会被绘制的码位**，即按 WinAnsi 全量声明 32–255。
 *
 * ⚠️ 踩过的坑：先前只声明 32–126（ASCII），结果 ° · × 这些超出范围的码位退化成
 * MissingWidth（默认 0）：字形照样画出来，但**不占宽度**，
 * 于是 "Terrarium ·SRTM"、"912 ×907" 全黏在一起。
 * 常用但未列入 AFM 表的码位按其真实字宽补上，其余填 500（实际不会用到）。
 */
const FULL_W: number[] = (() => {
  const w = new Array<number>(224).fill(500) // 码位 32..255
  for (let i = 0; i < HELV_W.length; i++) w[i] = HELV_W[i]
  w[0xb0 - 32] = 400 // °
  w[0xb7 - 32] = 278 // ·
  w[0xd7 - 32] = 584 // ×
  return w
})()

/** 单字符宽度：ASCII / WinAnsi 标点查表，CJK 按 1em */
function chW(ch: string, size: number): number {
  const c = ch.charCodeAt(0)
  if (c >= 0x20 && c <= 0x7e) return (FULL_W[c - 0x20] / 1000) * size
  const b = WINANSI[ch]
  if (b != null) return (FULL_W[b - 32] / 1000) * size
  return size
}

function strW(s: string, size: number): number {
  let w = 0
  for (let i = 0; i < s.length; i++) w += chW(s.charAt(i), size)
  return w
}

/** 按字宽折行（先清洗，保证与渲染字符集一致） */
function wrap(text: unknown, size: number, maxW: number): string[] {
  const lines: string[] = []
  const t = sanitize(text)
  let cur = ''
  let curW = 0
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i)
    const w = chW(ch, size)
    if (curW + w > maxW && cur) {
      lines.push(cur)
      cur = ch
      curW = w
    } else {
      cur += ch
      curW += w
    }
  }
  if (cur || !lines.length) lines.push(cur)
  return lines
}

/** 截断到指定宽度，超出补省略号 */
function ellipsize(s: unknown, size: number, maxW: number): string {
  const t = sanitize(s)
  if (strW(t, size) <= maxW) return t
  let out = ''
  for (let i = 0; i < t.length; i++) {
    if (strW(out + t.charAt(i) + '\u2026', size) > maxW) break
    out += t.charAt(i)
  }
  return out + '\u2026'
}

function f2(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function stampNow(d = new Date()): string {
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  )
}

/* ------------------------------------------------------------------ */
/* 文档构建器                                                          */
/* ------------------------------------------------------------------ */

class Doc {
  pages: string[] = []
  ops: string[] = []
  /** 当前块的上边缘（文本按基线绘制，基线 = y - pad - size） */
  y = PH - MT

  newPage() {
    this.pages.push(this.ops.join('\n'))
    this.ops = []
    this.y = PH - MT
  }

  /** 空间不足则翻页 */
  ensure(h: number) {
    if (this.y - h < MB) this.newPage()
  }

  gap(n: number) {
    this.y -= n
  }

  /* ---- 基础绘制 ---- */

  txt(s: unknown, x: number, y: number, size: number, color: RGB = INK, bold = false): number {
    const t = sanitize(s)
    const runs: { f: string; s: string }[] = []
    for (let i = 0; i < t.length; i++) {
      const ch = t.charAt(i)
      const f = isLatin(ch) ? 'F2' : 'F1'
      const last = runs[runs.length - 1]
      if (last && last.f === f) last.s += ch
      else runs.push({ f, s: ch })
    }
    let cx = x
    for (const r of runs) {
      // 加粗是「填充 + 描边」模拟出来的，所以描边色必须显式设成文字色。
      // ⚠️ 踩过的坑：早期只设了 rg（填充色）不设 RG，描边就继承了上一条分隔线留下的
      // 近白色，等于把字形笔画整条刷白，只剩极细的深色芯 —— 整行标题看起来是空心的。
      // 描边宽度按字号缩放并封顶，否则 8pt 的粗体（表头、卡片标签）会糊成一坨。
      const bw = Math.max(0.2, Math.min(0.34, size * 0.03)).toFixed(2)
      this.ops.push(
        `BT ${color.join(' ')} rg ${color.join(' ')} RG ${bold ? `2 Tr ${bw} w ` : '0 Tr '}/` +
          `${r.f} ${f2(size)} Tf 1 0 0 1 ${f2(cx)} ${f2(y)} Tm ` +
          `${r.f === 'F2' ? escLatin(r.s) : esc16(r.s)} Tj ET`,
      )
      cx += strW(r.s, size)
    }
    return cx - x
  }

  txtRight(s: unknown, xr: number, y: number, size: number, color: RGB = INK, bold = false) {
    const t = sanitize(s)
    this.txt(t, xr - strW(t, size), y, size, color, bold)
  }

  txtCenter(s: unknown, xc: number, y: number, size: number, color: RGB = INK, bold = false) {
    const t = sanitize(s)
    this.txt(t, xc - strW(t, size) / 2, y, size, color, bold)
  }

  rect(x: number, y: number, w: number, h: number, color: RGB) {
    this.ops.push(`${color.join(' ')} rg ${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re f`)
  }

  hline(x1: number, x2: number, y: number, color: RGB = LINE, w = 0.7) {
    this.ops.push(
      `${f2(w)} w ${color.join(' ')} RG ${f2(x1)} ${f2(y)} m ${f2(x2)} ${f2(y)} l S`,
    )
  }

  vline(x: number, y1: number, y2: number, color: RGB = LINE, w = 0.6) {
    this.ops.push(
      `${f2(w)} w ${color.join(' ')} RG ${f2(x)} ${f2(y1)} m ${f2(x)} ${f2(y2)} l S`,
    )
  }

  image(name: string, x: number, y: number, w: number, h: number) {
    this.ops.push(
      `q ${f2(w)} 0 0 ${f2(h)} ${f2(x)} ${f2(y)} cm /${name} Do Q`,
    )
  }

  /**
   * 「铺满裁切」：把图等比放大到刚好盖住给定矩形，多出来的部分用裁剪路径切掉。
   * 这样无论原图长宽比多极端（超宽全景 / 竖长图），封面主图都占一个恒定高度，
   * 下方所有内容的位置都不受影响。裁切是 PDF 原生的 W n，不额外解码。
   */
  coverImage(img: ImgRef, x: number, y: number, w: number, h: number) {
    const s = Math.max(w / img.w, h / img.h)
    const dw = img.w * s
    const dh = img.h * s
    this.ops.push(
      'q',
      `${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re W n`,
      `q ${f2(dw)} 0 0 ${f2(dh)} ${f2(x + (w - dw) / 2)} ${f2(y + (h - dh) / 2)} cm /${img.name} Do Q`,
      'Q',
    )
  }

  /* ---- 文本块 ---- */

  /** 段落：返回占用高度。maxW 必须扣掉 indent，否则缩进段会顶出右边界 */
  para(text: unknown, size: number, color: RGB = INK, opt: { indent?: number; x?: number; lh?: number; bold?: boolean; width?: number } = {}): number {
    const ind = opt.indent || 0
    const maxW = opt.width || CW - ind
    const lh = opt.lh || size * 1.6
    const lines = wrap(text, size, maxW)
    this.ensure(lines.length * lh)
    for (const line of lines) {
      if (this.y - lh < MB) this.newPage()
      this.y -= lh
      this.txt(line, (opt.x || ML) + ind, this.y, size, color, opt.bold)
    }
    return lines.length * lh
  }

  /** 小节标题（章节内的小分组） */
  subtitle(text: string) {
    this.ensure(30)
    this.y -= 6
    this.txt(text, ML, this.y, 9.5, BRAND_D, true)
    this.y -= 16
  }

  /** 带编号的章节标题 */
  section(num: string, title: string) {
    // 预留标题本身（约 63pt）+ 两行正文，避免标题孤零零吊在页面最下方
    this.ensure(80)
    this.y -= 16
    this.hline(ML, ML + CW, this.y, LINE_S, 0.6)
    this.y -= 25
    this.txt(num, ML, this.y, 15, [0.72, 0.78, 0.89], true)
    this.txt(title, ML + 28, this.y + 1.5, 12.5, INK, true)
    this.y -= 8
    this.hline(ML, ML + CW, this.y, BRAND, 1.2)
    this.y -= 14
  }

  /** 指标卡（n 列网格中的一格） */
  metric(x: number, top: number, w: number, h: number, label: string, value: string, unit?: string, accent: RGB = BRAND) {
    this.rect(x, top - h, w, h, PANEL)
    this.rect(x, top - h, 2.4, h, accent)
    this.txt(label, x + 10, top - 13, 8, MUT)
    const vw = this.txt(value, x + 10, top - h + 16, 15.5, INK, true)
    if (unit) this.txt(unit, x + 10 + vw + 2.5, top - h + 16, 8.5, MUT, true)
  }

  /**
   * 分布行：标签 + 进度条 + 占比 + 备注
   * 组件一律「传右边界、内部自己算宽度」，避免与外层算法差 1pt 压线。
   *
   * keepNext：本行后面还有同组行时置 true，要求一次留出「两行」的空间。
   * 这样分页时不会出现「本组只剩一行被甩到下一页」的孤行 —— 至少要成对换页。
   */
  distRow(
    label: string,
    ratio: number,
    note: string,
    color: RGB,
    opt: { labelW?: number; noteW?: number; keepNext?: boolean } = {},
  ) {
    const labelW = opt.labelW ?? 86
    const noteW = opt.noteW ?? 74
    const pctW = 44
    const barX = ML + labelW
    const barW = Math.max(40, CW - labelW - pctW - noteW - 10)
    this.ensure(opt.keepNext ? 35 : 18)
    this.txt(label, ML, this.y, 9, INK, false)
    const by = this.y - 1.8
    this.rect(barX, by, barW, 7, TRACK)
    const r = Math.max(0, Math.min(1, ratio))
    if (r > 0) this.rect(barX, by, barW * r, 7, color)
    this.txtRight(`${fmtNumber(r * 100, 1)}%`, barX + barW + pctW, this.y, 9, color, true)
    if (note) this.txtRight(ellipsize(note, 8, noteW), ML + CW, this.y, 8, FAINT)
    this.y -= 17
  }

  /** 大号数值行（用于背景指标条） */
  statRow(label: string, value: number | null, max: number, note: string, color: RGB) {
    const labelW = 78
    const barX = ML + labelW
    const barW = CW - labelW - 74
    this.txt(label, ML, this.y, 8.5, INK, true)
    const by = this.y - 1.5
    this.rect(barX, by, barW, 6, TRACK)
    if (value != null && isFinite(value)) {
      this.rect(barX, by, (barW * Math.max(0, Math.min(1, value / max))) | 0, 6, color)
    }
    this.txtRight(value == null || !isFinite(value) ? '--' : note, ML + CW, this.y, 9, color, true)
    this.y -= 20
  }

  /** 键值两列表（斑马纹 + 细分隔线） */
  kvTable(rows: [string, string][]) {
    const kw = 104
    const size = 9
    const lh = 13
    const pad = 5
    let n = 0
    for (const [k, raw] of rows) {
      const v = sanitize(raw)
      if (!v) continue
      const lines = wrap(v, size, CW - kw - 12)
      const h = lines.length * lh + pad * 2
      this.ensure(h)
      if (n % 2 === 1) this.rect(ML, this.y - h, CW, h, ZEBRA)
      const yBase = this.y - pad - size
      this.txt(k, ML + 7, yBase, size, MUT, true)
      for (let j = 0; j < lines.length; j++) this.txt(lines[j], ML + kw, yBase - j * lh, size, INK)
      this.hline(ML, ML + CW, this.y - h, LINE_S, 0.5)
      this.y -= h
      n++
    }
    this.y -= 10
  }

  /** 通用表格：深色表头 + 斑马纹 + 跨页重复表头 + 数字列右对齐 */
  table(
    cols: number[],
    header: string[],
    rows: (string | number)[][],
    opt: { size?: number; align?: ('left' | 'right')[] } = {},
  ) {
    const size = opt.size ?? 8.5
    const lh = size * 1.5
    const pad = 4.5
    const align = opt.align || cols.map(() => 'left' as const)

    const drawHeader = () => {
      this.ensure(lh + pad * 2 + 6)
      this.rect(ML, this.y - (lh + pad * 2), CW, lh + pad * 2, SLATE)
      let x = ML
      for (let c = 0; c < cols.length; c++) {
        const hx = align[c] === 'right' ? x + cols[c] - 7 : x + 7
        if (align[c] === 'right') this.txtRight(header[c], hx, this.y - pad - size + 0.5, size, WHITE, true)
        else this.txt(header[c], hx, this.y - pad - size + 0.5, size, WHITE, true)
        x += cols[c]
      }
      this.y -= lh + pad * 2
    }

    drawHeader()
    for (let r = 0; r < rows.length; r++) {
      const cells: string[][] = []
      let maxLines = 1
      for (let c = 0; c < cols.length; c++) {
        const lines = wrap(rows[r][c], size, cols[c] - 14)
        cells.push(lines)
        if (lines.length > maxLines) maxLines = lines.length
      }
      const h = maxLines * lh + pad * 2
      if (this.y - h < MB) {
        this.newPage()
        drawHeader()
      }
      if (r % 2 === 1) this.rect(ML, this.y - h, CW, h, ZEBRA)
      let x = ML
      const yBase = this.y - pad - size
      for (let c = 0; c < cols.length; c++) {
        for (let j = 0; j < cells[c].length; j++) {
          const cy = yBase - j * lh
          if (align[c] === 'right') this.txtRight(cells[c][j], x + cols[c] - 7, cy, size, c === 0 ? MUT : INK, c === 0)
          else this.txt(cells[c][j], x + 7, cy, size, c === 0 ? MUT : INK, c === 0)
        }
        x += cols[c]
      }
      this.hline(ML, ML + CW, this.y - h, LINE, 0.4)
      this.y -= h
    }
    this.y -= 12
  }

  /** 状态胶囊，右边界对齐 */
  pill(xr: number, y: number, text: string, color: RGB, size = 8): number {
    const w = strW(sanitize(text), size) + 13
    this.rect(xr - w, y - 3, w, size + 8, color)
    this.txt(text, xr - w + 6.5, y + 1.5, size, WHITE, true)
    return w
  }

  /** 关键词标签云，自动换行 */
  pills(items: string[]) {
    const size = 8.5
    const h = 19
    const gap = 6
    let x = ML
    this.ensure(h)
    for (const it of items) {
      const w = strW(sanitize(it), size) + 16
      if (x + w > ML + CW) {
        this.y -= h
        this.ensure(h)
        x = ML
      }
      this.rect(x, this.y - 4, w, 15, BRAND_L)
      this.txt(it, x + 8, this.y, size, BRAND_D, true)
      x += w + gap
    }
    this.y -= h + 3
  }

  /** 引用块：左侧竖色条 + 浅底 */
  callout(text: string, color: RGB = BRAND, size = 8.5) {
    const lines = wrap(text, size, CW - 22)
    const lh = size * 1.55
    const h = lines.length * lh + 10
    this.ensure(h)
    this.rect(ML, this.y - h, CW, h, [0.97, 0.98, 0.995])
    this.rect(ML, this.y - h, 3, h, color)
    for (let i = 0; i < lines.length; i++) {
      this.txt(lines[i], ML + 12, this.y - 6 - size - i * lh, size, [0.13, 0.2, 0.35])
    }
    this.y -= h + 6
  }

  /** 插图（等宽自适应，超页则缩高） */
  figure(img: ImgRef | null, caption: string, maxH = 380, sideMargin = 0) {
    if (!img) return
    const availW = CW - sideMargin * 2
    let iw = availW
    let ih = (iw * img.h) / img.w
    if (ih > maxH) {
      ih = maxH
      iw = (ih * img.w) / img.h
    }
    this.ensure(ih + 34)
    const ix = ML + (CW - iw) / 2
    this.rect(ix - 1, this.y - ih - 1, iw + 2, ih + 2, [0.85, 0.88, 0.92])
    this.image(img.name, ix, this.y - ih, iw, ih)
    this.y -= ih + 13
    this.txt(caption, ML, this.y, 8, MUT)
    this.y -= 16
  }
}

/* ------------------------------------------------------------------ */
/* 报告上下文                                                          */
/* ------------------------------------------------------------------ */

interface Ctx {
  r: TerrainAnalysisResult
  desc: TerrainDescription
  images: Record<string, ImgRef>
  stamp: string
  rid: string
  centerLon: number
  centerLat: number
  /** 区域中心的粗略经纬度文本 */
  where: string
  /** 项目名（可为空：直接进结果页时没有项目名） */
  projectName: string
}

/** 起伏等级（用于封面主指标的定性标签） */
function reliefGrade(range: number): { text: string; color: RGB } {
  if (range > 1500) return { text: '高起伏', color: C_RELIEF }
  if (range > 500) return { text: '中起伏', color: C_SLOPE }
  if (range > 200) return { text: '小起伏', color: C_ELEV }
  return { text: '微起伏', color: C_ELEV }
}

function fmtCoord(lon: number, lat: number): string {
  const ew = lon >= 0 ? 'E' : 'W'
  const ns = lat >= 0 ? 'N' : 'S'
  return `${Math.abs(lon).toFixed(4)}\u00b0${ew}, ${Math.abs(lat).toFixed(4)}\u00b0${ns}`
}

/**
 * 面积文本 —— 刻意不用 "km²"：上标 ²（U+00B2）不在 Adobe-GB1 字符集里，
 * 会被 sanitize 丢掉，只剩 "km" 反而成了长度单位。中文一律写「平方公里」。
 */
function areaText(km2: number): string {
  if (!isFinite(km2)) return '--'
  if (km2 < 1) return `${fmtNumber(km2 * 1_000_000, 0)} 平方米`
  return `${fmtNumber(km2, 2)} 平方公里`
}

/** 数值 / 单位分开（指标卡两段式排版用） */
function areaParts(km2: number): [string, string] {
  if (!isFinite(km2)) return ['--', '']
  if (km2 < 1) return [fmtNumber(km2 * 1_000_000, 0), '平方米']
  return [fmtNumber(km2, 2), '平方公里']
}

/* ================================================================== */
/* 封面                                                                */
/* ================================================================== */

function buildCover(doc: Doc, ctx: Ctx) {
  const { r, desc } = ctx
  const grade = reliefGrade(r.elevation.range)

  // 顶部品牌色条
  doc.rect(0, PH - 13, PW, 13, BRAND)
  doc.y = PH - 13 - 42
  doc.txt('TERRAIN ANALYSIS \u00b7 地形分析报告', ML, doc.y, 8.5, BRAND, true)

  doc.y -= 38
  doc.txt('地形分析报告', ML, doc.y, 30, INK, true)

  doc.y -= 24
  doc.txt(ctx.where, ML, doc.y, 12.5, BRAND_D, true)

  doc.y -= 16
  doc.hline(ML, ML + CW, doc.y, LINE, 1)

  doc.y -= 21
  // 项目名挤在同一行的右端，而不是另起一行：封面下半部分是「固定高度块」，
  // 多插一行会把主图挤到封面外（或反过来顶穿底部脚注）。
  if (ctx.projectName) {
    doc.txtRight(`项目  ${ellipsize(ctx.projectName, 9, 186)}`, ML + CW, doc.y, 9, MUT, true)
  }
  doc.txt(
    `生成时间  ${ctx.stamp}      \u00b7      采样网格  ${r.resolutionM} m      \u00b7      报告编号  ${ctx.rid}`,
    ML,
    doc.y,
    8.5,
    MUT,
  )

  // ---- 主图（左右出血，视觉更有分量）----
  //
  // 封面版式的关键：下方所有块都是「固定高度」的，所以主图高度不能自由伸缩，
  // 否则结论多一行、底图长宽比一变，下面就会被顶穿或留出一大片空白。
  // 做法是先反推主图应有的高度，再用「铺满裁切」把任意长宽比的图塞进这个高度。
  const verdictRaw = desc.paragraphs[desc.paragraphs.length - 1] || '本次分析已完成。'
  const vLines = wrap(verdictRaw, 8.8, CW)
  const vShown = vLines.slice(0, 2)
  if (vLines.length > 2) vShown[1] = ellipsize(verdictRaw, 8.8, CW)
  const nv = Math.max(1, vShown.length)

  const ROW_H = 25
  // heroTop 往下逐段累加：hero 块 → 分隔 → 结论标签 → 结论行 → 分隔 → 表头 → 值行 ×2
  const belowHero = 92 + 20 + 18 + (14.5 + 13 * (nv - 1)) + 18 + 21 + 18 + ROW_H
  const LAST_FACT_Y = 112 // 末行基线固定在页脚分隔线（90）上方 22pt
  const heroTopTarget = LAST_FACT_Y + belowHero
  // 以版心反推高度，再夹在合理区间内（过矮会显得局促，过高会挤掉下方内容）
  const boxH = Math.max(190, Math.min(300, doc.y - 20 - 40 - heroTopTarget))

  const main = ctx.images.main || null
  const imgTop = doc.y - 20
  if (main) {
    const boxW = CW + 34 // 左右各出血 17pt
    const bx = ML - 17
    const by = imgTop - boxH
    doc.coverImage(main, bx, by, boxW, boxH)
    doc.y = by - 14
    doc.txt(
      `图 1    地形晕渲图 \u00b7 色阶为高程（${fmtInt(r.elevation.min)}\u2013${fmtInt(r.elevation.max)} m）\u00b7 数据源 ${r.demSource || 'DEM 瓦片'}`,
      ML,
      doc.y,
      8,
      MUT,
    )
  } else {
    doc.rect(ML, imgTop - boxH, CW, boxH, PANEL)
    doc.txtCenter('本次未导出地形图', ML + CW / 2, imgTop - boxH / 2 + 3, 9.5, FAINT, true)
    doc.y = imgTop - boxH - 14
  }

  // ---- 主指标 + 背景指标条 ----
  doc.y -= 26
  doc.hline(ML, ML + CW, doc.y, LINE, 1)
  const heroTop = doc.y

  doc.y = heroTop - 22
  doc.txt('最大高差', ML, doc.y, 8.5, MUT, true)

  doc.y -= 34
  const numW = doc.txt(fmtInt(r.elevation.range), ML, doc.y, 33, grade.color, true)
  doc.txt('m', ML + numW + 6, doc.y, 10.5, MUT, true)

  doc.y -= 17
  doc.pill(ML + 188, doc.y + 2.5, grade.text, grade.color, 8)
  doc.txt(
    `平均海拔 ${fmtInt(r.elevation.mean)} m \u00b7 平均坡度 ${fmtNumber(r.slope.mean, 1)}\u00b0`,
    ML,
    doc.y,
    9,
    MUT,
  )

  // 右侧四条背景指标（几何上贴着 heroTop 排，所以单独算 y）
  const rx = ML + 214
  const rw = CW - 214
  const bars: [string, number, number, string, RGB][] = [
    ['平均坡度', r.slope.mean, 45, `${fmtNumber(r.slope.mean, 1)}\u00b0`, C_SLOPE],
    ['地形粗糙度', r.triMean, 60, `${fmtNumber(r.triMean, 1)} m`, C_ELEV],
    ['平均起伏度', r.localReliefMean, 80, `${fmtInt(r.localReliefMean)} m`, C_LAND],
    ['最大坡度', r.slope.max, 90, `${fmtNumber(r.slope.max, 1)}\u00b0`, C_ASPECT],
  ]
  let ry = heroTop - 22 // 与左侧「最大高差」标签同一基线，避免左右两栏错半行
  for (const [label, val, max, note, color] of bars) {
    const labelW = 62
    const barW = Math.max(40, rw - labelW - 54)
    doc.txt(label, rx, ry, 8, INK, true)
    doc.rect(rx + labelW, ry - 1.5, barW, 6, TRACK)
    if (isFinite(val)) {
      doc.rect(rx + labelW, ry - 1.5, (barW * Math.max(0, Math.min(1, val / max))) | 0, 6, color)
    }
    doc.txtRight(note, ML + CW, ry, 8.5, color, true)
    ry -= 19
  }
  // 固定高度块，让后续内容位置不受图片长宽比影响
  doc.y = heroTop - 92

  // ---- 核心结论（顺手把封面的中部留白填成有信息量的内容）----
  doc.y -= 20
  doc.hline(ML, ML + CW, doc.y, LINE_S, 0.6)
  doc.y -= 18
  doc.txt('核心结论', ML, doc.y, 8, MUT, true)
  for (let i = 0; i < vShown.length; i++) {
    doc.y -= i === 0 ? 14.5 : 13
    doc.txt(vShown[i], ML, doc.y, 8.8, INK)
  }

  // ---- 三栏速览（两行：规模 / 高程）----
  doc.y -= 18
  doc.hline(ML, ML + CW, doc.y, LINE, 0.8)
  const colsTop = doc.y - 21
  // 列宽不等宽：DEM 数据源那串「AWS Terrain Tiles（Terrarium · SRTM 30m）」明显更长
  const factX = [ML, ML + 122, ML + 274]
  const factRows: [string, string][][] = [
    [
      ['分析面积', areaText(r.areaKm2)],
      ['采样精度', `${r.resolutionM} m \u00b7 ${r.grid.cols} \u00d7 ${r.grid.rows}`],
      ['DEM 数据源', r.demSource || 'DEM 瓦片'],
    ],
    [
      ['最低海拔', `${fmtInt(r.elevation.min)} m`],
      ['最高海拔', `${fmtInt(r.elevation.max)} m`],
      ['中位海拔', `${fmtInt(r.elevation.median)} m`],
    ],
  ]
  factRows.forEach((row, ri) => {
    const kY = colsTop - ri * ROW_H
    row.forEach(([k, v], i) => {
      const x = factX[i]
      const availW = (i < 2 ? factX[i + 1] - 13 : ML + CW) - x
      doc.txt(k, x, kY, 7.5, BRAND, true)
      doc.txt(ellipsize(v, 9, availW), x, kY - 18, 9, INK, true)
    })
  })
  // 跨两行的列分隔线
  for (let i = 1; i < 3; i++) doc.vline(factX[i] - 13, colsTop - ROW_H - 26, colsTop + 8, LINE, 0.6)

  // ---- 封面脚注（贴底固定）----
  const fy = MB + 22
  doc.hline(ML, ML + CW, fy + 18, LINE_S, 0.6)
  doc.txt(
    '本报告由浏览器在本地生成，未上传任何数据。高程数据来自公开 DEM 瓦片，分析结果为采样统计值，仅供规划与研究参考。',
    ML,
    fy + 4,
    7.5,
    MUT,
  )
  doc.txt(`\u00a9 ${SITE_OWNER} \u00b7 地形分析器`, ML, fy - 9, 7.5, MUT)
  doc.txtRight(
    `关键词：${desc.keywords.slice(0, 8).join(' \u00b7 ') || '\u2014'}`,
    ML + CW,
    fy - 9,
    7.5,
    BRAND_D,
    true,
  )

  doc.newPage()
}

/* ================================================================== */
/* 正文                                                                */
/* ================================================================== */

function buildBody(doc: Doc, ctx: Ctx) {
  const { r, desc } = ctx
  /* ---------- 01 概览 ---------- */
  doc.section('01', '分析概览')
  doc.para(desc.paragraphs[0] || '本次分析已完成，核心指标如下。', 9.5, INK, { lh: 15 })
  doc.gap(6)

  const areaV = areaParts(r.areaKm2)
  const cards: [string, string, string?, RGB?][] = [
    ['区域面积', areaV[0], areaV[1], BRAND],
    ['最低海拔', fmtInt(r.elevation.min), 'm', C_ELEV],
    ['最高海拔', fmtInt(r.elevation.max), 'm', C_ELEV],
    ['平均海拔', fmtInt(r.elevation.mean), 'm', C_ELEV],
    ['最大高差', fmtInt(r.elevation.range), 'm', C_RELIEF],
    ['平均坡度', fmtNumber(r.slope.mean, 1), '\u00b0', C_SLOPE],
    ['中位海拔', fmtInt(r.elevation.median), 'm', C_ELEV],
    ['地形粗糙度', fmtNumber(r.triMean, 1), 'm', C_LAND],
  ]
  const gapX = 8
  const cardW = (CW - gapX * 3) / 4
  const cardH = 46
  for (let row = 0; row < 2; row++) {
    doc.ensure(cardH + 8)
    for (let c = 0; c < 4; c++) {
      const item = cards[row * 4 + c]
      if (!item) continue
      doc.metric(ML + c * (cardW + gapX), doc.y, cardW, cardH, item[0], item[1], item[2], item[3])
    }
    doc.y -= cardH + gapX
  }
  doc.gap(6)

  doc.subtitle('地形特征关键词')
  doc.pills(desc.keywords.length ? desc.keywords : ['\u2014'])

  /* ---------- 02 地形特征解读 ---------- */
  doc.section('02', '地形特征解读')
  const paras = desc.paragraphs.length > 1 ? desc.paragraphs.slice(1) : desc.paragraphs
  for (const p of paras) {
    doc.para(p, 9.5, INK, { lh: 15.5 })
    doc.gap(5)
  }

  /* ---------- 03 高程分析 ---------- */
  doc.section('03', '高程分析')
  const mkExtreme = (x: number, w: number, tag: string, elev: number, lon: number, lat: number, color: RGB) => {
    const h = 58
    doc.rect(x, doc.y - h, w, h, PANEL)
    doc.rect(x, doc.y - h, 2.4, h, color)
    doc.txt(tag, x + 11, doc.y - 14, 8, MUT)
    const vw = doc.txt(fmtInt(elev), x + 11, doc.y - h + 20, 17, INK, true)
    doc.txt('m', x + 11 + vw + 3, doc.y - h + 20, 9, MUT, true)
    doc.txtRight(fmtCoord(lon, lat), x + w - 11, doc.y - 14, 7.5, FAINT)
  }
  doc.ensure(66)
  mkExtreme(ML, (CW - 10) / 2, '最高点', r.highest.elevation, r.highest.lon, r.highest.lat, C_RELIEF)
  mkExtreme(ML + (CW - 10) / 2 + 10, (CW - 10) / 2, '最低点', r.lowest.elevation, r.lowest.lon, r.lowest.lat, C_ELEV)
  doc.y -= 66
  doc.gap(10)

  const bins = r.elevationHistogram.filter((b) => b.ratio > 0.0005)
  if (bins.length) {
    doc.subtitle(`高程分带（共 ${bins.length} 带）`)
    doc.table(
      [150, 108, 108, 137],
      ['高程区间', '像元数', '面积占比', '累计占比'],
      (() => {
        let acc = 0
        return bins.map((b) => {
          acc += b.ratio
          return [
            b.label,
            fmtInt(b.count),
            `${fmtNumber(b.ratio * 100, 2)}%`,
            `${fmtNumber(acc * 100, 2)}%`,
          ]
        })
      })(),
      { align: ['left', 'right', 'right', 'right'] },
    )
  }

  /* ---------- 04 坡度分析 ---------- */
  doc.section('04', '坡度分析')
  doc.ensure(cardH + 8)
  doc.metric(ML, doc.y, cardW, cardH, '平均坡度', fmtNumber(r.slope.mean, 1), '\u00b0', C_SLOPE)
  doc.metric(ML + cardW + gapX, doc.y, cardW, cardH, '最大坡度', fmtNumber(r.slope.max, 1), '\u00b0', C_SLOPE)
  doc.metric(ML + (cardW + gapX) * 2, doc.y, cardW, cardH, '中位坡度', fmtNumber(r.slope.median, 1), '\u00b0', C_SLOPE)
  doc.metric(ML + (cardW + gapX) * 3, doc.y, cardW, cardH, '起伏度均值', fmtInt(r.localReliefMean), 'm', C_LAND)
  doc.y -= cardH + 12

  doc.subtitle('坡度分级构成')
  r.slopeClasses.forEach((c, i) => {
    doc.distRow(c.label, c.ratio, areaText(c.areaKm2), C_SLOPE, {
      noteW: 86,
      keepNext: i < r.slopeClasses.length - 1,
    })
  })
  doc.gap(6)

  const steep = r.slopeClasses[r.slopeClasses.length - 1]
  const flat = r.slopeClasses[0]
  const slNote: string[] = []
  if (steep && steep.ratio > 0.05) slNote.push(`${steep.label} 的陡坡占 ${fmtNumber(steep.ratio * 100, 1)}%`)
  if (flat && flat.ratio > 0.05) slNote.push(`${flat.label} 的平缓地占 ${fmtNumber(flat.ratio * 100, 1)}%`)
  if (slNote.length) doc.callout(`${slNote.join('，')}。坡度直接决定可建设性、水土保持难度与通行成本。`, C_SLOPE)

  doc.figure(ctx.images.slope || null, '图 2    坡度分级图 \u00b7 颜色由缓到陡，深色为陡坡集中区', 330)

  /* ---------- 05 坡向分析 ---------- */
  doc.section('05', '坡向分析')
  const aspBins = r.aspectHistogram.filter((b) => b.ratio > 0)
  const aspMax = aspBins.find((b) => b.dir !== '平坦' && b.ratio === Math.max(...aspBins.filter((x) => x.dir !== '平坦').map((x) => x.ratio)))
  if (aspBins.length) {
    doc.subtitle('八方位分布')
    aspBins.forEach((b, i) => {
      doc.distRow(b.dir, b.ratio, `${fmtInt(b.count)} 像元`, C_ASPECT, {
        labelW: 62,
        noteW: 78,
        keepNext: i < aspBins.length - 1,
      })
    })
    doc.gap(4)
    if (aspMax) {
      doc.callout(
        `主导坡向为 ${aspMax.dir}，占 ${fmtNumber(aspMax.ratio * 100, 1)}%。坡向影响日照时长、积雪消融与建筑朝向，是选址与生态评估的关键因子。`,
        C_ASPECT,
      )
    }
  } else {
    doc.para('该区域几乎无有效坡面，坡向不适用。', 9, MUT)
  }
  doc.figure(ctx.images.aspect || null, '图 3    坡向分布图 \u00b7 按八方位着色，浅色为平坦区', 330)

  /* ---------- 06 地形位置 ---------- */
  doc.section('06', '地形位置（TPI 分类）')
  const lf = r.landform
  const lfItems: [string, number, RGB][] = [
    ['山脊', lf.ridge, C_RELIEF],
    ['上坡', lf.upperSlope, C_SLOPE],
    ['中坡', lf.middleSlope, [0.85, 0.7, 0.11]],
    ['下坡', lf.lowerSlope, C_ELEV],
    ['山谷 / 洼地', lf.valley, BRAND],
    ['平地', lf.flat, [0.58, 0.64, 0.72]],
  ]
  lfItems.forEach(([name, val, color], i) => {
    doc.distRow(name, val, `${fmtInt(val * r.grid.cols * r.grid.rows)} 像元`, color, {
      noteW: 78,
      keepNext: i < lfItems.length - 1,
    })
  })
  doc.gap(6)
  const topLf = [...lfItems].sort((a, b) => b[1] - a[1])[0]
  doc.callout(
    `地形位置以 ${topLf[0]} 为主，约占 ${fmtNumber(topLf[1] * 100, 1)}%。TPI（地形位置指数）刻画像元相对邻域的凹凸关系，六类构成可直观反映坡面结构与沟谷发育程度。`,
    C_LAND,
  )

  /* ---------- 07 水文与汇流 ---------- */
  const hyd = r.hydrology
  if (hyd && r.flowAccGrid) {
    doc.section('07', '水文与汇流分析')
    doc.para(
      '按 D8 单流向模型逐像元求解水流方向（先填洼，再取坡度最陡的下坡方向），累积上游汇水面积后提取河网，并据汇水面积与坡度算出地形湿度指数 TWI。',
      9,
      MUT,
    )
    doc.gap(4)
    doc.ensure(cardH + 8)
    doc.metric(ML, doc.y, cardW, cardH, '河网密度', fmtNumber(hyd.drainageDensity, 2), 'km/km\u00b2', C_WATER)
    doc.metric(ML + (cardW + gapX), doc.y, cardW, cardH, '河网总长', fmtNumber(hyd.streamLengthKm, 1), 'km', C_WATER)
    doc.metric(ML + (cardW + gapX) * 2, doc.y, cardW, cardH, '最长主沟道', fmtNumber(hyd.longestChannelKm, 2), 'km', C_LAND)
    doc.metric(ML + (cardW + gapX) * 3, doc.y, cardW, cardH, '最大汇流累积', fmtNumber(hyd.maxAccKm2, 2), 'km\u00b2', C_LAND)
    doc.y -= cardH + 12

    doc.subtitle('湿度指数与河网构成')
    doc.distRow(
      '河网总长',
      hyd.maxAccKm2 > 0 ? Math.min(1, hyd.streamLengthKm / Math.max(0.001, r.areaKm2 * 3)) : 0,
      `${fmtInt(hyd.streamCells)} 像元`,
      C_WATER,
      { keepNext: true },
    )
    doc.distRow(
      '易积水区（TWI 前 20%）',
      isFinite(hyd.wetRatio) ? hyd.wetRatio : 0,
      `TWI ${fmtNumber(hyd.twiP80, 1)}`,
      C_WATER,
      { keepNext: true },
    )
    doc.distRow(
      '平均湿度指数',
      isFinite(hyd.twiMean) ? Math.max(0, Math.min(1, hyd.twiMean / 20)) : 0,
      fmtNumber(hyd.twiMean, 2),
      C_LAND,
      { keepNext: false },
    )
    doc.gap(4)
    doc.callout(
      `河网提取阈值为汇水面积 ${fmtNumber(hyd.thresholdKm2, 2)} km²（选区面积的 1%，夹在 0.02~8 km²）。` +
        `河网密度 ${fmtNumber(hyd.drainageDensity, 2)} km/km²，是判断地表切割程度的常用指标：大于 2 属沟谷密集，1 上下为一般山地，小于 0.5 多为平缓高原或平原。` +
        `平均 TWI ${fmtNumber(hyd.twiMean, 2)}，易积水区占 ${fmtNumber(hyd.wetRatio * 100, 1)}%。`,
      C_WATER,
    )
    doc.gap(4)
    doc.para(
      '注意：汇流仅在所选区域内计算（区域外的 DEM 未取数），边界处的汇水面积偏小。分析完整流域时建议把分水岭以内的范围一并选入。',
      8.5,
      MUT,
      { lh: 13 },
    )
    doc.gap(8)
  }

  /* ---------- 08 曲率 ---------- */
  const cur = r.curvature
  if (cur && r.curvGrid) {
    doc.section('08', '曲率与坡面形态')
    doc.para(
      '曲率由 3×3 窗口的二阶导数求解（Zevenbergen & Thorne）。平面曲率说明水流在坡面上是发散还是汇聚，剖面曲率说明沿坡向下是加速还是减速；单位统一取 1/100m。',
      9,
      MUT,
    )
    doc.gap(4)
    doc.ensure(cardH + 8)
    doc.metric(ML, doc.y, cardW, cardH, '平均平面曲率', fmtNumber(cur.planMean, 2), '', C_ASPECT)
    doc.metric(ML + (cardW + gapX), doc.y, cardW, cardH, '平均剖面曲率', fmtNumber(cur.profileMean, 2), '', C_SLOPE)
    doc.metric(ML + (cardW + gapX) * 2, doc.y, cardW, cardH, '凸坡占比', fmtNumber(cur.convexRatio * 100, 1), '%', C_RELIEF)
    doc.metric(ML + (cardW + gapX) * 3, doc.y, cardW, cardH, '凹坡占比', fmtNumber(cur.concaveRatio * 100, 1), '%', C_WATER)
    doc.y -= cardH + 12

    doc.subtitle('坡面形态构成')
    doc.distRow('凸坡（发散）', cur.convexRatio, fmtNumber(cur.convexRatio * 100, 1) + '%', C_RELIEF, { keepNext: true })
    doc.distRow('近线性', cur.linearRatio, fmtNumber(cur.linearRatio * 100, 1) + '%', [0.6, 0.63, 0.66], { keepNext: true })
    doc.distRow('凹坡（汇聚）', cur.concaveRatio, fmtNumber(cur.concaveRatio * 100, 1) + '%', C_WATER, { keepNext: false })
    doc.gap(4)
    doc.callout(
      `平均绝对曲率 ${fmtNumber(cur.meanAbs, 2)}（1/100m），凹坡占 ${fmtNumber(cur.concaveRatio * 100, 1)}%、凸坡占 ${fmtNumber(cur.convexRatio * 100, 1)}%。` +
        `凹坡占比明显偏高说明坡面以汇水型为主，降雨会较快向沟谷集中，是水土流失风险评估的关键判据。`,
      C_ASPECT,
    )
    doc.gap(10)
  }

  /* ---------- 09 高程剖面 ---------- */
  if (ctx.images.profile) {
    doc.section('09', '高程剖面')
    doc.para('剖面沿用户在地图上绘制的测线采样，反映沿线地形的起伏节律与陡缓变化。', 9, MUT)
    doc.gap(2)
    doc.figure(ctx.images.profile, '图 4    高程剖面曲线 \u00b7 横轴为沿线距离，纵轴为海拔', 260)
  }

  /* ---------- 10 数据与方法 ---------- */
  doc.section(ctx.images.profile ? '10' : '09', '数据与方法说明')
  const notes = [
    `高程数据源：${r.demSource || 'DEM 瓦片'}，采样网格 ${r.resolutionM} m（${r.grid.cols} \u00d7 ${r.grid.rows} 个像元）。`,
    '坡度、坡向由 3\u00d73 窗口的 Horn 算法求解；地形粗糙度 TRI 取像元与 8 邻域的平均高差；平均起伏度取 3\u00d73 窗口内最大最小高差；地形位置 TPI 采用 Weiss（2001）六分类阈值。',
    '水文分析采用 D8 单流向模型：先以 Planchon & Darboux 迭代法填洼，再按最陡下降方向定流向，最后按高程降序累积汇水面积；河网阈值为选区面积的 1%，TWI = ln(比汇水面积 / tan 坡度)。',
    '曲率按 Zevenbergen & Thorne（1987）的 3\u00d73 二阶导数求解，单位 1/100m；|平面曲率| ≤ 0.1 计为近线性。',
    '所有指标基于规则网格重采样后的统计值，属区域整体刻画；局部微地形与人工构筑物不在本报告的解析范围内。',
    '坐标系：分析内部统一使用 WGS84；若界面底图为高德系列，地图显示已做 GCJ-02 纠偏，不影响统计结果。',
    `分析区域中心约在 ${ctx.where}，分析面积约 ${areaText(r.areaKm2)}。`,
  ]
  const nLh = 12.5
  for (const n of notes) {
    doc.ensure(24)
    doc.y -= 13
    // 项目符号要与首行文字对齐：para 内部是先 y -= lh 再画基线，所以符号取「首行基线 + 2」
    doc.rect(ML + 2, doc.y - nLh + 2, 4, 4, LINE)
    doc.para(n, 8.5, MUT, { indent: 14, lh: nLh, width: CW - 14 })
  }

  doc.gap(16)
  doc.hline(ML, ML + CW, doc.y, LINE_S, 0.7)
  doc.gap(15)
  doc.txt('报告结束', ML, doc.y, 9, FAINT, true)
  doc.txtRight(`${ctx.rid}  \u00b7  ${ctx.stamp}`, ML + CW, doc.y, 8, MUT)

  doc.newPage()
}

/* ================================================================== */
/* 页眉页脚（封面不加）                                                */
/* ================================================================== */

function decorate(pages: string[], ctx: Ctx): string[] {
  const n = pages.length
  for (let i = 1; i < n; i++) {
    const tmp = new Doc()
    tmp.ops = []
    tmp.txt(`地形分析报告  \u00b7  ${ctx.projectName || ctx.where}`, ML, PH - 34, 8, MUT)
    tmp.txtRight(`第 ${i + 1} / ${n} 页`, PW - MR, PH - 34, 8, MUT)
    tmp.hline(ML, PW - MR, PH - 41, LINE, 0.6)
    const h = tmp.ops.join('\n')

    const f = new Doc()
    f.ops = []
    f.txt(`${ctx.rid}  \u00b7  \u00a9 ${SITE_OWNER}`, ML, MB - 24, 8, MUT)
    f.txtRight(ctx.stamp, PW - MR, MB - 24, 8, MUT)
    f.hline(ML, PW - MR, MB - 13, LINE, 0.6)
    f.ops.push(`${BRAND.join(' ')} rg ${ML} ${MB - 13} m ${ML + 30} ${MB - 13} l S`)
    const foot = f.ops.join('\n')

    pages[i] = h + '\n' + pages[i] + '\n' + foot
  }
  return pages
}

/* ================================================================== */
/* PDF 对象组装                                                        */
/* ================================================================== */

const CHUNK = 8192

/** 二进制 → 字符串（latin-1 逐字节映射，分块避免大图卡顿） */
function bytesToStr(u8: Uint8Array): string {
  let out = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    out += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, Math.min(i + CHUNK, u8.length))) as unknown as number[],
    )
  }
  return out
}

function assemble(pagesOps: string[], images: ImgRef[]): Uint8Array {
  const n = pagesOps.length
  // 1 Catalog / 2 Pages / 3 F1(中文) / 4 F1 描述符 / 5 F2(Helvetica) / 6.. 图片 / 之后每页 Page+Contents
  const FONT = 3
  const DESC = 4
  const HFONT = 5
  const imgIds: number[] = []
  let next = 6
  for (let i = 0; i < images.length; i++) imgIds.push(next++)
  const PAGE0 = next

  const objs: Record<number, string> = {}
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids: string[] = []
  for (let p = 0; p < n; p++) kids.push(`${PAGE0 + p * 2} 0 R`)
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
  objs[FONT] =
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ' +
    '/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> ' +
    `/FontDescriptor ${DESC} 0 R >>] >>`
  objs[DESC] =
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 ' +
    '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 ' +
    '/CapHeight 880 /StemV 58 >>'
  // 显式声明 /Widths：阅读器必须按这些宽度排版，与 chW() 完全一致
  objs[HFONT] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ' +
    `/FirstChar 32 /LastChar 255 /Widths [${FULL_W.join(' ')}] >>`

  images.forEach((img, i) => {
    objs[imgIds[i]] =
      `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${img.bytes.length} >>\nstream\n${bytesToStr(img.bytes)}\nendstream`
  })

  let res = `/Resources << /Font << /F1 ${FONT} 0 R /F2 ${HFONT} 0 R >>`
  if (images.length) {
    res += ' /XObject << ' + images.map((img, i) => `/${img.name} ${imgIds[i]} 0 R`).join(' ') + ' >>'
  }
  res += ' >>'

  for (let p = 0; p < n; p++) {
    const pageId = PAGE0 + p * 2
    const contId = pageId + 1
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] ${res} /Contents ${contId} 0 R >>`
    const stream = pagesOps[p]
    objs[contId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }

  const head = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: Record<number, number> = {}
  let body = ''
  const total = PAGE0 + n * 2 - 1
  for (let id = 1; id <= total; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objs[id]}\nendobj\n`
  }
  const headLen = head.length
  const xrefPos = headLen + body.length
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= total; id++) {
    const s = String(headLen + offsets[id]).padStart(10, '0')
    xref += `${s} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`

  // 全程按 latin-1 处理 → body.length 等于字节数，可直接当 xref 偏移
  const bin = head + body + xref + trailer
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff
  return bytes
}

/* ================================================================== */
/* 图片预处理：dataURL → JPEG 字节（顺便垫白底、限宽）                  */
/* ================================================================== */

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function prepJpeg(dataUrl: string | undefined, maxW = 1440): Promise<Omit<ImgRef, 'name'> | null> {
  if (!dataUrl) return null
  const img = await loadImage(dataUrl)
  if (!img || !img.naturalWidth) return null
  const sc = Math.min(1, maxW / img.naturalWidth)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * sc))
  c.height = Math.max(1, Math.round(img.naturalHeight * sc))
  const g = c.getContext('2d')
  if (!g) return null
  // 透明 PNG 直接转 JPEG 会变黑，先垫白底
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(img, 0, 0, c.width, c.height)
  const url = c.toDataURL('image/jpeg', 0.88)
  const b64 = url.slice(url.indexOf(',') + 1)
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return { bytes, w: c.width, h: c.height }
}

/* ================================================================== */
/* 入口                                                                */
/* ================================================================== */

/**
 * 纯渲染：给定分析数据与已编码好的图片字节，产出完整 PDF 字节流。
 * 不触碰 DOM（图片字节由调用方准备），因此可在 Node 里直接跑结构校验。
 */
export function renderTerrainReportPDF(
  result: TerrainAnalysisResult,
  desc: TerrainDescription,
  images: Record<string, ReportImage> = {},
  meta: ReportMeta = {},
): Uint8Array {
  const g = result.grid
  const centerLon = (g.minLon + g.maxLon) / 2
  const centerLat = (g.minLat + g.maxLat) / 2
  const d = new Date()

  const ctx: Ctx = {
    r: result,
    desc,
    images,
    stamp: stampNow(d),
    rid:
      'TR-' +
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '-' +
      Math.floor(Math.random() * 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0'),
    centerLon,
    centerLat,
    where: fmtCoord(centerLon, centerLat),
    projectName: meta.projectName || '',
  }

  const doc = new Doc()
  buildCover(doc, ctx)
  buildBody(doc, ctx)
  return assemble(decorate(doc.pages, ctx), Object.values(images))
}

export async function exportReportPDF(
  result: TerrainAnalysisResult,
  desc: TerrainDescription,
  assets: ReportAssets,
  meta: ReportMeta = {},
) {
  // 四张图并行准备；任何一张失败都只是少一张插图，不影响出报告
  const [main, slope, aspect, profile] = await Promise.all([
    prepJpeg(assets.mapDataUrl, 1600),
    prepJpeg(assets.slopeMapDataUrl, 1400),
    prepJpeg(assets.aspectMapDataUrl, 1400),
    prepJpeg(assets.profileDataUrl, 1600),
  ])

  const images: Record<string, ReportImage> = {}
  if (main) images.main = { name: 'Im1', ...main }
  if (slope) images.slope = { name: 'Im2', ...slope }
  if (aspect) images.aspect = { name: 'Im3', ...aspect }
  if (profile) images.profile = { name: 'Im4', ...profile }

  const bytes = renderTerrainReportPDF(result, desc, images, meta)

  const d = new Date()
  // Uint8Array<ArrayBufferLike> 不能直接当 BlobPart，切出真实的 ArrayBuffer 再交给 Blob
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = new Blob([ab], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // 文件名由调用方给定（「项目名-时间」，与 PNG 同一套 base）；
  // 没给就退回旧的时间戳命名，保证单独调用也不会产出无名文件。
  a.download =
    meta.fileName ||
    `terrain-report-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.pdf`
  if (!/\.pdf$/i.test(a.download)) a.download += '.pdf'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}
