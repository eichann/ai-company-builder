// The key broker as the app sees it (.claude/rules/key-broker.md): the
// member's own keys (「自分の鍵」, K8) and the plain-Japanese words for what
// the server answers. Pure: used by main (the server client) and the renderer.
import type { MyBrokerKeys, OwnKeyBlocked } from '../../shared/types/key-broker'

export type { MyBrokerKeys, MyBrokerService, OwnBrokerKey, OwnKeyBlocked } from '../../shared/types/key-broker'

/** What main answers the renderer: the member's view, or why not (never a key value). */
export type OwnKeysResult =
  | { success: true; data: MyBrokerKeys }
  | { success: false; offline: boolean; error: string }

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
  if (b.code === 'BROKER_OFF') return 'サーバーで API キーを預かる機能が、まだ使えるようになっていません。管理者に相談してください。'
  if (status === 400) return 'キーの形が正しくありません。発行元の画面からコピーした鍵を、空白なしでそのまま貼り付けてください。'
  if (status === 401) return 'サインインし直してから、もう一度お試しください。'
  if (status === 404) return 'このサーバーは「自分の鍵」にまだ対応していないか、このサービスが見つかりません。'
  if (status === 409) return '同じ鍵が別の画面で変更されました。もう一度お試しください。'
  return `保存できませんでした（サーバーの応答 ${status}）。`
}
