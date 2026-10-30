/**
 * Per-company cache of the member's AI policy (GET /api/companies/:id/me/agent-policy):
 * the AI sandbox (「AI の囲い」, agent-sandbox.md) and the emergency stop (M2,
 * agent-stop.md). Refreshed at each chat turn with a short budget, every 60 s
 * and when the push channel announces a new version; the server's ETag makes an
 * unchanged answer a 304. A failed refresh keeps the last answer.
 *
 * - Sandbox: memory only (this app run); with no answer at all the sandbox
 *   stays off for that turn (logged).
 * - Stop: the last stop part received is also kept on disk per account and
 *   company (`<dir>/<user>/<company>.json`, 0600), so a restart while offline
 *   still knows it. Never received (no answer, an older server without `stop`)
 *   = unknown → the app stops nothing (owner decision §6 #5).
 *
 * Every request says the app follows the stop (X-ACB-Agent-Stop), which is how
 * the admin counts the apps that do not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseAgentSandboxSettings } from '../../../shared/core/agent-sandbox'
import type { AgentPolicy, AgentSandboxPolicy } from '../../../shared/types/agent-sandbox'
import { AGENT_STOP_SUPPORT_HEADER, parseAgentStopPolicy, type AgentStopPolicy } from '../../shared/agent-stop'

export interface AgentPolicyStoreDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
  /** The signed-in account (session.ts); the stop is kept on disk only under a known account. */
  userId?: () => string | null
  /** Where the last stop received is kept (<userData>/agent-policy). */
  dir?: () => string
}

export interface AgentPolicyStore {
  get(companyId: string): AgentPolicy | undefined
  /** Fetch now (deduplicated per company); resolves to the cached value, waiting at most `timeoutMs`. */
  refresh(companyId: string, options?: { timeoutMs?: number }): Promise<AgentPolicy | undefined>
  /** The last stop received for this company (memory, else disk); undefined = never received. */
  stop(companyId: string): AgentStopPolicy | undefined
  /** Companies whose last received stop stops the whole AI. */
  stoppedCompanies(): string[]
  /** Called when a company's received stop changes (not for one loaded from disk). */
  onStopChange(listener: (companyId: string, stop: AgentStopPolicy | undefined) => void): void
  /** Sign-out: forget the memory copy (the files stay, per account). */
  clear(): void
}

/** The answer's `data`, validated (the sandbox part re-checked with the shared rules). */
export function parseAgentPolicy(data: unknown): AgentPolicy | undefined {
  if (!data || typeof data !== 'object') return undefined
  const value = data as { version?: unknown; sandbox?: unknown; stop?: unknown }
  if (typeof value.version !== 'string' || !value.version) return undefined
  const sandbox = parseAgentSandboxSettings(value.sandbox)
  if ('error' in sandbox) return undefined
  const source = (value.sandbox as { source?: unknown }).source === 'member' ? 'member' : 'company'
  const policy: AgentSandboxPolicy = { ...sandbox.value, source }
  const stop = parseAgentStopPolicy(value.stop)
  return { version: value.version, sandbox: policy, ...(stop ? { stop } : {}) }
}

const sameStop = (a: AgentStopPolicy | undefined, b: AgentStopPolicy | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function createAgentPolicyStore(deps: AgentPolicyStoreDeps): AgentPolicyStore {
  const cache = new Map<string, AgentPolicy>()
  const inflight = new Map<string, Promise<AgentPolicy | undefined>>()
  /** `${user}\0${company}` → the last stop received (undefined: an answer without one). */
  const stops = new Map<string, AgentStopPolicy | undefined>()
  const log = deps.log ?? console
  const doFetch = deps.fetch ?? fetch
  const listeners: Array<(companyId: string, stop: AgentStopPolicy | undefined) => void> = []
  /** Accounts whose kept stops were read from disk this run. */
  const scanned = new Set<string>()

  const user = () => deps.userId?.() ?? null
  const keyOf = (companyId: string) => `${user() ?? ''}\0${companyId}`
  const fileOf = (companyId: string): string | undefined => {
    const id = user()
    const dir = deps.dir?.()
    if (!id || !dir) return undefined
    return path.join(dir, encodeURIComponent(id), `${encodeURIComponent(companyId)}.json`)
  }
  const readDisk = (companyId: string): AgentStopPolicy | undefined => {
    const file = fileOf(companyId)
    if (!file) return undefined
    try { return parseAgentStopPolicy((JSON.parse(fs.readFileSync(file, 'utf8')) as { stop?: unknown }).stop) } catch { return undefined }
  }
  const writeDisk = (companyId: string, stop: AgentStopPolicy | undefined) => {
    const file = fileOf(companyId)
    if (!file) return
    try {
      if (!stop) { fs.rmSync(file, { force: true }); return }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ stop, at: new Date().toISOString() }), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (error) {
      log.warn(`[agent-policy] ${companyId}: the stop could not be kept on disk (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }
  const stopOf = (companyId: string): AgentStopPolicy | undefined => {
    const key = keyOf(companyId)
    if (stops.has(key)) return stops.get(key)
    const loaded = readDisk(companyId)
    stops.set(key, loaded)
    return loaded
  }
  const receivedStop = (companyId: string, stop: AgentStopPolicy | undefined) => {
    const before = stopOf(companyId)
    stops.set(keyOf(companyId), stop)
    if (sameStop(before, stop)) return
    writeDisk(companyId, stop)
    for (const listener of listeners) {
      try { listener(companyId, stop) } catch (error) {
        log.warn(`[agent-policy] ${companyId}: applying the stop failed (${error instanceof Error ? error.message : 'unknown'})`)
      }
    }
  }

  async function load(companyId: string): Promise<AgentPolicy | undefined> {
    const base = deps.baseUrl()
    const cached = cache.get(companyId)
    if (!base) return cached
    const keep = cached ? 'keeping the last policy' : 'unknown, the AI sandbox stays off this turn'
    try {
      const headers: Record<string, string> = { Cookie: deps.cookies().join('; '), [AGENT_STOP_SUPPORT_HEADER]: '1' }
      if (cached) headers['If-None-Match'] = `"${cached.version}"`
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/agent-policy`, { headers, redirect: 'error' })
      if (res.status === 304) return cached
      if (!res.ok) {
        // 404 from an older server that has no policy yet: the same as "off".
        log.warn(`[agent-policy] ${companyId}: HTTP ${res.status}; ${keep}`)
        return cached
      }
      const data = (await res.json() as { data?: unknown })?.data
      const policy = parseAgentPolicy(data)
      if (!policy) {
        log.warn(`[agent-policy] ${companyId}: unexpected response; ${keep}`)
        // The stop part on its own still counts: a stop must not wait for a sandbox setting this app cannot read.
        const stop = parseAgentStopPolicy((data as { stop?: unknown } | undefined)?.stop)
        if (stop) receivedStop(companyId, stop)
        return cached
      }
      cache.set(companyId, policy)
      receivedStop(companyId, policy.stop)
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
    stop: stopOf,
    stoppedCompanies() {
      // Stops kept from an earlier run count before any company was asked about.
      const id = user()
      const dir = deps.dir?.()
      if (id && dir && !scanned.has(id)) {
        scanned.add(id)
        try {
          for (const name of fs.readdirSync(path.join(dir, encodeURIComponent(id)))) {
            if (!name.endsWith('.json')) continue
            try { stopOf(decodeURIComponent(name.slice(0, -'.json'.length))) } catch { /* unreadable name */ }
          }
        } catch { /* nothing kept */ }
      }
      const prefix = `${user() ?? ''}\0`
      return [...stops].filter(([key, stop]) => key.startsWith(prefix) && stop?.all).map(([key]) => key.slice(prefix.length))
    },
    onStopChange(listener) { listeners.push(listener) },
    clear() { cache.clear(); stops.clear(); scanned.clear() },
  }
}
