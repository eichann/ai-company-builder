/**
 * The Google client (milestone 4 G3, `.claude/rules/google-connector.md`):
 * the ONE place in the server that talks to Google — the OAuth token,
 * revoke and userinfo endpoints for the connection (services/google-connector.ts)
 * and every API call made on a member's behalf (`request`: Calendar, Meet and
 * Drive for the minutes, Gmail for mail).
 *
 * Every call re-checks every switch, so each stop works from the next call:
 * the operator's stop file (`<PLUGINS_DIR>/stopped` naming `google` or `*`),
 * the company's client present and on, the vault on, the caller still a
 * member, the member's grant active (an admin's stop, 「すべての鍵を止める」
 * and the member's own 「許可をやめる」 all end it), the scope granted.
 *
 * Secrets: the client secret and the refresh token come out of the vault
 * just before they are sent; the access token lives only in this module's
 * memory, at most until Google's expiry and never more than 1 hour. None of
 * them is returned, logged, stored or put in an error. Google's error bodies
 * are not passed on (only its short reason code).
 *
 * Retries: reads (GET) after a 429, a 5xx or a failure before sending — wait
 * (Retry-After, else 1 s, 2 s), at most 2 retries. Writes (Gmail send) are
 * never retried here; a connection lost after sending is `unknown`.
 *
 * Staging (`practiceGoogle`): every Google host goes to the fake Google
 * (adapters/upstream-practice.ts); a client secret or token that is not a
 * practice value is never sent (`practice-real-secret`).
 */
import { checkUpstreamPath } from '../../shared/core/upstream-path'
import { GOOGLE_API_HOSTS, GOOGLE_AUTHORIZE_PATH, isPracticeGoogleSecret, type GoogleApi } from '../../shared/core/google'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorGrantRow } from '../ports/connectors'
import type { Clock } from '../ports/clock'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'
import type { BrokerVault } from './broker-vault'

const HEADERS_TIMEOUT_MS = 30_000
const MAX_READ_RETRIES = 2
const RETRY_AFTER_CAP_MS = 10_000
/** Drive's export limit is 10 MB; a little room for JSON around it. */
const MAX_ANSWER_BYTES = 12 * 1024 * 1024
/** An access token is kept at most this long (and never past Google's expiry minus a minute). */
const ACCESS_TOKEN_MAX_MS = 60 * 60 * 1000
const ACCESS_TOKEN_MARGIN_MS = 60 * 1000
/** Failures of the way out that certainly happen before the request leaves. */
const BEFORE_SENDING: readonly UpstreamFailure[] = ['private-address', 'dns', 'tls', 'practice-real-secret']

/** Why a call was refused before anything left ACB. */
export type GoogleStopReason =
  | 'operator-stopped' | 'not-configured' | 'off' | 'vault-off' | 'not-member'
  | 'no-grant' | 'grant-revoked' | 'grant-stopped' | 'scope-not-granted'
  | 'practice-real-secret' | 'bad-path' | 'token-refused' | 'token-unavailable'

export interface GoogleRequest {
  api: Exclude<GoogleApi, 'oauth' | 'userinfo'>
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Google's path (`/calendar/v3/calendars/primary/events`), without the query. */
  path: string
  query?: Record<string, string | string[]>
  /** JSON body (writes). */
  body?: unknown
  /** The scope this call needs; the call is refused unless the member granted it. */
  scope: string
  /** A short name for the record (`calendar.events.list`, `gmail.send`); never content. */
  operation: string
}

export type GoogleResult =
  | {
    ok: true
    status: number
    /** The answer as JSON (null when empty or not JSON). */
    json: unknown
    /** The answer as text when it is not JSON (Drive export). */
    text: string | null
  }
  | {
    ok: false
    /**
     * not-sent: nothing left ACB (a switch is off, no grant, …);
     * refused: Google answered 4xx (`status`, `googleReason`);
     * rate-limited / server-error: 429 / 5xx after the retries a read gets;
     * unknown: a write whose answer was lost — it may have been applied (never re-send blindly).
     */
    kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown'
    reason: GoogleStopReason | UpstreamFailure | 'answer-too-large' | 'refused' | 'rate-limited' | 'server-error'
    status?: number
    /** Google's short error code (`insufficientPermissions`, `notFound`, `PERMISSION_DENIED`), never its message. */
    googleReason?: string
  }

export interface GoogleTokens {
  accessToken: string
  refreshToken: string | null
  scopes: string
  expiresInSeconds: number
}

export interface GoogleUserInfo {
  email: string | null
  emailVerified: boolean
  hd: string | null
}

export interface GoogleClientDeps {
  companyData: CompanyDataSource
  brokerVault: BrokerVault
  upstream: UpstreamClient
  clock: Clock
  isMember(companyId: string, userId: string): boolean
  /** The operator's stop file names `google` or `*` (read on every call). */
  operatorStopped(): Promise<boolean>
  /** One AI-action-log line per call (operation name, status; never content). */
  record(companyId: string, userId: string, e: { operation: string; api: string; host: string; status: number | null; ok: boolean }): void
  /** Staging: the fake Google answers every Google host (only practice values are sent). */
  practiceGoogle: boolean
  /** Where the browser signs in (https://accounts.google.com, or the fake Google's origin). */
  authorizeOrigin: string
  sleep(ms: number): Promise<void>
}

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

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { return undefined }
}

/** Google's short error code of an answer, never its message. */
function googleReasonOf(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const err = (json as { error?: unknown }).error
  if (typeof err === 'string') return /^[A-Za-z_]{1,60}$/.test(err) ? err : undefined
  if (!err || typeof err !== 'object') return undefined
  const first = (err as { errors?: Array<{ reason?: unknown }> }).errors?.[0]?.reason
  const status = (err as { status?: unknown }).status
  const pick = typeof first === 'string' ? first : typeof status === 'string' ? status : undefined
  return pick && /^[A-Za-z_]{1,60}$/.test(pick) ? pick : undefined
}

function form(values: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(values).toString())
}

export function createGoogleClient(deps: GoogleClientDeps) {
  /** company|user|grantId → access token (memory only). */
  const accessTokens = new Map<string, { token: string; expiresAtMs: number; scopes: string }>()
  const cacheKey = (companyId: string, userId: string, grantId: string) => `${companyId}|${userId}|${grantId}`

  /** The company's client id and secret, or why not (practice: never a real secret). */
  async function clientCredentials(companyId: string): Promise<{ clientId: string; secret: string } | { stop: GoogleStopReason }> {
    if (!deps.brokerVault.status().enabled) return { stop: 'vault-off' }
    const handle = deps.companyData.forCompany(companyId).connectors
    const client = handle.client()
    const sealed = handle.clientSecret()
    if (!client || !sealed) return { stop: 'not-configured' }
    const secret = await deps.brokerVault.openConnector({ purpose: 'acb-google-client', companyId, id: 'google-client' }, sealed)
    if (deps.practiceGoogle && !isPracticeGoogleSecret(secret)) return { stop: 'practice-real-secret' }
    return { clientId: client.clientId, secret }
  }

  /** POST to Google's token / revoke endpoint (form body; never retried; nothing logged). */
  async function postForm(path: '/token' | '/revoke', values: Record<string, string>): Promise<{ status: number; json: unknown } | { failure: UpstreamFailure | 'answer-too-large' }> {
    const body = form(values)
    const sent = await deps.upstream.send({
      host: GOOGLE_API_HOSTS.oauth, method: 'POST', path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.byteLength), accept: 'application/json', 'accept-encoding': 'identity' },
      body: (async function* () { yield body })(),
      allowPrivateHosts: [], signal: new AbortController().signal, headersTimeoutMs: HEADERS_TIMEOUT_MS,
    })
    if (!sent.ok) return { failure: sent.reason }
    const bytes = await readBody(sent.response.body).catch(() => null)
    if (!bytes) return { failure: 'answer-too-large' }
    return { status: sent.response.status, json: parseJson(bytes) ?? null }
  }

  function tokensOf(json: unknown): GoogleTokens | null {
    if (!json || typeof json !== 'object') return null
    const j = json as Record<string, unknown>
    if (typeof j.access_token !== 'string' || j.access_token === '') return null
    return {
      accessToken: j.access_token,
      refreshToken: typeof j.refresh_token === 'string' && j.refresh_token !== '' ? j.refresh_token : null,
      scopes: typeof j.scope === 'string' ? j.scope : '',
      expiresInSeconds: typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600,
    }
  }

  /** The switches that apply to every member call, in order; null when all are on. */
  async function switchesOff(companyId: string, userId: string): Promise<GoogleStopReason | null> {
    if (await deps.operatorStopped()) return 'operator-stopped'
    const client = deps.companyData.forCompany(companyId).connectors.client()
    if (!client) return 'not-configured'
    if (!client.enabled) return 'off'
    if (!deps.brokerVault.status().enabled) return 'vault-off'
    if (!deps.isMember(companyId, userId)) return 'not-member'
    return null
  }

  function grantStop(grant: ConnectorGrantRow | null): GoogleStopReason | null {
    if (!grant) return 'no-grant'
    if (grant.status === 'revoked') return 'grant-revoked'
    if (grant.status === 'stopped') return 'grant-stopped'
    return null
  }

  /** A usable access token for the member's active grant (refreshing it when needed). */
  async function accessTokenFor(companyId: string, userId: string, grant: ConnectorGrantRow): Promise<{ token: string } | { stop: GoogleStopReason } | { failure: UpstreamFailure | 'answer-too-large' }> {
    const key = cacheKey(companyId, userId, grant.grantId)
    const cached = accessTokens.get(key)
    if (cached && cached.expiresAtMs > deps.clock.nowMs()) return { token: cached.token }
    accessTokens.delete(key)
    const connectors = deps.companyData.forCompany(companyId).connectors
    const stored = connectors.refreshToken('google', userId)
    if (!stored || stored.grantId !== grant.grantId) return { stop: 'grant-revoked' }
    const creds = await clientCredentials(companyId)
    if ('stop' in creds) return creds
    const refreshToken = await deps.brokerVault.openConnector({ purpose: 'acb-google-grant', companyId, id: stored.grantId }, stored.sealed)
    if (deps.practiceGoogle && !isPracticeGoogleSecret(refreshToken)) return { stop: 'practice-real-secret' }
    const answer = await postForm('/token', {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.secret,
    })
    if ('failure' in answer) return answer
    if (answer.status === 400 || answer.status === 401) {
      const reason = googleReasonOf(answer.json)
      if (reason === 'invalid_grant') {
        // Google no longer honours the token (revoked in the Google account, 6 months unused,
        // the 100-token limit…): the grant ends; the member is asked to allow again.
        connectors.endGrant('google', userId, 'revoked', 'invalid_grant', deps.clock.now(), {
          id: `${grant.grantId}-ended`, provider: 'google', action: 'grant-revoked', userId, at: deps.clock.now(), by: 'google',
          change: JSON.stringify({ reason: 'invalid_grant' }),
        }, grant.grantId)
        return { stop: 'grant-revoked' }
      }
      return { stop: 'token-refused' }
    }
    if (answer.status < 200 || answer.status >= 300) return { stop: 'token-unavailable' }
    const tokens = tokensOf(answer.json)
    if (!tokens) return { stop: 'token-unavailable' }
    const lifetime = Math.min(tokens.expiresInSeconds * 1000 - ACCESS_TOKEN_MARGIN_MS, ACCESS_TOKEN_MAX_MS)
    if (lifetime > 0) accessTokens.set(key, { token: tokens.accessToken, expiresAtMs: deps.clock.nowMs() + lifetime, scopes: tokens.scopes })
    return { token: tokens.accessToken }
  }

  function pathWithQuery(req: GoogleRequest): string | null {
    const checked = checkUpstreamPath(req.path)
    if (!checked || req.path.includes('?') || req.path.includes('#')) return null
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(req.query ?? {})) for (const one of Array.isArray(v) ? v : [v]) q.append(k, one)
    const qs = q.toString()
    return qs ? `${req.path}?${qs}` : req.path
  }

  function forget(companyId: string, userId: string): void {
    const prefix = `${companyId}|${userId}|`
    for (const k of [...accessTokens.keys()]) if (k.startsWith(prefix)) accessTokens.delete(k)
  }

  async function revoke(token: string): Promise<boolean> {
    if (deps.practiceGoogle && !isPracticeGoogleSecret(token)) return false
    const answer = await postForm('/revoke', { token })
    return !('failure' in answer) && answer.status === 200
  }

  return {
    /** Forget every cached access token of a member (a grant ended or was replaced). */
    forget,

    /** Forget every cached access token of a company (the client changed, stop-all). */
    forgetCompany(companyId: string): void {
      const prefix = `${companyId}|`
      for (const k of [...accessTokens.keys()]) if (k.startsWith(prefix)) accessTokens.delete(k)
    },

    /** The URL the member's browser opens (Google's sign-in, or the fake Google's on staging). */
    authorizeUrl(params: Record<string, string>): string {
      return `${deps.authorizeOrigin}${GOOGLE_AUTHORIZE_PATH}?${new URLSearchParams(params).toString()}`
    },

    clientCredentials,

    /** Exchanges an authorization code (PKCE). Nothing logged; the tokens go straight to the caller. */
    async exchangeCode(companyId: string, code: string, verifier: string, redirectUri: string): Promise<{ ok: true; tokens: GoogleTokens } | { ok: false; reason: string }> {
      const creds = await clientCredentials(companyId)
      if ('stop' in creds) return { ok: false, reason: creds.stop }
      if (deps.practiceGoogle && !isPracticeGoogleSecret(code)) return { ok: false, reason: 'practice-real-secret' }
      const answer = await postForm('/token', {
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
        client_id: creds.clientId, client_secret: creds.secret,
      })
      if ('failure' in answer) return { ok: false, reason: answer.failure }
      if (answer.status < 200 || answer.status >= 300) return { ok: false, reason: googleReasonOf(answer.json) ?? `status-${answer.status}` }
      const tokens = tokensOf(answer.json)
      return tokens ? { ok: true, tokens } : { ok: false, reason: 'unreadable-answer' }
    },

    /** Which account an access token belongs to (OpenID userinfo). */
    async userInfo(accessToken: string): Promise<GoogleUserInfo | null> {
      if (deps.practiceGoogle && !isPracticeGoogleSecret(accessToken)) return null
      const sent = await deps.upstream.send({
        host: GOOGLE_API_HOSTS.userinfo, method: 'GET', path: '/oauth2/v3/userinfo',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'accept-encoding': 'identity' },
        body: null, allowPrivateHosts: [], signal: new AbortController().signal, headersTimeoutMs: HEADERS_TIMEOUT_MS,
      })
      if (!sent.ok || sent.response.status !== 200) return null
      const bytes = await readBody(sent.response.body).catch(() => null)
      const json = bytes ? parseJson(bytes) : null
      if (!json || typeof json !== 'object') return null
      const j = json as Record<string, unknown>
      return {
        email: typeof j.email === 'string' ? j.email : null,
        emailVerified: j.email_verified === true || j.email_verified === 'true',
        hd: typeof j.hd === 'string' ? j.hd : null,
      }
    },

    /** Revokes a token at Google (best effort: false when it could not be confirmed). */
    revoke,

    /** Revokes a member's stored refresh token at Google (best effort; the caller ends the grant either way). */
    async revokeStored(companyId: string, userId: string): Promise<boolean> {
      if (!deps.brokerVault.status().enabled) return false
      const stored = deps.companyData.forCompany(companyId).connectors.refreshToken('google', userId)
      if (!stored) return false
      try {
        const token = await deps.brokerVault.openConnector({ purpose: 'acb-google-grant', companyId, id: stored.grantId }, stored.sealed)
        return await revoke(token)
      } catch {
        return false
      }
    },

    /**
     * One API call on a member's behalf — the entry point for later features
     * (minutes: Calendar / Meet / Drive; mail: Gmail). Every switch is checked
     * first; then the access token; then the call through the way out.
     */
    async request(companyId: string, userId: string, req: GoogleRequest): Promise<GoogleResult> {
      const host = GOOGLE_API_HOSTS[req.api]
      const notSent = (reason: GoogleStopReason): GoogleResult => ({ ok: false, kind: 'not-sent', reason })
      if (!host) return notSent('bad-path')
      const path = pathWithQuery(req)
      if (!path) return notSent('bad-path')
      const isRead = req.method === 'GET'
      const body = req.body === undefined ? null : new TextEncoder().encode(JSON.stringify(req.body))
      let retriedAfter401 = false
      for (let attempt = 0; ; attempt++) {
        // Every switch, before every attempt (a stop during a wait applies to the retry too).
        const off = await switchesOff(companyId, userId)
        if (off) return notSent(off)
        const connectors = deps.companyData.forCompany(companyId).connectors
        const grant = connectors.grant('google', userId)
        const stop = grantStop(grant)
        if (stop) return notSent(stop)
        if (!grant!.scopes.includes(req.scope)) return notSent('scope-not-granted')
        const token = await accessTokenFor(companyId, userId, grant!)
        if ('stop' in token) return notSent(token.stop)
        if ('failure' in token) return { ok: false, kind: 'not-sent', reason: token.failure }

        const headers: Record<string, string> = { authorization: `Bearer ${token.token}`, accept: 'application/json', 'accept-encoding': 'identity' }
        if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.byteLength) }
        const sent = await deps.upstream.send({
          host, method: req.method, path, headers,
          body: body ? (async function* () { yield body })() : null,
          allowPrivateHosts: [], signal: new AbortController().signal, headersTimeoutMs: HEADERS_TIMEOUT_MS,
        })
        connectors.touchGrant('google', userId, deps.clock.now())
        let failure: GoogleResult
        let retryAfterMs: number | null = null
        if (!sent.ok) {
          deps.record(companyId, userId, { operation: req.operation, api: req.api, host, status: null, ok: false })
          const before = BEFORE_SENDING.includes(sent.reason)
          failure = { ok: false, kind: before || isRead ? 'not-sent' : 'unknown', reason: sent.reason }
          if (!isRead || before) return failure
        } else {
          const { status } = sent.response
          const bytes = await readBody(sent.response.body).catch(() => null)
          deps.record(companyId, userId, { operation: req.operation, api: req.api, host, status, ok: status >= 200 && status < 300 })
          if (!bytes) return { ok: false, kind: isRead ? 'server-error' : 'unknown', reason: 'answer-too-large', status }
          const json = parseJson(bytes)
          if (status >= 200 && status < 300) {
            return { ok: true, status, json: json === undefined ? null : json, text: json === undefined ? new TextDecoder().decode(bytes) : null }
          }
          if (status === 401 && !retriedAfter401) {
            // The access token stopped working (revoked, expired early): nothing was done, so drop it
            // and try once more with a fresh one (also a write: Google refused it before acting).
            forget(companyId, userId)
            retriedAfter401 = true
            attempt--
            continue
          }
          const googleReason = googleReasonOf(json)
          if (status === 429) {
            failure = { ok: false, kind: 'rate-limited', reason: 'rate-limited', status, ...(googleReason ? { googleReason } : {}) }
            const ra = Number(sent.response.headers.find(([n]) => n === 'retry-after')?.[1])
            if (Number.isFinite(ra) && ra >= 0) retryAfterMs = Math.min(ra * 1000, RETRY_AFTER_CAP_MS)
          } else if (status >= 500) {
            failure = { ok: false, kind: 'server-error', reason: 'server-error', status, ...(googleReason ? { googleReason } : {}) }
          } else {
            return { ok: false, kind: 'refused', reason: 'refused', status, ...(googleReason ? { googleReason } : {}) }
          }
          // Writes are never retried here: the caller decides (re-reading, asking the person).
          if (!isRead) return failure
        }
        if (attempt >= MAX_READ_RETRIES) return failure
        await deps.sleep(retryAfterMs ?? 1000 * 2 ** attempt)
      }
    },
  }
}

export type GoogleClient = ReturnType<typeof createGoogleClient>
