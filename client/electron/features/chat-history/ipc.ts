// Chat history on this computer (chat-history-store.ts) and the session
// hand-offs between agents (handoff/). Session lists use summaries (no
// message bodies); body search runs in the main process.
//   chatHistory:* (flushSession is the synchronous unload save),
//   handoff:get, handoff:update, handoff:complete; sends chatHistory:changed

import type { ChatHistoryChange, ChatMetadataPatch, ChatSaveReceipt, ChatSession } from '../../../shared/chat-history'
import type { HandoffCompletion } from '../../../shared/handoff'
import type { ChatHistoryStore } from '../../chat-history-store'
import type { HandoffService } from '../../handoff/service'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { WindowPort } from '../ports'

export interface ChatHistoryDeps {
  history: ChatHistoryStore
  handoffs: HandoffService
  window: WindowPort
}

export interface ChatHistoryEvents {
  /** Tell the window a session changed (a tab re-reads only that session's metadata). */
  changed(change: ChatHistoryChange): void
}

export function registerChatHistoryIpc(ipc: IpcRegistrar, { history, handoffs, window }: ChatHistoryDeps): ChatHistoryEvents {
  ipc.handle('handoff:get', (_, company: string, id: string) => { handoffs.touch(company, id); return handoffs.view(company, id) })
  ipc.handle('handoff:update', (_, company: string, id: string) => handoffs.requestUpdate(company, id))
  ipc.handle('handoff:complete', (_, company: string, id: string, receipt: HandoffCompletion) => handoffs.complete(company, id, receipt))
  // Targeted change events: a tab re-reads only its own session's metadata and the
  // sidebar re-reads the summaries (no message bodies), never the whole history.
  function broadcastChatHistoryChanged(change: ChatHistoryChange): void {
    window.send('chatHistory:changed', change)
  }
  ipc.handle('chatHistory:getSummaries', (_, companyId: string) => history.summaries(companyId))
  ipc.handle('chatHistory:search', (_, companyId: string, query: string) => history.search(companyId, query))
  ipc.handle('chatHistory:getSession', (_, companyId: string, sessionId: string) =>
    history.get(companyId, sessionId))
  // The receipt, not the stored session: sending the whole conversation back on
  // every autosave cost as much IPC as the save itself.
  function persistChatSession(companyId: string, session: ChatSession): ChatSaveReceipt {
    const result = history.save(companyId, session)
    if (result.status === 'deleted') return result
    if (result.status === 'saved') broadcastChatHistoryChanged({ companyId, sessionId: session.id, kind: 'save' })
    return { status: result.status, revision: result.session.revision ?? 0 }
  }
  ipc.handle('chatHistory:saveSession', (_, companyId: string, session: ChatSession) =>
    persistChatSession(companyId, session))
  // Used only during unload, when an asynchronous renderer request cannot be awaited.
  ipc.on('chatHistory:flushSession', (event, companyId: string, session: ChatSession) => {
    try { event.returnValue = { result: persistChatSession(companyId, session) } }
    catch (error) { event.returnValue = { error: error instanceof Error ? error.message : '保存に失敗しました。' } }
  })
  ipc.handle('chatHistory:patchSession', (_, companyId: string, sessionId: string, patch: ChatMetadataPatch) => {
    const result = history.patch(companyId, sessionId, patch)
    broadcastChatHistoryChanged({ companyId, sessionId, kind: 'patch' })
    return result
  })
  ipc.handle('chatHistory:deleteSession', (_, companyId: string, sessionId: string) => {
    history.delete(companyId, sessionId)
    handoffs.invalidate(companyId, sessionId)
    broadcastChatHistoryChanged({ companyId, sessionId, kind: 'delete', deletedSessionId: sessionId })
    return true
  })

  return { changed: broadcastChatHistoryChanged }
}
