import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { UIMessage } from 'ai'
import type { AuthMode } from '../../../../shared/agent'
import { agentCan } from '../../../../shared/agents/registry'
import { canSteerText } from '../../../../shared/steer'
import type { ChatServerClient } from '../chatServerClient'
import { draftWith, mergeQueuedSends, steerPartId, unreadSteerParts, withoutSteerParts, type QueuedSend } from '../queuedSends'
import type { ChatInputApi } from './useChatDraft'

export interface SteeringOptions {
  chatServer: ChatServerClient
  authModeRef: MutableRefObject<AuthMode>
  appSessionIdRef: MutableRefObject<string | null>
  inputApiRef: MutableRefObject<ChatInputApi | null>
}

/**
 * Messages sent while the AI works (shared/steer.ts): pushed into the running
 * turn when the agent can steer (registry capability `steering`) and the text
 * qualifies, otherwise — or when the agent did not read it in time — they wait
 * above the input (`queuedSends`). Called before useChat: its onFinish records
 * in `lastTurnAbortedRef` how the turn ended (a ref: read by the flush effect
 * of the same commit, nothing renders from it). The flush itself is
 * useQueuedSendFlush, called once the send function exists.
 */
export function useSteering({ chatServer, authModeRef, appSessionIdRef, inputApiRef }: SteeringOptions) {
  // Sends that wait for the running turn to end: no steering available, or
  // the agent did not read the instruction before the turn ended.
  const [queuedSends, setQueuedSends] = useState<QueuedSend[]>([])
  // The last turn was stopped or failed: waiting sends go back into the input.
  const lastTurnAbortedRef = useRef(false)

  /** A message sent during a running turn: steered into it, or queued. */
  const sendWhileRunning = useCallback((item: QueuedSend) => {
    const sessionId = appSessionIdRef.current
    if (agentCan(authModeRef.current, 'steering') && sessionId && !item.files?.length && !item.filePaths?.length && canSteerText(item.text)) {
      void chatServer.steer(sessionId, item.text).then(response => {
        if (response.status === 'delivered') return
        setQueuedSends(queue => [...queue, { ...item, ...(response.id ? { steerPartId: steerPartId(response.id) } : {}) }])
      })
    } else {
      setQueuedSends(queue => [...queue, item])
    }
  }, [chatServer, authModeRef, appSessionIdRef])

  /** 取り消す: the waiting message goes back into the input. */
  const cancelQueuedSend = useCallback((index: number) => {
    const item = queuedSends[index]
    if (!item) return
    setQueuedSends(queue => queue.filter((_, i) => i !== index))
    const draft = inputApiRef.current?.getValue() ?? ''
    inputApiRef.current?.setValue(draftWith(draft, [item.text]))
    inputApiRef.current?.focus()
  }, [queuedSends, inputApiRef])

  return { queuedSends, setQueuedSends, lastTurnAbortedRef, sendWhileRunning, cancelQueuedSend }
}

export type Steering = ReturnType<typeof useSteering>

/**
 * The turn ended: waiting sends go out together as the next message — or,
 * after a stop or an error, back into the input. An instruction the agent did
 * not read leaves the reply first (it is sent again as a normal message).
 */
export function useQueuedSendFlush(
  { queuedSends, setQueuedSends, lastTurnAbortedRef }: Steering,
  status: string,
  send: (text: string, files?: File[], filePaths?: string[]) => Promise<void>,
  setMessages: (update: (messages: UIMessage[]) => UIMessage[]) => void,
  inputApiRef: MutableRefObject<ChatInputApi | null>,
): void {
  useEffect(() => {
    if ((status !== 'ready' && status !== 'error') || queuedSends.length === 0) return
    const unread = unreadSteerParts(queuedSends)
    if (unread.size) {
      setMessages(current => withoutSteerParts(current, unread))
    }
    if (status === 'error' || lastTurnAbortedRef.current) {
      const draft = inputApiRef.current?.getValue() ?? ''
      inputApiRef.current?.setValue(draftWith(draft, queuedSends.map(item => item.text)))
      setQueuedSends([])
      return
    }
    // All of them as one message: one more turn, not a race of several.
    const merged = mergeQueuedSends(queuedSends)
    setQueuedSends([])
    void send(merged.text, merged.files, merged.filePaths)
  }, [status, queuedSends, send, setMessages, inputApiRef, lastTurnAbortedRef, setQueuedSends])
}
