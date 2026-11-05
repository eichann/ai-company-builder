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
/** Why a save was refused, in a sentence for the member (a skill file they may not change, …). */
export type EditorRefusals = ElectronPort<'reservedPathRefusal'>

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

/** The sentence for a save that failed; null when it failed for another reason, or the question could not be asked. */
export async function saveRefusal(filePath: string, refusals: EditorRefusals = window.electronAPI): Promise<string | null> {
  try {
    return await refusals.reservedPathRefusal(filePath)
  } catch {
    return null
  }
}

export function createDirectory(dirPath: string, writes: EditorWrites = window.electronAPI) {
  return writes.createDirectory(dirPath)
}

/** Keeps the disk version (.backups/<ts>_editor_overwrite/, or the private backups). */
export function backupBeforeOverwrite(rootPath: string, filePath: string, writes: EditorWrites = window.electronAPI) {
  return writes.backupBeforeOverwrite(rootPath, filePath)
}

/** Whether a record a tidied tab points to can still be read (「片づけたタブ」 marks it 「見つかりません」). */
export type TidiedRecordReads = ElectronPort<'getRecordCard'>

/** false only when the server says the record is gone or not readable; unknown (offline) → true. */
export async function recordStillThere(companyId: string, recordId: string, reads: TidiedRecordReads = window.electronAPI): Promise<boolean> {
  const r = await reads.getRecordCard(companyId, recordId).catch(() => null)
  return !(r && !r.success && r.notFound)
}
