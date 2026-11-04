// The card's 元のスレッド (stage 3 A4, outbound-mail.md "Replies"): what main answers for
// `threads:get` and the words the panel shows. The thread is read now on the server with the
// member's own permission and never kept; the app keeps it only while the card is open.
import type { ThreadMessageView, ThreadReplyDraft, ThreadView } from '../../shared/types/threads'

export type { ThreadMessageView, ThreadReplyDraft, ThreadView } from '../../shared/types/threads'

/**
 * `none`: the record has no original 連絡 the member may see (the panel stays hidden — an
 * owner-only one answers the same as none); otherwise the thread or why it could not be read.
 */
export type RecordThreadResult =
  | { success: true; thread: ThreadView }
  | { success: false; none: true }
  | { success: false; none: false; offline: boolean; error: string }

export const THREAD_OFFLINE_TEXT = 'サーバーにつながらないため、元の連絡を読めません。'

export const THREAD_WORDS = {
  title: { email: '元のメール', chat: '元のスレッド' },
  more: 'これより前のメッセージは省いています。',
  mine: 'あなた',
  someone: 'Slack の人',
  truncated: '（長いため、途中まで）',
  replies: '返事の下書き',
} as const

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 320).slice(0, 50) : [])
const REPLY_STATES = new Set(['draft', 'sent', 'unknown', 'discarded'])

function readMessage(x: unknown): ThreadMessageView | null {
  if (!x || typeof x !== 'object') return null
  const m = x as Record<string, unknown>
  const id = str(m.id, 300)
  const text = str(m.text, 50_000)
  if (!id || text === null) return null
  return {
    id, text, fromName: str(m.fromName, 200), fromAddress: str(m.fromAddress, 320), to: strList(m.to), cc: strList(m.cc),
    at: str(m.at, 40), subject: str(m.subject, 1000), truncated: m.truncated === true, mine: m.mine === true,
  }
}

/** A thread from the server, validated (null when malformed). */
export function readThreadView(data: unknown): ThreadView | null {
  if (!data || typeof data !== 'object') return null
  const t = data as Record<string, unknown>
  const recordId = str(t.recordId, 120)
  const interactionId = str(t.interactionId, 120)
  if (!recordId || !interactionId || (t.channel !== 'email' && t.channel !== 'chat') || !Array.isArray(t.messages) || t.messages.length > 100) return null
  const messages = t.messages.map(readMessage)
  if (messages.some(m => m === null)) return null
  const u = t.unavailable && typeof t.unavailable === 'object' ? t.unavailable as Record<string, unknown> : null
  const replies: ThreadReplyDraft[] = (Array.isArray(t.replies) ? t.replies : []).flatMap(r => {
    const x = r && typeof r === 'object' ? r as Record<string, unknown> : {}
    const id = str(x.id, 120)
    return id && REPLY_STATES.has(x.state as string) ? [{ id, state: x.state as ThreadReplyDraft['state'], channel: x.channel === 'slack' ? 'slack' as const : 'email' as const }] : []
  })
  return {
    recordId, interactionId, channel: t.channel, messages: messages as ThreadMessageView[], more: t.more === true,
    unavailable: u && typeof u.text === 'string' && typeof u.reason === 'string'
      ? { reason: u.reason as NonNullable<ThreadView['unavailable']>['reason'], text: u.text.slice(0, 500), allow: u.allow === 'google-inbox' || u.allow === 'slack-read' ? u.allow : null }
      : null,
    replies,
  }
}

/** Who wrote a message, as the panel shows it. */
export function authorLine(m: ThreadMessageView): string {
  if (m.mine) return THREAD_WORDS.mine
  if (m.fromName && m.fromAddress) return `${m.fromName} <${m.fromAddress}>`
  return m.fromName ?? m.fromAddress ?? THREAD_WORDS.someone
}

/** A piece of a chat message's text: plain, or Slack's `*bold*`. Drawn as text only (never as HTML). */
export interface ChatTextRun { text: string; bold: boolean }

// `*bold*`: no space just inside the stars, on one line (Slack's rule, without its word-boundary
// rule, which Japanese text has no spaces for).
const BOLD_RE = /\*([^*\s](?:[^*\n]*[^*\s])?)\*/g

/**
 * A Slack message's text (already plain on the server: mentions as `@name`, links as labels,
 * slack-chat.ts `slackPlainText`) cut into runs at Slack's `*bold*`. Everything else stays
 * literal text — `<`, `&` and tags included: the panel puts runs into the page as text.
 */
export function chatTextRuns(text: string): ChatTextRun[] {
  const runs: ChatTextRun[] = []
  let at = 0
  for (const m of text.matchAll(BOLD_RE)) {
    const start = m.index ?? 0
    if (start > at) runs.push({ text: text.slice(at, start), bold: false })
    runs.push({ text: m[1], bold: true })
    at = start + m[0].length
  }
  if (at < text.length) runs.push({ text: text.slice(at), bold: false })
  return runs
}
