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

  return { previewFilePath, openFile, pinFile, selectFile, closeFile }
}
