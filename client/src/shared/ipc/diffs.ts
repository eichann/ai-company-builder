// The diff view's access to the main process (DiffViewer, shown by the sync
// preview and the commit history, so it lives in shared/), as one small port
// over the IPC contract. Every function takes its port as the last parameter,
// defaulting to window.electronAPI.
import type { ElectronAPI, ElectronPort } from './electron-api'

/** Reading diffs from the company folder's git on this computer. */
export type DiffReads = ElectronPort<'gitFileDiff' | 'gitCommitFileDiff'>

type FileStatus = Parameters<ElectronAPI['gitFileDiff']>[2]

/** A file's changes not shared yet (what the next sync would send). */
export function getWorkingFileDiff(rootPath: string, filePath: string, fileStatus: FileStatus, reads: DiffReads = window.electronAPI) {
  return reads.gitFileDiff(rootPath, filePath, fileStatus)
}

/** What one commit changed in a file. */
export function getCommitFileDiff(rootPath: string, commitHash: string, filePath: string, reads: DiffReads = window.electronAPI) {
  return reads.gitCommitFileDiff(rootPath, commitHash, filePath)
}
