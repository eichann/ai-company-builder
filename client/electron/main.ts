import { app, BrowserWindow, ipcMain, dialog, shell, net as electronNet, protocol } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { execSync, exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
import { createAnthropic } from '@ai-sdk/anthropic'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { streamText } from 'ai'
import { startChatServer, type ChatServerConfig } from './chat-server'
import simpleGit, { SimpleGit } from 'simple-git'
import { resolveGitBinary, resolveGitDir } from 'dugite'
import chokidar, { FSWatcher } from 'chokidar'
import net from 'net'

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

// File watchers map for tracking active watchers
const fileWatchers: Map<string, FSWatcher> = new Map()

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

// Config file path for storing API keys
const getConfigPath = () => path.join(app.getPath('userData'), 'config.json')

interface AppConfig {
  anthropicApiKey?: string
  authMode?: 'claude-code' | 'api-key'
  permissionMode?: 'bypassPermissions' | 'default'
  serverUrl?: string
}

// ============================================================================
// Shell PATH resolution for packaged app
// ============================================================================

/**
 * macOS .app bundles don't inherit the user's shell PATH.
 * Resolve the full PATH by querying the user's login shell.
 */
let resolvedShellPath: string | null = null

function getShellPath(): string {
  if (resolvedShellPath) return resolvedShellPath

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

  // Try to get the PATH from the user's default shell
  try {
    const userShell = process.env.SHELL || '/bin/zsh'
    const result = execSync(`${userShell} -ilc 'echo $PATH'`, {
      stdio: 'pipe',
      timeout: 5000,
      env: { ...process.env, HOME: os.homedir() },
    }).toString().trim()
    if (result) {
      resolvedShellPath = result
      return result
    }
  } catch { /* shell query failed, use fallback */ }

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

/** Get env object with resolved PATH for execSync/spawn calls */
function getShellEnv(): Record<string, string> {
  return { ...process.env as Record<string, string>, PATH: getShellPath() }
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
  if (process.platform === 'win32') {
    // Windows: try `where claude.cmd`
    try {
      const result = execSync('where claude.cmd', { stdio: 'pipe', timeout: 5000 }).toString().trim()
      const firstLine = result.split('\n')[0]?.trim()
      if (firstLine) return firstLine
    } catch { /* not found via where */ }
    // Fallback: common Windows paths
    const winPaths = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(os.homedir(), '.npm-global', 'bin', 'claude.cmd'),
    ]
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  // macOS / Linux: try `which claude` with resolved shell PATH
  try {
    const result = execSync('which claude', { stdio: 'pipe', timeout: 5000, env: getShellEnv() }).toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch { /* not found via which */ }

  // Fallback: search common paths
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

  // Step 2: Check version (confirms the binary is executable)
  try {
    const versionOutput = execSync(`"${cliPath}" --version`, { stdio: 'pipe', timeout: 10000, env: getShellEnv() }).toString().trim()
    status.version = versionOutput
    status.available = true
    // Assume authenticated if CLI is executable.
    // Actual auth errors will surface at API call time with a clear message.
    // Note: `claude config list` etc. cannot be used for auth checking because
    // they start a full session and fail in nested/Electron contexts.
    status.authenticated = true
  } catch {
    status.error = `Claude Code CLIの実行に失敗しました（パス: ${cliPath}）。再インストールしてください。`
    cachedClaudeCodeStatus = status
    return status
  }

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

function loadConfig(): AppConfig {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }
  } catch {
    // ignore
  }
  return {}
}

function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
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
    },
  })

  // Fully disable spell checker to prevent dictionary loading overhead (especially for Japanese IME)
  mainWindow.webContents.session.setSpellCheckerLanguages([])

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

app.whenReady().then(async () => {
  // Handle local-file:// protocol to serve local files (restricted to allowed directories)
  protocol.handle('local-file', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local-file://', ''))
    const resolved = path.resolve(filePath)
    // Check if path is within an allowed directory
    let isAllowed = false
    for (const root of allowedRoots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        isAllowed = true
        break
      }
    }
    if (!isAllowed) {
      return new Response('Forbidden: path is outside allowed directories', { status: 403 })
    }
    return electronNet.fetch('file://' + resolved)
  })
  // Start embedded Hono chat server
  try {
    const serverConfig: ChatServerConfig = {
      getAuthMode: () => {
        const config = loadConfig()
        return (config.authMode || 'claude-code') as 'claude-code' | 'api-key'
      },
      getApiKey: () => {
        const config = loadConfig()
        return config.anthropicApiKey
      },
      getPermissionMode: () => {
        const config = loadConfig()
        return (config.permissionMode || 'bypassPermissions') as 'bypassPermissions' | 'default'
      },
      isClaudeCodeAuthenticated,
      getClaudeCodeCliPath,
      getShellEnv,
      buildSystemPrompt,
      requestToolApproval: (toolName, toolInput, toolUseId) => {
        return new Promise((resolve) => {
          pendingApprovals.set(toolUseId, { resolve })
          mainWindow?.webContents.send('tool-approval-request', {
            toolUseId, toolName, toolInput,
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

// Clean up file watchers on app quit
app.on('before-quit', () => {
  fileWatchers.forEach((watcher) => watcher.close())
  fileWatchers.clear()
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

ipcMain.handle('fs:readFile', async (_, filePath: string) => {
  try {
    const safePath = validatePath(filePath)
    return await fs.promises.readFile(safePath, 'utf-8')
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
  try {
    const safePath = validatePath(filePath)
    await fs.promises.writeFile(safePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:createDirectory', async (_, dirPath: string) => {
  try {
    const safePath = validatePath(dirPath)
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
    await fs.promises.rename(safeSrc, safeDest)
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

// Start watching a directory
ipcMain.handle('fs:watch', async (_, rootPath: string) => {
  try {
    const safePath = validatePath(rootPath)
    // Stop existing watcher for this path if any
    if (fileWatchers.has(safePath)) {
      await fileWatchers.get(safePath)?.close()
    }

    const watcher = chokidar.watch(safePath, {
      ignored: /node_modules|\.git/,
      persistent: true,
      ignoreInitial: true,
      depth: 10,
    })

    watcher.on('add', (filePath) => {
      mainWindow?.webContents.send('fs:change', { type: 'add', path: filePath })
    })
    watcher.on('addDir', (dirPath) => {
      mainWindow?.webContents.send('fs:change', { type: 'addDir', path: dirPath })
    })
    watcher.on('unlink', (filePath) => {
      mainWindow?.webContents.send('fs:change', { type: 'unlink', path: filePath })
    })
    watcher.on('unlinkDir', (dirPath) => {
      mainWindow?.webContents.send('fs:change', { type: 'unlinkDir', path: dirPath })
    })
    watcher.on('change', (filePath) => {
      mainWindow?.webContents.send('fs:change', { type: 'change', path: filePath })
    })

    fileWatchers.set(safePath, watcher)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Stop watching a directory
ipcMain.handle('fs:unwatch', async (_, rootPath: string) => {
  try {
    const safePath = validatePath(rootPath)
    const watcher = fileWatchers.get(safePath)
    if (watcher) {
      await watcher.close()
      fileWatchers.delete(safePath)
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
ipcMain.handle('config:getAuthMode', () => {
  const config = loadConfig()
  return config.authMode || 'claude-code'
})

ipcMain.handle('config:setAuthMode', (_, mode: 'claude-code' | 'api-key') => {
  const config = loadConfig()
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
  const config = loadConfig()
  return config.permissionMode || 'bypassPermissions'
})

ipcMain.handle('config:setPermissionMode', (_, mode: 'bypassPermissions' | 'default') => {
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

// Chat history management
const getChatHistoryDir = () => path.join(app.getPath('userData'), 'chat-history')

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

interface ChatHistoryFile {
  sessions: ChatSession[]
}

function getChatHistoryPath(companyId: string): string {
  const dir = getChatHistoryDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, `${companyId}.json`)
}

function loadChatHistory(companyId: string): ChatHistoryFile {
  try {
    const filePath = getChatHistoryPath(companyId)
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (e) {
    console.error('Failed to load chat history:', e)
  }
  return { sessions: [] }
}

function saveChatHistory(companyId: string, history: ChatHistoryFile): void {
  const filePath = getChatHistoryPath(companyId)
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2))
}

// Get all sessions for a company (returns last 5)
ipcMain.handle('chatHistory:getSessions', (_, companyId: string) => {
  const history = loadChatHistory(companyId)
  // Return last 5 sessions, sorted by updatedAt descending
  return history.sessions
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5)
})

// Get a specific session
ipcMain.handle('chatHistory:getSession', (_, companyId: string, sessionId: string) => {
  const history = loadChatHistory(companyId)
  return history.sessions.find(s => s.id === sessionId) || null
})

// Save a session (create or update)
ipcMain.handle('chatHistory:saveSession', (_, companyId: string, session: ChatSession) => {
  const history = loadChatHistory(companyId)
  const existingIndex = history.sessions.findIndex(s => s.id === session.id)

  if (existingIndex >= 0) {
    history.sessions[existingIndex] = session
  } else {
    history.sessions.push(session)
  }

  // Keep only last 5 sessions
  history.sessions = history.sessions
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5)

  saveChatHistory(companyId, history)
  return true
})

// Delete a session
ipcMain.handle('chatHistory:deleteSession', (_, companyId: string, sessionId: string) => {
  const history = loadChatHistory(companyId)
  history.sessions = history.sessions.filter(s => s.id !== sessionId)
  saveChatHistory(companyId, history)
  return true
})

// Server API URL - read from config.json (set during first-launch setup) with env fallback
function getServerApiUrl(): string {
  const config = loadConfig()
  return config.serverUrl || process.env.API_URL || ''
}

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

// Create a simpleGit instance with bundled git binary and HTTPS token authentication
function createGit(repoPath: string): SimpleGit {
  const gitBinary = resolveGitBinary()
  const gitDir = resolveGitDir()
  const askPassPath = getGitAskPassPath()
  const sessionToken = extractSessionToken(authCookies)

  return simpleGit(repoPath, {
    binary: gitBinary,
    unsafe: { allowUnsafeCustomBinary: true },
    config: ['core.hooksPath=/dev/null', 'credential.helper='],
  })
    .env({
      ...process.env,
      GIT_ASKPASS: askPassPath,
      GIT_TOKEN: sessionToken,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EXEC_PATH: path.join(gitDir, 'libexec', 'git-core'),
      GIT_TEMPLATE_DIR: path.join(gitDir, 'share', 'git-core', 'templates'),
    })
}

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
    const remotes = await git.getRemotes()
    const existingRemote = remotes.find(r => r.name === remoteName)

    if (existingRemote) {
      // Update existing remote
      await git.removeRemote(remoteName)
    }
    await git.addRemote(remoteName, remoteUrl)
    return { success: true }
  } catch (error) {
    console.error('Git addRemote error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('git:sync', async (_, repoPath: string, companyId: string, commitMessage: string) => {
  try {
    const git: SimpleGit = createGit(repoPath)
    const backupsDir = path.join(repoPath, '.backups')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupPath = path.join(backupsDir, timestamp)

    // Auto-migrate remote URL from SSH to HTTPS if needed
    try {
      const remotes = await git.getRemotes(true)
      const origin = remotes.find(r => r.name === 'origin')
      if (origin && origin.refs?.fetch && !origin.refs.fetch.startsWith('https://')) {
        console.log('Git sync: Detected SSH remote URL, migrating to HTTPS...')
        const repoInfoResponse = await fetch(`${getServerApiUrl()}/api/git/repos/${companyId}`, {
          headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
        })
        if (repoInfoResponse.ok) {
          const repoInfo = await repoInfoResponse.json()
          const httpsUrl = repoInfo.data?.httpsUrl
          if (httpsUrl) {
            await git.removeRemote('origin')
            await git.addRemote('origin', httpsUrl)
            console.log(`Git sync: Migrated remote URL to ${httpsUrl}`)
          }
        }
      }
    } catch (migrationError) {
      console.warn('Git sync: Remote URL migration check failed:', migrationError)
    }

    // Set git user identity from logged-in user
    if (authCookies.length > 0) {
      try {
        const response = await fetch(`${getServerApiUrl()}/api/me`, {
          headers: { 'Cookie': authCookies.join('; ') },
        })
        if (response.ok) {
          const data = await response.json()
          if (data.success && data.data) {
            const userName = data.data.name || data.data.email
            const userEmail = data.data.email
            await git.addConfig('user.name', userName, false, 'local')
            await git.addConfig('user.email', userEmail, false, 'local')
          }
        }
      } catch (e) {
        console.warn('Git sync: Could not set git user identity:', e)
      }
    }

    // Ensure essential patterns are in .gitignore
    const gitignorePath = path.join(repoPath, '.gitignore')
    let gitignoreContent = ''
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
    }

    // Essential patterns that should always be ignored
    const essentialPatterns = [
      { pattern: '.backups/', comment: '' },
      { pattern: 'node_modules/', comment: '# Dependencies' },
    ]

    const patternsToAdd: string[] = []
    for (const { pattern, comment } of essentialPatterns) {
      if (!gitignoreContent.includes(pattern)) {
        if (comment) patternsToAdd.push(comment)
        patternsToAdd.push(pattern)
      }
    }

    if (patternsToAdd.length > 0) {
      const addition = '\n' + patternsToAdd.join('\n') + '\n'
      fs.appendFileSync(gitignorePath, addition)
      gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
    } else if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '.backups/\nnode_modules/\n')
      gitignoreContent = '.backups/\nnode_modules/\n'
    }

    // Detect large files (>100MB) and add to .gitignore
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100MB
    const ignoredLargeFiles: string[] = []

    function scanForLargeFiles(dir: string, baseDir: string): void {
      if (!fs.existsSync(dir)) return
      const items = fs.readdirSync(dir)

      for (const item of items) {
        const fullPath = path.join(dir, item)
        const relativePath = path.relative(baseDir, fullPath)

        // Skip directories that are always ignored
        if (item === '.git' || item === '.backups' || item === 'node_modules') continue
        // Skip if already in .gitignore
        if (gitignoreContent.includes(relativePath)) continue

        try {
          const stat = fs.statSync(fullPath)
          if (stat.isDirectory()) {
            scanForLargeFiles(fullPath, baseDir)
          } else if (stat.isFile() && stat.size > LARGE_FILE_THRESHOLD) {
            ignoredLargeFiles.push(relativePath)
          }
        } catch {
          // Skip files we can't access
        }
      }
    }

    scanForLargeFiles(repoPath, repoPath)

    // Add large files to .gitignore
    if (ignoredLargeFiles.length > 0) {
      const largeFilesSection = '\n# Auto-ignored: Large files (>100MB)\n' +
        ignoredLargeFiles.map(f => f).join('\n') + '\n'
      fs.appendFileSync(gitignorePath, largeFilesSection)
      console.log(`Git sync: Ignored ${ignoredLargeFiles.length} large file(s):`, ignoredLargeFiles)
    }

    // 1. Fetch from origin
    console.log('Git sync: Fetching from origin...')
    try {
      await git.fetch('origin')
    } catch (fetchError) {
      console.warn('Git sync: Fetch failed (may be offline):', fetchError)
    }

    // 2. Protect department folders (restore if deleted locally)
    let restoredFolders: string[] = []
    if (companyId) {
      try {
        const response = await fetch(`${getServerApiUrl()}/api/companies/${companyId}/departments`, {
          headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
        })
        if (response.ok) {
          const result = await response.json()
          const departments = result.data || []

          for (const dept of departments) {
            const deptPath = path.join(repoPath, dept.folder)
            if (!fs.existsSync(deptPath)) {
              // Department folder was deleted locally - try to restore from origin
              console.log(`Git sync: Restoring deleted department folder: ${dept.folder}`)
              try {
                await git.checkout(['origin/main', '--', dept.folder])
                restoredFolders.push(dept.folder)
              } catch (restoreError) {
                // Folder might not exist on origin either, create empty
                console.warn(`Git sync: Could not restore ${dept.folder}, creating empty:`, restoreError)
                fs.mkdirSync(deptPath, { recursive: true })
                fs.writeFileSync(path.join(deptPath, '.gitkeep'), '')
                restoredFolders.push(dept.folder)
              }
            }
          }
        }
      } catch (apiError) {
        console.warn('Git sync: Could not fetch departments from API:', apiError)
      }
    }

    // 3. Add all files and commit
    await git.add('.')
    const status = await git.status()

    const hasLocalChanges = status.staged.length > 0 || status.files.length > 0

    if (hasLocalChanges) {
      await git.commit(commitMessage || 'Sync from AI Company Builder')
    }

    // Record local commit hash before rebase attempt
    const localHash = (await git.revparse(['HEAD'])).trim()
    console.log(`Git sync: Local commit hash: ${localHash}`)

    // 4. Pull with rebase
    let hadConflicts = false
    let conflictFiles: string[] = []

    try {
      console.log('Git sync: Pulling with rebase...')
      await git.pull('origin', 'main', ['--rebase'])
    } catch (pullError) {
      console.log('Git sync: Pull/rebase failed, checking for conflicts...')

      // Check if it's a conflict
      const statusAfterPull = await git.status()
      if (statusAfterPull.conflicted.length > 0) {
        hadConflicts = true
        conflictFiles = statusAfterPull.conflicted

        console.log(`Git sync: Conflict detected in ${conflictFiles.length} files`)

        // a. Backup conflicting files (get clean local version from localHash)
        fs.mkdirSync(backupPath, { recursive: true })

        for (const file of conflictFiles) {
          try {
            const content = await git.show([`${localHash}:${file}`])
            const destPath = path.join(backupPath, file)
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            fs.writeFileSync(destPath, content)
          } catch {
            // File might not exist in localHash (e.g., new file on server side only)
          }
        }

        // Save metadata
        const metadata = {
          timestamp: new Date().toISOString(),
          reason: 'conflict',
          conflictFiles,
          message: commitMessage || 'Sync from AI Company Builder'
        }
        fs.writeFileSync(
          path.join(backupPath, '_metadata.json'),
          JSON.stringify(metadata, null, 2)
        )

        // b. Resolve conflicts: take server version (--ours in rebase context = upstream)
        console.log('Git sync: Resolving conflicts with server version...')
        await git.checkout(['--ours', '--', ...conflictFiles])
        await git.add(conflictFiles)

        // c. Continue rebase (non-conflicting files are already auto-merged by git)
        try {
          console.log('Git sync: Continuing rebase...')
          await git.rebase(['--continue'])
        } catch {
          // If all local changes were only in conflicting files,
          // the rebased commit may be empty → skip it
          console.log('Git sync: Rebase continue failed, trying skip...')
          try {
            await git.rebase(['--skip'])
          } catch {
            // Rebase may already be complete
          }
        }

      } else {
        // Not a conflict, maybe network error or no remote tracking
        console.warn('Git sync: Pull failed but no conflicts:', pullError)
      }
    }

    // 5. Push (only if we have local changes to push)
    if (!hasLocalChanges && !hadConflicts) {
      // No local changes and no conflicts — just pulled remote changes
      let successMessage = restoredFolders.length > 0
        ? `部署フォルダを復元しました: ${restoredFolders.join(', ')}`
        : '同期が完了しました'
      if (ignoredLargeFiles.length > 0) {
        successMessage += `（${ignoredLargeFiles.length}個の大容量ファイルを同期対象外にしました）`
      }
      return {
        success: true,
        message: successMessage,
        restoredFolders,
        ignoredLargeFiles
      }
    }

    try {
      console.log('Git sync: Pushing to origin...')
      await git.push('origin', 'main', ['--set-upstream'])
    } catch (pushError) {
      // Check if push was rejected due to secret detection
      const pushErrorMsg = pushError instanceof Error ? pushError.message : String(pushError)
      if (pushErrorMsg.includes('SECRET_DETECTED')) {
        // Extract file list from error message
        // git prefixes pre-receive hook stderr with "remote: "
        const fileLines = pushErrorMsg
          .split('\n')
          .map((line: string) => line.replace(/^remote:\s*/, '').trim())
          .filter((line: string) => line.startsWith('- '))
        const fileList = fileLines.length > 0
          ? fileLines.join('\n')
          : '（詳細不明）'
        return {
          success: false,
          error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
          secretDetected: true
        }
      }

      console.error('Git sync: Push to main failed:', pushErrorMsg)
      // Try master branch if main fails
      try {
        await git.push('origin', 'master', ['--set-upstream'])
      } catch (masterPushError) {
        // Check secret detection on master push too
        const masterErrorMsg = masterPushError instanceof Error ? masterPushError.message : String(masterPushError)
        if (masterErrorMsg.includes('SECRET_DETECTED')) {
          const fileLines = masterErrorMsg
            .split('\n')
            .map((line: string) => line.replace(/^remote:\s*/, '').trim())
            .filter((line: string) => line.startsWith('- '))
          const fileList = fileLines.length > 0
            ? fileLines.join('\n')
            : '（詳細不明）'
          return {
            success: false,
            error: `シークレット（APIキー等）が検出されました。\n該当ファイルからシークレットを削除してから再度同期してください。\n\n${fileList}`,
            secretDetected: true
          }
        }
        console.error('Git sync: Push to master also failed:', masterErrorMsg)
        return {
          success: true,
          message: 'ローカルにコミットしました。プッシュに失敗しました。',
          pushFailed: true,
          hadConflicts,
          conflictFiles,
          backupPath: hadConflicts ? backupPath : undefined,
          restoredFolders,
          ignoredLargeFiles
        }
      }
    }

    // Success
    if (hadConflicts) {
      return {
        success: true,
        message: `同期完了。${conflictFiles.length}ファイルが競合したためサーバー版で上書きしました。その他の変更は正常に反映されました。`,
        hadConflicts: true,
        conflictFiles,
        backupPath,
        restoredFolders,
        ignoredLargeFiles
      }
    }

    let successMessage = '同期が完了しました'
    if (ignoredLargeFiles.length > 0) {
      successMessage += `（${ignoredLargeFiles.length}個の大容量ファイルを同期対象外にしました）`
    }

    return {
      success: true,
      message: successMessage,
      restoredFolders,
      ignoredLargeFiles
    }
  } catch (error) {
    console.error('Git sync error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// Setup Git remote for a company
ipcMain.handle('git:setupCompanyRemote', async (_, repoPath: string, companyId: string) => {
  try {
    // Fetch HTTPS URL from server API
    const repoInfoResponse = await fetch(`${getServerApiUrl()}/api/git/repos/${companyId}`, {
      headers: authCookies.length > 0 ? { 'Cookie': authCookies.join('; ') } : {},
    })
    if (!repoInfoResponse.ok) {
      return { success: false, error: 'Failed to get repository info from server' }
    }
    const repoInfo = await repoInfoResponse.json()
    const remoteUrl = repoInfo.data?.httpsUrl
    if (!remoteUrl) {
      return { success: false, error: 'Server did not return repository URL' }
    }

    const git: SimpleGit = createGit(repoPath)

    // Check if it's already a git repo
    const isRepo = await git.checkIsRepo()
    if (!isRepo) {
      await git.init()
    }

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

    // Add/update origin remote
    const remotes = await git.getRemotes()
    const existingOrigin = remotes.find(r => r.name === 'origin')
    if (existingOrigin) {
      await git.removeRemote('origin')
    }
    await git.addRemote('origin', remoteUrl)

    // Check if remote has any branches (i.e. commits exist)
    let remoteHasCommits = false
    try {
      const lsRemote = await git.listRemote(['--heads', 'origin'])
      remoteHasCommits = lsRemote.trim().length > 0
    } catch (lsError) {
      console.warn('Git setup: ls-remote failed:', lsError)
    }

    if (remoteHasCommits) {
      // Remote has content — pull it down (member joining existing company)
      console.log('Git setup: Remote has commits, fetching...')
      await git.fetch('origin')

      // Determine the main branch name
      const lsRemote = await git.listRemote(['--heads', 'origin'])
      const branchMatch = lsRemote.match(/refs\/heads\/(\S+)/)
      const remoteBranch = branchMatch ? branchMatch[1] : 'main'

      // Check if we have local commits
      const localLog = await git.log().catch(() => null)
      if (!localLog || localLog.total === 0) {
        // No local commits — checkout the remote branch
        await git.checkout(['-b', remoteBranch, `origin/${remoteBranch}`])
        console.log(`Git setup: Checked out origin/${remoteBranch}`)
      } else {
        // Local commits exist — set up tracking and pull
        const status = await git.status()
        const localBranch = status.current || 'main'
        try {
          await git.pull('origin', remoteBranch, ['--rebase'])
          console.log(`Git setup: Pulled origin/${remoteBranch} into ${localBranch}`)
        } catch (pullError) {
          console.warn('Git setup: Pull failed, will resolve on next sync:', pullError)
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
          fs.writeFileSync(gitignorePath, '.DS_Store\n*.log\nnode_modules/\n')
        }

        await git.add('.')
        await git.commit('Initial commit')
      }

      // Push to server
      try {
        const status = await git.status()
        const branch = status.current || 'main'
        await git.push('origin', branch, ['--set-upstream'])
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
  }
})

// Get backup history
ipcMain.handle('backup:list', async (_, repoPath: string) => {
  try {
    const backupsDir = path.join(repoPath, '.backups')

    if (!fs.existsSync(backupsDir)) {
      return { success: true, backups: [] }
    }

    const entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    const backups: Array<{
      id: string
      timestamp: string
      reason: string
      files: string[]
      path: string
    }> = []

    for (const entry of entries) {
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
          id: entry.name,
          timestamp: metadata.timestamp || entry.name,
          reason: metadata.reason || 'unknown',
          files: metadata.conflictFiles || files,
          path: backupPath
        })
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
    const backupsDir = path.join(safeRepoPath, '.backups')
    const backupPath = path.join(backupsDir, backupId)
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
    const { shell } = require('electron')
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
    await git.add('.')

    // Check status
    const status = await git.status()

    // Commit if there are changes
    if (status.files.length > 0) {
      await git.commit(`Sync: ${new Date().toISOString()}`)
    }

    // Push with set-upstream
    const branch = status.current || 'main'
    await git.push('origin', branch, ['--set-upstream', '--force'])

    return { success: true, message: `Pushed to server (branch: ${branch})` }
  } catch (error) {
    console.error('Git push error:', error)
    const errorMsg = error instanceof Error ? error.message : String(error)
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

// List skills for a department
ipcMain.handle('skills:list', async (_, rootPath: string, departmentFolder: string, departmentId: string) => {
  try {
    const skillsDir = path.join(rootPath, departmentFolder, '.claude', 'skills')

    // Check if skills directory exists
    if (!fs.existsSync(skillsDir)) {
      return { success: true, skills: [] }
    }

    // Read .gitignore to detect draft skills
    const gitignorePath = path.join(rootPath, '.gitignore')
    const gitignoreLines: string[] = []
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8')
      gitignoreLines.push(...content.split('\n').map(l => l.trim()))
    }

    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    const skills: SkillInfo[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue // Skip hidden folders

      const skillPath = path.join(skillsDir, entry.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')

      // Check if SKILL.md exists
      if (!fs.existsSync(skillMdPath)) continue

      try {
        const skillMdContent = await fs.promises.readFile(skillMdPath, 'utf-8')
        const frontmatter = parseSkillFrontmatter(skillMdContent)

        // Scan for additional files
        const rulesDir = path.join(skillPath, 'rules')
        const scriptsDir = path.join(skillPath, 'scripts')
        const referencesDir = path.join(skillPath, 'references')

        const files: SkillInfo['files'] = {
          skillMd: skillMdPath,
        }

        // Collect rules files
        if (fs.existsSync(rulesDir)) {
          const rulesEntries = await fs.promises.readdir(rulesDir)
          files.rules = rulesEntries
            .filter(f => f.endsWith('.md'))
            .map(f => path.join(rulesDir, f))
        }

        // Collect scripts files
        if (fs.existsSync(scriptsDir)) {
          const scriptsEntries = await fs.promises.readdir(scriptsDir)
          files.scripts = scriptsEntries
            .filter(f => !f.startsWith('.'))
            .map(f => path.join(scriptsDir, f))
        }

        // Collect references files
        if (fs.existsSync(referencesDir)) {
          const refsEntries = await fs.promises.readdir(referencesDir)
          files.references = refsEntries
            .filter(f => !f.startsWith('.'))
            .map(f => path.join(referencesDir, f))
        }

        // Collect tools (Web apps)
        const toolsDir = path.join(skillPath, 'tools')
        if (fs.existsSync(toolsDir)) {
          const toolsEntries = await fs.promises.readdir(toolsDir, { withFileTypes: true })
          const tools: ToolInfo[] = []

          for (const toolEntry of toolsEntries) {
            if (!toolEntry.isDirectory()) continue
            if (toolEntry.name.startsWith('.')) continue
            if (toolEntry.name === 'node_modules') continue

            const toolPath = path.join(toolsDir, toolEntry.name)
            const packageJsonPath = path.join(toolPath, 'package.json')
            const hasPackageJson = fs.existsSync(packageJsonPath)

            let displayName = toolEntry.name
            let startCommand: string | undefined

            if (hasPackageJson) {
              try {
                const pkgContent = await fs.promises.readFile(packageJsonPath, 'utf-8')
                const pkg = JSON.parse(pkgContent)
                displayName = pkg.name || toolEntry.name
                // Determine start command (prefer "dev" for development)
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
              path: toolPath,
              hasPackageJson,
              startCommand,
            })
          }

          if (tools.length > 0) {
            files.tools = tools
          }
        }

        // Check if this skill is in .gitignore (private/not shared)
        const skillRelativePath = `${departmentFolder}/.claude/skills/${entry.name}/`
        const isPrivate = gitignoreLines.some(line => line === skillRelativePath)

        skills.push({
          id: `${departmentId}-${entry.name}`,
          name: frontmatter.name || entry.name,
          description: frontmatter.description || '',
          departmentId,
          skillPath,
          isPrivate,
          isNurturing: frontmatter.status === 'nurturing',
          files,
        })
      } catch (err) {
        console.error(`Failed to parse skill ${entry.name}:`, err)
        // Skip this skill if parsing fails
      }
    }

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
    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
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
        await execAsync('npm install', { cwd: toolPath })
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
          server.close()
          resolve(false)
        })
        server.listen(p)
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
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const logPath = path.join(toolPath, '.tool-output.log')
    const logFd = fs.openSync(logPath, 'w')

    console.log('[tools:start] About to spawn:', npmCmd, 'run', startCommand)
    const childProcess = spawn(npmCmd, ['run', startCommand, '--', '--port', port.toString()], {
      cwd: toolPath,
      stdio: ['ignore', logFd, logFd],
      detached: false,
      env: { ...process.env, PORT: port.toString(), PATH: getShellPath() },
    })
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

    // Wait a bit for the server to start
    await new Promise((resolve) => setTimeout(resolve, 2000))

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
        spawn('taskkill', ['/pid', runningTool.process.pid.toString(), '/f', '/t'])
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
