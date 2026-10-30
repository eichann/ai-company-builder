// Sync's access to the main process, as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts), one per capability. Every function takes
// its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Reading the backups sync and the editor kept on this computer (`.backups/`). */
export type BackupReads = ElectronPort<'backupList'>
/** Putting a backed-up file back into the company folder (overwrites the file there). */
export type BackupWrites = ElectronPort<'backupRestore'>
/** Opening a backup folder in Finder / Explorer: hands the folder to another app. */
export type BackupOutbound = ElectronPort<'backupOpenFolder'>

export function listBackups(rootPath: string, reads: BackupReads = window.electronAPI) {
  return reads.backupList(rootPath)
}

export function restoreBackupFile(rootPath: string, backupId: string, filePath: string, writes: BackupWrites = window.electronAPI) {
  return writes.backupRestore(rootPath, backupId, filePath)
}

/** Main opens only a backup folder inside a company (anything else could be launched). */
export function openBackupFolder(backupPath: string, outbound: BackupOutbound = window.electronAPI) {
  return outbound.backupOpenFolder(backupPath)
}
