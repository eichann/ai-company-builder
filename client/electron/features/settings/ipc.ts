// Settings: the API key, which AI the member signs in with (and whether its
// CLI is there), the chat's permission mode, the server URL, and which extra
// environment variable names AI processes may see.
//   config:*, codex:status

import type { CodexStatus } from '../../../shared/agent'
import { isAgentId } from '../../../shared/agents/registry'
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from '../../../shared/permission-mode'
import { normalizePassthroughNames, refusedPassthroughNames } from '../../agents/agent-env'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { ClaudeCli } from '../../services/claude-cli'
import type { ConfigStore } from '../../services/config-store'

export interface SettingsDeps {
  config: ConfigStore
  claudeCli: ClaudeCli
  /** Codex CLI presence and login (agents/codex.ts). */
  codexStatus: () => Promise<CodexStatus>
}

export function registerSettingsIpc(ipc: IpcRegistrar, deps: SettingsDeps): void {
  const { config } = deps

  // API Key management
  ipc.handle('config:getApiKey', () => {
    return config.load().anthropicApiKey || null
  })

  ipc.handle('config:setApiKey', (_, apiKey: string) => {
    const current = config.load()
    current.anthropicApiKey = apiKey
    config.save(current)
    return true
  })

  ipc.handle('config:hasApiKey', () => {
    return !!config.load().anthropicApiKey
  })

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

  ipc.handle('config:getClaudeCodeStatus', () => {
    return deps.claudeCli.status(true) // force refresh when explicitly requested
  })

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
