/**
 * The Google connection's storage, behind the company handle
 * (`.claude/rules/google-connector.md`): the company's OAuth client, members'
 * grants, the pending 「Google で許可」 starts and their history. Every method
 * is limited to the handle's company.
 *
 * Secrets are passed and returned only as sealed envelopes (the vault seals
 * and opens them); the listing methods never return one.
 */
import type { SealedSecret } from './secret-cipher'

export type ConnectorProvider = 'google'

export interface OAuthClientRow {
  clientId: string
  secretLast4: string
  domain: string
  enabled: boolean
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

  // Members' grants.
  grants(provider: ConnectorProvider): ConnectorGrantRow[]
  grant(provider: ConnectorProvider, userId: string): ConnectorGrantRow | null
  /** The sealed refresh token of an active grant (null otherwise). */
  refreshToken(provider: ConnectorProvider, userId: string): { grantId: string; sealed: SealedSecret } | null
  /** Insert or replace the member's grant as active with a new token. */
  putGrant(row: Omit<ConnectorGrantRow, 'status' | 'statusReason' | 'lastUsedAt'>, sealed: SealedSecret, change: ConnectorChangeRow | null): void
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

  // Pending starts (single use).
  putPending(row: OAuthPendingRow): void
  /** Removes and returns the row for this state hash when not expired at `now`; null otherwise (also when expired: removed). */
  takePending(stateHash: string, now: string): OAuthPendingRow | null
  /** Removes expired rows and the member's earlier starts. */
  prunePending(now: string, userId?: string): void

  history(provider: ConnectorProvider, limit: number): ConnectorChangeRow[]
}
