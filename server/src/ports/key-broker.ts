/**
 * Storage of the API key broker (.claude/rules/key-broker.md): the vault's
 * keys (sealed — ports/secret-cipher.ts), the per-service decision rule, the
 * company's own-key setting, the change history and the short-lived tokens.
 * Shapes on the wire: shared/types/key-broker.ts; rules: services/broker-*.ts
 * and services/key-broker.ts.
 *
 * Listing never returns the sealed secret; only `sealed()` does, and only the
 * vault service (services/broker-vault.ts) calls it.
 */
import type { BrokerStatusReason } from '../../shared/core/key-broker'
import type { SealedSecret, SecretCipher } from './secret-cipher'

export type { BrokerStatusReason }

/** The vault's cipher, or why there is none (the server runs either way). */
export type BrokerCipherState =
  | { enabled: true; cipher: SecretCipher }
  /** `detail`: an English sentence for the operator's log (never contains a value). */
  | { enabled: false; reason: BrokerStatusReason; detail: string }

export interface BrokerKeyRow {
  id: string
  companyId: string
  /** 'company' | 'user' */
  scope: string
  /** The member a `user` key belongs to; null for company keys. */
  ownerUserId: string | null
  service: string
  displayName: string
  last4: string
  /** JSON of BrokerDestinations. */
  destinations: string
  /** JSON of BrokerAudience (company keys; `user` keys store nobody). */
  audience: string
  /** JSON of BrokerCaps. */
  caps: string
  allowPrivateContent: boolean
  /** 'active' | 'disabled' */
  status: string
  /** Which KEK wraps the data key (rotation / KMS migration progress). */
  kekId: string
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
  secretUpdatedAt: string
}

/** Metadata an update may set (undefined = unchanged). */
export interface BrokerKeyChanges {
  displayName?: string
  destinations?: string
  audience?: string
  caps?: string
  allowPrivateContent?: boolean
  status?: string
}

export interface BrokerChangeRow {
  id: string
  changedAt: string
  changedBy: string
  /** The key concerned, when the change is about one. */
  keyId: string | null
  /** create | replace | update | delete | service | settings */
  action: string
  /** JSON of the change, never containing a secret. */
  change: string
}

export interface StoredBrokerService {
  service: string
  /** 'person' | 'tool' | 'system' */
  category: string
  /** 'company-only' | 'user-only' | 'company-first' */
  rule: string
  /** JSON array of hosts members' own keys for this service may be sent to. */
  ownKeyHosts: string
  updatedAt: string
  updatedBy: string
}

export interface StoredBrokerSettings {
  memberKeysAllowed: boolean
  /** JSON array of hosts allowed to resolve to private addresses (the relay's exception). */
  internalHosts: string
  updatedAt: string
  updatedBy: string
}

export interface BrokerKeyRepository {
  /** The company's keys, oldest first (both scopes). */
  list(companyId: string): BrokerKeyRow[]
  find(companyId: string, keyId: string): BrokerKeyRow | null
  /** The sealed secret of one key (vault only). */
  sealed(companyId: string, keyId: string): SealedSecret | null
  /** Every sealed secret of every company, for re-wrapping under a new KEK. */
  allSealed(): Array<{ companyId: string; keyId: string; sealed: SealedSecret }>
  insert(row: BrokerKeyRow, sealed: SealedSecret, change: BrokerChangeRow): void
  update(companyId: string, keyId: string, changes: BrokerKeyChanges, at: string, by: string, change: BrokerChangeRow): void
  replaceSecret(companyId: string, keyId: string, sealed: SealedSecret, last4: string, at: string, by: string, change: BrokerChangeRow): void
  /** Only the data key's wrapping changes (the ciphertext stays). */
  rewrap(companyId: string, keyId: string, wrappedKey: string, kekId: string): void
  delete(companyId: string, keyId: string, change: BrokerChangeRow): void

  services(companyId: string): StoredBrokerService[]
  saveService(companyId: string, service: StoredBrokerService, change: BrokerChangeRow): void
  settings(companyId: string): StoredBrokerSettings | null
  saveSettings(companyId: string, settings: StoredBrokerSettings, change: BrokerChangeRow): void
  /** Newest first. */
  history(companyId: string, limit: number): BrokerChangeRow[]
}

export interface BrokerTokenRow {
  id: string
  companyId: string
  userId: string
  /** sha256 of the token value (hex); the value itself is never stored. */
  tokenHash: string
  /** JSON array of service names the token may be used for. */
  services: string
  /** The conversation's active department folder, when the app sent one. */
  department: string | null
  conversationId: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface BrokerTokenRepository {
  insert(row: BrokerTokenRow): void
  findByHash(tokenHash: string): BrokerTokenRow | null
  /** Revoke one of the member's tokens; false when there is no such live token. */
  revoke(companyId: string, userId: string, tokenId: string, at: string): boolean
  /** Revoke every live token of a member (or of the company when userId is null). */
  revokeAll(companyId: string, userId: string | null, at: string): number
  /** Tokens of the member not yet expired or revoked. */
  countLive(companyId: string, userId: string, now: string): number
  /** Delete tokens that expired before `before`. */
  pruneExpired(before: string): number
}

/** One-way digest of a token value (sha256 hex): what the token table stores and looks up. */
export interface TokenDigest {
  digest(token: string): string
}
