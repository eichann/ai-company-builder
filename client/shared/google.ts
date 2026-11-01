// The Google connection as the app sees it (.claude/rules/google-connector.md):
// what main answers the renderer, the plain-Japanese words for the member's
// state, and which sign-in page main may open. Pure: used by main (the server
// client) and the renderer. Nothing here ever holds a token: the app has none.
import { GOOGLE_AUTHORIZE_HOST, GOOGLE_AUTHORIZE_PATH, type GoogleFeature } from '../../shared/core/google'
import type { GoogleGrantStatus, GoogleUnavailableReason, MyGoogle } from '../../shared/types/google'

export type { GoogleFeature } from '../../shared/core/google'
export type { GoogleGrantStatus, GoogleUnavailableReason, MyGoogle } from '../../shared/types/google'

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
  canDisconnect: boolean
  domainHint: string | null
}

export function googleSectionView(my: MyGoogle): GoogleSectionView {
  const unavailable = my.available ? null : GOOGLE_UNAVAILABLE_TEXT[my.reason ?? 'not-configured']
  const ended = !my.connected && my.status ? GOOGLE_GRANT_STATUS_TEXT[my.status] ?? null : null
  return {
    account: my.connected ? my.googleEmail : null,
    allowed: my.connected ? my.features.map(f => GOOGLE_FEATURE_LABEL[f]) : [],
    notice: unavailable ?? ended,
    connectFeatures: my.available && !my.connected ? ['minutes'] : null,
    canAddMail: my.available && my.connected && !my.features.includes('mail'),
    canDisconnect: my.connected || my.status !== null,
    domainHint: my.domain ? `会社の Google アカウント（@${my.domain}）で許可してください。` : null,
  }
}
