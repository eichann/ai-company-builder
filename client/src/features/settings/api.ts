// The settings panel's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
// The company .env holds secret values, so it has ports of its own, and even
// those never read a value back: only per name whether it is set.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'
import type { GoogleFeature } from '../../../shared/google'
import type { SlackFeature } from '../../../shared/slack'
import { FULL_ACCESS_ROLES } from '../../../../shared/core/permissions'
import { googlePermission } from '../../shared/lib/googlePermission'

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
/** Asking the company server which companies the member belongs to, with their role in each. */
export type GitignoreEditorReads = ElectronPort<'getCompanies'>
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

/**
 * May this member edit the company .gitignore on the settings page? It applies to everyone
 * once synced, so only owners and admins get the editor; anyone else (or an unknown role:
 * offline, company not listed) sees it read-only. Only the page: sync's essentials and the
 * .env lines are still written for every member (large files and private skills now go to
 * .git/info/exclude), and the server does not check who changes the file yet
 * (.claude/rules/sync-guards.md "Shared files").
 */
export async function canEditCompanyGitignore(companyId: string, reads: GitignoreEditorReads = window.electronAPI): Promise<boolean> {
  try {
    const result = await reads.getCompanies()
    const role = result.success ? result.data?.find(c => c.id === companyId)?.role : undefined
    return role !== undefined && FULL_ACCESS_ROLES.has(role)
  } catch {
    return false
  }
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

/** Asking the company server about the member's Google permission (no token ever reaches the app). */
export type GoogleReads = ElectronPort<'getGoogleStatus'>
/** 「Google で許可」 (main opens Google's page in the browser) and 「許可をやめる」. */
export type GoogleOutbound = ElectronPort<'connectGoogle' | 'disconnectGoogle'>

/** Every answer is also told to `googlePermission`: a change re-reads today's calendar at once. */
export async function getGoogleStatus(companyId: string, reads: GoogleReads = window.electronAPI) {
  const r = await reads.getGoogleStatus(companyId)
  if (r?.success) googlePermission.seen(companyId, r.data)
  return r
}

export function connectGoogle(companyId: string, features: GoogleFeature[], outbound: GoogleOutbound = window.electronAPI) {
  return outbound.connectGoogle(companyId, features)
}

/** 「スプレッドシートを中継で使う」: the member's view and own records; 「やめる」 / back on (no consent). */
export type GoogleRelayPort = ElectronPort<'getGoogleRelay' | 'setGoogleRelay'>

export function getGoogleRelay(companyId: string, port: GoogleRelayPort = window.electronAPI) {
  return port.getGoogleRelay(companyId)
}

export function setGoogleRelay(companyId: string, on: boolean, port: GoogleRelayPort = window.electronAPI) {
  return port.setGoogleRelay(companyId, on)
}

export async function disconnectGoogle(companyId: string, outbound: GoogleOutbound = window.electronAPI) {
  const r = await outbound.disconnectGoogle(companyId)
  if (r?.success) googlePermission.seen(companyId, r.data)
  return r
}

/** Sends the .env key `name` to the server as one's own key; the .env loses it only once the server kept it. */
export function moveEnvKeyToServer(companyId: string, rootPath: string, name: string, outbound: EnvKeyMoveOutbound = window.electronAPI) {
  return outbound.moveEnvKeyToServer(companyId, rootPath, name)
}

/** Asking the company server about the member's Slack permission (no token ever reaches the app). */
export type SlackReads = ElectronPort<'getSlackStatus'>
/** 「Slack で許可」 (main opens Slack's page in the browser), 「許可をやめる」 and the 知らせの DM switch. */
export type SlackOutbound = ElectronPort<'connectSlack' | 'disconnectSlack' | 'setSlackFeature'>

export function getSlackStatus(companyId: string, reads: SlackReads = window.electronAPI) {
  return reads.getSlackStatus(companyId)
}

export function connectSlack(companyId: string, features: SlackFeature[], outbound: SlackOutbound = window.electronAPI) {
  return outbound.connectSlack(companyId, features)
}

export function disconnectSlack(companyId: string, outbound: SlackOutbound = window.electronAPI) {
  return outbound.disconnectSlack(companyId)
}

export function setSlackFeature(companyId: string, feature: SlackFeature, on: boolean, outbound: SlackOutbound = window.electronAPI) {
  return outbound.setSlackFeature(companyId, feature, on)
}

/**
 * 「仕事の道具をつなぐ」: one Google consent for every feature the company offers (main opens
 * Google's page; the URL never comes here), and 「あとで」 per service (marks what is offered as shown).
 */
export type ConnectToolsOutbound = ElectronPort<'connectGoogleAll' | 'markGoogleSeen' | 'markSlackSeen'>

export function connectGoogleAll(companyId: string, outbound: ConnectToolsOutbound = window.electronAPI) {
  return outbound.connectGoogleAll(companyId)
}

export function markGoogleSeen(companyId: string, outbound: ConnectToolsOutbound = window.electronAPI) {
  return outbound.markGoogleSeen(companyId)
}

export function markSlackSeen(companyId: string, outbound: ConnectToolsOutbound = window.electronAPI) {
  return outbound.markSlackSeen(companyId)
}

/** 自分の設定: the member's own 受信を読む / AI が自動で進める, as the company server holds them. */
export type WorkSwitchReads = ElectronPort<'getWorkSwitches'>
/** Turning one of them on or off (the server refuses turning on what the company does not allow). */
export type WorkSwitchWrites = ElectronPort<'setWorkSwitch'>

export function getWorkSwitches(companyId: string, reads: WorkSwitchReads = window.electronAPI) {
  return reads.getWorkSwitches(companyId)
}

export function setWorkSwitch(companyId: string, which: 'readIncoming' | 'autoRun', on: boolean, writes: WorkSwitchWrites = window.electronAPI) {
  return writes.setWorkSwitch(companyId, which, on)
}
