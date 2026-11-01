import { useCallback, useState } from 'react'
import type { QueuedPluginStep } from '../../../../shared/ai-turn-steps/plugin'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { listPluginStepTurns } from '../api'

/** How often the list is read again (the claim re-checks with the server: a stale entry costs one refused claim). */
const REFRESH_MS = 60_000
const NONE: readonly QueuedPluginStep[] = []

/** Now and every minute while subscribed. */
function everyMinute(listener: (payload: undefined) => void): () => void {
  listener(undefined)
  const timer = setInterval(() => listener(undefined), REFRESH_MS)
  return () => clearInterval(timer)
}

/**
 * The member's records waiting at a business plugin's `start: ai_turn` step (plugin-steps.md):
 * the AI turn runner's queue takes them like the task list's 「AI の番」. Read on mount and every
 * minute; another company's list never shows (an answer may arrive after a switch).
 */
export function usePluginStepTurns(companyId: string | undefined): readonly QueuedPluginStep[] {
  const [state, setState] = useState<{ companyId: string | undefined; turns: readonly QueuedPluginStep[] }>({ companyId, turns: NONE })
  const subscribe = useCallback((listener: (payload: undefined) => void) => companyId ? everyMinute(listener) : undefined, [companyId])
  useIpcEvent(subscribe, () => {
    if (!companyId) return
    void listPluginStepTurns(companyId).then(turns => setState({ companyId, turns: Array.isArray(turns) ? turns : NONE }), () => {})
  }, !!companyId)
  return state.companyId === companyId ? state.turns : NONE
}
