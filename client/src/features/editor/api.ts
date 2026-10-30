// The editor's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Reading an open file on this computer: its text, its bytes (PDF), whether it still exists. */
export type EditorReads = ElectronPort<'readFile' | 'readFileBinary' | 'exists'>
/**
 * Saving on this computer: the file, its folder when it was deleted, and the
 * disk version kept in the backups before overwriting a change made elsewhere.
 */
export type EditorWrites = ElectronPort<'writeFile' | 'createDirectory' | 'backupBeforeOverwrite'>

/** The file's text, or null when it is gone. */
export function readFile(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.readFile(filePath)
}

/** Whether a tab remembered from the last session can be reopened. */
export function fileExists(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.exists(filePath)
}

export function readFileBinary(filePath: string, reads: EditorReads = window.electronAPI) {
  return reads.readFileBinary(filePath)
}

/** True when written. */
export function writeFile(filePath: string, content: string, writes: EditorWrites = window.electronAPI) {
  return writes.writeFile(filePath, content)
}

export function createDirectory(dirPath: string, writes: EditorWrites = window.electronAPI) {
  return writes.createDirectory(dirPath)
}

/** Keeps the disk version (.backups/<ts>_editor_overwrite/, or the private backups). */
export function backupBeforeOverwrite(rootPath: string, filePath: string, writes: EditorWrites = window.electronAPI) {
  return writes.backupBeforeOverwrite(rootPath, filePath)
}
