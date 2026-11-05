/**
 * The connector (「つなぎ役」, milestone 3 P5, `.claude/rules/plugins.md`): the
 * core's one component that talks to an outside system for a connector
 * plugin. A package holds no program; this module makes exactly the calls
 * its declaration lists — the endpoint's method and path template, `{id}`
 * filled with a plain outside id, under the declaration's one `base_url`
 * host — and nothing else (no other host, path, method or redirect).
 *
 * The key comes from the key broker's vault (`reveal`) just before the
 * request and goes only into the service's credential header; it is never
 * logged, returned, stored or put in an error. Answers are read as JSON
 * (≤ 5 MB); an error answer's body is dropped (it could echo what was sent).
 *
 * Wire format: HubSpot's CRM API (search bodies `{ filterGroups, properties,
 * sorts, limit, after }`, answers `{ results, paging.next.after }`, objects
 * `{ id, properties, updatedAt, associations }`, account details
 * `{ portalId }`). A system with another shape needs another connector kind
 * in the core, not conditions in a declaration (owner rule §8-1).
 *
 * Pace and retries (HubSpot's limits: 100 requests per 10 s per key on Free
 * / Starter, search 5 per second; HubSpot does not say how long to wait after
 * a 429): per company and connection at most 80 requests per 10 s and 4
 * searches per second (headroom for scripts sharing the key), waiting rather
 * than failing. Retries depend on the kind of call (review §5.6):
 * - reads (GET, search): after a 429, a 5xx or a failure before anything was
 *   sent — wait (Retry-After when given, else 1 s, 2 s, 4 s), at most 3
 *   retries and 15 s of waiting in all;
 * - writes (update, create, archive): never retried here. A 429 / 5xx is
 *   returned as is; a connection lost after sending is `unknown` — the
 *   caller re-reads the outside value to decide, and never re-sends a create.
 * Before every attempt — the first, and after every wait — `precheck` is
 * asked again (stops, membership, policy: review §6.5); a refusal there
 * sends nothing.
 *
 * A contract-3 connector's declared calls (`callDeclared`, plugins.md "Contract
 * 3") go the same way, with the key in the header its `auth` names, the actor's
 * headers, and the pace of its `limits`; an error answer gives only its top-level
 * `code`, the rest is dropped as above.
 */
import { checkUpstreamPath } from '../../shared/core/upstream-path'
import { EXTERNAL_ID_RE, type PluginEndpoint, type PluginEndpointName } from '../../shared/core/plugins'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'
import type { ActivePlugin } from './plugins'

/** One outside id as it may appear in a path (HubSpot's are digits). */
export { EXTERNAL_ID_RE }

export type ConnectorEndpoint = PluginEndpointName | 'account_info'

export interface ConnectorCall {
  endpoint: ConnectorEndpoint
  /** The declaration's object (not for account_info). */
  object?: string
  /** Fills `{id}`. */
  id?: string
  query?: Record<string, string | string[]>
  body?: unknown
}

/** One contract-3 call: a declared path with `{id}` not yet filled, the query or the body, and who acted. */
export interface DeclaredCall {
  method: 'GET' | 'POST'
  path: string
  id?: string
  query?: Record<string, string>
  body?: unknown
  /** The member header's value; the address only when the member's own, verified, and the service wants one. */
  actor: { member: string; email: string | null }
  /** Told right before each attempt goes out: what the access log needs (a call refused before this reached nobody). */
  onSend?: () => void
}

export type ConnectorResult =
  | { ok: true; status: number; body: unknown }
  | {
    ok: false
    /**
     * not-sent: nothing left ACB (a precheck refused, no key, a bad id, the
     *   way out failed before connecting);
     * unknown: a write was sent and its answer did not arrive (it may have
     *   been applied);
     * refused: the outside system answered 4xx (not 429);
     * rate-limited: 429 (reads: after the retries);
     * server-error: 5xx (reads: after the retries).
     */
    kind: 'not-sent' | 'unknown' | 'refused' | 'rate-limited' | 'server-error'
    status?: number
    /** A fixed word for logs and answers (never a value, key or body). */
    reason: string
    /** A declared call's error answer: its top-level `code`, a plain word. */
    code?: string
  }

export interface PluginConnectorDeps {
  upstream: UpstreamClient
  /** The company key's value (key broker vault), or null. */
  reveal: (companyId: string, keyId: string) => Promise<string | null>
  /** How the service's key travels: the header and its value for a key. */
  credential: (companyId: string, service: string) => { header: string; value: (key: string) => string } | null
  sleep: (ms: number) => Promise<void>
  nowMs: () => number
}

const READ_ENDPOINTS: readonly ConnectorEndpoint[] = ['get', 'search', 'properties_list', 'stages_list', 'account_info']
const MAX_ANSWER_BYTES = 5 * 1024 * 1024
const HEADERS_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3
const MAX_WAIT_MS = 15_000
const RETRY_AFTER_CAP_MS = 10_000
const PER_TEN_SECONDS = 80
const SEARCH_PER_SECOND = 4
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,100}$/

async function readBody(body: AsyncIterable<Uint8Array>): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > MAX_ANSWER_BYTES) return null
    chunks.push(chunk)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/**
 * Failures of the way out that certainly happen before the request leaves
 * (`connect` is any socket error, also after sending: not in this list).
 */
const BEFORE_SENDING: readonly UpstreamFailure[] = ['private-address', 'dns', 'tls', 'practice-real-secret']

export function createPluginConnector(deps: PluginConnectorDeps) {
  /** Recent request times per company × connection (and searches separately). */
  const recent = new Map<string, number[]>()

  /** Null: the declaration's `limits` would keep this call waiting longer than a read may; nothing is sent. */
  async function pace(key: string, isSearch: boolean, perMinute: number | null = null): Promise<number | null> {
    let waited = 0
    for (;;) {
      const now = deps.nowMs()
      if (perMinute !== null) {
        const minute = (recent.get(`${key}|minute`) ?? []).filter(t => t > now - 60_000)
        recent.set(`${key}|minute`, minute)
        if (minute.length >= perMinute) {
          const wait = minute[0] + 60_000 - now
          if (waited + wait > MAX_WAIT_MS) return null
          await deps.sleep(wait)
          waited += wait
          continue
        }
      }
      const all = (recent.get(key) ?? []).filter(t => t > now - 10_000)
      const searches = (recent.get(`${key}|search`) ?? []).filter(t => t > now - 1_000)
      recent.set(key, all)
      recent.set(`${key}|search`, searches)
      const wait = all.length >= PER_TEN_SECONDS ? all[0] + 10_000 - now
        : isSearch && searches.length >= SEARCH_PER_SECOND ? searches[0] + 1_000 - now : 0
      if (wait <= 0) {
        all.push(now)
        if (isSearch) searches.push(now)
        if (perMinute !== null) recent.get(`${key}|minute`)!.push(now)
        return waited
      }
      await deps.sleep(wait)
      waited += wait
    }
  }

  function pathOf(plugin: ActivePlugin, call: ConnectorCall): string | null {
    const m = plugin.manifest
    let endpoint: PluginEndpoint | undefined
    if (call.endpoint === 'account_info') endpoint = m.accountInfo ?? undefined
    else endpoint = call.object ? m.objects[call.object]?.endpoints[call.endpoint] : undefined
    if (!endpoint) return null
    let path = endpoint.path
    if (path.includes('{id}')) {
      if (typeof call.id !== 'string' || !EXTERNAL_ID_RE.test(call.id)) return null
      path = path.replace('{id}', call.id)
    } else if (call.id !== undefined) return null
    const full = `${m.baseUrl.basePath}${path}`
    if (!checkUpstreamPath(full)) return null
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(call.query ?? {})) for (const one of Array.isArray(v) ? v : [v]) q.append(k, one)
    const qs = q.toString()
    return qs ? `${full}?${qs}` : full
  }

  function declaredPath(plugin: ActivePlugin, call: DeclaredCall): string | null {
    let path = call.path
    if (path.includes('{id}')) {
      if (typeof call.id !== 'string' || !EXTERNAL_ID_RE.test(call.id)) return null
      path = path.replace('{id}', call.id)
    } else if (call.id !== undefined) return null
    const full = `${plugin.manifest.baseUrl.basePath}${path}`
    if (!checkUpstreamPath(full)) return null
    const qs = new URLSearchParams(call.query ?? {}).toString()
    return qs ? `${full}?${qs}` : full
  }

  /** The attempts of one call: pace, precheck, the key revealed right then, the answer, retries for reads. */
  async function attempts(companyId: string, plugin: ActivePlugin, r: {
    method: string; path: string; isRead: boolean; isSearch: boolean; perMinute: number | null; body: unknown
    credential: { header: string; value: (key: string) => string }; headers: Record<string, string>; errorCodes: boolean; onSend?: () => void
  }, precheck: () => Promise<string | null>): Promise<ConnectorResult> {
    const { method, path, isRead, credential } = r
    const body = r.body === undefined ? null : new TextEncoder().encode(JSON.stringify(r.body))
    let waitedInAll = 0
    for (let attempt = 0; ; attempt++) {
      const paced = await pace(`${companyId}|${plugin.connectorId}|${plugin.connectionId}`, r.isSearch, r.perMinute)
      if (paced === null) return { ok: false, kind: 'rate-limited', reason: 'rate-limited' }
      waitedInAll += paced
      const stop = await precheck()
      if (stop) return { ok: false, kind: 'not-sent', reason: stop }
      const key = await deps.reveal(companyId, plugin.keyId)
      if (!key) return { ok: false, kind: 'not-sent', reason: 'no-key' }
      const headers: Record<string, string> = { accept: 'application/json', ...r.headers, [credential.header]: credential.value(key), 'accept-encoding': 'identity' }
      if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.byteLength) }
      const controller = new AbortController()
      r.onSend?.()
      const sent = await deps.upstream.send({
        host: plugin.manifest.baseUrl.host, method, path, headers,
        body: body ? (async function* () { yield body })() : null,
        allowPrivateHosts: [], signal: controller.signal, headersTimeoutMs: HEADERS_TIMEOUT_MS,
      })
      let retryAfterMs: number | null = null
      let failure: ConnectorResult
      if (!sent.ok) {
        const before = BEFORE_SENDING.includes(sent.reason)
        failure = { ok: false, kind: before || isRead ? 'not-sent' : 'unknown', reason: sent.reason }
        // Writes are never retried: nothing sent, or perhaps applied (`unknown`).
        if (!isRead) return failure
      } else {
        const { status } = sent.response
        const bytes = await readBody(sent.response.body).catch(() => null)
        if (status >= 200 && status < 300) {
          if (status === 204) return { ok: true, status, body: null }
          if (!bytes) return isRead ? { ok: false, kind: 'server-error', status, reason: 'unreadable-answer' } : { ok: false, kind: 'unknown', status, reason: 'unreadable-answer' }
          try {
            return { ok: true, status, body: bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder().decode(bytes)) as unknown }
          } catch {
            return isRead ? { ok: false, kind: 'server-error', status, reason: 'unreadable-answer' } : { ok: false, kind: 'unknown', status, reason: 'unreadable-answer' }
          }
        }
        const code = r.errorCodes && bytes ? errorCodeOf(bytes) : undefined
        const coded = code ? { code } : {}
        if (status === 429) {
          failure = { ok: false, kind: 'rate-limited', status, reason: 'rate-limited', ...coded }
          const ra = Number(sent.response.headers.find(([n]) => n === 'retry-after')?.[1])
          if (Number.isFinite(ra) && ra >= 0) retryAfterMs = Math.min(ra * 1000, RETRY_AFTER_CAP_MS)
        } else if (status >= 500) {
          failure = { ok: false, kind: 'server-error', status, reason: 'server-error', ...coded }
        } else {
          return { ok: false, kind: 'refused', status, reason: status === 401 ? 'key-rejected' : status === 403 ? 'not-permitted' : status === 404 ? 'not-found' : 'refused', ...coded }
        }
        // Writes are never retried here (their result may be known to the caller only by re-reading).
        if (!isRead) return failure
      }
      if (attempt >= MAX_RETRIES) return failure
      const wait = retryAfterMs ?? 1000 * 2 ** attempt
      if (waitedInAll + wait > MAX_WAIT_MS) return failure
      await deps.sleep(wait)
      waitedInAll += wait
    }
  }

  return {
    /**
     * One declared call. `precheck` runs right before every attempt; a
     * non-null answer stops it with nothing sent.
     */
    async call(companyId: string, plugin: ActivePlugin, call: ConnectorCall, precheck: () => Promise<string | null>): Promise<ConnectorResult> {
      const path = pathOf(plugin, call)
      if (!path) return { ok: false, kind: 'not-sent', reason: 'undeclared-call' }
      const method = call.endpoint === 'account_info' ? 'GET' : plugin.manifest.objects[call.object!].endpoints[call.endpoint as PluginEndpointName]!.method
      const credential = deps.credential(companyId, plugin.manifest.service)
      if (!credential) return { ok: false, kind: 'not-sent', reason: 'no-credential' }
      return attempts(companyId, plugin, {
        method, path, isRead: READ_ENDPOINTS.includes(call.endpoint), isSearch: call.endpoint === 'search', perMinute: null, body: call.body,
        credential, headers: {}, errorCodes: false,
      }, precheck)
    },

    /** One contract-3 read (`DeclaredCall`): the same way out, with the declaration's `auth`, `actor` and `limits`. */
    async callDeclared(companyId: string, plugin: ActivePlugin, call: DeclaredCall, precheck: () => Promise<string | null>): Promise<ConnectorResult> {
      const path = declaredPath(plugin, call)
      if (!path) return { ok: false, kind: 'not-sent', reason: 'undeclared-call' }
      const { auth, actor, limits } = plugin.manifest.calling ?? {}
      if (!auth || !actor) return { ok: false, kind: 'not-sent', reason: 'no-credential' }
      if (!EXTERNAL_ID_RE.test(call.actor.member)) return { ok: false, kind: 'not-sent', reason: 'bad-actor' }
      const headers: Record<string, string> = { [actor.memberHeader.toLowerCase()]: call.actor.member }
      if (actor.emailHeader && call.actor.email) headers[actor.emailHeader.toLowerCase()] = call.actor.email
      return attempts(companyId, plugin, {
        method: call.method, path, isRead: true, isSearch: false, perMinute: limits?.perMinute ?? null, body: call.body,
        credential: { header: auth.header.toLowerCase(), value: key => (auth.format === 'bearer' ? `Bearer ${key}` : key) }, headers, errorCodes: true, onSend: call.onSend,
      }, precheck)
    },
  }
}

/** The top-level `code` of an error answer (plugins.md "Contract 3": one flat shape); anything else of it is dropped. */
function errorCodeOf(bytes: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown } | null
    return typeof parsed?.code === 'string' && ERROR_CODE_RE.test(parsed.code) ? parsed.code : undefined
  } catch {
    return undefined
  }
}

export type PluginConnector = ReturnType<typeof createPluginConnector>
