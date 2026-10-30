// The company watcher (opened by the screen skeleton) and its events
// (lib/fileEvents: the renderer's one subscription), as small ports over the
// IPC contract (src/shared/ipc/electron-api.ts).
import type { ElectronPort } from './electron-api'

/** Listening to file changes the company folder's watcher reports on this computer. */
export type FileChangeReads = ElectronPort<'onFileChanges' | 'onFileChange'>

/**
 * Opening and closing the company folder's one recursive watcher (main runs
 * fs.watch on this computer; nothing is changed or sent).
 */
export type CompanyWatchReads = ElectronPort<'watchCompany' | 'unwatchCompany'>

/** Idempotent; `success: false` when the watcher could not be opened yet. */
export function watchCompany(rootPath: string, reads: CompanyWatchReads = window.electronAPI) {
  return reads.watchCompany(rootPath)
}

export function unwatchCompany(rootPath: string, reads: CompanyWatchReads = window.electronAPI) {
  return reads.unwatchCompany(rootPath)
}

type Change =Parameters<Parameters<FileChangeReads['onFileChange']>[0]>[0]

/**
 * Delivers batches (one-change batches from an older main process); returns
 * the unsubscribe, or null where nothing can be heard (no window, preview
 * pages without the API).
 */
export function listenToFileChanges(
  dispatch: (changes: Change[]) => void,
  reads: Partial<FileChangeReads> | undefined = typeof window === 'undefined' ? undefined : window.electronAPI,
): (() => void) | null {
  if (reads?.onFileChanges) return reads.onFileChanges(dispatch)
  if (reads?.onFileChange) return reads.onFileChange(change => dispatch([change]))
  return null
}
