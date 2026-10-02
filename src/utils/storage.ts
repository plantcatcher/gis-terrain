import type { HistoryItem } from '../types'

/**
 * 项目持久化 —— 用 IndexedDB 存整份分析结果。
 *
 * 为什么不用 localStorage：
 *  - **配额**。localStorage 只有 ~5MB。一份结果的 `grid.elevations` 是
 *    Float32Array，采样网格越大越夸张（1800×1800 就是 13MB），外加
 *    slopeGrid / hillshade / aspectGrid 各占一份，单个项目轻松越界。
 *  - **膨胀**。localStorage 只能存字符串，TypedArray 转 JSON 会膨胀 5~10 倍。
 *  - **阻塞**。它是同步 API，主线程写几 MB 会直接掉帧。
 *  IndexedDB 走结构化克隆，TypedArray 原样落盘，且全程异步。
 *
 * 存储策略：**增量写**。只有指纹变化的项目才会重新 put —— 重命名一个项目
 * 不该把另外九个项目的几 MB 网格重新序列化一遍。
 */

const DB_NAME = 'terrain-analyzer'
const DB_VERSION = 1
const STORE = 'projects'

/**
 * 保留的项目数上限。每个项目含多张与网格同尺寸的栅格，没有上限的话
 * 浏览器存储会一路涨到配额告警；超出时淘汰最旧的。
 */
export const MAX_PROJECTS = 20

/** id -> 指纹，用于跳过未变化的项目；load 时填充，避免水合后立刻整个回写 */
const savedFingerprints = new Map<string, string>()

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
  })
}

/**
 * 内容指纹：覆盖所有会变化的字段。
 * `result` 一旦算完就不再变，所以不必参与 —— 否则每次对比都要遍历网格。
 * 选区被拖动时首点与中点会变，因此也纳入指纹。
 */
function fingerprint(it: HistoryItem): string {
  const ring = it.feature?.geometry?.coordinates?.[0] ?? []
  const p0 = ring[0] ?? []
  const pm = ring[Math.floor(ring.length / 2)] ?? ring[ring.length - 1] ?? []
  return [
    it.id,
    it.name,
    it.timestamp,
    it.areaKm2,
    `${p0[0]},${p0[1]}`,
    `${pm[0]},${pm[1]}`,
  ].join('|')
}

/** 结构完整性校验：历史版本或写入中断都可能留下残缺记录 */
function isUsable(it: unknown): it is HistoryItem {
  const o = it as HistoryItem | null
  return (
    !!o &&
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.timestamp === 'number' &&
    typeof o.areaKm2 === 'number' &&
    !!o.feature?.geometry &&
    !!o.result?.grid?.elevations &&
    typeof o.result.grid.cols === 'number'
  )
}

/** 读取全部项目，按时间倒序（最新在前，与内存态顺序一致） */
export async function loadProjects(): Promise<HistoryItem[]> {
  let db: IDBDatabase | undefined
  try {
    db = await openDB()
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result as unknown[])
      req.onerror = () => reject(req.error)
    })
    const items = rows.filter(isUsable)
    const dropped = rows.length - items.length
    if (dropped > 0) console.warn(`[storage] 丢弃 ${dropped} 条残缺的项目记录`)
    // 记住指纹，避免水合完成后立刻把刚读出来的数据原样写回一遍
    savedFingerprints.clear()
    for (const it of items) savedFingerprints.set(it.id, fingerprint(it))
    return items.sort((a, b) => b.timestamp - a.timestamp)
  } catch (e) {
    console.warn('[storage] 读取项目失败，按空列表处理', e)
    return []
  } finally {
    db?.close()
  }
}

/**
 * 写入项目列表（增量）。
 *
 * 注意调用方要在**水合完成之后**才调用 —— 否则首次渲染的空数组会把
 * 已存的项目整个抹掉。App 里用 hydratedRef 把关。
 */
export async function saveProjects(items: HistoryItem[]): Promise<void> {
  const keep = items.slice(0, MAX_PROJECTS)
  const nextIds = new Set(keep.map((it) => it.id))

  let db: IDBDatabase | undefined
  try {
    db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)

      // 先删已移除 / 被上限淘汰的
      for (const id of savedFingerprints.keys()) {
        if (!nextIds.has(id)) store.delete(id)
      }
      // 只写变化的
      let written = 0
      for (const it of keep) {
        const fp = fingerprint(it)
        if (savedFingerprints.get(it.id) === fp) continue
        store.put(it)
        savedFingerprints.set(it.id, fp)
        written++
      }

      tx.oncomplete = () => {
        if (written > 0) console.info(`[storage] 已保存 ${written} 个项目`)
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch (e) {
    // 配额超限是这里最主要的失败原因。不清指纹：下次写入会重试同一批，
    // 若清掉指纹反而会把「已成功写过的」也标记成待写，情况更糟。
    console.warn('[storage] 保存项目失败（可能是存储配额不足）', e)
  } finally {
    db?.close()
  }
}
