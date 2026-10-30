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
/**
 * Reading this computer's AI setup: the chosen AI, whether Claude Code is installed
 * and signed in, the permission mode, the API key's status (never the key).
 */
export type AgentSetupReads = ElectronPort<'getAuthMode' | 'getClaudeCodeStatus' | 'hasApiKey' | 'getApiKeyStatus' | 'getPermissionMode'>
/** Checking Codex: starts the member's Codex, which asks their ChatGPT account and model list. */
export type CodexStatusOutbound = ElectronPort<'getCodexStatus'>
/** Changing this computer's AI setup: which AI the chat uses, what it may do without asking. */
export type AgentSetupWrites = ElectronPort<'setAuthMode' | 'setPermissionMode'>
/** Storing the Anthropic API key (a secret, encrypted on this computer); no other port carries it. */
export type ApiKeyWrites = ElectronPort<'setApiKey'>
/** Questions and approval requests from the running AI. */
export type AgentQuestionReads = ElectronPort<'onAgentInteraction' | 'onAgentInteractionClosed' | 'getAgentInteractions' | 'onToolApprovalRequest'>
/** Answering the running AI: the answer lets it go on (an approval lets it run the command). */
export type AgentAnswers = ElectronPort<'respondAgentInteraction' | 'respondToolApproval'>
/** Where the embedded chat server listens on this computer, and its token. */
export type ChatServerReads = ElectronPort<'getChatServerInfo' | 'onChatServerInfo'>
/** Leaving the app: opening a URL in the member's browser. */
export type ChatOutbound = ElectronPort<'openExternal'>

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

export function getAuthMode(reads: AgentSetupReads = window.electronAPI) {
  return reads.getAuthMode()
}

export function getClaudeCodeStatus(reads: AgentSetupReads = window.electronAPI) {
  return reads.getClaudeCodeStatus()
}

export function isApiKeySaved(reads: AgentSetupReads = window.electronAPI) {
  return reads.hasApiKey()
}

/** Whether a key is saved and its last four characters; the key never comes back. */
export function getApiKeyStatus(reads: AgentSetupReads = window.electronAPI) {
  return reads.getApiKeyStatus()
}

export function getPermissionMode(reads: AgentSetupReads = window.electronAPI) {
  return reads.getPermissionMode()
}

export function getCodexStatus(outbound: CodexStatusOutbound = window.electronAPI) {
  return outbound.getCodexStatus()
}

export function saveAuthMode(mode: Args<'setAuthMode'>[0], writes: AgentSetupWrites = window.electronAPI) {
  return writes.setAuthMode(mode)
}

export function savePermissionMode(mode: Args<'setPermissionMode'>[0], writes: AgentSetupWrites = window.electronAPI) {
  return writes.setPermissionMode(mode)
}

export function saveApiKey(apiKey: string, writes: ApiKeyWrites = window.electronAPI) {
  return writes.setApiKey(apiKey)
}

/** A question from the AI; returns the unsubscribe. */
export function onAgentInteraction(callback: Args<'onAgentInteraction'>[0], reads: AgentQuestionReads = window.electronAPI) {
  return reads.onAgentInteraction(callback)
}

/** A question answered or cancelled elsewhere; returns the unsubscribe. */
export function onAgentInteractionClosed(callback: Args<'onAgentInteractionClosed'>[0], reads: AgentQuestionReads = window.electronAPI) {
  return reads.onAgentInteractionClosed(callback)
}

/** The questions still open for this window. */
export function getAgentInteractions(reads: AgentQuestionReads = window.electronAPI) {
  return reads.getAgentInteractions()
}

/** A dangerous command or private content going public waits for the member; returns the unsubscribe. */
export function onToolApprovalRequest(callback: Args<'onToolApprovalRequest'>[0], reads: AgentQuestionReads = window.electronAPI) {
  return reads.onToolApprovalRequest(callback)
}

/** True when main accepted the answer. */
export function respondAgentInteraction(id: string, response: Args<'respondAgentInteraction'>[1], answers: AgentAnswers = window.electronAPI) {
  return answers.respondAgentInteraction(id, response)
}

export function respondToolApproval(toolUseId: string, approved: boolean, answers: AgentAnswers = window.electronAPI) {
  return answers.respondToolApproval(toolUseId, approved)
}

export function getChatServerInfo(reads: ChatServerReads = window.electronAPI) {
  return reads.getChatServerInfo()
}

/** The address again once the page has loaded; returns the unsubscribe. */
export function onChatServerInfo(callback: Args<'onChatServerInfo'>[0], reads: ChatServerReads = window.electronAPI) {
  return reads.onChatServerInfo(callback)
}

export function openInBrowser(url: string, outbound: ChatOutbound = window.electronAPI) {
  return outbound.openExternal(url)
}
