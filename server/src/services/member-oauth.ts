/**
 * A member's own permission at an outside provider (Google today, Slack next),
 * provider-neutral (`.claude/rules/member-oauth.md`): the grant vault
 * (`connector_grants`), the pending starts (`oauth_pending`: state, PKCE),
 * sealing with the company's key, the stops and the history. A provider
 * plugs in with a descriptor (`OAuthProviderDescriptor`): its sign-in URL,
 * code exchange, how it tells which account was allowed, revoke, scopes →
 * features, and its switches. Google is the first provider
 * (services/google-connector.ts registers it).
 *
 * The callback is public and shared by every company and provider: the state
 * is `<companyId>.<64 hex>`, the pending row is taken by the state's sha256
 * inside that company only, and it must belong to the provider the browser
 * came back to. A grant is stored and read under its provider, and its token
 * is sealed under a per-provider purpose bound to the company and the grant
 * id, so one provider's grant never serves another, nor another company.
 *
 * Secrets (the refresh token, the verifier, codes, access tokens) are never
 * answered, logged or stored in plain text.
 */
import { normalizeEmail } from '../../shared/core/mail'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ConnectorChangeRow, ConnectorGrantRow, ConnectorProvider, ConnectorRepository } from '../ports/connectors'
import type { TokenDigest } from '../ports/key-broker'
import { logError } from '../lib/error-log'
import type { Member } from './access'
import type { BrokerVault, ConnectorSecretContext } from './broker-vault'

/** Emails compared as ACB stores them (`normalizeEmail`); an unreadable one matches nothing. Provider-neutral. */
function sameEmail(a: string, b: string): boolean {
  const x = normalizeEmail(a)
  return x !== null && x === normalizeEmail(b)
}

export const PENDING_MINUTES = 10

/** A state as the server makes it: `<companyId>.<64 hex>`. */
const STATE_RE = /^([A-Za-z0-9_-]{1,100})\.([0-9a-f]{64})$/

/** History actions of grants (the provider's own client / switch actions are its own). */
export type GrantChangeAction = 'grant' | 'grant-revoked' | 'grant-stopped' | 'grant-features' | 'stop-all'

/** Where the provider sends the browser back (Google's is registered in each company's Google Cloud client). */
export function oauthCallbackPath(provider: ConnectorProvider): string {
  return `/api/oauth/${provider}/callback`
}

/** Where a member's refresh token is sealed: per provider, bound to the company and the grant. */
export function grantSealContext(provider: ConnectorProvider, companyId: string, grantId: string): ConnectorSecretContext {
  return { purpose: `acb-${provider}-grant`, companyId, id: grantId }
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string | null
  /** Space-separated, as the provider reports them. */
  scopes: string
}

/** The page the browser shows after the provider sent it back. */
export interface CallbackPage {
  granted: boolean
  /** One plain Japanese sentence: no secret, nobody's email. */
  message: string
  /** The page heading's provider name (「Google の許可」). */
  label: string
}

export interface OAuthProviderDescriptor {
  id: ConnectorProvider
  /** On screen: 「<label> の許可」. */
  label: string
  /** The member features this provider offers (e.g. Google: minutes, mail): a grant carries which are off. */
  features: readonly string[]
  /** Why the provider cannot be used in this company now (operator stop, client, switch, vault), or null. */
  unavailable(companyId: string): Promise<string | null>
  /** The provider's sign-in URL for these parameters. */
  authorizeUrl(params: Record<string, string>): string
  exchangeCode(companyId: string, code: string, verifier: string, redirectUri: string): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; reason: string }>
  /**
   * Which account the tokens belong to, after the provider's own checks
   * (Google: verified, the company's domain). The service then requires it to
   * be the member's own ACB email.
   */
  identify(companyId: string, accessToken: string): Promise<{ ok: true; email: string } | { ok: false; message: string; why: string }>
  /** Revokes a token at the provider (best effort). */
  revoke(token: string): Promise<boolean>
  /** The provider's report of granted scopes → the allowed ones only. */
  normalizeScopes(granted: string): string[]
  featuresOf(scopes: readonly string[]): string[]
  /** Drop cached access tokens. */
  forget(companyId: string, userId: string): void
  forgetCompany(companyId: string): void
  /** The callback page's sentences. */
  pages: { granted: string; expired: string; denied: string; unavailable: string; failed: string; email: string; noRefresh: string }
}

export interface MemberOAuthDeps {
  companyData: CompanyDataSource
  brokerVault: BrokerVault
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  tokenDigest: TokenDigest
  isMember(companyId: string, userId: string): boolean
  /** `<PUBLIC_URL>/api/oauth/<provider>/callback`, read per call. */
  redirectUri(provider: ConnectorProvider): string
  /** Warnings (reason codes and ids only); default console. */
  log?: Pick<Console, 'warn'>
}

export function createMemberOAuth(deps: MemberOAuthDeps) {
  const { companyData, brokerVault, accounts, clock, ids } = deps
  const log = deps.log ?? console
  const providers = new Map<ConnectorProvider, OAuthProviderDescriptor>()
  const connectorsOf = (companyId: string): ConnectorRepository => companyData.forCompany(companyId).connectors

  function change(provider: ConnectorProvider, action: string, by: string, userId: string | null, detail: Record<string, unknown>): ConnectorChangeRow {
    return { id: ids.newId(), provider, action, userId, at: clock.now(), by, change: JSON.stringify(detail) }
  }
  /** `revokedAtGoogle`, `revokedAtSlack` (the history key Google's rows have had since milestone 4). */
  const revokedKey = (p: OAuthProviderDescriptor) => `revokedAt${p.label}`

  function descriptor(provider: ConnectorProvider): OAuthProviderDescriptor {
    const p = providers.get(provider)
    if (!p) throw new Error(`OAuth provider not registered: ${provider}`)
    return p
  }

  /** The member's stored refresh token, opened (only an active grant of this provider). */
  async function openRefreshToken(provider: ConnectorProvider, companyId: string, userId: string): Promise<{ grantId: string; token: string } | null> {
    if (!brokerVault.status().enabled) return null
    const stored = connectorsOf(companyId).refreshToken(provider, userId)
    if (!stored) return null
    return { grantId: stored.grantId, token: await brokerVault.openConnector(grantSealContext(provider, companyId, stored.grantId), stored.sealed) }
  }

  async function revokeStored(provider: ConnectorProvider, companyId: string, userId: string): Promise<boolean> {
    try {
      const opened = await openRefreshToken(provider, companyId, userId)
      return opened ? await descriptor(provider).revoke(opened.token) : false
    } catch {
      return false
    }
  }

  /**
   * Ends every active grant of the provider in the company as `status` now
   * (locally, at once), then revokes the tokens at the provider in the
   * background (best effort).
   */
  async function endAllGrants(provider: ConnectorProvider, companyId: string, by: string, status: 'revoked' | 'stopped', reason: string, action: string): Promise<number> {
    const p = descriptor(provider)
    const connectors = connectorsOf(companyId)
    const sealed = connectors.grants(provider).filter(g => g.status === 'active')
      .map(g => ({ userId: g.userId, stored: connectors.refreshToken(provider, g.userId) }))
    let ended = 0
    for (const { userId } of sealed) {
      if (connectors.endGrant(provider, userId, status, reason, clock.now(), change(provider, action, by, userId, { reason }))) ended++
      p.forget(companyId, userId)
    }
    p.forgetCompany(companyId)
    if (brokerVault.status().enabled) {
      void (async () => {
        for (const { stored } of sealed) {
          if (!stored) continue
          try {
            await p.revoke(await brokerVault.openConnector(grantSealContext(provider, companyId, stored.grantId), stored.sealed))
          } catch (err) {
            logError(provider, 'revoking a stopped grant at the provider failed', err, { company: companyId })
          }
        }
      })()
    }
    return ended
  }

  return {
    register(p: OAuthProviderDescriptor): void {
      providers.set(p.id, p)
    },

    /** The member's grant of this provider in this company (null: none). */
    grant(provider: ConnectorProvider, companyId: string, userId: string): ConnectorGrantRow | null {
      return connectorsOf(companyId).grant(provider, userId)
    },

    openRefreshToken,
    revokeStored,
    endAllGrants,

    /**
     * Starts a member's 「<provider> で許可」: a new single-use pending row
     * (the member's earlier ones removed) and the sign-in URL, whose
     * parameters the provider's connector builds around the state, the PKCE
     * challenge, the redirect URI and the scopes.
     */
    async start(provider: ConnectorProvider, member: Member, scopes: string[],
      params: (p: { state: string; codeChallenge: string; redirectUri: string; scope: string }) => Record<string, string>): Promise<{ authorizeUrl: string; expiresAt: string }> {
      const p = descriptor(provider)
      const connectors = connectorsOf(member.companyId)
      const now = clock.nowMs()
      const state = `${member.companyId}.${ids.newToken()}`
      const verifier = ids.newToken()
      const stateHash = deps.tokenDigest.digest(state)
      const expiresAt = new Date(now + PENDING_MINUTES * 60_000).toISOString()
      connectors.prunePending(clock.now(), member.userId)
      connectors.putPending({
        stateHash, provider, userId: member.userId, scopes,
        verifier: await brokerVault.sealConnector({ purpose: 'acb-oauth-pending', companyId: member.companyId, id: stateHash }, verifier),
        createdAt: new Date(now).toISOString(), expiresAt,
      })
      const authorizeUrl = p.authorizeUrl(params({
        state, codeChallenge: hexToBase64Url(deps.tokenDigest.digest(verifier)), redirectUri: deps.redirectUri(provider), scope: scopes.join(' '),
      }))
      return { authorizeUrl, expiresAt }
    },

    /** Admin 「止める」 one member: revoked at the provider too; false when the member has no grant. */
    async stopGrant(provider: ConnectorProvider, companyId: string, userId: string, by: string): Promise<boolean> {
      const p = descriptor(provider)
      const connectors = connectorsOf(companyId)
      const grant = connectors.grant(provider, userId)
      if (!grant) return false
      if (grant.status === 'active') {
        const revoked = await revokeStored(provider, companyId, userId)
        connectors.endGrant(provider, userId, 'stopped', 'admin', clock.now(), change(provider, 'grant-stopped', by, userId, { reason: 'admin', [revokedKey(p)]: revoked }))
        p.forget(companyId, userId)
      }
      return true
    },

    /**
     * The member turns one feature of their own grant on or off (owner decision
     * 2026-11-01, e.g. Google 受信を読む): kept in `features_off`, enforced by the
     * provider's client from the next call, kept across a re-consent, gone with
     * 「許可をやめる」. Nothing is asked of the provider. `no-grant` when the member
     * has no grant; an unknown feature is the caller's to refuse (`bad-feature`).
     */
    setFeatureOff(provider: ConnectorProvider, member: Member, feature: string, off: boolean): { ok: true; featuresOff: string[] } | { ok: false; reason: 'no-grant' | 'bad-feature' } {
      const p = descriptor(provider)
      if (!p.features.includes(feature)) return { ok: false, reason: 'bad-feature' }
      const connectors = connectorsOf(member.companyId)
      const grant = connectors.grant(provider, member.userId)
      if (!grant) return { ok: false, reason: 'no-grant' }
      const was = grant.featuresOff.includes(feature)
      if (was === off) return { ok: true, featuresOff: grant.featuresOff }
      const next = p.features.filter(f => (f === feature ? off : grant.featuresOff.includes(f)))
      connectors.setFeaturesOff(provider, member.userId, next, clock.now(), change(provider, 'grant-features', member.userId, member.userId, { feature, off }))
      return { ok: true, featuresOff: next }
    },

    /** The member's 「許可をやめる」: revoked at the provider too (best effort), then nothing kept. */
    async disconnect(provider: ConnectorProvider, member: Member): Promise<void> {
      const p = descriptor(provider)
      const connectors = connectorsOf(member.companyId)
      const grant = connectors.grant(provider, member.userId)
      if (grant) {
        const revoked = grant.status === 'active' ? await revokeStored(provider, member.companyId, member.userId) : false
        connectors.deleteGrant(provider, member.userId, change(provider, 'grant-revoked', member.userId, member.userId, { reason: 'member', [revokedKey(p)]: revoked }))
        p.forget(member.companyId, member.userId)
      }
      connectors.prunePending(clock.now(), member.userId)
    },

    /** 「すべての鍵を止める」: every active grant of every provider in the company stops now. */
    async stopAll(companyId: string, by: string): Promise<number> {
      let ended = 0
      for (const provider of providers.keys()) ended += await endAllGrants(provider, companyId, by, 'stopped', 'stop-all', 'stop-all')
      return ended
    },

    /**
     * GET /api/oauth/:provider/callback?code&state[&error] (public). Stores the
     * grant only when everything holds; otherwise nothing at all. null: no
     * such provider.
     */
    async callback(provider: string, query: { state?: string; code?: string; error?: string }): Promise<CallbackPage | null> {
      const p = providers.get(provider as ConnectorProvider)
      if (!p) return null
      const refused = (message: string): CallbackPage => ({ granted: false, message, label: p.label })
      const m = STATE_RE.exec(query.state ?? '')
      if (!m) return refused(p.pages.expired)
      const companyId = m[1]
      // The company comes from the state, and the pending row is looked for inside that company only;
      // it must have been started for this provider.
      const connectors = connectorsOf(companyId)
      const pending = connectors.takePending(deps.tokenDigest.digest(query.state!), clock.now())
      if (!pending || pending.provider !== p.id) return refused(p.pages.expired)
      if (query.error) return refused(p.pages.denied)
      if (!query.code || query.code.length > 2048) return refused(p.pages.failed)
      if (await p.unavailable(companyId)) return refused(p.pages.unavailable)
      if (!deps.isMember(companyId, pending.userId)) return refused(p.pages.unavailable)

      let verifier: string
      try {
        verifier = await brokerVault.openConnector({ purpose: 'acb-oauth-pending', companyId, id: pending.stateHash }, pending.verifier)
      } catch (err) {
        logError(p.id, 'a pending start could not be opened', err, { company: companyId })
        return refused(p.pages.failed)
      }
      const exchanged = await p.exchangeCode(companyId, query.code, verifier, deps.redirectUri(p.id))
      if (!exchanged.ok) {
        log.warn(`[${p.id}] code exchange refused: ${exchanged.reason} company=${companyId}`)
        return refused(p.pages.failed)
      }
      const tokens = exchanged.tokens
      // Whatever is refused below: the tokens just issued are revoked, so nothing lingers.
      const refuseAndRevoke = async (message: string, why: string): Promise<CallbackPage> => {
        await p.revoke(tokens.refreshToken ?? tokens.accessToken).catch(() => false)
        log.warn(`[${p.id}] permission refused: ${why} company=${companyId} user=${pending.userId}`)
        return refused(message)
      }
      const who = await p.identify(companyId, tokens.accessToken)
      if (!who.ok) return refuseAndRevoke(who.message, who.why)
      const account = accounts.byIds([pending.userId]).get(pending.userId)
      if (!account || !sameEmail(account.email, who.email)) return refuseAndRevoke(p.pages.email, 'other-account')

      const scopes = p.normalizeScopes(tokens.scopes)
      const now = clock.now()
      const existing = connectors.grant(p.id, pending.userId)
      if (!tokens.refreshToken) {
        // Incremental consent may come without a new refresh token: the stored one now covers the merged scopes.
        if (existing?.status === 'active' && connectors.refreshToken(p.id, pending.userId)) {
          connectors.setGrantScopes(p.id, pending.userId, scopes, now, change(p.id, 'grant', pending.userId, pending.userId, { features: p.featuresOf(scopes), consent: 'added' }))
          p.forget(companyId, pending.userId)
          return { granted: true, message: p.pages.granted, label: p.label }
        }
        return refuseAndRevoke(p.pages.noRefresh, 'no-refresh-token')
      }
      // A new consent replaces the old token (deleted here, not revoked at the provider: at Google,
      // revoking any token of the app ends the person's whole consent, the new one included).
      const grantId = ids.newId()
      const sealed = await brokerVault.sealConnector(grantSealContext(p.id, companyId, grantId), tokens.refreshToken)
      connectors.putGrant({
        userId: pending.userId, provider: p.id, grantId, accountEmail: who.email.trim().toLowerCase(), scopes,
        createdAt: now, updatedAt: now,
      }, sealed, change(p.id, 'grant', pending.userId, pending.userId, { features: p.featuresOf(scopes), consent: existing ? 'replaced' : 'new' }))
      p.forget(companyId, pending.userId)
      return { granted: true, message: p.pages.granted, label: p.label }
    },
  }
}

export type MemberOAuth = ReturnType<typeof createMemberOAuth>

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
