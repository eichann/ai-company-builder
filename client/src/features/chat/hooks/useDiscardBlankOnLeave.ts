import { useEffect, useRef } from 'react'
import { deleteChatSession, getChatSessionSummaries } from '../api'
import { discardWhenLeft, isBlankWhenLeft, type LeftConversation } from '../model'

export interface DiscardBlankOptions {
  isActive: boolean
  companyId: string | undefined
  /** This conversation's id in the history store. */
  sessionId: string | null
  /** The tab's live state, read when the member leaves it. */
  readLeft: () => LeftConversation
  /** Closes this conversation's tab (the panel keeps at least one tab). */
  close: () => void
}

/**
 * A conversation the member opened and left for another without typing
 * anything goes away like a closed empty one: its tab closes and its stored
 * copy, if any, is deleted. Only a switch to another conversation makes a
 * mounted tab inactive (quitting, other panels and company switches unmount
 * or leave it active), so this runs exactly on that. Called after
 * useChatHistory: its synchronous save on leaving lands before the check.
 */
export function useDiscardBlankOnLeave({ isActive, companyId, sessionId, readLeft, close }: DiscardBlankOptions) {
  const activeRef = useRef(isActive)
  const wasActiveRef = useRef(isActive)
  const latest = useRef({ companyId, sessionId, readLeft, close })
  latest.current = { companyId, sessionId, readLeft, close }
  activeRef.current = isActive

  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = isActive
    if (isActive || !wasActive) return
    const { companyId, sessionId, readLeft } = latest.current
    if (!companyId || !isBlankWhenLeft(readLeft())) return
    let alive = true
    // Renamed or pinned is known only to the store; a failure keeps the conversation.
    void getChatSessionSummaries(companyId).then(summaries => {
      const stored = summaries.find(summary => summary.id === sessionId)
      // The member may have come back or started typing meanwhile.
      if (!alive || activeRef.current || !discardWhenLeft(latest.current.readLeft(), stored)) return
      latest.current.close()
      if (stored) void deleteChatSession(companyId, stored.id).catch(() => {})
    }).catch(() => {})
    return () => { alive = false }
  }, [isActive])
}
