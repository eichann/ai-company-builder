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

/** Reading the company folder on this computer: folder listings, whether a name is taken. */
export type FileTreeReads = ElectronPort<'readDirectory' | 'readDirectoryTree' | 'getStats'>
/** Changing the company folder on this computer: new file or folder, rename, move inside it, delete. */
export type FileTreeWrites = ElectronPort<'createFile' | 'createDirectory' | 'renameItem' | 'moveItem' | 'deleteItem'>
/**
 * Moving a file dropped from Finder into the company folder: it takes a file
 * from anywhere on this computer (the original is gone), so it has its own port.
 */
export type FileImportWrites = ElectronPort<'moveFromExternal'>
/**
 * Checking a name the member typed against private folders they cannot read:
 * main asks the company server (paths/check), so the name leaves the computer.
 */
export type ReservedNameOutbound = ElectronPort<'reservedPathRefusal'>
/** Alt-dragging a file out of the tree: hands it to another app (browser, Slack, Finder). */
export type FileDragOutbound = ElectronPort<'startDrag'>

export function readDirectory(dirPath: string, reads: FileTreeReads = window.electronAPI) {
  return reads.readDirectory(dirPath)
}

export function readDirectoryTree(dirPath: string, maxDepth?: number, reads: FileTreeReads = window.electronAPI) {
  return reads.readDirectoryTree(dirPath, maxDepth)
}

/** Rejects when nothing is at `path`. */
export function getStats(path: string, reads: FileTreeReads = window.electronAPI) {
  return reads.getStats(path)
}

/** Never replaces a file that exists (`code: 'name_taken'`). */
export function createEmptyFile(filePath: string, writes: FileTreeWrites = window.electronAPI) {
  return writes.createFile(filePath, '')
}

export function createDirectory(dirPath: string, writes: FileTreeWrites = window.electronAPI) {
  return writes.createDirectory(dirPath)
}

export function renameItem(oldPath: string, newPath: string, writes: FileTreeWrites = window.electronAPI) {
  return writes.renameItem(oldPath, newPath)
}

export function moveItem(sourcePath: string, destPath: string, writes: FileTreeWrites = window.electronAPI) {
  return writes.moveItem(sourcePath, destPath)
}

export function deleteItem(path: string, writes: FileTreeWrites = window.electronAPI) {
  return writes.deleteItem(path)
}

export function moveFromExternal(sourcePath: string, destPath: string, writes: FileImportWrites = window.electronAPI) {
  return writes.moveFromExternal(sourcePath, destPath)
}

/** The sentence refusing the name, or null when it may be used (or nobody knows: offline). */
export function reservedPathRefusal(targetPath: string, outbound: ReservedNameOutbound = window.electronAPI) {
  return outbound.reservedPathRefusal(targetPath)
}

export function startDrag(filePath: string, outbound: FileDragOutbound = window.electronAPI) {
  outbound.startDrag(filePath)
}
