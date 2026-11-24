/**
 * The request log: one line per request on stdout, shared by every company on
 * the server, so it holds only what troubleshooting needs and nothing a
 * member wrote (2026-10-31; it replaced hono/logger, which printed the URL
 * with its query — file paths, folder names, search terms, private-folder
 * names, a relay token in `?key=`).
 *
 *   [http] <request id> <METHOD> <route pattern> <status> <ms>ms db=<ms> [git=<ms>] [ext=<ms>] [company=<id>] [user=<id>] [<param>=<id> …] [app=<build>]
 *
 * - The route pattern as registered (`/api/companies/:companyId/files/content`),
 *   never the URL; never the query string.
 * - The request id is new for each request and returned in `X-Request-Id`, so
 *   support can find a member's request in the log.
 * - Company and user are opaque ids (never names or emails). Other route
 *   parameters are printed only when listed in OPAQUE_PARAMS and shaped like
 *   an id; anything else is left out (an invitation `:token` is a secret).
 *
 * - db / git / ext: where the time went (stage 0 of reducing the apps' polling,
 *   2026-11-19). Each is the time, in ms with two decimals, during which at least
 *   one operation of that kind started by this request was running — a union of
 *   intervals, so overlapping operations (two git processes at once, a
 *   statement inside a transaction) count once. db: inside better-sqlite3
 *   (prepare, statements, exec, pragma, whole transactions; synchronous, so it
 *   is also time the event loop was blocked). git: a git process of this request
 *   running. ext: waiting for another service's response headers (the relay's
 *   way out). An operation still running when the line is written counts until
 *   then (git-http's http-backend streams after its headers). git / ext are
 *   printed only when the request used them. Reported at the I/O boundaries
 *   through the OperationMetrics port (`requestOperations`).
 * - app: the desktop app's build (X-ACB-Client-Version), only when it parses as
 *   one; any other value is left out.
 *
 * Detailed per-company history belongs in the per-company, access-controlled
 * records (agent_events, broker_history, push_rejections…), not here.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import type { MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import { parseClientVersion } from '../../shared/core/client-version'
import type { OperationCategory, OperationMetrics } from '../ports/operation-metrics'

export const REQUEST_ID_HEADER = 'X-Request-Id'

/** Busy time of one kind of operation: the union of its intervals (nested or parallel ones count once). */
interface Busy {
  active: number
  since: number
  total: number
}

const newBusy = (): Busy => ({ active: 0, since: 0, total: 0 })
const CATEGORIES: readonly OperationCategory[] = ['db', 'git', 'ext']
type BusyByCategory = Record<OperationCategory, Busy>
const newBusyByCategory = (): BusyByCategory => ({ db: newBusy(), git: newBusy(), ext: newBusy() })

function busyUntil(b: Busy, now: number): number {
  return b.total + (b.active > 0 ? now - b.since : 0)
}

interface RequestState {
  id: string
  busy: BusyByCategory
}

// The request being handled: its id for error lines printed further down
// (lib/error-log.ts), its operations' time for its own line.
const currentRequest = new AsyncLocalStorage<RequestState>()

/** The id of the request this code runs for (also after awaits and setImmediate), if any. */
export function currentRequestId(): string | undefined {
  return currentRequest.getStore()?.id
}

// The whole server's, for the per-minute load line (lib/load-log.ts): requests
// logged and operations' busy time since the last take, requests or not.
let serverRequests = 0
const serverBusy = newBusyByCategory()

/**
 * The OperationMetrics port (ports/operation-metrics.ts): adds an operation to
 * the request it started in (if any) and to the server's totals. A few
 * performance.now() calls; nothing about the operation itself is kept.
 */
export const requestOperations: OperationMetrics = {
  start(category) {
    const now = performance.now()
    const mine = currentRequest.getStore()?.busy[category]
    const all = serverBusy[category]
    if (all.active++ === 0) all.since = now
    if (mine && mine.active++ === 0) mine.since = now
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const end = performance.now()
      if (--all.active === 0) all.total += end - all.since
      if (mine && --mine.active === 0) mine.total += end - mine.since
    }
  },
}

export interface ServerLoadCounters {
  requests: number
  /** Busy ms per category since the last take (union over the whole server). */
  busyMs: Record<OperationCategory, number>
}

/** The server's counters since the last call, which starts the next period. */
export function takeServerLoadCounters(): ServerLoadCounters {
  const now = performance.now()
  const busyMs = { db: 0, git: 0, ext: 0 }
  for (const category of CATEGORIES) {
    const b = serverBusy[category]
    busyMs[category] = busyUntil(b, now)
    b.total = 0
    if (b.active > 0) b.since = now
  }
  const requests = serverRequests
  serverRequests = 0
  return { requests, busyMs }
}

/** db always, git / ext when used: `db=1.25`. */
function operationFields(busy: BusyByCategory, now: number): string[] {
  const fields: string[] = []
  for (const category of CATEGORIES) {
    const ms = busyUntil(busy[category], now)
    if (category === 'db' || ms > 0) fields.push(`${category}=${ms.toFixed(2)}`)
  }
  return fields
}

const APP_VERSION_HEADER = 'X-ACB-Client-Version'

/** The app build to print: only a value that parses as one (its characters are [0-9A-Za-z.+-]). */
export function appBuildField(raw: string | undefined): string[] {
  if (!raw || raw.length > 80) return []
  const parsed = parseClientVersion(raw)
  return parsed ? [`app=${parsed.raw}`] : []
}

/** Route parameters that hold opaque ids (or a service name), safe to print. */
const OPAQUE_PARAMS = new Set([
  'companyId', 'company', 'id', 'userId', 'ruleId', 'scopeId', 'stopId', 'keyId', 'tokenId',
  'invitationId', 'repo', 'service', 'ticketId', 'itemId', 'deviceId',
])

/** What an id looks like; any other value (a name, a path, Japanese text) is not printed. */
const ID_SHAPE = /^[A-Za-z0-9._-]{1,80}$/

// The signed-in user of a request, noted by whoever authenticated it
// (lib/auth.ts getUserFromRequest, git-http's token check).
const usersByRequest = new WeakMap<Request, string>()

export function noteRequestUser(request: Request, userId: string): void {
  usersByRequest.set(request, userId)
}

/** The company a route is about: `:companyId` (also `/api/companies/:companyId`), or a git repository `<companyId>.git`. */
function companyOf(pattern: string, params: Record<string, string>): string | undefined {
  if (params.companyId) return params.companyId
  if (params.company) return params.company
  if (pattern.startsWith('/api/git-http/:repo/') && params.repo) return params.repo.replace(/\.git$/, '')
  return undefined
}

/** The log line's fields after the duration, each `key=value` with an id-shaped value. */
export function describeRequest(pattern: string, params: Record<string, string>, userId: string | undefined): string[] {
  const fields: string[] = []
  const company = companyOf(pattern, params)
  if (company && ID_SHAPE.test(company)) fields.push(`company=${company}`)
  if (userId && ID_SHAPE.test(userId)) fields.push(`user=${userId}`)
  for (const [key, value] of Object.entries(params)) {
    if (!OPAQUE_PARAMS.has(key) || !ID_SHAPE.test(value)) continue
    if (value === company && (key === 'companyId' || key === 'company' || key === 'id' || key === 'repo')) continue
    fields.push(`${key}=${value}`)
  }
  return fields
}

export function requestLog(print: (line: string) => void = line => console.log(line)): MiddlewareHandler {
  return async (c, next) => {
    const id = randomUUID()
    const started = performance.now()
    const state: RequestState = { id, busy: newBusyByCategory() }
    c.header(REQUEST_ID_HEADER, id)
    try {
      await currentRequest.run(state, () => next())
    } finally {
      // The route that answered; middleware (app.use: method ALL) answering
      // means no route did (unknown path, CORS preflight).
      const answered = matchedRoutes(c)[c.req.routeIndex]
      const route = answered && answered.method !== 'ALL' ? answered.path : '(no route)'
      let params: Record<string, string> = {}
      try {
        if (answered && answered.method !== 'ALL') params = c.req.param() as Record<string, string>
      } catch {
        params = {}
      }
      const now = performance.now()
      const ms = Math.round(now - started)
      const operations = operationFields(state.busy, now)
      const fields = describeRequest(route, params, usersByRequest.get(c.req.raw))
      // A response a handler built itself (git-http, Better Auth) does not carry it yet.
      if (!c.res.headers.get(REQUEST_ID_HEADER)) {
        try {
          const headers = new Headers(c.res.headers)
          headers.set(REQUEST_ID_HEADER, id)
          c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers })
        } catch { /* the log line still carries the id */ }
      }
      serverRequests++
      print(['[http]', id, c.req.method, route, String(c.res.status), `${ms}ms`, ...operations, ...fields, ...appBuildField(c.req.header(APP_VERSION_HEADER))].join(' '))
    }
  }
}
