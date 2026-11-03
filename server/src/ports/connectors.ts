/**
 * The connectors' storage, behind the company handle: the company's Google
 * OAuth client (`.claude/rules/google-connector.md`) and, for every provider,
 * members' grants, the pending 「… で許可」 starts and their history
 * (`.claude/rules/member-oauth.md`). Every method is limited to the handle's
 * company; grants and pending starts are always read under their provider.
 *
 * Secrets are passed and returned only as sealed envelopes (the vault seals
 * and opens them); the listing methods never return one.
 */
import type { SealedSecret } from './secret-cipher'

/** Providers with member-level OAuth (the CHECK of connector_grants / oauth_pending lists the same). */
export const CONNECTOR_PROVIDERS = ['google', 'slack'] as const
export type ConnectorProvider = typeof CONNECTOR_PROVIDERS[number]

export interface OAuthClientRow {
  clientId: string
  secretLast4: string
  domain: string
  enabled: boolean
  /**
   * The admin's company-level switches over each feature's default (`GOOGLE_COMPANY_DEFAULT_OFF`):
   * default-on features turned off, default-off features turned on.
   */
  featuresOff: string[]
  featuresOn: string[]
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

export interface ConnectorGrantRow {
  userId: string
  provider: ConnectorProvider
  /** A new id at every consent: the refresh token's seal is bound to it. */
  grantId: string
  accountEmail: string
  scopes: string[]
  /**
   * The provider's features the member turned off inside this grant (owner
   * decision 2026-11-01: e.g. Google 受信を読む off). Set by the member
   * (`memberOAuth.setFeatureOff`), enforced by the provider's client.
   */
  featuresOff: string[]
  status: 'active' | 'revoked' | 'stopped'
  statusReason: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface OAuthPendingRow {
  stateHash: string
  provider: ConnectorProvider
  userId: string
  scopes: string[]
  verifier: SealedSecret
  createdAt: string
  expiresAt: string
}

export interface ConnectorChangeRow {
  id: string
  provider: ConnectorProvider
  action: string
  userId: string | null
  at: string
  by: string
  /** JSON without any secret. */
  change: string
}

export interface ConnectorRepository {
  // The company's OAuth client (one per company).
  client(): OAuthClientRow | null
  clientSecret(): SealedSecret | null
  /** Insert or replace; `secret` null keeps the stored one (and its last 4). */
  saveClient(row: { clientId: string; domain: string; at: string; by: string }, secret: { sealed: SealedSecret; last4: string } | null, change: ConnectorChangeRow): void
  setClientEnabled(enabled: boolean, at: string, by: string, change: ConnectorChangeRow): void
  /** The company-level switches (the client must exist). */
  setClientFeatures(switches: { featuresOff: string[]; featuresOn: string[] }, at: string, by: string, change: ConnectorChangeRow): void
  /** Google Picker's API key and app id on the client (google-drive.md); null when not registered. */
  picker(): { apiKey: string; appId: string } | null
  /** Sets (or with null, removes) the Picker's registration; the client must exist. */
  savePicker(value: { apiKey: string; appId: string } | null, at: string, by: string, change: ConnectorChangeRow): void

  // Members' grants.
  grants(provider: ConnectorProvider): ConnectorGrantRow[]
  grant(provider: ConnectorProvider, userId: string): ConnectorGrantRow | null
  /** The sealed refresh token of an active grant (null otherwise). */
  refreshToken(provider: ConnectorProvider, userId: string): { grantId: string; sealed: SealedSecret } | null
  /** Insert or replace the member's grant as active with a new token. */
  putGrant(row: Omit<ConnectorGrantRow, 'status' | 'statusReason' | 'lastUsedAt' | 'featuresOff'>, sealed: SealedSecret, change: ConnectorChangeRow | null): void
  /** Only the scopes (incremental consent that kept the token). */
  setGrantScopes(provider: ConnectorProvider, userId: string, scopes: string[], at: string, change: ConnectorChangeRow | null): void
  /**
   * Ends a grant: status revoked / stopped, the sealed token cleared. Only when
   * the grant is still `grantId` (when given), so a late failure of an old token
   * never ends a newer consent. True when a row changed.
   */
  endGrant(provider: ConnectorProvider, userId: string, status: 'revoked' | 'stopped', reason: string, at: string, change: ConnectorChangeRow | null, grantId?: string): boolean
  /** Deletes the member's grant row (the member's 「許可をやめる」). */
  deleteGrant(provider: ConnectorProvider, userId: string, change: ConnectorChangeRow): void
  touchGrant(provider: ConnectorProvider, userId: string, at: string): void
  /** The member's turned-off features of the grant (the row must exist); kept across a re-consent. */
  setFeaturesOff(provider: ConnectorProvider, userId: string, featuresOff: string[], at: string, change: ConnectorChangeRow): void

  // Pending starts (single use).
  putPending(row: OAuthPendingRow): void
  /** Removes and returns the row for this state hash when not expired at `now`; null otherwise (also when expired: removed). */
  takePending(stateHash: string, now: string): OAuthPendingRow | null
  /** Removes expired rows and the member's earlier starts. */
  prunePending(now: string, userId?: string): void

  history(provider: ConnectorProvider, limit: number): ConnectorChangeRow[]
  /** One history line for a change stored elsewhere (Google's `inbox` switch = the company's 受信を読む). */
  addHistory(change: ConnectorChangeRow): void

  // 「仕事の道具をつなぐ」: the provider's features the app already showed the member.
  setupSeen(provider: ConnectorProvider, userId: string): string[]
  /** Adds features to the member's seen list (kept across 「許可をやめる」). */
  addSetupSeen(provider: ConnectorProvider, userId: string, features: string[], at: string): void

  // The admin's choice of which core connector serves a role, when two could
  // (connector-roles.md; asked once, only when both exist).
  /** The chosen connector's id for the role, null when none was chosen. */
  roleChoice(role: string): string | null
  /** Sets (or with null, clears) the choice; a history line (`connector_history`, provider `roles`) is written in the same transaction. */
  setRoleChoice(role: string, connectorId: string | null, at: string, by: string, historyId: string): void
}
