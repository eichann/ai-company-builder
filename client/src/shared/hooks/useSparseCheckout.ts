import { useState, useEffect, useCallback } from 'react'
import { excludedFolderOf, normalizeExclusions } from '../../../shared/sparse-paths'
import { applyExcludedFolders, getExcludedFolders } from '../ipc/download-choices'

interface UseSparseCheckoutOptions {
  rootPath: string
}

export interface ApplyResult {
  success: boolean
  /** Offline (a partial clone could not download): nothing changed. */
  offline?: boolean
  error?: string
}

interface UseSparseCheckoutResult {
  /** Whether sparse checkout is active (i.e. at least one folder is excluded) */
  enabled: boolean
  /** Folders (any depth) the user has excluded from local sync */
  excludedPaths: string[]
  /** Whether the initial check is still loading */
  isLoading: boolean
  /**
   * Why the last change could not be applied (null when it was). Downloading
   * a folder while offline reports
   * 「インターネットにつながっているときにダウンロードできます」; nothing changed.
   */
  error: string | null
  /** Replace the whole exclusion list (settings panel → 適用). */
  apply: (next: string[]) => Promise<ApplyResult>
  /** Stop syncing a folder locally (add to exclusion list) */
  removePath: (folderPath: string) => Promise<boolean>
  /** Resume syncing a folder locally (remove from exclusion list); downloads it if needed */
  addPath: (folderPath: string) => Promise<boolean>
  /** Clear all exclusions (full checkout) */
  disable: () => Promise<boolean>
  /** Whether a folder is currently synced locally (neither it nor a parent is excluded) */
  isCheckedOut: (folderPath: string) => boolean
  /** The excluded folder covering a repository-relative path, or null. */
  notDownloadedFolderOf: (repoPath: string) => string | null
  /** Refresh state from disk */
  refresh: () => void
}

/** Fired on window after any instance changed the exclusions, so every view reloads. */
export const SPARSE_CHANGED_EVENT = 'acb:sparse-changed'

// Sparse checkout is modelled as an EXCLUSION list: the user opts folders out
// (any depth), and the main process applies everything − excluded
// (electron/sync/sparse.ts). A folder is "checked out" iff neither it nor a
// parent is excluded.
export function useSparseCheckout({ rootPath }: UseSparseCheckoutOptions): UseSparseCheckoutResult {
  const [excludedPaths, setExcludedPaths] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadState = useCallback(async () => {
    if (!rootPath) {
      setExcludedPaths([])
      setIsLoading(false)
      return
    }
    try {
      const result = await getExcludedFolders(rootPath)
      setExcludedPaths(result.success ? normalizeExclusions(result.excluded) : [])
    } catch (err) {
      console.error('Failed to load sparse checkout state:', err)
      setExcludedPaths([])
    } finally {
      setIsLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    loadState()
  }, [loadState])

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ rootPath?: string }>).detail
      if (!detail?.rootPath || detail.rootPath === rootPath) void loadState()
    }
    window.addEventListener(SPARSE_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(SPARSE_CHANGED_EVENT, onChanged)
  }, [rootPath, loadState])

  // Apply a new exclusion list. On failure the main process has left the
  // repository as it was; reload so the panel shows what is really on disk.
  const apply = useCallback(async (next: string[]): Promise<ApplyResult> => {
    if (!rootPath) return { success: false, error: '会社フォルダが開かれていません' }
    setError(null)
    try {
      const result = await applyExcludedFolders(rootPath, next)
      if (!result.success) {
        setError(result.error || '変更できませんでした')
        await loadState()
        return { success: false, offline: result.offline, error: result.error || '変更できませんでした' }
      }
      setExcludedPaths(result.excluded ?? normalizeExclusions(next))
      window.dispatchEvent(new CustomEvent(SPARSE_CHANGED_EVENT, { detail: { rootPath } }))
      return { success: true }
    } catch (err) {
      console.error('Failed to update sparse checkout:', err)
      const message = err instanceof Error ? err.message : '変更できませんでした'
      setError(message)
      return { success: false, error: message }
    }
  }, [rootPath, loadState])

  const removePath = useCallback(
    async (folderPath: string) => (await apply([...excludedPaths, folderPath])).success,
    [apply, excludedPaths],
  )

  const addPath = useCallback(
    async (folderPath: string) => (await apply(excludedPaths.filter(p => p !== folderPath))).success,
    [apply, excludedPaths],
  )

  const disable = useCallback(async () => (await apply([])).success, [apply])

  const notDownloadedFolderOf = useCallback(
    (repoPath: string) => excludedFolderOf(excludedPaths, repoPath),
    [excludedPaths],
  )

  const isCheckedOut = useCallback(
    (folderPath: string): boolean => excludedFolderOf(excludedPaths, folderPath) === null,
    [excludedPaths],
  )

  return {
    enabled: excludedPaths.length > 0,
    excludedPaths,
    isLoading,
    error,
    apply,
    removePath,
    addPath,
    disable,
    isCheckedOut,
    notDownloadedFolderOf,
    refresh: loadState,
  }
}
