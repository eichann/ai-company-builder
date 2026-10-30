import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fileNameProblem, folderPathProblem, NAME_TAKEN_MESSAGE } from '../../../../shared/file-names'
import { lastSegment } from '../../../../shared/private-folder-ui'
import { createDirectory, createEmptyFile, deleteItem, getStats, renameItem, reservedPathRefusal } from '../api'
import type { FileEntry, FileTreeModel } from '../fileTreeModel'
import type { SetSelectedPaths } from './useTreeSelection'
import type { usePrivateFolders } from './usePrivateFolders'

const parentDir = (p: string) => p.substring(0, p.lastIndexOf('/'))

/** Something is at `path` already (getStats rejects or fails when nothing is). */
async function isTaken(path: string): Promise<boolean> {
  try {
    return (await getStats(path)).success
  } catch {
    return false
  }
}

/** Main's own refusals are sentences for the member (Japanese); a raw system error is not shown as is. */
function failureMessage(mode: 'newFile' | 'newFolder' | 'rename', detail?: string): string {
  const what = mode === 'rename' ? '名前を変更できませんでした。' : mode === 'newFolder' ? 'フォルダを作れませんでした。' : 'ファイルを作れませんでした。'
  return detail && /[\u3040-\u30ff\u4e00-\u9fff]/.test(detail) ? detail : `${what}もう一度試してください。`
}

interface InputDialogState {
  isOpen: boolean
  title: string
  defaultValue: string
  mode: 'newFile' | 'newFolder' | 'rename'
  targetPath: string
  parentPath: string
  /** Why the typed name was refused; the dialog stays open. */
  error: string | null
}

interface DeleteDialogState {
  isOpen: boolean
  title: string
  message: string
  targetPath: string
  targetPaths?: string[]
}

interface Deps {
  model: FileTreeModel
  privateFolders: ReturnType<typeof usePrivateFolders>
  setSelectedPaths: SetSelectedPaths
  showChangeIn: (dir: string, open?: boolean) => Promise<void>
  refuseNotDownloaded: (absTarget: string) => boolean
  closeContextMenu: () => void
  warn: (message: string, ms: number) => void
}

/**
 * New file / folder, rename, delete and copy path, with their dialogs and the
 * refusals in front of every write (not downloaded, a name a private folder
 * uses, a private folder itself). The main process refuses these writes too.
 */
export function useFileOperations({ model, privateFolders, setSelectedPaths, showChangeIn, refuseNotDownloaded, closeContextMenu, warn }: Deps) {
  const { t } = useTranslation()
  const [newFolder, setNewFolder] = useState<{ parentPath: string } | null>(null)
  const [inputDialog, setInputDialog] = useState<InputDialogState>({
    isOpen: false,
    title: '',
    defaultValue: '',
    mode: 'newFile',
    targetPath: '',
    parentPath: '',
    error: null,
  })
  const [confirmDialog, setConfirmDialog] = useState<DeleteDialogState>({
    isOpen: false,
    title: '',
    message: '',
    targetPath: '',
  })

  /**
   * Refuse a folder name that a private folder the member cannot read already
   * uses (known to the main process only as a salted hash). The sentence names
   * only what the member typed.
   */
  const refuseReserved = useCallback(async (absTarget: string): Promise<boolean> => {
    let message: string | null = null
    try { message = await reservedPathRefusal(absTarget) } catch { /* older preload / preview: allow */ }
    if (!message) return false
    warn(message, 6000)
    return true
  }, [warn])

  /** A private folder itself cannot be moved or renamed here (it is its own repository on the server). */
  const refusePrivateRoot = useCallback((absPath: string, action: '移動' | '名前の変更'): boolean => {
    const root = privateFolders.privateRootAt(absPath)
    if (!root) return false
    warn(`非公開フォルダ「${lastSegment(root.path)}」そのものは、${action}ができません。必要なときは管理者に相談してください。`, 6000)
    return true
  }, [privateFolders, warn])

  const newFile = useCallback((parentPath: string) => {
    if (refuseNotDownloaded(`${parentPath}/_`)) { closeContextMenu(); return }
    setInputDialog({
      isOpen: true,
      title: t('fileTree.newFile'),
      defaultValue: '',
      mode: 'newFile',
      targetPath: '',
      parentPath,
      error: null,
    })
    closeContextMenu()
  }, [closeContextMenu, t, refuseNotDownloaded])

  const newFolderIn = useCallback((parentPath: string) => {
    if (refuseNotDownloaded(`${parentPath}/_`)) { closeContextMenu(); return }
    setNewFolder({ parentPath })
    closeContextMenu()
  }, [closeContextMenu, refuseNotDownloaded])

  const rename = useCallback((entry: FileEntry) => {
    if (refusePrivateRoot(entry.path, '名前の変更')) { closeContextMenu(); return }
    setInputDialog({
      isOpen: true,
      title: t('fileTree.rename'),
      defaultValue: entry.name,
      mode: 'rename',
      targetPath: entry.path,
      parentPath: parentDir(entry.path),
      error: null,
    })
    closeContextMenu()
  }, [closeContextMenu, t, refusePrivateRoot])

  const askDelete = useCallback((entry: FileEntry) => {
    const message = t('fileTree.deleteMessage', { name: entry.name }) +
      (entry.isDirectory ? ' ' + t('fileTree.deleteFolderMessage') : '') +
      ' ' + t('fileTree.deleteWarning')
    setConfirmDialog({
      isOpen: true,
      title: t('fileTree.deleteConfirm'),
      message,
      targetPath: entry.path,
    })
    closeContextMenu()
  }, [closeContextMenu, t])

  /** The multi-select menu's delete: `paths` is the selection at the right-click. */
  const askDeleteMany = useCallback((paths: string[]) => {
    setSelectedPaths(new Set(paths))
    const count = paths.length
    const hasFolders = paths.some(p => model.isDirectory(p))
    const message = `${count}件のアイテムを削除しますか？` +
      (hasFolders ? ' フォルダを含む場合、中身もすべて削除されます。' : '') +
      ' この操作は取り消せません。'
    setConfirmDialog({
      isOpen: true,
      title: `${count}件を削除`,
      message,
      targetPath: '',
      targetPaths: paths,
    })
    closeContextMenu()
  }, [closeContextMenu, model, setSelectedPaths])

  const copyPath = useCallback(async (entry: FileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path)
    } catch {
      // Fallback for HTTP
      const textArea = document.createElement('textarea')
      textArea.value = entry.path
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
      } catch {
        window.prompt('パスをコピーしてください:', entry.path)
      }
      document.body.removeChild(textArea)
    }
    closeContextMenu()
  }, [closeContextMenu])

  const confirmInput = useCallback(async (value: string) => {
    const { mode, targetPath, parentPath } = inputDialog
    const refuse = (error: string) => setInputDialog(prev => ({ ...prev, error }))

    const problem = mode === 'newFolder' ? folderPathProblem(value) : fileNameProblem(value)
    if (problem) { refuse(problem); return }
    const newPath = `${parentPath}/${value}`
    if (mode === 'rename' && newPath === targetPath) { setInputDialog(prev => ({ ...prev, isOpen: false })); return }

    // A name with a '/' could still lead into a folder that is not downloaded.
    if (refuseNotDownloaded(newPath) || await refuseReserved(newPath)) {
      setInputDialog(prev => ({ ...prev, isOpen: false }))
      return
    }

    // Main refuses to replace anything too; the check here keeps the dialog's sentence the same.
    const result = mode === 'newFile' ? await createEmptyFile(newPath)
      : mode === 'newFolder' ? (await isTaken(newPath) ? { success: false, error: NAME_TAKEN_MESSAGE } : { success: await createDirectory(newPath) })
      : await renameItem(targetPath, newPath)
    if (!result.success) {
      refuse(result.error && 'code' in result && result.code === 'name_taken' ? result.error : failureMessage(mode, result.error))
      return
    }

    // Show it at once (the watcher reports it too) and open the parent so the new item is visible.
    await showChangeIn(parentPath, true)

    setInputDialog(prev => ({ ...prev, isOpen: false }))
  }, [inputDialog, showChangeIn, refuseNotDownloaded, refuseReserved])
  const cancelInput = () => setInputDialog(prev => ({ ...prev, isOpen: false, error: null }))

  /** 公開 (or inside a private folder) from 「新しいフォルダ…」: on disk, as before. */
  const createPlainFolder = useCallback(async (parentPath: string, name: string) => {
    const target = `${parentPath}/${name}`
    if (refuseNotDownloaded(target) || await refuseReserved(target)) { setNewFolder(null); return null }
    const problem = folderPathProblem(name) ?? (await isTaken(target) ? NAME_TAKEN_MESSAGE : null)
    if (problem) return problem
    if (!await createDirectory(target)) return failureMessage('newFolder')
    await showChangeIn(parentPath, true)
    setNewFolder(null)
    return null
  }, [showChangeIn, refuseNotDownloaded, refuseReserved])

  const confirmDelete = useCallback(async () => {
    const paths = confirmDialog.targetPaths || [confirmDialog.targetPath]
    const affectedParents = new Set<string>()
    const failed: string[] = []

    for (const p of paths) {
      const result = await deleteItem(p).catch(() => ({ success: false }))
      if (!result.success) failed.push(p)
      affectedParents.add(parentDir(p))
    }

    // What could not be deleted stays selected, so the member sees which ones.
    setSelectedPaths(new Set(failed))
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    await Promise.all([...affectedParents].map(dir => model.invalidate(dir)))
    if (failed.length > 0) {
      const names = failed.map(p => `「${p.slice(p.lastIndexOf('/') + 1)}」`).join('、')
      warn(`${names}を削除できませんでした。${failed.length < paths.length ? 'ほかのものは削除しました。' : ''}開いているアプリがあれば閉じてから、もう一度試してください。`, 8000)
    }
  }, [confirmDialog, model, setSelectedPaths, warn])
  const cancelDelete = () => setConfirmDialog(prev => ({ ...prev, isOpen: false }))

  return {
    inputDialog, confirmInput, cancelInput,
    confirmDialog, confirmDelete, cancelDelete,
    newFolder, setNewFolder, createPlainFolder,
    newFile, newFolderIn, rename, askDelete, askDeleteMany, copyPath,
    refuseReserved, refusePrivateRoot,
  }
}
