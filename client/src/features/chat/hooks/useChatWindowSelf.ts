import { useEffect, useState } from 'react'
import type { ChatWindowContext } from '../../../../shared/chat-windows'
import { getChatSession, getChatWindowContext, onChatHistoryChanged } from '../api'

export type ChatWindowSelfState =
  | { kind: 'loading' }
  | { kind: 'missing'; message: string }
  | { kind: 'ready'; context: ChatWindowContext }

/**
 * A consultation's own window (「別ウィンドウで開く」): which consultation it
 * shows (main answers only this window), whether it still exists, and the
 * window closes when the conversation is deleted anywhere.
 */
export function useChatWindowSelf(): ChatWindowSelfState {
  const [state, setState] = useState<ChatWindowSelfState>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    void (async () => {
      const context = await getChatWindowContext().catch(() => null)
      if (!context) { if (alive) setState({ kind: 'missing', message: 'この画面に表示する相談がありません。ウィンドウを閉じてください。' }); return }
      const session = await getChatSession(context.companyId, context.sessionId).catch(() => null)
      if (!alive) return
      setState(session ? { kind: 'ready', context } : { kind: 'missing', message: 'この相談は削除されたか、参照できません。' })
    })()
    return () => { alive = false }
  }, [])

  const sessionId = state.kind === 'ready' ? state.context.sessionId : undefined
  useEffect(() => {
    if (!sessionId) return
    return onChatHistoryChanged(change => { if (change.deletedSessionId === sessionId) window.close() })
  }, [sessionId])
  return state
}
