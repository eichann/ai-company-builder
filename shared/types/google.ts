/**
 * The Google connection's API contract (milestone 4 G3,
 * `.claude/rules/google-connector.md`). No shape here ever carries a client
 * secret, a refresh or access token, an authorization code or a PKCE value.
 */
import type { GoogleFeature } from '../core/google'
import type { GoogleRelayService, SheetsOperation } from '../core/google-relay'

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
  /** What is allowed: minutes = 予定と議事録を読む, mail = メールを送る, drive = Drive で選んだものを読む・置く, inbox = 受信を読む. */
  features: GoogleFeature[]
  /** Allowed features the member turned off themselves (not used until they turn them on again). */
  featuresOff: GoogleFeature[]
  scopes: string[]
  status: GoogleGrantStatus
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type GoogleChangeAction = 'client' | 'enabled' | 'features' | 'picker' | 'grant' | 'grant-revoked' | 'grant-stopped' | 'grant-features' | 'stop-all'
  /** The relay's settings (cap, the company-wide stop) and one member's relay stop. */
  | 'relay' | 'relay-member'

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
  /** Google Picker (Drive: 選んだファイルを読む・置く, google-drive.md): the API key's last 4 and the project number. */
  picker: GooglePickerView
  /** Features off for the whole company (受信を読む until the admin turns it on): never asked of members, refused from the next call. */
  featuresOff: GoogleFeature[]
  /** What members are asked for in one consent (on, and Drive only with the Picker registered). */
  companyFeatures: GoogleFeature[]
}

/** PUT /api/companies/:id/google/features — the admin turns one feature off / on for the company. */
export interface GoogleCompanyFeatureSwitch {
  feature: GoogleFeature
  on: boolean
}

export interface GooglePickerView {
  configured: boolean
  appId: string | null
  apiKeyLast4: string | null
  /** The page to allow in the API key's website restrictions (`<PUBLIC_URL>/api/google-picker`). */
  pageUrl: string
}

/** PUT /api/companies/:id/google/picker. `apiKey` may be left out to keep the stored one; `null` both = remove. */
export interface GooglePickerSave {
  apiKey?: string
  appId: string | null
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
  /** The features allowed in the grant (on or off). */
  features: GoogleFeature[]
  /** Of those, the ones the member turned off (e.g. 受信を読む): ACB does not use them until turned on. */
  featuresOff: GoogleFeature[]
  /** The domain the account must belong to (shown so the member picks the right account). */
  domain: string | null
  practice: boolean
  /** What the company offers (asked together by 「Google でつなぐ」); empty while unavailable. */
  companyFeatures: GoogleFeature[]
  /** Allowed features that would do more if allowed again (`googleFeaturesToRenew`); an older server leaves it out. */
  renew?: GoogleFeature[]
  /** Features already shown to the member on 「仕事の道具をつなぐ」 (connected, declined or 「あとで」). */
  seen: GoogleFeature[]
  /**
   * What the company offers that a member allows only by choosing it (`GOOGLE_ASKED_BY_NAME_ONLY`:
   * 済んだメールを Gmail でもアーカイブする, the relay); an older server leaves it out.
   */
  offeredByName?: GoogleFeature[]
}

/** PUT /api/companies/:id/me/google/features — the member turns one allowed feature on or off. */
export interface GoogleFeatureSwitch {
  feature: GoogleFeature
  on: boolean
}

/**
 * POST /api/companies/:id/me/google/connect: some features (asked when first
 * used), or `all` — every feature the company offers, in one consent
 * (「仕事の道具をつなぐ」; also marks them seen).
 */
export type GoogleConnectRequest = { features: GoogleFeature[] } | { all: true }

export interface GoogleConnectStart {
  /** Open in the system browser. Valid for 10 minutes, once. */
  authorizeUrl: string
  expiresAt: string
}

// ---------------------------------------------------------------------------
// The relay with the member's own permission (「本人の許可で中継する」, google-connector.md "The relay").

/** One relayed call as the records show it: who, when, which spreadsheet and range, the result — never cell contents. */
export interface GoogleRelayRecord {
  id: string
  at: string
  userId: string
  /** The member's name (the admin's view; the member's own view: their own). */
  memberName: string | null
  /** `sheets`. */
  service: string
  /** The call (null when it was refused before one was recognised). */
  operation: SheetsOperation | null
  /** The spreadsheet (from the path) and the A1 range of a values call. */
  spreadsheetId: string | null
  range: string | null
  /** Google's status, or the relay's own when it refused. */
  status: number | null
  /**
   * ok: Google did it; google-refused: Google answered 4xx (no permission on that sheet, not
   * found); refused: ACB did not pass it (`reason`); error: Google or the way failed.
   */
  result: 'ok' | 'google-refused' | 'refused' | 'error'
  /** Why ACB refused: deletion / not-relayed / stopped / over-cap / not-allowed (no permission, feature off) / other. */
  reason: 'deletion' | 'not-relayed' | 'stopped' | 'over-cap' | 'not-allowed' | 'other' | null
}

/** One member in the admin's relay view. */
export interface GoogleRelayMember {
  userId: string
  memberName: string | null
  memberEmail: string | null
  /** The member allowed the relay (an active grant holding the service's permission, not turned off by them). */
  allowed: boolean
  /** When their Google permission was last given (the grant's creation or update). */
  allowedAt: string | null
  /** The admin stopped this member's relay. */
  stopped: boolean
  /** Calls counted today (the cap's day). */
  usedToday: number
}

/** GET /api/companies/:id/google/relay (owner/admin): 「API キー」→「本人の許可で中継する」→ Google. */
export interface GoogleRelayAdminView {
  /** Google is set up and on (else `reason`): without it nothing can be relayed. */
  available: boolean
  reason: GoogleUnavailableReason | null
  /** Each relay service and whether the company turned it on. */
  services: Array<{ service: GoogleRelayService; on: boolean }>
  /** Calls per member per day (all services). */
  capPerMemberPerDay: number
  /** The company-wide stop. */
  stopped: boolean
  /** Members who allowed it, were stopped, or used it today. */
  members: GoogleRelayMember[]
  /** The latest relayed calls of everyone (newest first, ≤ 100). */
  records: GoogleRelayRecord[]
}

/** PUT /api/companies/:id/google/relay — any subset. */
export interface GoogleRelaySave {
  services?: Partial<Record<GoogleRelayService, boolean>>
  capPerMemberPerDay?: number
  stopped?: boolean
}

/** PUT /api/companies/:id/google/relay/members/:userId */
export interface GoogleRelayMemberSave {
  stopped: boolean
}

/** GET /api/companies/:id/me/google/relay (any member: the app's 設定 → Google). */
export interface MyGoogleRelay {
  /** Google is usable now (else `reason`). */
  available: boolean
  reason: GoogleUnavailableReason | null
  /** Per relay service: the company offers it, the member allowed it (and has not turned it off). */
  services: Array<{ service: GoogleRelayService; offered: boolean; allowed: boolean; turnedOff: boolean }>
  /** The admin stopped the relay for everyone ('company') or for this member ('member'). */
  stopped: 'company' | 'member' | null
  capPerDay: number
  usedToday: number
  /** The member's own relayed calls (newest first, ≤ 50). */
  records: GoogleRelayRecord[]
}
