// The member's own API keys (「自分の鍵」, K8; .claude/rules/key-broker.md):
// list, register / replace, delete — the server decides everything. A key the
// member pastes passes through here once, in the PUT body, and is never kept,
// logged or answered: the renderer gets the server's view (last 4 only) or a
// sentence built from status codes alone (client/shared/broker-keys.ts).
//   brokerKeys:list, brokerKeys:save, brokerKeys:delete, brokerKeys:moveFromEnv
//
// brokerKeys:moveFromEnv moves a built-in service's key from the company
// folder's .env to the server as one's own key: main reads the value (it never
// reaches the renderer), sends it like brokerKeys:save, and takes the name out
// of the .env only after the server kept the key — and only if the .env still
// holds that same value. A refusal, an offline server or a failed write leaves
// the .env as it was.

import fs from 'fs'
import path from 'path'
import { ENV_KEY_SERVICES, OWN_KEYS_OFFLINE_TEXT, ownKeysErrorText, type MyBrokerKeys, type OwnKeyMoveResult, type OwnKeysResult } from '../../../shared/broker-keys'
import { applyEnvChanges, parseEnvFile } from '../../../shared/env-file'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'

export interface BrokerDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** The allowed company roots (the .env move reads and writes `<root>/.env`). */
  paths: PathGuard
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

const SERVICE = /^[a-z0-9][a-z0-9_-]{0,39}$/

export function createOwnKeysApi(deps: BrokerDeps) {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? console

  async function request(companyId: string, method: string, rest: string, body?: unknown): Promise<OwnKeysResult> {
    const base = deps.baseUrl()
    if (!base) return { success: false, offline: true, error: OWN_KEYS_OFFLINE_TEXT }
    let res: Response
    try {
      res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/broker-keys${rest}`, {
        method,
        headers: { Cookie: deps.cookies().join('; '), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      // The error may quote the request; say only that it failed.
      log.warn('[broker] own keys: the server could not be reached')
      return { success: false, offline: true, error: OWN_KEYS_OFFLINE_TEXT }
    }
    const json = (await res.json().catch(() => null)) as { data?: MyBrokerKeys } | null
    if (res.ok && json?.data && Array.isArray(json.data.services)) return { success: true, data: json.data }
    log.warn(`[broker] own keys: ${method} answered ${res.status}`)
    return { success: false, offline: false, error: ownKeysErrorText(res.status, json) }
  }

  return {
    list: (companyId: string) => request(companyId, 'GET', ''),
    save: (companyId: string, service: string, secret: string, displayName?: string) =>
      request(companyId, 'PUT', `/${service}`, { secret, ...(displayName ? { displayName } : {}) }),
    remove: (companyId: string, service: string) => request(companyId, 'DELETE', `/${service}`),
  }
}

const invalid = { success: false, offline: false, error: '入力が正しくありません。' } as const satisfies OwnKeysResult

/** The .env value of `name`, or null (no file, no such name, empty). */
async function envValue(envPath: string, name: string): Promise<string | null> {
  if (!fs.existsSync(envPath)) return null
  const value = parseEnvFile(await fs.promises.readFile(envPath, 'utf-8'))[name]
  return typeof value === 'string' && value.trim() ? value : null
}

export function createEnvKeyMove(deps: Pick<BrokerDeps, 'paths' | 'log'>, api: ReturnType<typeof createOwnKeysApi>) {
  const log = deps.log ?? console
  return async (companyId: string, rootPath: string, name: string): Promise<OwnKeyMoveResult> => {
    const service = ENV_KEY_SERVICES[name]
    if (!service) return invalid
    const envPath = deps.paths.validate(path.join(deps.paths.validate(rootPath), '.env'))
    const value = await envValue(envPath, name)
    if (!value) return { success: false, offline: false, error: 'この PC の .env に、この鍵が見つかりませんでした。' }
    const saved = await api.save(companyId, service, value.trim())
    if (!saved.success) return saved
    // The server kept it: now take the local copy out, unless the .env changed meanwhile.
    try {
      const current = fs.existsSync(envPath) ? await fs.promises.readFile(envPath, 'utf-8') : ''
      if (parseEnvFile(current)[name] !== value) return { success: true, data: saved.data, removed: false }
      await fs.promises.writeFile(envPath, applyEnvChanges(current, { [name]: null }), { encoding: 'utf-8', mode: 0o600 })
      return { success: true, data: saved.data, removed: true }
    } catch {
      log.warn('[broker] own keys: the key was sent, but the .env could not be updated')
      return { success: true, data: saved.data, removed: false }
    }
  }
}

export function registerBrokerIpc(ipc: IpcRegistrar, deps: BrokerDeps): void {
  const api = createOwnKeysApi(deps)
  const moveFromEnv = createEnvKeyMove(deps, api)
  ipc.handle('brokerKeys:list', async (_, companyId: string) => {
    if (typeof companyId !== 'string' || !companyId) return invalid
    return api.list(companyId)
  })
  ipc.handle('brokerKeys:save', async (_, companyId: string, service: string, secret: string, displayName?: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof service !== 'string' || !SERVICE.test(service) || typeof secret !== 'string') return invalid
    return api.save(companyId, service, secret.trim(), typeof displayName === 'string' ? displayName.trim() : undefined)
  })
  ipc.handle('brokerKeys:delete', async (_, companyId: string, service: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof service !== 'string' || !SERVICE.test(service)) return invalid
    return api.remove(companyId, service)
  })
  ipc.handle('brokerKeys:moveFromEnv', async (_, companyId: string, rootPath: string, name: string) => {
    if (typeof companyId !== 'string' || !companyId || typeof name !== 'string') return invalid
    try {
      return await moveFromEnv(companyId, rootPath, name)
    } catch (error) {
      // A path outside the company folder (or a link out of it): the guard's own sentence, no value.
      return { success: false, offline: false, error: error instanceof Error ? error.message : '入力が正しくありません。' }
    }
  })
}
