// The key broker as the app sees it (.claude/rules/key-broker.md): the
// member's own keys (「自分の鍵」, K8) and the plain-Japanese words for what
// the server answers. Pure: used by main (the server client) and the renderer.
import type { BrokerKeyCheckResult } from '../../shared/core/key-broker'
import type { MyBrokerKeys, OwnKeyBlocked } from '../../shared/types/key-broker'

export type { BrokerKeyCheck, MyBrokerKeys, MyBrokerService, OwnBrokerKey, OwnKeyBlocked } from '../../shared/types/key-broker'
export type { BrokerKeyCheckResult } from '../../shared/core/key-broker'

/** What main answers the renderer: the member's view, or why not (never a key value). */
export type OwnKeysResult =
  | { success: true; data: MyBrokerKeys }
  | { success: false; offline: boolean; error: string }

/** What main answers when a key is moved from this computer's .env to the server. */
export type OwnKeyMoveResult =
  | { success: true; data: MyBrokerKeys; /** The name was taken out of the .env (only after the server kept the key). */ removed: boolean }
  | { success: false; offline: boolean; error: string }

/**
 * The company .env names that hold a built-in service's key (what scripts
 * read before the key broker), and the service each one is for. Only these
 * can be moved to the server as one's own key.
 */
export const ENV_KEY_SERVICES: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GEMINI_API_KEY: 'gemini',
  GOOGLE_API_KEY: 'gemini',
}

/**
 * How the server's one check of a saved key went, in the member's words. They
 * claim no more than that: valid now, refused, or not known.
 */
export const KEY_CHECK_TEXT: Record<BrokerKeyCheckResult, string> = {
  valid: '鍵が有効なことを確かめました。',
  rejected: 'この鍵は使えませんでした（発行元の画面で確かめてください）。',
  unreachable: '確かめられませんでした（通信できません）。鍵は保存しました。',
  unconfirmed: '確かめられませんでした（発行元から、はっきりした答えがありませんでした）。鍵は保存しました。',
  limited: '鍵は使えますが、権限が足りないかもしれません（発行元の画面で、鍵の権限を確かめてください）。鍵は保存しました。',
  'not-checkable': 'この鍵は、実際に使うまで確かめられません。鍵は保存しました。',
}

export const OWN_KEY_BLOCKED_TEXT: Record<OwnKeyBlocked, string> = {
  'member-keys-off': 'この会社では、メンバーが自分の鍵を登録することは許可されていません。',
  'company-only': 'このサービスは会社の鍵だけを使う設定です。',
  'no-destinations': 'このサービスの「自分の鍵」の送り先を、管理者がまだ許可していません。',
}

export const OWN_KEYS_OFFLINE_TEXT = 'サーバーに接続できませんでした。時間をおいてもう一度お試しください。'

/**
 * The words for a refused own-key request. Built only from the status and
 * the server's codes — never from its error text — so nothing the request
 * carried (the key) can come back through here.
 */
export function ownKeysErrorText(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; reason?: unknown }
  if (b.code === 'OWN_KEY_NOT_ALLOWED' && typeof b.reason === 'string' && b.reason in OWN_KEY_BLOCKED_TEXT) {
    return `${OWN_KEY_BLOCKED_TEXT[b.reason as OwnKeyBlocked]}管理者に相談してください。`
  }
  if (b.code === 'KEY_REJECTED') return `${KEY_CHECK_TEXT.rejected}保存していません。`
  if (b.code === 'BROKER_OFF') return 'サーバーで API キーを預かる機能が、まだ使えるようになっていません。管理者に相談してください。'
  if (status === 400) return 'キーの形が正しくありません。発行元の画面からコピーした鍵を、空白なしでそのまま貼り付けてください。'
  if (status === 401) return 'サインインし直してから、もう一度お試しください。'
  if (status === 404) return 'このサーバーは「自分の鍵」にまだ対応していないか、このサービスが見つかりません。'
  if (status === 409) return '同じ鍵が別の画面で変更されました。もう一度お試しください。'
  return `保存できませんでした（サーバーの応答 ${status}）。`
}
