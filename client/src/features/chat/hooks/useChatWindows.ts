import { useEffect, useRef, useState } from 'react'
import type { ChatWindowInfo, ChatWindowStatus } from '../../../../shared/chat-windows'
import { closeChatWindows, listChatWindows, onChatWindowsChanged } from '../api'

/**
 * The main window's view of the consultations other windows show
 * (「別ウィンドウで開く」): their statuses for the list, keyed by conversation
 * id, and `onReturned` when one of this company's windows closes (its
 * consultation comes back here). The windows close when this company's
 * chat goes (company switch, sign-out, another account).
 */
export function useChatWindows(companyId: string, onReturned: (sessionId: string) => void): ReadonlyMap<string, ChatWindowStatus> {
  const [windows, setWindows] = useState<ReadonlyMap<string, ChatWindowStatus>>(() => new Map())
  const onReturnedRef = useRef(onReturned)
  onReturnedRef.current = onReturned

  useEffect(() => {
    let alive = true
    const apply = (list: ChatWindowInfo[]) => {
      if (alive) setWindows(new Map(list.filter(w => w.companyId === companyId).map(w => [w.sessionId, w.status])))
    }
    void listChatWindows().then(list => apply(list ?? [])).catch(() => {})
    const unsubscribe = onChatWindowsChanged(change => {
      apply(change.windows)
      if (change.closed?.companyId === companyId) onReturnedRef.current(change.closed.sessionId)
    })
    return () => { alive = false; unsubscribe() }
  }, [companyId])

  useEffect(() => () => { void closeChatWindows().catch(() => {}) }, [])

  return windows
}
