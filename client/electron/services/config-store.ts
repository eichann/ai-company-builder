// The app's settings on this computer: <userData>/config.json, read once and
// cached; every save rewrites the file (atomically, owner-only) and the cache.

import fs from 'fs'
import { atomicWrite } from '../chat-history-store'
import type { AuthMode } from '../../shared/agent'
import type { PermissionMode } from '../../shared/permission-mode'

export interface AppConfig {
  /**
   * Legacy: the API key in plain text (app versions before the key moved to
   * `anthropicApiKeyEncrypted`). Read only by services/api-key-store.ts, which
   * migrates it away; never write it.
   */
  anthropicApiKey?: string
  /** The API key encrypted by the OS (safeStorage), base64. Only services/api-key-store.ts reads it. */
  anthropicApiKeyEncrypted?: string
  authMode?: AuthMode
  permissionMode?: PermissionMode
  serverUrl?: string
  docbaseCookie?: string
  /** Extra environment variable names passed to AI processes (agents/agent-env.ts). */
  agentEnvPassthrough?: string[]
  /** Where the last consultation window (「別ウィンドウで開く」) was; the next one opens there. */
  chatWindowBounds?: { x?: number; y?: number; width: number; height: number }
}

export interface ConfigStore {
  /** The cached settings (read from disk the first time; {} when missing or unreadable). Mutate, then `save`. */
  load(): AppConfig
  save(config: AppConfig): void
  /** The AI the member signs in with ('claude-code' unless chosen). */
  authMode(): AuthMode
  /** The server's base URL: config.json, else API_URL, else ''. */
  serverUrl(): string
}

/** `configPath` is resolved on first use (Electron's userData path is known only then). */
export function createConfigStore(configPath: () => string): ConfigStore {
  let cachedConfig: AppConfig | null = null

  function load(): AppConfig {
    if (cachedConfig) return cachedConfig
    try {
      const file = configPath()
      if (fs.existsSync(file)) {
        cachedConfig = JSON.parse(fs.readFileSync(file, 'utf-8'))
        return cachedConfig!
      }
    } catch {
      // ignore
    }
    cachedConfig = {}
    return cachedConfig
  }

  return {
    load,
    save(config) {
      atomicWrite(configPath(), JSON.stringify(config, null, 2))
      cachedConfig = config
    },
    authMode: () => load().authMode || 'claude-code',
    serverUrl: () => load().serverUrl || process.env.API_URL || '',
  }
}
