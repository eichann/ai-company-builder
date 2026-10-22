import type { HandoffCompletion, HandoffView } from '../shared/handoff'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../shared/agent-interaction'
import type { VoiceInputAPI, VoiceEvent } from '../shared/voice-input'
import type { ChatSession, ChatSaveResult, ChatMetadataPatch, ChatHistoryChange } from '../shared/chat-history'
import type { PermissionMode } from '../shared/permission-mode'
import type { WriteAccess } from '../shared/write-access'
// Use require for CommonJS compatibility in Electron preload
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')

// Types for AI messages
interface AIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface AIResponse {
  text?: string
  thinking?: string
  error?: string
}

interface AICompleteData {
  thinking?: string
  content?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  voiceInput: {
    capabilities: () => ipcRenderer.invoke('voice:capabilities'),
    devices: () => ipcRenderer.invoke('voice:devices'),
    start: (id: string, deviceId?: string) => ipcRenderer.invoke('voice:start', id, deviceId),
    stop: (id: string) => ipcRenderer.invoke('voice:stop', id),
    cancel: (id: string) => ipcRenderer.invoke('voice:cancel', id),
    onEvent: (callback: (event: VoiceEvent) => void) => {
      const listener = (_event: unknown, value: VoiceEvent) => callback(value)
      ipcRenderer.on('voice:event', listener)
      return () => ipcRenderer.removeListener('voice:event', listener)
    },
  },
  // Authentication
  signUp: (email: string, password: string, name?: string) =>
    ipcRenderer.invoke('auth:signUp', email, password, name),
  signIn: (email: string, password: string) =>
    ipcRenderer.invoke('auth:signIn', email, password),
  signOut: () => ipcRenderer.invoke('auth:signOut'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),

  // Companies API
  getCompanies: () => ipcRenderer.invoke('api:getCompanies'),
  createCompany: (name: string) => ipcRenderer.invoke('api:createCompany', name),
  getCompany: (companyId: string) => ipcRenderer.invoke('api:getCompany', companyId),

  // Departments API
  getDepartments: (companyId: string) => ipcRenderer.invoke('api:getDepartments', companyId),

  // File system operations
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  registerAllowedRoot: (path: string) => ipcRenderer.invoke('fs:registerAllowedRoot', path),
  readDirectory: (path: string) => ipcRenderer.invoke('fs:readDirectory', path),
  readDirectoryTree: (path: string, maxDepth?: number) => ipcRenderer.invoke('fs:readDirectoryTree', path, maxDepth ?? 2),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  readFileBinary: (path: string) => ipcRenderer.invoke('fs:readFileBinary', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  createDirectory: (path: string) => ipcRenderer.invoke('fs:createDirectory', path),
  exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  getDocumentsPath: () => ipcRenderer.invoke('app:getDocumentsPath'),

  // Extended file system operations
  deleteItem: (path: string) => ipcRenderer.invoke('fs:delete', path),
  renameItem: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  moveItem: (sourcePath: string, destPath: string) => ipcRenderer.invoke('fs:move', sourcePath, destPath),
  moveFromExternal: (sourcePath: string, destPath: string) => ipcRenderer.invoke('fs:moveFromExternal', sourcePath, destPath),
  copyItem: (sourcePath: string, destPath: string) => ipcRenderer.invoke('fs:copy', sourcePath, destPath),
  getStats: (path: string) => ipcRenderer.invoke('fs:stat', path),

  // Native drag to external apps
  startDrag: (filePath: string) => ipcRenderer.send('fs:startDrag', filePath),

  // File watching
  watchDirectory: (rootPath: string) => ipcRenderer.invoke('fs:watch', rootPath),
  unwatchDirectory: (rootPath: string) => ipcRenderer.invoke('fs:unwatch', rootPath),
  onFileChange: (callback: (data: { type: string; path: string }) => void) => {
    const batchHandler = (_: unknown, changes: Array<{ type: string; path: string }>) => {
      for (const change of changes) callback(change)
    }
    ipcRenderer.on('fs:changes', batchHandler)
    return () => ipcRenderer.removeListener('fs:changes', batchHandler)
  },

  // Git operations
  gitInit: (repoPath: string) => ipcRenderer.invoke('git:init', repoPath),
  gitIsRepo: (repoPath: string) => ipcRenderer.invoke('git:isRepo', repoPath),
  gitAddRemote: (repoPath: string, remoteName: string, remoteUrl: string) =>
    ipcRenderer.invoke('git:addRemote', repoPath, remoteName, remoteUrl),
  gitSync: (repoPath: string, companyId: string, commitMessage: string) =>
    ipcRenderer.invoke('git:sync', repoPath, companyId, commitMessage),
  // Per-folder write access (閲覧のみ badges); refreshed by sync and the chat.
  getWriteAccess: (companyId: string, refresh?: boolean) =>
    ipcRenderer.invoke('writeAccess:get', companyId, refresh),
  onWriteAccessChanged: (callback: (data: { companyId: string; access: WriteAccess }) => void) => {
    const wrapped = (_event: unknown, data: { companyId: string; access: WriteAccess }) => callback(data)
    ipcRenderer.on('writeAccess:changed', wrapped)
    return () => ipcRenderer.off('writeAccess:changed', wrapped)
  },
  gitPreview: (repoPath: string) =>
    ipcRenderer.invoke('git:preview', repoPath),
  gitGenerateSummary: (repoPath: string) =>
    ipcRenderer.invoke('git:generateSummary', repoPath),
  gitRevertFile: (repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') =>
    ipcRenderer.invoke('git:revertFile', repoPath, filePath, fileStatus),
  gitFileDiff: (repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') =>
    ipcRenderer.invoke('git:fileDiff', repoPath, filePath, fileStatus),
  gitCommitFileDiff: (repoPath: string, commitHash: string, filePath: string) =>
    ipcRenderer.invoke('git:commitFileDiff', repoPath, commitHash, filePath),
  gitListFiles: (repoPath: string, folderPath: string) =>
    ipcRenderer.invoke('git:listFiles', repoPath, folderPath),
  gitGrep: (repoPath: string, query: string, folderPath: string) =>
    ipcRenderer.invoke('git:grep', repoPath, query, folderPath),
  gitLog: (repoPath: string, folderPath: string, limit?: number) =>
    ipcRenderer.invoke('git:log', repoPath, folderPath, limit),
  gitShowCommit: (repoPath: string, commitHash: string, folderPath?: string) =>
    ipcRenderer.invoke('git:showCommit', repoPath, commitHash, folderPath),
  gitSetupCompanyRemote: (repoPath: string, companyId: string, selectedPaths?: string[]) =>
    ipcRenderer.invoke('git:setupCompanyRemote', repoPath, companyId, selectedPaths),
  gitInspectCompanyFolder: (folder: string, companyId: string) =>
    ipcRenderer.invoke('git:inspectCompanyFolder', folder, companyId),
  onSetupProgress: (callback: (data: { repoPath: string; receivedBytes: number }) => void) => {
    const handler = (_: unknown, data: { repoPath: string; receivedBytes: number }) => callback(data)
    ipcRenderer.on('setup:progress', handler)
    return () => ipcRenderer.removeListener('setup:progress', handler)
  },
  gitPushToServer: (repoPath: string) =>
    ipcRenderer.invoke('git:pushToServer', repoPath),

  // Sparse checkout
  isSparseCheckout: (repoPath: string) =>
    ipcRenderer.invoke('git:isSparseCheckout', repoPath),
  listRemoteDirectories: (repoPath: string) =>
    ipcRenderer.invoke('git:listRemoteDirectories', repoPath),
  sparseGetExclusions: (repoPath: string) =>
    ipcRenderer.invoke('git:sparseGetExclusions', repoPath),
  sparseSetExclusions: (repoPath: string, excluded: string[]) =>
    ipcRenderer.invoke('git:sparseSetExclusions', repoPath, excluded),
  sparseUncommittedChanges: (repoPath: string, folders: string[]) =>
    ipcRenderer.invoke('git:sparseUncommittedChanges', repoPath, folders),
  folderSizes: (repoPath: string, companyId: string, folder: string, measure: string[]) =>
    ipcRenderer.invoke('git:folderSizes', repoPath, companyId, folder, measure),
  onSparseProgress: (callback: (data: { repoPath: string; receivedBytes: number }) => void) => {
    const handler = (_: unknown, data: { repoPath: string; receivedBytes: number }) => callback(data)
    ipcRenderer.on('sparse:progress', handler)
    return () => ipcRenderer.removeListener('sparse:progress', handler)
  },
  gitBinaryStatus: () =>
    ipcRenderer.invoke('git:getBinaryStatus'),

  // Backup operations
  backupList: (repoPath: string) =>
    ipcRenderer.invoke('backup:list', repoPath),
  backupRestore: (repoPath: string, backupId: string, filePath: string) =>
    ipcRenderer.invoke('backup:restore', repoPath, backupId, filePath),
  backupOpenFolder: (backupPath: string) =>
    ipcRenderer.invoke('backup:openFolder', backupPath),
  serverCreateRepo: (companyId: string) =>
    ipcRenderer.invoke('server:createRepo', companyId),

  // Environment variables (.env file)
  readEnv: (rootPath: string) => ipcRenderer.invoke('env:read', rootPath),
  writeEnv: (rootPath: string, vars: Record<string, string>) => ipcRenderer.invoke('env:write', rootPath, vars),

  // Skills
  listSkills: (rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string) =>
    ipcRenderer.invoke('skills:list', rootPath, departmentFolder, departmentId, departmentName),
  publishSkill: (rootPath: string, skillRelativePath: string) =>
    ipcRenderer.invoke('skills:publish', rootPath, skillRelativePath),
  makeSkillPrivate: (rootPath: string, skillRelativePath: string) =>
    ipcRenderer.invoke('skills:makePrivate', rootPath, skillRelativePath),
  toggleSkillNurturing: (skillMdPath: string, makeNurturing: boolean) =>
    ipcRenderer.invoke('skills:toggleNurturing', skillMdPath, makeNurturing),

  // Tools (Web apps in skills)
  startTool: (toolPath: string, startCommand?: string) =>
    ipcRenderer.invoke('tools:start', toolPath, startCommand),
  stopTool: (toolPath: string) =>
    ipcRenderer.invoke('tools:stop', toolPath),
  listRunningTools: () =>
    ipcRenderer.invoke('tools:list-running'),
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:openExternal', url),

  // Config operations
  getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
  setApiKey: (apiKey: string) => ipcRenderer.invoke('config:setApiKey', apiKey),
  hasApiKey: () => ipcRenderer.invoke('config:hasApiKey'),
  getCodexStatus: () => ipcRenderer.invoke('codex:status'),
  getAuthMode: () => ipcRenderer.invoke('config:getAuthMode'),
  setAuthMode: (mode: 'claude-code' | 'codex' | 'api-key') => ipcRenderer.invoke('config:setAuthMode', mode),
  isClaudeCodeAvailable: () => ipcRenderer.invoke('config:isClaudeCodeAvailable'),
  getClaudeCodeStatus: () => ipcRenderer.invoke('config:getClaudeCodeStatus'),
  getPermissionMode: () => ipcRenderer.invoke('config:getPermissionMode'),
  setPermissionMode: (mode: PermissionMode) =>
    ipcRenderer.invoke('config:setPermissionMode', mode),

  // Server URL config
  getServerUrl: () => ipcRenderer.invoke('config:getServerUrl'),
  setServerUrl: (url: string) => ipcRenderer.invoke('config:setServerUrl', url),
  validateServerUrl: (url: string) => ipcRenderer.invoke('config:validateServerUrl', url),

  onAgentInteraction: (callback: (request: AgentInteractionRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentInteractionRequest) => callback(request)
    ipcRenderer.on('agent-interaction:request', handler)
    return () => ipcRenderer.removeListener('agent-interaction:request', handler)
  },
  onAgentInteractionClosed: (callback: (request: AgentInteractionRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AgentInteractionRequest) => callback(request)
    ipcRenderer.on('agent-interaction:closed', handler)
    return () => ipcRenderer.removeListener('agent-interaction:closed', handler)
  },
  getAgentInteractions: (): Promise<AgentInteractionRequest[]> => ipcRenderer.invoke('agent-interaction:list'),
  respondAgentInteraction: (id: string, response: AgentInteractionResponse): Promise<boolean> => ipcRenderer.invoke('agent-interaction:respond', id, response),

  // Tool approval
  onToolApprovalRequest: (callback: (data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown>; appSessionId?: string }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown>; appSessionId?: string }) => callback(data)
    ipcRenderer.on('tool-approval-request', handler)
    return () => { ipcRenderer.removeListener('tool-approval-request', handler) }
  },
  respondToolApproval: (toolUseId: string, approved: boolean) =>
    ipcRenderer.invoke('tool-approval-response', toolUseId, approved),

  getHandoff: (company: string, id: string) => ipcRenderer.invoke('handoff:get', company, id),
  updateHandoff: (company: string, id: string) => ipcRenderer.invoke('handoff:update', company, id),
  completeHandoffTurn: (company: string, id: string, receipt: HandoffCompletion) => ipcRenderer.invoke('handoff:complete', company, id, receipt),
  onHandoffChanged: (callback: (scope: { companyId: string; sessionId: string }) => void) => {
    const wrapped = (_event: unknown, scope: { companyId: string; sessionId: string }) => callback(scope)
    ipcRenderer.on('handoff:changed', wrapped)
    return () => ipcRenderer.off('handoff:changed', wrapped)
  },
  // Chat history
  getChatSessions: (companyId: string) =>
    ipcRenderer.invoke('chatHistory:getSessions', companyId),
  getChatSession: (companyId: string, sessionId: string) =>
    ipcRenderer.invoke('chatHistory:getSession', companyId, sessionId),
  saveChatSession: (companyId: string, session: ChatSession) =>
    ipcRenderer.invoke('chatHistory:saveSession', companyId, session),
  flushChatSession: (companyId: string, session: ChatSession): ChatSaveResult => {
    const response = ipcRenderer.sendSync('chatHistory:flushSession', companyId, session)
    if (response.error) throw new Error(response.error)
    return response.result
  },
  patchChatSession: (companyId: string, sessionId: string, patch: ChatMetadataPatch) =>
    ipcRenderer.invoke('chatHistory:patchSession', companyId, sessionId, patch),
  deleteChatSession: (companyId: string, sessionId: string) =>
    ipcRenderer.invoke('chatHistory:deleteSession', companyId, sessionId),
  // Subscribe to chat history change broadcasts (multi-tab sync). Returns unsubscribe.
  onChatHistoryChanged: (callback: (data: ChatHistoryChange) => void) => {
    const wrapped = (_event: unknown, data: ChatHistoryChange) => callback(data)
    ipcRenderer.on('chatHistory:changed', wrapped)
    return () => ipcRenderer.off('chatHistory:changed', wrapped)
  },

  // AI operations
  chat: (messages: AIMessage[], systemPrompt?: string, workingDirectory?: string) =>
    ipcRenderer.invoke('ai:chat', messages, systemPrompt, workingDirectory),

  // AI streaming events
  onAIChunk: (callback: (chunk: string) => void) => {
    const handler = (_: unknown, chunk: string) => callback(chunk)
    ipcRenderer.on('ai:chunk', handler)
    return () => ipcRenderer.removeListener('ai:chunk', handler)
  },
  onAIComplete: (callback: (data?: AICompleteData) => void) => {
    const handler = (_: unknown, data?: AICompleteData) => callback(data)
    ipcRenderer.on('ai:complete', handler)
    return () => ipcRenderer.removeListener('ai:complete', handler)
  },
  onAIThinking: (callback: (isThinking: boolean) => void) => {
    const handler = (_: unknown, isThinking: boolean) => callback(isThinking)
    ipcRenderer.on('ai:thinking', handler)
    return () => ipcRenderer.removeListener('ai:thinking', handler)
  },
  onAIThought: (callback: (thought: string) => void) => {
    const handler = (_: unknown, thought: string) => callback(thought)
    ipcRenderer.on('ai:thought', handler)
    return () => ipcRenderer.removeListener('ai:thought', handler)
  },
  onAIThoughtStream: (callback: (thought: string) => void) => {
    const handler = (_: unknown, thought: string) => callback(thought)
    ipcRenderer.on('ai:thought-stream', handler)
    return () => ipcRenderer.removeListener('ai:thought-stream', handler)
  },

  // Chat server info (for useChat transport)
  getChatServerInfo: () => ipcRenderer.invoke('chat-server:getInfo') as Promise<{ port: number; authToken: string } | null>,
  onChatServerInfo: (callback: (info: { port: number; authToken: string }) => void) => {
    const handler = (_: unknown, info: { port: number; authToken: string }) => callback(info)
    ipcRenderer.on('chat-server:info', handler)
    return () => ipcRenderer.removeListener('chat-server:info', handler)
  },
})

/** git:folderSizes — one level of the folder tree with sizes (electron/sync/folder-sizes.ts). */
type FolderSizesResponse =
  | {
      success: true
      path: string
      size: number | null
      folders: Array<{ name: string; path: string; size: number | null; files: number | null; hasChildren: boolean }>
      measured: Record<string, number | null>
      offline: boolean
    }
  | { success: false; error: string }

interface GitResult {
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
  // Nested repos auto-detected and added to .gitignore during this sync
  excludedNestedRepos?: string[]
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

interface GitRepoResult {
  isRepo: boolean
}

interface ServerRepoResult {
  success: boolean
  data?: {
    companyId: string
    path: string
    httpsUrl?: string
    sshUrl?: string
    message?: string
  }
  error?: string
}

interface EnvResult {
  success: boolean
  vars?: Record<string, string>
  error?: string
}

interface AuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
}

interface AuthResult {
  success: boolean
  data?: unknown
  error?: string
}

interface SessionResult {
  success: boolean
  user: AuthUser | null
}

interface CompaniesResult {
  success: boolean
  data?: Array<{
    id: string
    name: string
    slug: string
    ownerId: string
    repoPath: string | null
    role: string
    createdAt: string
    updatedAt: string
  }>
  error?: string
}

interface CompanyResult {
  success: boolean
  data?: {
    id: string
    name: string
    slug: string
    ownerId: string
    repoPath: string | null
    role: string
    createdAt: string
    updatedAt: string
  }
  error?: string
}

interface DepartmentInfo {
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

interface DepartmentsResult {
  success: boolean
  data?: DepartmentInfo[]
  error?: string
}

interface ToolInfo {
  name: string
  displayName: string
  path: string
  hasPackageJson: boolean
  startCommand?: string
}

interface SkillInfo {
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

interface SkillsResult {
  success: boolean
  skills: SkillInfo[]
  error?: string
}

interface BackupInfo {
  id: string
  timestamp: string
  reason: string
  files: string[]
  path: string
}

interface BackupListResult {
  success: boolean
  backups: BackupInfo[]
  error?: string
}

interface BackupRestoreResult {
  success: boolean
  message?: string
  error?: string
}

declare global {
  interface Window {
    electronAPI: {
      voiceInput: VoiceInputAPI
      // Authentication
      signUp: (email: string, password: string, name?: string) => Promise<AuthResult>
      signIn: (email: string, password: string) => Promise<AuthResult>
      signOut: () => Promise<{ success: boolean; error?: string }>
      getSession: () => Promise<SessionResult>

      // Companies API
      getCompanies: () => Promise<CompaniesResult>
      createCompany: (name: string) => Promise<CompanyResult>
      getCompany: (companyId: string) => Promise<CompanyResult>

      // Departments API
      getDepartments: (companyId: string) => Promise<DepartmentsResult>

      // File system
      selectDirectory: () => Promise<string | null>
      registerAllowedRoot: (path: string) => Promise<{ success: boolean }>
      readDirectory: (path: string) => Promise<Array<{ name: string; isDirectory: boolean; path: string }>>
      readDirectoryTree: (path: string, maxDepth?: number) => Promise<Array<{ name: string; isDirectory: boolean; path: string; children?: Array<{ name: string; isDirectory: boolean; path: string; children?: unknown[] }> }>>
      readFile: (path: string) => Promise<string | null>
      readFileBinary: (path: string) => Promise<ArrayBuffer | null>
      writeFile: (path: string, content: string) => Promise<boolean>
      createDirectory: (path: string) => Promise<boolean>
      exists: (path: string) => Promise<boolean>
      getDocumentsPath: () => Promise<string>

      // Extended file system operations
      deleteItem: (path: string) => Promise<{ success: boolean; error?: string }>
      renameItem: (oldPath: string, newPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
      moveItem: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
      moveFromExternal: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
      copyItem: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
      getStats: (path: string) => Promise<{ success: boolean; data?: { isDirectory: boolean; isFile: boolean; size: number; mtime: string; ctime: string } }>

      // Native drag to external apps
      startDrag: (filePath: string) => void

      // File watching
      watchDirectory: (rootPath: string) => Promise<{ success: boolean; error?: string }>
      unwatchDirectory: (rootPath: string) => Promise<{ success: boolean; error?: string }>
      onFileChange: (callback: (data: { type: string; path: string }) => void) => () => void

      // Environment variables
      readEnv: (rootPath: string) => Promise<EnvResult>
      writeEnv: (rootPath: string, vars: Record<string, string>) => Promise<{ success: boolean; error?: string }>

      // Skills
      listSkills: (rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string) => Promise<SkillsResult>
      publishSkill: (rootPath: string, skillRelativePath: string) => Promise<{ success: boolean; error?: string }>
      makeSkillPrivate: (rootPath: string, skillRelativePath: string) => Promise<{ success: boolean; error?: string }>
      toggleSkillNurturing: (skillMdPath: string, makeNurturing: boolean) => Promise<{ success: boolean; error?: string }>

      // Tools (Web apps)
      startTool: (toolPath: string, startCommand?: string) => Promise<{ success: boolean; port?: number; pid?: number; alreadyRunning?: boolean; error?: string }>
      stopTool: (toolPath: string) => Promise<{ success: boolean; message?: string; error?: string }>
      listRunningTools: () => Promise<{ success: boolean; tools: Array<{ toolPath: string; port: number; pid?: number }> }>
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>

      // Config
      getApiKey: () => Promise<string | null>
      setApiKey: (apiKey: string) => Promise<boolean>
      hasApiKey: () => Promise<boolean>
      getCodexStatus: () => Promise<import('../shared/agent').CodexStatus>
      getAuthMode: () => Promise<'claude-code' | 'codex' | 'api-key'>
      setAuthMode: (mode: 'claude-code' | 'codex' | 'api-key') => Promise<boolean>
      isClaudeCodeAvailable: () => Promise<boolean>
      getClaudeCodeStatus: () => Promise<{
        available: boolean
        authenticated: boolean
        cliPath: string | null
        version: string | null
        error: string | null
        checkedAt: number
      }>
      getPermissionMode: () => Promise<PermissionMode>
      setPermissionMode: (mode: PermissionMode) => Promise<boolean>

      // Server URL config
      getServerUrl: () => Promise<string | null>
      setServerUrl: (url: string) => Promise<boolean>
      validateServerUrl: (url: string) => Promise<{ valid: boolean; error?: string; serverName?: string; version?: string }>

      onAgentInteraction: (callback: (request: AgentInteractionRequest) => void) => () => void
      onAgentInteractionClosed: (callback: (request: AgentInteractionRequest) => void) => () => void
      getAgentInteractions: () => Promise<AgentInteractionRequest[]>
      respondAgentInteraction: (id: string, response: AgentInteractionResponse) => Promise<boolean>

      // Tool approval
      onToolApprovalRequest: (callback: (data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown>; appSessionId?: string }) => void) => () => void
      respondToolApproval: (toolUseId: string, approved: boolean) => Promise<boolean>

      getHandoff: (company: string, id: string) => Promise<HandoffView>
      updateHandoff: (company: string, id: string) => Promise<void>
      completeHandoffTurn: (company: string, id: string, receipt: HandoffCompletion) => Promise<void>
      onHandoffChanged: (callback: (scope: { companyId: string; sessionId: string }) => void) => () => void
      // Chat history
      getChatSessions: (companyId: string) => Promise<ChatSession[]>
      getChatSession: (companyId: string, sessionId: string) => Promise<ChatSession | null>
      saveChatSession: (companyId: string, session: ChatSession) => Promise<ChatSaveResult>
      flushChatSession: (companyId: string, session: ChatSession) => ChatSaveResult
      patchChatSession: (companyId: string, sessionId: string, patch: ChatMetadataPatch) => Promise<ChatSession | null>
      deleteChatSession: (companyId: string, sessionId: string) => Promise<boolean>
      onChatHistoryChanged: (callback: (data: ChatHistoryChange) => void) => () => void

      // Git
      gitInit: (repoPath: string) => Promise<GitResult>
      gitIsRepo: (repoPath: string) => Promise<GitRepoResult>
      gitAddRemote: (repoPath: string, remoteName: string, remoteUrl: string) => Promise<GitResult>
      gitSync: (repoPath: string, companyId: string, commitMessage: string) => Promise<GitResult>
      getWriteAccess: (companyId: string, refresh?: boolean) => Promise<WriteAccess | null>
      onWriteAccessChanged: (callback: (data: { companyId: string; access: WriteAccess }) => void) => () => void
      gitPreview: (repoPath: string) => Promise<{
        success: boolean
        hasChanges: boolean
        changes: { added: string[]; modified: string[]; deleted: string[] }
        totalCount: number
        error?: string
      }>
      gitGenerateSummary: (repoPath: string) => Promise<{
        success: boolean
        summary: string | null
      }>
      gitRevertFile: (repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => Promise<{
        success: boolean
        error?: string
      }>
      gitFileDiff: (repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => Promise<{
        success: boolean
        diff: string
        isNewFile?: boolean
        isDeletedFile?: boolean
        error?: string
      }>
      gitCommitFileDiff: (repoPath: string, commitHash: string, filePath: string) => Promise<{
        success: boolean
        diff: string
        error?: string
      }>
      gitListFiles: (repoPath: string, folderPath: string) => Promise<{
        success: boolean
        files: string[]
        error?: string
      }>
      gitGrep: (repoPath: string, query: string, folderPath: string) => Promise<{
        success: boolean
        results: Array<{ file: string; line: number; text: string }>
        error?: string
      }>
      gitLog: (repoPath: string, folderPath: string, limit?: number) => Promise<{
        success: boolean
        commits: Array<{
          hash: string
          hashShort: string
          message: string
          author: string
          date: string
        }>
        error?: string
      }>
      gitShowCommit: (repoPath: string, commitHash: string, folderPath?: string) => Promise<{
        success: boolean
        files: Array<{ status: string; path: string }>
        error?: string
      }>
      gitSetupCompanyRemote: (repoPath: string, companyId: string, selectedPaths?: string[]) => Promise<GitResult & { refused?: boolean }>
      // electron/sync/company-folder.ts (CompanyFolderDecision)
      gitInspectCompanyFolder: (folder: string, companyId: string) => Promise<{
        success: boolean
        decision?:
          | { action: 'firstSetup' | 'existingClone' | 'uploadExisting' }
          | { action: 'refuse'; reason: 'otherRemote' | 'unrelatedRepo' | 'notEmpty'; message: string }
        error?: string
      }>
      onSetupProgress: (callback: (data: { repoPath: string; receivedBytes: number }) => void) => () => void
      gitPushToServer: (repoPath: string) => Promise<GitResult>
      serverCreateRepo: (companyId: string) => Promise<ServerRepoResult>

      // Sparse checkout
      isSparseCheckout: (repoPath: string) => Promise<{ enabled: boolean }>
      listRemoteDirectories: (repoPath: string) => Promise<{ success: boolean; directories: string[]; error?: string }>
      sparseGetExclusions: (repoPath: string) => Promise<{ success: boolean; excluded: string[]; error?: string }>
      sparseSetExclusions: (repoPath: string, excluded: string[]) => Promise<{ success: boolean; enabled?: boolean; excluded?: string[]; error?: string; offline?: boolean }>
      sparseUncommittedChanges: (repoPath: string, folders: string[]) => Promise<{ success: boolean; files: string[]; error?: string }>
      folderSizes: (repoPath: string, companyId: string, folder: string, measure: string[]) => Promise<FolderSizesResponse>
      onSparseProgress: (callback: (data: { repoPath: string; receivedBytes: number }) => void) => () => void
      gitBinaryStatus: () => Promise<{ bundled: boolean; binary: string }>

      // Backup
      backupList: (repoPath: string) => Promise<BackupListResult>
      backupRestore: (repoPath: string, backupId: string, filePath: string) => Promise<BackupRestoreResult>
      backupOpenFolder: (backupPath: string) => Promise<{ success: boolean; error?: string }>

      // AI
      chat: (messages: AIMessage[], systemPrompt?: string, workingDirectory?: string) => Promise<AIResponse>
      onAIChunk: (callback: (chunk: string) => void) => () => void
      onAIComplete: (callback: (data?: { thinking?: string; content?: string }) => void) => () => void
      onAIThinking: (callback: (isThinking: boolean) => void) => () => void
      onAIThought: (callback: (thought: string) => void) => () => void
      onAIThoughtStream: (callback: (thought: string) => void) => () => void

      // Chat server (for useChat transport)
      getChatServerInfo: () => Promise<{ port: number; authToken: string } | null>
      onChatServerInfo: (callback: (info: { port: number; authToken: string }) => void) => () => void
    }
  }
}

export {}
