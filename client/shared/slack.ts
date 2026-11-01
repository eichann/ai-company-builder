// The Slack connection as the app sees it (.claude/rules/slack-connector.md):
// what main answers the renderer, the plain-Japanese words for the member's
// state, and which sign-in page main may open. Pure: used by main (the server
// client) and the renderer. Nothing here ever holds a token: the app has none.
import type { SlackFeature } from '../../shared/core/slack'
import type { MySlack, SlackGrantStatus, SlackUnavailableReason } from '../../shared/types/slack'

export type { SlackFeature } from '../../shared/core/slack'
export type { MySlack, SlackGrantStatus, SlackUnavailableReason } from '../../shared/types/slack'

/** What main answers the renderer: the member's view, or why not (built from status codes only). */
export type SlackStatusResult =
  | { success: true; data: MySlack }
  | { success: false; offline: boolean; error: string }

/** 「Slack で許可」: main opened the sign-in page in the browser (the URL itself stays in main). */
export type SlackConnectResult =
  | { success: true }
  | { success: false; offline: boolean; error: string }

export const SLACK_OFFLINE_TEXT = 'サーバーに接続できませんでした。時間をおいてもう一度お試しください。'

/** What each feature lets ACB do, in the member's words. */
export const SLACK_FEATURE_LABEL: Record<SlackFeature, string> = {
  read: '自分あての DM とメンションを受け取る',
  reply: '返事を送る',
  notices: '大事な知らせ（あなたの番）を DM で受け取る',
}

export const SLACK_UNAVAILABLE_TEXT: Record<SlackUnavailableReason, string> = {
  'not-configured': '管理者がまだ Slack をつないでいません。',
  off: '管理者が Slack を止めています。',
  'vault-off': 'サーバーの準備ができていないため使えません。管理者に確かめてください。',
  'operator-stopped': 'いまは Slack を使えません（運用担当者が止めています）。',
}

export const SLACK_GRANT_STATUS_TEXT: Partial<Record<SlackGrantStatus, string>> = {
  stopped: '管理者がこの許可を止めました。もう一度「Slack で許可」を押すと使えます。',
  revoked: '許可が取り消されました（Slack 側か、会社の Slack の登録が変わったため）。もう一度「Slack で許可」を押してください。',
}

export const SLACK_OPENED_TEXT = 'ブラウザで Slack の画面を開きました。許可したらこの画面に戻ってください。'
export const SLACK_PRACTICE_TEXT = '練習用の Slack につながっています'

/**
 * The words for a refused request. Built only from the status and the
 * server's codes — never from its error text.
 */
export function slackErrorText(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; reason?: unknown }
  if (b.code === 'SLACK_UNAVAILABLE') {
    return typeof b.reason === 'string' && b.reason in SLACK_UNAVAILABLE_TEXT
      ? SLACK_UNAVAILABLE_TEXT[b.reason as SlackUnavailableReason]
      : 'いまは Slack とつなげません。管理者に確かめてください。'
  }
  if (b.code === 'SLACK_NOT_CONNECTED') return 'まだ Slack で許可していません。'
  if (b.code === 'SLACK_FEATURE_NOT_GRANTED') return 'この機能はまだ許可していません。先に「Slack で許可」で足してください。'
  if (status === 401) return 'サインインし直してから、もう一度お試しください。'
  if (status === 404) return 'このサーバーは Slack との連携にまだ対応していません。'
  return `うまくいきませんでした（サーバーの応答 ${status}）。`
}

/** Slack's sign-in page (OAuth v2). */
export const SLACK_AUTHORIZE_HOST = 'slack.com'
export const SLACK_AUTHORIZE_PATH = '/oauth/v2/authorize'

/**
 * The only pages main opens for 「Slack で許可」: Slack's sign-in page over
 * https, or (staging) the practice Slack on this machine.
 */
export function isSlackSignInUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.pathname !== SLACK_AUTHORIZE_PATH || u.username || u.password) return false
  if (u.protocol === 'https:') return u.hostname === SLACK_AUTHORIZE_HOST && u.port === ''
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
}

/** What the section shows for the member's state. */
export interface SlackSectionView {
  allowed: string[]
  connected: boolean
  /** Why it cannot be used / why the old permission ended (one sentence), or null. */
  notice: string | null
  /** 「Slack で許可」 asks for these; null = no button. */
  connectFeatures: SlackFeature[] | null
  /** 「返事を送る許可も足す」 when connected without reply. */
  canAddReply: boolean
  /** The 知らせの DM switch: shown when allowed; `on` = not turned off. */
  notices: { on: boolean } | null
  canDisconnect: boolean
}

export function slackSectionView(my: MySlack): SlackSectionView {
  const unavailable = my.available ? null : SLACK_UNAVAILABLE_TEXT[my.reason ?? 'not-configured']
  const ended = !my.connected && my.status ? SLACK_GRANT_STATUS_TEXT[my.status] ?? null : null
  const off = my.featuresOff ?? []
  return {
    allowed: my.connected ? my.features.map(f => `${SLACK_FEATURE_LABEL[f]}${off.includes(f) ? '（オフにしています）' : ''}`) : [],
    connected: my.connected,
    notice: unavailable ?? ended,
    connectFeatures: my.available && !my.connected ? ['read', 'notices'] : null,
    canAddReply: my.available && my.connected && !my.features.includes('reply'),
    notices: my.connected && my.features.includes('notices') ? { on: !off.includes('notices') } : null,
    canDisconnect: my.connected || my.status !== null,
  }
}
