import { useEffect } from 'react'
import { IDLE_WINDOW_STATUS, type ChatWindowStatus } from '../../../../shared/chat-windows'
import { reportChatWindowStatus } from '../api'

/** Tells the main window's list how this window's consultation stands (あなたの番, 作業中, …). */
export function useReportWindowStatus(status: ChatWindowStatus | undefined): void {
  const { state, kind, line } = status ?? IDLE_WINDOW_STATUS
  useEffect(() => {
    void reportChatWindowStatus({ state, ...(kind ? { kind } : {}), line }).catch(() => {})
  }, [state, kind, line])
}
