/**
 * The Slack client (stage 3 A2, `.claude/rules/slack-connector.md`): the ONE
 * place in the server that talks to Slack — the OAuth endpoints for a
 * member's 「Slack で許可」 (services/slack-connector.ts), the Web API on a
 * member's behalf with their own user token (`userCall`: reading their DMs and
 * mentions, replying), the company bot's calls (`botCall`: notice DMs) and the
 * check of an event's signature (`verifySignature`).
 *
 * Every call re-checks every switch, so each stop works from the next call:
 * the operator's stop file (`slack` or `*`), the company's app present and on,
 * the vault on, the caller still a member, the member's grant active, the
 * scope granted. The client secret, signing secret, bot token and a member's
 * token come out of the vault just before they are used; none is returned,
 * logged, stored in plain text or put in an error. Slack's error bodies are
 * not passed on (only its short `error` code).
 *
 * Tokens: the company's app has token rotation off (the admin's guide says
 * so), so a member's user token (`xoxp-`) does not expire: it is what the
 * grant vault keeps in the refresh token's place. An answer with a
 * `refresh_token` (rotation on) is refused at the exchange; rotation support
 * is a later change of this file only.
 *
 * No retries here: a write (`chat.postMessage`) is never re-sent blindly — a
 * connection lost after sending is `unknown`; callers decide for reads.
 */
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorGrantRow } from '../ports/connectors'
import type { Clock } from '../ports/clock'
import type { HmacSigner, SlackDataSource } from '../ports/slack'
import type { UpstreamClient, UpstreamFailure } from '../ports/upstream'
import type { BrokerVault, ConnectorSecretContext } from './broker-vault'
import { grantSealContext } from './member-oauth'
import { isPracticeSlackSecret, SLACK_FEATURES, SLACK_HOST, type SlackFeature } from '../../shared/core/slack'

export { isSlackFeature, SLACK_FEATURES, SLACK_HOST, type SlackFeature } from '../../shared/core/slack'
export const SLACK_AUTHORIZE_PATH = '/oauth/v2/authorize'

/** The user scopes each member feature needs (always with the identity scopes). */
export const SLACK_IDENTITY_SCOPES = ['users:read', 'users:read.email'] as const
export const SLACK_FEATURE_SCOPES: Record<SlackFeature, readonly string[]> = {
  /** 自分あての DM とメンションを読む (channels are read, never kept). */
  read: ['im:history', 'mpim:history', 'channels:history', 'groups:history'],
  /** 返事を送る (as the member). */
  reply: ['chat:write'],
  /** 大事な知らせを Slack の DM で受け取る: sent by the company's bot, so nothing beyond who the member is. */
  notices: [],
}
const ALLOWED_SCOPES = new Set<string>([...SLACK_IDENTITY_SCOPES, ...Object.values(SLACK_FEATURE_SCOPES).flat()])

export function slackScopesFor(features: readonly SlackFeature[]): string[] {
  return [...new Set([...SLACK_IDENTITY_SCOPES, ...features.flatMap(f => SLACK_FEATURE_SCOPES[f])])]
}
/** Slack's report (comma- or space-separated) → the allowed scopes only. */
export function normalizeSlackScopes(granted: string): string[] {
  return [...new Set(granted.split(/[\s,]+/).filter(s => ALLOWED_SCOPES.has(s)))].sort()
}
/** A feature counts only when all its scopes (and the identity scopes) are granted. */
export function slackFeaturesOf(scopes: readonly string[]): SlackFeature[] {
  const has = (s: string) => scopes.includes(s)
  if (!SLACK_IDENTITY_SCOPES.every(has)) return []
  return SLACK_FEATURES.filter(f => SLACK_FEATURE_SCOPES[f].every(has))
}

/** Where a Slack app secret is sealed: bound to the company and the secret's name. */
export function slackAppSealContext(companyId: string, which: 'client-secret' | 'signing-secret' | 'bot-token'): ConnectorSecretContext {
  return { purpose: 'acb-slack-app', companyId, id: which }
}

const HEADERS_TIMEOUT_MS = 30_000
const MAX_ANSWER_BYTES = 4 * 1024 * 1024
/** Slack's own rule: a request older (or newer) than 5 minutes is refused (replay). */
export const SLACK_SIGNATURE_WINDOW_SECONDS = 5 * 60
const BEFORE_SENDING: readonly UpstreamFailure[] = ['private-address', 'dns', 'tls', 'practice-real-secret']

export type SlackStopReason =
  | 'operator-stopped' | 'not-configured' | 'off' | 'vault-off' | 'not-member'
  | 'no-grant' | 'grant-revoked' | 'grant-stopped' | 'scope-not-granted' | 'feature-off' | 'no-bot' | 'bad-method'

export type SlackResult =
  | { ok: true; json: Record<string, unknown> }
  | {
    ok: false
    /**
     * not-sent: nothing left ACB; refused: Slack answered `ok: false` or a 4xx
     * (`slackError`); rate-limited / server-error: 429 / 5xx; unknown: a write
     * whose answer was lost — it may have been applied (never re-send blindly).
     */
    kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown'
    reason: SlackStopReason | UpstreamFailure | 'answer-too-large' | 'refused' | 'rate-limited' | 'server-error'
    status?: number
    /** Slack's short error code (`channel_not_found`, `invalid_auth`), never more. */
    slackError?: string
  }

export interface SlackCallRequest {
  /** A Web API method (`conversations.replies`, `chat.postMessage`). */
  method: string
  params: Record<string, string>
  /** A read (retry-safe) or a write (never re-sent). */
  write: boolean
  /** A short name for the record; never content. */
  operation: string
}

export interface SlackClientDeps {
  companyData: CompanyDataSource
  slackData: SlackDataSource
  brokerVault: BrokerVault
  upstream: UpstreamClient
  hmac: HmacSigner
  clock: Clock
  isMember(companyId: string, userId: string): boolean
  /** The operator's stop file names `slack` or `*` (read on every call). */
  operatorStopped(): Promise<boolean>
  /** One AI-action-log line per call (operation name, status; never content). */
  record(companyId: string, userId: string | null, e: { operation: string; host: string; status: number | null; ok: boolean }): void
  /** Where the browser signs in (https://slack.com, or the practice Slack's origin). */
  authorizeOrigin: string
  /**
   * The practice Slack is on (staging, `ACB_FAKE_SLACK_URL`): a client secret
   * that is not a practice value is never sent (also one saved before the
   * redirect was on). Tokens are checked by the practice upstream itself.
   */
  practiceSlack?: boolean
}

const METHOD_RE = /^[a-z]+(\.[a-zA-Z]+)+$/
const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

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

function slackErrorOf(json: unknown): string | undefined {
  const e = isObj(json) ? json.error : undefined
  return typeof e === 'string' && /^[a-z_]{1,60}$/.test(e) ? e : undefined
}

export function createSlackClient(deps: SlackClientDeps) {
  const appOf = (companyId: string) => deps.slackData.forCompany(companyId)

  async function openAppSecret(companyId: string, which: 'client-secret' | 'signing-secret' | 'bot-token'): Promise<string | null> {
    if (!deps.brokerVault.status().enabled) return null
    const sealed = appOf(companyId).secret(which)
    return sealed ? deps.brokerVault.openConnector(slackAppSealContext(companyId, which), sealed) : null
  }

  /** POST a form to a Web API method (with a bearer token or none). Nothing logged. */
  async function post(method: string, form: Record<string, string>, token: string | null):
  Promise<{ status: number; json: unknown; retryAfter?: string } | { failure: UpstreamFailure | 'answer-too-large' }> {
    const body = new TextEncoder().encode(new URLSearchParams(form).toString())
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.byteLength), accept: 'application/json', 'accept-encoding': 'identity',
    }
    if (token) headers.authorization = `Bearer ${token}`
    const sent = await deps.upstream.send({
      host: SLACK_HOST, method: 'POST', path: `/api/${method}`, headers,
      body: (async function* () { yield body })(),
      allowPrivateHosts: [], signal: new AbortController().signal, headersTimeoutMs: HEADERS_TIMEOUT_MS,
    })
    if (!sent.ok) return { failure: sent.reason }
    const bytes = await readBody(sent.response.body).catch(() => null)
    if (!bytes) return { failure: 'answer-too-large' }
    let json: unknown = null
    try { json = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null } catch { json = null }
    const retryAfter = sent.response.headers.find(([n]) => n === 'retry-after')?.[1]
    return { status: sent.response.status, json, ...(retryAfter ? { retryAfter } : {}) }
  }

  /** The switches that apply to every call of the company, in order; null when all are on. */
  async function appSwitchesOff(companyId: string): Promise<SlackStopReason | null> {
    if (await deps.operatorStopped()) return 'operator-stopped'
    const app = appOf(companyId).app()
    if (!app) return 'not-configured'
    if (!app.enabled) return 'off'
    if (!deps.brokerVault.status().enabled) return 'vault-off'
    return null
  }

  function grantStop(grant: ConnectorGrantRow | null): SlackStopReason | null {
    if (!grant) return 'no-grant'
    if (grant.status === 'revoked') return 'grant-revoked'
    if (grant.status === 'stopped') return 'grant-stopped'
    return null
  }

  /** One sent call → the result, recorded once. */
  async function call(companyId: string, logUser: string | null, token: string, req: SlackCallRequest): Promise<SlackResult> {
    const answer = await post(req.method, req.params, token)
    if ('failure' in answer) {
      deps.record(companyId, logUser, { operation: req.operation, host: SLACK_HOST, status: null, ok: false })
      const before = (BEFORE_SENDING as readonly string[]).includes(answer.failure)
      return { ok: false, kind: before || !req.write ? 'not-sent' : 'unknown', reason: answer.failure }
    }
    const good = answer.status === 200 && isObj(answer.json) && answer.json.ok === true
    deps.record(companyId, logUser, { operation: req.operation, host: SLACK_HOST, status: answer.status, ok: good })
    if (good) return { ok: true, json: answer.json as Record<string, unknown> }
    const slackError = slackErrorOf(answer.json)
    const extra = { status: answer.status, ...(slackError ? { slackError } : {}) }
    if (answer.status === 429) return { ok: false, kind: 'rate-limited', reason: 'rate-limited', ...extra }
    if (answer.status >= 500) return { ok: false, kind: 'server-error', reason: 'server-error', ...extra }
    return { ok: false, kind: 'refused', reason: 'refused', ...extra }
  }

  return {
    /** The URL the member's browser opens (Slack's sign-in). */
    authorizeUrl(params: Record<string, string>): string {
      return `${deps.authorizeOrigin}${SLACK_AUTHORIZE_PATH}?${new URLSearchParams(params).toString()}`
    },

    /**
     * Exchanges an authorization code for the member's user token. With token
     * rotation on (a `refresh_token`), it is refused. The workspace is checked
     * by `identify` (so a refusal there revokes the token). Nothing logged.
     */
    async exchangeCode(companyId: string, code: string, redirectUri: string):
    Promise<{ ok: true; tokens: { accessToken: string; refreshToken: string; scopes: string } } | { ok: false; reason: string }> {
      const off = await appSwitchesOff(companyId)
      if (off) return { ok: false, reason: off }
      const app = appOf(companyId).app()!
      const secret = await openAppSecret(companyId, 'client-secret')
      if (!secret) return { ok: false, reason: 'not-configured' }
      if (deps.practiceSlack && !isPracticeSlackSecret(secret)) return { ok: false, reason: 'practice-real-secret' }
      const answer = await post('oauth.v2.access', { code, client_id: app.clientId, client_secret: secret, redirect_uri: redirectUri }, null)
      if ('failure' in answer) return { ok: false, reason: answer.failure }
      const j = answer.json
      if (answer.status !== 200 || !isObj(j) || j.ok !== true) return { ok: false, reason: slackErrorOf(j) ?? `status-${answer.status}` }
      const user = isObj(j.authed_user) ? j.authed_user : null
      if (!user || typeof user.access_token !== 'string' || !user.access_token) return { ok: false, reason: 'no-user-token' }
      if (typeof user.refresh_token === 'string') return { ok: false, reason: 'token-rotation-on' }
      return { ok: true, tokens: { accessToken: user.access_token, refreshToken: user.access_token, scopes: typeof user.scope === 'string' ? user.scope : '' } }
    },

    /** Which Slack account a user token belongs to: its workspace, its user and that user's address. */
    async identify(accessToken: string): Promise<{ teamId: string; slackUserId: string; email: string | null } | null> {
      const who = await post('auth.test', {}, accessToken)
      if ('failure' in who || !isObj(who.json) || who.json.ok !== true) return null
      const teamId = who.json.team_id
      const slackUserId = who.json.user_id
      if (typeof teamId !== 'string' || typeof slackUserId !== 'string' || !SLACK_ID_RE.test(slackUserId)) return null
      const info = await post('users.info', { user: slackUserId }, accessToken)
      if ('failure' in info || !isObj(info.json) || info.json.ok !== true || !isObj(info.json.user)) return { teamId, slackUserId, email: null }
      const profile = isObj(info.json.user.profile) ? info.json.user.profile : {}
      return { teamId, slackUserId, email: typeof profile.email === 'string' ? profile.email : null }
    },

    /** Revokes a token at Slack (best effort: false when it could not be confirmed). */
    async revoke(token: string): Promise<boolean> {
      const answer = await post('auth.revoke', {}, token)
      return !('failure' in answer) && isObj(answer.json) && answer.json.ok === true
    },

    /**
     * One Web API call with the member's own user token. Every switch, the
     * grant and the scope first; then the call.
     */
    async userCall(companyId: string, userId: string, req: SlackCallRequest & { scope: string }): Promise<SlackResult> {
      const notSent = (reason: SlackStopReason): SlackResult => ({ ok: false, kind: 'not-sent', reason })
      if (!METHOD_RE.test(req.method)) return notSent('bad-method')
      const off = await appSwitchesOff(companyId)
      if (off) return notSent(off)
      if (!deps.isMember(companyId, userId)) return notSent('not-member')
      const connectors = deps.companyData.forCompany(companyId).connectors
      const grant = connectors.grant('slack', userId)
      const stop = grantStop(grant)
      if (stop) return notSent(stop)
      if (!grant!.scopes.includes(req.scope)) return notSent('scope-not-granted')
      const stored = connectors.refreshToken('slack', userId)
      if (!stored || stored.grantId !== grant!.grantId) return notSent('grant-revoked')
      const token = await deps.brokerVault.openConnector(grantSealContext('slack', companyId, stored.grantId), stored.sealed)
      const result = await call(companyId, userId, token, req)
      connectors.touchGrant('slack', userId, deps.clock.now())
      return result
    },

    /** One Web API call as the company's bot (notice DMs). `logUser`: whom it is for, in the record. */
    async botCall(companyId: string, logUser: string | null, req: SlackCallRequest): Promise<SlackResult> {
      if (!METHOD_RE.test(req.method)) return { ok: false, kind: 'not-sent', reason: 'bad-method' }
      const off = await appSwitchesOff(companyId)
      if (off) return { ok: false, kind: 'not-sent', reason: off }
      const token = await openAppSecret(companyId, 'bot-token')
      if (!token) return { ok: false, kind: 'not-sent', reason: 'no-bot' }
      return call(companyId, logUser, token, req)
    },

    /**
     * Slack's request signature (`v0=` HMAC-SHA256 of `v0:<timestamp>:<body>`
     * with the company's signing secret), within 5 minutes of now. False when
     * the company has no app or the vault is off (nothing to check against).
     */
    async verifySignature(companyId: string, timestamp: string | undefined, signature: string | undefined, rawBody: string): Promise<boolean> {
      if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(signature)) return false
      if (Math.abs(deps.clock.nowMs() / 1000 - Number(timestamp)) > SLACK_SIGNATURE_WINDOW_SECONDS) return false
      let secret: string | null
      try {
        secret = await openAppSecret(companyId, 'signing-secret')
      } catch {
        return false
      }
      if (!secret) return false
      return deps.hmac.same(`v0=${deps.hmac.sha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`, signature)
    },
  }
}

export type SlackClient = ReturnType<typeof createSlackClient>
