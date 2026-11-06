/**
 * The Google connection (milestone 4 G3, `.claude/rules/google-connector.md`):
 * which Google permissions (scopes) each ACB feature asks for, the hosts each
 * Google API lives on, and the input rules of the admin's registration.
 *
 * Owner decisions (design §5-2, §9 q8/q10; 2026-11-02 「仕事の道具をつなぐ」):
 * ask only for the features the company turned on, all of them in one consent
 * (`googleFeaturesToAsk`); a feature the company turns on later is asked once
 * more (or when first used); never `drive`, `drive.readonly`, `gmail.compose`,
 * `gmail.metadata` or domain-wide delegation (`GOOGLE_NEVER_SCOPES`).
 * `gmail.readonly` is allowed only as the `inbox` feature (owner decision 2026-11-01, spec §7-1:
 * the member can turn it off); `gmail.modify` only as the `inbox_archive` feature, and only for
 * taking a thread out of the inbox and putting it back (`gmailCallAllowed`, owner decision 2026-11-05).
 * The Google account must be the member's own ACB email. 受信を読む's switches are the
 * member's own 受信を読む within the company's (`work-switches.ts`), not a Google switch.
 *
 * Pure: imports nothing outside shared/core.
 */
import { normalizeEmail } from './mail'

export const GOOGLE_FEATURES = ['minutes', 'mail', 'drive', 'inbox', 'sheets', 'inbox_archive'] as const
/**
 * minutes = 予定と議事録を読む, mail = メールを送る, drive = Drive で選んだものを読む・置く
 * (`drive.file` only), inbox = 受信を読む (`gmail.readonly`), sheets = スプレッドシートを中継で使う
 * (`spreadsheets`: a script's Sheets calls relayed with the member's own permission,
 * `google-relay.ts`; owner decision 2026-11-04), inbox_archive = 済んだメールを Gmail でもアーカイブする
 * (`gmail.modify`, used for nothing but the inbox label: `gmailCallAllowed`; owner decision 2026-11-05).
 */
export type GoogleFeature = typeof GOOGLE_FEATURES[number]

export const GOOGLE_SCOPE = {
  openid: 'openid',
  /** `email` is Google's short name for this one; Google reports the long form. */
  email: 'https://www.googleapis.com/auth/userinfo.email',
  calendarEventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  meetReadonly: 'https://www.googleapis.com/auth/meetings.space.readonly',
  driveMeetReadonly: 'https://www.googleapis.com/auth/drive.meet.readonly',
  /**
   * The minutes' Google Docs by the Docs API (owner decision 2026-11-05): Drive's export refuses
   * Meet's documents under `drive.meet.readonly`. Google lets it open any Doc the member can open;
   * ACB uses it only for a meeting's documents (`google-meetings.ts` `docText`).
   */
  documentsReadonly: 'https://www.googleapis.com/auth/documents.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  /**
   * Only the files the member picked with Google Picker or ACB created
   * (owner decision 2026-11-01: least privilege; never `drive` / `drive.readonly`).
   */
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  /** 受信を読む (the `inbox` feature only): the member's received mail, read when needed, never stored. */
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  /**
   * スプレッドシートを中継で使う (the `sheets` feature only): every sheet the member can edit —
   * no per-file designation (owner decision 2026-11-04); Google refuses the rest, the relay
   * never passes a deletion and writes only into sheets owned inside the company's Workspace
   * (shared/core/google-relay.ts `sheetOwnership`).
   */
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  /**
   * With スプレッドシートを中継で使う only (owner decision 2026-11-04, 「会社の Workspace の中の表だけに
   * 書ける」): to read who owns a sheet before the relay writes into it. Google lets it read the
   * names and details of every file the member can see (never their contents); ACB sends exactly
   * one kind of call with it — one file's `owners` and `driveId` (`driveMetadataCallAllowed`).
   */
  driveMetadataReadonly: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  /**
   * 済んだメールを Gmail でもアーカイブする (the `inbox_archive` feature only, owner decision
   * 2026-11-05). Google lets it read, label, trash and draft too; ACB sends exactly one kind of call
   * with it — one message's INBOX label removed (archive) or added back (undo): `gmailCallAllowed`,
   * enforced by the one Google client before anything leaves.
   */
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
} as const

/** Scopes ACB never asks for, holds or hands out (owner decisions; `google-connector.md`). */
export const GOOGLE_NEVER_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  // `drive.metadata.readonly` left this list on 2026-11-05 (B-H1: the relay writes only into sheets
  // owned inside the company's Workspace, and only Drive tells the owner). Held only with the
  // `sheets` feature; the Google client sends nothing with it but one file's owner lookup.
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.metadata',
  // `gmail.modify` left this list on 2026-11-05 (owner decision: 「済んだメールを Gmail でもアーカイブする」,
  // opt-in per member). It is held only as the `inbox_archive` feature, and the Google client sends
  // nothing with it but `messages.modify` on one message's INBOX label (`gmailCallAllowed`).
  'https://mail.google.com/',
]

/** Asked with every feature: to read which account was allowed (and that its address is verified). */
const IDENTITY_SCOPES = [GOOGLE_SCOPE.openid, GOOGLE_SCOPE.email]

/** What each feature asks Google for (besides the identity scopes). */
export const GOOGLE_FEATURE_SCOPES: Record<GoogleFeature, readonly string[]> = {
  minutes: [GOOGLE_SCOPE.calendarEventsReadonly, GOOGLE_SCOPE.meetReadonly, GOOGLE_SCOPE.driveMeetReadonly, GOOGLE_SCOPE.documentsReadonly],
  mail: [GOOGLE_SCOPE.gmailSend],
  drive: [GOOGLE_SCOPE.driveFile],
  inbox: [GOOGLE_SCOPE.gmailReadonly],
  sheets: [GOOGLE_SCOPE.spreadsheets, GOOGLE_SCOPE.driveMetadataReadonly],
  inbox_archive: [GOOGLE_SCOPE.gmailModify],
}

/**
 * Asked with the feature, but a grant without them still has it: it reads less well until the
 * member allows again (`googleFeaturesToRenew`). Grants made before the scope existed keep working.
 */
export const GOOGLE_FEATURE_OPTIONAL_SCOPES: Partial<Record<GoogleFeature, readonly string[]>> = {
  minutes: [GOOGLE_SCOPE.documentsReadonly],
  // A grant from before 2026-11-05 still reads sheets; the relay refuses its writes until the member
  // allows again (it cannot tell who owns the sheet).
  sheets: [GOOGLE_SCOPE.driveMetadataReadonly],
}

/** Every scope ACB may hold. Anything else Google reports as granted is not stored. */
export const GOOGLE_ALLOWED_SCOPES: readonly string[] = [
  ...IDENTITY_SCOPES,
  ...GOOGLE_FEATURE_SCOPES.minutes,
  ...GOOGLE_FEATURE_SCOPES.mail,
  ...GOOGLE_FEATURE_SCOPES.drive,
  ...GOOGLE_FEATURE_SCOPES.inbox,
  ...GOOGLE_FEATURE_SCOPES.sheets,
  ...GOOGLE_FEATURE_SCOPES.inbox_archive,
]

/** Google's short names → the long form it reports. */
const SCOPE_ALIASES: Record<string, string> = { email: GOOGLE_SCOPE.email }

export function isGoogleFeature(v: unknown): v is GoogleFeature {
  return typeof v === 'string' && (GOOGLE_FEATURES as readonly string[]).includes(v)
}

/** The scopes to ask for (as sent in the authorization URL: `openid email …`). */
export function googleScopesFor(features: readonly GoogleFeature[]): string[] {
  const out = ['openid', 'email']
  for (const f of GOOGLE_FEATURES) if (features.includes(f)) out.push(...GOOGLE_FEATURE_SCOPES[f])
  return out
}

/** A space-separated scope list as Google reports it → the allowed ones, long form, sorted, unique. */
export function normalizeGrantedScopes(raw: string | readonly string[]): string[] {
  const list = typeof raw === 'string' ? raw.split(/\s+/) : [...raw]
  const out = new Set<string>()
  for (const s of list) {
    const scope = SCOPE_ALIASES[s] ?? s
    if (GOOGLE_ALLOWED_SCOPES.includes(scope)) out.add(scope)
  }
  return [...out].sort()
}

/** The features whose every scope is granted (an optional one aside). */
export function googleFeaturesOf(scopes: readonly string[]): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(f => GOOGLE_FEATURE_SCOPES[f].every(s => scopes.includes(s) || GOOGLE_FEATURE_OPTIONAL_SCOPES[f]?.includes(s)))
}

/** The granted features that would do more if the member allowed them again (an optional scope missing). */
export function googleFeaturesToRenew(scopes: readonly string[]): GoogleFeature[] {
  return googleFeaturesOf(scopes).filter(f => GOOGLE_FEATURE_OPTIONAL_SCOPES[f]?.some(s => !scopes.includes(s)))
}

/**
 * The feature a scope belongs to (each feature scope belongs to exactly one),
 * null for the identity scopes. The Google client refuses a call whose
 * feature the member turned off (`connector_grants.features_off`).
 */
export function googleFeatureOfScope(scope: string): GoogleFeature | null {
  return GOOGLE_FEATURES.find(f => GOOGLE_FEATURE_SCOPES[f].includes(scope)) ?? null
}

/** A member's list of turned-off features as stored → the known features only (unknown entries are ignored). */
export function googleFeaturesOff(raw: readonly string[]): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(f => raw.includes(f))
}

// ---------------------------------------------------------------------------
// What the company offers its members (owner decision 2026-11-02, 「仕事の道具をつなぐ」).

/**
 * Off for a company until its admin turns them on; the others are on until the admin turns them
 * off. 受信を読む (`inbox`) is no longer Google's own company switch since 2026-11-02 — it is
 * the company's 受信を読む (`work-switches.ts`, the task settings' `readIncoming.allowed`, allowed
 * by default, each member starting off), which covers Slack's reading too. `sheets` (the relay,
 * 2026-11-04) is off until the admin ticks スプレッドシート under 「API キー」→「本人の許可で中継する」;
 * `inbox_archive` (2026-11-05) until the admin turns it on in 「会社で使うもの」.
 */
export const GOOGLE_COMPANY_DEFAULT_OFF: readonly GoogleFeature[] = ['sheets', 'inbox_archive']

/**
 * The admin's switches as stored (default-on features turned off, default-off features turned on)
 * and the company's 受信を読む (`readIncomingAllowed`), which decides the `inbox` feature.
 */
export interface GoogleCompanySwitches {
  featuresOff: readonly string[]
  featuresOn: readonly string[]
  readIncomingAllowed: boolean
}

/** Whether the company has a feature on (the admin's switch over the feature's default; `inbox` = the company's 受信を読む). */
export function googleCompanyFeatureOn(feature: GoogleFeature, company: GoogleCompanySwitches): boolean {
  if (feature === 'inbox') return company.readIncomingAllowed
  return GOOGLE_COMPANY_DEFAULT_OFF.includes(feature) ? company.featuresOn.includes(feature) : !company.featuresOff.includes(feature)
}

/** The stored switches after the admin turns one feature on or off (only the list of its default changes; never `inbox`). */
export function googleCompanySwitched(company: Omit<GoogleCompanySwitches, 'readIncomingAllowed'>, feature: Exclude<GoogleFeature, 'inbox'>, on: boolean): { featuresOff: GoogleFeature[]; featuresOn: GoogleFeature[] } {
  const defaultOff = GOOGLE_COMPANY_DEFAULT_OFF.includes(feature)
  return {
    featuresOff: GOOGLE_FEATURES.filter(f => (f === feature && !defaultOff ? !on : company.featuresOff.includes(f) && !GOOGLE_COMPANY_DEFAULT_OFF.includes(f))),
    featuresOn: GOOGLE_FEATURES.filter(f => (f === feature && defaultOff ? on : company.featuresOn.includes(f) && GOOGLE_COMPANY_DEFAULT_OFF.includes(f))),
  }
}

/**
 * The features a company offers: every feature on for the company
 * (`googleCompanyFeatureOn`), and Drive only once Google Picker is registered
 * (without it Drive cannot be used, so `drive.file` is not asked).
 */
export function googleCompanyFeatures(company: GoogleCompanySwitches & { pickerConfigured: boolean }): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(f => googleCompanyFeatureOn(f, company) && (f !== 'drive' || company.pickerConfigured))
}

/**
 * Features never asked in the one consent: only when the member names them (the relay, 2026-11-04;
 * 済んだメールを Gmail でもアーカイブする, 2026-11-05: only members who choose it allow it).
 */
export const GOOGLE_ASKED_BY_NAME_ONLY: readonly GoogleFeature[] = ['sheets', 'inbox_archive']

/**
 * What one member is offered (「仕事の道具をつなぐ」's one consent, the screen's 「まだ許可していないもの」):
 * the company's features, but 受信を読む only while the member's own 受信を読む is on — the
 * most sensitive scope is never asked of someone who did not turn it on (owner decisions
 * 2026-11-02) — and never `sheets`: the relay is asked only when the member chooses it
 * (設定 → Google 「スプレッドシートを中継で使う」, by name), like a feature asked when first used.
 */
export function googleMemberFeatures(companyFeatures: readonly GoogleFeature[], readIncomingOn: boolean): GoogleFeature[] {
  return companyFeatures.filter(f => (f !== 'inbox' || readIncomingOn) && !GOOGLE_ASKED_BY_NAME_ONLY.includes(f))
}

/**
 * What one consent asks for: the requested features the company offers, plus
 * those already granted that the company still offers (Google merges them).
 * Never a feature the company turned off (least privilege at company level).
 */
export function googleFeaturesToAsk(requested: readonly GoogleFeature[], companyFeatures: readonly GoogleFeature[], granted: readonly GoogleFeature[]): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(f => companyFeatures.includes(f) && (requested.includes(f) || granted.includes(f)))
}

// ---------------------------------------------------------------------------
// The Gmail calls ACB makes (owner decision 2026-11-05): the one rule the Google client applies to
// every call to the Gmail API before anything leaves.

/** The message a label change names (Gmail's ids). */
const GMAIL_ID = '[A-Za-z0-9_-]{1,200}'
const GMAIL_READ_RE = /^\/gmail\/v1\/users\/me\/(messages|threads|history|profile|labels)(\/[A-Za-z0-9_-]{1,200})?$/
const GMAIL_SEND_PATH = '/gmail/v1/users/me/messages/send'
/**
 * A mail with PDFs attached (outbound-mail.md "Attachments"): `messages.send`'s media upload, the
 * message as `message/rfc822` bytes. The JSON `raw` form caps the request far below 10 MB of files;
 * the upload endpoint takes up to 35 MB. Same scope, same one message, only to `users/me`.
 */
export const GMAIL_UPLOAD_SEND_PATH = '/upload/gmail/v1/users/me/messages/send'
/** One message's labels (never a whole conversation: a reply ACB has not read yet must stay in the inbox). */
const GMAIL_MODIFY_RE = new RegExp(`^/gmail/v1/users/me/messages/${GMAIL_ID}/modify$`)

/** The only bodies a call with `gmail.modify` may carry: the INBOX label off (archive) or back on (undo). */
export const GMAIL_ARCHIVE_BODY = Object.freeze({ removeLabelIds: Object.freeze(['INBOX']) })
export const GMAIL_UNARCHIVE_BODY = Object.freeze({ addLabelIds: Object.freeze(['INBOX']) })

/** A path Google routes to Gmail on its shared host (`/gmail/…`, `/upload/gmail/…`, `/batch/gmail/…`), however escaped. */
function mentionsGmail(path: string): boolean {
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* as written */ }
  const GMAIL_ROUTE = /^\/+((upload|batch)\/+)?gmail(\/|$)/i
  return GMAIL_ROUTE.test(path) || GMAIL_ROUTE.test(decoded)
}

function isLabelBody(body: unknown, key: 'removeLabelIds' | 'addLabelIds'): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const keys = Object.keys(body)
  const list = (body as Record<string, unknown>)[key]
  return keys.length === 1 && keys[0] === key && Array.isArray(list) && list.length === 1 && list[0] === 'INBOX'
}

/**
 * Whether ACB may send this Gmail call (`google-client.ts` refuses anything else as `call-not-allowed`,
 * nothing sent): reads (`GET` of messages, threads, history, the profile, labels) with
 * `gmail.readonly`; `messages/send` with `gmail.send`; and with `gmail.modify` exactly
 * `POST messages/<id>/modify` (one message, never a thread) whose body is `{ removeLabelIds: ['INBOX'] }` or
 * `{ addLabelIds: ['INBOX'] }` — never trash, delete, a draft, a send, a read, any other label or a
 * batch. `gmail.modify` is accepted for no other API, and no other API may name a Gmail path. Only
 * `users/me`. One upload: `POST /upload/gmail/v1/users/me/messages/send?uploadType=media` with
 * `gmail.send` and a `message/rfc822` body (a mail with attachments) — no other query, no other
 * upload path.
 */
export function gmailCallAllowed(req: { api: string; method: string; path: string; scope: string; body?: unknown; query?: Record<string, string | string[]>; rawContentType?: string }): boolean {
  if (req.scope === GOOGLE_SCOPE.gmailModify) {
    return req.api === 'gmail' && req.method === 'POST' && GMAIL_MODIFY_RE.test(req.path)
      && (isLabelBody(req.body, 'removeLabelIds') || isLabelBody(req.body, 'addLabelIds'))
  }
  // Google also serves Gmail on www.googleapis.com (the Calendar / Drive host): a Gmail path named
  // under another API is still a Gmail call, and ACB makes none that way.
  if (req.api !== 'gmail') return !mentionsGmail(req.path)
  if (req.method === 'GET') return req.scope === GOOGLE_SCOPE.gmailReadonly && GMAIL_READ_RE.test(req.path)
  if (req.path === GMAIL_UPLOAD_SEND_PATH) {
    const q = req.query ?? {}
    return req.method === 'POST' && req.scope === GOOGLE_SCOPE.gmailSend && req.rawContentType === 'message/rfc822'
      && Object.keys(q).length === 1 && q.uploadType === 'media'
  }
  return req.method === 'POST' && req.path === GMAIL_SEND_PATH && req.scope === GOOGLE_SCOPE.gmailSend
}

/** The one call ACB makes with `drive.metadata.readonly`: a file's owners and shared drive. */
const DRIVE_OWNER_PATH_RE = /^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,200}$/
const DRIVE_OWNER_QUERY = new Set(['fields', 'supportsAllDrives'])

/**
 * Whether ACB makes this call with `drive.metadata.readonly` (enforced by the server's one Google
 * client before anything leaves): only `GET /drive/v3/files/<id>` asking for the owners and the
 * shared drive. Calls with any other scope are not this function's business (true).
 */
export function driveMetadataCallAllowed(req: { api: string; method: string; path: string; scope: string; query?: Record<string, string | string[]> }): boolean {
  if (req.scope !== GOOGLE_SCOPE.driveMetadataReadonly) return true
  if (req.api !== 'drive' || req.method !== 'GET' || !DRIVE_OWNER_PATH_RE.test(req.path)) return false
  const q = req.query ?? {}
  return Object.keys(q).every(k => DRIVE_OWNER_QUERY.has(k)) && q.fields === DRIVE_OWNER_FIELDS
}

/** The fields the relay's owner lookup asks Drive for (and nothing else). */
export const DRIVE_OWNER_FIELDS = 'owners(emailAddress),driveId'

// ---------------------------------------------------------------------------
// Where Google's APIs live (the server's one Google client maps an API to its host).

export const GOOGLE_APIS = ['calendar', 'meet', 'drive', 'docs', 'gmail', 'sheets', 'oauth', 'userinfo'] as const
export type GoogleApi = typeof GOOGLE_APIS[number]

export const GOOGLE_API_HOSTS: Record<GoogleApi, string> = {
  calendar: 'www.googleapis.com',
  drive: 'www.googleapis.com',
  meet: 'meet.googleapis.com',
  /** The minutes' documents: `/v1/documents/…`. */
  docs: 'docs.googleapis.com',
  gmail: 'gmail.googleapis.com',
  /** The relay's Sheets calls (google-relay.ts): `/v4/spreadsheets/…`. */
  sheets: 'sheets.googleapis.com',
  /** POST /token, POST /revoke */
  oauth: 'oauth2.googleapis.com',
  /** GET /oauth2/v3/userinfo */
  userinfo: 'www.googleapis.com',
}

/** The browser's authorization endpoint. */
export const GOOGLE_AUTHORIZE_HOST = 'accounts.google.com'
export const GOOGLE_AUTHORIZE_PATH = '/o/oauth2/v2/auth'

/** Every host ACB's Google connection talks to (the practice redirect maps each one). */
export const GOOGLE_HOSTS: readonly string[] = [
  ...new Set([...Object.values(GOOGLE_API_HOSTS), 'openidconnect.googleapis.com', GOOGLE_AUTHORIZE_HOST]),
]

/** Where Google sends the browser back to (relative to the server's public URL). */
export const GOOGLE_CALLBACK_PATH = '/api/oauth/google/callback'

// ---------------------------------------------------------------------------
// Practice values (the fake Google, staging only): recognisable at a glance.

export const PRACTICE_GOOGLE_SECRET_PREFIX = 'fake-google-secret-'
const PRACTICE_GOOGLE_PREFIXES = [PRACTICE_GOOGLE_SECRET_PREFIX, 'ya29.fake-', '1//fake-', '4/fake-']

/** A client secret, access / refresh token or code of the fake Google (a `Bearer ` prefix is ignored). */
export function isPracticeGoogleSecret(value: string): boolean {
  const v = value.trim().replace(/^Bearer\s+/i, '')
  return PRACTICE_GOOGLE_PREFIXES.some(p => v.startsWith(p))
}

// ---------------------------------------------------------------------------
// The admin's registration (「つなぎ先」→「Google」).

/** Google's web client ids: `<digits>-<letters/digits>.apps.googleusercontent.com`. Kept loose; ASCII only. */
export function checkGoogleClientId(v: unknown): string | null {
  if (typeof v !== 'string') return 'クライアント ID を入れてください。'
  const s = v.trim()
  if (s.length < 10 || s.length > 200 || !/^[A-Za-z0-9._-]+$/.test(s)) return 'クライアント ID の形が正しくありません（Google Cloud の「認証情報」に出ている文字をそのまま貼ってください）。'
  return null
}

/** A client secret: printable ASCII without spaces, 8–200. The message never quotes the value. */
export function checkGoogleClientSecret(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return 'クライアント シークレットを入れてください。'
  const s = v.trim()
  if (s.length < 8 || s.length > 200 || !/^[\x21-\x7e]+$/.test(s)) return 'クライアント シークレットの形が正しくありません（Google Cloud に出ている文字をそのまま貼ってください）。'
  return null
}

/** The company's Workspace domain (`div.example`): lower-case host name with a dot, no scheme or @. */
export function normalizeGoogleDomain(v: unknown): { value: string } | { error: string } {
  if (typeof v !== 'string' || v.trim() === '') return { error: '社内のドメインを入れてください（例: example.co.jp）。' }
  const s = v.trim().toLowerCase().replace(/^@/, '')
  if (s.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) {
    return { error: '社内のドメインの形が正しくありません（例: example.co.jp。https:// や @ は付けません）。' }
  }
  return { value: s }
}

/** Emails compared as ACB stores them (`normalizeEmail`: trimmed, lower case); an unreadable one matches nothing. */
export function sameEmail(a: string, b: string): boolean {
  const x = normalizeEmail(a)
  return x !== null && x === normalizeEmail(b)
}
