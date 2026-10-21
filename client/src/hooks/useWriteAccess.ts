import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { evaluateWrite, repoRelativePath, type WriteAccess } from '../../shared/write-access'

/**
 * The signed-in member's write access in the current company (閲覧のみ
 * badges). Loaded when the company opens; updated by the main process after
 * each sync and chat turn (writeAccess:changed). Unknown → nothing is shown
 * as read-only.
 */
export function useWriteAccess() {
  const companyId = useAppStore(s => s.currentCompany?.id)
  const rootPath = useAppStore(s => s.currentCompany?.rootPath)
  const [access, setAccess] = useState<WriteAccess | null>(null)

  useEffect(() => {
    setAccess(null)
    if (!companyId || !window.electronAPI?.getWriteAccess) return
    let active = true
    window.electronAPI.getWriteAccess(companyId)
      .then(value => { if (active) setAccess(value) })
      .catch(() => { /* unknown: no badges */ })
    const off = window.electronAPI.onWriteAccessChanged(({ companyId: changed, access: next }) => {
      if (active && changed === companyId) setAccess(next)
    })
    return () => { active = false; off() }
  }, [companyId])

  /** true when `absPath` is inside the company and the member may not write there. */
  const isReadOnly = useCallback((absPath: string): boolean => {
    if (!access || access.all || !rootPath) return false
    const rel = repoRelativePath(rootPath, absPath)
    if (rel === null) return false
    return !evaluateWrite(access, rel).write
  }, [access, rootPath])

  return { access, isReadOnly }
}
