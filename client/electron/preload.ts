// Use require for CommonJS compatibility in Electron preload
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
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  createDirectory: (path: string) => ipcRenderer.invoke('fs:createDirectory', path),
  exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  getDocumentsPath: () => ipcRenderer.invoke('app:getDocumentsPath'),

  // Extended file system operations
  deleteItem: (path: string) => ipcRenderer.invoke('fs:delete', path),
  renameItem: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  moveItem: (sourcePath: string, destPath: string) => ipcRenderer.invoke('fs:move', sourcePath, destPath),
  copyItem: (sourcePath: string, destPath: string) => ipcRenderer.invoke('fs:copy', sourcePath, destPath),
  getStats: (path: string) => ipcRenderer.invoke('fs:stat', path),

  // File watching
  watchDirectory: (rootPath: string) => ipcRenderer.invoke('fs:watch', rootPath),
  unwatchDirectory: (rootPath: string) => ipcRenderer.invoke('fs:unwatch', rootPath),
  onFileChange: (callback: (data: { type: string; path: string }) => void) => {
    const handler = (_: unknown, data: { type: string; path: string }) => callback(data)
    ipcRenderer.on('fs:change', handler)
    return () => ipcRenderer.removeListener('fs:change', handler)
  },

  // Git operations
  gitInit: (repoPath: string) => ipcRenderer.invoke('git:init', repoPath),
  gitIsRepo: (repoPath: string) => ipcRenderer.invoke('git:isRepo', repoPath),
  gitAddRemote: (repoPath: string, remoteName: string, remoteUrl: string) =>
    ipcRenderer.invoke('git:addRemote', repoPath, remoteName, remoteUrl),
  gitSync: (repoPath: string, companyId: string, commitMessage: string) =>
    ipcRenderer.invoke('git:sync', repoPath, companyId, commitMessage),
  gitSetupCompanyRemote: (repoPath: string, companyId: string) =>
    ipcRenderer.invoke('git:setupCompanyRemote', repoPath, companyId),
  gitPushToServer: (repoPath: string) =>
    ipcRenderer.invoke('git:pushToServer', repoPath),

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
  listSkills: (rootPath: string, departmentFolder: string, departmentId: string) =>
    ipcRenderer.invoke('skills:list', rootPath, departmentFolder, departmentId),
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
  getAuthMode: () => ipcRenderer.invoke('config:getAuthMode'),
  setAuthMode: (mode: 'claude-code' | 'api-key') => ipcRenderer.invoke('config:setAuthMode', mode),
  isClaudeCodeAvailable: () => ipcRenderer.invoke('config:isClaudeCodeAvailable'),
  getClaudeCodeStatus: () => ipcRenderer.invoke('config:getClaudeCodeStatus'),
  getPermissionMode: () => ipcRenderer.invoke('config:getPermissionMode'),
  setPermissionMode: (mode: 'bypassPermissions' | 'default') =>
    ipcRenderer.invoke('config:setPermissionMode', mode),

  // Server URL config
  getServerUrl: () => ipcRenderer.invoke('config:getServerUrl'),
  setServerUrl: (url: string) => ipcRenderer.invoke('config:setServerUrl', url),
  validateServerUrl: (url: string) => ipcRenderer.invoke('config:validateServerUrl', url),

  // Tool approval
  onToolApprovalRequest: (callback: (data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown> }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_: any, data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('tool-approval-request', handler)
    return () => { ipcRenderer.removeListener('tool-approval-request', handler) }
  },
  respondToolApproval: (toolUseId: string, approved: boolean) =>
    ipcRenderer.invoke('tool-approval-response', toolUseId, approved),

  // Chat history
  getChatSessions: (companyId: string) =>
    ipcRenderer.invoke('chatHistory:getSessions', companyId),
  getChatSession: (companyId: string, sessionId: string) =>
    ipcRenderer.invoke('chatHistory:getSession', companyId, sessionId),
  saveChatSession: (companyId: string, session: ChatSession) =>
    ipcRenderer.invoke('chatHistory:saveSession', companyId, session),
  deleteChatSession: (companyId: string, sessionId: string) =>
    ipcRenderer.invoke('chatHistory:deleteSession', companyId, sessionId),

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

interface ChatSession {
  id: string
  companyId: string
  title: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    thinking?: string
  }>
  createdAt: string
  updatedAt: string
}

interface GitResult {
  success: boolean
  error?: string
  message?: string
  remoteUrl?: string
  pushFailed?: boolean
  // Sync-specific fields
  hadConflicts?: boolean
  conflictFiles?: string[]
  backupPath?: string
  restoredFolders?: string[]
  ignoredLargeFiles?: string[]
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
      readFile: (path: string) => Promise<string | null>
      writeFile: (path: string, content: string) => Promise<boolean>
      createDirectory: (path: string) => Promise<boolean>
      exists: (path: string) => Promise<boolean>
      getDocumentsPath: () => Promise<string>

      // Extended file system operations
      deleteItem: (path: string) => Promise<{ success: boolean; error?: string }>
      renameItem: (oldPath: string, newPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
      moveItem: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
      copyItem: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
      getStats: (path: string) => Promise<{ success: boolean; data?: { isDirectory: boolean; isFile: boolean; size: number; mtime: string; ctime: string } }>

      // File watching
      watchDirectory: (rootPath: string) => Promise<{ success: boolean; error?: string }>
      unwatchDirectory: (rootPath: string) => Promise<{ success: boolean; error?: string }>
      onFileChange: (callback: (data: { type: string; path: string }) => void) => () => void

      // Environment variables
      readEnv: (rootPath: string) => Promise<EnvResult>
      writeEnv: (rootPath: string, vars: Record<string, string>) => Promise<{ success: boolean; error?: string }>

      // Skills
      listSkills: (rootPath: string, departmentFolder: string, departmentId: string) => Promise<SkillsResult>
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
      getAuthMode: () => Promise<'claude-code' | 'api-key'>
      setAuthMode: (mode: 'claude-code' | 'api-key') => Promise<boolean>
      isClaudeCodeAvailable: () => Promise<boolean>
      getClaudeCodeStatus: () => Promise<{
        available: boolean
        authenticated: boolean
        cliPath: string | null
        version: string | null
        error: string | null
        checkedAt: number
      }>
      getPermissionMode: () => Promise<'bypassPermissions' | 'default'>
      setPermissionMode: (mode: 'bypassPermissions' | 'default') => Promise<boolean>

      // Server URL config
      getServerUrl: () => Promise<string | null>
      setServerUrl: (url: string) => Promise<boolean>
      validateServerUrl: (url: string) => Promise<{ valid: boolean; error?: string; serverName?: string; version?: string }>

      // Tool approval
      onToolApprovalRequest: (callback: (data: { toolUseId: string; toolName: string; toolInput: Record<string, unknown> }) => void) => () => void
      respondToolApproval: (toolUseId: string, approved: boolean) => Promise<boolean>

      // Chat history
      getChatSessions: (companyId: string) => Promise<ChatSession[]>
      getChatSession: (companyId: string, sessionId: string) => Promise<ChatSession | null>
      saveChatSession: (companyId: string, session: ChatSession) => Promise<boolean>
      deleteChatSession: (companyId: string, sessionId: string) => Promise<boolean>

      // Git
      gitInit: (repoPath: string) => Promise<GitResult>
      gitIsRepo: (repoPath: string) => Promise<GitRepoResult>
      gitAddRemote: (repoPath: string, remoteName: string, remoteUrl: string) => Promise<GitResult>
      gitSync: (repoPath: string, companyId: string, commitMessage: string) => Promise<GitResult>
      gitSetupCompanyRemote: (repoPath: string, companyId: string) => Promise<GitResult>
      gitPushToServer: (repoPath: string) => Promise<GitResult>
      serverCreateRepo: (companyId: string) => Promise<ServerRepoResult>

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
