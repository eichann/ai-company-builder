import { useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { ChatWindowOpenRequest, ChatWindowStatus } from '../../../../shared/chat-windows'
import type { ConsultationStatus } from '../../../lib/consultationStatus'
import { focusChatWindow, getChatSession, openChatWindow } from '../api'
import { canMoveToWindow, MOVE_WHILE_WORKING } from '../chatWindows'

interface Options {
  company: { id: string; name: string; rootPath: string } | null
  department?: { name: string; folder: string }
  slashCommands?: ChatWindowOpenRequest['slashCommands']
  /** Consultations other windows show (useChatWindows). */
  windows: ReadonlyMap<string, ChatWindowStatus>
  /** This window's tab showing a consultation, with its status now. */
  tabOf: (sessionId: string) => { id: string; status?: ConsultationStatus } | undefined
  /** Removes the consultation's tab (its unmount saves the conversation synchronously). */
  detach: (sessionId: string) => void
  /** Puts it back as a tab (the window could not open). */
  reopen: (sessionId: string) => void
  alert?: (message: string) => void
}

/**
 * 「別ウィンドウで開く」 from the main window: a consultation another window
 * shows is brought to the front instead; one shown here leaves this window
 * first (saved on the way out), so it is never on screen twice.
 */
export function useMoveToWindow(options: Options): (sessionId: string) => Promise<void> {
  const ref = useRef(options)
  ref.current = options
  return useCallback(async (sessionId: string) => {
    const { company, department, slashCommands, windows, tabOf, detach, reopen, alert = window.alert } = ref.current
    if (!company) return
    if (windows.has(sessionId)) { await focusChatWindow(sessionId); return }
    const tab = tabOf(sessionId)
    if (tab && !canMoveToWindow(tab.status)) { alert(MOVE_WHILE_WORKING); return }
    const stored = await getChatSession(company.id, sessionId).catch(() => null)
    if (!stored) { alert('まだ何も書いていない相談は、別ウィンドウで開けません。'); return }
    // The tab goes now (its unmount saves synchronously), before the window reads the conversation.
    if (tab) flushSync(() => detach(sessionId))
    const result = await openChatWindow(sessionId, {
      companyId: company.id, companyName: company.name, rootPath: company.rootPath,
      ...(department ? { department } : {}),
      ...(slashCommands?.length ? { slashCommands } : {}),
      title: stored.title,
    }).catch(() => ({ ok: false as const, error: '別ウィンドウで開けませんでした。' }))
    if (!result.ok) {
      if (tab) reopen(sessionId)
      alert(result.error)
    }
  }, [])
}
