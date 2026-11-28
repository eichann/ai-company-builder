// Settings: the API key, which AI the member signs in with (and whether its
// CLI is there), the chat's permission mode, the server URL, and which extra
// environment variable names AI processes may see; 「ブラウザ操作」's operator tool set on this PC.
//   config:*, codex:status

import type { CodexStatus } from '../../../shared/agent'
import { isAgentId } from '../../../shared/agents/registry'
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from '../../../shared/permission-mode'
import { BROWSER_OPERATOR_TOOLSETS, browserOperatorToolset, type BrowserOperatorToolset } from '../../../shared/browser-operator-toolsets'
import { normalizePassthroughNames, refusedPassthroughNames } from '../../agents/agent-env'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { ApiKeyStore } from '../../services/api-key-store'
import type { ClaudeCli } from '../../services/claude-cli'
import { withSignIn, type ClaudeSignInService } from '../../services/claude-sign-in'
import type { PathGuard } from '../ports'
import type { ConfigStore } from '../../services/config-store'

export interface SettingsDeps {
  config: ConfigStore
  /** The encrypted API key (status and save only reach the renderer). */
  apiKey: Pick<ApiKeyStore, 'status' | 'save'>
  claudeCli: ClaudeCli
  /** The member's own `claude auth status` / `claude auth login` (services/claude-sign-in.ts). */
  claudeSignIn: ClaudeSignInService
  /** The chat's folder the sign-in is checked in must be a company folder (allowed roots). */
  paths: PathGuard
  /** Codex CLI presence and login (agents/codex.ts). */
  codexStatus: () => Promise<CodexStatus>
}

export function registerSettingsIpc(ipc: IpcRegistrar, deps: SettingsDeps): void {
  const { config } = deps

  // The API key: the renderer only ever gets its status (set, last four
  // characters), never the key (services/api-key-store.ts).
  ipc.handle('config:getApiKeyStatus', () => deps.apiKey.status())

  ipc.handle('config:setApiKey', (_, apiKey: string) => deps.apiKey.save(apiKey))

  ipc.handle('config:hasApiKey', () => deps.apiKey.status().set)

  // Auth mode management
  ipc.handle('codex:status', () => deps.codexStatus())

  ipc.handle('config:getAuthMode', () => config.authMode())

  ipc.handle('config:setAuthMode', (_, mode: 'claude-code' | 'codex' | 'api-key') => {
    const current = config.load()
    if (!isAgentId(mode)) throw new Error('不明なAI接続方式です。')
    current.authMode = mode
    config.save(current)
    return true
  })

  // The folder the chat runs Claude Code in (its project settings may sign it in another way);
  // anything not a company folder is no folder, and then the answer is unknown (never blocks).
  const chatFolder = (root: unknown): string | undefined => {
    if (typeof root !== 'string' || !root) return undefined
    try { return deps.paths.validate(root) } catch { return undefined }
  }

  ipc.handle('config:getClaudeCodeStatus', async (_, root?: string) => {
    // The folder is judged first, whatever the CLI's state (no path from the renderer goes unchecked).
    const folder = chatFolder(root)
    const installed = deps.claudeCli.status(true) // force refresh when explicitly requested
    if (!installed.available) return installed
    return withSignIn(installed, await deps.claudeSignIn.check(folder))
  })

  // 「Claude にログインする」: the official CLI's own sign-in; one at a time for the whole app.
  ipc.handle('claudeSignIn:start', (_, root?: string) => deps.claudeSignIn.start(chatFolder(root)))
  ipc.handle('claudeSignIn:cancel', () => deps.claudeSignIn.cancel())
  ipc.handle('claudeSignIn:openPage', () => deps.claudeSignIn.openPage())

  ipc.handle('config:getPermissionMode', () => {
    return normalizePermissionMode(config.load().permissionMode)
  })

  ipc.handle('config:setPermissionMode', (_, mode: PermissionMode) => {
    if (!PERMISSION_MODES.includes(mode)) return false
    const current = config.load()
    current.permissionMode = mode
    config.save(current)
    return true
  })

  // 「ブラウザ操作」's operator tool set on this PC (agent-browser.md "The operator's tool sets"): what the operator is told
  // and how its answer is read — never what it may do. Anything not a known set is refused, never stored.
  ipc.handle('config:getBrowserOperatorToolset', () => browserOperatorToolset(config.load().browserOperatorToolset))

  ipc.handle('config:setBrowserOperatorToolset', (_, toolset: BrowserOperatorToolset) => {
    if (!(BROWSER_OPERATOR_TOOLSETS as readonly unknown[]).includes(toolset)) return false
    const current = config.load()
    current.browserOperatorToolset = toolset
    config.save(current)
    return true
  })

  // Server URL configuration
  ipc.handle('config:getServerUrl', () => {
    return config.load().serverUrl || process.env.API_URL || null
  })

  ipc.handle('config:setServerUrl', (_, url: string) => {
    const current = config.load()
    current.serverUrl = url
    config.save(current)
    return true
  })

  // Extra variable names the member lets AI processes see (agents/agent-env.ts).
  // Secret-looking names are refused, never stored; names only, never values.
  ipc.handle('config:getAgentEnvPassthrough', () => {
    const stored = config.load().agentEnvPassthrough
    return normalizePassthroughNames(Array.isArray(stored) ? stored : [])
  })

  ipc.handle('config:setAgentEnvPassthrough', (_, names: string[]) => {
    const list = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean) : []
    const { invalid, denied } = refusedPassthroughNames(list)
    const current = config.load()
    current.agentEnvPassthrough = normalizePassthroughNames(list)
    config.save(current)
    return { names: current.agentEnvPassthrough, invalid, denied }
  })

  ipc.handle('config:validateServerUrl', async (_, url: string) => {
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
}
