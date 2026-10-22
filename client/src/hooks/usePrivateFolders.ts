import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { useAppStore } from '../stores/appStore'
import { repoRelativePath } from '../../shared/write-access'
import { isPrivateRoot, privateFolderOf, type MyPrivateFolder } from '../../shared/private-folder-ui'

interface PrivateFolderState {
  /** companyId → the private folders this member can read (unknown until loaded). */
  byCompany: Record<string, MyPrivateFolder[]>
  load: (companyId: string) => Promise<void>
}

/**
 * The private folders the signed-in member can read (GET /me/private-folders),
 * for lock icons, the 「🔒 非公開」 banner and the move confirmations. Loaded
 * when a company opens, after a sync, after creating one and when the write
 * access changes. Unknown (offline, older server) = nothing is shown private.
 */
export const usePrivateFolderStore = create<PrivateFolderState>((set) => ({
  byCompany: {},
  load: async (companyId) => {
    if (!window.electronAPI?.getMyPrivateFolders) return
    try {
      const res = await window.electronAPI.getMyPrivateFolders(companyId)
      if (res.success) set(s => ({ byCompany: { ...s.byCompany, [companyId]: res.folders } }))
    } catch {
      // Keep what we had.
    }
  },
}))

export function usePrivateFolders() {
  const companyId = useAppStore(s => s.currentCompany?.id)
  const rootPath = useAppStore(s => s.currentCompany?.rootPath)
  const folders = usePrivateFolderStore(s => (companyId ? s.byCompany[companyId] : undefined))
  const load = usePrivateFolderStore(s => s.load)

  useEffect(() => {
    if (!companyId) return
    void load(companyId)
    const off = window.electronAPI?.onWriteAccessChanged?.(({ companyId: changed }) => {
      if (changed === companyId) void load(companyId)
    })
    return () => { off?.() }
  }, [companyId, load])

  const list = folders ?? []
  const rel = useCallback((absPath: string): string | null => (rootPath ? repoRelativePath(rootPath, absPath) : null), [rootPath])

  /** The private folder an absolute path is at or inside, or null. */
  const privateOf = useCallback((absPath: string): MyPrivateFolder | null => {
    const r = rel(absPath)
    return r === null ? null : privateFolderOf(r, list)
  }, [rel, list])

  /** The private folder whose root is exactly this absolute path, or null. */
  const privateRootAt = useCallback((absPath: string): MyPrivateFolder | null => {
    const r = rel(absPath)
    return r !== null && isPrivateRoot(r, list) ? privateFolderOf(r, list) : null
  }, [rel, list])

  const reload = useCallback(() => (companyId ? load(companyId) : Promise.resolve()), [companyId, load])

  return { folders: list, privateOf, privateRootAt, relativePath: rel, reload }
}
