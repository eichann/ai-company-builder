/**
 * The fake portal (「練習用のつなぎ先」): a small Hono app with the data in memory
 * that behaves as a contract-3 service must (`plugins.md` "Contract 3": the
 * service conforms to ACB's rules, not the other way). Used by the server tests
 * (passed straight in) and on staging (`pnpm fake:portal`, `serve.ts`). Generic
 * on purpose: this is a public repository, so no real service's names are here;
 * a real package's paths reach these handlers through `aliases`.
 *
 * Test and staging code only: it lives under `server/tests/`, which the
 * production image never copies, and nothing in `server/src` may import it
 * (`tests/unit/layering.test.ts`).
 *
 * What it holds a client to, on every call: `Authorization: Bearer pat-fake-…`,
 * the actor header (an id, or `system`), an email header only in an address's
 * shape, `{id}` as `EXTERNAL_ID_RE`, a search as POST (personal data never in a
 * URL). Errors are one flat shape `{ code, summary, details? }`; every answer has
 * fixed fields, an unused one null.
 *
 * In front, like the load balancer before a real service (staging 2026-11-06),
 * `requireUserAgent` answers a request without a `User-Agent` with 403 and an
 * HTML page; `failNext({ status: 403, gateway: true })` does so once for any
 * request.
 *
 * Faults: `fail(...)` — a 429 with `Retry-After`, or a 500; `extraField(...)` — an
 * answer carrying a field nobody declared. `PORTAL_SEED.instructionLike` is a
 * person whose name is written to look like an instruction. `/__fake/*` does the
 * same over HTTP (`controlRoutes`).
 */
import { Hono, type Context } from 'hono'
import { defaultPortalSeed, type PortalPerson, type PortalSeed } from './seed'

export const FAKE_PORTAL_KEY_PREFIX = 'pat-fake-'
export const PORTAL_ACTOR_HEADER = 'x-acb-actor'
export const PORTAL_EMAIL_HEADER = 'x-acb-actor-email'
export const PORTAL_SCOPES = { read: 'read', sensitive: 'read.sensitive' } as const

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/
const DEFAULT_PER_MINUTE = 60

export interface FakePortalOptions {
  seed?: PortalSeed
  now?: () => number
  /** Where the API is mounted (a declared `base_url`'s path). Default `/api`. */
  basePath?: string
  /** Serve `/__fake/*` (faults over HTTP, for staging). Off by default. */
  controlRoutes?: boolean
  accountId?: string
  environment?: 'staging' | 'production'
  /** Requests per key per minute; omitted = none. `true` = 60. */
  rateLimit?: number | true
  /** A real package's path → this fake's path, `{id}` kept: `/a/{id}/b` → `/people/{id}/mail`. */
  aliases?: Record<string, string>
  /** A request without `User-Agent` is refused in front of the API: 403 with an HTML page. */
  requireUserAgent?: boolean
}

/** What a test may look at: what arrived, never compared to anything the fake was told to return. */
export interface PortalRequest {
  method: string
  path: string
  actor: string | null
  email: string | null
  authorization: string | null
  userAgent: string | null
  body: string
}

type Fault = { status: 429; retryAfter: number } | { status: 500 } | { status: 409; code: string } | { status: 403; gateway: true }

/** What a load balancer answers when it refuses: a page, not the API's JSON. */
const GATEWAY_403 = '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>'

export function createFakePortal(options: FakePortalOptions = {}) {
  const seed = options.seed ?? defaultPortalSeed()
  const now = options.now ?? Date.now
  const basePath = (options.basePath ?? '/api').replace(/\/+$/, '')
  const perMinute = options.rateLimit === true ? DEFAULT_PER_MINUTE : options.rateLimit ?? null
  const keys = new Map<string, Set<string>>()
  const requests: PortalRequest[] = []
  const faults: Fault[] = []
  const hits = new Map<string, number[]>()
  let extra: { name: string; value: string } | null = null
  let account: { accountId: string; environment: string } = { accountId: options.accountId ?? 'sample-account', environment: options.environment ?? 'staging' }

  const aliases = Object.entries(options.aliases ?? {}).map(([from, to]) => ({
    from: new RegExp(`^${from.split('{id}').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)')}$`),
    to,
  }))

  const app = new Hono()
  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 405 | 429 | 500, code: string, summary: string, details?: Record<string, string>) =>
    c.json({ code, summary, ...(details ? { details } : {}) }, status)
  const answer = (c: Context, body: Record<string, unknown>) => {
    c.header('Cache-Control', 'no-store')
    return c.json(extra ? { ...body, [extra.name]: extra.value } : body)
  }
  const person = (ref: string): PortalPerson | undefined => seed.people.find(p => p.person_ref === ref)
  const scopesOf = (c: Context) => keys.get(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '') ?? new Set<string>()
  const wants = (c: Context, flag: string) => c.req.query(flag) === '1'

  const api = new Hono()

  api.use('*', async (c, next) => {
    requests.push({
      method: c.req.method, path: new URL(c.req.url).pathname + new URL(c.req.url).search,
      actor: c.req.header(PORTAL_ACTOR_HEADER) ?? null, email: c.req.header(PORTAL_EMAIL_HEADER) ?? null,
      authorization: c.req.header('authorization') ?? null, userAgent: c.req.header('user-agent') ?? null, body: await c.req.raw.clone().text(),
    })
    const gateway = faults[0]?.status === 403 ? faults.shift() : undefined
    if (gateway || (options.requireUserAgent && !c.req.header('user-agent'))) return c.html(GATEWAY_403, 403)
    const auth = c.req.header('authorization') ?? ''
    const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (!keys.has(key)) return fail(c, 401, 'UNAUTHORIZED', '鍵がありません')
    const actor = c.req.header(PORTAL_ACTOR_HEADER)
    if (actor === undefined || !ID_RE.test(actor)) return fail(c, 400, 'INVALID_INPUT', '操作した人のヘッダーが要ります')
    const email = c.req.header(PORTAL_EMAIL_HEADER)
    if (email !== undefined && !EMAIL_RE.test(email)) return fail(c, 400, 'INVALID_INPUT', 'メールアドレスの形ではありません')
    const fault = faults.shift()
    if (fault?.status === 429) { c.header('Retry-After', String(fault.retryAfter)); return fail(c, 429, 'RATE_LIMITED', '呼び出しが多すぎます') }
    if (fault?.status === 500) return fail(c, 500, 'INTERNAL', '一時的なエラーです')
    if (fault?.status === 409) return c.json({ code: fault.code, summary: '状態が変わりました' }, 409)
    if (perMinute !== null) {
      const recent = (hits.get(key) ?? []).filter(t => t > now() - 60_000)
      if (recent.length >= perMinute) { c.header('Retry-After', '60'); return fail(c, 429, 'RATE_LIMITED', '呼び出しが多すぎます') }
      hits.set(key, [...recent, now()])
    }
    await next()
  })
  const validId = (c: Context) => ID_RE.test(c.req.param('id') ?? '')

  api.get('/account', c => answer(c, { account_id: account.accountId, environment: account.environment }))

  api.get('/people/search', c => { c.header('Allow', 'POST'); return fail(c, 405, 'METHOD_NOT_ALLOWED', '検索は POST です') })
  api.post('/people/search', async c => {
    const body = await c.req.json().catch(() => null) as { email?: unknown; name?: unknown } | null
    const byEmail = typeof body?.email === 'string'
    const byName = typeof body?.name === 'string'
    if (byEmail === byName) return fail(c, 400, 'INVALID_INPUT', 'email か name のどちらか1つです')
    const found = seed.people.filter(p => byEmail ? p.email.toLowerCase() === (body!.email as string).toLowerCase() : p.name.includes(body!.name as string))
    return answer(c, { results: found.map(p => ({ person_ref: p.person_ref, name: p.name, email_masked: `${p.email[0]}***@${p.email.split('@')[1]}` })) })
  })
  api.get('/people/:id/diagnosis', c => {
    if (!validId(c)) return fail(c, 400, 'INVALID_ID', '番号の形が違います')
    const p = person(c.req.param('id'))
    if (!p) return fail(c, 404, 'NOT_FOUND', 'ありません')
    return answer(c, { person_ref: p.person_ref, name: p.name, findings: p.findings, checked_at: new Date(now()).toISOString() })
  })
  api.get('/people/:id/mail', c => {
    if (!validId(c)) return fail(c, 400, 'INVALID_ID', '番号の形が違います')
    const p = person(c.req.param('id'))
    if (!p) return fail(c, 404, 'NOT_FOUND', 'ありません')
    const withBody = wants(c, 'include_body')
    if (withBody && !scopesOf(c).has(PORTAL_SCOPES.sensitive)) return fail(c, 403, 'SCOPE_REQUIRED', '本文には別の権限が要ります', { required_scope: PORTAL_SCOPES.sensitive })
    return answer(c, { person_ref: p.person_ref, mails: p.mails.map(m => ({ id: m.id, subject: m.subject, status: m.status, body: withBody ? m.body : null })) })
  })

  api.get('/pages', c => answer(c, { pages: seed.pages.map(({ id, title, viewer_url }) => ({ id, title, viewer_url })) }))
  api.post('/pages/search', async c => {
    const body = await c.req.json().catch(() => null) as { words?: unknown } | null
    if (typeof body?.words !== 'string' || body.words === '') return fail(c, 400, 'INVALID_INPUT', 'words が要ります')
    const words = body.words.split(/\s+/)
    const found = seed.pages.filter(p => words.every(w => p.title.includes(w) || p.markdown.includes(w)))
    return answer(c, { results: found.map(({ id, title, viewer_url }) => ({ id, title, viewer_url })) })
  })
  api.get('/pages/:id', c => {
    if (!validId(c)) return fail(c, 400, 'INVALID_ID', '番号の形が違います')
    const p = seed.pages.find(x => x.id === c.req.param('id'))
    if (!p) return fail(c, 404, 'NOT_FOUND', 'ありません')
    return answer(c, { ...p })
  })
  api.notFound(c => fail(c, 404, 'NOT_FOUND', 'ありません'))

  if (options.controlRoutes) {
    app.post('/__fake/rate-limit', async c => { const b = await c.req.json().catch(() => ({})) as { retryAfter?: number }; failNext({ status: 429, retryAfter: b.retryAfter ?? 1 }); return c.json({ ok: true }) })
    app.post('/__fake/server-error', c => { failNext({ status: 500 }); return c.json({ ok: true }) })
    app.post('/__fake/extra-field', async c => { const b = await c.req.json().catch(() => ({})) as { name?: string; value?: string }; extraField(b.name ?? 'undeclared_note', b.value ?? '宣言にない欄'); return c.json({ ok: true }) })
    app.post('/__fake/clear', c => { clearFaults(); return c.json({ ok: true }) })
  }
  app.route(basePath, api)

  /** `fetch` with a real package's paths moved to this fake's. */
  async function fetchWithAliases(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(`${basePath}/`)) {
      const inner = url.pathname.slice(basePath.length)
      for (const a of aliases) {
        const m = a.from.exec(inner)
        if (!m) continue
        url.pathname = basePath + a.to.replace('{id}', m[1] ?? '')
        return app.fetch(new Request(url, request))
      }
    }
    return app.fetch(request)
  }

  function failNext(fault: Fault) { faults.push(fault) }
  function extraField(name: string, value: string) { extra = { name, value } }
  function clearFaults() { faults.length = 0; extra = null }
  /** What `/account` says from now on: the key was swapped for another account's or environment's. */
  function setAccount(next: { accountId?: string; environment?: string }) { account = { ...account, ...next } }

  return {
    app,
    fetch: fetchWithAliases,
    addKey(key: string, scopes: readonly string[] = [PORTAL_SCOPES.read]) {
      if (!key.startsWith(FAKE_PORTAL_KEY_PREFIX)) throw new Error(`a fake key starts with ${FAKE_PORTAL_KEY_PREFIX}`)
      keys.set(key, new Set(scopes))
    },
    /** The next request answers this. */
    failNext,
    /** Every answer also carries this field, which nobody declared. */
    extraField,
    clearFaults,
    setAccount,
    requests: (): readonly PortalRequest[] => requests,
  }
}

export type FakePortal = ReturnType<typeof createFakePortal>

/** `FAKE_PORTAL_ALIASES`: `<real path>=<fake path>` separated by commas. */
export function parsePortalAliases(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (text ?? '').split(',')) {
    const at = pair.indexOf('=')
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return out
}
