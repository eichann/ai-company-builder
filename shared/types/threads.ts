/**
 * API contract of the card's 元のスレッド (stage 3 A4, `.claude/rules/outbound-mail.md`
 * "Replies"): the original thread of a record that came from outside (an
 * interaction, or a record linking one: a reply request, a task), read now
 * through the role with the viewing member's own permission. The server keeps
 * nothing of it.
 *
 *   GET /api/companies/:companyId/threads/:recordId   (session)       → { thread: ThreadView }
 *   GET /api/records-ai/threads/:recordId             (record token)  → { thread: ThreadView }
 *
 * A record the member cannot read, one without an original 連絡, and a
 * missing or another company's one answer the same 404 `THREAD_NOT_FOUND`.
 */
import type { OutboundChannel, OutboundMailState } from './outbound-mail'

export type ThreadChannel = 'email' | 'chat'

export interface ThreadMessageView {
  /** The message's id at the service (opaque). */
  id: string
  /** The sender as the service shows them (mail: name and address; chat: the display name, no address). */
  fromName: string | null
  fromAddress: string | null
  /** Mail only: To / CC addresses. */
  to: string[]
  cc: string[]
  at: string | null
  /** Mail only. */
  subject: string | null
  text: string
  truncated: boolean
  /** The viewing member wrote it. */
  mine: boolean
}

/** Why the thread is not shown: the member's permission, a stop, or nothing to read. */
export type ThreadUnavailableReason = 'not-connected' | 'turned-off' | 'stopped' | 'choice-needed' | 'not-found' | 'unavailable' | 'no-thread'

export interface ThreadReplyDraft {
  /** The outbound_message record (the member's own draft; `outboundMail:get` reads it). */
  id: string
  state: OutboundMailState
  channel: OutboundChannel
}

export interface ThreadView {
  /** The record asked about. */
  recordId: string
  /** The 来た連絡 (interaction) whose thread this is. */
  interactionId: string
  channel: ThreadChannel
  /** Oldest first; `more` when earlier ones were left out. */
  messages: ThreadMessageView[]
  more: boolean
  /** Null when the thread was read; else why not, with a sentence for the member. */
  unavailable: { reason: ThreadUnavailableReason; text: string; allow: 'google-inbox' | 'slack-read' | null } | null
  /** The member's own reply drafts to this 連絡 (newest first). */
  replies: ThreadReplyDraft[]
}
