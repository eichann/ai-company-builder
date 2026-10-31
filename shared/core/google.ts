/**
 * The Google connection (milestone 4 G3, `.claude/rules/google-connector.md`):
 * which Google permissions (scopes) each ACB feature asks for, the hosts each
 * Google API lives on, and the input rules of the admin's registration.
 *
 * Owner decisions (design §5-2, §9 q8/q10): ask only for what a feature
 * needs, when it is first needed (minutes first, `gmail.send` when mail is
 * first used); never `drive.readonly`, `gmail.compose`, `gmail.readonly`,
 * `gmail.metadata` or domain-wide delegation. The Google account must be the
 * member's own ACB email.
 *
 * Pure: imports nothing outside shared/core.
 */
import { normalizeEmail } from './mail'

export const GOOGLE_FEATURES = ['minutes', 'mail'] as const
/** minutes = 予定と議事録を読む, mail = メールを送る. */
export type GoogleFeature = typeof GOOGLE_FEATURES[number]

export const GOOGLE_SCOPE = {
  openid: 'openid',
  /** `email` is Google's short name for this one; Google reports the long form. */
  email: 'https://www.googleapis.com/auth/userinfo.email',
  calendarEventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  meetReadonly: 'https://www.googleapis.com/auth/meetings.space.readonly',
  driveMeetReadonly: 'https://www.googleapis.com/auth/drive.meet.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
} as const

/** Asked with every feature: to read which account was allowed (and that its address is verified). */
const IDENTITY_SCOPES = [GOOGLE_SCOPE.openid, GOOGLE_SCOPE.email]

/** What each feature asks Google for (besides the identity scopes). */
export const GOOGLE_FEATURE_SCOPES: Record<GoogleFeature, readonly string[]> = {
  minutes: [GOOGLE_SCOPE.calendarEventsReadonly, GOOGLE_SCOPE.meetReadonly, GOOGLE_SCOPE.driveMeetReadonly],
  mail: [GOOGLE_SCOPE.gmailSend],
}

/** Every scope ACB may hold. Anything else Google reports as granted is not stored. */
export const GOOGLE_ALLOWED_SCOPES: readonly string[] = [
  ...IDENTITY_SCOPES,
  ...GOOGLE_FEATURE_SCOPES.minutes,
  ...GOOGLE_FEATURE_SCOPES.mail,
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

/** The features whose every scope is granted. */
export function googleFeaturesOf(scopes: readonly string[]): GoogleFeature[] {
  return GOOGLE_FEATURES.filter(f => GOOGLE_FEATURE_SCOPES[f].every(s => scopes.includes(s)))
}

// ---------------------------------------------------------------------------
// Where Google's APIs live (the server's one Google client maps an API to its host).

export const GOOGLE_APIS = ['calendar', 'meet', 'drive', 'gmail', 'oauth', 'userinfo'] as const
export type GoogleApi = typeof GOOGLE_APIS[number]

export const GOOGLE_API_HOSTS: Record<GoogleApi, string> = {
  calendar: 'www.googleapis.com',
  drive: 'www.googleapis.com',
  meet: 'meet.googleapis.com',
  gmail: 'gmail.googleapis.com',
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
