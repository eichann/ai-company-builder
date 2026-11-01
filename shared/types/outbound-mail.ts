/**
 * API contract of outbound mail (milestone 4 G8, `.claude/rules/outbound-mail.md`;
 * design 節目4 §1-6, §3-5, §4-2 … §4-5). Mounted at /api/companies/:companyId
 * (a person's session) and /api/records-ai (their AI's record token).
 *
 * Session (the member's own screens):
 *   POST /outbound-recipients               { meetingId?, bundleId? } → MailRecipientsView
 *   POST /outbound                          MailDraftInput → 201 { draft: OutboundMailView }
 *   GET  /outbound/:messageId               → { draft: OutboundMailView }
 *   PUT  /outbound/:messageId               MailDraftChange → { draft }
 *   GET  /outbound/:messageId/recipients    → MailRecipientsView (the draft's sources, typed ones included)
 *   POST /outbound/:messageId/recipients    { email, name? } → { recipient, draft } (「あなたが入力」, a person only)
 *   POST /outbound/:messageId/send          { hash } → MailSendAnswer        (a person only)
 *   POST /outbound/:messageId/resolve       { sent: boolean } → { draft }    (after an unknown send; a person only)
 *   POST /outbound/:messageId/discard       {} → { draft }                   (a person only)
 *
 * Record token (the member's AI): POST /outbound-recipients (read), POST /outbound
 * (act), GET /outbound/:messageId (read), PUT /outbound/:messageId (act). There is
 * no send, resolve, discard or typed address for the AI: no route exists.
 *
 * Refusal codes: MAIL_NOT_FOUND (404, also another company's / another member's
 * draft), RECIPIENT_NOT_OFFERED (400: a ref not from a source), MAIL_INVALID (400,
 * `problems`), VERSION_CONFLICT (409), NOT_DRAFT (409), CONTENT_CHANGED (409, with
 * `draft`), RECIPIENTS_UNVERIFIABLE (409), RECIPIENT_GONE (409, `goneRefs`),
 * GOOGLE_CONSENT_NEEDED (409, `needsGoogleConsent: 'mail'`), GOOGLE_UNAVAILABLE (503),
 * SEND_REFUSED (409), SEND_IN_PROGRESS (409), RECORDS_DISABLED (404).
 *
 * Replies (A4, outbound-mail.md "Replies"): a draft with `interactionId` answers that
 * 来た連絡 in its own thread — mail: a reply in the member's own Gmail conversation
 * (recipients from the thread: source `thread`); Slack (`channel: 'slack'`): a reply
 * in the thread as the member, body only. Codes: THREAD_UNKNOWN (409: the 連絡 has no
 * thread to answer), THREAD_UNREADABLE (409: the thread cannot be read now),
 * SLACK_CONSENT_NEEDED (409, `needsSlackConsent: 'reply'`), SLACK_FEATURE_OFF (409),
 * SLACK_UNAVAILABLE (503).
 */
import type { RecipientSource, VerifiedRecipient } from '../core/mail'

export type OutboundMailState = 'draft' | 'sent' | 'unknown' | 'discarded'

/** Where it goes: a mail, or a reply in a Slack thread. */
export type OutboundChannel = 'email' | 'slack'

export interface MailRecipientView extends VerifiedRecipient {
  /** An address outside the company's domain that no earlier sent mail of the company went to (「この宛先に送るのは初めてです」). */
  firstTime: boolean
}

export interface OutboundMailView {
  /** The outbound_message record id. */
  id: string
  state: OutboundMailState
  /** The content's version (1, 2, …): every change makes a new one. */
  version: number
  /** `sha256:<hex>` of this version's canonical content; the send carries it back. */
  hash: string
  /** email: a mail (Gmail); slack: a reply in a Slack thread (no recipients, no subject). */
  channel: OutboundChannel
  /** The 来た連絡 (interaction) it answers in its own thread, else null. */
  interactionId: string | null
  /** The member's Google account (their ACB email); for Slack, the address their Slack permission is for. */
  from: string
  to: MailRecipientView[]
  cc: MailRecipientView[]
  subject: string
  /** Null once deleted (30 days after sent / discarded). */
  body: string | null
  bodyDeleted: boolean
  /** Links in the body (「本文にリンクが N つあります」). */
  linkCount: number
  meetingId: string | null
  bundleId: string | null
  sentAt: string | null
  /** Gmail's message id / the Slack message's ts (only after a confirmed send). */
  providerMessageId: string | null
  /** The member wrote it on the screen, or their AI (the latest version's author). */
  lastChangedBy: 'human' | 'ai'
  updatedAt: string
}

export interface MailRecipientsView {
  recipients: MailRecipientView[]
  /** Sources that could not be read just now (their addresses are not offered): calendar / hubspot. */
  unreadable: RecipientSource[]
}

export interface MailDraftInput {
  /** The meeting (会議) the mail is about. */
  meetingId?: string
  /** The まとまり (any type implementing `bundle`: a 案件…) it is about; a meeting's own is taken along. */
  bundleId?: string
  /** The 来た連絡 it answers in its own thread (its まとまり is taken along); its channel decides mail or Slack. */
  interactionId?: string
  /** Mail only (a Slack reply has no recipients). */
  toRefs: string[]
  ccRefs?: string[]
  subject: string
  body: string
}

export interface MailDraftChange {
  /** The version the change is made on (`OutboundMailView.version`). */
  expectedVersion: number
  toRefs?: string[]
  ccRefs?: string[]
  subject?: string
  body?: string
}

export type MailSendAnswer =
  | { outcome: 'sent'; draft: OutboundMailView }
  /** Sent, but the answer was lost: 「届いたか分かりません。…を確かめてください」. Never re-sent. */
  | { outcome: 'unknown'; draft: OutboundMailView; message: string }
