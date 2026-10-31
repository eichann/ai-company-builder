// The member's notice that the AI action log (monitoring M1) goes to the
// company's administrators (owner decision, 2026-10-25): shown once per
// account on this PC the first time the chat opens, and always in Settings.
// What is sent: electron/services/agent-event-sender.ts.

export const AGENT_LOG_NOTICE_TEXT = 'AI の操作の記録（いつ・どの道具を・どこに使ったか。会話やファイルの中身は含みません）が、会社の管理者に送られます。'
export const AGENT_LOG_NOTICE_MORE = '詳しくは管理者にお問い合わせください。'

/**
 * 「AI の囲い」 (the company's AI sandbox, .claude/rules/agent-sandbox.md): what a
 * member should know, in Settings next to the log notice. True whatever the
 * company chose (off / record only / enforce), so it needs no policy here.
 */
export const SANDBOX_NOTICE_TEXT = '会社の設定によっては、AI が実行するコマンドは「AI の囲い」の中で動きます。会社が許可した宛先にだけ接続でき、パスワードや鍵などの大事な場所は読めません。必要な宛先が止められたときは、管理者に相談してください。'

const key = (userId: string) => `acb.agentLogNoticeSeen:${userId}`

/** Whether this account still has to see the one-time notice (storage unavailable → no: never nag). */
export function shouldShowAgentLogNotice(userId: string): boolean {
  try { return localStorage.getItem(key(userId)) === null } catch { return false }
}

export function markAgentLogNoticeSeen(userId: string): void {
  try { localStorage.setItem(key(userId), new Date().toISOString()) } catch { /* shown again next time */ }
}
