// The Google connection as the app sees it (.claude/rules/google-connector.md):
// what main answers the renderer, the plain-Japanese words for the member's
// state, and which sign-in page main may open. Pure: used by main (the server
// client) and the renderer. Nothing here ever holds a token: the app has none.
import { GOOGLE_AUTHORIZE_HOST, GOOGLE_AUTHORIZE_PATH, type GoogleFeature } from '../../shared/core/google'
import type { GoogleGrantStatus, GoogleUnavailableReason, MyGoogle, MyGoogleRelay } from '../../shared/types/google'

export type { GoogleFeature } from '../../shared/core/google'
export type { GoogleGrantStatus, GoogleRelayRecord, GoogleUnavailableReason, MyGoogle, MyGoogleRelay } from '../../shared/types/google'
export { googleRelayRecordWords } from '../../shared/core/google-relay'

/** What main answers the renderer: the member's view, or why not (built from status codes only). */
export type GoogleStatusResult =
  | { success: true; data: MyGoogle }
  | { success: false; offline: boolean; error: string }

/** 「Google で許可」: main opened the sign-in page in the browser (the URL itself stays in main). */
export type GoogleConnectResult =
  | { success: true }
  | { success: false; offline: boolean; error: string }

export const GOOGLE_OFFLINE_TEXT = 'サーバーに接続できませんでした。時間をおいてもう一度お試しください。'

/** What each feature lets ACB do, in the member's words. */
export const GOOGLE_FEATURE_LABEL: Record<GoogleFeature, string> = {
  minutes: '予定と議事録を読む',
  mail: 'メールを送る',
  drive: 'Drive で選んだものを読む・置く',
  inbox: '受信を読む',
  sheets: 'スプレッドシートを中継で使う',
  inbox_archive: '済んだメールを Gmail でもアーカイブする',
}

export const GOOGLE_UNAVAILABLE_TEXT: Record<GoogleUnavailableReason, string> = {
  'not-configured': '管理者がまだ Google をつないでいません。',
  off: '管理者が Google を止めています。',
  'vault-off': 'サーバーの準備ができていないため使えません。管理者に確かめてください。',
  'operator-stopped': 'いまは Google を使えません（運用担当者が止めています）。',
}

export const GOOGLE_GRANT_STATUS_TEXT: Partial<Record<GoogleGrantStatus, string>> = {
  stopped: '管理者がこの許可を止めました。もう一度「Google で許可」を押すと使えます。',
  revoked: 'Google 側で許可が取り消されました。もう一度「Google で許可」を押してください。',
}

export const GOOGLE_OPENED_TEXT = 'ブラウザで Google の画面を開きました。許可したらこの画面に戻ってください。'
export const GOOGLE_PRACTICE_TEXT = '練習用の Google につながっています'

/**
 * The words for a refused request. Built only from the status and the
 * server's codes — never from its error text.
 */
export function googleErrorText(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; reason?: unknown }
  if (b.code === 'GOOGLE_UNAVAILABLE') {
    return typeof b.reason === 'string' && b.reason in GOOGLE_UNAVAILABLE_TEXT
      ? GOOGLE_UNAVAILABLE_TEXT[b.reason as GoogleUnavailableReason]
      : 'いまは Google とつなげません。管理者に確かめてください。'
  }
  if (b.code === 'GOOGLE_FEATURE_COMPANY_OFF') return 'この機能は会社で使っていません。管理者に確かめてください。'
  if (status === 401) return 'サインインし直してから、もう一度お試しください。'
  if (status === 404) return 'このサーバーは Google との連携にまだ対応していません。'
  return `うまくいきませんでした（サーバーの応答 ${status}）。`
}

/**
 * The only pages main opens for 「Google で許可」: Google's sign-in page over
 * https, or (staging) the practice Google on this machine.
 */
export function isGoogleSignInUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.pathname !== GOOGLE_AUTHORIZE_PATH || u.username || u.password) return false
  if (u.protocol === 'https:') return u.hostname === GOOGLE_AUTHORIZE_HOST && u.port === ''
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
}

/** A grant from before the Docs API: reading works, without Gemini's notes. */
export const GOOGLE_RENEW_MINUTES_TEXT = 'Google の許可をし直すと、メモも読めるようになります'

/** What the section shows for the member's state. */
export interface GoogleSectionView {
  /** The account and what is allowed, when connected. */
  account: string | null
  allowed: string[]
  /** Why it cannot be used / why the old permission ended (one sentence), or null. */
  notice: string | null
  /** 「Google で許可」 asks for these (minutes first); null = no button. */
  connectFeatures: GoogleFeature[] | null
  /** 「メールを送る許可も足す」 when connected without mail. */
  canAddMail: boolean
  /** 「受信を読む許可も足す」 when connected without 受信を読む (asked only when the member wants it). */
  canAddInbox: boolean
  /** 「許可をし直す」: connected before the minutes' documents could be read by name (`MyGoogle.renew`). */
  canRenewMinutes: boolean
  canDisconnect: boolean
  domainHint: string | null
  /**
   * 「済んだメールを Gmail でもアーカイブする」 (owner decision 2026-11-05), only while the company offers it
   * and the member is connected: allow = ［許可する］ (Google's page), resume = ［オンにする］ (they only
   * turned it off: no new consent), on = ［やめる］. null: not shown.
   */
  archive: 'allow' | 'resume' | 'on' | null
}

/** What the archive card says (plain words: no labels, scopes or permissions' names). */
export const GOOGLE_ARCHIVE_TEXT = 'ACB で来た連絡を「済んだ」「取り込まない」にしたときや、そこから作ったやることがすべて終わったときに、Gmail でもそのメールをアーカイブします（受信トレイから外すだけで、消したり送ったりはしません）。知らせの［元に戻す］で受信トレイに戻せます。'

/** 「やめる」 stops ACB using it; the permission itself stays with Google until 「許可をやめる」. */
export const GOOGLE_ARCHIVE_STOP_TEXT = '「やめる」と ACB は Gmail をアーカイブしなくなりますが、Google での許可そのものは残ります。許可ごと取り消すには上の「許可をやめる」を押してください（予定や議事録なども読めなくなります）。'

/** The company offers the feature (an older server without the list: as before, offered). */
const offered = (my: MyGoogle, f: GoogleFeature) => !my.companyFeatures || my.companyFeatures.includes(f)

export function googleSectionView(my: MyGoogle): GoogleSectionView {
  const unavailable = my.available ? null : GOOGLE_UNAVAILABLE_TEXT[my.reason ?? 'not-configured']
  const ended = !my.connected && my.status ? GOOGLE_GRANT_STATUS_TEXT[my.status] ?? null : null
  return {
    account: my.connected ? my.googleEmail : null,
    allowed: my.connected ? my.features.map(f => `${GOOGLE_FEATURE_LABEL[f]}${(my.featuresOff ?? []).includes(f) ? '（オフにしています）' : ''}`) : [],
    notice: unavailable ?? ended,
    connectFeatures: my.available && !my.connected ? ['minutes'] : null,
    canAddMail: my.available && my.connected && !my.features.includes('mail') && offered(my, 'mail'),
    canAddInbox: my.available && my.connected && !my.features.includes('inbox') && offered(my, 'inbox'),
    canRenewMinutes: my.available && my.connected && (my.renew ?? []).includes('minutes'),
    canDisconnect: my.connected || my.status !== null,
    domainHint: my.domain ? `会社の Google アカウント（@${my.domain}）で許可してください。` : null,
    archive: !my.available || !my.connected || !(my.offeredByName ?? []).includes('inbox_archive') ? null
      : !my.features.includes('inbox_archive') ? 'allow'
        : (my.featuresOff ?? []).includes('inbox_archive') ? 'resume' : 'on',
  }
}

// ---------------------------------------------------------------------------
// 「スプレッドシートを中継で使う」 (google-connector.md "The relay").

/** The relay as main answers the renderer: the member's view, or why not (built from status codes only). */
export type GoogleRelayResult =
  | { success: true; data: MyGoogleRelay }
  | { success: false; offline: boolean; error: string }

/** What the card shows, or null when the company does not offer the relay (no card). */
export interface GoogleRelayCardView {
  /** allow: ［許可する］ opens Google's page (a consent); resume: ［許可する］ turns it back on (no consent: the permission is kept); allowed: ［やめる］. */
  state: 'allow' | 'resume' | 'allowed'
  /** 「今日 37回 ／ 上限 500回」 */
  usage: string
  /** Why scripts cannot reach a sheet now although the member allowed it (an admin's stop), or null. */
  notice: string | null
}

export function googleRelayCardView(r: MyGoogleRelay): GoogleRelayCardView | null {
  const sheets = r.services.find(s => s.service === 'sheets')
  if (!r.available || !sheets?.offered) return null
  const state = sheets.allowed ? 'allowed' : sheets.turnedOff ? 'resume' : 'allow'
  const notice = !sheets.allowed ? null
    : r.stopped === 'company' ? '管理者が、いま全員の Google の中継を止めています。スクリプトは表に届きません（許可はそのまま残っています）。'
      : r.stopped === 'member' ? '管理者が、いまあなたの Google の中継を止めています。スクリプトは表に届きません（許可はそのまま残っています）。' : null
  return { state, usage: `今日 ${r.usedToday}回 ／ 上限 ${r.capPerDay}回`, notice }
}
