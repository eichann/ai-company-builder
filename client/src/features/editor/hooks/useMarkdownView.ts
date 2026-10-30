import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { isMarkdownFile } from '../fileKinds'

export type MdViewMode = 'preview' | 'editor'

/**
 * Where each open file was scrolled (0–1), shared by the code editor and the
 * Markdown preview, so switching tabs or modes comes back to the same place.
 */
export function useScrollMemory(openFiles: string[], activeFilePath: string | null, mdViewMode: MdViewMode) {
  const scrollRatioRef = useRef<Map<string, number>>(new Map())
  const editorViewRef = useRef<EditorView | null>(null)
  const mdPreviewRef = useRef<HTMLDivElement | null>(null)

  // Save current scroll ratio (call BEFORE switching away)
  const saveCurrentScrollPosition = useCallback(() => {
    if (!activeFilePath) return
    const isMdPreview = isMarkdownFile(activeFilePath) && mdViewMode === 'preview'
    if (isMdPreview && mdPreviewRef.current) {
      const el = mdPreviewRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      scrollRatioRef.current.set(activeFilePath, maxScroll > 0 ? el.scrollTop / maxScroll : 0)
    } else if (editorViewRef.current) {
      const dom = editorViewRef.current.scrollDOM
      const maxScroll = dom.scrollHeight - dom.clientHeight
      scrollRatioRef.current.set(activeFilePath, maxScroll > 0 ? dom.scrollTop / maxScroll : 0)
    }
  }, [activeFilePath, mdViewMode])

  // Clean up scroll ratios when files are closed
  useEffect(() => {
    const openFilesSet = new Set(openFiles)
    for (const key of scrollRatioRef.current.keys()) {
      if (!openFilesSet.has(key)) {
        scrollRatioRef.current.delete(key)
      }
    }
  }, [openFiles])

  const ratioOf = (path: string) => scrollRatioRef.current.get(path)

  return { editorViewRef, mdPreviewRef, saveCurrentScrollPosition, ratioOf }
}

/**
 * Markdown files open as source or as a rendered preview; the choice is one
 * for all files and survives restarts (localStorage `mdViewMode`).
 */
export function useMarkdownViewMode() {
  const [mdViewMode, setMdViewMode] = useState<MdViewMode>(() => {
    const saved = localStorage.getItem('mdViewMode')
    return saved === 'preview' || saved === 'editor' ? saved : 'editor'
  })
  const setMdViewModePersisted = useCallback((mode: MdViewMode) => {
    setMdViewMode(mode)
    localStorage.setItem('mdViewMode', mode)
  }, [])
  return { mdViewMode, setMdViewModePersisted }
}

/** ⌘⇧M: toggle the active Markdown file between source and preview. */
export function useToggleViewShortcut(activeFilePath: string | null, mdViewMode: MdViewMode, setMode: (mode: MdViewMode) => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'm') {
        if (!activeFilePath || !isMarkdownFile(activeFilePath)) return
        e.preventDefault()
        setMode(mdViewMode === 'preview' ? 'editor' : 'preview')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeFilePath, mdViewMode, setMode])
}
