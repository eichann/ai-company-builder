// The commit history's access to the main process, as one small port over the
// IPC contract (src/shared/ipc/electron-api.ts). Every function takes its port
// as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Reading the company folder's git history on this computer (nothing is fetched). */
export type CommitHistoryReads = ElectronPort<'gitLog' | 'gitShowCommit'>

/** The newest commits touching `pathFilter` ('' = the whole company). */
export function getCommitLog(rootPath: string, pathFilter: string, limit: number, reads: CommitHistoryReads = window.electronAPI) {
  return reads.gitLog(rootPath, pathFilter, limit)
}

/** The files one commit changed, only those under `folderPath` when given. */
export function getCommitFiles(rootPath: string, commitHash: string, folderPath: string | undefined, reads: CommitHistoryReads = window.electronAPI) {
  return reads.gitShowCommit(rootPath, commitHash, folderPath)
}
