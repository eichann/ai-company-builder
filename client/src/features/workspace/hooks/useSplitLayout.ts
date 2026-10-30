import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PANE_LIMITS, dragPane, paneSize, parseLayout, resizedBy, serializeLayout, withPaneSize,
  type SplitNode, type WorkspaceLayout,
} from '../layoutTree'

// Per company in localStorage `layout:<company id>` (layoutTree.ts holds the shape).
const LAYOUT_KEY_PREFIX = 'layout:'

function readLayout(companyId: string | undefined): WorkspaceLayout {
  if (!companyId) return parseLayout(null)
  try {
    return parseLayout(localStorage.getItem(`${LAYOUT_KEY_PREFIX}${companyId}`))
  } catch {
    return parseLayout(null)
  }
}

// Drags reach the top split of each tree; nested splits come with the multi-pane chat.
function topSplit(layout: WorkspaceLayout, splitId: string): SplitNode | null {
  return splitId === 'screen' || splitId === 'files' ? layout[splitId] : null
}

/**
 * The split tree of the open company: its pane sizes (saved per company as
 * they change), divider drags, and which pane is hidden (not saved: the chat
 * shows again at the next start).
 */
export function useSplitLayout(companyId: string | undefined) {
  const [state, setState] = useState(() => ({ companyId, layout: readLayout(companyId), loaded: true }))
  if (state.companyId !== companyId) setState({ companyId, layout: readLayout(companyId), loaded: true })
  const layout = state.layout
  const layoutRef = useRef(layout)
  useEffect(() => { layoutRef.current = layout }, [layout])

  // Only a change by the member is written: opening a company leaves its entry as it was.
  useEffect(() => {
    if (!state.companyId || state.loaded) return
    try {
      localStorage.setItem(`${LAYOUT_KEY_PREFIX}${state.companyId}`, serializeLayout(state.layout))
    } catch {
      // Storage may be unavailable; the layout still works for this session.
    }
  }, [state])

  const [collapsed, setCollapsed] = useState<string | null>(null)
  const toggleCollapsed = useCallback((paneId: string) => {
    setCollapsed(current => (current === paneId ? null : paneId))
  }, [])

  // Each drag snapshots the pane's size at pointerdown and derives the size
  // from the pointer's total offset (panelResize.ts).
  const dragStartRef = useRef(0)
  const startResize = useCallback((splitId: string, dividerIndex: number) => {
    const split = topSplit(layoutRef.current, splitId)
    if (!split) return
    const target = resizedBy(split, dividerIndex)
    dragStartRef.current = target ? (paneSize(split, target.paneId) ?? 0) : 0
  }, [])
  const resize = useCallback((splitId: string, dividerIndex: number, offset: number) => {
    const split = topSplit(layoutRef.current, splitId)
    const target = split && resizedBy(split, dividerIndex)
    if (!split || !target) return
    const { size, collapseSibling } = dragPane(dragStartRef.current, target.sign * offset, PANE_LIMITS[target.paneId] ?? {}, window.innerWidth)
    const next = withPaneSize(split, target.paneId, size)
    if (next !== split) {
      layoutRef.current = { ...layoutRef.current, [splitId]: next }
      setState(s => ({ ...s, layout: { ...s.layout, [splitId]: next }, loaded: false }))
    }
    if (collapseSibling) {
      // The divider unmounts with the hidden pane, which ends this drag.
      const sibling = split.children.find(child => child.id !== target.paneId && paneSize(split, child.id) == null)
      if (sibling) setCollapsed(sibling.id)
    }
  }, [])

  return { layout, collapsed, toggleCollapsed, startResize, resize }
}
