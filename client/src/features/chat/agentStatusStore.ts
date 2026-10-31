import { useSyncExternalStore } from 'react'
import type { RateLimitProvider, RateLimitSnapshot } from '../../../shared/rate-limits'
import { applyAgentProgress, type AgentProgressEvent } from '../../../shared/agent-progress'

// Side information the chat server streams next to the transcript (transient
// data parts): the account's plan usage for the header meter, and each running
// subagent's latest progress line. Shared by every chat tab: limits belong to
// the account, and tool call ids are unique.

type Listener = () => void
const listeners = new Set<Listener>()
let rateLimits: Partial<Record<RateLimitProvider, RateLimitSnapshot>> = {}
let progress: ReadonlyMap<string, string> = new Map()

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setRateLimits(snapshot: RateLimitSnapshot | null | undefined) {
  if (!snapshot) return
  const current = rateLimits[snapshot.provider]
  // A fetched snapshot must not replace a newer one that streamed in meanwhile.
  if (current && current.updatedAt > snapshot.updatedAt) return
  rateLimits = { ...rateLimits, [snapshot.provider]: snapshot }
  notify()
}

export function reportAgentProgress(event: AgentProgressEvent) {
  const next = applyAgentProgress(progress, event)
  if (next === progress) return
  progress = next
  notify()
}

export function useRateLimits(provider: RateLimitProvider): RateLimitSnapshot | undefined {
  return useSyncExternalStore(subscribe, () => rateLimits[provider])
}

export function useAgentProgress(toolCallId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => progress.get(toolCallId))
}
