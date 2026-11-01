/**
 * The Google connection (milestone 4 G3, `.claude/rules/google-connector.md`):
 * the company's OAuth client (owner/admin, 「つなぎ先」→「Google」), a member's
 * 「Google で許可」 and 「許可をやめる」, and the stops. The member's grant,
 * the pending start, the public callback and the stops are the provider-
 * neutral services/member-oauth.ts (`.claude/rules/member-oauth.md`); this
 * module registers Google there as a provider. Every Google request goes
 * through services/google-client.ts.
 *
 * Owner decisions applied (design §4-6, §9 q10): the member allows it
 * themselves; the refresh token is sealed in the vault and never shown again;
 * only the Google account with the member's own ACB email, verified, in the
 * company's Workspace domain is accepted — anything else stores nothing.
 */
import {
  googleFeaturesOf, googleScopesFor, isGoogleFeature, isPracticeGoogleSecret, normalizeGoogleDomain, normalizeGrantedScopes,
  checkGoogleClientId, checkGoogleClientSecret, GOOGLE_FEATURES, type GoogleFeature,
} from '../../shared/core/google'
import { emailDomain } from '../../shared/core/mail'
import type {
  GoogleAdminView, GoogleChange, GoogleChangeAction, GoogleConnectStart, GoogleGrantSummary, GoogleUnavailableReason, MyGoogle,
} from '../../shared/types/google'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorChangeRow, ConnectorRepository } from '../ports/connectors'
import { requireFullAccess, type Member } from './access'
import type { BrokerVault } from './broker-vault'
import type { GoogleClient } from './google-client'
import type { MemberOAuth } from './member-oauth'
import { ok, refuse, type Outcome } from './outcome'

export const GOOGLE_FORBIDDEN = 'Only owners and admins can manage the Google connection'
const HISTORY_LIMIT = 50

export interface GoogleConnectorDeps {
  companyData: CompanyDataSource
  brokerVault: BrokerVault
  google: GoogleClient
  memberOAuth: MemberOAuth
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** `<PUBLIC_URL>/api/oauth/google/callback`, read per call (shown to the admin). */
  redirectUri(): string
  practiceGoogle: boolean
  operatorStopped(): Promise<boolean>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

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

export function createGoogleConnector(deps: GoogleConnectorDeps) {
  const { companyData, brokerVault, google, memberOAuth, accounts, clock, ids } = deps
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

  // Google as a member-level OAuth provider (member-oauth.ts runs the start, the callback and the stops).
  memberOAuth.register({
    id: 'google',
    label: 'Google',
    features: GOOGLE_FEATURES,
    unavailable: unavailableReason,
    authorizeUrl: params => google.authorizeUrl(params),
    exchangeCode: (companyId, code, verifier, redirectUri) => google.exchangeCode(companyId, code, verifier, redirectUri),
    async identify(companyId, accessToken) {
      const domain = connectorsOf(companyId).client()?.domain ?? ''
      const info = await google.userInfo(accessToken)
      if (!info || !info.email) return { ok: false, message: PAGE.failed, why: 'no-userinfo' }
      if (!info.emailVerified) return { ok: false, message: PAGE.notVerified, why: 'email-not-verified' }
      if (!domain || !info.hd || info.hd.toLowerCase() !== domain || emailDomain(info.email) !== domain) return { ok: false, message: PAGE.domain(domain), why: 'other-domain' }
      return { ok: true, email: info.email }
    },
    revoke: token => google.revoke(token),
    normalizeScopes: normalizeGrantedScopes,
    featuresOf: googleFeaturesOf,
    forget: (companyId, userId) => google.forget(companyId, userId),
    forgetCompany: companyId => google.forgetCompany(companyId),
    pages: PAGE,
  })

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
        await memberOAuth.endAllGrants('google', member.companyId, member.userId, 'revoked', 'client-changed', 'grant-revoked')
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
      if (!await memberOAuth.stopGrant('google', member.companyId, userId, member.userId)) return refuse('not-found', 'Google permission not found')
      return ok(await view(member.companyId))
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
      return ok(await memberOAuth.start('google', member, scopes, p => ({
        client_id: client.clientId,
        redirect_uri: p.redirectUri,
        response_type: 'code',
        scope: p.scope,
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        include_granted_scopes: 'true',
        hd: client.domain,
        ...(account?.email ? { login_hint: account.email } : {}),
        // A refresh token comes only with a consent: ask for it unless an active grant already holds one.
        ...(active ? {} : { prompt: 'consent' }),
      })))
    },

    /** DELETE …/me/google: 「許可をやめる」 — revoked at Google too (best effort), then nothing kept. */
    async disconnect(member: Member): Promise<Outcome<MyGoogle>> {
      await memberOAuth.disconnect('google', member)
      return ok(await myView(member))
    },
  }
}

export type GoogleConnector = ReturnType<typeof createGoogleConnector>
