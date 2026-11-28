import { useCallback, useEffect, useRef, useState } from 'react'
import { backupBeforeOverwrite, backupEdits, createDirectory, readFile, writeFile, saveRefusal } from '../api'
import { canAutosave, decideCompareChoice, decideSave, isDirty } from '../../../../shared/editor-disk-state'
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
  /** Brings a tab to the front (closing a tab changed on disk shows its compare view instead). */
  showFile: (filePath: string) => void
}

/**
 * Saving: autosave a second after the last keystroke, an explicit save
 * (`editor.save`, ⌘S), saving before a tab closes, and the compare view's two choices
 * (［自分の版を保存］ / ［届いた版を採用］) — never silently over someone else's version, and
 * the version not picked is kept in the backups first (files-and-editor.md, External changes).
 */
export function useFileSaving({ activeFilePath, fileContents, fileContentsRef, updateFile, rootPath, setError, setNotice, showFile }: Deps) {
  const [, setIsSaving] = useState(false)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const activeFile = activeFilePath ? fileContents.get(activeFilePath) : null
  const hasChanges = activeFile ? activeFile.content !== activeFile.originalContent : false

  const askConfirm = useCallback((request: Omit<ConfirmRequest, 'resolve'>) =>
    new Promise<boolean>(resolve => setConfirmRequest({ ...request, resolve })), [])

  const markSaved = useCallback((filePath: string, content: string) => updateFile(filePath, f => ({
    ...f, originalContent: content, missing: false, external: undefined, comparing: false, changedWhileComparing: false, keepFailed: false,
  })), [updateFile])

  /**
   * Save `content`, never silently over someone else's version: the disk is
   * compared with the version this tab loaded first (decideSave). At a
   * difference nothing is written: the banner shows and, for a save the member
   * asked for, the compare view opens (they pick a version there).
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

      if (decision.action === 'already-saved') {
        markSaved(filePath, content)
        return true
      }

      if (decision.action === 'ask') {
        // Show the banner whatever happens next, so the change is never unnoticed.
        updateFile(filePath, f => ({
          ...f,
          external: { kind: 'changed', diskContent: decision.diskContent },
          missing: false,
          ...(interactive ? { comparing: true, changedWhileComparing: false } : {}),
        }))
        return false
      }

      if (decision.recreate) {
        // The file (or its folder) was deleted: saving puts it back.
        const parent = filePath.substring(0, filePath.lastIndexOf('/'))
        if (parent) await createDirectory(parent)
      }

      const success = await writeFile(filePath, content)
      if (success) {
        markSaved(filePath, content)
        return true
      }
      setError(await saveRefusal(filePath) ?? '保存に失敗しました')
      return false
    } catch {
      setError('保存できませんでした。少し待ってから、もう一度保存してください')
      return false
    } finally {
      setIsSaving(false)
    }
  }, [markSaved, updateFile, fileContentsRef, setError])

  /**
   * The disk at the press of a compare button, against the version the member
   * was shown. Resolves true when that version is still on disk; otherwise the
   * tab is updated (saved already, or compare again) and nothing is replaced.
   */
  const stillShown = useCallback(async (filePath: string, compared: string): Promise<boolean> => {
    const current = fileContentsRef.current.get(filePath)
    if (!current) return false
    const decision = decideCompareChoice(current, compared, await readFile(filePath))
    if (decision.action === 'go') return true
    if (decision.action === 'already-saved') markSaved(filePath, current.content)
    else {
      updateFile(filePath, f => ({
        ...f,
        external: decision.external,
        missing: decision.external.kind === 'deleted',
        comparing: decision.external.kind === 'changed',
        changedWhileComparing: decision.external.kind === 'changed',
      }))
    }
    return false
  }, [fileContentsRef, markSaved, updateFile])

  /**
   * ［自分の版を保存］: keep the version that arrived in the backups, then write
   * the tab's edits — in one press. No backup, no write.
   */
  const saveMine = useCallback(async (filePath: string, compared: string): Promise<boolean> => {
    const content = fileContentsRef.current.get(filePath)?.content
    if (content === undefined) return false
    setError(null)
    try {
      if (!await stillShown(filePath, compared)) return false
      const backup = rootPath ? await backupBeforeOverwrite(rootPath, filePath) : null
      // 'missing': the file went after the check — there is nothing on disk to lose.
      if (!backup?.success || (!backup.backupPath && backup.skipped !== 'missing')) {
        setError('届いた版をバックアップに残せなかったため、保存していません。あなたの編集はこのタブにそのまま残っています。')
        updateFile(filePath, f => ({ ...f, keepFailed: true }))
        return false
      }
      // Changed again while it was being kept: what was kept is not what the member saw.
      if (!await stillShown(filePath, compared)) return false
      if (!await writeFile(filePath, content)) {
        setError(await saveRefusal(filePath) ?? '保存に失敗しました')
        return false
      }
      markSaved(filePath, content)
      setNotice('あなたの版を保存しました。届いた版はバックアップに残しています（タイトルバーの［バックアップ履歴］で見られます）')
      return true
    } catch {
      setError('保存できませんでした。少し待ってから、もう一度選んでください')
      return false
    }
  }, [fileContentsRef, stillShown, rootPath, markSaved, setError, setNotice])

  /**
   * ［届いた版を採用］: keep the tab's edits in the backups, then show the version
   * that arrived — in one press, no confirm. No backup, edits stay.
   */
  const takeArrived = useCallback(async (filePath: string, compared: string): Promise<boolean> => {
    const edits = fileContentsRef.current.get(filePath)?.content
    if (edits === undefined) return false
    setError(null)
    try {
      if (!await stillShown(filePath, compared)) return false
      const backup = rootPath ? await backupEdits(rootPath, filePath, edits) : null
      if (!backup?.success || !backup.backupPath) {
        setError('あなたの編集をバックアップに残せなかったため、届いた版にしていません。あなたの編集はこのタブにそのまま残っています。')
        updateFile(filePath, f => ({ ...f, keepFailed: true }))
        return false
      }
      // Typing went on while the edits were being kept: what was kept is not all of them.
      if (fileContentsRef.current.get(filePath)?.content !== edits) {
        setError('残している間に編集が続いたため、届いた版にしていません。もう一度選んでください。')
        return false
      }
      // Changed again while the edits were being kept: show that one to compare, replace nothing.
      if (!await stillShown(filePath, compared)) return false
      const now = fileContentsRef.current.get(filePath)?.external
      if (now?.kind !== 'changed' || now.diskContent !== compared) return false
      // A watcher event in the meantime is newer than the read above: never mark it clean.
      updateFile(filePath, f => (f.content !== edits || f.external?.kind !== 'changed' || f.external.diskContent !== compared ? f : {
        ...f, content: compared, originalContent: compared, missing: false, external: undefined, comparing: false, changedWhileComparing: false, keepFailed: false,
      }))
      setNotice('届いた版にしました。あなたの編集はバックアップに残しています（タイトルバーの［バックアップ履歴］で見られます）')
      return true
    } catch {
      setError('届いた版にできませんでした。少し待ってから、もう一度選んでください')
      return false
    }
  }, [fileContentsRef, stillShown, rootPath, updateFile, setError, setNotice])

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

  /**
   * Saves before closing; resolves false to keep the tab open. A file changed
   * on disk is not closed: its compare view opens (`showFile`) so the member picks —
   * unless neither version could be kept there (`keepFailed`): then, and only then,
   * closing without saving is offered, saying the edits will not be kept.
   */
  const saveBeforeClose = async (path: string): Promise<boolean> => {
    const file = fileContents.get(path)
    if (file && !file.isLoading && isDirty(file)) {
      const saved = await saveFile(path, file.content, { interactive: true })
      const now = fileContentsRef.current.get(path)
      if (!saved && now?.external?.kind === 'changed') {
        if (!now.keepFailed) {
          showFile(path)
          return false
        }
        return askConfirm({
          title: '保存せずに閉じますか？',
          message: 'このファイルは、どちらの版もバックアップに残せませんでした。\n閉じると、この編集は残りません（バックアップ履歴にも入りません）。',
          confirmText: '保存せずに閉じる',
          danger: true,
        })
      }
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

  return { hasChanges, handleSave, saveMine, takeArrived, saveBeforeClose, confirmRequest, answerConfirm }
}
