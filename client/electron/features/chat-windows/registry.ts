// Which window shows which consultation (「別ウィンドウで開く」). Pure: the
// windows are ids (their webContents id, the IPC sender id). One consultation
// is never shown in two windows: `claim` refuses a second one, and the caller
// focuses the window that already shows it.

import type { ChatWindowContext, ChatWindowInfo, ChatWindowStatus } from '../../../shared/chat-windows'
import { IDLE_WINDOW_STATUS } from '../../../shared/chat-windows'

export interface ChatWindowEntry {
  windowId: number
  context: ChatWindowContext
  status: ChatWindowStatus
}

export interface ChatWindowRegistry {
  /** The window showing this consultation, if any. */
  find(sessionId: string): ChatWindowEntry | undefined
  get(windowId: number): ChatWindowEntry | undefined
  /** Records that `windowId` shows the context's consultation; refused (with the window that has it) when another one does. */
  claim(windowId: number, context: ChatWindowContext): { ok: true } | { ok: false; existing: ChatWindowEntry }
  /** The window closed: its consultation is free again. */
  release(windowId: number): ChatWindowEntry | undefined
  /** False when the window is unknown or nothing changed. */
  setStatus(windowId: number, status: ChatWindowStatus): boolean
  list(): ChatWindowInfo[]
  windowIds(): number[]
}

const sameStatus = (a: ChatWindowStatus, b: ChatWindowStatus) => a.state === b.state && a.kind === b.kind && a.line === b.line

export function createChatWindowRegistry(): ChatWindowRegistry {
  const byWindow = new Map<number, ChatWindowEntry>()
  const find = (sessionId: string) => [...byWindow.values()].find(entry => entry.context.sessionId === sessionId)
  return {
    find,
    get: windowId => byWindow.get(windowId),
    claim(windowId, context) {
      const existing = find(context.sessionId)
      if (existing && existing.windowId !== windowId) return { ok: false, existing }
      byWindow.set(windowId, { windowId, context, status: existing?.status ?? IDLE_WINDOW_STATUS })
      return { ok: true }
    },
    release(windowId) {
      const entry = byWindow.get(windowId)
      byWindow.delete(windowId)
      return entry
    },
    setStatus(windowId, status) {
      const entry = byWindow.get(windowId)
      if (!entry || sameStatus(entry.status, status)) return false
      byWindow.set(windowId, { ...entry, status })
      return true
    },
    list: () => [...byWindow.values()].map(entry => ({ companyId: entry.context.companyId, sessionId: entry.context.sessionId, status: entry.status })),
    windowIds: () => [...byWindow.keys()],
  }
}
