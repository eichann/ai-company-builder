import { useCallback, useState } from 'react'
import type { TaskListData, TaskListResult } from '../../../../shared/tasks'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { getTaskList, onTasksMayHaveChanged } from '../api'

/** Read again at least this often while the list is mounted (others' changes reach no signal of ours). */
const REFRESH_MS = 2 * 60_000

/**
 * The company's task list, read from main: at mount, when its records may have changed
 * (`records:changed`), every 2 minutes and on `reload` (after the member's own change: a fresh
 * read, never one main began before the change). The last good answer stays on screen while a read fails.
 */
export function useTaskList(companyId: string | undefined) {
  const [state, setState] = useState<{ companyId: string | undefined; data: TaskListData | null; error: string | null }>({ companyId, data: null, error: null })
  const read = useCallback((fresh: boolean) => {
    if (!companyId) return
    void getTaskList(companyId, undefined, fresh ? { fresh: true } : undefined).then((r: TaskListResult | undefined) => {
      if (!r) return
      setState(s => r.success
        ? { companyId, data: r.data, error: null }
        : { companyId, data: s.companyId === companyId ? s.data : null, error: r.error })
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
