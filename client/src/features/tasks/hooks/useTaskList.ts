import { useCallback, useState } from 'react'
import type { TaskListData, TaskListResult } from '../../../../shared/tasks'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useInterval } from '../../../shared/hooks/useInterval'
import { getTaskList, onTasksMayHaveChanged } from '../api'

/** Read again at least this often while the list is mounted (others' changes reach no signal of ours). */
const REFRESH_MS = 2 * 60_000

/**
 * The company's task list, read from main: at mount, when the member's turn or notices may
 * have changed (the push channel), every 2 minutes and on `reload` (after the member's own
 * change). The last good answer stays on screen while a read fails.
 */
export function useTaskList(companyId: string | undefined) {
  const [state, setState] = useState<{ companyId: string | undefined; data: TaskListData | null; error: string | null }>({ companyId, data: null, error: null })
  const reload = useCallback(() => {
    if (!companyId) return
    void getTaskList(companyId).then((r: TaskListResult | undefined) => {
      if (!r) return
      setState(s => r.success
        ? { companyId, data: r.data, error: null }
        : { companyId, data: s.companyId === companyId ? s.data : null, error: r.error })
    }, () => {})
  }, [companyId])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    if (!companyId) return undefined
    listener(undefined)
    return onTasksMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload, !!companyId)
  useInterval(reload, companyId ? REFRESH_MS : null)
  // Another company's list never shows here (an answer may arrive after a switch).
  const current = state.companyId === companyId ? state : { data: null, error: null }
  return { data: current.data, error: current.error, reload }
}
