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
/** What the next sync would send: main lists the changes without staging anything. */
export type SyncPreviewReads = ElectronPort<'gitPreview'>
/** Undoing one not-yet-shared change in the company folder (「元に戻す」 in the preview). */
export type SyncRevertWrites = ElectronPort<'gitRevertFile'>
/** Summarising the changes: the member's AI reads the diff, so it leaves the computer. */
export type SyncSummaryOutbound = ElectronPort<'gitGenerateSummary'>
/** Syncing: commits, takes the server's changes and sends the member's work to the server. */
export type SyncOutbound = ElectronPort<'gitSync'>
/** Automatic sync (receive: takes teammates' changes; send: the normal sync). Main decides whether it may run now. */
export type AutoSyncOutbound = ElectronPort<'gitAutoSync'>

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

export function previewSync(rootPath: string, reads: SyncPreviewReads = window.electronAPI) {
  return reads.gitPreview(rootPath)
}

export function revertChange(rootPath: string, filePath: string, fileStatus: Parameters<SyncRevertWrites['gitRevertFile']>[2], writes: SyncRevertWrites = window.electronAPI) {
  return writes.gitRevertFile(rootPath, filePath, fileStatus)
}

export function summarizeChanges(rootPath: string, outbound: SyncSummaryOutbound = window.electronAPI) {
  return outbound.gitGenerateSummary(rootPath)
}

export function autoSync(rootPath: string, companyId: string, mode: Parameters<AutoSyncOutbound['gitAutoSync']>[2], state: Parameters<AutoSyncOutbound['gitAutoSync']>[3], outbound: AutoSyncOutbound = window.electronAPI) {
  return outbound.gitAutoSync(rootPath, companyId, mode, state)
}

export function syncCompany(rootPath: string, companyId: string, commitMessage: string, outbound: SyncOutbound = window.electronAPI) {
  return outbound.gitSync(rootPath, companyId, commitMessage)
}
