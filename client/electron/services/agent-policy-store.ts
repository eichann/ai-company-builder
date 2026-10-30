/**
 * Per-company cache of the member's AI policy (GET /api/companies/:id/me/agent-policy):
 * today the AI sandbox (「AI の囲い」, agent-sandbox.md); the emergency stop
 * (M2) joins it. Refreshed at each chat turn with a short budget; the server's
 * ETag makes an unchanged answer a 304. A failed refresh keeps the last answer
 * (memory only, this app run); with no answer at all the policy is unknown and
 * the sandbox stays off for that turn (logged).
 */
import { parseAgentSandboxSettings } from '../../../shared/core/agent-sandbox'
import type { AgentPolicy, AgentSandboxPolicy } from '../../../shared/types/agent-sandbox'

export interface AgentPolicyStoreDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

export interface AgentPolicyStore {
  get(companyId: string): AgentPolicy | undefined
  /** Fetch now (deduplicated per company); resolves to the cached value, waiting at most `timeoutMs`. */
  refresh(companyId: string, options?: { timeoutMs?: number }): Promise<AgentPolicy | undefined>
  clear(): void
}

/** The answer's `data`, validated (the sandbox part re-checked with the shared rules). */
export function parseAgentPolicy(data: unknown): AgentPolicy | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = data as { version?: unknown; sandbox?: unknown }
  if (typeof value.version !== 'string' || !value.version) return undefined
  const sandbox = parseAgentSandboxSettings(value.sandbox)
  if ('error' in sandbox) return undefined
  const source = (value.sandbox as { source?: unknown }).source === 'member' ? 'member' : 'company'
  const policy: AgentSandboxPolicy = { ...sandbox.value, source }
  return { version: value.version, sandbox: policy }
}

export function createAgentPolicyStore(deps: AgentPolicyStoreDeps): AgentPolicyStore {
  const cache = new Map<string, AgentPolicy>()
  const inflight = new Map<string, Promise<AgentPolicy | undefined>>()
  const log = deps.log ?? console
  const doFetch = deps.fetch ?? fetch

  async function load(companyId: string): Promise<AgentPolicy | undefined> {
    const base = deps.baseUrl()
    const cached = cache.get(companyId)
    if (!base) return cached
    const keep = cached ? 'keeping the last policy' : 'unknown, the AI sandbox stays off this turn'
    try {
      const headers: Record<string, string> = { Cookie: deps.cookies().join('; ') }
      if (cached) headers['If-None-Match'] = `"${cached.version}"`
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/agent-policy`, { headers })
      if (res.status === 304) return cached
      if (!res.ok) {
        // 404 from an older server that has no policy yet: the same as "off".
        log.warn(`[agent-policy] ${companyId}: HTTP ${res.status}; ${keep}`)
        return cached
      }
      const policy = parseAgentPolicy((await res.json() as { data?: unknown })?.data)
      if (!policy) { log.warn(`[agent-policy] ${companyId}: unexpected response; ${keep}`); return cached }
      cache.set(companyId, policy)
      return policy
    } catch (error) {
      log.warn(`[agent-policy] ${companyId}: ${error instanceof Error ? error.message : 'request failed'}; ${keep}`)
      return cached
    }
  }

  return {
    get: companyId => cache.get(companyId),
    refresh(companyId, options) {
      let pending = inflight.get(companyId)
      if (!pending) {
        pending = load(companyId).finally(() => inflight.delete(companyId))
        inflight.set(companyId, pending)
      }
      const timeoutMs = options?.timeoutMs
      if (!timeoutMs) return pending
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        pending,
        new Promise<AgentPolicy | undefined>(resolve => { timer = setTimeout(() => resolve(cache.get(companyId)), timeoutMs) }),
      ]).finally(() => clearTimeout(timer))
    },
    clear() { cache.clear() },
  }
}
