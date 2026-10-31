import { useEffect, useState } from 'react'
import type { ChatWindowContext } from '../../../../shared/chat-windows'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useAppStore } from '../../../stores/appStore'
import { getChatSession, getChatWindowContext, onChatHistoryChanged } from '../api'

export type ChatWindowSelfState =
  | { kind: 'loading' }
  | { kind: 'missing'; message: string }
  | { kind: 'ready'; context: ChatWindowContext }

/**
 * A consultation's own window (「別ウィンドウで開く」): which consultation it
 * shows (main answers only this window), whether it still exists, and the
 * window closes when the conversation is deleted anywhere. Once ready, the
 * app store holds the consultation's company.
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
      if (!session) { setState({ kind: 'missing', message: 'この相談は削除されたか、参照できません。' }); return }
      // The chat reads the company from the store (its folder for the AI, the history file).
      useAppStore.setState({ currentCompany: { id: context.companyId, name: context.companyName, rootPath: context.rootPath, departments: [], createdAt: new Date() } })
      setState({ kind: 'ready', context })
    })()
    return () => { alive = false }
  }, [])

  const sessionId = state.kind === 'ready' ? state.context.sessionId : undefined
  useIpcEvent(onChatHistoryChanged, change => { if (change.deletedSessionId === sessionId) window.close() }, !!sessionId)
  return state
}
