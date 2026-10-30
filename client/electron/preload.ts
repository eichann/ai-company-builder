// window.electronAPI: the renderer's only way into the main process. Every
// method is typed from the IPC contract (shared/ipc-contract.ts): `invoke`,
// `send`, `sendSync` and `subscribe` below accept only channels listed there,
// with their argument and result types, and `api` must implement the whole
// `ElectronAPI`. Methods name their arguments (no `...args`), so what each one
// forwards stays visible (tests/ipc-harness records it).
import type {
  ElectronAPI, EventChannel, EventPayload, InvokeArgs, InvokeChannel, InvokeResult,
  SendArgs, SendChannel, SyncArgs, SyncChannel, SyncResult,
} from '../shared/ipc-contract'
import type { VoiceInputAPI } from '../shared/voice-input'
import type { ChatMetadataPatch, ChatSaveReceipt, ChatSession } from '../shared/chat-history'
import type { HandoffCompletion } from '../shared/handoff'
import type { AgentInteractionResponse } from '../shared/agent-interaction'
import type { PermissionMode } from '../shared/permission-mode'
import type { CreatePrivateFolderRequest } from '../shared/private-folder-ui'
import type { AutoSyncMode, AutoSyncRendererState } from '../shared/auto-sync'
// Use require for CommonJS compatibility in Electron preload
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')

const invoke = <C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> =>
  ipcRenderer.invoke(channel, ...args)
const send = <C extends SendChannel>(channel: C, ...args: SendArgs<C>): void => {
  ipcRenderer.send(channel, ...args)
}
const sendSync = <C extends SyncChannel>(channel: C, ...args: SyncArgs<C>): SyncResult<C> =>
  ipcRenderer.sendSync(channel, ...args)
/** Listen to a main → renderer event; returns the unsubscribe. */
function subscribe<C extends EventChannel>(channel: C, callback: (...payload: EventPayload<C>) => void): () => void {
  const listener = (_event: unknown, ...payload: EventPayload<C>) => callback(...payload)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

type GitFileStatus = 'added' | 'modified' | 'deleted'

const voiceInput: VoiceInputAPI = {
  capabilities: () => invoke('voice:capabilities'),
  devices: () => invoke('voice:devices'),
  start: (id: string, deviceId?: string) => invoke('voice:start', id, deviceId),
  stop: (id: string) => invoke('voice:stop', id),
  cancel: (id: string) => invoke('voice:cancel', id),
  getPrompt: () => invoke('voice:getPrompt'),
  setPrompt: (instructions: string) => invoke('voice:setPrompt', instructions),
  resetPrompt: () => invoke('voice:resetPrompt'),
  onEvent: callback => subscribe('voice:event', callback),
}

const api: ElectronAPI = {
  voiceInput,
  // Authentication
  signUp: (email: string, password: string, name?: string) =>
    invoke('auth:signUp', email, password, name),
  signIn: (email: string, password: string) =>
    invoke('auth:signIn', email, password),
  signOut: () => invoke('auth:signOut'),
  getSession: () => invoke('auth:getSession'),

  // Companies API
  getCompanies: () => invoke('api:getCompanies'),
  createCompany: (name: string) => invoke('api:createCompany', name),

  // Departments API
  getDepartments: (companyId: string) => invoke('api:getDepartments', companyId),

  // File system operations
  selectDirectory: () => invoke('dialog:selectDirectory'),
  registerAllowedRoot: (path: string) => invoke('fs:registerAllowedRoot', path),
  readDirectory: (path: string) => invoke('fs:readDirectory', path),
  readDirectoryTree: (path: string, maxDepth?: number) => invoke('fs:readDirectoryTree', path, maxDepth ?? 2),
  readFile: (path: string) => invoke('fs:readFile', path),
  readFileBinary: (path: string) => invoke('fs:readFileBinary', path),
  writeFile: (path: string, content: string) => invoke('fs:writeFile', path, content),
  backupBeforeOverwrite: (rootPath: string, filePath: string) =>
    invoke('editor:backupBeforeOverwrite', rootPath, filePath),
  createDirectory: (path: string) => invoke('fs:createDirectory', path),
  exists: (path: string) => invoke('fs:exists', path),

  // Extended file system operations
  deleteItem: (path: string) => invoke('fs:delete', path),
  renameItem: (oldPath: string, newPath: string) => invoke('fs:rename', oldPath, newPath),
  moveItem: (sourcePath: string, destPath: string) => invoke('fs:move', sourcePath, destPath),
  moveFromExternal: (sourcePath: string, destPath: string) => invoke('fs:moveFromExternal', sourcePath, destPath),
  copyItem: (sourcePath: string, destPath: string) => invoke('fs:copy', sourcePath, destPath),
  getStats: (path: string) => invoke('fs:stat', path),

  // Native drag to external apps
  startDrag: (filePath: string) => send('fs:startDrag', filePath),

  // File watching: one recursive watcher per open company folder (opened by
  // SkillCentricLayout when the company opens). Everything else subscribes.
  watchCompany: (rootPath: string) => invoke('fs:watch', rootPath),
  unwatchCompany: (rootPath: string) => invoke('fs:unwatch', rootPath),
  onFileChange: callback => subscribe('fs:changes', changes => {
    for (const change of changes) callback(change)
  }),
  /** The same events, one call per batch (sent at most every ~100 ms). */
  onFileChanges: callback => subscribe('fs:changes', callback),

  // Git operations
  gitSync: (repoPath: string, companyId: string, commitMessage: string) =>
    invoke('git:sync', repoPath, companyId, commitMessage),
  // 「自動で受け取る」 / 「自動で送る」 (the renderer's timer; main decides whether it may run now).
  gitAutoSync: (repoPath: string, companyId: string, mode: AutoSyncMode, state: AutoSyncRendererState) =>
    invoke('git:autoSync', repoPath, companyId, mode, state),
  // Per-folder write access (閲覧のみ badges); refreshed by sync and the chat.
  getWriteAccess: (companyId: string, refresh?: boolean) =>
    invoke('writeAccess:get', companyId, refresh),
  onWriteAccessChanged: callback => subscribe('writeAccess:changed', callback),
  // Private folders (lock icons, 「新しいフォルダ…」 dialog). Human-only: no chat tool.
  getMyPrivateFolders: (companyId: string) => invoke('privateFolders:mine', companyId),
  getPrivateFolderCreateContext: (companyId: string, parentPath: string) =>
    invoke('privateFolders:createContext', companyId, parentPath),
  createPrivateFolder: (companyId: string, input: CreatePrivateFolderRequest) =>
    invoke('privateFolders:create', companyId, input),
  // The member's own API keys (「自分の鍵」): last 4 only ever comes back.
  listOwnBrokerKeys: (companyId: string) => invoke('brokerKeys:list', companyId),
  saveOwnBrokerKey: (companyId: string, service: string, secret: string, displayName?: string) =>
    invoke('brokerKeys:save', companyId, service, secret, displayName),
  deleteOwnBrokerKey: (companyId: string, service: string) => invoke('brokerKeys:delete', companyId, service),
  gitPreview: (repoPath: string) =>
    invoke('git:preview', repoPath),
  gitGenerateSummary: (repoPath: string) =>
    invoke('git:generateSummary', repoPath),
  gitRevertFile: (repoPath: string, filePath: string, fileStatus: GitFileStatus) =>
    invoke('git:revertFile', repoPath, filePath, fileStatus),
  gitFileDiff: (repoPath: string, filePath: string, fileStatus: GitFileStatus) =>
    invoke('git:fileDiff', repoPath, filePath, fileStatus),
  gitCommitFileDiff: (repoPath: string, commitHash: string, filePath: string) =>
    invoke('git:commitFileDiff', repoPath, commitHash, filePath),
  gitListFiles: (repoPath: string, folderPath: string) =>
    invoke('git:listFiles', repoPath, folderPath),
  gitGrep: (repoPath: string, query: string, folderPath: string) =>
    invoke('git:grep', repoPath, query, folderPath),
  gitLog: (repoPath: string, folderPath: string, limit?: number) =>
    invoke('git:log', repoPath, folderPath, limit),
  gitShowCommit: (repoPath: string, commitHash: string, folderPath?: string) =>
    invoke('git:showCommit', repoPath, commitHash, folderPath),
  gitSetupCompanyRemote: (repoPath: string, companyId: string, selectedPaths?: string[]) =>
    invoke('git:setupCompanyRemote', repoPath, companyId, selectedPaths),
  gitInspectCompanyFolder: (folder: string, companyId: string) =>
    invoke('git:inspectCompanyFolder', folder, companyId),
  onSetupProgress: callback => subscribe('setup:progress', callback),

  // Sparse checkout
  sparseGetExclusions: (repoPath: string) =>
    invoke('git:sparseGetExclusions', repoPath),
  sparseSetExclusions: (repoPath: string, excluded: string[]) =>
    invoke('git:sparseSetExclusions', repoPath, excluded),
  sparseUncommittedChanges: (repoPath: string, folders: string[]) =>
    invoke('git:sparseUncommittedChanges', repoPath, folders),
  folderSizes: (repoPath: string, companyId: string, folder: string, measure: string[]) =>
    invoke('git:folderSizes', repoPath, companyId, folder, measure),
  /** The 「『…』というフォルダ名は使えません」 sentence when a path would write into a private folder the member cannot read (else null). */
  reservedPathRefusal: (targetPath: string) =>
    invoke('privateFolders:reservedPathRefusal', targetPath),
  onSparseProgress: callback => subscribe('sparse:progress', callback),
  gitBinaryStatus: () =>
    invoke('git:getBinaryStatus'),

  // Backup operations
  backupList: (repoPath: string) =>
    invoke('backup:list', repoPath),
  backupRestore: (repoPath: string, backupId: string, filePath: string) =>
    invoke('backup:restore', repoPath, backupId, filePath),
  backupOpenFolder: (backupPath: string) =>
    invoke('backup:openFolder', backupPath),

  // Environment variables (.env file): status only, never values
  getEnvStatus: (rootPath: string) => invoke('env:status', rootPath),
  updateEnv: (rootPath: string, changes: Record<string, string | null>) => invoke('env:update', rootPath, changes),

  // Skills
  listSkills: (rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string, options?: { force?: boolean }) =>
    invoke('skills:list', rootPath, departmentFolder, departmentId, departmentName, options),
  publishSkill: (rootPath: string, skillRelativePath: string) =>
    invoke('skills:publish', rootPath, skillRelativePath),
  makeSkillPrivate: (rootPath: string, skillRelativePath: string) =>
    invoke('skills:makePrivate', rootPath, skillRelativePath),
  toggleSkillNurturing: (skillMdPath: string, makeNurturing: boolean) =>
    invoke('skills:toggleNurturing', skillMdPath, makeNurturing),

  // Tools (Web apps in skills)
  startTool: (toolPath: string, startCommand?: string, companyId?: string) =>
    invoke('tools:start', toolPath, startCommand, companyId),
  stopTool: (toolPath: string) =>
    invoke('tools:stop', toolPath),
  openExternal: (url: string) =>
    invoke('shell:openExternal', url),

  // Config operations
  getApiKeyStatus: () => invoke('config:getApiKeyStatus'),
  setApiKey: (apiKey: string) => invoke('config:setApiKey', apiKey),
  hasApiKey: () => invoke('config:hasApiKey'),
  getCodexStatus: () => invoke('codex:status'),
  getAuthMode: () => invoke('config:getAuthMode'),
  setAuthMode: (mode: 'claude-code' | 'codex' | 'api-key') => invoke('config:setAuthMode', mode),
  getClaudeCodeStatus: () => invoke('config:getClaudeCodeStatus'),
  getPermissionMode: () => invoke('config:getPermissionMode'),
  setPermissionMode: (mode: PermissionMode) =>
    invoke('config:setPermissionMode', mode),

  // Server URL config
  getServerUrl: () => invoke('config:getServerUrl'),
  setServerUrl: (url: string) => invoke('config:setServerUrl', url),
  validateServerUrl: (url: string) => invoke('config:validateServerUrl', url),
  getAgentEnvPassthrough: () => invoke('config:getAgentEnvPassthrough'),
  setAgentEnvPassthrough: (names: string[]) => invoke('config:setAgentEnvPassthrough', names),

  onAgentInteraction: callback => subscribe('agent-interaction:request', callback),
  onAgentInteractionClosed: callback => subscribe('agent-interaction:closed', callback),
  getAgentInteractions: () => invoke('agent-interaction:list'),
  respondAgentInteraction: (id: string, response: AgentInteractionResponse) => invoke('agent-interaction:respond', id, response),

  // Tool approval
  onToolApprovalRequest: callback => subscribe('tool-approval-request', callback),
  respondToolApproval: (toolUseId: string, approved: boolean) =>
    invoke('tool-approval-response', toolUseId, approved),

  getHandoff: (company: string, id: string) => invoke('handoff:get', company, id),
  updateHandoff: (company: string, id: string) => invoke('handoff:update', company, id),
  completeHandoffTurn: (company: string, id: string, receipt: HandoffCompletion) => invoke('handoff:complete', company, id, receipt),
  onHandoffChanged: callback => subscribe('handoff:changed', callback),
  // Chat history
  // Session lists use summaries (no message bodies); body search runs in the main process.
  getChatSessionSummaries: (companyId: string) =>
    invoke('chatHistory:getSummaries', companyId),
  searchChatSessions: (companyId: string, query: string) =>
    invoke('chatHistory:search', companyId, query),
  getChatSession: (companyId: string, sessionId: string) =>
    invoke('chatHistory:getSession', companyId, sessionId),
  saveChatSession: (companyId: string, session: ChatSession) =>
    invoke('chatHistory:saveSession', companyId, session),
  flushChatSession: (companyId: string, session: ChatSession) => {
    const response = sendSync('chatHistory:flushSession', companyId, session)
    if (response.error) throw new Error(response.error)
    // Main sets `result` whenever `error` is absent (an empty message cannot occur in practice).
    return response.result as ChatSaveReceipt
  },
  patchChatSession: (companyId: string, sessionId: string, patch: ChatMetadataPatch) =>
    invoke('chatHistory:patchSession', companyId, sessionId, patch),
  deleteChatSession: (companyId: string, sessionId: string) =>
    invoke('chatHistory:deleteSession', companyId, sessionId),
  // Subscribe to chat history change broadcasts (multi-tab sync). Returns unsubscribe.
  onChatHistoryChanged: callback => subscribe('chatHistory:changed', callback),

  // Chat server info (for useChat transport)
  getChatServerInfo: () => invoke('chat-server:getInfo'),
  onChatServerInfo: callback => subscribe('chat-server:info', callback),
}

// The renderer types window.electronAPI itself (src/shared/ipc/electron-api.ts).
contextBridge.exposeInMainWorld('electronAPI', api)

export {}
