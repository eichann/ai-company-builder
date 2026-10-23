import { ConsultationReferences } from './consultations/service'
import { recoveryContext } from './handoff/recovery-context'
import { AgentInteractions } from './agent-interactions'
import type { AgentInteractionResponse } from '../shared/agent-interaction'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { createCommitMessageGenerator } from './commit-message'
import { app, BrowserWindow, ipcMain, dialog, shell, net as electronNet, protocol, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { exec, execFileSync, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
import { createAnthropic } from '@ai-sdk/anthropic'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { streamText } from 'ai'
import { startChatServer, type ChatServerConfig } from './chat-server'
import type { SimpleGit } from 'simple-git'
import {
  isProtectedConfigRejection,
  parseProtectedConfigPaths,
  protectedConfigMessage,
  isWriteDeniedRejection,
  parseWriteDeniedPaths,
  writeDeniedMessage,
} from './protected-config'
import { createGitSync } from './sync/git-sync'
import { configuredGitCommand, createConfiguredGit } from './sync/git-factory'
import { companySearchScope, gitLogArgs, grepCompany, listCompanyFiles, normalizeSearchFolder, parseGitLog } from './git-search'
import { createMessageBoxSyncDialog } from './sync/message-box-dialog'
import { createFetchSyncServerApi } from './sync/server-api'
import { isDownloadFailure, readSparseConfig, setSparseExclusions, uncommittedChangesIn } from './sync/sparse'
import { folderSizesView, serverFolderSizes } from './sync/folder-sizes'
import { notDownloadedFolderFor, notDownloadedFolders } from './sync/not-downloaded'
import { createCompanyFilesApi } from './company-files/api'
import { companyFilesInstructions, createCompanyFileTools } from './company-files/tools'
import { notDownloadedUserMessage } from '../shared/sparse-paths'
import { companyPathOf, privateBackupsDir, readPrivateScopesCache, readableScopeOf } from './sync/private-folders'

/** backup:list ids of private folders' backups (kept in .git, privateBackupsDir). */
const PRIVATE_BACKUP_ID_PREFIX = 'private:'
import { reservedPathMessage } from '../../shared/types/private-folders'
import { checkoutSelectedDepartments } from './sync/first-setup'
import { configureOrigin, setRemoteUrl } from './sync/remote'
import { previewChanges, withScratchIndex } from './sync/preview'
import { decideCompanyFolder, inspectLocalFolder, sameCompanyRemote, watchPackBytes, type CompanyFolderDecision } from './sync/company-folder'
import { resolveGitBinary, resolveGitDir } from 'dugite'
import chokidar from 'chokidar'
import { CompanyWatcher, coveringRoot, type FileChange, type RawEventType } from './company-watcher'
import { SkillsCache } from '../shared/skills-refresh'
import { editorOverwriteBackupPlan, type EditorOverwriteBackupMetadata } from '../shared/editor-disk-state'
import { localFileTarget } from './local-file-protocol'
import net from 'net'
import { HandoffStore } from './handoff/store'
import { HandoffService } from './handoff/service'
import { writeClaudeHandoff } from './handoff/claude'
import { writeCodexHandoff } from './handoff/codex'
import type { HandoffCompletion } from '../shared/handoff'
import { ChatHistoryStore } from './chat-history-store'
import type { ChatSession, ChatMetadataPatch, ChatHistoryChange, ChatSaveReceipt } from '../shared/chat-history'
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from '../shared/permission-mode'
import { BUILD_INFO, gitIdentityConfig, installServerFetchIdentity } from './client-identity'
import { createWriteAccessStore } from './write-access-store'
import { createPrivateFoldersApi } from './private-folders-api'
import type { InstructionAuthority } from './write-guard'
import type { CreatePrivateFolderRequest } from '../shared/private-folder-ui'

// Allowed directory roots for file system access control
// Paths are added when the user selects a directory via dialog or sets up a company folder
const allowedRoots: Set<string> = new Set()

/**
 * Validate that a path is within an allowed directory.
 * Prevents path traversal attacks from the renderer process.
 */
function validatePath(inputPath: string): string {
  const resolved = path.resolve(inputPath)
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved
    }
  }
  throw new Error(`Access denied: path is outside allowed directories`)
}

/**
 * Add a directory to the allowed roots.
 * Also allows the app's userData directory (for config, etc.).
 */
function addAllowedRoot(dirPath: string): void {
  const resolved = path.resolve(dirPath)
  allowedRoots.add(resolved)
}

/**
 * Refuse an app file operation that would create or change something inside
 * a folder not downloaded on this computer (sparse exclusions): the member
 * cannot see the teammates' files there, and sync would hold the file back
 * instead of sharing it. The renderer disables these actions with the same
 * explanation; this is the backstop. Returns the message, or null to allow.
 */
function notDownloadedRefusal(absPath: string): string | null {
  const folder = notDownloadedFolderFor(absPath)
  if (folder !== null) {
    console.warn(`[fs] Refused a write into a folder that is not downloaded: ${absPath}`)
    return notDownloadedUserMessage(folder.normalize('NFC'))
  }
  return null
}

// One recursive watcher per open company folder (see company-watcher.ts).
const companyWatchers: Map<string, CompanyWatcher> = new Map()

// Skills scans (skills:list), reused for plain tab switches (5 s) and dropped
// as soon as a watcher event makes them stale (sendFileChanges) or the
// renderer forces a refresh. Keys and staleness rules: shared/skills-refresh.ts.
const skillsCache = new SkillsCache<SkillInfo[]>(5000)

// Running tool processes map
interface RunningTool {
  process: ChildProcess
  port: number
  toolPath: string
}
const runningTools: Map<string, RunningTool> = new Map()

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

let mainWindow: BrowserWindow | null = null
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

// Config file path for storing API keys
const getConfigPath = () => path.join(app.getPath('userData'), 'config.json')

interface AppConfig {
  anthropicApiKey?: string
  authMode?: 'claude-code' | 'codex' | 'api-key'
  permissionMode?: PermissionMode
  serverUrl?: string
  docbaseCookie?: string
}

// ============================================================================
// Shell PATH resolution for packaged app
// ============================================================================

/**
 * macOS .app bundles don't inherit the user's shell PATH.
 * Resolve the full PATH by querying the user's login shell.
 */
let resolvedShellPath: string | null = null

// Directories to append to PATH on Windows so the spawned Claude CLI can find
// node/git and its own siblings. Unlike macOS .app bundles, Windows apps DO
// inherit the user's PATH, so we keep it and only append known install dirs.
function getWindowsExtraPathDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.local', 'bin'),               // native installer (claude.exe)
    path.join(home, 'AppData', 'Roaming', 'npm'),   // npm global (claude.cmd)
    path.join(home, '.npm-global'),
    path.join(home, '.npm-global', 'bin'),
  ].filter(p => {
    try { return fs.existsSync(p) } catch { return false }
  })
}

function getShellPath(): string {
  if (resolvedShellPath) return resolvedShellPath

  if (process.platform === 'win32') {
    // Keep the inherited Windows PATH and append known Claude/npm locations,
    // joined with ';' (path.delimiter). Never replace it with POSIX paths.
    const current = process.env.Path || process.env.PATH || ''
    resolvedShellPath = [current, ...getWindowsExtraPathDirs()]
      .filter(Boolean)
      .join(path.delimiter)
    return resolvedShellPath
  }

  const staticPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    path.join(os.homedir(), '.nodenv', 'shims'),
  ]

  // Directories containing version subdirectories (e.g. v22.17.1/bin)
  const versionManagerDirs = [
    path.join(os.homedir(), '.nvm', 'versions', 'node'),
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'),
    path.join(os.homedir(), '.nodenv', 'versions'),
    path.join(os.homedir(), '.asdf', 'installs', 'nodejs'),
    '/usr/local/n/versions/node',
  ]

  // NOTE: Do NOT use execSync here to query the user's shell PATH.
  // execSync with stdio:'pipe' corrupts Electron's file descriptor table,
  // causing spawn EBADF errors in subsequent child process creation.
  // Instead, build PATH from known locations + version manager directories.

  // Expand version manager directories to include all installed versions
  const expandedPaths: string[] = [...staticPaths]
  for (const versionsDir of versionManagerDirs) {
    try {
      if (!fs.existsSync(versionsDir)) continue
      const versions = fs.readdirSync(versionsDir)
      for (const ver of versions) {
        expandedPaths.push(path.join(versionsDir, ver, 'bin'))
      }
    } catch { /* skip */ }
  }

  resolvedShellPath = expandedPaths.join(':')
  return resolvedShellPath
}

/** Get env object with resolved PATH for spawn calls */
function getShellEnv(): Record<string, string> {
  if (process.platform === 'win32') {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    // Remove CLAUDECODE to avoid "nested session" detection when spawning Claude CLI
    delete env['CLAUDECODE']
    // Windows env keys are case-insensitive; replace the EXISTING path key in
    // place (usually 'Path') so the child doesn't get both 'Path' and 'PATH'.
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path'
    env[pathKey] = getShellPath()
    return env
  }
  const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: getShellPath() }
  // Remove CLAUDECODE to avoid "nested session" detection when spawning Claude CLI
  delete env['CLAUDECODE']
  return env
}

// ============================================================================
// Claude Code CLI detection & authentication
// ============================================================================

/** Cached result of Claude Code CLI detection */
let cachedClaudeCodeStatus: {
  available: boolean
  authenticated: boolean
  cliPath: string | null
  version: string | null
  error: string | null
  checkedAt: number
} | null = null

const CLAUDE_STATUS_TTL = 30_000 // Re-check every 30 seconds

/**
 * Find the Claude Code CLI binary by searching common locations.
 * Returns the full path or null if not found.
 */
function findClaudeCodeCli(): string | null {
  // NOTE: Do NOT use execSync (e.g. `which claude`, `where claude.cmd`) here.
  // execSync with stdio:'pipe' corrupts Electron's file descriptor table,
  // causing spawn EBADF errors. Use fs.existsSync on known paths instead.

  if (process.platform === 'win32') {
    const home = os.homedir()
    const winPaths = [
      // Native installer (irm https://claude.ai/install.ps1 | iex) — preferred:
      // a real .exe spawns directly without a shell, even from paths with spaces.
      path.join(home, '.local', 'bin', 'claude.exe'),
      // npm global install (npm i -g @anthropic-ai/claude-code)
      path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(home, '.npm-global', 'claude.cmd'),
      path.join(home, '.npm-global', 'bin', 'claude.cmd'),
      // .cmd shim sometimes placed next to the native install
      path.join(home, '.local', 'bin', 'claude.cmd'),
    ]
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  // macOS / Linux: search common paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',               // Homebrew on Apple Silicon
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
  ]

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p
  }

  // Search Node version manager directories (nvm, fnm, volta, nodenv, asdf, n)
  const versionManagerDirs = [
    path.join(os.homedir(), '.nvm', 'versions', 'node'),       // nvm
    path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions'), // fnm
    path.join(os.homedir(), '.nodenv', 'versions'),             // nodenv
    path.join(os.homedir(), '.asdf', 'installs', 'nodejs'),     // asdf
    '/usr/local/n/versions/node',                                // n
  ]

  for (const versionsDir of versionManagerDirs) {
    try {
      if (!fs.existsSync(versionsDir)) continue
      const versions = fs.readdirSync(versionsDir)
      // Sort descending to prefer newer versions
      versions.sort().reverse()
      for (const ver of versions) {
        const claudePath = path.join(versionsDir, ver, 'bin', 'claude')
        if (fs.existsSync(claudePath)) return claudePath
      }
    } catch { /* skip */ }
  }

  // volta stores binaries directly in ~/.volta/bin
  const voltaPath = path.join(os.homedir(), '.volta', 'bin', 'claude')
  if (fs.existsSync(voltaPath)) return voltaPath

  return null
}

/**
 * Check Claude Code CLI status: availability, path, version, and authentication.
 * Results are cached for CLAUDE_STATUS_TTL milliseconds.
 */
function checkClaudeCodeStatus(forceRefresh = false): typeof cachedClaudeCodeStatus {
  if (!forceRefresh && cachedClaudeCodeStatus && Date.now() - cachedClaudeCodeStatus.checkedAt < CLAUDE_STATUS_TTL) {
    return cachedClaudeCodeStatus
  }

  const status: typeof cachedClaudeCodeStatus = {
    available: false,
    authenticated: false,
    cliPath: null,
    version: null,
    error: null,
    checkedAt: Date.now(),
  }

  // Step 1: Find the CLI binary
  const cliPath = findClaudeCodeCli()
  if (!cliPath) {
    status.error = 'Claude Code CLIが見つかりません。`npm install -g @anthropic-ai/claude-code` でインストールしてください。'
    cachedClaudeCodeStatus = status
    return status
  }
  status.cliPath = cliPath

  // Step 2: Mark as available if binary exists
  // NOTE: Do NOT use execSync here (e.g. `claude --version`) — it corrupts
  // Electron's file descriptor table and causes `spawn EBADF` on subsequent
  // process spawns (e.g. when launching the Claude CLI for chat).
  // Actual auth errors will surface at API call time with a clear message.
  status.available = true
  status.authenticated = true
  status.version = 'installed'

  cachedClaudeCodeStatus = status
  return status
}

/**
 * Legacy compat: returns true if Claude Code CLI is available AND authenticated.
 */
function isClaudeCodeAuthenticated(): boolean {
  const status = checkClaudeCodeStatus()
  return status?.available === true && status?.authenticated === true
}

/**
 * Get the resolved path to Claude Code CLI binary.
 * Returns the path or a platform-appropriate fallback.
 */
function getClaudeCodeCliPath(): string {
  const status = checkClaudeCodeStatus()
  return status?.cliPath || (process.platform === 'win32' ? 'claude.cmd' : 'claude')
}

let cachedConfig: AppConfig | null = null

function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      return cachedConfig!
    }
  } catch {
    // ignore
  }
  cachedConfig = {}
  return cachedConfig
}

function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  cachedConfig = config
}

function createWindow() {
  const disableElectronSpellcheck =
    process.env.ELECTRON_DISABLE_SPELLCHECK === '1' ||
    process.env.ELECTRON_DISABLE_SPELL_CHECKING === '1'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Reversible A/B test switch for input lag diagnosis.
      spellcheck: !disableElectronSpellcheck,
      // Required for the in-iframe Chromium PDF Viewer to render `blob:` PDFs in
      // packaged builds. Without this, dev (HTTP origin) happens to work but the
      // production file:// origin blocks the embedded PDF viewer.
      plugins: true,
    },
  })

  // Fully disable spell checker to prevent dictionary loading overhead (especially for Japanese IME)
  mainWindow.webContents.session.setSpellCheckerLanguages([])

  // Inject DocBase cookie for image.docbase.io requests (fixes 403 on DocBase images)
  const appConfig = loadConfig()
  if (appConfig.docbaseCookie) {
    const docbaseCookie = appConfig.docbaseCookie
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://image.docbase.io/*'] },
      (details, callback) => {
        details.requestHeaders['Cookie'] = docbaseCookie
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // DevTools disabled for performance testing - uncomment below line to enable
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null

// Register custom protocol for serving local files (images etc.)
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } },
])

// IPC handler for renderer to request chat server info on demand
ipcMain.handle('chat-server:getInfo', () => {
  return chatServerInfo
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Clean up file watchers on app quit (a native recursive watcher closes in
// well under a millisecond; chokidar's per-directory watchers took 30+ s).
app.on('before-quit', () => {
  companyWatchers.forEach((watcher) => watcher.close())
  companyWatchers.clear()

  // Kill running skill tools so dev servers don't outlive the app.
  // Windows has no process groups/POSIX signals — kill the tree via taskkill.
  for (const [toolPath, tool] of runningTools) {
    const pid = tool.process.pid
    if (!pid) continue
    console.log('[before-quit] stopping tool:', toolPath)
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', pid.toString(), '/f', '/t'], { windowsHide: true })
      } catch { /* best effort on quit */ }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try { tool.process.kill('SIGTERM') } catch { /* already gone */ }
      }
    }
  }
  runningTools.clear()
})

// IPC Handlers for file system operations
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  })
  const selected = result.filePaths[0] || null
  if (selected) {
    addAllowedRoot(selected)
  }
  return selected
})

// Register a directory as allowed for file system access (called when company folder is set)
ipcMain.handle('fs:registerAllowedRoot', async (_, dirPath: string) => {
  if (dirPath && typeof dirPath === 'string') {
    addAllowedRoot(dirPath)
  }
  return { success: true }
})

ipcMain.handle('fs:readDirectory', async (_, dirPath: string) => {
  try {
    const safePath = validatePath(dirPath)
    const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(safePath, entry.name),
    }))
  } catch {
    return []
  }
})

const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '.backups', '.workspace', '__pycache__', '.next', '.nuxt', 'dist', '.venv', 'venv'])


ipcMain.handle('fs:readDirectoryTree', async (_, dirPath: string, maxDepth: number = 2) => {
  try {
    const safePath = validatePath(dirPath)
    const readLevel = async (dir: string, depth: number): Promise<Array<{ name: string; isDirectory: boolean; path: string; children?: Array<unknown> }>> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      const results = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name)
        const isDir = entry.isDirectory()
        const node: { name: string; isDirectory: boolean; path: string; children?: Array<unknown> } = {
          name: entry.name,
          isDirectory: isDir,
          path: entryPath,
        }
        if (isDir && depth < maxDepth && !TREE_SKIP_DIRS.has(entry.name)) {
          try {
            node.children = await readLevel(entryPath, depth + 1)
          } catch {
            node.children = []
          }
        }
        return node
      }))
      return results
    }
    return await readLevel(safePath, 0)
  } catch {
    return []
  }
})

ipcMain.handle('fs:readFile', async (_, filePath: string) => {
  try {
    const safePath = validatePath(filePath)
    return await fs.promises.readFile(safePath, 'utf-8')
  } catch {
    return null
  }
})

ipcMain.handle('fs:readFileBinary', async (_, filePath: string) => {
  try {
    const safePath = validatePath(filePath)
    const buffer = await fs.promises.readFile(safePath)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
  try {
    const safePath = validatePath(filePath)
    if (notDownloadedRefusal(safePath) || await reservedRefusal(safePath)) return false
    await fs.promises.writeFile(safePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
})

// Before the editor overwrites a file someone else changed since the tab
// loaded it (the member confirmed): keep the disk version, byte for byte, in
// .backups/<ts>_editor_overwrite/ — or .git/acb-private-backups/ for a file in
// a private folder (never in that folder's working tree). Plan and rules:
// shared/editor-disk-state.ts.
ipcMain.handle('editor:backupBeforeOverwrite', async (_, rootPath: string, filePath: string) => {
  try {
    const root = validatePath(rootPath)
    const safePath = validatePath(filePath)
    let bytes: Buffer
    try {
      bytes = await fs.promises.readFile(safePath)
    } catch {
      return { success: true, skipped: 'missing' as const }
    }
    let insideNestedRepo = false
    for (let dir = path.dirname(safePath); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) { insideNestedRepo = true; break }
    }
    const cache = readPrivateScopesCache(root)
    const plan = editorOverwriteBackupPlan({
      rootPath: root,
      filePath: safePath,
      privateFolders: cache ? [...cache.scopes, ...(cache.pendingPublic ?? [])].map(s => s.path) : [],
      insideNestedRepo,
      now: new Date(),
    })
    if ('skip' in plan) return { success: true, skipped: plan.skip }
    const backupDir = path.join(plan.privateFolder ? privateBackupsDir(root) : path.join(root, '.backups'), plan.folder)
    const target = path.join(backupDir, ...plan.rel.split('/'))
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, bytes)
    const metadata: EditorOverwriteBackupMetadata = {
      timestamp: new Date().toISOString(),
      reason: 'editor_overwrite',
      files: [plan.rel],
      privateFolder: plan.privateFolder,
    }
    await fs.promises.writeFile(path.join(backupDir, '_metadata.json'), JSON.stringify(metadata, null, 2))
    return { success: true, backupPath: backupDir }
  } catch (error) {
    console.error('[editor] backup before overwrite failed:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('fs:createDirectory', async (_, dirPath: string) => {
  try {
    const safePath = validatePath(dirPath)
    if (notDownloadedRefusal(safePath) || await reservedRefusal(safePath)) return false
    await fs.promises.mkdir(safePath, { recursive: true })
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:exists', async (_, targetPath: string) => {
  try {
    const safePath = validatePath(targetPath)
    await fs.promises.access(safePath)
    return true
  } catch {
    return false
  }
})

// Delete file or folder
ipcMain.handle('fs:delete', async (_, targetPath: string) => {
  try {
    const safePath = validatePath(targetPath)
    const stat = await fs.promises.stat(safePath)
    if (stat.isDirectory()) {
      await fs.promises.rm(safePath, { recursive: true })
    } else {
      await fs.promises.unlink(safePath)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Rename file or folder
ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
  try {
    const safeOld = validatePath(oldPath)
    const safeNew = validatePath(newPath)
    const refused = notDownloadedRefusal(safeNew) ?? await reservedRefusal(safeNew)
    if (refused) return { success: false, error: refused }
    await fs.promises.rename(safeOld, safeNew)
    return { success: true, newPath: safeNew }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Move file or folder
ipcMain.handle('fs:move', async (_, sourcePath: string, destinationPath: string) => {
  try {
    const safeSrc = validatePath(sourcePath)
    const safeDest = validatePath(destinationPath)
    const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
    if (refused) return { success: false, error: refused }
    await fs.promises.rename(safeSrc, safeDest)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Move file from external location (e.g. Finder drop)
// Source path is NOT validated (external), only destination is validated
ipcMain.handle('fs:moveFromExternal', async (_, sourcePath: string, destinationPath: string) => {
  try {
    const safeDest = validatePath(destinationPath)
    const resolved = path.resolve(sourcePath)
    const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
    if (refused) return { success: false, error: refused }

    try {
      await fs.promises.rename(resolved, safeDest)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
        // Cross-volume: copy then delete original
        const stat = await fs.promises.stat(resolved)
        if (stat.isDirectory()) {
          await fs.promises.cp(resolved, safeDest, { recursive: true })
          await fs.promises.rm(resolved, { recursive: true, force: true })
        } else {
          await fs.promises.copyFile(resolved, safeDest)
          await fs.promises.unlink(resolved)
        }
      } else {
        throw err
      }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Copy file or folder
ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationPath: string) => {
  try {
    const safeSrc = validatePath(sourcePath)
    const safeDest = validatePath(destinationPath)
    const refused = notDownloadedRefusal(safeDest) ?? await reservedRefusal(safeDest)
    if (refused) return { success: false, error: refused }
    const stat = await fs.promises.stat(safeSrc)
    if (stat.isDirectory()) {
      await fs.promises.cp(safeSrc, safeDest, { recursive: true })
    } else {
      await fs.promises.copyFile(safeSrc, safeDest)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Get file/folder stats
ipcMain.handle('fs:stat', async (_, targetPath: string) => {
  try {
    const safePath = validatePath(targetPath)
    const stat = await fs.promises.stat(safePath)
    return {
      success: true,
      data: {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ctime: stat.ctime.toISOString(),
      }
    }
  } catch {
    return { success: false }
  }
})

// Native drag to external apps (browser, Finder, Slack, etc.)
ipcMain.on('fs:startDrag', (event, filePath: string) => {
  const safePath = validatePath(filePath)
  event.sender.startDrag({
    file: safePath,
    icon: nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
    ),
  })
})

/**
 * Where recursive fs.watch is unavailable (Linux before Node 20): chokidar on
 * the company root, its events fed into the same classifier.
 */
function chokidarFallback(root: string, onRaw: (type: RawEventType, rel: string) => void, onError: (error: unknown) => void) {
  const watcher = chokidar.watch(root, {
    // Same directories as the recursive watcher; non-regular files (sockets
    // in temporary browser profiles) make fs.watch throw.
    ignored: (targetPath, stats) =>
      /(^|[\\/])(\.git|node_modules|\.workspace|\.backups)([\\/])/i.test(targetPath)
      || !!(stats && !stats.isFile() && !stats.isDirectory()),
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    followSymlinks: false,
    ignorePermissionErrors: true,
  })
  watcher.on('error', onError)
  const rel = (p: string) => path.relative(root, p)
  watcher.on('add', p => onRaw('rename', rel(p)))
  watcher.on('addDir', p => onRaw('rename', rel(p)))
  watcher.on('unlink', p => onRaw('rename', rel(p)))
  watcher.on('unlinkDir', p => onRaw('rename', rel(p)))
  watcher.on('change', p => onRaw('change', rel(p)))
  return { close: () => { void watcher.close() } }
}

function sendFileChanges(changes: FileChange[]): void {
  // A skill the AI (or anything else) created, changed or removed is scanned
  // afresh by the next skills:list.
  skillsCache.invalidateForChanges(changes)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fs:changes', changes)
  }
}

// Watch a company folder: one recursive watcher for the whole company, kept
// open across department switches. Idempotent; a folder inside an already
// watched one is covered by it.
ipcMain.handle('fs:watch', async (_, rootPath: string) => {
  try {
    const safePath = validatePath(rootPath)
    if (coveringRoot(companyWatchers.keys(), safePath)) return { success: true }
    // A parent opened after a child replaces the child's watcher.
    for (const [root, watcher] of companyWatchers) {
      if (root.startsWith(safePath + path.sep)) {
        watcher.close()
        companyWatchers.delete(root)
      }
    }
    const watcher = new CompanyWatcher({ root: safePath, onChanges: sendFileChanges, fallback: chokidarFallback })
    watcher.start()
    companyWatchers.set(safePath, watcher)
    console.log(`[fs-watch] watching ${safePath} (${watcher.mode ?? 'retrying'})`)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Stop watching a company folder (the company was closed or switched).
ipcMain.handle('fs:unwatch', async (_, rootPath: string) => {
  try {
    const safePath = validatePath(rootPath)
    const watcher = companyWatchers.get(safePath)
    if (watcher) {
      watcher.close()
      companyWatchers.delete(safePath)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('app:getDocumentsPath', () => {
  return app.getPath('documents')
})

// .env file management
interface EnvVars {
  [key: string]: string
}

function parseEnvFile(content: string): EnvVars {
  const result: EnvVars = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim()
      let value = trimmed.slice(eqIndex + 1).trim()
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  }
  return result
}

function stringifyEnvFile(vars: EnvVars): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    // Quote values that contain spaces or special characters
    const needsQuotes = /[\s#=]/.test(value)
    const quotedValue = needsQuotes ? `"${value}"` : value
    lines.push(`${key}=${quotedValue}`)
  }
  return lines.join('\n') + '\n'
}

ipcMain.handle('env:read', async (_, rootPath: string) => {
  try {
    const safePath = validatePath(rootPath)
    const envPath = path.join(safePath, '.env')
    if (!fs.existsSync(envPath)) {
      return { success: true, vars: {} }
    }
    const content = await fs.promises.readFile(envPath, 'utf-8')
    const vars = parseEnvFile(content)
    return { success: true, vars }
  } catch (error) {
    console.error('Failed to read .env:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('env:write', async (_, rootPath: string, vars: EnvVars) => {
  try {
    const safePath = validatePath(rootPath)
    const envPath = path.join(safePath, '.env')
    const content = stringifyEnvFile(vars)
    await fs.promises.writeFile(envPath, content, 'utf-8')

    // Self-heal: ensure secrets are never synced, even for older folders whose
    // .gitignore predates the seed (or had the entries removed). The .env file
    // holds API keys, so it must stay local-only.
    const gitignorePath = path.join(safePath, '.gitignore')
    let gitignoreContent = ''
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
    }
    const existingLines = gitignoreContent.split('\n').map((line) => line.trim())
    const missing = ['.env', '.env.*', '!.env.example', '!.env.sample'].filter((p) => !existingLines.includes(p))
    if (missing.length > 0) {
      const prefix = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : ''
      const header = existingLines.includes('# Secrets — never sync (local only)')
        ? ''
        : '# Secrets — never sync (local only)\n'
      fs.appendFileSync(gitignorePath, prefix + header + missing.join('\n') + '\n')
    }

    return { success: true }
  } catch (error) {
    console.error('Failed to write .env:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// API Key management
ipcMain.handle('config:getApiKey', () => {
  const config = loadConfig()
  return config.anthropicApiKey || null
})

ipcMain.handle('config:setApiKey', (_, apiKey: string) => {
  const config = loadConfig()
  config.anthropicApiKey = apiKey
  saveConfig(config)
  return true
})

ipcMain.handle('config:hasApiKey', () => {
  const config = loadConfig()
  return !!config.anthropicApiKey
})

// Auth mode management
ipcMain.handle('codex:status', () => getCodexStatus(getShellEnv()))

ipcMain.handle('config:getAuthMode', () => {
  const config = loadConfig()
  return config.authMode || 'claude-code'
})

ipcMain.handle('config:setAuthMode', (_, mode: 'claude-code' | 'codex' | 'api-key') => {
  const config = loadConfig()
  if (!['claude-code', 'codex', 'api-key'].includes(mode)) throw new Error('不明なAI接続方式です。')
  config.authMode = mode
  saveConfig(config)
  return true
})

ipcMain.handle('config:isClaudeCodeAvailable', () => {
  return isClaudeCodeAuthenticated()
})

ipcMain.handle('config:getClaudeCodeStatus', () => {
  const status = checkClaudeCodeStatus(true) // force refresh when explicitly requested
  return status
})

ipcMain.handle('config:getPermissionMode', () => {
  return normalizePermissionMode(loadConfig().permissionMode)
})

ipcMain.handle('config:setPermissionMode', (_, mode: PermissionMode) => {
  if (!PERMISSION_MODES.includes(mode)) return false
  const config = loadConfig()
  config.permissionMode = mode
  saveConfig(config)
  return true
})

// Server URL configuration
ipcMain.handle('config:getServerUrl', () => {
  const config = loadConfig()
  return config.serverUrl || process.env.API_URL || null
})

ipcMain.handle('config:setServerUrl', (_, url: string) => {
  const config = loadConfig()
  config.serverUrl = url
  saveConfig(config)
  return true
})

ipcMain.handle('config:validateServerUrl', async (_, url: string) => {
  try {
    const normalizedUrl = url.replace(/\/+$/, '')
    const response = await fetch(`${normalizedUrl}/api/config`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return { valid: false, error: `Server responded with status ${response.status}` }
    }
    const data = await response.json()
    if (data.success && data.data?.name === 'AI Company Builder') {
      return { valid: true, serverName: data.data.name, version: data.data.version }
    }
    return { valid: false, error: 'Not an AI Company Builder server' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { valid: false, error: `Could not connect: ${message}` }
  }
})

// DocBase cookie for image proxy
ipcMain.handle('config:getDocbaseCookie', () => {
  const config = loadConfig()
  return config.docbaseCookie || null
})

ipcMain.handle('config:setDocbaseCookie', (_, cookie: string) => {
  const config = loadConfig()
  config.docbaseCookie = cookie
  saveConfig(config)
  // Apply immediately to current session
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://image.docbase.io/*'] },
      (details, callback) => {
        details.requestHeaders['Cookie'] = cookie
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }
  return true
})

const agentInteractions = new AgentInteractions((owner, event, request) => {
  const target = mainWindow?.webContents
  if (target && !target.isDestroyed() && target.id === owner) target.send(`agent-interaction:${event}`, request)
})
ipcMain.handle('agent-interaction:list', event => agentInteractions.list(event.sender.id))
ipcMain.handle('agent-interaction:respond', (event, id: string, response: AgentInteractionResponse) => agentInteractions.respond(event.sender.id, id, response))

// Tool approval IPC (chat-server → renderer → response)
const pendingApprovals = new Map<string, { resolve: (result: { approved: boolean }) => void }>()

ipcMain.handle('tool-approval-response', (_, toolUseId: string, approved: boolean) => {
  const pending = pendingApprovals.get(toolUseId)
  if (pending) {
    pending.resolve({ approved })
    pendingApprovals.delete(toolUseId)
  }
  return true
})

// Local history stays in the existing per-device userData directory.
const localHistoryStore = new ChatHistoryStore(path.join(app.getPath('userData'), 'chat-history'))
const handoffStore = new HandoffStore(path.join(app.getPath('userData'), 'chat-handoffs'), localHistoryStore)
const handoffs = new HandoffService(localHistoryStore, handoffStore, async (provider, request) => {
  const cwd = path.join(app.getPath('userData'), 'handoff-worker')
  fs.mkdirSync(cwd, { recursive: true })
  const input = { ...request, cwd, env: getShellEnv() }
  return provider === 'claude-code' ? writeClaudeHandoff({ ...input, cli: getClaudeCodeCliPath() }) : writeCodexHandoff(input)
}, (companyId, sessionId) => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('handoff:changed', { companyId, sessionId }) })
try { handoffStore.cleanupDeleted() } catch { console.warn('[handoff] Startup cleanup deferred: history unavailable') }
app.on('before-quit', () => handoffs.dispose())
// History writes are coalesced and asynchronous; whatever is still pending is written now.
app.on('will-quit', () => localHistoryStore.flushSync())
ipcMain.handle('handoff:get', (_, company: string, id: string) => { handoffs.touch(company, id); return handoffs.view(company, id) })
ipcMain.handle('handoff:update', (_, company: string, id: string) => handoffs.requestUpdate(company, id))
ipcMain.handle('handoff:complete', (_, company: string, id: string, receipt: HandoffCompletion) => handoffs.complete(company, id, receipt))
// Targeted change events: a tab re-reads only its own session's metadata and the
// sidebar re-reads the summaries (no message bodies), never the whole history.
function broadcastChatHistoryChanged(change: ChatHistoryChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chatHistory:changed', change)
  }
}
ipcMain.handle('chatHistory:getSummaries', (_, companyId: string) => localHistoryStore.summaries(companyId))
ipcMain.handle('chatHistory:search', (_, companyId: string, query: string) => localHistoryStore.search(companyId, query))
ipcMain.handle('chatHistory:getSession', (_, companyId: string, sessionId: string) =>
  localHistoryStore.get(companyId, sessionId))
// The receipt, not the stored session: sending the whole conversation back on
// every autosave cost as much IPC as the save itself.
function persistChatSession(companyId: string, session: ChatSession): ChatSaveReceipt {
  const result = localHistoryStore.save(companyId, session)
  if (result.status === 'deleted') return result
  if (result.status === 'saved') broadcastChatHistoryChanged({ companyId, sessionId: session.id, kind: 'save' })
  return { status: result.status, revision: result.session.revision ?? 0 }
}
ipcMain.handle('chatHistory:saveSession', (_, companyId: string, session: ChatSession) =>
  persistChatSession(companyId, session))
// Used only during unload, when an asynchronous renderer request cannot be awaited.
ipcMain.on('chatHistory:flushSession', (event, companyId: string, session: ChatSession) => {
  try { event.returnValue = { result: persistChatSession(companyId, session) } }
  catch (error) { event.returnValue = { error: error instanceof Error ? error.message : '保存に失敗しました。' } }
})
ipcMain.handle('chatHistory:patchSession', (_, companyId: string, sessionId: string, patch: ChatMetadataPatch) => {
  const result = localHistoryStore.patch(companyId, sessionId, patch)
  broadcastChatHistoryChanged({ companyId, sessionId, kind: 'patch' })
  return result
})
ipcMain.handle('chatHistory:deleteSession', (_, companyId: string, sessionId: string) => {
  localHistoryStore.delete(companyId, sessionId)
  handoffs.invalidate(companyId, sessionId)
  broadcastChatHistoryChanged({ companyId, sessionId, kind: 'delete', deletedSessionId: sessionId })
  return true
})

// Server API URL - read from config.json (set during first-launch setup) with env fallback
function getServerApiUrl(): string {
  const config = loadConfig()
  return config.serverUrl || process.env.API_URL || ''
}

// Every fetch() to the server's origin carries X-ACB-Client-Version /
// X-ACB-Client-Platform, so the server knows which build each member runs.
installServerFetchIdentity(getServerApiUrl)
console.log(`[client-identity] build ${BUILD_INFO.version} (built ${BUILD_INFO.builtAt})`)

function extractResponseMessageFromJson(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const message = record.message
  const error = record.error
  if (typeof message === 'string' && message) return message
  if (typeof error === 'string' && error) return error
  return undefined
}

async function parseJsonResponseSafe(response: Response): Promise<{
  json: unknown | null
  nonJsonError?: string
}> {
  const text = await response.text()
  if (!text) {
    return { json: null }
  }

  try {
    return { json: JSON.parse(text) }
  } catch {
    const preview = text.replace(/\s+/g, ' ').slice(0, 120)
    return {
      json: null,
      nonJsonError: `API returned non-JSON response (status ${response.status}) from ${getServerApiUrl()}. Preview: ${preview}`,
    }
  }
}

// Session cookie storage (in-memory for the session)
let authCookies: string[] = []

// Per-folder write access of the signed-in member (shared/write-access.ts).
// The renderer asks when it opens a company and gets writeAccess:changed
// broadcasts after that; the chat refreshes it per turn, sync after success.
const writeAccessStore = createWriteAccessStore({
  baseUrl: getServerApiUrl,
  cookies: () => authCookies,
  onChange: (companyId, access) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('writeAccess:changed', { companyId, access })
  },
})
// The chat AI's read-only company files (company-files/): the session stays
// here in the main process; answers are cached briefly per member.
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: () => authCookies, log: console })

// Auth API handlers
ipcMain.handle('auth:signUp', async (_, email: string, password: string, name?: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'app://',
      },
      body: JSON.stringify({ email, password, name: name || email.split('@')[0] }),
    })

    // Store cookies from response
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) {
      authCookies = cookies
    }

    const { json, nonJsonError } = await parseJsonResponseSafe(response)
    if (nonJsonError) {
      return { success: false, error: nonJsonError }
    }

    const data = json as Record<string, unknown> | null
    if (!response.ok) {
      return { success: false, error: extractResponseMessageFromJson(data) || 'Sign up failed' }
    }
    return { success: true, data }
  } catch (error) {
    console.error('Sign up error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('auth:signIn', async (_, email: string, password: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'app://',
      },
      body: JSON.stringify({ email, password }),
    })

    // Store cookies from response
    const cookies = response.headers.getSetCookie()
    if (cookies.length > 0) {
      authCookies = cookies
    }

    const { json, nonJsonError } = await parseJsonResponseSafe(response)
    if (nonJsonError) {
      return { success: false, error: nonJsonError }
    }

    const data = json as Record<string, unknown> | null
    if (!response.ok) {
      return { success: false, error: extractResponseMessageFromJson(data) || 'Sign in failed' }
    }
    return { success: true, data }
  } catch (error) {
    console.error('Sign in error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('auth:signOut', async () => {
  try {
    await fetch(`${getServerApiUrl()}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'app://',
        'Cookie': authCookies.join('; '),
      },
    })
    authCookies = []
    writeAccessStore.clear()
    companyFilesApi.clear()
    return { success: true }
  } catch (error) {
    console.error('Sign out error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('auth:getSession', async () => {
  try {
    if (authCookies.length === 0) {
      return { success: false, user: null }
    }

    const response = await fetch(`${getServerApiUrl()}/api/me`, {
      headers: {
        'Cookie': authCookies.join('; '),
      },
    })

    if (!response.ok) {
      return { success: false, user: null }
    }

    const data = await response.json()
    if (data.success && data.data) {
      return { success: true, user: data.data }
    }
    return { success: false, user: null }
  } catch (error) {
    console.error('Get session error:', error)
    return { success: false, user: null }
  }
})

// Companies API handlers
ipcMain.handle('api:getCompanies', async () => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/companies`, {
      headers: {
        'Cookie': authCookies.join('; '),
      },
    })

    const data = await response.json()
    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to fetch companies' }
    }
    return data
  } catch (error) {
    console.error('Get companies error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('api:createCompany', async (_, name: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/companies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': authCookies.join('; '),
      },
      body: JSON.stringify({ name }),
    })

    const data = await response.json()
    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to create company' }
    }
    return data
  } catch (error) {
    console.error('Create company error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('api:getCompany', async (_, companyId: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/companies/${companyId}`, {
      headers: {
        'Cookie': authCookies.join('; '),
      },
    })

    const data = await response.json()
    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to fetch company' }
    }
    return data
  } catch (error) {
    console.error('Get company error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('api:getDepartments', async (_, companyId: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/companies/${companyId}/departments`, {
      headers: {
        'Cookie': authCookies.join('; '),
      },
    })

    const data = await response.json()
    if (!response.ok) {
      return { success: false, error: data.error || 'Failed to fetch departments' }
    }
    return data
  } catch (error) {
    console.error('Get departments error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// ============================================================================
// Git HTTPS authentication via GIT_ASKPASS
// ============================================================================

/** Path to the GIT_ASKPASS helper script */
let gitAskPassPath: string | null = null

/**
 * Create a GIT_ASKPASS helper script that outputs the session token.
 * Git calls this script when HTTPS authentication is needed.
 */
function getGitAskPassPath(): string {
  if (gitAskPassPath && fs.existsSync(gitAskPassPath)) return gitAskPassPath

  // Use a path without spaces to avoid issues with GIT_ASKPASS execution
  const dir = path.join(os.tmpdir(), 'acb-git-helpers')
  fs.mkdirSync(dir, { recursive: true })

  const isWindows = process.platform === 'win32'
  const scriptPath = path.join(dir, isWindows ? 'git-askpass.bat' : 'git-askpass.sh')

  if (isWindows) {
    fs.writeFileSync(scriptPath, '@echo %GIT_TOKEN%\r\n')
  } else {
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho "$GIT_TOKEN"\n')
    fs.chmodSync(scriptPath, 0o755)
  }

  gitAskPassPath = scriptPath
  return scriptPath
}

/**
 * Extract the Better Auth session token from authCookies.
 */
function extractSessionToken(cookies: string[]): string {
  for (const cookie of cookies) {
    // Better Auth session cookie (with or without __Secure- prefix)
    const match = cookie.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)
    if (match) {
      let token = match[1]
      try {
        token = decodeURIComponent(token)
      } catch { /* use as-is */ }
      // Better Auth signed cookies: "token.signature" — extract token part only
      const dotIndex = token.indexOf('.')
      if (dotIndex > 0) {
        token = token.slice(0, dotIndex)
      }
      return token
    }
  }
  return ''
}

// Resolve git binary: try dugite's bundled git first, fall back to system git.
// The mac build ships a universal (arm64 + x86_64) bundled git
// (scripts/universal-git.mjs). The system-git fallback is a last resort only:
// Apple Git 2.39 at /usr/bin/git has a broken chunked HTTP push and known
// CVEs, which is what Intel Macs ran while the bundled git was arm64-only.
function resolveGitBinaryWithFallback(): { binary: string; envOverrides: Record<string, string>; fallback: boolean } {
  const dugiteBinary = resolveGitBinary()
  try {
    // Quick check: can the bundled binary actually execute?
    const version = execFileSync(dugiteBinary, ['--version'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    console.log(`[git] Using bundled git: ${dugiteBinary} (${version}, ${process.platform}-${process.arch})`)
    const gitDir = resolveGitDir()
    return {
      binary: dugiteBinary,
      envOverrides: {
        GIT_EXEC_PATH: path.join(gitDir, 'libexec', 'git-core'),
        // GIT_TEMPLATE_DIR is set by the git factory for every binary: an
        // empty app-owned directory, so init/clone copy no templates.
      },
      fallback: false,
    }
  } catch (error) {
    // Bundled git failed (e.g. arch mismatch) — fall back to system git
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[git] Bundled git ${dugiteBinary} failed on ${process.platform}-${process.arch} (${reason}); falling back to system git`)
    const systemPaths = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
    for (const p of systemPaths) {
      if (fs.existsSync(p)) {
        console.log(`[git] Using system git: ${p}`)
        return { binary: p, envOverrides: {}, fallback: true }
      }
    }
    // Last resort: hope 'git' is in PATH
    console.warn('[git] No system git found, using PATH lookup')
    return { binary: 'git', envOverrides: {}, fallback: true }
  }
}

// Cache the resolved git binary (checked once at startup)
let _resolvedGit: ReturnType<typeof resolveGitBinaryWithFallback> | null = null
function getResolvedGit() {
  if (!_resolvedGit) _resolvedGit = resolveGitBinaryWithFallback()
  return _resolvedGit
}

// Create a simpleGit instance with HTTPS token authentication
function createGit(repoPath: string, extraEnv?: Record<string, string>): SimpleGit {
  const { binary, envOverrides } = getResolvedGit()
  return createConfiguredGit(repoPath, {
    binary,
    askPassPath: getGitAskPassPath(),
    token: extractSessionToken(authCookies),
    // App-owned hooks/ and templates/ (empty): the member's git hooks and
    // init.templateDir never run in the app (sync/git-factory.ts appGitDirs).
    appGitDir: path.join(app.getPath('userData'), 'git'),
    envOverrides: extraEnv ? { ...envOverrides, ...extraEnv } : envOverrides,
    // X-ACB-Client-Version / X-ACB-Client-Platform on git's HTTP requests,
    // so the server records which build synced (electron/client-identity.ts).
    extraConfig: gitIdentityConfig(),
  })
}

// Report which git binary is in use (bundled dugite git vs system fallback),
// so the UI can warn when the bundled binary failed (e.g. arch mismatch).
ipcMain.handle('git:getBinaryStatus', async () => {
  const { binary, fallback } = getResolvedGit()
  return { bundled: !fallback, binary }
})

// Git operations
ipcMain.handle('git:init', async (_, repoPath: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    await git.init()
    return { success: true }
  } catch (error) {
    console.error('Git init error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('git:isRepo', async (_, repoPath: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    const isRepo = await git.checkIsRepo()
    return { isRepo }
  } catch {
    return { isRepo: false }
  }
})

ipcMain.handle('git:addRemote', async (_, repoPath: string, remoteName: string, remoteUrl: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    // set-url, never remove + add: removing drops a partial clone's
    // promisor config (./sync/remote.ts).
    await setRemoteUrl(git, remoteUrl, remoteName)
    return { success: true }
  } catch (error) {
    console.error('Git addRemote error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Sync's commit message (electron/commit-message.ts): written by the AI the
// member signs in with — Claude Code (`claude -p --model haiku`, isolated),
// Codex, or the API key — from the staged file list only (name-status +
// stat, no contents). No AI, a failure or 30 s without an answer → null, and
// sync commits its fixed message. A private folder's clone uses the API key
// only, as before.
// `gitFor` picks the index: the member's own for sync, a throwaway copy for
// the preview's summary (git:generateSummary — preview never stages).
const commitMessageGenerator = (gitFor: (repoPath: string) => SimpleGit) => createCommitMessageGenerator({
  readStaged: async (repoPath) => {
    const git: SimpleGit = gitFor(repoPath)
    // core.quotePath=false: Japanese names as text, not octal escapes.
    const stat = await git.raw(['-c', 'core.quotePath=false', 'diff', '--cached', '--stat'])
    const nameStatus = await git.raw(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-status'])
    return { nameStatus, stat }
  },
  settings: () => {
    const config = loadConfig()
    return { authMode: config.authMode || 'claude-code', apiKey: config.anthropicApiKey }
  },
  claudeReady: isClaudeCodeAuthenticated,
  getCli: getClaudeCodeCliPath,
  getEnv: getShellEnv,
  getCwd: () => {
    const cwd = path.join(app.getPath('userData'), 'commit-message')
    fs.mkdirSync(cwd, { recursive: true })
    return cwd
  },
})
const generateCommitMessage = commitMessageGenerator(createGit)

// Preview changes before sync. Strictly read-only: it never stages — a
// staged file inside a not-downloaded folder slipped past sync's
// outside-checkout hold-back and was shared (sync/preview.ts).
ipcMain.handle('git:preview', async (_, repoPath: string) => {
  try {
    const safePath = validatePath(repoPath)
    const git: SimpleGit = createGit(safePath)
    const { added, modified, deleted } = await previewChanges(git)

    const totalCount = added.length + modified.length + deleted.length

    return {
      success: true,
      hasChanges: totalCount > 0,
      changes: { added, modified, deleted },
      totalCount,
    }
  } catch (err) {
    console.error('Git preview error:', err)
    return {
      success: false,
      hasChanges: false,
      changes: { added: [], modified: [], deleted: [] },
      totalCount: 0,
      error: err instanceof Error ? err.message : 'Preview failed',
    }
  }
})

// Revert a file's changes (git checkout HEAD -- <file> or git rm for new files)
ipcMain.handle('git:revertFile', async (_, repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
  try {
    const safePath = validatePath(repoPath)
    const git: SimpleGit = createGit(safePath)

    if (fileStatus === 'added') {
      // New file: drop it from the index if it is there (preview no longer
      // stages, so it usually is not) and delete it
      await git.raw(['rm', '--cached', '--quiet', '--ignore-unmatch', '--sparse', '--', filePath])
      const fullPath = validatePath(path.join(safePath, filePath))
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath)
      }
    } else {
      // Modified or deleted: restore from HEAD
      await git.raw(['checkout', 'HEAD', '--', filePath])
    }

    return { success: true }
  } catch (err) {
    console.error('Git revert file error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Revert failed' }
  }
})

// Get diff for a specific file (what the next sync would share: the file on
// disk against HEAD — preview does not stage)
ipcMain.handle('git:fileDiff', async (_, repoPath: string, filePath: string, fileStatus: 'added' | 'modified' | 'deleted') => {
  try {
    const safePath = validatePath(repoPath)
    const git: SimpleGit = createGit(safePath)

    if (fileStatus === 'added') {
      // New file: show entire content as addition
      const content = fs.readFileSync(validatePath(path.join(safePath, filePath)), 'utf-8')
      return { success: true, diff: content, isNewFile: true }
    } else if (fileStatus === 'deleted') {
      // Deleted file: show entire content as deletion
      const content = await git.show([`HEAD:${filePath}`])
      return { success: true, diff: content, isDeletedFile: true }
    } else {
      // Modified: show unified diff
      const diff = await git.diff(['HEAD', '-U3', '--', filePath])
      return { success: true, diff }
    }
  } catch (err) {
    console.error('Git file diff error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Diff failed', diff: '' }
  }
})

// Get diff for a specific file in a specific commit
ipcMain.handle('git:commitFileDiff', async (_, repoPath: string, commitHash: string, filePath: string) => {
  try {
    const safePath = validatePath(repoPath)
    const git: SimpleGit = createGit(safePath)
    const diff = await git.show([commitHash, '--', filePath])
    return { success: true, diff }
  } catch (err) {
    console.error('Git commit file diff error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Diff failed', diff: '' }
  }
})

// Generate change summary (async, called separately from preview)
ipcMain.handle('git:generateSummary', async (_, repoPath: string) => {
  try {
    const safePath = validatePath(repoPath)
    // Staged into a throwaway copy of the index: preview never stages.
    const summary = await withScratchIndex({
      git: createGit(safePath),
      repoPath: safePath,
      makeGit: env => createGit(safePath, env),
      fn: async scratch => {
        await scratch.raw(['add', '--sparse', '.'])
        return commitMessageGenerator(() => scratch)(safePath)
      },
    })
    return { success: true, summary: summary || null }
  } catch {
    return { success: false, summary: null }
  }
})

// Search tab / Cmd+P / history panel: electron/git-search.ts (limits, what
// is searched, no lazy fetch). The same git configuration as createGit, for a
// process whose output is streamed and stopped early.
function searchGitCommand() {
  const { binary, envOverrides } = getResolvedGit()
  return configuredGitCommand({
    binary,
    askPassPath: getGitAskPassPath(),
    token: '', // read-only local commands: no server access
    appGitDir: path.join(app.getPath('userData'), 'git'),
    envOverrides,
    extraConfig: gitIdentityConfig(),
  })
}

// File names in a folder ('' = the whole company) for Cmd+P: tracked and
// untracked (not ignored), downloaded folders and readable private folders.
ipcMain.handle('git:listFiles', async (_, repoPath: string, folderPath: string) => {
  try {
    const safePath = validatePath(repoPath)
    const scope = companySearchScope(safePath, normalizeSearchFolder(folderPath))
    const { files, truncated } = await listCompanyFiles(searchGitCommand(), scope)
    return { success: true, files, truncated }
  } catch (err) {
    console.error('Git ls-files error:', err)
    return { success: false, files: [], error: err instanceof Error ? err.message : 'Failed' }
  }
})

// Git log filtered by folder path (no --follow: see gitLogArgs)
ipcMain.handle('git:log', async (_, repoPath: string, folderPath: string, limit: number = 50) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    const raw = await git.raw(gitLogArgs(folderPath, limit))
    return { success: true, commits: parseGitLog(raw) }
  } catch (err) {
    console.error('Git log error:', err)
    return { success: false, commits: [], error: err instanceof Error ? err.message : 'Failed' }
  }
})

// Show files changed in a specific commit, filtered by folder
ipcMain.handle('git:showCommit', async (_, repoPath: string, commitHash: string, folderPath?: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    const args = ['show', '--name-status', '--pretty=format:', commitHash]
    if (folderPath) args.push('--', folderPath)
    const result = await git.raw(args)
    const files: Array<{ status: string; path: string }> = []
    for (const line of result.trim().split('\n')) {
      if (!line) continue
      const [status, ...pathParts] = line.split('\t')
      if (status && pathParts.length > 0) {
        files.push({ status: status.charAt(0), path: pathParts.join('\t') })
      }
    }
    return { success: true, files }
  } catch (err) {
    console.error('Git show error:', err)
    return { success: false, files: [], error: err instanceof Error ? err.message : 'Failed' }
  }
})

// Content search in a folder ('' = the whole company): fixed string, A–Z
// case-insensitive, ≤20 matches per file and ≤500 in all (git is stopped
// there), lines cut around the match. A new search from the same window stops
// the previous one.
const runningGreps = new Map<number, AbortController>()
ipcMain.handle('git:grep', async (event, repoPath: string, query: string, folderPath: string) => {
  const senderId = event.sender.id
  runningGreps.get(senderId)?.abort()
  const controller = new AbortController()
  runningGreps.set(senderId, controller)
  try {
    const safePath = validatePath(repoPath)
    const scope = companySearchScope(safePath, normalizeSearchFolder(folderPath))
    const { matches, truncated, timedOut } = await grepCompany(searchGitCommand(), scope, String(query ?? ''), controller.signal)
    return { success: true, results: matches, truncated, timedOut, cancelled: controller.signal.aborted }
  } catch (err: unknown) {
    console.error('Git grep error:', err)
    return { success: false, results: [], error: err instanceof Error ? err.message : 'Failed' }
  } finally {
    if (runningGreps.get(senderId) === controller) runningGreps.delete(senderId)
  }
})

// git:sync lives in ./sync/git-sync.ts (testable without Electron — see
// tests/sync-harness). This wires the app's git, dialogs and server API in.
const gitSync = createGitSync({
  createGit,
  dialog: createMessageBoxSyncDialog({
    hasWindow: () => !!mainWindow && !mainWindow.isDestroyed(),
    showMessageBox: (options) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    },
  }),
  api: createFetchSyncServerApi({ baseUrl: getServerApiUrl, cookies: () => authCookies }),
  generateCommitMessage,
  now: () => new Date(),
  platform: process.platform,
  log: console,
})

ipcMain.handle('git:sync', async (_, repoPath: string, companyId: string, commitMessage: string) => {
  const result = await gitSync(repoPath, companyId, commitMessage)
  // Rules may have changed since the last look: refresh the chat guard / badges.
  if (result.success && companyId) void writeAccessStore.refresh(companyId)
  return result
})

// Private folders as the chat write guard sees them, from the cached
// /me/scopes answer sync keeps in the company's .git (no network call).
function privateFolderGuardView(root: string) {
  const cache = readPrivateScopesCache(root)
  if (!cache) return undefined
  const readable = [...cache.scopes, ...(cache.pendingPublic ?? [])]
  return {
    reservedFolderOf: async (rel: string) => {
      if (readableScopeOf(readable, rel) || fs.existsSync(path.join(root, ...rel.split('/')))) return null
      return gitSync.pathChecker.reservedFolderOf(cache.companyId, rel).catch(() => null)
    },
    readOnlyFolderOf: (rel: string) => {
      const scope = readableScopeOf(cache.scopes, rel)
      return scope && !scope.canWrite ? scope.path : null
    },
  }
}

/**
 * Refuse creating something at a folder name the member may not use (a
 * private folder they cannot read — the server answers POST …/paths/check;
 * sync's shared, cached checker). Only for paths that do not exist yet (an
 * editor save never waits on it); unknown answers allow — sync's hold-back
 * and the server's [RESERVED_PATH] stay the safety net. The message is the
 * server's own wording, naming only what the member typed.
 */
async function reservedRefusal(absPath: string): Promise<string | null> {
  if (fs.existsSync(absPath)) return null
  const where = companyPathOf(absPath)
  if (!where) return null
  const folder = await gitSync.pathChecker.reservedFolderOf(where.companyId, where.rel).catch(() => null)
  if (folder === null) return null
  console.warn('[fs] Refused a write into a folder name that cannot be used')
  return reservedPathMessage(folder)
}

// The file tree asks before creating / renaming / moving to a path: a
// folder named like a private folder the member cannot read is refused with
// the server's [RESERVED_PATH] sentence (only the name the member typed).
// The fs:* handlers refuse the same paths as a backstop (notDownloadedRefusal).
ipcMain.handle('privateFolders:reservedPathRefusal', async (_, targetPath: string) => {
  try {
    return await reservedRefusal(validatePath(targetPath))
  } catch {
    return null
  }
})

ipcMain.handle('writeAccess:get', async (_, companyId: string, refresh?: boolean) => {
  if (typeof companyId !== 'string' || !companyId) return null
  const cached = writeAccessStore.get(companyId)
  if (cached && !refresh) return cached
  return (await writeAccessStore.refresh(companyId)) ?? null
})

// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons. Only the person's dialog creates them — never the chat (no tool).
const privateFoldersApi = createPrivateFoldersApi({ baseUrl: getServerApiUrl, cookies: () => authCookies })
// The private folders this member may read, per company, for the chat's
// private-read guard (private-read-guard.ts). Refreshed at every chat turn;
// a failed refresh keeps the last answer (unknown = local reads are not recognised).
const readablePrivateFolders = new Map<string, string[]>()
const privateFolderRefreshes = new Map<string, Promise<void>>()
function refreshReadablePrivateFolders(companyId: string, timeoutMs: number): Promise<void> {
  let pending = privateFolderRefreshes.get(companyId)
  if (!pending) {
    pending = privateFoldersApi.mine(companyId)
      .then(result => { if (result.success) readablePrivateFolders.set(companyId, result.folders.map(f => f.path.normalize('NFC'))) })
      .catch(() => {})
      .finally(() => privateFolderRefreshes.delete(companyId))
    privateFolderRefreshes.set(companyId, pending)
  }
  return waitAtMost(pending, timeoutMs)
}
// Who may change CLAUDE.md / AGENTS.md (write-guard.ts): role + managed
// department folders from /me/capabilities. A server without the folders
// leaves a non-admin's authority unknown (never blocks; the push check stays).
const instructionAuthority = new Map<string, InstructionAuthority>()
const authorityRefreshes = new Map<string, Promise<void>>()
function refreshInstructionAuthority(companyId: string, timeoutMs: number): Promise<void> {
  let pending = authorityRefreshes.get(companyId)
  if (!pending) {
    pending = privateFoldersApi.capabilities(companyId)
      .then(result => {
        if (!result.success) return
        if (result.role === 'owner' || result.role === 'admin' || result.managedDepartmentFolders) {
          instructionAuthority.set(companyId, { role: result.role, managedFolders: result.managedDepartmentFolders ?? [] })
        } else instructionAuthority.delete(companyId)
      })
      .catch(() => {})
      .finally(() => authorityRefreshes.delete(companyId))
    authorityRefreshes.set(companyId, pending)
  }
  return waitAtMost(pending, timeoutMs)
}
function waitAtMost(pending: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })]).finally(() => clearTimeout(timer))
}
ipcMain.handle('privateFolders:mine', async (_, companyId: string) => {
  if (typeof companyId !== 'string' || !companyId) return { success: false, offline: false, error: 'companyId is required' }
  return privateFoldersApi.mine(companyId)
})
ipcMain.handle('privateFolders:createContext', async (_, companyId: string, parentPath: string) => {
  if (typeof companyId !== 'string' || !companyId || typeof parentPath !== 'string') return { success: false, offline: false, error: 'Invalid arguments' }
  return privateFoldersApi.createContext(companyId, parentPath)
})
ipcMain.handle('privateFolders:create', async (_, companyId: string, input: CreatePrivateFolderRequest) => {
  if (typeof companyId !== 'string' || !companyId || !input || typeof input.name !== 'string' || typeof input.parentPath !== 'string') {
    return { success: false, offline: false, error: 'Invalid arguments' }
  }
  return privateFoldersApi.create(companyId, {
    parentPath: input.parentPath,
    name: input.name,
    ...(Array.isArray(input.viewers) ? { viewers: input.viewers.filter(v => typeof v === 'string') } : {}),
    ...(Array.isArray(input.editors) ? { editors: input.editors.filter(v => typeof v === 'string') } : {}),
    ...(input.force === true ? { force: true } : {}),
  })
})

const SETUP_OFFLINE_MESSAGE = 'サーバーに接続できませんでした。インターネット接続を確認して、もう一度お試しください。'

// The company's repository URL on the server (null when the server cannot say).
async function companyRemoteUrl(companyId: string): Promise<string | null> {
  const repoInfoResponse = await fetch(`${getServerApiUrl()}/api/git/repos/${companyId}`, {
    headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
  })
  if (!repoInfoResponse.ok) return null
  const repoInfo = await repoInfoResponse.json()
  return typeof repoInfo.data?.httpsUrl === 'string' && repoInfo.data.httpsUrl ? repoInfo.data.httpsUrl : null
}

// Which setup a chosen company folder gets (./sync/company-folder.ts). Reads
// only: nothing in the folder is created or changed. Throws when the server
// cannot be reached (the remote's state is part of the decision).
async function companyFolderDecision(folder: string, remoteUrl: string): Promise<{ decision: CompanyFolderDecision; remoteHasCommits: boolean }> {
  const local = await inspectLocalFolder(folder, args => createGit(folder).raw(args))
  // ls-remote by URL needs no repository; run it from the app's own folder.
  const heads = await createGit(app.getPath('userData')).raw(['ls-remote', '--heads', remoteUrl])
  const remoteHasCommits = heads.trim().length > 0
  return { decision: decideCompanyFolder({ ...local, remoteHasCommits }, remoteUrl), remoteHasCommits }
}

// CompanySelector asks before setting a folder up: 'firstSetup' shows the
// department picker, 'refuse' explains why the folder cannot be used.
// Offline, only a clone of this company (recognised by its origin's path,
// /api/git-http/<companyId>) can be opened — work goes on without the server;
// everything else needs it for the first download.
ipcMain.handle('git:inspectCompanyFolder', async (_, folder: string, companyId: string) => {
  let safe: string
  try {
    safe = validatePath(folder)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const remoteUrl = await companyRemoteUrl(companyId)
    if (remoteUrl) return { success: true, decision: (await companyFolderDecision(safe, remoteUrl)).decision }
  } catch (error) {
    console.warn('Git setup: Could not inspect the folder online:', error)
  }
  try {
    const local = await inspectLocalFolder(safe, args => createGit(safe).raw(args))
    const expected = `${getServerApiUrl()}/api/git-http/${companyId.replace(/[^a-zA-Z0-9_-]/g, '')}.git` // as server/src/routes/git.ts builds it
    if (local.hasGitDir && local.originUrl && local.hasLocalCommits && sameCompanyRemote(local.originUrl, expected)) {
      return { success: true, offline: true, decision: { action: 'existingClone' } satisfies CompanyFolderDecision }
    }
  } catch (error) {
    console.warn('Git setup: Could not inspect the folder:', error)
  }
  return { success: false, error: SETUP_OFFLINE_MESSAGE }
})

// Setup Git remote for a company
//
// While it runs, the bytes arriving in .git/objects/pack are reported to the
// window as 'setup:progress' events: a first download of a large company
// takes minutes, and the setup screen shows it moving.
ipcMain.handle('git:setupCompanyRemote', async (event, repoPath: string, companyId: string, selectedPaths?: string[]) => {
  let stopProgress: (() => void) | null = null
  try {
    repoPath = validatePath(repoPath)
    // Fetch HTTPS URL from server API
    const remoteUrl = await companyRemoteUrl(companyId)
    if (!remoteUrl) {
      return { success: false, error: 'Failed to get repository info from server' }
    }

    // Backstop for the selector's own check: never re-point another
    // remote's clone at this company, and never check the company out over
    // the member's own files (./sync/company-folder.ts).
    let decision: CompanyFolderDecision
    let remoteHasCommits: boolean
    try {
      ({ decision, remoteHasCommits } = await companyFolderDecision(repoPath, remoteUrl))
    } catch (inspectError) {
      console.warn('Git setup: ls-remote failed:', inspectError)
      return { success: false, error: SETUP_OFFLINE_MESSAGE }
    }
    if (decision.action === 'refuse') {
      return { success: false, refused: true, error: decision.message }
    }

    const git: SimpleGit = createGit(repoPath)

    // A repository of its own, even when the folder sits inside another
    // repository (checkIsRepo would answer for the parent, whose origin
    // would then be replaced below).
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      await git.init()
    }
    stopProgress = watchPackBytes(repoPath, receivedBytes => {
      if (!event.sender.isDestroyed()) event.sender.send('setup:progress', { repoPath, receivedBytes })
    })

    // Configure git user from authenticated session (local to this repo)
    try {
      const meResponse = await fetch(`${getServerApiUrl()}/api/me`, {
        headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
      })
      if (meResponse.ok) {
        const meData = await meResponse.json()
        if (meData.success && meData.data) {
          await git.addConfig('user.email', meData.data.email, false)
          await git.addConfig('user.name', meData.data.name || meData.data.email, false)
          console.log(`Git setup: Configured user as ${meData.data.email}`)
        }
      }
    } catch (configError) {
      console.warn('Git setup: Could not configure user identity:', configError)
    }

    // Windows: deep Japanese folder trees easily exceed MAX_PATH (260 chars)
    // and break checkout — opt this repo into long path support
    if (process.platform === 'win32') {
      try {
        await git.addConfig('core.longpaths', 'true', false)
      } catch (longPathError) {
        console.warn('Git setup: Could not set core.longpaths:', longPathError)
      }
    }

    // Add/update origin remote. set-url, never remove + add: this runs
    // again whenever a company is reopened, and `remote remove` deleted a
    // partial clone's promisor config, so downloading a department later
    // failed (./sync/remote.ts). Repair a clone that already lost it.
    await configureOrigin(git, remoteUrl, console)

    if (remoteHasCommits) {
      // Check if we have local commits
      const localLog = await git.log().catch(() => null)

      // First setup with departments picked: download only those (plus what
      // the whole company shares) — a partial clone with the sparse cone set
      // before the first checkout (./sync/first-setup.ts). Only for a folder
      // with no local commits; an existing clone is never converted.
      if ((!localLog || localLog.total === 0) && Array.isArray(selectedPaths) && selectedPaths.length > 0) {
        const lsHeads = await git.listRemote(['--heads', 'origin'])
        const headMatch = lsHeads.match(/refs\/heads\/(\S+)/)
        let departments: string[] | null = null
        try {
          const deptResponse = await fetch(`${getServerApiUrl()}/api/companies/${companyId}/departments`, {
            headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
          })
          const deptData = deptResponse.ok ? await deptResponse.json() : null
          if (deptData?.success && Array.isArray(deptData.data)) {
            departments = (deptData.data as Array<{ folder?: unknown }>)
              .map(d => d.folder)
              .filter((f): f is string => typeof f === 'string' && f.length > 0 && !f.includes('/'))
          }
        } catch (deptError) {
          console.warn('Git setup: Could not load departments, treating root folders as departments:', deptError)
        }
        try {
          const { excluded, included } = await checkoutSelectedDepartments({
            git,
            repoPath,
            branch: headMatch ? headMatch[1] : 'main',
            departments,
            selected: selectedPaths.filter((p): p is string => typeof p === 'string'),
            log: console,
          })
          return {
            success: true,
            remoteUrl,
            cloned: true,
            partial: true,
            downloadedDepartments: included,
            excludedDepartments: excluded,
            message: `Cloned from server (selected departments only): ${remoteUrl}`,
          }
        } catch (partialError) {
          const msg = partialError instanceof Error ? partialError.message : String(partialError)
          console.error('Git setup: Partial clone failed:', msg)
          return {
            success: false,
            error: isDownloadFailure(msg)
              ? 'ダウンロードできませんでした。インターネット接続を確認して、もう一度お試しください。'
              : msg,
          }
        }
      }

      // Remote has content — pull it down (member joining existing company)
      console.log('Git setup: Remote has commits, fetching...')
      await git.fetch(['--progress', 'origin'])

      // Determine the main branch name
      const lsRemote = await git.listRemote(['--heads', 'origin'])
      const branchMatch = lsRemote.match(/refs\/heads\/(\S+)/)
      const remoteBranch = branchMatch ? branchMatch[1] : 'main'

      if (!localLog || localLog.total === 0) {
        // No local commits — checkout the remote branch
        await git.checkout(['-b', remoteBranch, `origin/${remoteBranch}`])
        console.log(`Git setup: Checked out origin/${remoteBranch}`)
      } else {
        // Local commits exist — set up tracking and pull
        const status = await git.status()
        const localBranch = status.current || 'main'
        const hasChanges = !status.isClean()
        if (hasChanges) {
          console.log('Git setup: Uncommitted changes detected, skipping pull (will resolve on next sync)')
        } else {
          try {
            await git.pull('origin', remoteBranch, ['--rebase', '--progress'])
            console.log(`Git setup: Pulled origin/${remoteBranch} into ${localBranch}`)
          } catch (pullError) {
            console.warn('Git setup: Pull failed, will resolve on next sync:', pullError)
          }
        }
      }

      return {
        success: true,
        remoteUrl,
        cloned: true,
        message: `Cloned from server: ${remoteUrl}`
      }
    } else {
      // Remote is empty — initialize and push (owner's first setup)
      console.log('Git setup: Remote is empty, initializing...')

      const localLog = await git.log().catch(() => null)
      if (!localLog || localLog.total === 0) {
        // Create .gitignore if it doesn't exist
        const gitignorePath = path.join(repoPath, '.gitignore')
        if (!fs.existsSync(gitignorePath)) {
          fs.writeFileSync(gitignorePath, '.DS_Store\n*.log\nnode_modules/\n.backups/\n.workspace/\n# Secrets — never sync (local only)\n.env\n.env.*\n!.env.example\n!.env.sample\n')
        }

        await git.raw(['add', '--sparse', '.'])
        await git.commit('Initial commit')
      }

      // Push to server
      try {
        const status = await git.status()
        const branch = status.current || 'main'
        await git.push('origin', branch, ['--set-upstream', '--progress'])
        console.log(`Git setup: Pushed to origin/${branch}`)
      } catch (pushError) {
        console.warn('Git setup: Push failed (may be first time or network issue):', pushError)
      }

      return {
        success: true,
        remoteUrl,
        cloned: false,
        message: `Git remote configured: ${remoteUrl}`
      }
    }
  } catch (error) {
    console.error('Git setup error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  } finally {
    stopProgress?.()
  }
})

// Exclusions model and helpers: ./sync/sparse.ts


// Read the persisted exclusion list for a repo.
ipcMain.handle('git:sparseGetExclusions', async (_, repoPath: string) => {
  try {
    const safe = validatePath(repoPath)
    return { success: true, excluded: readSparseConfig(safe).excluded }
  } catch (error) {
    return { success: false, excluded: [], error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Set the exclusion list and reconcile the worktree to match. In a partial
// clone (first setup with departments picked), adding a department downloads
// it; offline nothing changes and the result says so (offline: true).
//
// While it runs, the bytes arriving in .git/objects/pack (a download in a
// partial clone) are reported to the window as 'sparse:progress' events, so
// the panel can show the download moving.
ipcMain.handle('git:sparseSetExclusions', async (event, repoPath: string, excluded: string[]) => {
  let stopProgress: (() => void) | null = null
  try {
    const safe = validatePath(repoPath)
    stopProgress = watchPackBytes(safe, receivedBytes => {
      if (!event.sender.isDestroyed()) event.sender.send('sparse:progress', { repoPath, receivedBytes })
    })
    const result = await setSparseExclusions(createGit(safe), safe, Array.isArray(excluded) ? excluded : [])
    if (!result.success) console.error('Sparse set exclusions error:', result.error)
    // Private folders are their own repositories: download one that is no
    // longer left out, retire the clone of one that now is (after syncing it).
    const cache = result.success ? readPrivateScopesCache(safe) : null
    if (cache && cache.scopes.length > 0) {
      const reports = await gitSync.applyPrivateFolderChoices(safe, cache.companyId).catch((e: unknown) => {
        console.warn('Private folders: could not apply download choices:', e)
        return []
      })
      const failed = reports.filter(r => !r.success)
      if (failed.length > 0) return { ...result, privateFolderErrors: failed.map(r => `『${r.path}』: ${r.error ?? ''}`) }
    }
    return result
  } catch (error) {
    console.error('Sparse set exclusions error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  } finally {
    stopProgress?.()
  }
})

// Files inside these folders with changes not committed yet: the settings
// panel asks before leaving such a folder out (the next sync would move them
// to .backups/ instead of sharing them).
ipcMain.handle('git:sparseUncommittedChanges', async (_, repoPath: string, folders: string[]) => {
  try {
    const safe = validatePath(repoPath)
    return { success: true, files: await uncommittedChangesIn(createGit(safe), Array.isArray(folders) ? folders : []) }
  } catch (error) {
    return { success: false, files: [], error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// One level of the company's folder tree with sizes, for the settings panel
// (server sizes; local names only when the server cannot be reached).
ipcMain.handle('git:folderSizes', async (_, repoPath: string, companyId: string, folder: string, measure: string[]) => {
  try {
    const safe = validatePath(repoPath)
    const fetchSizes = companyId ? serverFolderSizes({ baseUrl: getServerApiUrl(), companyId, cookies: authCookies }) : null
    const listed = typeof folder === 'string' ? folder : ''
    const view = await folderSizesView(createGit(safe), fetchSizes, listed, Array.isArray(measure) ? measure : [])
    // Readable private folders are not in the company repository: list them
    // where they live (no size — the company's folder sizes cannot see them).
    const cache = readPrivateScopesCache(safe)
    const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
    const privateNodes = (cache?.scopes ?? [])
      .filter(s => parentOf(s.path).normalize('NFC') === listed.normalize('NFC') && !view.folders.some(f => f.path.normalize('NFC') === s.path))
      .map(s => ({ name: s.path.split('/').pop() ?? s.path, path: s.path, size: null, files: null, hasChildren: false, private: true }))
    return { success: true, ...view, folders: [...view.folders, ...privateNodes] }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Check if sparse checkout is enabled
ipcMain.handle('git:isSparseCheckout', async (_, repoPath: string) => {
  try {
    const git = createGit(validatePath(repoPath))
    const config = await git.raw(['config', '--get', 'core.sparseCheckout'])
    return { enabled: config.trim() === 'true' }
  } catch {
    return { enabled: false }
  }
})

// List top-level directories from remote (includes sparse-excluded ones)
ipcMain.handle('git:listRemoteDirectories', async (_, repoPath: string) => {
  try {
    const git = createGit(validatePath(repoPath))
    const result = await git.raw(['ls-tree', '-d', '--name-only', 'origin/main'])
    return {
      success: true,
      directories: result.split('\n').filter(d => d && !d.startsWith('.'))
    }
  } catch (error) {
    console.error('List remote directories error:', error)
    return { success: false, directories: [], error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Get backup history
ipcMain.handle('backup:list', async (_, repoPath: string) => {
  try {
    // .backups/ in the working tree, and the private folders' backups kept
    // inside .git (sync/private-folders.ts privateBackupsDir — never in the
    // working tree, so they can never be staged into the company repository).
    // The latter are listed with ids prefixed `private:`.
    const backups: Array<{
      id: string
      timestamp: string
      reason: string
      files: string[]
      path: string
    }> = []

    for (const { dir: backupsDir, idPrefix } of [
      { dir: path.join(repoPath, '.backups'), idPrefix: '' },
      { dir: privateBackupsDir(repoPath), idPrefix: PRIVATE_BACKUP_ID_PREFIX },
    ]) {
    if (!fs.existsSync(backupsDir)) continue
    for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const backupPath = path.join(backupsDir, entry.name)
        const metadataPath = path.join(backupPath, '_metadata.json')

        let metadata: { timestamp?: string; reason?: string; conflictFiles?: string[] } = {}
        if (fs.existsSync(metadataPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
          } catch {
            // Ignore parse errors
          }
        }

        // List files in backup (excluding _metadata.json)
        const files: string[] = []
        const listFiles = (dir: string, prefix = '') => {
          const items = fs.readdirSync(dir, { withFileTypes: true })
          for (const item of items) {
            if (item.name === '_metadata.json') continue
            const relativePath = prefix ? `${prefix}/${item.name}` : item.name
            if (item.isDirectory()) {
              listFiles(path.join(dir, item.name), relativePath)
            } else {
              files.push(relativePath)
            }
          }
        }
        listFiles(backupPath)

        backups.push({
          id: `${idPrefix}${entry.name}`,
          timestamp: metadata.timestamp || entry.name,
          reason: metadata.reason || 'unknown',
          files: metadata.conflictFiles || files,
          path: backupPath
        })
      }
    }
    }

    // Sort by timestamp (newest first)
    backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    return { success: true, backups }
  } catch (error) {
    console.error('Backup list error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error', backups: [] }
  }
})

// Restore a file from backup
ipcMain.handle('backup:restore', async (_, repoPath: string, backupId: string, filePath: string) => {
  try {
    const safeRepoPath = validatePath(repoPath)
    const isPrivate = backupId.startsWith(PRIVATE_BACKUP_ID_PREFIX)
    const backupsDir = isPrivate ? privateBackupsDir(safeRepoPath) : path.join(safeRepoPath, '.backups')
    const backupPath = path.join(backupsDir, isPrivate ? backupId.slice(PRIVATE_BACKUP_ID_PREFIX.length) : backupId)
    if (!backupPath.startsWith(backupsDir + path.sep)) return { success: false, error: 'Invalid backup path' }
    const srcPath = path.resolve(backupPath, filePath)
    const destPath = path.resolve(safeRepoPath, filePath)

    // Prevent path traversal via ../
    if (!srcPath.startsWith(backupPath + path.sep)) {
      return { success: false, error: 'Invalid backup path' }
    }
    if (!destPath.startsWith(safeRepoPath + path.sep)) {
      return { success: false, error: 'Invalid destination path' }
    }

    if (!fs.existsSync(srcPath)) {
      return { success: false, error: 'Backup file not found' }
    }

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    // Copy file
    fs.copyFileSync(srcPath, destPath)

    return { success: true, message: `Restored: ${filePath}` }
  } catch (error) {
    console.error('Backup restore error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Open backup folder in Finder/Explorer
ipcMain.handle('backup:openFolder', async (_, backupPath: string) => {
  try {
    await shell.openPath(backupPath)
    return { success: true }
  } catch (error) {
    console.error('Open folder error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Push to server
ipcMain.handle('git:pushToServer', async (_, repoPath: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)

    // Add all changes
    await git.raw(['add', '--sparse', '.'])

    // Check status
    const status = await git.status()

    // Commit if there are changes
    if (status.files.length > 0) {
      await git.commit(`Sync: ${new Date().toISOString()}`)
    }

    // Push with set-upstream
    const branch = status.current || 'main'
    await git.push('origin', branch, ['--set-upstream', '--force', '--progress'])

    return { success: true, message: `Pushed to server (branch: ${branch})` }
  } catch (error) {
    console.error('Git push error:', error)
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (isProtectedConfigRejection(errorMsg)) {
      const protectedFiles = parseProtectedConfigPaths(errorMsg)
      return { success: false, error: protectedConfigMessage(protectedFiles), errorType: 'protected_config', protectedFiles }
    }
    if (isWriteDeniedRejection(errorMsg)) {
      const writeDeniedFiles = parseWriteDeniedPaths(errorMsg)
      return { success: false, error: writeDeniedMessage(writeDeniedFiles), errorType: 'write_denied', writeDeniedFiles }
    }
    if (errorMsg.includes('SECRET_DETECTED')) {
      const fileLines = errorMsg
        .split('\n')
        .map((line: string) => line.replace(/^remote:\s*/, '').trim())
        .filter((line: string) => line.startsWith('- '))
      const fileList = fileLines.length > 0 ? fileLines.join('\n') : '（詳細不明）'
      return {
        success: false,
        error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
        secretDetected: true
      }
    }
    return { success: false, error: errorMsg }
  }
})

// Create repo on server via API
ipcMain.handle('server:createRepo', async (_, companyId: string) => {
  try {
    const response = await fetch(`${getServerApiUrl()}/api/git/repos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': authCookies.join('; '),
      },
      body: JSON.stringify({ companyId }),
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('Server createRepo error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Default system prompt with thinking instructions
const DEFAULT_SYSTEM_PROMPT = `あなたは会社の業務をサポートするAIアシスタントです。丁寧に日本語で回答してください。

重要: 複雑な質問や分析が必要な場合は、まず<think>タグ内で思考過程を示してください。
思考には以下を含めてください：
- 質問の分析
- 考慮すべきポイント
- 解決へのアプローチ

例:
<think>
ユーザーは○○について質問しています。
これを答えるには、△△と□□を考慮する必要があります。
まず△△について検討し、次に□□について...
</think>

実際の回答は<think>タグの外に記述してください。
シンプルな挨拶や短い質問には思考は不要です。`

// Parse text to extract thinking and content parts
interface ParsedContent {
  thinking: string | null
  content: string
}

function parseThinkingContent(text: string): ParsedContent {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g
  let thinking: string | null = null
  let content = text

  const match = thinkRegex.exec(text)
  if (match) {
    thinking = match[1].trim()
    content = text.replace(thinkRegex, '').trim()
  }

  return { thinking, content }
}

// Build system prompt with working directory context
function buildSystemPrompt(workingDirectory?: string): string {
  let prompt = DEFAULT_SYSTEM_PROMPT

  if (workingDirectory) {
    prompt += `

## 作業ディレクトリ
あなたの作業ディレクトリは「${workingDirectory}」です。
ファイルの作成・編集・読み取りはすべてこのディレクトリ内で行ってください。
相対パスを使う場合は、このディレクトリを基準にしてください。

このディレクトリ内には部署ごとのフォルダ（sales, hr, accounting, contents, development, general）があり、
各フォルダにはAGENT.mdファイルにそのエージェントの役割が定義されています。`
  }

  // Add skill structure rules
  prompt += `

## スキル作成ルール

ユーザーが「スキルを作成して」「新しいスキルを追加して」などと言った場合は、以下のルールに従ってスキルを作成してください。

### 設計哲学：Progressive Disclosure（段階的開示）

スキルは3層構造で設計する。**コンテキストウィンドウは公共財**であり、本当に必要な情報だけを含める。

| 層 | 内容 | 目安 |
|---|------|------|
| Layer 1 | frontmatter（name, description） | 〜100語、トリガー判定用 |
| Layer 2 | SKILL.md本文 | <5000語、実行時にロード |
| Layer 3 | references/, scripts/ | 必要時のみ参照 |

**重要**: 詳細な仕様書、API定義、長いドキュメントはSKILL.md本文ではなく \`references/\` フォルダに分離する。

### スキルのディレクトリ構造

\`\`\`
.claude/skills/{folder-name}/
├── SKILL.md          # スキル定義ファイル（必須）
├── rules/            # ルールファイル格納フォルダ（必須、空でも作成）
├── references/       # 参考資料格納フォルダ（必須、空でも作成）
├── scripts/          # スクリプト格納フォルダ（必須、空でも作成）
└── tools/            # Webアプリツール格納フォルダ（必須、空でも作成）
\`\`\`

### フォルダ名の命名規則（重要）

- **英小文字で始まる**
- **使用可能文字**: 英小文字(a-z)、数字(0-9)、ハイフン(-)、アンダースコア(_)
- **日本語は使用不可**
- **最大50文字**

例: \`create-proposal\`, \`monthly-report\`, \`customer_analysis\`
NG例: \`提案書作成\`, \`Create Proposal\`, \`123-skill\`

### SKILL.mdのフォーマット

\`\`\`markdown
---
name: スキル名（日本語OK）
description: スキルの説明（1-2文、このスキルが何をするか簡潔に）
---

# スキル名

## Overview（概要）
このスキルが何を実現するか、1-2段落で説明。

## When to Use（使うべき場面）
- このスキルが適している状況を箇条書きで列挙
- 具体的なユースケースを示す

## When NOT to Use（使うべきでない場面）
- このスキルでは対応できないケース
- 代わりに使うべきスキルや方法を示す
- 例: 「カレンダー予定の登録 → Googleカレンダースキルを使用」

## 前提条件
- 必要な設定、認証情報、ツール
- 例: 「Slack APIトークンが必要」

## AIへの指示

このスキルを実行するときにAIが従うべき詳細な指示。
- 具体的な手順
- 出力フォーマット
- 品質基準

## 安全ルール

**重要**: お金、データ、外部送信が絡む操作には必ず記載。
- 確認が必要な操作（例: 「送信前に必ずユーザーに確認」）
- 禁止事項（例: 「本番データを削除しない」）
- エラー時の対応

## 参考資料

references/ フォルダ内のファイルを参照する場合はここに記載。
詳細な仕様書、API定義、長いドキュメントはreferences/に格納し、
必要に応じて「references/api-spec.md を参照」のように指示する。
\`\`\`

### 制約レベルの使い分け

| レベル | 用途 | SKILL.mdでの書き方 |
|--------|------|-------------------|
| テキスト指示 | 柔軟なタスク | 「丁寧な文体で」「簡潔に」 |
| 擬似コード | パターンあり＋変動 | 処理の流れを箇条書きで |
| scripts/ | 一貫性必須の操作 | スクリプトファイルに分離 |

### スキル作成時の手順

1. ユーザーの要望をヒアリング（何を自動化したいか）
2. フォルダ名を決める（英数字のみ、内容を表す名前）
3. スキルディレクトリを作成
4. 必須サブディレクトリ（rules/, references/, scripts/, tools/）を作成
5. SKILL.mdを上記フォーマットで作成
6. 必要に応じてreferences/に詳細資料を追加

### スキル作成後の報告

作成後、以下を報告：
- スキル名とフォルダ名
- 概要（何ができるか）
- 使い方の例
- 追加で設定が必要なこと（あれば）`

  return prompt
}

// Tool (Web app) info
interface ToolInfo {
  name: string           // Folder name
  displayName: string    // From package.json or folder name
  path: string           // Absolute path
  hasPackageJson: boolean
  startCommand?: string  // "dev" or "start"
}

// Skills listing handler
interface SkillInfo {
  id: string
  name: string
  description: string
  departmentId: string
  skillPath: string
  group: string
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

// Parse YAML frontmatter from SKILL.md
function parseSkillFrontmatter(content: string): { name?: string; description?: string; status?: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return {}

  const frontmatter = frontmatterMatch[1]
  const result: { name?: string; description?: string; status?: string } = {}

  // Parse name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  if (nameMatch) {
    result.name = nameMatch[1].trim()
  }

  // Parse description
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  if (descMatch) {
    result.description = descMatch[1].trim()
  }

  // Parse status
  const statusMatch = frontmatter.match(/^status:\s*(.+)$/m)
  if (statusMatch) {
    result.status = statusMatch[1].trim()
  }

  return result
}

// Gitignore cache per rootPath to avoid repeated file reads
const gitignoreCache = new Map<string, { lines: string[]; mtime: number }>()

function getGitignoreLines(rootPath: string): string[] {
  const gitignorePath = path.join(rootPath, '.gitignore')
  try {
    if (!fs.existsSync(gitignorePath)) return []
    const stat = fs.statSync(gitignorePath)
    const cached = gitignoreCache.get(rootPath)
    if (cached && cached.mtime === stat.mtimeMs) return cached.lines
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    const lines = content.split('\n').map(l => l.trim())
    gitignoreCache.set(rootPath, { lines, mtime: stat.mtimeMs })
    return lines
  } catch {
    return []
  }
}

function invalidateGitignoreCache(rootPath: string): void {
  gitignoreCache.delete(rootPath)
}

function invalidateSkillsCache(rootPath: string, departmentFolder?: string): void {
  skillsCache.invalidate(rootPath, departmentFolder)
}

/** Scan a single .claude/skills/ directory and return SkillInfo[] */
async function scanSkillsInDir(
  skillsDir: string,
  rootPath: string,
  departmentId: string,
  group: string,
  gitignoreRelativePrefix: string,
): Promise<SkillInfo[]> {
  if (!fs.existsSync(skillsDir)) return []

  const gitignoreLines = getGitignoreLines(rootPath)
  const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
  const skills: SkillInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue

    const skillPath = path.join(skillsDir, entry.name)
    const skillMdPath = path.join(skillPath, 'SKILL.md')

    if (!fs.existsSync(skillMdPath)) continue

    try {
      const skillMdContent = await fs.promises.readFile(skillMdPath, 'utf-8')
      const frontmatter = parseSkillFrontmatter(skillMdContent)

      const rulesDir = path.join(skillPath, 'rules')
      const scriptsDir = path.join(skillPath, 'scripts')
      const referencesDir = path.join(skillPath, 'references')

      const files: SkillInfo['files'] = { skillMd: skillMdPath }

      if (fs.existsSync(rulesDir)) {
        const rulesEntries = await fs.promises.readdir(rulesDir)
        files.rules = rulesEntries.filter(f => f.endsWith('.md')).map(f => path.join(rulesDir, f))
      }

      if (fs.existsSync(scriptsDir)) {
        const scriptsEntries = await fs.promises.readdir(scriptsDir)
        files.scripts = scriptsEntries.filter(f => !f.startsWith('.')).map(f => path.join(scriptsDir, f))
      }

      if (fs.existsSync(referencesDir)) {
        const refsEntries = await fs.promises.readdir(referencesDir)
        files.references = refsEntries.filter(f => !f.startsWith('.')).map(f => path.join(referencesDir, f))
      }

      const toolsDir = path.join(skillPath, 'tools')
      if (fs.existsSync(toolsDir)) {
        const toolsEntries = await fs.promises.readdir(toolsDir, { withFileTypes: true })
        const tools: ToolInfo[] = []

        for (const toolEntry of toolsEntries) {
          if (!toolEntry.isDirectory()) continue
          if (toolEntry.name.startsWith('.')) continue
          if (toolEntry.name === 'node_modules') continue

          const toolEntryPath = path.join(toolsDir, toolEntry.name)
          const packageJsonPath = path.join(toolEntryPath, 'package.json')
          const hasPackageJson = fs.existsSync(packageJsonPath)

          let displayName = toolEntry.name
          let startCommand: string | undefined

          if (hasPackageJson) {
            try {
              const pkgContent = await fs.promises.readFile(packageJsonPath, 'utf-8')
              const pkg = JSON.parse(pkgContent)
              displayName = pkg.name || toolEntry.name
              if (pkg.scripts?.dev) {
                startCommand = 'dev'
              } else if (pkg.scripts?.start) {
                startCommand = 'start'
              }
            } catch {
              // Ignore package.json parse errors
            }
          }

          tools.push({
            name: toolEntry.name,
            displayName,
            path: toolEntryPath,
            hasPackageJson,
            startCommand,
          })
        }

        if (tools.length > 0) files.tools = tools
      }

      const skillRelativePath = `${gitignoreRelativePrefix}.claude/skills/${entry.name}/`
      const isPrivate = gitignoreLines.some(line => line === skillRelativePath)

      skills.push({
        id: `${departmentId}-${group.replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-').toLowerCase()}-${entry.name}`,
        name: frontmatter.name || entry.name,
        description: frontmatter.description || '',
        departmentId,
        skillPath,
        group,
        isPrivate,
        isNurturing: frontmatter.status === 'nurturing',
        files,
      })
    } catch (err) {
      console.error(`Failed to parse skill ${entry.name}:`, err)
    }
  }

  return skills
}

/**
 * Recursively find all directories containing `.claude/skills/` under a base directory.
 * Returns array of { skillsDir, relativePath } where relativePath is relative to baseDir.
 */
async function findSkillsDirs(baseDir: string, maxDepth = 5): Promise<{ skillsDir: string; relativePath: string }[]> {
  const results: { skillsDir: string; relativePath: string }[] = []
  const SKIP_DIRS = new Set(['.git', '.claude', '.backups', 'node_modules', '.next', 'dist', 'build', '__pycache__'])

  async function walk(dir: string, relPath: string, depth: number) {
    if (depth > maxDepth) return

    // Check if this directory has .claude/skills/
    const skillsDir = path.join(dir, '.claude', 'skills')
    if (fs.existsSync(skillsDir)) {
      results.push({ skillsDir, relativePath: relPath })
    }

    // Recurse into subdirectories
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name, depth + 1)
      }
    } catch {
      // Ignore permission/readdir errors
    }
  }

  await walk(baseDir, '', 0)
  return results
}

/**
 * Scan skills across hierarchy:
 * 1. Company root: {rootPath}/.claude/skills/ → group "全社"
 * 2. Department + nested: {rootPath}/{dept}/**\/.claude/skills/ → group "{deptName}" or "{deptName} / {path}"
 */
async function scanSkills(rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string): Promise<SkillInfo[]> {
  const deptDisplayName = departmentName || departmentFolder
  const allSkills: SkillInfo[] = []

  // Level 1: Company root (.claude/skills/) — only when company-wide tab
  if (!departmentFolder) {
    const rootSkillsDir = path.join(rootPath, '.claude', 'skills')
    const rootSkills = await scanSkillsInDir(rootSkillsDir, rootPath, departmentId, '全社', '')
    allSkills.push(...rootSkills)
  }

  // Level 2+: Department and all nested subdirectories (skip when company-wide)
  if (departmentFolder) {
    const deptDir = path.join(rootPath, departmentFolder)
    if (fs.existsSync(deptDir)) {
      const found = await findSkillsDirs(deptDir)
      for (const { skillsDir, relativePath } of found) {
        const groupName = relativePath
          ? `${deptDisplayName} / ${relativePath.split('/').pop()}`
          : deptDisplayName
        const gitignorePrefix = relativePath
          ? `${departmentFolder}/${relativePath}/`
          : `${departmentFolder}/`
        const skills = await scanSkillsInDir(skillsDir, rootPath, departmentId, groupName, gitignorePrefix)
        allSkills.push(...skills)
      }
    }
  }

  return allSkills
}

// List skills for a department (scans 3 hierarchy levels)
ipcMain.handle('skills:list', async (_, rootPath: string, departmentFolder: string, departmentId: string, departmentName?: string, options?: { force?: boolean }) => {
  try {
    // A forced refresh (watcher event, sync, the member's own change) rescans.
    if (options?.force) invalidateSkillsCache(rootPath, departmentFolder)
    const cached = skillsCache.get(rootPath, departmentFolder)
    if (cached) return { success: true, skills: cached }

    const skills = await scanSkills(rootPath, departmentFolder, departmentId, departmentName)
    skillsCache.set(rootPath, departmentFolder, skills)

    return { success: true, skills }
  } catch (error) {
    console.error('Skills list error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error', skills: [] }
  }
})

// Publish a skill (remove from .gitignore, one-way / irreversible)
ipcMain.handle('skills:publish', async (_, rootPath: string, skillRelativePath: string) => {
  try {
    const gitignorePath = path.join(rootPath, '.gitignore')
    if (!fs.existsSync(gitignorePath)) return { success: true }

    const content = fs.readFileSync(gitignorePath, 'utf-8')
    const lines = content.split('\n')
    const filtered = lines.filter(l => l.trim() !== skillRelativePath)

    // Remove empty "# Private skills" header if no more entries follow
    const cleanedLines: string[] = []
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i].trim() === '# Private skills') {
        const nextNonEmpty = filtered.slice(i + 1).find(l => l.trim() !== '')
        if (!nextNonEmpty || !nextNonEmpty.includes('.claude/skills/')) {
          continue
        }
      }
      cleanedLines.push(filtered[i])
    }
    fs.writeFileSync(gitignorePath, cleanedLines.join('\n'))
    invalidateGitignoreCache(rootPath)
    invalidateSkillsCache(rootPath)
    return { success: true }
  } catch (error) {
    console.error('Publish skill error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Add skill to .gitignore (used when creating a new skill)
ipcMain.handle('skills:makePrivate', async (_, rootPath: string, skillRelativePath: string) => {
  try {
    const gitignorePath = path.join(rootPath, '.gitignore')
    const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
    const lines = content.split('\n')

    if (!lines.some(l => l.trim() === skillRelativePath)) {
      const header = '# Private skills'
      const headerIndex = lines.findIndex(l => l.trim() === header)
      if (headerIndex >= 0) {
        lines.splice(headerIndex + 1, 0, skillRelativePath)
      } else {
        lines.push('', header, skillRelativePath)
      }
      fs.writeFileSync(gitignorePath, lines.join('\n'))
      invalidateGitignoreCache(rootPath)
      invalidateSkillsCache(rootPath)
    }
    return { success: true }
  } catch (error) {
    console.error('Make private error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Toggle nurturing status in SKILL.md frontmatter
ipcMain.handle('skills:toggleNurturing', async (_, skillMdPath: string, makeNurturing: boolean) => {
  try {
    if (!fs.existsSync(skillMdPath)) {
      return { success: false, error: 'SKILL.md not found' }
    }

    let content = fs.readFileSync(skillMdPath, 'utf-8')
    const frontmatterMatch = content.match(/^(---\n)([\s\S]*?)\n(---)/)
    if (!frontmatterMatch) {
      return { success: false, error: 'No frontmatter found' }
    }

    const [fullMatch, opening, body, closing] = frontmatterMatch
    const lines = body.split('\n')

    if (makeNurturing) {
      // Add status: nurturing if not present
      const statusIndex = lines.findIndex(l => /^status:/.test(l))
      if (statusIndex >= 0) {
        lines[statusIndex] = 'status: nurturing'
      } else {
        lines.push('status: nurturing')
      }
    } else {
      // Remove status line
      const filtered = lines.filter(l => !/^status:/.test(l))
      lines.length = 0
      lines.push(...filtered)
    }

    const newFrontmatter = `${opening}${lines.join('\n')}\n${closing}`
    content = content.replace(fullMatch, newFrontmatter)
    fs.writeFileSync(skillMdPath, content)
    return { success: true }
  } catch (error) {
    console.error('Toggle nurturing error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Start a tool (Web app)
ipcMain.handle('tools:start', async (_, toolPath: string, startCommand: string = 'dev') => {
  try {
    console.log('[tools:start] toolPath:', toolPath, 'command:', startCommand)

    // Check if already running
    if (runningTools.has(toolPath)) {
      const existing = runningTools.get(toolPath)!
      return { success: true, port: existing.port, alreadyRunning: true }
    }

    // Check if package.json exists
    const packageJsonPath = path.join(toolPath, 'package.json')
    if (!fs.existsSync(packageJsonPath)) {
      return { success: false, error: 'No package.json found' }
    }

    // Check if node_modules exists, if not run npm install
    const nodeModulesPath = path.join(toolPath, 'node_modules')
    if (!fs.existsSync(nodeModulesPath)) {
      console.log('[tools:start] Installing dependencies...')
      try {
        await execAsync('npm install', { cwd: toolPath, env: getShellEnv() })
      } catch (installErr) {
        console.error('[tools:start] npm install failed:', installErr)
        return { success: false, error: `npm install failed: ${installErr instanceof Error ? installErr.message : installErr}` }
      }
    }
    console.log('[tools:start] node_modules exists:', fs.existsSync(nodeModulesPath))

    // Find an available port (start from 3100 to avoid conflicts)
    const basePort = 3100
    let port = basePort
    const maxPort = 3200

    const isPortInUse = async (p: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const server = net.createServer()
        server.once('error', () => resolve(true))
        server.once('listening', () => {
          server.close(() => resolve(false))
        })
        server.listen(p)
      })
    }

    const waitForPort = (p: number, timeoutMs: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const start = Date.now()
        const check = () => {
          const socket = new net.Socket()
          socket.once('connect', () => {
            socket.destroy()
            resolve(true)
          })
          socket.once('error', () => {
            socket.destroy()
            if (Date.now() - start > timeoutMs) {
              resolve(false)
            } else {
              setTimeout(check, 200)
            }
          })
          socket.connect(p, '127.0.0.1')
        }
        check()
      })
    }

    while (port < maxPort) {
      if (!(await isPortInUse(port))) break
      port++
    }

    if (port >= maxPort) {
      return { success: false, error: 'No available port found' }
    }
    console.log('[tools:start] Using port:', port)

    // Start the tool — write stdout/stderr to log file to avoid EBADF with pipes
    const logPath = path.join(toolPath, '.tool-output.log')
    const logFd = fs.openSync(logPath, 'w')
    const npmArgs = ['run', startCommand, '--', '--port', port.toString()]
    // getShellEnv handles the Windows Path-key replacement; PORT rides along
    const toolEnv = { ...getShellEnv(), PORT: port.toString() }

    console.log('[tools:start] About to spawn: npm', npmArgs.join(' '))
    let childProcess: ChildProcess
    if (process.platform === 'win32') {
      // npm is npm.cmd on Windows: batch files cannot be spawned directly
      // (Node blocks it since CVE-2024-27980). Run through cmd.exe with
      // spaced args quoted — same pattern as the chat-server claude spawn.
      // No `detached`: tools:stop kills the tree from this cmd.exe pid via
      // taskkill /t.
      const quoted = ['npm', ...npmArgs]
        .map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
        .join(' ')
      childProcess = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoted], {
        cwd: toolPath,
        stdio: ['ignore', logFd, logFd],
        env: toolEnv,
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    } else {
      // Force fork+exec instead of posix_spawn to avoid EBADF in Electron
      // (Electron's main process inherits Chromium FDs that lack FD_CLOEXEC)
      childProcess = spawn('npm', npmArgs, {
        cwd: toolPath,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env: toolEnv,
        ...(process.getuid ? { uid: process.getuid(), gid: process.getgid!() } : {}),
      })
    }
    console.log('[tools:start] Spawn succeeded, pid:', childProcess.pid)

    // Close the log fd in the parent (child has its own copy)
    fs.closeSync(logFd)

    // Store the running tool
    runningTools.set(toolPath, {
      process: childProcess,
      port,
      toolPath,
    })

    // Handle process exit
    childProcess.on('exit', (code) => {
      console.log(`Tool process exited with code ${code}:`, toolPath)
      runningTools.delete(toolPath)
    })

    childProcess.on('error', (err) => {
      console.error('Tool process error:', err)
      runningTools.delete(toolPath)
    })

    // Wait for the server to be ready (port listening), with timeout
    const isReady = await waitForPort(port, 5000)
    if (!isReady) {
      console.warn(`[tools:start] Port ${port} not ready after timeout, proceeding anyway`)
    }

    return { success: true, port, pid: childProcess.pid }
  } catch (error) {
    console.error('[tools:start] Error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Stop a running tool
ipcMain.handle('tools:stop', async (_, toolPath: string) => {
  try {
    const runningTool = runningTools.get(toolPath)
    if (!runningTool) {
      return { success: true, message: 'Tool was not running' }
    }

    // Kill the process
    if (runningTool.process.pid) {
      // On Windows, we need to kill the process tree
      if (process.platform === 'win32') {
        // Await taskkill so a failure is visible instead of silently
        // leaving an orphaned dev server holding files and the port
        await new Promise<void>((resolve) => {
          const tk = spawn('taskkill', ['/pid', runningTool.process.pid!.toString(), '/f', '/t'], { windowsHide: true })
          tk.on('exit', (code) => {
            if (code !== 0) console.warn(`[tools:stop] taskkill exited with ${code} for pid ${runningTool.process.pid}`)
            resolve()
          })
          tk.on('error', (err) => {
            console.error('[tools:stop] taskkill failed:', err)
            resolve()
          })
        })
      } else {
        // On Unix, kill the process group
        try {
          process.kill(-runningTool.process.pid, 'SIGTERM')
        } catch {
          runningTool.process.kill('SIGTERM')
        }
      }
    }

    runningTools.delete(toolPath)
    return { success: true }
  } catch (error) {
    console.error('Tool stop error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// List running tools
ipcMain.handle('tools:list-running', async () => {
  const tools: Array<{ toolPath: string; port: number; pid?: number }> = []
  for (const [toolPath, tool] of runningTools) {
    tools.push({
      toolPath,
      port: tool.port,
      pid: tool.process.pid,
    })
  }
  return { success: true, tools }
})

// Open URL in external browser
ipcMain.handle('shell:openExternal', async (_, url: string) => {
  try {
    await shell.openExternal(url)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// AI Chat handler
ipcMain.handle('ai:chat', async (_event, messages: ChatMessage[], systemPrompt?: string, workingDirectory?: string) => {
  const config = loadConfig()
  const authMode = config.authMode || 'claude-code'

  // Build system prompt with working directory context
  const finalSystemPrompt = systemPrompt || buildSystemPrompt(workingDirectory)
  if (authMode === 'codex') return { error: 'Codexは相談チャットから利用してください。' }

  try {
    let model

    if (authMode === 'claude-code') {
      // Use Claude Code CLI authentication (Max/Pro subscription)
      const ccStatus = checkClaudeCodeStatus()
      if (!ccStatus?.available || !ccStatus?.authenticated) {
        return { error: ccStatus?.error || 'Claude Code CLIが認証されていません。`claude login`を実行してください。' }
      }
      const claudePath = getClaudeCodeCliPath()
      model = claudeCode('sonnet', {
        pathToClaudeCodeExecutable: claudePath,
        // Bypass permission prompts for smoother UX
        permissionMode: 'bypassPermissions',
        // Set working directory for Claude Code
        cwd: workingDirectory,
        // Ensure the spawned process has the user's shell PATH (needed in .app bundles)
        env: getShellEnv(),
      })
    } else {
      // Use API key authentication
      if (!config.anthropicApiKey) {
        return { error: 'APIキーが設定されていません。' }
      }
      const anthropic = createAnthropic({
        apiKey: config.anthropicApiKey,
      })
      model = anthropic('claude-sonnet-4-20250514')
    }

    const result = streamText({
      model,
      system: finalSystemPrompt,
      messages,
    })

    // Stream the response back to renderer
    let fullText = ''
    let inThinking = false
    let thinkingStarted = false
    let thinkingContent = ''

    for await (const chunk of result.textStream) {
      fullText += chunk

      // Check if we're entering a thinking block
      if (!inThinking && fullText.includes('<think>') && !fullText.includes('</think>')) {
        inThinking = true
        if (!thinkingStarted) {
          thinkingStarted = true
          // Signal thinking started
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:thinking', true)
          }
        }
        // Extract and send thinking content so far
        const thinkStart = fullText.indexOf('<think>') + 7
        const currentThinking = fullText.slice(thinkStart)
        if (currentThinking !== thinkingContent) {
          thinkingContent = currentThinking
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:thought-stream', thinkingContent)
          }
        }
        continue
      }

      // While in thinking mode, stream thinking content
      if (inThinking && !fullText.includes('</think>')) {
        const thinkStart = fullText.indexOf('<think>') + 7
        const currentThinking = fullText.slice(thinkStart)
        if (currentThinking !== thinkingContent) {
          thinkingContent = currentThinking
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:thought-stream', thinkingContent)
          }
        }
        continue
      }

      // Check if thinking block is complete
      if (inThinking && fullText.includes('</think>')) {
        inThinking = false
        const parsed = parseThinkingContent(fullText)
        if (parsed.thinking) {
          // Send final thinking content
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ai:thought-stream', parsed.thinking)
            mainWindow.webContents.send('ai:thinking', false)
          }
        }
        continue
      }

      // Send content chunks (outside of think tags)
      if (!inThinking && mainWindow && !mainWindow.isDestroyed()) {
        // Only send if we're past the thinking block or there was no thinking
        if (!fullText.includes('<think>') || fullText.includes('</think>')) {
          // Filter out the think tags from what we send
          const cleanChunk = chunk.replace(/<\/?think>/g, '')
          if (cleanChunk) {
            mainWindow.webContents.send('ai:chunk', cleanChunk)
          }
        }
      }
    }

    // Final parse to get clean content
    const parsed = parseThinkingContent(fullText)

    // Signal completion
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:complete', {
        thinking: parsed.thinking,
        content: parsed.content
      })
    }

    return { text: parsed.content, thinking: parsed.thinking }
  } catch (error: unknown) {
    console.error('AI Chat Error:', error)
    let errorMessage = 'Unknown error'
    if (error instanceof Error) {
      errorMessage = error.message
      // Check for API-specific error data
      if ('data' in error && typeof error.data === 'object' && error.data !== null) {
        const data = error.data as { error?: { message?: string } }
        if (data.error?.message) {
          errorMessage = data.error.message
        }
      }
    }
    // Signal completion even on error
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:complete')
    }
    return { error: errorMessage }
  }
})

// Startup runs last, once every store and service above is initialised: the
// chat server config below captures them, and keeping the use after the
// declaration makes no-use-before-define (TDZ) hold by construction.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  registerVoiceInput(getClaudeCodeCliPath, getShellEnv, () => {
    const config = loadConfig()
    return { authMode: config.authMode || 'claude-code', apiKey: config.anthropicApiKey }
  })
  // Handle local-file:// protocol to serve local files (restricted to allowed directories)
  // `?v=<n>` (a per-path version the renderer bumps on file events) is dropped
  // before resolving; responses are never cached, so a replaced file shows.
  protocol.handle('local-file', async (request) => {
    const target = localFileTarget(request.url, allowedRoots)
    if (!target.ok) {
      return new Response(target.status === 403 ? 'Forbidden: path is outside allowed directories' : 'Bad request', { status: target.status })
    }
    const resolved = target.path
    const response = await electronNet.fetch(pathToFileURL(resolved).toString())
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
  // Start embedded Hono chat server
  try {
    const serverConfig: ChatServerConfig = {
      getAuthMode: () => {
        const config = loadConfig()
        return (config.authMode || 'claude-code') as 'claude-code' | 'codex' | 'api-key'
      },
      getApiKey: () => {
        const config = loadConfig()
        return config.anthropicApiKey
      },
      // Unset → 'auto'. A mode the user saved explicitly is kept as-is.
      getPermissionMode: () => normalizePermissionMode(loadConfig().permissionMode),
      isClaudeCodeAuthenticated,
      getClaudeCodeCliPath,
      getShellEnv,
      buildSystemPrompt,
      onChatActivity: (token, active) => handoffs.setBusy(token, active),
      getWriteGuard: async (companyId, root) => {
        const [access] = await Promise.all([
          writeAccessStore.refresh(companyId, { timeoutMs: 3000 }),
          refreshReadablePrivateFolders(companyId, 3000),
          refreshInstructionAuthority(companyId, 3000),
        ])
        if (!access) console.warn(`[write-access] ${companyId}: unknown at chat start; edits to read-only folders are not blocked in the chat`)
        // getAccess reads the live cache, so a refresh during a long chat applies at once.
        return {
          root,
          getAccess: () => writeAccessStore.get(companyId),
          getNotDownloaded: () => notDownloadedFolders(root),
          getPrivateFolders: () => readablePrivateFolders.get(companyId),
          getInstructionAuthority: () => instructionAuthority.get(companyId),
          getPrivateFolderView: () => privateFolderGuardView(root),
        }
      },
      createCompanyFiles: (companyId, root, signal) => {
        let notDownloaded: string[] = []
        try { notDownloaded = root ? notDownloadedFolders(root) : [] } catch { /* unknown: the instructions just do not list them */ }
        return {
          tools: createCompanyFileTools({ api: companyFilesApi, companyId, companyRoot: root, signal }),
          instructions: companyFilesInstructions(notDownloaded),
        }
      },
      createReferences: (company, id, signal) => new ConsultationReferences(localHistoryStore, handoffStore).forTurn(company, id, signal),
      prepareRecovery: (company, id, messages) => recoveryContext(localHistoryStore.get(company, id), handoffStore.read(company, id), messages),
      onRecovery: (company, id, recovery) => handoffs.recordRecovery(company, id, recovery),
      persistAgentSession: (company, id, session) => {
        if (!localHistoryStore.patch(company, id, { agentSession: session, claudeSessionId: session.providerId === 'claude-code' ? session.id : '' })) throw new Error('相談が削除されたため引き継ぎを中止しました。')
        broadcastChatHistoryChanged({ companyId: company, sessionId: id, kind: 'patch' })
      },
      requestInteraction: (request, appSessionId, signal) => {
        const owner = mainWindow?.webContents
        if (!owner || owner.isDestroyed()) return Promise.resolve({ cancelled: true })
        const ownerId = owner.id
        const close = () => agentInteractions.closeOwner(ownerId)
        owner.once('destroyed', close)
        owner.once('did-start-navigation', close)
        return agentInteractions.request(ownerId, appSessionId, request, signal).finally(() => {
          owner.removeListener('destroyed', close)
          owner.removeListener('did-start-navigation', close)
        })
      },
      requestToolApproval: (toolName, toolInput, toolUseId, appSessionId, reason) => {
        return new Promise((resolve) => {
          pendingApprovals.set(toolUseId, { resolve })
          mainWindow?.webContents.send('tool-approval-request', {
            toolUseId, toolName, toolInput, appSessionId, ...(reason ? { reason } : {}),
          })
          // 60s timeout → auto-deny
          setTimeout(() => {
            if (pendingApprovals.has(toolUseId)) {
              pendingApprovals.delete(toolUseId)
              resolve({ approved: false })
            }
          }, 60_000)
        })
      },
    }
    const result = await startChatServer(serverConfig)
    chatServerInfo = { port: result.port, authToken: result.authToken }
  } catch (err) {
    console.error('[chat-server] Failed to start:', err)
  }

  createWindow()

  // Send chat server info to renderer once window is ready
  if (mainWindow && chatServerInfo) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.send('chat-server:info', chatServerInfo)
    })
  }
})
