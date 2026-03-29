import { useState, useEffect, useCallback } from 'react'

interface UseSparseCheckoutOptions {
  rootPath: string
}

interface UseSparseCheckoutResult {
  /** Whether sparse checkout is enabled for this repo */
  enabled: boolean
  /** List of checked-out folder paths (empty if not sparse) */
  checkedOutPaths: string[]
  /** Whether the initial check is still loading */
  isLoading: boolean
  /** Add a folder to sparse checkout */
  addPath: (folderPath: string) => Promise<boolean>
  /** Remove a folder from sparse checkout */
  removePath: (folderPath: string) => Promise<boolean>
  /** Enable sparse checkout with selected paths */
  enable: (paths: string[]) => Promise<boolean>
  /** Disable sparse checkout (restore all files) */
  disable: () => Promise<boolean>
  /** Check if a specific folder is checked out */
  isCheckedOut: (folderPath: string) => boolean
  /** Refresh the sparse checkout state */
  refresh: () => void
}

export function useSparseCheckout({ rootPath }: UseSparseCheckoutOptions): UseSparseCheckoutResult {
  const [enabled, setEnabled] = useState(false)
  const [checkedOutPaths, setCheckedOutPaths] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadState = useCallback(async () => {
    if (!rootPath) {
      setEnabled(false)
      setCheckedOutPaths([])
      setIsLoading(false)
      return
    }

    try {
      const { enabled: isSparse } = await window.electronAPI.isSparseCheckout(rootPath)
      setEnabled(isSparse)

      if (isSparse) {
        const result = await window.electronAPI.sparseCheckoutList(rootPath)
        if (result.success) {
          setCheckedOutPaths(result.paths)
        }
      } else {
        setCheckedOutPaths([])
      }
    } catch (err) {
      console.error('Failed to load sparse checkout state:', err)
      setEnabled(false)
      setCheckedOutPaths([])
    } finally {
      setIsLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    loadState()
  }, [loadState])

  const addPath = useCallback(async (folderPath: string): Promise<boolean> => {
    if (!rootPath) return false
    try {
      // If not yet sparse, initialize first
      if (!enabled) {
        // Get all current top-level directories + the new one
        const result = await window.electronAPI.listRemoteDirectories(rootPath)
        if (!result.success) return false
        await window.electronAPI.sparseCheckoutInit(rootPath)
        await window.electronAPI.sparseCheckoutSet(rootPath, [...result.directories, folderPath])
      } else {
        await window.electronAPI.sparseCheckoutAdd(rootPath, [folderPath])
      }
      await loadState()
      return true
    } catch (err) {
      console.error('Failed to add sparse checkout path:', err)
      return false
    }
  }, [rootPath, enabled, loadState])

  const removePath = useCallback(async (folderPath: string): Promise<boolean> => {
    if (!rootPath || !enabled) return false
    try {
      const remaining = checkedOutPaths.filter(p => p !== folderPath)
      if (remaining.length === 0) {
        // Can't have empty sparse checkout — disable instead
        await window.electronAPI.sparseCheckoutDisable(rootPath)
      } else {
        await window.electronAPI.sparseCheckoutSet(rootPath, remaining)
      }
      await loadState()
      return true
    } catch (err) {
      console.error('Failed to remove sparse checkout path:', err)
      return false
    }
  }, [rootPath, enabled, checkedOutPaths, loadState])

  const enable = useCallback(async (paths: string[]): Promise<boolean> => {
    if (!rootPath) return false
    try {
      await window.electronAPI.sparseCheckoutInit(rootPath)
      await window.electronAPI.sparseCheckoutSet(rootPath, paths)
      await loadState()
      return true
    } catch (err) {
      console.error('Failed to enable sparse checkout:', err)
      return false
    }
  }, [rootPath, loadState])

  const disableSparse = useCallback(async (): Promise<boolean> => {
    if (!rootPath) return false
    try {
      await window.electronAPI.sparseCheckoutDisable(rootPath)
      await loadState()
      return true
    } catch (err) {
      console.error('Failed to disable sparse checkout:', err)
      return false
    }
  }, [rootPath, loadState])

  const isCheckedOut = useCallback((folderPath: string): boolean => {
    if (!enabled) return true // Not sparse = everything is checked out
    return checkedOutPaths.includes(folderPath)
  }, [enabled, checkedOutPaths])

  return {
    enabled,
    checkedOutPaths,
    isLoading,
    addPath,
    removePath,
    enable,
    disable: disableSparse,
    isCheckedOut,
    refresh: loadState,
  }
}
