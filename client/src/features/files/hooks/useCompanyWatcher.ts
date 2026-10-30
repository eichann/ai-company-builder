import { useEffect } from 'react'
import { isPerfCutEnabled, perfMark } from '../../../lib/perfDiagnostics'
import { unwatchCompany, watchCompany } from '../../../shared/ipc/file-events'

/**
 * One recursive watcher for the whole company, opened with the company and
 * kept across department switches (closing chokidar's per-department
 * watchers blocked the main process for up to 40 s). Retried briefly in case
 * the folder is not registered with the main process yet.
 */
export function useCompanyWatcher(rootPath: string | undefined) {
  useEffect(() => {
    const root = rootPath
    if (!root) return
    if (isPerfCutEnabled('disableWatchers')) {
      perfMark('skill_layout.watch.disabled')
      return
    }
    perfMark('skill_layout.watch.start')
    let cancelled = false
    let retryTimer: number | null = null
    const open = (attempt: number) => {
      void watchCompany(root).then(result => {
        if (cancelled || result?.success !== false || attempt >= 5) return
        retryTimer = window.setTimeout(() => open(attempt + 1), 1000)
      }).catch(() => {})
    }
    open(0)
    return () => {
      cancelled = true
      if (retryTimer != null) window.clearTimeout(retryTimer)
      void unwatchCompany(root)
      perfMark('skill_layout.watch.stop')
    }
  }, [rootPath])
}
