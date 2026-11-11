import { useCallback, useState } from 'react'
import type { QueuedJobTurn } from '../../../../shared/ai-turn-steps/job'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { listJobTurns } from '../api'

/** How often the list is read again (the clock makes occurrences every 5 minutes; the claim re-checks with the server). */
const REFRESH_MS = 60_000
const NONE: readonly QueuedJobTurn[] = []

function everyMinute(listener: (payload: undefined) => void): () => void {
  listener(undefined)
  const timer = setInterval(() => listener(undefined), REFRESH_MS)
  return () => clearInterval(timer)
}

/**
 * The member's scheduled jobs' occurrences this PC may run now (jobs.md "The app's runner"): the AI turn
 * runner's queue takes them like the task list's 「AI の番」. Read on mount and every minute; another
 * company's list never shows (an answer may arrive after a switch).
 */
export function useJobTurns(companyId: string | undefined): readonly QueuedJobTurn[] {
  const [state, setState] = useState<{ companyId: string | undefined; turns: readonly QueuedJobTurn[] }>({ companyId, turns: NONE })
  const subscribe = useCallback((listener: (payload: undefined) => void) => companyId ? everyMinute(listener) : undefined, [companyId])
  useIpcEvent(subscribe, () => {
    if (!companyId) return
    void listJobTurns(companyId).then(turns => setState({ companyId, turns: Array.isArray(turns) ? turns : NONE }), () => {})
  }, !!companyId)
  return state.companyId === companyId ? state.turns : NONE
}
