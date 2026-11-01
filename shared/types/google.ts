/**
 * The Google connection's API contract (milestone 4 G3,
 * `.claude/rules/google-connector.md`). No shape here ever carries a client
 * secret, a refresh or access token, an authorization code or a PKCE value.
 */
import type { GoogleFeature } from '../core/google'

export type { GoogleFeature } from '../core/google'

/** active: usable; revoked: Google or the member ended it; stopped: an admin or 「すべての鍵を止める」 stopped it. */
export type GoogleGrantStatus = 'active' | 'revoked' | 'stopped'

/** One member's Google permission, as the admin sees it. */
export interface GoogleGrantSummary {
  userId: string
  /** The member's ACB account (for the list), null when the account is gone. */
  memberEmail: string | null
  memberName: string | null
  /** The Google account that was allowed (the member's own ACB email by rule). */
  googleEmail: string
  /** What is allowed: minutes = 予定と議事録を読む, mail = メールを送る. */
  features: GoogleFeature[]
  scopes: string[]
  status: GoogleGrantStatus
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type GoogleChangeAction = 'client' | 'enabled' | 'grant' | 'grant-revoked' | 'grant-stopped' | 'stop-all'

/** One line of the history (who, when, what — never a secret or token). */
export interface GoogleChange {
  id: string
  action: GoogleChangeAction
  at: string
  by: string
  byName: string | null
  /** The member a grant line is about. */
  userId: string | null
  /** Action details: client id and last 4 before → after, domain, on/off, features, a reason. */
  detail: Record<string, unknown>
}

/** GET /api/companies/:id/google (owner/admin). */
export interface GoogleAdminView {
  /** The vault (key-encryption key) is on: without it nothing can be registered. */
  vaultEnabled: boolean
  /** A client is registered. */
  configured: boolean
  clientId: string | null
  /** The last 4 characters of the client secret; the secret itself is never answered. */
  secretLast4: string | null
  domain: string | null
  enabled: boolean
  /** The exact redirect URI to register in Google Cloud. */
  redirectUri: string
  /** Staging: the server talks to the practice Google (only practice secrets can be saved). */
  practice: boolean
  /** The operator stopped Google for every company (`<PLUGINS_DIR>/stopped`). */
  operatorStopped: boolean
  updatedAt: string | null
  updatedBy: string | null
  grants: GoogleGrantSummary[]
  /** Latest 50. */
  history: GoogleChange[]
}

/** PUT /api/companies/:id/google/client. `clientSecret` may be left out to keep the stored one. */
export interface GoogleClientSave {
  clientId: string
  clientSecret?: string
  domain: string
}

/** PUT /api/companies/:id/google/enabled */
export interface GoogleEnabledSave {
  enabled: boolean
}

/** Why a member cannot connect now. */
export type GoogleUnavailableReason = 'not-configured' | 'off' | 'vault-off' | 'operator-stopped'

/** GET /api/companies/:id/me/google (any member: the app's 設定 → Google). */
export interface MyGoogle {
  /** The company lets members connect now; else `reason`. */
  available: boolean
  reason: GoogleUnavailableReason | null
  /** A grant exists and is active. */
  connected: boolean
  status: GoogleGrantStatus | null
  googleEmail: string | null
  features: GoogleFeature[]
  /** The domain the account must belong to (shown so the member picks the right account). */
  domain: string | null
  practice: boolean
}

/** POST /api/companies/:id/me/google/connect */
export interface GoogleConnectRequest {
  features: GoogleFeature[]
}

export interface GoogleConnectStart {
  /** Open in the system browser. Valid for 10 minutes, once. */
  authorizeUrl: string
  expiresAt: string
}
