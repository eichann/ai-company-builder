// The member's notice that the AI action log (monitoring M1) goes to the
// company's administrators (owner decision, 2026-10-25): shown once per
// account on this PC the first time the chat opens, and always in Settings.
// What is sent: electron/services/agent-event-sender.ts.

export const AGENT_LOG_NOTICE_TEXT = 'AI の操作の記録（いつ・どの道具を・どこに使ったか。会話やファイルの中身は含みません）が、会社の管理者に送られます。'
export const AGENT_LOG_NOTICE_MORE = '詳しくは管理者にお問い合わせください。'

const key = (userId: string) => `acb.agentLogNoticeSeen:${userId}`

/** Whether this account still has to see the one-time notice (storage unavailable → no: never nag). */
export function shouldShowAgentLogNotice(userId: string): boolean {
  try { return localStorage.getItem(key(userId)) === null } catch { return false }
}

export function markAgentLogNoticeSeen(userId: string): void {
  try { localStorage.setItem(key(userId), new Date().toISOString()) } catch { /* shown again next time */ }
}
