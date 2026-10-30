// The settings panel's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
// The company .env holds secret values, so it has ports of its own, and even
// those never read a value back: only per name whether it is set.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** Reading on this computer: which git binary the app runs. */
export type GitBinaryReads = ElectronPort<'gitBinaryStatus'>
/** Reading the company folder's .env: names, set or not, last four characters — never a value. */
export type CompanyEnvReads = ElectronPort<'getEnvStatus'>
/** Setting, replacing or removing names in the company folder's .env. */
export type CompanyEnvWrites = ElectronPort<'updateEnv'>
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
/** Asking the company server which services the member may use and their own keys (last 4 only). */
export type OwnKeyReads = ElectronPort<'listOwnBrokerKeys'>
/** Sending one's own API key to the company server (once; it never comes back), or deleting it there. */
export type OwnKeyOutbound = ElectronPort<'saveOwnBrokerKey' | 'deleteOwnBrokerKey'>

/**
 * Moving a key from the company .env to the company server as one's own key: main reads the
 * value (never the renderer), sends it, and removes it from the .env only after the server kept it.
 */
export type EnvKeyMoveOutbound = ElectronPort<'moveEnvKeyToServer'>

export function getGitBinaryStatus(reads: GitBinaryReads = window.electronAPI) {
  return reads.gitBinaryStatus()
}

export function readCompanyEnvStatus(rootPath: string, reads: CompanyEnvReads = window.electronAPI) {
  return reads.getEnvStatus(rootPath)
}

/** A string sets or replaces that name, null removes it; names not listed stay as they are. */
export function updateCompanyEnv(rootPath: string, changes: Record<string, string | null>, writes: CompanyEnvWrites = window.electronAPI) {
  return writes.updateEnv(rootPath, changes)
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

export function listOwnKeys(companyId: string, reads: OwnKeyReads = window.electronAPI) {
  return reads.listOwnBrokerKeys(companyId)
}

/** Registers or replaces the member's own key for `service`; the value is not kept here. */
export function saveOwnKey(companyId: string, service: string, secret: string, displayName: string | undefined, outbound: OwnKeyOutbound = window.electronAPI) {
  return outbound.saveOwnBrokerKey(companyId, service, secret, displayName)
}

export function deleteOwnKey(companyId: string, service: string, outbound: OwnKeyOutbound = window.electronAPI) {
  return outbound.deleteOwnBrokerKey(companyId, service)
}

/** Sends the .env key `name` to the server as one's own key; the .env loses it only once the server kept it. */
export function moveEnvKeyToServer(companyId: string, rootPath: string, name: string, outbound: EnvKeyMoveOutbound = window.electronAPI) {
  return outbound.moveEnvKeyToServer(companyId, rootPath, name)
}
