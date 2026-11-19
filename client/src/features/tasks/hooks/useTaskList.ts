import { useCallback, useRef, useState } from 'react'
import type { TaskListResult } from '../../../../shared/tasks'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { getTaskList, onTasksMayHaveChanged } from '../api'
import { nextListState, type TaskListState } from '../listAnswers'

/** Read again at least this often while the list is mounted (others' changes reach no signal of ours). */
const REFRESH_MS = 2 * 60_000

/**
 * The company's task list, read from main: at mount, when its records may have changed
 * (`records:changed`), every 2 minutes and on `reload` (after the member's own change: a fresh
 * read, never one main began before the change). An answer older than the one shown is never taken
 * (`listAnswers.ts`). The last good answer stays on screen while a read fails.
 */
export function useTaskList(companyId: string | undefined) {
  const [state, setState] = useState<TaskListState>({ companyId, data: null, error: null, shown: 0 })
  const tickets = useRef(0)
  const read = useCallback((fresh: boolean) => {
    if (!companyId) return
    const ticket = ++tickets.current
    void getTaskList(companyId, undefined, fresh ? { fresh: true } : undefined).then((r: TaskListResult | undefined) => {
      // Never an answer older than the one shown (listAnswers.ts): a press's result is not put back.
      if (r) setState(s => nextListState(s, companyId, ticket, r))
    }, () => {})
  }, [companyId])
  const look = useCallback(() => read(false), [read])
  const reload = useCallback(() => read(true), [read])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    if (!companyId) return undefined
    listener(undefined)
    return onTasksMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, look, !!companyId)
  useInterval(look, companyId ? REFRESH_MS : null)
  // Another company's list never shows here (an answer may arrive after a switch).
  const current = state.companyId === companyId ? state : { data: null, error: null }
  return { data: current.data, error: current.error, reload }
}
