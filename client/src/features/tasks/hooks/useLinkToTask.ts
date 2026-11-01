import { useCallback, useRef, useState } from 'react'
import type { TaskChoice } from '../../../../shared/task-links'
import { getOpenTasks, linkFileToTask } from '../api'

export type LinkToTaskPhase =
  | { kind: 'loading' }
  | { kind: 'choose'; tasks: TaskChoice[] }
  | { kind: 'linking'; tasks: TaskChoice[] }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string; tasks: TaskChoice[] | null }

export interface LinkToTaskState {
  companyPath: string
  phase: LinkToTaskPhase
}

/**
 * 「やることにつなぐ…」's flow for one file at a time: `open` loads the member's
 * open tasks, `choose` links the file to one. Loading starts in the handler
 * that opened it (no effect); an answer for a file no longer open is dropped.
 */
export function useLinkToTask(companyId: string | undefined) {
  const [state, setState] = useState<LinkToTaskState | null>(null)
  const current = useRef(0)

  const open = useCallback((companyPath: string) => {
    if (!companyId) return
    const run = ++current.current
    setState({ companyPath, phase: { kind: 'loading' } })
    const settle = (phase: LinkToTaskPhase) => { if (current.current === run) setState({ companyPath, phase }) }
    getOpenTasks(companyId)
      .then(r => settle(r.success ? { kind: 'choose', tasks: r.tasks } : { kind: 'failed', message: r.error, tasks: null }))
      .catch(() => settle({ kind: 'failed', message: 'やることを読み込めませんでした。', tasks: null }))
  }, [companyId])

  const choose = useCallback((task: TaskChoice, tasks: TaskChoice[]) => {
    if (!companyId || !state) return
    const run = current.current
    const { companyPath } = state
    const settle = (phase: LinkToTaskPhase) => { if (current.current === run) setState({ companyPath, phase }) }
    settle({ kind: 'linking', tasks })
    linkFileToTask(companyId, task.id, companyPath, task.version)
      .then(r => settle(r.success ? { kind: 'done', message: r.message } : { kind: 'failed', message: r.error, tasks }))
      .catch(() => settle({ kind: 'failed', message: 'つなげませんでした。', tasks }))
  }, [companyId, state])

  const close = useCallback(() => { current.current++; setState(null) }, [])

  return { state, open, choose, close }
}
