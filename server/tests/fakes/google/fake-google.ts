/**
 * The fake Google (「練習用の Google」, milestone 4 design N13 / G2): a small
 * Hono app with the data in memory that answers the OAuth 2.0, Calendar,
 * Meet, Drive and Gmail calls the server makes, in the shapes of Google's
 * public reference pages. Used by the server tests (passed straight in) and
 * on the staging server (`pnpm fake:google`, `serve.ts`).
 *
 * Test and staging code only: it lives under `server/tests/`, which the
 * production image never copies (server/Dockerfile copies `server/src` and
 * `shared`), and nothing in `server/src` may import it
 * (`tests/unit/layering.test.ts`).
 *
 * One origin, Google's paths. Google spreads these over several hosts; every
 * path below is the real one, and no two hosts share a path, so a practice
 * redirect maps each host onto this one base URL by path alone:
 *
 *   accounts.google.com           GET  /o/oauth2/v2/auth             (authorization endpoint)
 *   oauth2.googleapis.com         POST /token, POST /revoke
 *   www.googleapis.com            GET  /oauth2/v3/userinfo
 *   openidconnect.googleapis.com  GET  /v1/userinfo
 *   www.googleapis.com            GET  /calendar/v3/calendars/{calendarId}/events[/{eventId}]
 *   meet.googleapis.com           GET  /v2/conferenceRecords, /v2/conferenceRecords/{id},
 *                                      /v2/conferenceRecords/{id}/smartNotes[/{noteId}],
 *                                      /v2/conferenceRecords/{id}/transcripts[/{transcriptId}]
 *   www.googleapis.com            GET  /drive/v3/files/{fileId}, /drive/v3/files/{fileId}/export
 *   gmail.googleapis.com          POST /gmail/v1/users/{userId}/messages/send
 *
 * Practice values only, recognisable at a glance: client secrets start with
 * `fake-google-secret-`, access tokens `ya29.fake-`, refresh tokens
 * `1//fake-`, authorization codes `4/fake-`. Any other bearer value is 401.
 *
 * Stricter than Google where the server is meant to be strict anyway (so a
 * sloppy server fails here): the authorization request must carry `state`
 * and an S256 PKCE challenge (Google accepts a request without them, or with
 * `plain`), and Gmail refuses a From that is not the token's account (Gmail
 * itself may rewrite it instead).
 */
import { createHash, randomBytes } from 'crypto'
import { Hono, type Context } from 'hono'
import { defaultGoogleSeed, type ArtifactState, type GoogleSeed, type SeedArtifact } from './seed'

export const FAKE_GOOGLE_SECRET_PREFIX = 'fake-google-secret-'
export const FAKE_ACCESS_TOKEN_PREFIX = 'ya29.fake-'
export const FAKE_REFRESH_TOKEN_PREFIX = '1//fake-'
export const FAKE_CODE_PREFIX = '4/fake-'

export const GOOGLE_SCOPES = {
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
  calendarEventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  meetReadonly: 'https://www.googleapis.com/auth/meetings.space.readonly',
  driveMeetReadonly: 'https://www.googleapis.com/auth/drive.meet.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
} as const

/** The scopes milestone 4 asks for (design §5-2). */
export const MILESTONE4_SCOPES = [
  GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email, GOOGLE_SCOPES.calendarEventsReadonly,
  GOOGLE_SCOPES.meetReadonly, GOOGLE_SCOPES.driveMeetReadonly, GOOGLE_SCOPES.gmailSend,
]

const AUTH = 'https://www.googleapis.com/auth/'
/** Google's short names, granted (and reported in `scope`) as the long form. */
const SCOPE_ALIASES: Record<string, string> = { email: GOOGLE_SCOPES.email, profile: GOOGLE_SCOPES.profile }
/** Every scope the fake accepts in an authorization request. */
const KNOWN_SCOPES = new Set<string>([
  ...Object.values(GOOGLE_SCOPES),
  `${AUTH}calendar`, `${AUTH}calendar.readonly`, `${AUTH}calendar.events`,
  `${AUTH}meetings.space.created`,
  `${AUTH}drive`, `${AUTH}drive.readonly`,
  `${AUTH}gmail.compose`, `${AUTH}gmail.modify`, 'https://mail.google.com/',
])
/** Any one of these lets a call through (each method's "Authorization scopes" list). */
const NEEDS = {
  calendar: [GOOGLE_SCOPES.calendarEventsReadonly, `${AUTH}calendar.readonly`, `${AUTH}calendar.events`, `${AUTH}calendar`],
  meet: [GOOGLE_SCOPES.meetReadonly, `${AUTH}meetings.space.created`],
  drive: [GOOGLE_SCOPES.driveMeetReadonly, `${AUTH}drive.readonly`, `${AUTH}drive`],
  gmailSend: [GOOGLE_SCOPES.gmailSend, `${AUTH}gmail.compose`, `${AUTH}gmail.modify`, 'https://mail.google.com/'],
}
/** Drive scopes that reach every file the account can open (not only Meet's). */
const DRIVE_FULL = new Set([`${AUTH}drive.readonly`, `${AUTH}drive`])

export interface FakeGoogleOptions {
  seed?: GoogleSeed
  /** Milliseconds since the epoch; tests pass their own clock. */
  now?: () => number
  /** Serve `/__fake/*` (sign-in choice, faults, outside changes, sent mail). Off by default. */
  controlRoutes?: boolean
  /** Refresh tokens per client and account before the oldest is invalidated (Google: 100). */
  refreshTokenLimit?: number
  /** Drive's export limit (10 MB). */
  exportLimitBytes?: number
}

export interface FakeClient {
  clientId: string
  clientSecret: string
  redirectUris: string[]
  /** An internal app: only accounts of this Workspace domain may sign in ("Error 403: org_internal"). */
  internalDomain?: string
}

/** Who "signs in" at the authorization endpoint (there is no screen to click). */
export type SignIn = { email: string; withholdScopes?: string[] } | { deny: true }

export interface SentMessage {
  id: string
  threadId: string
  /** The account the token belongs to. */
  account: string
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  headers: Record<string, string>
  sentAt: string
}

export interface FakeGoogleRequestLog { method: string; path: string; status: number }

export interface FakeGoogleFaults {
  /** Delay every answer by this many milliseconds (0 = none). */
  delayMs: number
  /** The next `count` API / token requests answer `status` (500 or 429 shapes) without doing anything. */
  failNext(count?: number, status?: number): void
  /**
   * The next `count` Gmail sends are stored (the mail went out) and then never
   * answered: over a real socket the connection is cut; through `app.fetch`
   * the promise stays pending until `close()`. 「届いたか分からない」.
   */
  dropAnswerAfterSend(count?: number): void
  reset(): void
}

export interface FakeGoogle {
  app: Hono
  /** Registers an OAuth client; the secret must be a practice one. */
  addClient(client: Partial<FakeClient> & { redirectUris: string[] }): FakeClient
  /** Who signs in at the next authorization requests (default: the seed's member). */
  signIn(choice: SignIn): void
  /** The person removed the app's access in their Google account: every token of theirs stops working. */
  revokeAllFor(email: string): void
  /** Someone changes a calendar event (removes an attendee, renames it): `updated`, `sequence` and `etag` move. */
  changeEvent(id: string, change: { removeAttendee?: string; summary?: string }): void
  /** The minutes document is edited: new text (or one appended line), `version` + 1, new `modifiedTime`. */
  changeDoc(id: string, text?: string): void
  /** A Meet artifact moves on (e.g. ENDED → FILE_GENERATED). */
  setArtifactState(conferenceId: string, kind: 'smartNotes' | 'transcripts', artifactId: string, state: ArtifactState): void
  /** Every message Gmail "sent", oldest first. */
  sent: SentMessage[]
  /** A document's current version (null when unknown); for assertions. */
  doc(id: string): { text: string; version: number; modifiedTime: string } | null
  /** Live refresh tokens of an account (for the 100-per-account limit). */
  refreshTokenCount(clientId: string, email: string): number
  faults: FakeGoogleFaults
  requests: FakeGoogleRequestLog[]
  /** Releases every request held by `dropAnswerAfterSend`. */
  close(): void
}

interface CodeGrant {
  clientId: string
  redirectUri: string
  email: string
  scopes: string[]
  codeChallenge: string
  offline: boolean
  expiresAt: number
  used: boolean
}
interface RefreshGrant { token: string; clientId: string; email: string; scopes: string[]; createdAt: number; live: boolean }
interface AccessGrant { clientId: string; email: string; scopes: string[]; expiresAt: number; refreshToken: string | null; live: boolean }

class GoogleApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {
    super(`google ${status}`)
  }
}

const STATUS_NAMES: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' }

/** Google's JSON error (`{ error: { code, message, errors?, status } }`). */
const apiError = (code: number, message: string, reason?: string, extra: Record<string, unknown> = {}) =>
  new GoogleApiError(code, { error: { code, message, ...(reason ? { errors: [{ message, domain: 'global', reason, ...extra }] } : {}), status: STATUS_NAMES[code] ?? 'UNKNOWN' } })

const unauthenticated = () => new GoogleApiError(401, {
  error: {
    code: 401,
    message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
    errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }],
    status: 'UNAUTHENTICATED',
  },
}, { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' })

const insufficientScope = (service: string) => new GoogleApiError(403, {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { service } }],
  },
}, { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="insufficient_scope"' })

/** The token endpoint's error (`{ error, error_description }`, RFC 6749 §5.2). */
const oauthError = (status: number, error: string, description: string) => new GoogleApiError(status, { error, error_description: description })

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomToken = (n = 24) => b64url(randomBytes(n))

/** RFC 3339 with an offset or Z (Calendar refuses timeMin/timeMax without one). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const now = options.now ?? (() => Date.now())
  const seed = options.seed ?? defaultGoogleSeed()
  const refreshLimit = options.refreshTokenLimit ?? 100
  const exportLimit = options.exportLimitBytes ?? 10 * 1024 * 1024
  const iso = (ms: number) => new Date(ms).toISOString()

  const users = new Map(seed.users.map(u => [u.email.toLowerCase(), u]))
  const clients = new Map<string, FakeClient>()
  const codes = new Map<string, CodeGrant>()
  const refreshTokens = new Map<string, RefreshGrant>()
  const accessTokens = new Map<string, AccessGrant>()
  let signInChoice: SignIn = { email: seed.users[0]?.email ?? '' }

  const created = now()
  const events = seed.events.map(e => ({ ...e, attendees: e.attendees.map(a => ({ ...a })), created, updated: created, sequence: 0 }))
  const conferences = seed.conferences.map(c => ({ ...c, smartNotes: c.smartNotes.map(a => ({ ...a })), transcripts: c.transcripts.map(a => ({ ...a })) }))
  const docs = new Map(seed.docs.map(d => [d.id, { ...d }]))
  const sent: SentMessage[] = []
  const requests: FakeGoogleRequestLog[] = []

  // ---- faults ----
  let failCount = 0
  let failStatus = 500
  let dropCount = 0
  const held = new Set<() => void>()
  const faults: FakeGoogleFaults = {
    delayMs: 0,
    failNext(count = 1, status = 500) { failCount = count; failStatus = status },
    dropAnswerAfterSend(count = 1) { dropCount = count },
    reset() { faults.delayMs = 0; failCount = 0; dropCount = 0 },
  }

  const app = new Hono()

  app.use('*', async (c, next) => {
    const control = c.req.path.startsWith('/__fake/')
    if (!control && faults.delayMs > 0) await new Promise(r => setTimeout(r, faults.delayMs))
    if (!control && c.req.path !== '/o/oauth2/v2/auth' && failCount > 0) {
      failCount--
      const message = failStatus === 429 ? 'Resource has been exhausted (e.g. check quota).' : 'Internal error encountered.'
      const err = apiError(failStatus, message, failStatus === 429 ? 'rateLimitExceeded' : 'backendError')
      const res = c.json(err.body as object, failStatus as 500)
      requests.push({ method: c.req.method, path: c.req.path, status: failStatus })
      return res
    }
    await next()
    requests.push({ method: c.req.method, path: c.req.path, status: c.res.status })
  })

  app.onError((err, c) => {
    if (err instanceof GoogleApiError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v)
      return c.json(err.body as object, err.status as 400)
    }
    throw err
  })

  // ---- OAuth 2.0 ----

  function normalizeScopes(raw: string): string[] {
    return [...new Set(raw.split(/\s+/).filter(Boolean).map(s => SCOPE_ALIASES[s] ?? s))]
  }

  /** The error page Google shows instead of redirecting (unknown client, unregistered redirect URI). */
  const errorPage = (c: Context, status: number, error: string, detail: string) =>
    c.text(`Error ${status}: ${error}\n${detail}`, status as 400)

  app.get('/o/oauth2/v2/auth', c => {
    const q = c.req.query()
    const client = clients.get(q.client_id ?? '')
    if (!client) return errorPage(c, 401, 'invalid_client', 'The OAuth client was not found.')
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return errorPage(c, 400, 'redirect_uri_mismatch', 'You can\'t sign in to this app because it doesn\'t comply with Google\'s OAuth 2.0 policy.')
    }
    if (q.response_type !== 'code') return errorPage(c, 400, 'invalid_request', 'Invalid response_type: only "code" is supported.')
    if (!q.scope) return errorPage(c, 400, 'invalid_request', 'Missing required parameter: scope')
    const scopes = normalizeScopes(q.scope)
    const unknown = scopes.filter(s => !KNOWN_SCOPES.has(s))
    if (unknown.length > 0) return errorPage(c, 400, 'invalid_scope', `Some requested scopes were invalid. {invalid=[${unknown.join(', ')}]}`)
    if (!q.state) return errorPage(c, 400, 'invalid_request', 'The fake requires a state parameter.')
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) {
      return errorPage(c, 400, 'invalid_request', 'The fake requires a PKCE code_challenge with code_challenge_method=S256.')
    }
    const back = new URL(q.redirect_uri)
    back.searchParams.set('state', q.state)
    if ('deny' in signInChoice) {
      back.searchParams.set('error', 'access_denied')
      return c.redirect(back.toString(), 302)
    }
    const user = users.get(signInChoice.email.toLowerCase())
    if (!user) return errorPage(c, 400, 'invalid_request', 'The fake has no such account to sign in.')
    if (client.internalDomain && user.hd !== client.internalDomain) {
      return errorPage(c, 403, 'org_internal', 'This client is restricted to users within its organization.')
    }
    const withheld = new Set(normalizeScopes((signInChoice.withholdScopes ?? []).join(' ')))
    // openid and email are always granted; the person can untick the others (granular consent).
    const granted = scopes.filter(s => s === GOOGLE_SCOPES.openid || s === GOOGLE_SCOPES.email || !withheld.has(s))
    const code = `${FAKE_CODE_PREFIX}${randomToken()}`
    codes.set(code, {
      clientId: client.clientId, redirectUri: q.redirect_uri, email: user.email, scopes: granted,
      codeChallenge: q.code_challenge!, offline: q.access_type === 'offline', expiresAt: now() + 10 * 60_000, used: false,
    })
    back.searchParams.set('code', code)
    back.searchParams.set('scope', granted.join(' '))
    back.searchParams.set('authuser', '0')
    if (user.hd) back.searchParams.set('hd', user.hd)
    back.searchParams.set('prompt', 'consent')
    return c.redirect(back.toString(), 302)
  })

  async function formOf(c: Context): Promise<Record<string, string>> {
    const body = await c.req.parseBody().catch(() => ({}))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
    return out
  }

  function authenticateClient(c: Context, form: Record<string, string>): FakeClient {
    let id = form.client_id
    let secret = form.client_secret
    const basic = /^Basic (\S+)$/.exec(c.req.header('authorization') ?? '')
    if (basic) {
      const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':')
      id = decodeURIComponent(u ?? ''); secret = decodeURIComponent(p ?? '')
    }
    const client = clients.get(id ?? '')
    if (!client || client.clientSecret !== secret) throw oauthError(401, 'invalid_client', 'Unauthorized')
    return client
  }

  function issueAccess(clientId: string, email: string, scopes: string[], refreshToken: string | null) {
    const token = `${FAKE_ACCESS_TOKEN_PREFIX}${randomToken(32)}`
    accessTokens.set(token, { clientId, email, scopes, expiresAt: now() + 3599_000, refreshToken, live: true })
    return token
  }

  function issueRefresh(clientId: string, email: string, scopes: string[]) {
    const token = `${FAKE_REFRESH_TOKEN_PREFIX}${randomToken(32)}`
    refreshTokens.set(token, { token, clientId, email, scopes, createdAt: now(), live: true })
    // Google keeps a limited number per client and account and silently invalidates the oldest.
    const live = [...refreshTokens.values()].filter(r => r.live && r.clientId === clientId && r.email === email)
    for (const old of live.slice(0, Math.max(0, live.length - refreshLimit))) revokeRefresh(old.token)
    return token
  }

  function revokeRefresh(token: string) {
    const r = refreshTokens.get(token)
    if (!r) return
    r.live = false
    for (const a of accessTokens.values()) if (a.refreshToken === token) a.live = false
  }

  /** An unsigned-looking ID token: the claims Google puts in one (read it without trusting it; prefer userinfo). */
  function idToken(clientId: string, email: string): string {
    const u = users.get(email.toLowerCase())!
    const t = Math.floor(now() / 1000)
    const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)))
    const claims = { iss: 'https://accounts.google.com', azp: clientId, aud: clientId, sub: u.sub, email: u.email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}), iat: t, exp: t + 3599 }
    return `${enc({ alg: 'RS256', kid: 'fake-google-key', typ: 'JWT' })}.${enc(claims)}.${b64url(Buffer.from('fake-signature-not-verifiable'))}`
  }

  app.post('/token', async c => {
    const form = await formOf(c)
    const client = authenticateClient(c, form)
    if (form.grant_type === 'authorization_code') {
      const grant = codes.get(form.code ?? '')
      if (!grant || grant.clientId !== client.clientId) throw oauthError(400, 'invalid_grant', 'Malformed auth code.')
      if (grant.used || grant.expiresAt < now()) throw oauthError(400, 'invalid_grant', 'Bad Request')
      if (form.redirect_uri !== grant.redirectUri) throw oauthError(400, 'redirect_uri_mismatch', 'Bad Request')
      if (!form.code_verifier) throw oauthError(400, 'invalid_grant', 'Missing code verifier.')
      if (b64url(createHash('sha256').update(form.code_verifier).digest()) !== grant.codeChallenge) {
        throw oauthError(400, 'invalid_grant', 'Invalid code verifier.')
      }
      grant.used = true
      const refresh = grant.offline ? issueRefresh(client.clientId, grant.email, grant.scopes) : null
      return c.json({
        access_token: issueAccess(client.clientId, grant.email, grant.scopes, refresh),
        expires_in: 3599,
        ...(refresh ? { refresh_token: refresh } : {}),
        scope: grant.scopes.join(' '),
        token_type: 'Bearer',
        ...(grant.scopes.includes(GOOGLE_SCOPES.openid) ? { id_token: idToken(client.clientId, grant.email) } : {}),
      })
    }
    if (form.grant_type === 'refresh_token') {
      const r = refreshTokens.get(form.refresh_token ?? '')
      if (!r || !r.live || r.clientId !== client.clientId) throw oauthError(400, 'invalid_grant', 'Token has been expired or revoked.')
      return c.json({
        access_token: issueAccess(client.clientId, r.email, r.scopes, r.token),
        expires_in: 3599,
        scope: r.scopes.join(' '),
        token_type: 'Bearer',
        ...(r.scopes.includes(GOOGLE_SCOPES.openid) ? { id_token: idToken(client.clientId, r.email) } : {}),
      })
    }
    throw oauthError(400, 'unsupported_grant_type', `Invalid grant_type: ${form.grant_type ?? ''}`)
  })

  /** Revoking either token ends the whole grant (Google's revoke endpoint). */
  app.post('/revoke', async c => {
    const form = await formOf(c)
    const token = form.token ?? c.req.query('token') ?? ''
    const r = refreshTokens.get(token)
    const a = accessTokens.get(token)
    if (r?.live) { revokeRefresh(token); return c.body(null, 200) }
    if (a?.live) {
      a.live = false
      if (a.refreshToken) revokeRefresh(a.refreshToken)
      return c.body(null, 200)
    }
    throw oauthError(400, 'invalid_token', 'Token expired or revoked')
  })

  /** The bearer's grant, or 401; with `needs`, 403 unless one of them was granted. */
  function bearer(c: Context, needs?: string[], service = 'googleapis.com'): AccessGrant {
    const m = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')
    const token = m?.[1] ?? ''
    const a = token.startsWith(FAKE_ACCESS_TOKEN_PREFIX) ? accessTokens.get(token) : undefined
    if (!a || !a.live || a.expiresAt <= now()) throw unauthenticated()
    if (needs && !needs.some(s => a.scopes.includes(s))) throw insufficientScope(service)
    return a
  }

  const userinfo = (c: Context) => {
    const a = bearer(c)
    const u = users.get(a.email.toLowerCase())!
    const out: Record<string, unknown> = { sub: u.sub }
    if (a.scopes.includes(GOOGLE_SCOPES.profile)) Object.assign(out, { name: u.name, given_name: u.givenName, family_name: u.familyName })
    if (a.scopes.includes(GOOGLE_SCOPES.email)) Object.assign(out, { email: u.email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}) })
    return c.json(out)
  }
  app.get('/oauth2/v3/userinfo', userinfo)
  app.get('/v1/userinfo', userinfo)

  // ---- Calendar v3 ----

  type LiveEvent = (typeof events)[number]
  const etagOf = (e: LiveEvent) => `"${(e.updated * 1000 + e.sequence).toString().padStart(16, '0')}"`

  function eventOut(e: LiveEvent, viewer: string) {
    const me = viewer.toLowerCase()
    return {
      kind: 'calendar#event',
      etag: etagOf(e),
      id: e.id,
      status: 'confirmed',
      htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
      created: iso(e.created),
      updated: iso(e.updated),
      summary: e.summary,
      creator: { email: e.organizer, ...(e.organizer.toLowerCase() === me ? { self: true } : {}) },
      organizer: { email: e.organizer, ...(e.organizer.toLowerCase() === me ? { self: true } : {}) },
      start: { dateTime: e.start, timeZone: 'Asia/Tokyo' },
      end: { dateTime: e.end, timeZone: 'Asia/Tokyo' },
      iCalUID: `${e.id}@google.com`,
      sequence: e.sequence,
      attendees: e.attendees.map(a => ({
        email: a.email,
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.email === e.organizer ? { organizer: true } : {}),
        ...(a.email.toLowerCase() === me ? { self: true } : {}),
        responseStatus: a.responseStatus,
      })),
      ...(e.meetingCode ? {
        hangoutLink: `https://meet.google.com/${e.meetingCode}`,
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/${e.meetingCode}`, label: `meet.google.com/${e.meetingCode}` }],
          conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet', iconUri: 'https://fonts.gstatic.com/s/i/productlogos/meet_2020q4/v6/web-512dp/logo_meet_2020q4_color_2x_web_512dp.png' },
          conferenceId: e.meetingCode,
        },
      } : {}),
      reminders: { useDefault: true },
      eventType: 'default',
    }
  }

  function calendarOwner(c: Context, a: AccessGrant): string {
    const id = decodeURIComponent(c.req.param('calendarId') ?? '')
    if (id === 'primary' || id.toLowerCase() === a.email.toLowerCase()) return a.email
    throw apiError(404, 'Not Found', 'notFound')
  }
  const onCalendar = (e: LiveEvent, owner: string) =>
    e.organizer.toLowerCase() === owner.toLowerCase() || e.attendees.some(x => x.email.toLowerCase() === owner.toLowerCase())

  app.get('/calendar/v3/calendars/:calendarId/events', c => {
    const a = bearer(c, NEEDS.calendar, 'calendar-json.googleapis.com')
    const owner = calendarOwner(c, a)
    const q = c.req.query()
    for (const k of ['timeMin', 'timeMax'] as const) {
      if (q[k] !== undefined && !RFC3339.test(q[k])) throw apiError(400, 'Bad Request', 'badRequest')
    }
    if (q.orderBy === 'startTime' && q.singleEvents !== 'true') {
      throw apiError(400, 'The requested ordering is not available for the particular query.', 'badRequest')
    }
    if (q.orderBy !== undefined && q.orderBy !== 'startTime' && q.orderBy !== 'updated') throw apiError(400, `Invalid value for orderBy: ${q.orderBy}`, 'invalid')
    const maxResults = q.maxResults === undefined ? 250 : Number(q.maxResults)
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2500) throw apiError(400, 'Invalid value for maxResults', 'invalid')
    const from = q.timeMin ? Date.parse(q.timeMin) : -Infinity
    const to = q.timeMax ? Date.parse(q.timeMax) : Infinity
    // timeMin bounds the event's end, timeMax its start (both exclusive).
    let list = events.filter(e => onCalendar(e, owner) && Date.parse(e.end) > from && Date.parse(e.start) < to)
    if (q.orderBy === 'startTime') list = [...list].sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
    else if (q.orderBy === 'updated') list = [...list].sort((x, y) => x.updated - y.updated)
    const offset = q.pageToken ? Number(Buffer.from(q.pageToken, 'base64url').toString()) : 0
    if (!Number.isInteger(offset) || offset < 0) throw apiError(400, 'Invalid page token value.', 'invalid')
    const pageItems = list.slice(offset, offset + maxResults)
    const next = offset + maxResults < list.length ? Buffer.from(String(offset + maxResults)).toString('base64url') : null
    return c.json({
      kind: 'calendar#events',
      etag: `"${now()}"`,
      summary: owner,
      description: '',
      updated: iso(Math.max(created, ...events.map(e => e.updated))),
      timeZone: 'Asia/Tokyo',
      accessRole: 'owner',
      defaultReminders: [{ method: 'popup', minutes: 10 }],
      ...(next ? { nextPageToken: next } : {}),
      items: pageItems.map(e => eventOut(e, owner)),
    })
  })

  app.get('/calendar/v3/calendars/:calendarId/events/:eventId', c => {
    const a = bearer(c, NEEDS.calendar, 'calendar-json.googleapis.com')
    const owner = calendarOwner(c, a)
    const e = events.find(x => x.id === c.req.param('eventId'))
    if (!e || !onCalendar(e, owner)) throw apiError(404, 'Not Found', 'notFound')
    return c.json(eventOut(e, owner))
  })

  // ---- Meet REST v2 ----

  type LiveConference = (typeof conferences)[number]
  const canSeeConference = (conf: LiveConference, email: string) => conf.participants.some(p => p.toLowerCase() === email.toLowerCase())
  const conferenceOut = (conf: LiveConference) => ({
    name: `conferenceRecords/${conf.id}`,
    startTime: conf.startTime,
    endTime: conf.endTime,
    expireTime: iso(Date.parse(conf.endTime) + 30 * 24 * 3600_000),
    space: conf.space,
  })
  const artifactOut = (conf: LiveConference, kind: 'smartNotes' | 'transcripts', a: SeedArtifact) => ({
    name: `conferenceRecords/${conf.id}/${kind}/${a.id}`,
    state: a.state,
    startTime: conf.startTime,
    ...(a.state !== 'STARTED' ? { endTime: conf.endTime } : {}),
    // The document exists once the file is generated.
    ...(a.state === 'FILE_GENERATED' ? { docsDestination: { document: a.docId, exportUri: `https://docs.google.com/document/d/${a.docId}/view` } } : {}),
  })
  const meetNotFound = () => apiError(404, 'Requested entity was not found.')

  /** The list filter: `space.meeting_code = "…"`, `space.name = "…"`, `start_time >= "…"` / `<=` / `>` / `<`, `end_time IS NULL`, joined by AND. */
  function conferenceFilter(filter: string): (conf: LiveConference) => boolean {
    const tests: ((conf: LiveConference) => boolean)[] = []
    for (const part of filter.split(/\s+AND\s+/i).map(s => s.trim()).filter(Boolean)) {
      let m = /^(space\.meeting_code|space\.name)\s*=\s*"([^"]*)"$/.exec(part)
      if (m) {
        const [, field, value] = m
        tests.push(conf => (field === 'space.name' ? conf.space : conf.meetingCode) === value)
        continue
      }
      m = /^(start_time|end_time)\s*(>=|<=|>|<|=)\s*"([^"]+)"$/.exec(part)
      if (m) {
        const [, field, op, value] = m
        const t = Date.parse(value)
        if (Number.isNaN(t)) throw apiError(400, `Invalid filter: ${part}`)
        tests.push(conf => {
          const v = Date.parse(field === 'start_time' ? conf.startTime : conf.endTime)
          return op === '>=' ? v >= t : op === '<=' ? v <= t : op === '>' ? v > t : op === '<' ? v < t : v === t
        })
        continue
      }
      if (/^end_time\s+IS\s+NULL$/i.test(part)) { tests.push(() => false); continue }
      throw apiError(400, `Invalid filter: ${part}`)
    }
    return conf => tests.every(t => t(conf))
  }

  function pageOf<T>(items: T[], c: Context, def: number) {
    const size = Math.min(c.req.query('pageSize') ? Number(c.req.query('pageSize')) : def, 100)
    if (!Number.isInteger(size) || size < 1) throw apiError(400, 'Invalid page size.')
    const token = c.req.query('pageToken')
    const offset = token ? Number(Buffer.from(token, 'base64url').toString()) : 0
    if (!Number.isInteger(offset) || offset < 0) throw apiError(400, 'Invalid page token.')
    const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString('base64url') : null
    return { slice: items.slice(offset, offset + size), next }
  }

  app.get('/v2/conferenceRecords', c => {
    const a = bearer(c, NEEDS.meet, 'meet.googleapis.com')
    const keep = conferenceFilter(c.req.query('filter') ?? '')
    const list = conferences.filter(conf => canSeeConference(conf, a.email) && keep(conf))
      .sort((x, y) => Date.parse(y.startTime) - Date.parse(x.startTime))
    const { slice, next } = pageOf(list, c, 25)
    // An empty list is `{}`: Google leaves out empty repeated fields.
    return c.json({ ...(slice.length ? { conferenceRecords: slice.map(conferenceOut) } : {}), ...(next ? { nextPageToken: next } : {}) })
  })

  function visibleConference(c: Context, a: AccessGrant): LiveConference {
    const conf = conferences.find(x => x.id === c.req.param('id'))
    if (!conf || !canSeeConference(conf, a.email)) throw meetNotFound()
    return conf
  }

  app.get('/v2/conferenceRecords/:id', c => c.json(conferenceOut(visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com')))))

  for (const kind of ['smartNotes', 'transcripts'] as const) {
    app.get(`/v2/conferenceRecords/:id/${kind}`, c => {
      const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
      const { slice, next } = pageOf(conf[kind], c, 10)
      return c.json({ ...(slice.length ? { [kind]: slice.map(a => artifactOut(conf, kind, a)) } : {}), ...(next ? { nextPageToken: next } : {}) })
    })
    app.get(`/v2/conferenceRecords/:id/${kind}/:artifactId`, c => {
      const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
      const a = conf[kind].find(x => x.id === c.req.param('artifactId'))
      if (!a) throw meetNotFound()
      return c.json(artifactOut(conf, kind, a))
    })
  }

  // ---- Drive v3 ----

  type LiveDoc = NonNullable<ReturnType<typeof docs.get>>
  const fileNotFound = (id: string) => apiError(404, `File not found: ${id}.`, 'notFound', { location: 'fileId', locationType: 'parameter' })

  /** With only `drive.meet.readonly`, files Meet did not create do not exist for the token (404, as Drive answers for files out of a narrow scope). */
  function visibleDoc(c: Context): { a: AccessGrant; d: LiveDoc } {
    const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
    const id = c.req.param('fileId') ?? ''
    const d = docs.get(id)
    if (!d || !d.readers.some(r => r.toLowerCase() === a.email.toLowerCase())) throw fileNotFound(id)
    if (!d.createdByMeet && !a.scopes.some(s => DRIVE_FULL.has(s))) throw fileNotFound(id)
    return { a, d }
  }

  app.get('/drive/v3/files/:fileId/export', c => {
    const { d } = visibleDoc(c)
    const mimeType = c.req.query('mimeType')
    if (!mimeType) throw apiError(400, 'Required parameter: mimeType', 'required', { location: 'mimeType', locationType: 'parameter' })
    if (mimeType !== 'text/plain') throw apiError(400, 'The requested conversion is not supported.', 'badRequest')
    // Docs' plain-text export starts with a byte-order mark and ends lines with CRLF.
    const text = '﻿' + d.text.replace(/\r?\n/g, '\r\n')
    if (Buffer.byteLength(text, 'utf8') > exportLimit) throw apiError(403, 'This file is too large to be exported.', 'exportSizeLimitExceeded')
    return c.body(text, 200, { 'content-type': 'text/plain; charset=UTF-8' })
  })

  app.get('/drive/v3/files/:fileId', c => {
    const { d } = visibleDoc(c)
    // headRevisionId is left out: Drive sets it only for files with binary content, not Google Docs.
    const all: Record<string, unknown> = {
      kind: 'drive#file', id: d.id, name: d.name, mimeType: 'application/vnd.google-apps.document',
      version: String(d.version), modifiedTime: d.modifiedTime, createdTime: d.modifiedTime,
      owners: [{ kind: 'drive#user', emailAddress: d.owner, me: false }],
    }
    const fields = c.req.query('fields')
    if (fields === '*') return c.json(all)
    const wanted = fields ? fields.split(',').map(f => f.trim()).filter(Boolean) : ['kind', 'id', 'name', 'mimeType']
    const out: Record<string, unknown> = {}
    for (const f of wanted) {
      if (!/^[a-zA-Z]+(\([^)]*\))?$/.test(f)) throw apiError(400, `Invalid field selection ${f}`, 'invalidParameter', { location: 'fields', locationType: 'parameter' })
      const name = f.replace(/\(.*$/, '')
      if (name in all) out[name] = all[name]
      else if (name !== 'headRevisionId') throw apiError(400, `Invalid field selection ${name}`, 'invalidParameter', { location: 'fields', locationType: 'parameter' })
    }
    return c.json(out)
  })

  // ---- Gmail ----

  app.post('/gmail/v1/users/:userId/messages/send', async c => {
    const a = bearer(c, NEEDS.gmailSend, 'gmail.googleapis.com')
    const userId = decodeURIComponent(c.req.param('userId') ?? '')
    if (userId !== 'me' && userId.toLowerCase() !== a.email.toLowerCase()) throw apiError(403, 'Delegation denied for ' + a.email, 'forbidden')
    const body = await c.req.json().catch(() => null) as { raw?: unknown; threadId?: unknown } | null
    if (!body || typeof body.raw !== 'string' || body.raw === '') throw apiError(400, '\'raw\' RFC822 payload message string or uploading message via /upload/* URL required', 'invalidArgument')
    const parsed = parseMessage(Buffer.from(body.raw, 'base64url').toString('utf8'))
    if (parsed.to.length + parsed.cc.length + parsed.bcc.length === 0) throw apiError(400, 'Recipient address required', 'invalidArgument')
    if (parsed.from && !addressesOf(parsed.from).some(f => f.toLowerCase() === a.email.toLowerCase())) {
      throw apiError(400, `Invalid From header: not the account ${a.email}`, 'invalidArgument')
    }
    const id = randomBytes(8).toString('hex')
    const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : id
    sent.push({ id, threadId, account: a.email, ...parsed, sentAt: iso(now()) })
    if (dropCount > 0) {
      dropCount--
      return dropAnswer(c)
    }
    return c.json({ id, threadId, labelIds: ['SENT'] })
  })

  /** The send happened; the answer does not arrive. */
  function dropAnswer(c: Context): Promise<Response> {
    const env = c.env as { incoming?: { socket?: { destroy(): void } } } | undefined
    const socket = env?.incoming?.socket
    if (socket) {
      socket.destroy()
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return new Promise<Response>(resolveHeld => {
      const release = () => { held.delete(release); resolveHeld(new Response(null, { status: 504 })) }
      held.add(release)
    })
  }

  // ---- outside changes ----

  function changeEvent(id: string, change: { removeAttendee?: string; summary?: string }) {
    const e = events.find(x => x.id === id)
    if (!e) throw new Error(`fake Google: no event ${id}`)
    if (change.removeAttendee) e.attendees = e.attendees.filter(x => x.email.toLowerCase() !== change.removeAttendee!.toLowerCase())
    if (change.summary !== undefined) e.summary = change.summary
    e.sequence++
    e.updated = Math.max(now(), e.updated + 1)
  }

  function changeDoc(id: string, text?: string) {
    const d = docs.get(id)
    if (!d) throw new Error(`fake Google: no document ${id}`)
    d.text = text ?? `${d.text}・（追記）先方より、研修開始を2月に変更したいとの連絡あり\n`
    d.version++
    d.modifiedTime = iso(Math.max(now(), Date.parse(d.modifiedTime) + 1000))
  }

  function setArtifactState(conferenceId: string, kind: 'smartNotes' | 'transcripts', artifactId: string, state: ArtifactState) {
    const a = conferences.find(x => x.id === conferenceId)?.[kind].find(x => x.id === artifactId)
    if (!a) throw new Error(`fake Google: no ${kind} ${artifactId}`)
    a.state = state
  }

  function revokeAllFor(email: string) {
    for (const r of refreshTokens.values()) if (r.email.toLowerCase() === email.toLowerCase()) revokeRefresh(r.token)
    for (const t of accessTokens.values()) if (t.email.toLowerCase() === email.toLowerCase()) t.live = false
  }

  function signIn(choice: SignIn) { signInChoice = choice }

  if (options.controlRoutes) {
    const ok = (c: Context, fn: () => void) => {
      try { fn() } catch (err) { return c.json({ error: (err as Error).message }, 400) }
      return c.json({ ok: true })
    }
    app.post('/__fake/sign-in', async c => {
      const body = await c.req.json().catch(() => ({})) as { email?: string; deny?: boolean; withholdScopes?: string[] }
      return ok(c, () => signIn(body.deny ? { deny: true } : { email: body.email ?? '', withholdScopes: body.withholdScopes }))
    })
    app.post('/__fake/faults', async c => {
      const body = await c.req.json().catch(() => ({})) as { delayMs?: number; failNext?: number; failStatus?: number; dropAnswerAfterSend?: number; reset?: boolean }
      if (body.reset) faults.reset()
      if (typeof body.delayMs === 'number') faults.delayMs = body.delayMs
      if (typeof body.failNext === 'number') faults.failNext(body.failNext, body.failStatus)
      if (typeof body.dropAnswerAfterSend === 'number') faults.dropAnswerAfterSend(body.dropAnswerAfterSend)
      return c.json({ ok: true })
    })
    app.post('/__fake/revoke-all', async c => {
      const body = await c.req.json().catch(() => ({})) as { email?: string }
      return ok(c, () => revokeAllFor(body.email ?? ''))
    })
    app.post('/__fake/events/:id', async c => {
      const body = await c.req.json().catch(() => ({})) as { removeAttendee?: string; summary?: string }
      return ok(c, () => changeEvent(c.req.param('id'), body))
    })
    app.post('/__fake/docs/:id', async c => {
      const body = await c.req.json().catch(() => ({})) as { text?: string }
      return ok(c, () => changeDoc(c.req.param('id'), body.text))
    })
    app.post('/__fake/conferences/:id/:kind/:artifactId', async c => {
      const body = await c.req.json().catch(() => ({})) as { state?: ArtifactState }
      const kind = c.req.param('kind')
      if (kind !== 'smartNotes' && kind !== 'transcripts') return c.json({ error: 'kind is smartNotes or transcripts' }, 400)
      return ok(c, () => setArtifactState(c.req.param('id'), kind, c.req.param('artifactId'), body.state ?? 'FILE_GENERATED'))
    })
    app.get('/__fake/gmail/sent', c => c.json({ messages: sent }))
  }

  return {
    app,
    addClient(input) {
      const client: FakeClient = {
        clientId: input.clientId ?? `${randomBytes(6).toString('hex')}-fake.apps.googleusercontent.com`,
        clientSecret: input.clientSecret ?? `${FAKE_GOOGLE_SECRET_PREFIX}${randomToken(18)}`,
        redirectUris: [...input.redirectUris],
        ...(input.internalDomain ? { internalDomain: input.internalDomain } : {}),
      }
      if (!client.clientSecret.startsWith(FAKE_GOOGLE_SECRET_PREFIX)) throw new Error(`fake Google client secrets start with ${FAKE_GOOGLE_SECRET_PREFIX}`)
      clients.set(client.clientId, client)
      return client
    },
    signIn,
    revokeAllFor,
    changeEvent,
    changeDoc,
    setArtifactState,
    sent,
    doc(id) {
      const d = docs.get(id)
      return d ? { text: d.text, version: d.version, modifiedTime: d.modifiedTime } : null
    },
    refreshTokenCount(clientId, email) {
      return [...refreshTokens.values()].filter(r => r.live && r.clientId === clientId && r.email.toLowerCase() === email.toLowerCase()).length
    },
    faults,
    requests,
    close() { for (const release of [...held]) release() },
  }
}

// ---- RFC 2822 (what the server's mail builder produces; enough to read it back) ----

/** `=?UTF-8?B?…?=` / `=?UTF-8?Q?…?=` encoded words (RFC 2047). */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, _cs: string, enc: string, text: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
}

function decodeQuotedPrintable(s: string): string {
  const bytes = s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
  return Buffer.from(bytes, 'latin1').toString('utf8')
}

/** The bare addresses of a header (`"名前" <a@b>, c@d`). */
export function addressesOf(header: string): string[] {
  return header.split(',').map(s => s.trim()).filter(Boolean).map(s => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim())
}

function splitHeadersBody(text: string): { headers: Record<string, string>; body: string } {
  const sep = /\r?\n\r?\n/.exec(text)
  const head = sep ? text.slice(0, sep.index) : text
  const body = sep ? text.slice(sep.index + sep[0].length) : ''
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { headers, body }
}

function decodeBody(headers: Record<string, string>, body: string): string {
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

function parseMessage(text: string): Omit<SentMessage, 'id' | 'threadId' | 'account' | 'sentAt'> {
  const { headers, body } = splitHeadersBody(text)
  let plain = decodeBody(headers, body)
  const boundary = /multipart\/[^;]+;.*boundary="?([^";]+)"?/i.exec(headers['content-type'] ?? '')?.[1]
  if (boundary) {
    // The first text/plain part.
    const parts = body.split(`--${boundary}`).slice(1).filter(p => !p.startsWith('--'))
    const part = parts.map(p => splitHeadersBody(p.replace(/^\r?\n/, ''))).find(p => (p.headers['content-type'] ?? 'text/plain').toLowerCase().startsWith('text/plain'))
    plain = part ? decodeBody(part.headers, part.body) : ''
  }
  const list = (name: string) => (headers[name] ? addressesOf(decodeWords(headers[name])) : [])
  return {
    from: headers.from ? decodeWords(headers.from) : null,
    to: list('to'),
    cc: list('cc'),
    bcc: list('bcc'),
    subject: decodeWords(headers.subject ?? ''),
    body: plain.replace(/\r\n/g, '\n'),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, decodeWords(v)])),
  }
}
