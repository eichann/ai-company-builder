/**
 * The Google connection (milestone 4 G3, `.claude/rules/google-connector.md`):
 * the company's OAuth client (owner/admin, 「つなぎ先」→「Google」), a member's
 * 「Google で許可」 and 「許可をやめる」, Google's return to the server (the
 * callback), and the stops. Every Google request goes through
 * services/google-client.ts.
 *
 * Owner decisions applied (design §4-6, §9 q10): the member allows it
 * themselves; the refresh token is sealed in the vault and never shown again;
 * only the Google account with the member's own ACB email, verified, in the
 * company's Workspace domain is accepted — anything else stores nothing.
 *
 * The callback is public (Google sends the browser back without an ACB
 * session) and shared by every company: the state is `<companyId>.<random>`,
 * the company's handle is opened from it, and the pending row is found by the
 * state's sha256 inside that company only — a state of another company, a
 * forged one, a reused or an expired one finds nothing (design §3-8).
 */
import {
  googleFeaturesOf, googleScopesFor, isGoogleFeature, isPracticeGoogleSecret, normalizeGoogleDomain, normalizeGrantedScopes,
  checkGoogleClientId, checkGoogleClientSecret, sameEmail, GOOGLE_FEATURES, type GoogleFeature,
} from '../../shared/core/google'
import { emailDomain } from '../../shared/core/mail'
import type {
  GoogleAdminView, GoogleChange, GoogleChangeAction, GoogleConnectStart, GoogleGrantSummary, GoogleUnavailableReason, MyGoogle,
} from '../../shared/types/google'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorChangeRow, ConnectorRepository } from '../ports/connectors'
import type { TokenDigest } from '../ports/key-broker'
import { logError } from '../lib/error-log'
import { requireFullAccess, type Member } from './access'
import type { BrokerVault } from './broker-vault'
import type { GoogleClient } from './google-client'
import { ok, refuse, type Outcome } from './outcome'

export const GOOGLE_FORBIDDEN = 'Only owners and admins can manage the Google connection'
const PENDING_MINUTES = 10
const HISTORY_LIMIT = 50

export interface GoogleConnectorDeps {
  companyData: CompanyDataSource
  brokerVault: BrokerVault
  google: GoogleClient
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  tokenDigest: TokenDigest
  isMember(companyId: string, userId: string): boolean
  /** `<PUBLIC_URL>/api/oauth/google/callback`, read per call. */
  redirectUri(): string
  practiceGoogle: boolean
  operatorStopped(): Promise<boolean>
  /** Warnings (reason codes and ids only); default console. */
  log?: Pick<Console, 'warn'>
}

/** The page the browser shows after Google sent it back. */
export interface CallbackPage {
  granted: boolean
  /** One plain Japanese sentence: no secret, nobody's email. */
  message: string
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A state as the server makes it: `<companyId>.<64 hex>`. */
const STATE_RE = /^([A-Za-z0-9_-]{1,100})\.([0-9a-f]{64})$/

const PAGE = {
  granted: '許可しました。アプリに戻ってください。',
  expired: 'この許可の手続きは使えません（10分を過ぎたか、すでに使われています）。アプリからもう一度「Google で許可」を押してください。',
  denied: 'Google で許可されませんでした。許可は保存していません。',
  unavailable: 'いまは Google とつなげません。管理者に確かめてください。許可は保存していません。',
  failed: 'Google とのやりとりがうまくいきませんでした。少し待ってから、アプリでもう一度「Google で許可」を押してください。許可は保存していません。',
  notVerified: 'この Google アカウントのメールアドレスが確かめられていません。許可は保存していません。',
  domain: (domain: string) => `会社の Google アカウント（@${domain}）で許可してください。許可は保存していません。`,
  email: 'ACB に登録しているメールアドレスと同じ Google アカウントで許可してください。許可は保存していません。',
  noRefresh: 'Google から必要な情報が届きませんでした。アプリで「許可をやめる」を押してから、もう一度「Google で許可」を押してください。許可は保存していません。',
}

/** sha256 in hex → base64url (PKCE S256 challenge), without Node's Buffer. */
function hexToBase64Url(hex: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += alphabet[n & 63]
  }
  return out
}

export function createGoogleConnector(deps: GoogleConnectorDeps) {
  const { companyData, brokerVault, google, accounts, clock, ids } = deps
  const log = deps.log ?? console
  const connectorsOf = (companyId: string): ConnectorRepository => companyData.forCompany(companyId).connectors

  function change(action: GoogleChangeAction, by: string, userId: string | null, detail: Record<string, unknown>): ConnectorChangeRow {
    return { id: ids.newId(), provider: 'google', action, userId, at: clock.now(), by, change: JSON.stringify(detail) }
  }

  async function unavailableReason(companyId: string): Promise<GoogleUnavailableReason | null> {
    if (await deps.operatorStopped()) return 'operator-stopped'
    const client = connectorsOf(companyId).client()
    if (!client) return 'not-configured'
    if (!client.enabled) return 'off'
    if (!brokerVault.status().enabled) return 'vault-off'
    return null
  }

  async function view(companyId: string): Promise<GoogleAdminView> {
    const connectors = connectorsOf(companyId)
    const client = connectors.client()
    const grants = connectors.grants('google')
    const history = connectors.history('google', HISTORY_LIMIT)
    const people = accounts.byIds([...new Set([...grants.map(g => g.userId), ...history.map(h => h.by), ...(client ? [client.updatedBy] : [])])])
    return {
      vaultEnabled: brokerVault.status().enabled,
      configured: client !== null,
      clientId: client?.clientId ?? null,
      secretLast4: client?.secretLast4 ?? null,
      domain: client?.domain ?? null,
      enabled: client?.enabled ?? false,
      redirectUri: deps.redirectUri(),
      practice: deps.practiceGoogle,
      operatorStopped: await deps.operatorStopped(),
      updatedAt: client?.updatedAt ?? null,
      updatedBy: client?.updatedBy ?? null,
      grants: grants.map((g): GoogleGrantSummary => ({
        userId: g.userId,
        memberEmail: people.get(g.userId)?.email ?? null,
        memberName: people.get(g.userId)?.name ?? null,
        googleEmail: g.accountEmail,
        features: googleFeaturesOf(g.scopes),
        scopes: g.scopes,
        status: g.status,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        lastUsedAt: g.lastUsedAt,
      })),
      history: history.map((h): GoogleChange => {
        let detail: Record<string, unknown> = {}
        try { detail = JSON.parse(h.change) as Record<string, unknown> } catch { /* unreadable: shown empty */ }
        return { id: h.id, action: h.action as GoogleChangeAction, at: h.at, by: h.by, byName: people.get(h.by)?.name ?? null, userId: h.userId, detail }
      }),
    }
  }

  async function myView(member: Member): Promise<MyGoogle> {
    const connectors = connectorsOf(member.companyId)
    const client = connectors.client()
    const grant = connectors.grant('google', member.userId)
    const reason = await unavailableReason(member.companyId)
    return {
      available: reason === null,
      reason,
      connected: grant?.status === 'active',
      status: grant?.status ?? null,
      googleEmail: grant?.accountEmail ?? null,
      features: grant?.status === 'active' ? googleFeaturesOf(grant.scopes) : [],
      domain: client?.domain ?? null,
      practice: deps.practiceGoogle,
    }
  }

  /**
   * Ends every active grant of the company as `status` now (locally, at once),
   * then revokes the tokens at Google in the background (best effort).
   */
  async function endAllGrants(companyId: string, by: string, status: 'revoked' | 'stopped', reason: string, action: GoogleChangeAction): Promise<number> {
    const connectors = connectorsOf(companyId)
    const sealed = connectors.grants('google').filter(g => g.status === 'active')
      .map(g => ({ userId: g.userId, stored: connectors.refreshToken('google', g.userId) }))
    let ended = 0
    for (const { userId } of sealed) {
      if (connectors.endGrant('google', userId, status, reason, clock.now(), change(action, by, userId, { reason }))) ended++
      google.forget(companyId, userId)
    }
    google.forgetCompany(companyId)
    if (brokerVault.status().enabled) {
      void (async () => {
        for (const { stored } of sealed) {
          if (!stored) continue
          try {
            const token = await brokerVault.openConnector({ purpose: 'acb-google-grant', companyId, id: stored.grantId }, stored.sealed)
            await google.revoke(token)
          } catch (err) {
            logError('google', 'revoking a stopped grant at Google failed', err, { company: companyId })
          }
        }
      })()
    }
    return ended
  }

  return {
    /** GET …/google (owner/admin). */
    async adminView(member: Member): Promise<Outcome<GoogleAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(await view(member.companyId))
    },

    /** PUT …/google/client { clientId, clientSecret?, domain } (owner/admin). */
    async saveClient(member: Member, body: unknown): Promise<Outcome<GoogleAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const idError = checkGoogleClientId(body.clientId)
      if (idError) return refuse('bad-request', idError, { code: 'BAD_CLIENT_ID' })
      const domain = normalizeGoogleDomain(body.domain)
      if ('error' in domain) return refuse('bad-request', domain.error, { code: 'BAD_DOMAIN' })
      const hasSecret = body.clientSecret !== undefined && body.clientSecret !== null && body.clientSecret !== ''
      if (hasSecret) {
        const secretError = checkGoogleClientSecret(body.clientSecret)
        if (secretError) return refuse('bad-request', secretError, { code: 'BAD_CLIENT_SECRET' })
      }
      const connectors = connectorsOf(member.companyId)
      const before = connectors.client()
      if (!before && !hasSecret) return refuse('bad-request', 'クライアント シークレットを入れてください。', { code: 'BAD_CLIENT_SECRET' })
      if (!brokerVault.status().enabled) {
        return refuse('unavailable', 'サーバーに鍵の金庫が用意されていないため、登録できません。運用担当者に確かめてください。', { code: 'BROKER_OFF' })
      }
      const clientId = (body.clientId as string).trim()
      const secret = hasSecret ? (body.clientSecret as string).trim() : null
      // Staging: only the fake Google's secrets (a real one would go to the practice copy).
      if (secret !== null && deps.practiceGoogle && !isPracticeGoogleSecret(secret)) {
        return refuse('bad-request', '練習用の Google につながっているため、本物のクライアント シークレットは登録できません（練習用の値だけ）。', { code: 'REAL_KEY_ON_PRACTICE' })
      }
      const sealed = secret === null ? null : {
        sealed: await brokerVault.sealConnector({ purpose: 'acb-google-client', companyId: member.companyId, id: 'google-client' }, secret),
        last4: secret.slice(-4),
      }
      connectors.saveClient({ clientId, domain: domain.value, at: clock.now(), by: member.userId }, sealed, change('client', member.userId, null, {
        before: before ? { clientId: before.clientId, secretLast4: before.secretLast4, domain: before.domain } : null,
        after: { clientId, secretLast4: sealed?.last4 ?? before?.secretLast4 ?? null, domain: domain.value },
      }))
      // Tokens of another client, or accounts of another domain, no longer fit: members allow again.
      if (before && (before.clientId !== clientId || before.domain !== domain.value)) {
        await endAllGrants(member.companyId, member.userId, 'revoked', 'client-changed', 'grant-revoked')
      }
      google.forgetCompany(member.companyId)
      return ok(await view(member.companyId))
    },

    /** PUT …/google/enabled { enabled } (owner/admin): off stops every member's use from the next call. */
    async setEnabled(member: Member, body: unknown): Promise<Outcome<GoogleAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body) || typeof body.enabled !== 'boolean') return refuse('bad-request', 'enabled must be true or false')
      const connectors = connectorsOf(member.companyId)
      const client = connectors.client()
      if (!client) return refuse('not-found', 'Google の登録がまだありません。', { code: 'NOT_CONFIGURED' })
      if (client.enabled !== body.enabled) {
        connectors.setClientEnabled(body.enabled, clock.now(), member.userId, change('enabled', member.userId, null, { enabled: body.enabled }))
      }
      google.forgetCompany(member.companyId)
      return ok(await view(member.companyId))
    },

    /** DELETE …/google/grants/:userId (owner/admin): stops a member's grant (revoked at Google too). */
    async stopGrant(member: Member, userId: string): Promise<Outcome<GoogleAdminView>> {
      const allowed = requireFullAccess(member, GOOGLE_FORBIDDEN)
      if (!allowed.ok) return allowed
      const connectors = connectorsOf(member.companyId)
      const grant = connectors.grant('google', userId)
      if (!grant) return refuse('not-found', 'Google permission not found')
      if (grant.status === 'active') {
        const revoked = await google.revokeStored(member.companyId, userId)
        connectors.endGrant('google', userId, 'stopped', 'admin', clock.now(), change('grant-stopped', member.userId, userId, { reason: 'admin', revokedAtGoogle: revoked }))
        google.forget(member.companyId, userId)
      }
      return ok(await view(member.companyId))
    },

    /** 「すべての鍵を止める」 (key broker stop-all): every active grant of the company stops now. */
    async stopAll(companyId: string, by: string): Promise<number> {
      return endAllGrants(companyId, by, 'stopped', 'stop-all', 'stop-all')
    },

    /** GET …/me/google (any member). */
    async my(member: Member): Promise<Outcome<MyGoogle>> {
      return ok(await myView(member))
    },

    /** POST …/me/google/connect { features } → the URL the member's browser opens. */
    async connect(member: Member, body: unknown): Promise<Outcome<GoogleConnectStart>> {
      if (!isObject(body) || !Array.isArray(body.features) || body.features.length === 0 || !body.features.every(isGoogleFeature)) {
        return refuse('bad-request', `features must list one or more of: ${GOOGLE_FEATURES.join(', ')}`)
      }
      const reason = await unavailableReason(member.companyId)
      if (reason) return refuse('conflict', 'いまは Google とつなげません。管理者に確かめてください。', { code: 'GOOGLE_UNAVAILABLE', reason })
      const connectors = connectorsOf(member.companyId)
      const client = connectors.client()!
      const creds = await google.clientCredentials(member.companyId)
      if ('stop' in creds) return refuse('conflict', 'いまは Google とつなげません。管理者に確かめてください。', { code: 'GOOGLE_UNAVAILABLE', reason: creds.stop })
      const account = accounts.byIds([member.userId]).get(member.userId)
      const grant = connectors.grant('google', member.userId)
      const active = grant?.status === 'active'
      // Ask for what the member already allowed too (incremental: Google merges them).
      const features = new Set<GoogleFeature>(body.features as GoogleFeature[])
      if (active) for (const f of googleFeaturesOf(grant!.scopes)) features.add(f)
      const scopes = googleScopesFor([...features])

      const now = clock.nowMs()
      const state = `${member.companyId}.${ids.newToken()}`
      const verifier = ids.newToken()
      const stateHash = deps.tokenDigest.digest(state)
      connectors.prunePending(clock.now(), member.userId)
      connectors.putPending({
        stateHash, provider: 'google', userId: member.userId, scopes,
        verifier: await brokerVault.sealConnector({ purpose: 'acb-oauth-pending', companyId: member.companyId, id: stateHash }, verifier),
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PENDING_MINUTES * 60_000).toISOString(),
      })
      const params: Record<string, string> = {
        client_id: client.clientId,
        redirect_uri: deps.redirectUri(),
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        code_challenge: hexToBase64Url(deps.tokenDigest.digest(verifier)),
        code_challenge_method: 'S256',
        access_type: 'offline',
        include_granted_scopes: 'true',
        hd: client.domain,
        ...(account?.email ? { login_hint: account.email } : {}),
        // A refresh token comes only with a consent: ask for it unless an active grant already holds one.
        ...(active ? {} : { prompt: 'consent' }),
      }
      return ok({ authorizeUrl: google.authorizeUrl(params), expiresAt: new Date(now + PENDING_MINUTES * 60_000).toISOString() })
    },

    /** DELETE …/me/google: 「許可をやめる」 — revoked at Google too (best effort), then nothing kept. */
    async disconnect(member: Member): Promise<Outcome<MyGoogle>> {
      const connectors = connectorsOf(member.companyId)
      const grant = connectors.grant('google', member.userId)
      if (grant) {
        const revoked = grant.status === 'active' ? await google.revokeStored(member.companyId, member.userId) : false
        connectors.deleteGrant('google', member.userId, change('grant-revoked', member.userId, member.userId, { reason: 'member', revokedAtGoogle: revoked }))
        google.forget(member.companyId, member.userId)
      }
      connectors.prunePending(clock.now(), member.userId)
      return ok(await myView(member))
    },

    /**
     * GET /api/oauth/google/callback?code&state[&error] (public). Stores the
     * grant only when everything holds; otherwise nothing at all.
     */
    async callback(query: { state?: string; code?: string; error?: string }): Promise<CallbackPage> {
      const refused = (message: string): CallbackPage => ({ granted: false, message })
      const m = STATE_RE.exec(query.state ?? '')
      if (!m) return refused(PAGE.expired)
      const companyId = m[1]
      // The company comes from the state, and the pending row is looked for inside that company only.
      const connectors = connectorsOf(companyId)
      const pending = connectors.takePending(deps.tokenDigest.digest(query.state!), clock.now())
      if (!pending || pending.provider !== 'google') return refused(PAGE.expired)
      if (query.error) return refused(PAGE.denied)
      if (!query.code || query.code.length > 2048) return refused(PAGE.failed)
      if (await unavailableReason(companyId)) return refused(PAGE.unavailable)
      if (!deps.isMember(companyId, pending.userId)) return refused(PAGE.unavailable)
      const client = connectors.client()!

      let verifier: string
      try {
        verifier = await brokerVault.openConnector({ purpose: 'acb-oauth-pending', companyId, id: pending.stateHash }, pending.verifier)
      } catch (err) {
        logError('google', 'a pending start could not be opened', err, { company: companyId })
        return refused(PAGE.failed)
      }
      const exchanged = await google.exchangeCode(companyId, query.code, verifier, deps.redirectUri())
      if (!exchanged.ok) {
        log.warn(`[google] code exchange refused: ${exchanged.reason} company=${companyId}`)
        return refused(PAGE.failed)
      }
      const tokens = exchanged.tokens
      // Whatever is refused below: the tokens Google just issued are revoked, so nothing lingers.
      const refuseAndRevoke = async (message: string, why: string): Promise<CallbackPage> => {
        await google.revoke(tokens.refreshToken ?? tokens.accessToken).catch(() => false)
        log.warn(`[google] permission refused: ${why} company=${companyId} user=${pending.userId}`)
        return refused(message)
      }
      const info = await google.userInfo(tokens.accessToken)
      if (!info || !info.email) return refuseAndRevoke(PAGE.failed, 'no-userinfo')
      if (!info.emailVerified) return refuseAndRevoke(PAGE.notVerified, 'email-not-verified')
      if (!info.hd || info.hd.toLowerCase() !== client.domain || emailDomain(info.email) !== client.domain) return refuseAndRevoke(PAGE.domain(client.domain), 'other-domain')
      const account = accounts.byIds([pending.userId]).get(pending.userId)
      if (!account || !sameEmail(account.email, info.email)) return refuseAndRevoke(PAGE.email, 'other-account')

      const scopes = normalizeGrantedScopes(tokens.scopes)
      const now = clock.now()
      const existing = connectors.grant('google', pending.userId)
      if (!tokens.refreshToken) {
        // Incremental consent may come without a new refresh token: the stored one now covers the merged scopes.
        if (existing?.status === 'active' && connectors.refreshToken('google', pending.userId)) {
          connectors.setGrantScopes('google', pending.userId, scopes, now, change('grant', pending.userId, pending.userId, { features: googleFeaturesOf(scopes), consent: 'added' }))
          google.forget(companyId, pending.userId)
          return { granted: true, message: PAGE.granted }
        }
        return refuseAndRevoke(PAGE.noRefresh, 'no-refresh-token')
      }
      // A new consent replaces the old token (deleted here, not revoked at Google: revoking any
      // token of the app ends the person's whole consent, the new one included — google-connector.md).
      const grantId = ids.newId()
      const sealed = await brokerVault.sealConnector({ purpose: 'acb-google-grant', companyId, id: grantId }, tokens.refreshToken)
      connectors.putGrant({
        userId: pending.userId, provider: 'google', grantId, accountEmail: info.email.trim().toLowerCase(), scopes,
        createdAt: now, updatedAt: now,
      }, sealed, change('grant', pending.userId, pending.userId, { features: googleFeaturesOf(scopes), consent: existing ? 'replaced' : 'new' }))
      google.forget(companyId, pending.userId)
      return { granted: true, message: PAGE.granted }
    },
  }
}

export type GoogleConnector = ReturnType<typeof createGoogleConnector>
