import { useCallback, useEffect, useRef, useState } from 'react'
import { readFile } from '../api'
import { isBinaryFile } from '../fileKinds'
import { subscribeFileChanges } from '../../../shared/lib/fileEvents'
import { normalizePathSeparators } from '../../../shared/lib/path'
import { publishUnsavedEdits } from '../../../shared/lib/unsavedEdits'
import { applyDiskDecision, decideOnDiskEvent, isDirty, type EditorFileState } from '../../../../shared/editor-disk-state'

/**
 * An open tab. `originalContent` is the disk version the tab last loaded or
 * saved; `external` is set while the tab has edits and the disk changed (or
 * the file was deleted) meanwhile — see shared/editor-disk-state.ts.
 */
export interface OpenFile extends EditorFileState {
  path: string
  isLoading: boolean
  /** The member chose 「自分の編集を残す」: the banner stays, in its short form, until saved. */
  keepMine?: boolean
}

/**
 * The text of every open tab: loaded when a tab opens, dropped when it
 * closes, and kept in step with the disk through the company's watcher
 * (`reviewReloadRef` runs when a review sidecar of the active file changes).
 */
export function useOpenFiles(
  openFiles: string[],
  activeFilePath: string | null,
  reviewReloadRef: React.MutableRefObject<() => void>,
  setError: (message: string | null) => void,
) {
  const [fileContents, setFileContents] = useState<Map<string, OpenFile>>(new Map())
  const loadingRef = useRef<Set<string>>(new Set())

  // Automatic sync waits while a tab holds edits not yet on disk.
  useEffect(() => {
    publishUnsavedEdits([...fileContents].filter(([, f]) => !f.isLoading && isDirty(f)).map(([p]) => p))
  }, [fileContents])
  useEffect(() => () => publishUnsavedEdits([]), [])

  // Ref to access latest fileContents inside onFileChange callback
  const fileContentsRef = useRef<Map<string, OpenFile>>(fileContents)
  fileContentsRef.current = fileContents

  const activeFilePathRef = useRef(activeFilePath)
  activeFilePathRef.current = activeFilePath

  // Reload open files when changed on disk (e.g. by the AI agent). A file the
  // AI replaces (write a temp file, rename it over) arrives as 'add', a
  // deleted one as 'unlink' (for a folder possibly only the folder's path).
  useEffect(() => {
    const reload = async (changedPath: string) => {
      // Event paths use the platform's separators; tab paths may not (Windows).
      const key = normalizePathSeparators(changedPath)
      const filePath = [...fileContentsRef.current.keys()].find(p => normalizePathSeparators(p) === key)
      const file = filePath ? fileContentsRef.current.get(filePath) : undefined
      if (!filePath || !file || file.isLoading) return
      if (isBinaryFile(filePath)) {
        // Images and PDFs follow their file version; only the deleted mark changes here.
        if (file.missing) {
          setFileContents(prev => {
            const cur = prev.get(filePath)
            if (!cur?.missing) return prev
            const next = new Map(prev)
            next.set(filePath, { ...cur, missing: false })
            return next
          })
        }
        return
      }
      // Clean tab → show the disk version; tab with edits → never overwrite
      // them: show the banner and pause autosave (decideOnDiskEvent).
      try {
        const disk = await readFile(filePath)
        setFileContents(prev => {
          const cur = prev.get(filePath)
          if (!cur || cur.isLoading) return prev
          const updated = applyDiskDecision(cur, decideOnDiskEvent(cur, disk))
          if (updated === cur) return prev
          const next = new Map(prev)
          next.set(filePath, updated.external ? updated : { ...updated, keepMine: false })
          return next
        })
      } catch {
        // Silently ignore read errors during external change detection
      }
    }

    // 'unlink' may name a folder: every open file at or under it is gone.
    const markMissing = (removed: string) => {
      const key = normalizePathSeparators(removed)
      setFileContents(prev => {
        let next: Map<string, OpenFile> | null = null
        for (const [p, f] of prev) {
          const k = normalizePathSeparators(p)
          if (f.isLoading || !(k === key || k.startsWith(`${key}/`))) continue
          const updated = isBinaryFile(p)
            ? (f.missing ? f : { ...f, missing: true })
            : applyDiskDecision(f, decideOnDiskEvent(f, null))
          if (updated !== f) {
            next ??= new Map(prev)
            next.set(p, updated)
          }
        }
        return next ?? prev
      })
    }

    return subscribeFileChanges((changes) => {
      for (const data of changes) {
        const changedPath = data.path

        // Reload review data when a review or reply sidecar file changes
        const reviewMatch = changedPath.match(/^(.+)\.review\.[^/]+\.json$/) || changedPath.match(/^(.+)\.reply\.[^/]+\.json$/)
        if (reviewMatch) {
          if (reviewMatch[1] === activeFilePathRef.current) {
            reviewReloadRef.current()
          }
          continue
        }

        if (data.type === 'unlink' || data.type === 'unlinkDir') {
          markMissing(changedPath)
        } else if (data.type === 'change' || data.type === 'add') {
          void reload(changedPath)
        }
      }
    })
  }, [reviewReloadRef])

  const loadFile = async (filePath: string) => {
    setFileContents(prev => {
      const newMap = new Map(prev)
      newMap.set(filePath, {
        path: filePath,
        content: '',
        originalContent: '',
        isLoading: true,
      })
      return newMap
    })

    try {
      const fileContent = await readFile(filePath)
      setFileContents(prev => {
        const newMap = new Map(prev)
        newMap.set(filePath, {
          path: filePath,
          content: fileContent || '',
          originalContent: fileContent || '',
          isLoading: false,
        })
        return newMap
      })
    } catch {
      setError('ファイルの読み込み中にエラーが発生しました')
    } finally {
      loadingRef.current.delete(filePath)
    }
  }

  // Load file content when a new file is opened
  useEffect(() => {
    for (const filePath of openFiles) {
      if (!fileContents.has(filePath) && !loadingRef.current.has(filePath)) {
        // Skip loading for binary files (displayed via local-file:// URL)
        if (isBinaryFile(filePath)) {
          setFileContents(prev => {
            const newMap = new Map(prev)
            newMap.set(filePath, { path: filePath, content: '', originalContent: '', isLoading: false })
            return newMap
          })
          continue
        }
        loadingRef.current.add(filePath)
        loadFile(filePath)
      }
    }

    // Clean up closed files from state
    const openFilesSet = new Set(openFiles)
    setFileContents(prev => {
      const newMap = new Map(prev)
      for (const path of newMap.keys()) {
        if (!openFilesSet.has(path)) {
          newMap.delete(path)
        }
      }
      return newMap
    })
  }, [openFiles])

  const updateFile = useCallback((filePath: string, update: (f: OpenFile) => OpenFile) => {
    setFileContents(prev => {
      const f = prev.get(filePath)
      if (!f) return prev
      const next = new Map(prev)
      next.set(filePath, update(f))
      return next
    })
  }, [])

  /** The member typed in `filePath`. */
  const setContent = useCallback((filePath: string, newContent: string) => {
    setFileContents(prev => {
      const newMap = new Map(prev)
      const file = newMap.get(filePath)
      if (file) {
        newMap.set(filePath, {
          ...file,
          content: newContent,
        })
      }
      return newMap
    })
  }, [])

  return { fileContents, fileContentsRef, updateFile, setContent }
}
