// The settings panel's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
// The company .env holds secret values, so it has ports of its own: a reader
// of .gitignore or of this computer's settings never gets them.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** Reading on this computer: which git binary the app runs. */
export type GitBinaryReads = ElectronPort<'gitBinaryStatus'>
/** Reading the company folder's .env: names and secret values (API keys). */
export type CompanyEnvReads = ElectronPort<'readEnv'>
/** Writing the company folder's .env. */
export type CompanyEnvWrites = ElectronPort<'writeEnv'>
/** Reading the company folder's .gitignore. */
export type GitignoreReads = ElectronPort<'readFile'>
/** Writing the company folder's .gitignore. */
export type GitignoreWrites = ElectronPort<'writeFile'>
/** Reading this computer's list of extra environment variable names the AI may see. */
export type AgentEnvReads = ElectronPort<'getAgentEnvPassthrough'>
/** Changing that list: widens or narrows what the AI's processes see on this computer. */
export type AgentEnvWrites = ElectronPort<'setAgentEnvPassthrough'>
/** Asking the company server for folder sizes (this computer's listing when offline). */
export type FolderSizeReads = ElectronPort<'folderSizes'>
/** Reading on this computer for the download choice: unsaved work in folders, download progress. */
export type DownloadChoiceReads = ElectronPort<'sparseUncommittedChanges' | 'onSparseProgress'>

export function getGitBinaryStatus(reads: GitBinaryReads = window.electronAPI) {
  return reads.gitBinaryStatus()
}

export function readCompanyEnv(rootPath: string, reads: CompanyEnvReads = window.electronAPI) {
  return reads.readEnv(rootPath)
}

export function writeCompanyEnv(rootPath: string, vars: Record<string, string>, writes: CompanyEnvWrites = window.electronAPI) {
  return writes.writeEnv(rootPath, vars)
}

const gitignorePath = (rootPath: string) => `${rootPath}/.gitignore`

/** The .gitignore's text, or null when there is none. */
export function readGitignore(rootPath: string, reads: GitignoreReads = window.electronAPI) {
  return reads.readFile(gitignorePath(rootPath))
}

export function writeGitignore(rootPath: string, content: string, writes: GitignoreWrites = window.electronAPI) {
  return writes.writeFile(gitignorePath(rootPath), content)
}

export function getAgentEnvPassthrough(reads: AgentEnvReads = window.electronAPI) {
  return reads.getAgentEnvPassthrough()
}

export function setAgentEnvPassthrough(names: string[], writes: AgentEnvWrites = window.electronAPI) {
  return writes.setAgentEnvPassthrough(names)
}

export function getFolderSizes(rootPath: string, companyId: string, folder: string, measure: string[], reads: FolderSizeReads = window.electronAPI) {
  return reads.folderSizes(rootPath, companyId, folder, measure)
}

/** Files with unsaved (uncommitted) changes inside folders about to be left out. */
export function findUncommittedChanges(rootPath: string, folders: string[], reads: DownloadChoiceReads = window.electronAPI) {
  return reads.sparseUncommittedChanges(rootPath, folders)
}

/** Bytes received while a download choice is applied; returns the unsubscribe. */
export function onDownloadProgress(
  callback: Parameters<ElectronAPI['onSparseProgress']>[0],
  reads: DownloadChoiceReads = window.electronAPI,
) {
  return reads.onSparseProgress(callback)
}
