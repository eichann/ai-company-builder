// The member's write access (閲覧のみ badges), read by the file tree, the
// editor and the private folders, as one small port over the IPC contract
// (src/shared/ipc/electron-api.ts). Every function takes its port as the last
// parameter, defaulting to window.electronAPI.
import type { ElectronPort } from './electron-api'

/**
 * Reading the member's write access: main asks the company server and keeps
 * the answer; it sends nothing of the member's but who they are.
 */
export type WriteAccessReads = ElectronPort<'getWriteAccess' | 'onWriteAccessChanged'>

/** False in a window without a main process behind it (preview pages): nothing is shown read-only. */
export function canReadWriteAccess(reads: Partial<WriteAccessReads> | undefined = window.electronAPI) {
  return !!reads?.getWriteAccess
}

/** The cached answer unless `refresh`; null when unknown. */
export function getWriteAccess(companyId: string, refresh?: boolean, reads: WriteAccessReads = window.electronAPI) {
  return reads.getWriteAccess(companyId, refresh)
}

/**
 * After each sync and chat turn; returns the unsubscribe, or undefined where
 * this window cannot listen (preview pages).
 */
export function onWriteAccessChanged(
  callback: Parameters<WriteAccessReads['onWriteAccessChanged']>[0],
  reads: Partial<WriteAccessReads> | undefined = window.electronAPI,
): (() => void) | undefined {
  return reads?.onWriteAccessChanged?.(callback)
}
