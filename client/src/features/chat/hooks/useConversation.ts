import { useRef, useState, type MutableRefObject } from 'react'
import type { UIMessage } from 'ai'
import type { AgentSession, AuthMode } from '../../../../shared/agent'
import type { ChatServerClient } from '../chatServerClient'
import { uiMessageToSessionMessage } from '../chatSessionMessages'
import { patchChatSession, recordHandoffTurn } from '../api'

/** Saves the conversation: `override` = these messages instead of the current ones; `sync` = flush now (unload, tab switch, before sending). */
export type SaveConversation = (override?: UIMessage[], sync?: boolean, clearDraft?: boolean) => Promise<boolean>

export interface HandoffReceipt { companyId: string; sessionId: string; provider: AuthMode }

/**
 * Which conversation a chat tab shows, and the native agent session behind
 * it. Called before useChat: the transport's request body, useChat's
 * onFinish and the render-time interaction lookup read these refs.
 *
 * Refs, not state, on purpose: they change when a request is built or a turn
 * ends, nothing on screen depends on them, and the transport is created once
 * (useChat keeps its first one), so it can only ever read current values
 * through refs. `currentSessionId` is the state copy the parent and the
 * hand-off control follow.
 */
export function useConversation(initialSessionId: string | null | undefined) {
  // App session ID (for Claude CLI session resume). Read during render (the
  // interaction lookup): it must exist before any code that runs in render
  // reaches it — declared later, the first agent question hit the temporal
  // dead zone and crashed the window.
  // Eagerly assigned on first message send so the server can track the CLI session from the start
  const appSessionIdRef = useRef<string | null>(initialSessionId || crypto.randomUUID())
  // Claude CLI session ID (persisted across app restarts via ChatSession)
  const claudeSessionIdRef = useRef<string | null>(null)
  const agentSessionRef = useRef<AgentSession | null | undefined>(undefined)
  // Set by each /api/chat request (chatRequestBody.ts), read when its turn ends.
  const handoffRequestRef = useRef<HandoffReceipt | null>(null)
  // Declared before useChat: its onFinish reports hand-off failures here.
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(appSessionIdRef.current)
  // When each message was first seen (stamped during render, restored from history).
  const timestampsRef = useRef(new Map<string, Date>())
  // The latest render's save (useChatHistory assigns it); callbacks created
  // earlier — useChat's onFinish, timers, unload — always call the current one.
  const saveRef = useRef<SaveConversation>(async () => true)
  return { appSessionIdRef, claudeSessionIdRef, agentSessionRef, handoffRequestRef, historyError, setHistoryError, currentSessionId, setCurrentSessionId, timestampsRef, saveRef }
}

export type Conversation = ReturnType<typeof useConversation>

/** Messages seen for the first time get the current time (done during render, so it is there for the first paint). */
export function stampNewMessages(timestamps: Map<string, Date>, messages: readonly UIMessage[]): void {
  const now = new Date()
  for (const msg of messages) {
    if (!timestamps.has(msg.id)) timestamps.set(msg.id, now)
  }
}

interface FinishedTurn {
  finishedMessages: UIMessage[]
  message: UIMessage
  isAbort: boolean
  isDisconnect: boolean
  isError: boolean
  finishReason?: string
}

/**
 * A turn that ended normally updates the hand-off memo of the conversation it
 * belonged to — after the transcript is saved, and only while this tab still
 * shows that conversation of that company.
 */
export function completeHandoffTurn(
  conversation: Pick<Conversation, 'handoffRequestRef' | 'appSessionIdRef' | 'saveRef' | 'setHistoryError'>,
  companyIdRef: MutableRefObject<string | undefined>,
  turn: FinishedTurn,
): void {
  const receipt = conversation.handoffRequestRef.current
  if (!receipt || turn.isAbort || turn.isDisconnect || turn.isError || turn.finishReason !== 'stop') return
  const content = uiMessageToSessionMessage(turn.message, new Date()).content
  void (async () => {
    if (conversation.appSessionIdRef.current !== receipt.sessionId || companyIdRef.current !== receipt.companyId) return
    if (!await conversation.saveRef.current(turn.finishedMessages)) return
    await recordHandoffTurn(receipt.companyId, receipt.sessionId, { messageId: turn.message.id, content, provider: receipt.provider })
  })().catch(() => { conversation.setHistoryError('履歴は保存されましたが、引き継ぎメモの更新予約ができませんでした。') })
}

/** After a turn: remember the native session the agent used (resume after a restart). */
export function persistAgentSession(
  conversation: Pick<Conversation, 'appSessionIdRef' | 'agentSessionRef' | 'claudeSessionIdRef'>,
  chatServer: ChatServerClient,
  companyId: string | undefined,
): void {
  const finishedSessionId = conversation.appSessionIdRef.current
  if (!finishedSessionId || !companyId) return
  chatServer.sessionInfo(finishedSessionId)
    .then(data => {
      if (data.agentSession) {
        if (conversation.appSessionIdRef.current === finishedSessionId) conversation.agentSessionRef.current = data.agentSession
        void patchChatSession(companyId, finishedSessionId, { agentSession: data.agentSession }).catch(() => {})
      }
      if (data.claudeSessionId) {
        if (conversation.appSessionIdRef.current === finishedSessionId) conversation.claudeSessionIdRef.current = data.claudeSessionId
        void patchChatSession(companyId, finishedSessionId, { claudeSessionId: data.claudeSessionId }).catch(() => {})
      }
    })
    .catch(() => {})
}
