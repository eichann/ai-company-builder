import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import {
  DEFAULT_LAYOUT, dragPane, fitLayout, layoutAfterResize, paneRange, paneSize, parseLayout, resizedBy, serializeLayout, sizeText,
  type PaneView, type SplitId, type SplitNode, type WorkspaceLayout,
} from '../layoutTree'

// Per company in localStorage `layout:<company id>` (layoutTree.ts holds the shape and every size rule).
const LAYOUT_KEY_PREFIX = 'layout:'

const windowWidth = () => (typeof window === 'undefined' ? 0 : window.innerWidth)
const windowHeight = () => (typeof window === 'undefined' ? 0 : window.innerHeight)

function readLayout(companyId: string | undefined): WorkspaceLayout {
  if (!companyId) return parseLayout(null)
  try {
    return parseLayout(localStorage.getItem(`${LAYOUT_KEY_PREFIX}${companyId}`), windowWidth())
  } catch {
    return parseLayout(null)
  }
}

/** The pane a divider resizes in what is drawn, and how far it may go now. */
function dividerTarget(drawn: WorkspaceLayout, view: PaneView, width: number, middleHeight: number, splitId: string, dividerIndex: number) {
  const split = topSplit(drawn, splitId)
  const by = split && resizedBy(split, dividerIndex)
  if (!split || !by) return null
  return { ...by, size: paneSize(split, by.paneId) ?? 0, range: paneRange(by.paneId, drawn, width, view, middleHeight) }
}

const isSplitId = (splitId: string): splitId is SplitId => splitId === 'screen' || splitId === 'files' || splitId === 'middle'

// Drags reach the top split of each tree; nested splits come with the multi-pane chat.
function topSplit(layout: WorkspaceLayout, splitId: string): SplitNode | null {
  return isSplitId(splitId) ? layout[splitId] : null
}

/** What a divider shows and accepts: the size of the pane it resizes, its range now, and that size in words. */
export interface DividerState { value: number; min: number; max: number; text: string }

/**
 * The split tree of the open company: the sizes the member chose (saved per company as they
 * change), the sizes drawn in this window for the panes on screen (`shown`, fitted by
 * layoutTree.ts), divider drags and keys. `onCollapse`: the consultation was dragged well under
 * its minimum (the screen hides it).
 */
export function useSplitLayout(companyId: string | undefined, view: PaneView, onCollapse: (paneId: string) => void) {
  const [state, setState] = useState(() => ({ companyId, layout: readLayout(companyId), loaded: true }))
  if (state.companyId !== companyId) setState({ companyId, layout: readLayout(companyId), loaded: true })

  // Only a change by the member is written: opening a company leaves its entry as it was.
  useEffect(() => {
    if (!state.companyId || state.loaded) return
    try {
      localStorage.setItem(`${LAYOUT_KEY_PREFIX}${state.companyId}`, serializeLayout(state.layout))
    } catch {
      // Storage may be unavailable; the layout still works for this session.
    }
  }, [state])

  const [width, setWidth] = useState(windowWidth)
  useEventListener(typeof window === 'undefined' ? null : window, 'resize', () => setWidth(windowWidth()))

  // The middle's height (tabs + bottom panel), measured: what the bottom panel may take depends on it.
  // A hidden middle (a wide left tab) measures 0 and keeps the last height.
  const [middleHeight, setMiddleHeight] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const middleRef = useCallback((element: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => { const h = element.getBoundingClientRect().height; if (h > 0) setMiddleHeight(Math.round(h)) }
    observerRef.current = new ResizeObserver(measure)
    observerRef.current.observe(element)
    measure()
  }, [])

  const shown = useMemo(() => fitLayout(state.layout, width, view, middleHeight), [state.layout, width, view, middleHeight])
  const latest = useLatestRef({ shown, view, middleHeight })
  const onCollapseRef = useLatestRef(onCollapse)

  // The other panes keep the size they are drawn at (layoutTree.ts `layoutAfterResize`).
  const setSize = useCallback((splitId: string, paneId: string, size: number) => {
    if (!isSplitId(splitId)) return
    const drawn = latest.current.shown
    setState(s => {
      const next = layoutAfterResize(s.layout, drawn, splitId, paneId, size)
      return next === s.layout ? s : { ...s, layout: next, loaded: false }
    })
  }, [latest])

  const target = useCallback((splitId: string, dividerIndex: number) =>
    dividerTarget(latest.current.shown, latest.current.view, windowWidth(), latest.current.middleHeight, splitId, dividerIndex), [latest])

  // Each drag snapshots the drawn size at pointerdown and derives the size from the pointer's
  // total offset (panelResize.ts); dragging the consultation well under its minimum hides it.
  const dragStartRef = useRef(0)
  const startResize = useCallback((splitId: string, dividerIndex: number) => {
    dragStartRef.current = target(splitId, dividerIndex)?.size ?? 0
  }, [target])
  const resize = useCallback((splitId: string, dividerIndex: number, offset: number) => {
    const t = target(splitId, dividerIndex)
    if (!t) return
    const { size, collapse } = dragPane(t.paneId, dragStartRef.current, t.sign * offset, t.range)
    setSize(splitId, t.paneId, size)
    // The divider unmounts with the hidden pane, which ends this drag.
    if (collapse) onCollapseRef.current(t.paneId)
  }, [target, setSize, onCollapseRef])

  /** The divider moved by keys: `delta` px along the window (never hides a pane). */
  const nudge = useCallback((splitId: string, dividerIndex: number, delta: number) => {
    const t = target(splitId, dividerIndex)
    if (!t) return
    setSize(splitId, t.paneId, Math.max(t.range.min, Math.min(t.range.max, t.size + t.sign * delta)))
  }, [target, setSize])

  /** A double-clicked divider: the pane it resizes back to its first size. */
  const resetDivider = useCallback((splitId: string, dividerIndex: number) => {
    const t = target(splitId, dividerIndex)
    const first = t && topSplit(DEFAULT_LAYOUT, splitId) && paneSize(topSplit(DEFAULT_LAYOUT, splitId)!, t.paneId)
    if (t && first != null) setSize(splitId, t.paneId, first)
  }, [target, setSize])

  /** 「いつもの形に戻す」: the first sizes (the screen shows every pane again). */
  const resetSizes = useCallback(() => {
    setState(s => ({ ...s, layout: DEFAULT_LAYOUT, loaded: false }))
  }, [])

  const divider = useCallback((splitId: string, dividerIndex: number): DividerState | null => {
    const t = dividerTarget(shown, view, width, middleHeight, splitId, dividerIndex)
    const text = splitId === 'middle' ? sizeText(t?.size ?? 0, windowHeight(), 'height') : sizeText(t?.size ?? 0, width)
    return t && { value: t.size, min: t.range.min, max: t.range.max, text }
  }, [shown, view, width, middleHeight])

  return { shown, middleRef, startResize, resize, nudge, resetDivider, resetSizes, divider }
}
