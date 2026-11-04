import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

interface Options {
  openFiles: string[]
  setOpenFiles: Dispatch<SetStateAction<string[]>>
  activeFilePath: string | null
  setActiveFilePath: Dispatch<SetStateAction<string | null>>
}

/**
 * Opening, pinning and closing file tabs. A single click opens a preview tab
 * (italic) that the next single click replaces; a double click or an edit pins it.
 */
export function useEditorTabs({ openFiles, setOpenFiles, activeFilePath, setActiveFilePath }: Options) {
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null)

  // Replaces existing preview tab; already-pinned files just get activated
  const openFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      const alreadyOpen = prev.includes(filePath)
      if (alreadyOpen) return prev // Already open — just activate
      // Replace existing preview tab with new preview
      const filtered = previewFilePath ? prev.filter(f => f !== previewFilePath) : prev
      return [...filtered, filePath]
    })
    setPreviewFilePath(prev => {
      // Don't overwrite if file is already pinned (open and not the current preview)
      if (openFiles.includes(filePath) && prev !== filePath) return prev
      return filePath
    })
    setActiveFilePath(filePath)
  }, [previewFilePath, openFiles, setOpenFiles, setActiveFilePath])

  const pinFile = useCallback((filePath: string) => {
    setPreviewFilePath(prev => prev === filePath ? null : prev)
  }, [])

  const selectFile = useCallback((filePath: string) => {
    setActiveFilePath(filePath)
  }, [setActiveFilePath])

  const closeFile = useCallback((filePath: string) => {
    setPreviewFilePath(prev => prev === filePath ? null : prev)
    setOpenFiles(prev => {
      const newFiles = prev.filter(f => f !== filePath)
      // If closing the active file, switch to another
      if (filePath === activeFilePath) {
        const index = prev.indexOf(filePath)
        const nextFile = newFiles[Math.min(index, newFiles.length - 1)] || null
        setActiveFilePath(nextFile)
      }
      return newFiles
    })
  }, [activeFilePath, setOpenFiles, setActiveFilePath])

  /** Closes several tabs at once (「タブを片づける」, a task checked off); the active one moves to a tab that stays. */
  const closeTabs = useCallback((keys: readonly string[]) => {
    const gone = new Set(keys)
    setPreviewFilePath(prev => prev && gone.has(prev) ? null : prev)
    setOpenFiles(prev => {
      if (!prev.some(k => gone.has(k))) return prev // none of them open (a task checked off with no tab)
      const next = prev.filter(k => !gone.has(k))
      setActiveFilePath(active => active && !gone.has(active) ? active : (next[next.length - 1] ?? null))
      return next
    })
  }, [setOpenFiles, setActiveFilePath])

  /** Opens several tabs for good (片づけたタブ restored), the first one shown. */
  const openTabs = useCallback((keys: readonly string[]) => {
    if (keys.length === 0) return
    setOpenFiles(prev => [...prev, ...keys.filter((k, i) => !prev.includes(k) && keys.indexOf(k) === i)])
    setPreviewFilePath(prev => prev && keys.includes(prev) ? null : prev)
    setActiveFilePath(keys[0])
  }, [setOpenFiles, setActiveFilePath])

  return { previewFilePath, openFile, pinFile, selectFile, closeFile, closeTabs, openTabs }
}
