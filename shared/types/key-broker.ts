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
}

export interface BrokerServiceView {
  service: string
  label: string
  builtin: boolean
  category: BrokerServiceCategory
  rule: BrokerKeyRule
  /** Hosts members' own keys for this service may be sent to (empty = no own keys). */
  ownKeyHosts: string[]
  /** Where a built-in service's requests go (empty for others). */
  defaultHosts: string[]
  companyKeys: number
  userKeys: number
  /** null while the defaults apply. */
  updatedAt: string | null
}

export interface BrokerSettings {
  /** Members may register their own keys (default true). */
  memberKeysAllowed: boolean
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
  | { action: 'settings'; before: { memberKeysAllowed: boolean }; after: { memberKeysAllowed: boolean } }

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

/** PATCH …/broker/keys/:keyId (an own key: status only). */
export interface BrokerKeyUpdate {
  displayName?: string
  destinations?: BrokerDestinations
  audience?: BrokerAudience
  caps?: Partial<BrokerCaps>
  allowPrivateContent?: boolean
  status?: BrokerKeyStatus
}
