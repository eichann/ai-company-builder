// The member's own API keys (「自分の鍵」, K8; .claude/rules/key-broker.md):
// list, register / replace, delete — the server decides everything. A key the
// member pastes passes through here once, in the PUT body, and is never kept,
// logged or answered: the renderer gets the server's view (last 4 only) or a
// sentence built from status codes alone (client/shared/broker-keys.ts).
//   brokerKeys:list, brokerKeys:save, brokerKeys:delete

import { OWN_KEYS_OFFLINE_TEXT, ownKeysErrorText, type MyBrokerKeys, type OwnKeysResult } from '../../../shared/broker-keys'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface BrokerDeps {
  baseUrl: () => string
  cookies: () => string[]
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

const invalid: OwnKeysResult = { success: false, offline: false, error: '入力が正しくありません。' }

export function registerBrokerIpc(ipc: IpcRegistrar, deps: BrokerDeps): void {
  const api = createOwnKeysApi(deps)
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
}
