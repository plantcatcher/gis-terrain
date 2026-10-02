import { useEffect, useState } from 'react'

/**
 * 主指针是否为"粗指针"（触摸）。
 *
 * 用 `pointer: coarse` 而不是 UA 嗅探：接了鼠标的触屏笔记本 primary pointer 是
 * fine，会走桌面逻辑；而手机上无论什么浏览器都是 coarse。
 * 比 `'ontouchstart' in window` 准确得多（后者在带触摸屏的 Win 笔记本上也是 true）。
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false
  const mq = window.matchMedia?.('(pointer: coarse)')
  if (mq) return mq.matches
  return (navigator.maxTouchPoints ?? 0) > 0
}

/** 响应式媒体查询 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * 是否走移动端布局。
 *
 * 规则 = 窄屏 **或**（触屏 且 未到大屏）。第二个条件是为了处理"手机横屏"：
 * iPhone 横过来有 900+ px，纯按宽度判会掉回桌面布局 —— 而桌面布局依赖
 * 悬停/双击，触屏上根本用不了。
 *
 * ⚠️ 这个查询必须和 index.css 里那段 `@media` 的条件**逐字一致**，
 * 否则 JS 判定为移动端、CSS 却按桌面渲染，会出现状态与样式打架。
 */
export const MOBILE_MEDIA_QUERY = '(max-width: 820px), (pointer: coarse) and (max-width: 1100px)'

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY)
}

/** 表格/键盘设备：触屏上的双击、悬停等交互都不可靠 */
export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)')
}

/**
 * 还剩几根手指按在屏幕上。
 *
 * ⚠️ 必须看原始事件，不能用 `MapTouchEvent.points`。
 * MapLibre 4.7.1 的构造函数是这样取点的：
 *     const touches = type === 'touchend' ? e.changedTouches : e.touches
 * 也就是说 touchend 时 `points` 取的是**抬起的那几根手指**，长度通常还是 1。
 * 用 `points.length > 0` 判断"手指还没抬完"会永远成立 —— 于是
 * touchstart 起了个矩形，touchend 直接 return，选区永远画不出来。
 */
export function remainingTouches(e: { originalEvent?: unknown }): number {
  const oe = e.originalEvent as TouchEvent | undefined
  return oe?.touches?.length ?? 0
}
