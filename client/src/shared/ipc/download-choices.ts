// Which folders are on this computer (useSparseCheckout: the file tree, the
// department tabs, the settings), as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts). Every function takes its port as the last
// parameter, defaulting to window.electronAPI.
import type { ElectronPort } from './electron-api'

/** Reading the folders the member left out (this computer's list). */
export type ExcludedFolderReads = ElectronPort<'sparseGetExclusions'>
/**
 * Applying a new choice: removes left-out folders from disk, downloads
 * taken-back ones from the company server, and syncs a left-out private
 * folder one last time — its unshared work is sent, so it leaves the computer.
 */
export type DownloadChoiceOutbound = ElectronPort<'sparseSetExclusions'>

export function getExcludedFolders(rootPath: string, reads: ExcludedFolderReads = window.electronAPI) {
  return reads.sparseGetExclusions(rootPath)
}

/** Offline, a folder to download stays as it was and the result says so. */
export function applyExcludedFolders(rootPath: string, excluded: string[], outbound: DownloadChoiceOutbound = window.electronAPI) {
  return outbound.sparseSetExclusions(rootPath, excluded)
}
