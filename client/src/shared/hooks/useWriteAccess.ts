import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { evaluateWrite, repoRelativePath, type WriteAccess } from '../../../shared/write-access'
import { canReadWriteAccess, getWriteAccess, onWriteAccessChanged } from '../ipc/write-access'
import { answeredCompanyFolderKind } from '../../../shared/company-folder'

/**
 * The signed-in member's write access in the current company (閲覧のみ
 * badges). Loaded when the company opens; updated by the main process after
 * each sync and chat turn (writeAccess:changed). Unknown → nothing is shown
 * as read-only. A company without the shared company folder has no read-only
 * folders: its working folder is the member's own and nothing reaches the server.
 */
export function useWriteAccess() {
  const companyId = useAppStore(s => s.currentCompany?.id)
  const rootPath = useAppStore(s => s.currentCompany?.rootPath)
  const sharedFolder = useAppStore(s => answeredCompanyFolderKind(s.currentCompany?.folderKind) !== 'none')
  const [access, setAccess] = useState<WriteAccess | null>(null)

  useEffect(() => {
    setAccess(null)
    if (!companyId || !canReadWriteAccess()) return
    let active = true
    getWriteAccess(companyId)
      .then(value => { if (active) setAccess(value) })
      .catch(() => { /* unknown: no badges */ })
    const off = onWriteAccessChanged(({ companyId: changed, access: next }) => {
      if (active && changed === companyId) setAccess(next)
    })
    return () => { active = false; off?.() }
  }, [companyId])

  /** true when `absPath` is inside the company and the member may not write there. */
  const isReadOnly = useCallback((absPath: string): boolean => {
    if (!sharedFolder || !access || access.all || !rootPath) return false
    const rel = repoRelativePath(rootPath, absPath)
    if (rel === null) return false
    return !evaluateWrite(access, rel).write
  }, [access, rootPath, sharedFolder])

  return { access, isReadOnly }
}
