/**
 * Wire shapes of the API key broker's admin API (「API キー」,
 * `…/api/companies/:id/broker…`). Rules and validation:
 * shared/core/key-broker.ts. No shape here ever carries a key's value —
 * only its last four characters.
 */
import type {
  BrokerAudience,
  BrokerCaps,
  BrokerDestinations,
  BrokerEligibility,
  BrokerKeyRule,
  BrokerKeyScope,
  BrokerKeyStatus,
  BrokerRelayDefinition,
  BrokerServiceCategory,
  BrokerStatusReason,
} from '../core/key-broker'

/** A member who can use a key now, and why. */
export interface BrokerKeyUser {
  userId: string
  name: string | null
  email: string | null
  via: BrokerEligibility | 'owner'
}

export interface BrokerKeySummary {
  id: string
  scope: BrokerKeyScope
  /** The member an own key belongs to (null for company keys). */
  ownerUserId: string | null
  ownerName: string | null
  service: string
  displayName: string
  /** The key's last four characters — all that is ever shown. */
  last4: string
  destinations: BrokerDestinations
  /** Company keys; an own key's audience is its owner alone. */
  audience: BrokerAudience
  caps: BrokerCaps
  /** 「非公開の内容を送ってよい」 */
  allowPrivateContent: boolean
  status: BrokerKeyStatus
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
  /** When the value was last registered or replaced. */
  secretUpdatedAt: string
  /** Who can use it now (active members; for a disabled key, who could). */
  usableBy: BrokerKeyUser[]
  /** The relay's use of this key today (the caps' day): calls forwarded and tokens counted. */
  usageToday: { requests: number; tokens: number }
}

export interface BrokerServiceView {
  service: string
  label: string
  builtin: boolean
  category: BrokerServiceCategory
  rule: BrokerKeyRule
  /** Hosts members' own keys for this service may be sent to (empty = no own keys). */
  ownKeyHosts: string[]
  /** Where a built-in service's requests go (a generic service: its one host; empty for others). */
  defaultHosts: string[]
  /**
   * A generic service the company registered (K9): where its requests go and
   * how the key travels. null for built-in services and names with keys only.
   */
  relay: BrokerRelayDefinition | null
  companyKeys: number
  userKeys: number
  /** null while the defaults apply. */
  updatedAt: string | null
}

export interface BrokerSettings {
  /** Members may register their own keys (default true). */
  memberKeysAllowed: boolean
  /**
   * Hosts the relay may reach although they resolve to a private / internal
   * address (loopback, 10.x, 169.254.x, …). Empty by default: such addresses
   * are refused. An explicit, recorded exception for an in-house system.
   */
  internalHosts: string[]
  updatedAt: string | null
  updatedBy: string | null
}

/** A key as the history records it (never its value). */
export interface BrokerKeySnapshot {
  service: string
  scope: BrokerKeyScope
  ownerUserId: string | null
  displayName: string
  last4: string
  destinations: BrokerDestinations
  audience: BrokerAudience
  caps: BrokerCaps
  allowPrivateContent: boolean
  status: BrokerKeyStatus
}

export type BrokerServiceSetting = { category: BrokerServiceCategory; rule: BrokerKeyRule; ownKeyHosts: string[] }

export type BrokerChangeDetail =
  | { action: 'create'; key: BrokerKeySnapshot }
  | { action: 'replace'; service: string; displayName: string; last4Before: string; last4After: string }
  | { action: 'update'; service: string; displayName: string; before: Partial<BrokerKeySnapshot>; after: Partial<BrokerKeySnapshot> }
  | { action: 'delete'; key: BrokerKeySnapshot }
  | { action: 'service'; service: string; before: BrokerServiceSetting | null; after: BrokerServiceSetting }
  | { action: 'relay-service'; service: string; before: BrokerRelayDefinition | null; after: BrokerRelayDefinition | null }
  | { action: 'settings'; before: { memberKeysAllowed: boolean; internalHosts?: string[] }; after: { memberKeysAllowed: boolean; internalHosts?: string[] } }

export interface BrokerChange {
  id: string
  changedAt: string
  changedBy: string
  name: string | null
  email: string | null
  keyId: string | null
  change: BrokerChangeDetail
}

/** GET …/broker and the answer of every change (owner/admin). */
export interface BrokerView {
  /** Off when the server has no usable key-encryption key: keys cannot be registered or used. */
  status: { enabled: boolean; reason: BrokerStatusReason | null }
  settings: BrokerSettings
  services: BrokerServiceView[]
  keys: BrokerKeySummary[]
  /** The company's departments (for the audience picker). */
  departments: Array<{ id: string; name: string; folder: string }>
  /** Newest first, at most 50. */
  history: BrokerChange[]
}

/** POST …/broker/keys: a company key. */
export interface BrokerKeyCreate {
  service: string
  displayName: string
  /** Write-only. */
  secret: string
  /** Defaults to a built-in service's hosts. */
  destinations?: BrokerDestinations
  audience: BrokerAudience
  caps?: Partial<BrokerCaps>
  allowPrivateContent?: boolean
}

/** PUT …/broker/relay-services/:service — register or change a generic service (K9). */
export interface BrokerRelayServiceSave {
  label: string
  /** `https://<host>[/<base path>]` — the host is fixed for the service. */
  baseUrl: string
  /** The header the key goes in (`authorization`, `x-api-key`, …). */
  header: string
  /** The header's value with `{key}` where the key goes (default `{key}`). */
  format?: string
  /** Only when the service is new (default `tool`). */
  category?: BrokerServiceCategory
}

// ---------------------------------------------------------------------------
// Short-lived tokens (K3): POST …/me/broker-tokens (the desktop app, member session)
// ---------------------------------------------------------------------------

/** Why a requested service is not in the token. */
export type BrokerUnavailableReason = 'no-key' | 'unknown-service' | 'stopped'

/** POST …/me/broker-tokens */
export interface BrokerTokenRequest {
  /** The chat conversation the token is for (recorded with every use). */
  conversationId: string
  /** Services to include; omitted = every service the member can use now. */
  services?: string[]
  /** The conversation's active department folder, when there is one. */
  department?: string | null
  /** Shorter than the server's lifetime if wanted (15 minutes at least). */
  ttlMinutes?: number
}

export interface BrokerTokenIssued {
  /** false: the server has no key-encryption key; no token. */
  enabled: boolean
  /**
   * `acb_tok_…` — only for the chat's child processes (never logged, never
   * shown); null when no requested service is usable.
   */
  token: string | null
  tokenId: string | null
  expiresAt: string | null
  /** The services the token may be used for, and which kind of key each uses now. */
  services: Array<{ service: string; source: BrokerKeyScope }>
  unavailable: Array<{ service: string; reason: BrokerUnavailableReason }>
}

/** PATCH …/broker/keys/:keyId (an own key: status only). */
export interface BrokerKeyUpdate {
  displayName?: string
  destinations?: BrokerDestinations
  audience?: BrokerAudience
  caps?: Partial<BrokerCaps>
  allowPrivateContent?: boolean
  status?: BrokerKeyStatus
}

// ---------------------------------------------------------------------------
// A member's own keys (K8): …/me/broker-keys (any member, the app's 「自分の鍵」)
// ---------------------------------------------------------------------------

/** Why a member cannot register an own key for a service. */
export type OwnKeyBlocked =
  /** The company switched members' own keys off. */
  | 'member-keys-off'
  /** The service uses company keys only (「会社の鍵だけ」). */
  | 'company-only'
  /** The admin has not allowed any destination for own keys of this service. */
  | 'no-destinations'

/** A member's own key as the app shows it (never its value). */
export interface OwnBrokerKey {
  id: string
  displayName: string
  last4: string
  /** Where it may be sent (the service's own-key hosts when it was registered). */
  hosts: string[]
  /** 'disabled' when an admin stopped it. */
  status: BrokerKeyStatus
  secretUpdatedAt: string
}

export interface MyBrokerService {
  service: string
  label: string
  category: BrokerServiceCategory
  rule: BrokerKeyRule
  /** Whether the member may register an own key now, or why not. */
  ownKey: { allowed: true; hosts: string[] } | { allowed: false; reason: OwnKeyBlocked }
  /** Active company keys this member may use (dial ②), and for which departments' work (dial ①). */
  companyKeys: Array<{ displayName: string; allDepartments: boolean; departments: string[] }>
  /** The member's own key for this service, if any. */
  key: OwnBrokerKey | null
}

/** GET …/me/broker-keys, and the answer of PUT / DELETE …/me/broker-keys/:service. */
export interface MyBrokerKeys {
  /** false: the server has no key-encryption key (nothing can be registered or used). */
  enabled: boolean
  memberKeysAllowed: boolean
  services: MyBrokerService[]
}

/** PUT …/me/broker-keys/:service — register or replace one's own key (the value is write-only). */
export interface OwnBrokerKeySave {
  secret: string
  displayName?: string
}
