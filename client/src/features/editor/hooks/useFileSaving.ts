import { useCallback, useEffect, useRef, useState } from 'react'
import { backupBeforeOverwrite, createDirectory, readFile, writeFile } from '../api'
import { canAutosave, decideSave, isDirty } from '../../../../shared/editor-disk-state'
import { registerUnsavedEditsSaver } from '../../../shared/lib/unsavedEdits'
import type { OpenFile } from './useOpenFiles'

export interface ConfirmRequest {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

interface Deps {
  activeFilePath: string | null
  fileContents: Map<string, OpenFile>
  fileContentsRef: React.MutableRefObject<Map<string, OpenFile>>
  updateFile: (filePath: string, update: (f: OpenFile) => OpenFile) => void
  rootPath: string | null
  setError: (message: string | null) => void
  setNotice: (message: string | null) => void
}

/**
 * Saving: autosave a second after the last keystroke, an explicit save
 * (`editor.save`, ⌘S), saving before a tab closes, and loading the disk version instead — each one never silently over
 * someone else's version (files-and-editor.md, External changes).
 */
export function useFileSaving({ activeFilePath, fileContents, fileContentsRef, updateFile, rootPath, setError, setNotice }: Deps) {
  const [, setIsSaving] = useState(false)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const activeFile = activeFilePath ? fileContents.get(activeFilePath) : null
  const hasChanges = activeFile ? activeFile.content !== activeFile.originalContent : false

  const askConfirm = useCallback((request: Omit<ConfirmRequest, 'resolve'>) =>
    new Promise<boolean>(resolve => setConfirmRequest({ ...request, resolve })), [])

  /**
   * Save `content`, never silently over someone else's version: the disk is
   * compared with the version this tab loaded first (decideSave). Autosave
   * (`interactive: false`) stops at a difference and shows the banner; an
   * explicit save asks, backs the disk version up, then overwrites.
   * Resolves true when the content is on disk.
   */
  const saveFile = useCallback(async (filePath: string, content: string, { interactive }: { interactive: boolean }): Promise<boolean> => {
    const current = fileContentsRef.current.get(filePath)
    if (!current) return false
    setIsSaving(true)
    setError(null)
    try {
      const disk = await readFile(filePath)
      const decision = decideSave({ ...current, content }, disk)
      const markSaved = () => updateFile(filePath, f => ({ ...f, originalContent: content, missing: false, external: undefined, keepMine: false }))

      if (decision.action === 'already-saved') {
        markSaved()
        return true
      }

      if (decision.action === 'ask') {
        // Show the banner whatever happens next, so the change is never unnoticed.
        updateFile(filePath, f => ({ ...f, external: { kind: 'changed', diskContent: decision.diskContent }, missing: false }))
        if (!interactive) return false
        const ok = await askConfirm({
          title: 'このファイルは外部で変更されています',
          message: 'このタブで開いてから、AI やほかのメンバーの同期などでファイルの内容が変わりました。\n上書きすると、いまのディスクの内容はバックアップ（.backups、非公開フォルダならその専用の場所）に保存してから、あなたの編集で置き換えます。',
          confirmText: '外部の変更を上書きして保存',
          danger: true,
        })
        if (!ok) return false
        if (rootPath) {
          const backup = await backupBeforeOverwrite(rootPath, filePath)
          if (!backup.success) {
            setError('外部の変更をバックアップできなかったため、保存を中止しました。')
            return false
          }
          if (backup.backupPath) {
            setNotice(`外部で変更された内容をバックアップしてから上書きしました（${backup.backupPath}）`)
          }
        }
      }

      if (decision.action === 'write' && decision.recreate) {
        // The file (or its folder) was deleted: saving puts it back.
        const parent = filePath.substring(0, filePath.lastIndexOf('/'))
        if (parent) await createDirectory(parent)
      }

      const success = await writeFile(filePath, content)
      if (success) {
        markSaved()
        return true
      }
      setError('保存に失敗しました')
      return false
    } catch {
      setError('保存中にエラーが発生しました')
      return false
    } finally {
      setIsSaving(false)
    }
  }, [askConfirm, rootPath, updateFile, fileContentsRef, setError, setNotice])

  // Auto save with debounce (1 second after last keystroke) — paused while
  // something changed on disk that the member has not decided about.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!activeFilePath) return
    const file = fileContents.get(activeFilePath)
    if (!file || file.isLoading || !canAutosave(file)) return

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = setTimeout(() => {
      void saveFile(activeFilePath, file.content, { interactive: false })
    }, 1000)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [activeFilePath, fileContents, saveFile])

  const handleSave = useCallback(async () => {
    if (!activeFilePath || !hasChanges) return
    // Cancel pending auto save and save immediately
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    const file = fileContents.get(activeFilePath)
    if (!file) return
    await saveFile(activeFilePath, file.content, { interactive: true })
  }, [activeFilePath, hasChanges, fileContents, saveFile])

  /** 「ディスクの内容を読み込む」: drop the tab's edits (after a confirm) for the disk version. Resolves true when loaded. */
  const loadDiskVersion = useCallback(async (filePath: string): Promise<boolean> => {
    const ok = await askConfirm({
      title: 'ディスクの内容を読み込みますか？',
      message: 'このタブでの編集内容は破棄され、いまのディスクの内容に置き換わります。',
      confirmText: '編集を破棄して読み込む',
      danger: true,
    })
    if (!ok) return false
    const disk = await readFile(filePath)
    if (disk === null) {
      setError('ファイルを読み込めませんでした（削除された可能性があります）')
      return false
    }
    updateFile(filePath, f => ({ ...f, content: disk, originalContent: disk, missing: false, external: undefined, keepMine: false }))
    return true
  }, [askConfirm, updateFile, setError])

  /** Saves before closing — asking first if the file changed on disk; resolves false to keep the tab open. */
  const saveBeforeClose = async (path: string): Promise<boolean> => {
    const file = fileContents.get(path)
    if (file && !file.isLoading && isDirty(file)) {
      const saved = await saveFile(path, file.content, { interactive: true })
      if (!saved) {
        const discard = await askConfirm({
          title: '保存せずに閉じますか？',
          message: 'このタブでの編集内容は保存されていません。閉じると失われます。',
          confirmText: '保存せずに閉じる',
          danger: true,
        })
        if (!discard) return false
      }
    }
    return true
  }

  // Leaving (sign-out, closing the window): write every tab with edits, not
  // only the shown one, without asking; what cannot be saved that way (changed
  // on disk meanwhile, the write failed) is answered so the caller can ask.
  useEffect(() => registerUnsavedEditsSaver(async () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    const left: string[] = []
    for (const [path, file] of fileContentsRef.current) {
      if (file.isLoading || !isDirty(file)) continue
      if (!await saveFile(path, file.content, { interactive: false })) left.push(path)
    }
    return left
  }), [saveFile, fileContentsRef])

  const answerConfirm = (ok: boolean) => { confirmRequest?.resolve(ok); setConfirmRequest(null) }

  return { hasChanges, handleSave, loadDiskVersion, saveBeforeClose, confirmRequest, answerConfirm }
}
