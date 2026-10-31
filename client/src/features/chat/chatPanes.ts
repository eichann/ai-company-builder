/**
 * The chat panes of this window and the consultations each has open as a
 * tab: one consultation is never open in two panes, or both would save it
 * over each other (the same rule main keeps for windows, 「別ウィンドウで開く」).
 * Opening one that another pane has shows it there instead.
 */
interface ChatPaneEntry {
  sessions: ReadonlySet<string>
  show: (sessionId: string) => void
}

const panes = new Map<string, ChatPaneEntry>()

/** A pane says which consultations it has open; returns the function that removes it. */
export function publishChatPane(paneId: string, sessionIds: Iterable<string>, show: (sessionId: string) => void): () => void {
  const entry: ChatPaneEntry = { sessions: new Set(sessionIds), show }
  panes.set(paneId, entry)
  return () => { if (panes.get(paneId) === entry) panes.delete(paneId) }
}

/** The other pane that has this consultation open, if any. */
export function chatPaneWith(sessionId: string, exceptPane: string): string | undefined {
  for (const [paneId, entry] of panes) {
    if (paneId !== exceptPane && entry.sessions.has(sessionId)) return paneId
  }
  return undefined
}

/** Shows the consultation in the pane that has it open; false when no other pane has it. */
export function showInOtherChatPane(sessionId: string, exceptPane: string): boolean {
  const paneId = chatPaneWith(sessionId, exceptPane)
  if (paneId === undefined) return false
  panes.get(paneId)!.show(sessionId)
  return true
}
