// The chat's access to the main process, as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts), one per capability. Every function takes
// its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** Reading the chat history on this computer: summaries, one conversation, body search, changes. */
export type ChatHistoryReads = ElectronPort<'getChatSessionSummaries' | 'getChatSession' | 'searchChatSessions' | 'onChatHistoryChanged'>
/** Writing the chat history on this computer: save, rename / pin, delete. */
export type ChatHistoryWrites = ElectronPort<'saveChatSession' | 'flushChatSession' | 'patchChatSession' | 'deleteChatSession'>
/** Reading a conversation's hand-off memo (this computer). */
export type HandoffReads = ElectronPort<'getHandoff' | 'onHandoffChanged'>
/**
 * Asking for the hand-off memo to be written: the member's AI reads the
 * conversation and summarises it, so the conversation leaves the computer.
 */
export type HandoffOutbound = ElectronPort<'updateHandoff' | 'completeHandoffTurn'>

type Args<K extends keyof ElectronAPI> = ElectronAPI[K] extends (...args: infer A) => unknown ? A : never

/** The company's conversations without message bodies. */
export function getChatSessionSummaries(companyId: string, reads: ChatHistoryReads = window.electronAPI) {
  return reads.getChatSessionSummaries(companyId)
}

/** One conversation with its messages, or null when it is gone. */
export function getChatSession(companyId: string, sessionId: string, reads: ChatHistoryReads = window.electronAPI) {
  return reads.getChatSession(companyId, sessionId)
}

/** Ids of the conversations whose messages match (searched in the main process). */
export function searchChatSessions(companyId: string, query: string, reads: ChatHistoryReads = window.electronAPI) {
  return reads.searchChatSessions(companyId, query)
}

/** Saves, patches and deletes from any tab; returns the unsubscribe. */
export function onChatHistoryChanged(callback: Args<'onChatHistoryChanged'>[0], reads: ChatHistoryReads = window.electronAPI) {
  return reads.onChatHistoryChanged(callback)
}

export function saveChatSession(companyId: string, session: Args<'saveChatSession'>[1], writes: ChatHistoryWrites = window.electronAPI) {
  return writes.saveChatSession(companyId, session)
}

/** Synchronous save (page unload, leaving a tab); throws the main process's error. */
export function flushChatSession(companyId: string, session: Args<'flushChatSession'>[1], writes: ChatHistoryWrites = window.electronAPI) {
  return writes.flushChatSession(companyId, session)
}

/** Changes a conversation's fields (title, pin, native agent session) without its messages. */
export function patchChatSession(companyId: string, sessionId: string, changes: Args<'patchChatSession'>[2], writes: ChatHistoryWrites = window.electronAPI) {
  return writes.patchChatSession(companyId, sessionId, changes)
}

export function deleteChatSession(companyId: string, sessionId: string, writes: ChatHistoryWrites = window.electronAPI) {
  return writes.deleteChatSession(companyId, sessionId)
}

export function getHandoff(companyId: string, sessionId: string, reads: HandoffReads = window.electronAPI) {
  return reads.getHandoff(companyId, sessionId)
}

/** Any conversation's memo changed; returns the unsubscribe. */
export function onHandoffChanged(callback: Args<'onHandoffChanged'>[0], reads: HandoffReads = window.electronAPI) {
  return reads.onHandoffChanged(callback)
}

/** The member asked for the memo now. */
export function updateHandoff(companyId: string, sessionId: string, outbound: HandoffOutbound = window.electronAPI) {
  return outbound.updateHandoff(companyId, sessionId)
}

/** A turn ended normally and is saved: the memo is brought up to date when it is due. */
export function recordHandoffTurn(companyId: string, sessionId: string, receipt: Args<'completeHandoffTurn'>[2], outbound: HandoffOutbound = window.electronAPI) {
  return outbound.completeHandoffTurn(companyId, sessionId, receipt)
}
