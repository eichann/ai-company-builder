import { useCallback, useState } from 'react'
import type { ConversationGroupKey } from '../consultationStatus'
import { COLLAPSED_GROUPS_KEY_PREFIX, canCollapse, parseCollapsedGroups } from '../conversationGroups'

function read(companyId: string): ReadonlySet<ConversationGroupKey> {
  try { return parseCollapsedGroups(localStorage.getItem(COLLAPSED_GROUPS_KEY_PREFIX + companyId)) } catch { return new Set() }
}

/** The groups of the 「AIへの相談」 list this member folded in this company (this PC only). */
export function useCollapsedGroups(companyId: string) {
  const [collapsed, setCollapsed] = useState(() => read(companyId))
  // Another company reads its own (adjusted while rendering).
  const [readFor, setReadFor] = useState(companyId)
  if (readFor !== companyId) {
    setReadFor(companyId)
    setCollapsed(read(companyId))
  }
  const toggle = useCallback((key: ConversationGroupKey) => {
    if (!canCollapse(key)) return
    setCollapsed(previous => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      try { localStorage.setItem(COLLAPSED_GROUPS_KEY_PREFIX + companyId, JSON.stringify([...next])) } catch { /* kept for this session only */ }
      return next
    })
  }, [companyId])
  return { collapsed, toggle }
}
