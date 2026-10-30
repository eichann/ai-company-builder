// The file tree's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/**
 * Reading private folders from the company server: the ones the member can
 * read, and who may create one where (sends only who the member is and the
 * parent folder).
 */
export type PrivateFolderReads = ElectronPort<'getMyPrivateFolders' | 'getPrivateFolderCreateContext'>
/**
 * Creating a private folder: the server makes its repository and rules from
 * the name and members the member chose. Human-only: the chat has no tool for it.
 */
export type PrivateFolderOutbound = ElectronPort<'createPrivateFolder'>

/** False in a window without a main process behind it (preview pages): nothing is shown private. */
export function canReadPrivateFolders(reads: Partial<PrivateFolderReads> | undefined = window.electronAPI) {
  return !!reads?.getMyPrivateFolders
}

export function getMyPrivateFolders(companyId: string, reads: PrivateFolderReads = window.electronAPI) {
  return reads.getMyPrivateFolders(companyId)
}

/** The members, the department's managers and the rules for 「新しいフォルダ…」 under `parentPath`. */
export function getPrivateFolderCreateContext(companyId: string, parentPath: string, reads: PrivateFolderReads = window.electronAPI) {
  return reads.getPrivateFolderCreateContext(companyId, parentPath)
}

export function createPrivateFolder(
  companyId: string,
  input: Parameters<PrivateFolderOutbound['createPrivateFolder']>[1],
  outbound: PrivateFolderOutbound = window.electronAPI,
) {
  return outbound.createPrivateFolder(companyId, input)
}
