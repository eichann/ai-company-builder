import { useCallback } from 'react'
import { useAppStore } from '../stores/appStore'

interface FileOperationResult {
  success: boolean
  error?: string
}

export function useFileOperations() {
  const { addFileTreeEntry, removeFileTreeEntry, triggerFileTreeRefresh } = useAppStore()

  const createFile = useCallback(
    async (parentPath: string, fileName: string): Promise<FileOperationResult> => {
      try {
        const newPath = `${parentPath}/${fileName}`
        const success = await window.electronAPI.writeFile(newPath, '')
        if (success) {
          addFileTreeEntry(parentPath, {
            name: fileName,
            path: newPath,
            isDirectory: false,
          })
          return { success: true }
        }
        return { success: false, error: 'Failed to create file' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [addFileTreeEntry]
  )

  const createFolder = useCallback(
    async (parentPath: string, folderName: string): Promise<FileOperationResult> => {
      try {
        const newPath = `${parentPath}/${folderName}`
        const success = await window.electronAPI.createDirectory(newPath)
        if (success) {
          addFileTreeEntry(parentPath, {
            name: folderName,
            path: newPath,
            isDirectory: true,
            children: [],
          })
          return { success: true }
        }
        return { success: false, error: 'Failed to create folder' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [addFileTreeEntry]
  )

  const deleteItem = useCallback(
    async (itemPath: string): Promise<FileOperationResult> => {
      try {
        const result = await window.electronAPI.deleteItem(itemPath)
        if (result.success) {
          removeFileTreeEntry(itemPath)
          return { success: true }
        }
        return { success: false, error: result.error || 'Failed to delete item' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [removeFileTreeEntry]
  )

  const renameItem = useCallback(
    async (oldPath: string, newName: string): Promise<FileOperationResult> => {
      try {
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'))
        const newPath = `${parentPath}/${newName}`
        const result = await window.electronAPI.renameItem(oldPath, newPath)
        if (result.success) {
          triggerFileTreeRefresh()
          return { success: true }
        }
        return { success: false, error: result.error || 'Failed to rename item' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [triggerFileTreeRefresh]
  )

  const moveItem = useCallback(
    async (sourcePath: string, destPath: string): Promise<FileOperationResult> => {
      try {
        const result = await window.electronAPI.moveItem(sourcePath, destPath)
        if (result.success) {
          triggerFileTreeRefresh()
          return { success: true }
        }
        return { success: false, error: result.error || 'Failed to move item' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [triggerFileTreeRefresh]
  )

  const copyItem = useCallback(
    async (sourcePath: string, destPath: string): Promise<FileOperationResult> => {
      try {
        const result = await window.electronAPI.copyItem(sourcePath, destPath)
        if (result.success) {
          triggerFileTreeRefresh()
          return { success: true }
        }
        return { success: false, error: result.error || 'Failed to copy item' }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    [triggerFileTreeRefresh]
  )

  const copyPathToClipboard = useCallback(async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
    } catch {
      // Fallback for HTTP environments
      const textArea = document.createElement('textarea')
      textArea.value = path
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
      } catch {
        window.prompt('パスをコピーしてください:', path)
      }
      document.body.removeChild(textArea)
    }
  }, [])

  return {
    createFile,
    createFolder,
    deleteItem,
    renameItem,
    moveItem,
    copyItem,
    copyPathToClipboard,
  }
}
