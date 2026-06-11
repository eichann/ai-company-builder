import { useState, useEffect, useCallback } from 'react'

interface UseSparseCheckoutOptions {
  rootPath: string
}

interface UseSparseCheckoutResult {
  /** Whether sparse checkout is active (i.e. at least one folder is excluded) */
  enabled: boolean
  /** Folders the user has excluded from local sync */
  excludedPaths: string[]
  /** Whether the initial check is still loading */
  isLoading: boolean
  /** Stop syncing a folder locally (add to exclusion list) */
  removePath: (folderPath: string) => Promise<boolean>
  /** Resume syncing a folder locally (remove from exclusion list) */
  addPath: (folderPath: string) => Promise<boolean>
  /** Clear all exclusions (full checkout) */
  disable: () => Promise<boolean>
  /** Whether a folder is currently synced locally (i.e. not excluded) */
  isCheckedOut: (folderPath: string) => boolean
  /** Refresh state from disk */
  refresh: () => void
}

// Sparse checkout is modelled as an EXCLUSION list: the user opts folders out,
// and the main process derives the actual git cone as (all remote folders −
// excluded). A folder is "checked out" iff it is not excluded.
export function useSparseCheckout({ rootPath }: UseSparseCheckoutOptions): UseSparseCheckoutResult {
  const [excludedPaths, setExcludedPaths] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadState = useCallback(async () => {
    if (!rootPath) {
      setExcludedPaths([])
      setIsLoading(false)
      return
    }
    try {
      const result = await window.electronAPI.sparseGetExclusions(rootPath)
      setExcludedPaths(result.success ? result.excluded : [])
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

  const removePath = useCallback(async (folderPath: string): Promise<boolean> => {
    if (!rootPath) return false
    try {
      const next = [...new Set([...excludedPaths, folderPath])]
      const result = await window.electronAPI.sparseSetExclusions(rootPath, next)
      if (!result.success) return false
      setExcludedPaths(result.excluded ?? next)
      return true
    } catch (err) {
      console.error('Failed to exclude folder:', err)
      return false
    }
  }, [rootPath, excludedPaths])

  const addPath = useCallback(async (folderPath: string): Promise<boolean> => {
    if (!rootPath) return false
    try {
      const next = excludedPaths.filter(p => p !== folderPath)
      const result = await window.electronAPI.sparseSetExclusions(rootPath, next)
      if (!result.success) return false
      setExcludedPaths(result.excluded ?? next)
      return true
    } catch (err) {
      console.error('Failed to re-include folder:', err)
      return false
    }
  }, [rootPath, excludedPaths])

  const disable = useCallback(async (): Promise<boolean> => {
    if (!rootPath) return false
    try {
      const result = await window.electronAPI.sparseSetExclusions(rootPath, [])
      if (!result.success) return false
      setExcludedPaths([])
      return true
    } catch (err) {
      console.error('Failed to clear sparse exclusions:', err)
      return false
    }
  }, [rootPath])

  const isCheckedOut = useCallback((folderPath: string): boolean => {
    return !excludedPaths.includes(folderPath)
  }, [excludedPaths])

  return {
    enabled: excludedPaths.length > 0,
    excludedPaths,
    isLoading,
    removePath,
    addPath,
    disable,
    isCheckedOut,
    refresh: loadState,
  }
}
