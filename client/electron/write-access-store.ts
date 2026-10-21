/**
 * Per-company cache of the member's write access
 * (GET /api/companies/:companyId/me/write-access, see shared/write-access.ts).
 *
 * Refreshed when the renderer opens a company (app start), after every
 * successful sync, and when a chat turn starts. Uses the server's ETag, so a
 * refresh that changes nothing costs a 304. A failed refresh keeps the last
 * answer; with no answer at all the company's access is unknown and the chat
 * guard blocks nothing (the push check and the WRITE_DENIED recovery remain).
 */
import { isWriteAccess, type WriteAccess } from '../shared/write-access'

export interface WriteAccessStoreDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
  onChange?: (companyId: string, access: WriteAccess) => void
  log?: Pick<Console, 'warn' | 'log'>
}

export interface WriteAccessStore {
  get(companyId: string): WriteAccess | undefined
  /** Fetch now (deduplicated per company); resolves to the cached value afterwards. */
  refresh(companyId: string, options?: { timeoutMs?: number }): Promise<WriteAccess | undefined>
  clear(): void
}

export function createWriteAccessStore(deps: WriteAccessStoreDeps): WriteAccessStore {
  const cache = new Map<string, WriteAccess>()
  const inflight = new Map<string, Promise<WriteAccess | undefined>>()
  const log = deps.log ?? console
  const doFetch = deps.fetch ?? fetch

  async function load(companyId: string): Promise<WriteAccess | undefined> {
    const base = deps.baseUrl()
    if (!base) return cache.get(companyId)
    const cached = cache.get(companyId)
    try {
      const headers: Record<string, string> = { Cookie: deps.cookies().join('; ') }
      if (cached) headers['If-None-Match'] = `"${cached.version}"`
      const res = await doFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/me/write-access`, { headers })
      if (res.status === 304) return cached
      if (!res.ok) {
        log.warn(`[write-access] ${companyId}: HTTP ${res.status}; ${cached ? 'keeping the cached answer' : 'unknown, the chat will not block edits'}`)
        return cached
      }
      const body = await res.json() as { data?: unknown }
      if (!isWriteAccess(body?.data)) {
        log.warn(`[write-access] ${companyId}: unexpected response; ${cached ? 'keeping the cached answer' : 'unknown, the chat will not block edits'}`)
        return cached
      }
      const access = body.data
      cache.set(companyId, access)
      if (!cached || cached.version !== access.version) deps.onChange?.(companyId, access)
      return access
    } catch (error) {
      log.warn(`[write-access] ${companyId}: ${error instanceof Error ? error.message : String(error)}; ${cached ? 'keeping the cached answer' : 'unknown, the chat will not block edits'}`)
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
      // The caller waits at most timeoutMs; the fetch itself keeps going and
      // updates the cache when it lands.
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        pending,
        new Promise<WriteAccess | undefined>(resolve => { timer = setTimeout(() => resolve(cache.get(companyId)), timeoutMs) }),
      ]).finally(() => clearTimeout(timer))
    },
    clear() { cache.clear() },
  }
}
