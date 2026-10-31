import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import { useChat, type UseChatHelpers } from '@ai-sdk/react'
import type { ChatOnFinishCallback, ChatTransport, UIMessage } from 'ai'
import type { AuthMode } from '../../../../shared/agent'
import { RATE_LIMITS_PART_TYPE, hasRateLimits, type RateLimitSnapshot } from '../../../../shared/rate-limits'
import { AGENT_PROGRESS_PART_TYPE, readAgentProgress } from '../../../../shared/agent-progress'
import type { ChatServerClient } from '../chatServerClient'
import { streamThrottleMs } from '../markdownBlocks'
import { reportAgentProgress, setRateLimits } from '../agentStatusStore'

type FinishEvent = Parameters<ChatOnFinishCallback<UIMessage>>[0]

/**
 * Side information streamed next to the transcript as transient data parts
 * (never stored): plan usage for the header meter and subagent progress
 * lines, both into agentStatusStore (shared by every tab).
 */
export function handleTransientDataPart(part: { type: string; data?: unknown }): void {
  if (part.type === RATE_LIMITS_PART_TYPE) setRateLimits(part.data as RateLimitSnapshot)
  else if (part.type === AGENT_PROGRESS_PART_TYPE) {
    const progress = readAgentProgress(part.data)
    if (progress) reportAgentProgress(progress)
  }
}

/**
 * useChat with the re-render cadence of a streaming reply: longer for a long
 * reply, whose last markdown block is parsed again on every tick
 * (markdownBlocks.ts). `onFinish` is the latest render's (useChat calls it
 * through a ref).
 */
export function useStreamingChat(transport: ChatTransport<UIMessage>, onFinish: (event: FinishEvent) => void): UseChatHelpers<UIMessage> {
  const [streamThrottle, setStreamThrottle] = useState(() => streamThrottleMs(0))

  const chat = useChat({
    transport,
    experimental_throttle: streamThrottle,
    onFinish,
    onError: (err) => {
      console.error('[useChat] Error:', err)
    },
    onData: handleTransientDataPart,
  })

  // The throttle follows the reply's length (adjusted while rendering; useChat takes it next render).
  const last = chat.messages[chat.messages.length - 1]
  let length = 0
  if (last?.role === 'assistant') for (const part of last.parts) if (part.type === 'text') length += part.text.length
  const nextThrottle = streamThrottleMs(length)
  if (nextThrottle !== streamThrottle) setStreamThrottle(nextThrottle)

  return chat
}

/**
 * Plan usage for the header meter (shared/rate-limits.ts): streamed live as
 * transient data parts, and fetched for a tab that has not streamed yet (on
 * mount and when the agent changes).
 */
export function useRateLimitsRefresh(chatServer: ChatServerClient, authMode: AuthMode, authModeRef: MutableRefObject<AuthMode>): void {
  const fetchRateLimits = useCallback(async () => {
    if (!hasRateLimits(authModeRef.current)) return
    try {
      const data = await chatServer.rateLimits(authModeRef.current)
      setRateLimits(data.rateLimits)
    } catch {
      // The meter keeps what it has.
    }
  }, [chatServer, authModeRef])

  useEffect(() => { void fetchRateLimits() }, [authMode, fetchRateLimits])
}
