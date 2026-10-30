/**
 * The key broker's short-lived tokens on this computer (K6,
 * .claude/rules/key-broker.md): one per consultation (or per tool started
 * from the app) and department, asked from POST …/me/broker-tokens with the
 * member's session, kept in memory only, and replaced when less than
 * `REFRESH_MARGIN_MS` of its lifetime is left — so every chat turn starts
 * with a token that outlives a normal turn. Never written to disk, never
 * logged, never sent to the renderer: it goes only into the environment of
 * the chat's AI process and the tools the member starts (broker-env.ts).
 *
 * A failed request (offline, an older server, a timeout) gives no broker
 * variables for that turn: scripts then behave as before the broker.
 */
import type { BrokerTokenIssued } from '../../../shared/types/key-broker'
import { brokerEnv } from '../../shared/broker-env'

export interface BrokerTokenStoreDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  nowMs?: () => number
  log?: Pick<Console, 'warn'>
}

export interface BrokerEnvRequest {
  companyId: string
  /** The consultation (appSessionId), or `tool:<path>` for a tool started from the app. */
  conversationId: string
  /** The consultation's department folder (dial ① of who may use a company key). */
  department?: string | null
  /** Services whose standard variables the agent's CLI reads itself (registry `brokerReservedServices`). */
  reservedServices?: readonly string[]
  timeoutMs?: number
}

/** Replace a token when less than this is left (a turn rarely runs longer). */
export const REFRESH_MARGIN_MS = 10 * 60_000
const MAX_CACHED = 200

export interface BrokerTokenStore {
  /** The environment variables for one AI turn or tool start ({} when the broker is off or unreachable). */
  envFor(request: BrokerEnvRequest): Promise<Record<string, string>>
  /** Forget every token (sign-out, account change). */
  clear(): void
}

export function createBrokerTokenStore(deps: BrokerTokenStoreDeps): BrokerTokenStore {
  const doFetch = deps.fetch ?? fetch
  const now = deps.nowMs ?? Date.now
  const log = deps.log ?? console
  const cache = new Map<string, { issued: BrokerTokenIssued; expiresMs: number; server: string }>()

  async function issue(request: BrokerEnvRequest): Promise<BrokerTokenIssued | null> {
    const base = deps.baseUrl()
    if (!base) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 3000)
    try {
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(request.companyId)}/me/broker-tokens`, {
        method: 'POST',
        headers: { Cookie: deps.cookies().join('; '), 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: request.conversationId.slice(0, 200), department: request.department ?? null }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // 404 from a server without the broker: the same as "off".
        if (res.status !== 404) log.warn(`[broker] token for ${request.companyId}: HTTP ${res.status}; no keys this turn`)
        return null
      }
      const data = ((await res.json()) as { data?: BrokerTokenIssued }).data
      return data && typeof data.enabled === 'boolean' && Array.isArray(data.services) && Array.isArray(data.unavailable) ? data : null
    } catch {
      log.warn(`[broker] token for ${request.companyId}: the server could not be reached; no keys this turn`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async envFor(request) {
      const key = `${request.companyId}\0${request.conversationId}\0${request.department ?? ''}`
      const server = deps.baseUrl()
      let entry = cache.get(key)
      if (!entry || entry.server !== server || entry.expiresMs - now() < REFRESH_MARGIN_MS) {
        const issued = await issue(request)
        if (!issued) return {}
        entry = { issued, server, expiresMs: issued.expiresAt ? Date.parse(issued.expiresAt) : now() + REFRESH_MARGIN_MS + 60_000 }
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!)
        cache.delete(key)
        cache.set(key, entry)
      }
      return brokerEnv(server, entry.issued, request.reservedServices ?? [])
    },
    clear() {
      cache.clear()
    },
  }
}
