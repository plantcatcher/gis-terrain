export function fmtNumber(n: number, digits = 1): string {
  if (!isFinite(n)) return '--'
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtInt(n: number): string {
  if (!isFinite(n)) return '--'
  return Math.round(n).toLocaleString('zh-CN')
}

export function fmtArea(km2: number): string {
  if (km2 < 1) return `${fmtNumber(km2 * 1_000_000, 0)} m²`
  return `${fmtNumber(km2, 2)} km²`
}

export function fmtElev(m: number): string {
  return `${fmtInt(m)} m`
}

export function fmtSlope(deg: number): string {
  return `${fmtNumber(deg, 1)}°`
}

export function fmtDist(km: number): string {
  if (km < 1) return `${fmtNumber(km * 1000, 0)} m`
  return `${fmtNumber(km, 2)} km`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 导出文件名的时间戳 `20261002-2338`。
 * 精确到分钟：同一分钟内重复导出会撞名（浏览器自动加 `(1)`），
 * 这在"改一个图层再导一次"的对比场景里其实很有用 —— 一眼能看出是同一批。
 */
export function exportStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  )
}

/**
 * 文件名安全化。
 * Windows 下 `\ / : * ? " < > |` 以及首尾的点和空格非法，跨平台还会
 * 因为换行/控制字符直接失败 —— 项目名是用户随手改的，必须过一遍。
 */
export function safeFileName(name: string, fallback = '地形分析'): string {
  const cleaned = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
  return cleaned || fallback
}
