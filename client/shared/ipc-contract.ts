// The IPC contract between the renderer and the main process: every channel,
// what it takes and what it answers, in one place.
//
//  - IpcInvokeChannels  renderer → main, ipcRenderer.invoke ↔ ipcMain.handle
//  - IpcSendChannels    renderer → main, ipcRenderer.send ↔ ipcMain.on
//  - IpcSyncChannels    renderer → main, ipcRenderer.sendSync ↔ ipcMain.on
//                       (the listener sets event.returnValue)
//  - IpcEventChannels   main → renderer, webContents.send ↔ ipcRenderer.on
//  - ElectronAPI        window.electronAPI as preload.ts exposes it, its
//                       methods typed from the channels above
//
// Both ends are checked against it at compile time: preload.ts builds
// `window.electronAPI` as an `ElectronAPI` through typed `invoke` / `send`
// helpers, and the main process registers handlers through a typed registrar
// (electron/ipc/registrar.ts), so a handler's parameters and result must
// match its channel here. tests/ipc-contract.test.ts checks at run time that
// every channel here has exactly one handler and one preload caller, and
// nothing else exists. To add a channel: .claude/rules/ipc-and-main-process.md.
//
// Types only: nothing here runs, and nothing here depends on Electron, Node
// or React — a different shell (Tauri) implements the same contract.

import type { HandoffCompletion, HandoffView } from './handoff'
import type { AgentInteractionRequest, AgentInteractionResponse } from './agent-interaction'
import type { AuthMode, CodexStatus } from './agent'
import type { VoiceCapabilities, VoiceDeviceList, VoiceEvent, VoiceInputAPI } from './voice-input'
import type { VoicePromptSettings } from './voice-prompt'
import type { ChatHistoryChange, ChatMetadataPatch, ChatSaveReceipt, ChatSession, ChatSessionSummary } from './chat-history'
import type { PermissionMode } from './permission-mode'
import type { WriteAccess } from './write-access'
import type { CreatePrivateFolderRequest, CreatePrivateFolderResult, MyPrivateFolder, PrivateFolderCreateContext } from './private-folder-ui'

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type GitFileStatus = 'added' | 'modified' | 'deleted'

export interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
}

export interface AuthResult {
  success: boolean
  data?: unknown
  error?: string
}

export interface SessionResult {
  success: boolean
  user: AuthUser | null
}

export interface CompanyInfo {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  role: string
  createdAt: string
  updatedAt: string
}

export interface CompaniesResult {
  success: boolean
  data?: CompanyInfo[]
  error?: string
}

export interface CompanyResult {
  success: boolean
  data?: CompanyInfo
  error?: string
}

export interface DepartmentInfo {
  id: string
  companyId: string
  parentId: string | null
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface DepartmentsResult {
  success: boolean
  data?: DepartmentInfo[]
  error?: string
}

/** A success flag and, on failure, why. */
export interface SimpleResult {
  success: boolean
  error?: string
}

export interface DirectoryEntry { name: string; isDirectory: boolean; path: string }
/** `children` down to the requested depth (absent below it, and for files). */
export interface DirectoryTreeNode extends DirectoryEntry { children?: DirectoryTreeNode[] }

export interface FileStats { isDirectory: boolean; isFile: boolean; size: number; mtime: string; ctime: string }

/** A watcher event (electron/company-watcher.ts FileChange). */
export interface FileChangeEvent { type: string; path: string }

export interface EditorBackupResult {
  success: boolean
  backupPath?: string
  skipped?: 'missing' | 'outside-company' | 'internal'
  error?: string
}

export interface EnvResult {
  success: boolean
  vars?: Record<string, string>
  error?: string
}

export interface GitResult {
  success: boolean
  error?: string
  message?: string
  remoteUrl?: string
  pushFailed?: boolean
  // Sync-specific fields
  hadConflicts?: boolean
  conflictFiles?: string[]
  // Subset of conflictFiles the server had deleted; sync followed the deletion
  // instead of overwriting with a server version that no longer exists.
  deletedConflictFiles?: string[]
  backupPath?: string
  restoredFolders?: string[]
  ignoredLargeFiles?: string[]
  // Nested repos detected during this sync and excluded on this computer only
  // (.git/info/exclude; never the shared .gitignore)
  excludedNestedRepos?: string[]
  // Files of such a folder that a teammate shared at the same path: this
  // computer's versions were copied to nestedRepoBackupPath before the pull
  nestedRepoBackupFiles?: string[]
  nestedRepoBackupPath?: string
  errorType?: 'network' | 'auth' | 'conflict' | 'locked' | 'push_failed' | 'protected_config' | 'write_denied' | 'personal_path' | 'unknown' | string
  secretDetected?: boolean
  // Agent-execution config paths (.claude/settings.json, .mcp.json, ...) the
  // server refused because only an owner/admin may change them
  protectedFiles?: string[]
  // Protected paths sync put back to the server's version (member's copy in
  // protectedBackupPath)
  restoredProtectedFiles?: string[]
  protectedBackupPath?: string
  // Paths the server refused because the member may not edit their folder
  writeDeniedFiles?: string[]
  // Write-denied paths sync put back to the server's version (member's copy
  // in writeDeniedBackupPath)
  restoredWriteDeniedFiles?: string[]
  writeDeniedBackupPath?: string
  // .personal/ paths the server refused (never shared, for anyone)
  personalFiles?: string[]
  // .personal/ paths sync untracked so the rest could be shared (kept on disk)
  untrackedPersonalFiles?: string[]
  // Files created inside a folder not downloaded on this computer: not
  // shared, moved to outsideCheckoutBackupPath (.backups/<ts>_outside_checkout)
  outsideCheckoutFiles?: string[]
  outsideCheckoutBackupPath?: string
}

export interface GitPreviewResult {
  success: boolean
  hasChanges: boolean
  changes: { added: string[]; modified: string[]; deleted: string[] }
  totalCount: number
  error?: string
}

export interface GitFileDiffResult {
  success: boolean
  diff: string
  isNewFile?: boolean
  isDeletedFile?: boolean
  error?: string
}

export interface GitCommitFileDiffResult {
  success: boolean
  diff: string
  error?: string
}

export interface GitListFilesResult {
  success: boolean
  files: string[]
  truncated?: boolean
  error?: string
}

// Fixed string, A–Z case-insensitive; ≤20 matches per file, ≤500 in all
// (`truncated`); `text` is cut around the match, `column` = its start.
export interface GitGrepResult {
  success: boolean
  results: Array<{ file: string; line: number; text: string; column?: number }>
  truncated?: boolean
  timedOut?: boolean
  /** A newer search from this window replaced this one. */
  cancelled?: boolean
  error?: string
}

export interface GitLogResult {
  success: boolean
  commits: Array<{
    hash: string
    hashShort: string
    message: string
    author: string
    date: string
  }>
  error?: string
}

export interface GitShowCommitResult {
  success: boolean
  files: Array<{ status: string; path: string }>
  error?: string
}

/** electron/sync/company-folder.ts (CompanyFolderDecision) */
export type CompanyFolderDecisionView =
  | { action: 'firstSetup' | 'existingClone' | 'uploadExisting' }
  | { action: 'refuse'; reason: 'otherRemote' | 'unrelatedRepo' | 'notEmpty'; message: string }

export interface InspectCompanyFolderResult {
  success: boolean
  decision?: CompanyFolderDecisionView
  error?: string
}

/** Bytes arriving in .git/objects/pack while a download runs. */
export interface DownloadProgress { repoPath: string; receivedBytes: number }

export interface SparseExclusionsResult { success: boolean; excluded: string[]; error?: string }
export interface SparseSetExclusionsResult { success: boolean; enabled?: boolean; excluded?: string[]; error?: string; offline?: boolean }
export interface SparseUncommittedChangesResult { success: boolean; files: string[]; error?: string }

/** git:folderSizes — one level of the folder tree with sizes (electron/sync/folder-sizes.ts). */
export type FolderSizesResponse =
  | {
      success: true
      path: string
      size: number | null
      folders: Array<{ name: string; path: string; size: number | null; files: number | null; hasChildren: boolean; private?: boolean }>
      measured: Record<string, number | null>
      offline: boolean
    }
  | { success: false; error: string }

export interface GitBinaryStatus { bundled: boolean; binary: string }

export interface BackupInfo {
  id: string
  timestamp: string
  reason: string
  files: string[]
  path: string
}

export interface BackupListResult {
  success: boolean
  backups: BackupInfo[]
  error?: string
}

export interface BackupRestoreResult {
  success: boolean
  message?: string
  error?: string
}

export interface ToolInfo {
  name: string
  displayName: string
  path: string
  hasPackageJson: boolean
  startCommand?: string
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  departmentId: string
  skillPath: string
  group?: string
  isPrivate?: boolean
  isNurturing?: boolean
  files: {
    skillMd: string
    rules?: string[]
    references?: string[]
    scripts?: string[]
    tools?: ToolInfo[]
  }
}

export interface SkillsResult {
  success: boolean
  skills: SkillInfo[]
  error?: string
}

export interface StartToolResult { success: boolean; port?: number; pid?: number; alreadyRunning?: boolean; error?: string }
export interface StopToolResult { success: boolean; message?: string; error?: string }

export interface ClaudeCodeStatus {
  available: boolean
  authenticated: boolean
  cliPath: string | null
  version: string | null
  error: string | null
  checkedAt: number
}

export interface ServerUrlValidation { valid: boolean; error?: string; serverName?: string; version?: string }

export interface ToolApprovalRequest {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  appSessionId?: string
  reason?: string
}

export type PrivateFoldersFailure = { success: false; offline: boolean; error: string }

export interface ChatServerInfo { port: number; authToken: string }

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** renderer → main: ipcRenderer.invoke(channel, ...args) answers `result`. */
export interface IpcInvokeChannels {
  // Voice input (electron/voice-input.ts)
  'voice:capabilities': { args: []; result: VoiceCapabilities }
  'voice:devices': { args: []; result: VoiceDeviceList }
  'voice:start': { args: [requestId: string, deviceId?: string]; result: void }
  'voice:stop': { args: [requestId: string]; result: void }
  'voice:cancel': { args: [requestId: string]; result: void }
  'voice:getPrompt': { args: []; result: VoicePromptSettings }
  'voice:setPrompt': { args: [instructions: string]; result: VoicePromptSettings }
  'voice:resetPrompt': { args: []; result: VoicePromptSettings }

  // Authentication and the server's API (the session stays in the main process)
  'auth:signUp': { args: [email: string, password: string, name?: string]; result: AuthResult }
  'auth:signIn': { args: [email: string, password: string]; result: AuthResult }
  'auth:signOut': { args: []; result: SimpleResult }
  'auth:getSession': { args: []; result: SessionResult }
  'api:getCompanies': { args: []; result: CompaniesResult }
  'api:createCompany': { args: [name: string]; result: CompanyResult }
  'api:getDepartments': { args: [companyId: string]; result: DepartmentsResult }

  // File system (every path is checked against the allowed roots)
  'dialog:selectDirectory': { args: []; result: string | null }
  'fs:registerAllowedRoot': { args: [path: string]; result: { success: boolean } }
  'fs:readDirectory': { args: [path: string]; result: DirectoryEntry[] }
  'fs:readDirectoryTree': { args: [path: string, maxDepth: number]; result: DirectoryTreeNode[] }
  'fs:readFile': { args: [path: string]; result: string | null }
  'fs:readFileBinary': { args: [path: string]; result: ArrayBuffer | null }
  'fs:writeFile': { args: [path: string, content: string]; result: boolean }
  'editor:backupBeforeOverwrite': { args: [rootPath: string, filePath: string]; result: EditorBackupResult }
  'fs:createDirectory': { args: [path: string]; result: boolean }
  'fs:exists': { args: [path: string]; result: boolean }
  'fs:delete': { args: [path: string]; result: SimpleResult }
  'fs:rename': { args: [oldPath: string, newPath: string]; result: { success: boolean; newPath?: string; error?: string } }
  'fs:move': { args: [sourcePath: string, destPath: string]; result: SimpleResult }
  'fs:moveFromExternal': { args: [sourcePath: string, destPath: string]; result: SimpleResult }
  'fs:copy': { args: [sourcePath: string, destPath: string]; result: SimpleResult }
  'fs:stat': { args: [path: string]; result: { success: boolean; data?: FileStats } }
  'fs:watch': { args: [rootPath: string]; result: SimpleResult }
  'fs:unwatch': { args: [rootPath: string]; result: SimpleResult }

  // Git
  'git:sync': { args: [repoPath: string, companyId: string, commitMessage: string]; result: GitResult }
  'writeAccess:get': { args: [companyId: string, refresh?: boolean]; result: WriteAccess | null }
  'privateFolders:mine': { args: [companyId: string]; result: { success: true; folders: MyPrivateFolder[] } | PrivateFoldersFailure }
  'privateFolders:createContext': { args: [companyId: string, parentPath: string]; result: { success: true; context: PrivateFolderCreateContext } | PrivateFoldersFailure }
  'privateFolders:create': { args: [companyId: string, input: CreatePrivateFolderRequest]; result: CreatePrivateFolderResult }
  'git:preview': { args: [repoPath: string]; result: GitPreviewResult }
  'git:generateSummary': { args: [repoPath: string]; result: { success: boolean; summary: string | null } }
  'git:revertFile': { args: [repoPath: string, filePath: string, fileStatus: GitFileStatus]; result: SimpleResult }
  'git:fileDiff': { args: [repoPath: string, filePath: string, fileStatus: GitFileStatus]; result: GitFileDiffResult }
  'git:commitFileDiff': { args: [repoPath: string, commitHash: string, filePath: string]; result: GitCommitFileDiffResult }
  // folderPath '' = the whole company (electron/git-search.ts)
  'git:listFiles': { args: [repoPath: string, folderPath: string]; result: GitListFilesResult }
  'git:grep': { args: [repoPath: string, query: string, folderPath: string]; result: GitGrepResult }
  'git:log': { args: [repoPath: string, folderPath: string, limit?: number]; result: GitLogResult }
  'git:showCommit': { args: [repoPath: string, commitHash: string, folderPath?: string]; result: GitShowCommitResult }
  'git:setupCompanyRemote': { args: [repoPath: string, companyId: string, selectedPaths?: string[]]; result: GitResult & { refused?: boolean } }
  'git:inspectCompanyFolder': { args: [folder: string, companyId: string]; result: InspectCompanyFolderResult }
  'git:sparseGetExclusions': { args: [repoPath: string]; result: SparseExclusionsResult }
  'git:sparseSetExclusions': { args: [repoPath: string, excluded: string[]]; result: SparseSetExclusionsResult }
  'git:sparseUncommittedChanges': { args: [repoPath: string, folders: string[]]; result: SparseUncommittedChangesResult }
  'git:folderSizes': { args: [repoPath: string, companyId: string, folder: string, measure: string[]]; result: FolderSizesResponse }
  /** The 「『…』というフォルダ名は使えません」 sentence when a path would write into a private folder the member cannot read (else null). */
  'privateFolders:reservedPathRefusal': { args: [targetPath: string]; result: string | null }
  'git:getBinaryStatus': { args: []; result: GitBinaryStatus }

  // Backups
  'backup:list': { args: [repoPath: string]; result: BackupListResult }
  'backup:restore': { args: [repoPath: string, backupId: string, filePath: string]; result: BackupRestoreResult }
  'backup:openFolder': { args: [backupPath: string]; result: SimpleResult }

  // Environment variables (.env file)
  'env:read': { args: [rootPath: string]; result: EnvResult }
  'env:write': { args: [rootPath: string, vars: Record<string, string>]; result: SimpleResult }

  // Skills and their tools (web apps)
  'skills:list': { args: [rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string, options?: { force?: boolean }]; result: SkillsResult }
  'skills:publish': { args: [rootPath: string, skillRelativePath: string]; result: SimpleResult }
  'skills:makePrivate': { args: [rootPath: string, skillRelativePath: string]; result: SimpleResult }
  'skills:toggleNurturing': { args: [skillMdPath: string, makeNurturing: boolean]; result: SimpleResult }
  'tools:start': { args: [toolPath: string, startCommand?: string]; result: StartToolResult }
  'tools:stop': { args: [toolPath: string]; result: StopToolResult }
  'shell:openExternal': { args: [url: string]; result: SimpleResult }

  // Settings
  'config:getApiKey': { args: []; result: string | null }
  'config:setApiKey': { args: [apiKey: string]; result: boolean }
  'config:hasApiKey': { args: []; result: boolean }
  'codex:status': { args: []; result: CodexStatus }
  'config:getAuthMode': { args: []; result: AuthMode }
  'config:setAuthMode': { args: [mode: AuthMode]; result: boolean }
  'config:getClaudeCodeStatus': { args: []; result: ClaudeCodeStatus }
  'config:getPermissionMode': { args: []; result: PermissionMode }
  'config:setPermissionMode': { args: [mode: PermissionMode]; result: boolean }
  'config:getServerUrl': { args: []; result: string | null }
  'config:setServerUrl': { args: [url: string]; result: boolean }
  'config:validateServerUrl': { args: [url: string]; result: ServerUrlValidation }
  // Extra environment variable names passed to AI processes (agents/agent-env.ts), this computer only
  'config:getAgentEnvPassthrough': { args: []; result: string[] }
  'config:setAgentEnvPassthrough': { args: [names: string[]]; result: { names: string[]; invalid: string[]; denied: string[] } }

  // Chat: choice prompts, tool approvals, hand-offs, history, the chat server
  'agent-interaction:list': { args: []; result: AgentInteractionRequest[] }
  'agent-interaction:respond': { args: [id: string, response: AgentInteractionResponse]; result: boolean }
  'tool-approval-response': { args: [toolUseId: string, approved: boolean]; result: boolean }
  'handoff:get': { args: [company: string, id: string]; result: HandoffView }
  'handoff:update': { args: [company: string, id: string]; result: void }
  'handoff:complete': { args: [company: string, id: string, receipt: HandoffCompletion]; result: void }
  // Session lists use summaries (no message bodies); body search runs in the main process.
  'chatHistory:getSummaries': { args: [companyId: string]; result: ChatSessionSummary[] }
  'chatHistory:search': { args: [companyId: string, query: string]; result: string[] }
  'chatHistory:getSession': { args: [companyId: string, sessionId: string]; result: ChatSession | null }
  'chatHistory:saveSession': { args: [companyId: string, session: ChatSession]; result: ChatSaveReceipt }
  'chatHistory:patchSession': { args: [companyId: string, sessionId: string, patch: ChatMetadataPatch]; result: ChatSession | null }
  'chatHistory:deleteSession': { args: [companyId: string, sessionId: string]; result: boolean }
  'chat-server:getInfo': { args: []; result: ChatServerInfo | null }
}

/** renderer → main, fire and forget: ipcRenderer.send(channel, ...args). */
export interface IpcSendChannels {
  // Native drag to external apps (browser, Finder, Slack, …)
  'fs:startDrag': { args: [filePath: string] }
}

/** renderer → main, blocking: ipcRenderer.sendSync(channel, ...args) returns `result` (event.returnValue). */
export interface IpcSyncChannels {
  // Used only during unload, when an asynchronous renderer request cannot be awaited.
  'chatHistory:flushSession': { args: [companyId: string, session: ChatSession]; result: { result: ChatSaveReceipt; error?: undefined } | { error: string; result?: undefined } }
}

/** main → renderer: webContents.send(channel, ...payload). */
export interface IpcEventChannels {
  'voice:event': [event: VoiceEvent]
  // One batch per ~100 ms from the company watcher.
  'fs:changes': [changes: FileChangeEvent[]]
  'writeAccess:changed': [data: { companyId: string; access: WriteAccess }]
  'setup:progress': [data: DownloadProgress]
  'sparse:progress': [data: DownloadProgress]
  'agent-interaction:request': [request: AgentInteractionRequest]
  'agent-interaction:closed': [request: AgentInteractionRequest]
  'tool-approval-request': [data: ToolApprovalRequest]
  'handoff:changed': [scope: { companyId: string; sessionId: string }]
  'chatHistory:changed': [data: ChatHistoryChange]
  'chat-server:info': [info: ChatServerInfo]
}

export type InvokeChannel = keyof IpcInvokeChannels
export type InvokeArgs<C extends InvokeChannel> = IpcInvokeChannels[C]['args']
export type InvokeResult<C extends InvokeChannel> = IpcInvokeChannels[C]['result']
export type SendChannel = keyof IpcSendChannels
export type SendArgs<C extends SendChannel> = IpcSendChannels[C]['args']
export type SyncChannel = keyof IpcSyncChannels
export type SyncArgs<C extends SyncChannel> = IpcSyncChannels[C]['args']
export type SyncResult<C extends SyncChannel> = IpcSyncChannels[C]['result']
export type EventChannel = keyof IpcEventChannels
export type EventPayload<C extends EventChannel> = IpcEventChannels[C]

// ---------------------------------------------------------------------------
// window.electronAPI
// ---------------------------------------------------------------------------

/** A preload method that forwards its arguments to `C` unchanged. */
type Invoke<C extends InvokeChannel> = (...args: InvokeArgs<C>) => Promise<InvokeResult<C>>
/** `on…(callback)`: subscribe to an event, returns the unsubscribe. */
type Subscribe<C extends EventChannel> = (callback: (...payload: EventPayload<C>) => void) => () => void

export interface ElectronAPI {
  voiceInput: VoiceInputAPI

  // Authentication
  signUp: Invoke<'auth:signUp'>
  signIn: Invoke<'auth:signIn'>
  signOut: Invoke<'auth:signOut'>
  getSession: Invoke<'auth:getSession'>

  // Companies API
  getCompanies: Invoke<'api:getCompanies'>
  createCompany: Invoke<'api:createCompany'>

  // Departments API
  getDepartments: Invoke<'api:getDepartments'>

  // File system
  selectDirectory: Invoke<'dialog:selectDirectory'>
  registerAllowedRoot: Invoke<'fs:registerAllowedRoot'>
  readDirectory: Invoke<'fs:readDirectory'>
  /** maxDepth defaults to 2. */
  readDirectoryTree: (path: string, maxDepth?: number) => Promise<InvokeResult<'fs:readDirectoryTree'>>
  readFile: Invoke<'fs:readFile'>
  readFileBinary: Invoke<'fs:readFileBinary'>
  writeFile: Invoke<'fs:writeFile'>
  /** Keep the disk version before the editor overwrites a file changed elsewhere (.backups/<ts>_editor_overwrite/). */
  backupBeforeOverwrite: Invoke<'editor:backupBeforeOverwrite'>
  createDirectory: Invoke<'fs:createDirectory'>
  exists: Invoke<'fs:exists'>

  // Extended file system operations
  deleteItem: Invoke<'fs:delete'>
  renameItem: Invoke<'fs:rename'>
  moveItem: Invoke<'fs:move'>
  moveFromExternal: Invoke<'fs:moveFromExternal'>
  copyItem: Invoke<'fs:copy'>
  getStats: Invoke<'fs:stat'>

  // Native drag to external apps
  startDrag: (...args: SendArgs<'fs:startDrag'>) => void

  // File watching: one recursive watcher per open company folder (opened by
  // SkillCentricLayout when the company opens). Everything else subscribes.
  watchCompany: Invoke<'fs:watch'>
  unwatchCompany: Invoke<'fs:unwatch'>
  /** One call per change. */
  onFileChange: (callback: (data: FileChangeEvent) => void) => () => void
  /** The same events, one call per batch (sent at most every ~100 ms). */
  onFileChanges: Subscribe<'fs:changes'>

  // Environment variables
  readEnv: Invoke<'env:read'>
  writeEnv: Invoke<'env:write'>

  // Skills
  listSkills: Invoke<'skills:list'>
  publishSkill: Invoke<'skills:publish'>
  makeSkillPrivate: Invoke<'skills:makePrivate'>
  toggleSkillNurturing: Invoke<'skills:toggleNurturing'>

  // Tools (Web apps)
  startTool: Invoke<'tools:start'>
  stopTool: Invoke<'tools:stop'>
  openExternal: Invoke<'shell:openExternal'>

  // Config
  getApiKey: Invoke<'config:getApiKey'>
  setApiKey: Invoke<'config:setApiKey'>
  hasApiKey: Invoke<'config:hasApiKey'>
  getCodexStatus: Invoke<'codex:status'>
  getAuthMode: Invoke<'config:getAuthMode'>
  setAuthMode: Invoke<'config:setAuthMode'>
  getClaudeCodeStatus: Invoke<'config:getClaudeCodeStatus'>
  getPermissionMode: Invoke<'config:getPermissionMode'>
  setPermissionMode: Invoke<'config:setPermissionMode'>

  // Server URL config
  getServerUrl: Invoke<'config:getServerUrl'>
  setServerUrl: Invoke<'config:setServerUrl'>
  validateServerUrl: Invoke<'config:validateServerUrl'>
  getAgentEnvPassthrough: Invoke<'config:getAgentEnvPassthrough'>
  setAgentEnvPassthrough: Invoke<'config:setAgentEnvPassthrough'>

  onAgentInteraction: Subscribe<'agent-interaction:request'>
  onAgentInteractionClosed: Subscribe<'agent-interaction:closed'>
  getAgentInteractions: Invoke<'agent-interaction:list'>
  respondAgentInteraction: Invoke<'agent-interaction:respond'>

  // Tool approval
  onToolApprovalRequest: Subscribe<'tool-approval-request'>
  respondToolApproval: Invoke<'tool-approval-response'>

  getHandoff: Invoke<'handoff:get'>
  updateHandoff: Invoke<'handoff:update'>
  completeHandoffTurn: Invoke<'handoff:complete'>
  onHandoffChanged: Subscribe<'handoff:changed'>

  // Chat history
  getChatSessionSummaries: Invoke<'chatHistory:getSummaries'>
  searchChatSessions: Invoke<'chatHistory:search'>
  getChatSession: Invoke<'chatHistory:getSession'>
  saveChatSession: Invoke<'chatHistory:saveSession'>
  /** Synchronous (page unload); throws the main process's error. */
  flushChatSession: (...args: SyncArgs<'chatHistory:flushSession'>) => ChatSaveReceipt
  patchChatSession: Invoke<'chatHistory:patchSession'>
  deleteChatSession: Invoke<'chatHistory:deleteSession'>
  /** Change broadcasts (multi-tab sync). */
  onChatHistoryChanged: Subscribe<'chatHistory:changed'>

  // Git
  gitSync: Invoke<'git:sync'>
  /** Per-folder write access (閲覧のみ badges); refreshed by sync and the chat. */
  getWriteAccess: Invoke<'writeAccess:get'>
  onWriteAccessChanged: Subscribe<'writeAccess:changed'>
  // Private folders (lock icons, 「新しいフォルダ…」 dialog). Human-only: no chat tool.
  getMyPrivateFolders: Invoke<'privateFolders:mine'>
  getPrivateFolderCreateContext: Invoke<'privateFolders:createContext'>
  createPrivateFolder: Invoke<'privateFolders:create'>
  gitPreview: Invoke<'git:preview'>
  gitGenerateSummary: Invoke<'git:generateSummary'>
  gitRevertFile: Invoke<'git:revertFile'>
  gitFileDiff: Invoke<'git:fileDiff'>
  gitCommitFileDiff: Invoke<'git:commitFileDiff'>
  gitListFiles: Invoke<'git:listFiles'>
  gitGrep: Invoke<'git:grep'>
  gitLog: Invoke<'git:log'>
  gitShowCommit: Invoke<'git:showCommit'>
  gitSetupCompanyRemote: Invoke<'git:setupCompanyRemote'>
  gitInspectCompanyFolder: Invoke<'git:inspectCompanyFolder'>
  onSetupProgress: Subscribe<'setup:progress'>

  // Sparse checkout
  sparseGetExclusions: Invoke<'git:sparseGetExclusions'>
  sparseSetExclusions: Invoke<'git:sparseSetExclusions'>
  sparseUncommittedChanges: Invoke<'git:sparseUncommittedChanges'>
  folderSizes: Invoke<'git:folderSizes'>
  reservedPathRefusal: Invoke<'privateFolders:reservedPathRefusal'>
  onSparseProgress: Subscribe<'sparse:progress'>
  gitBinaryStatus: Invoke<'git:getBinaryStatus'>

  // Backup
  backupList: Invoke<'backup:list'>
  backupRestore: Invoke<'backup:restore'>
  backupOpenFolder: Invoke<'backup:openFolder'>

  // Chat server (for useChat transport)
  getChatServerInfo: Invoke<'chat-server:getInfo'>
  onChatServerInfo: Subscribe<'chat-server:info'>
}
