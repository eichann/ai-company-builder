/**
 * API contract of outbound mail (milestone 4 G8, `.claude/rules/outbound-mail.md`;
 * design 節目4 §1-6, §3-5, §4-2 … §4-5). Mounted at /api/companies/:companyId
 * (a person's session) and /api/records-ai (their AI's record token).
 *
 * Session (the member's own screens):
 *   POST /outbound-recipients               { minutesId?, dealId? } → MailRecipientsView
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
 */
import type { RecipientSource, VerifiedRecipient } from '../core/mail'

export type OutboundMailState = 'draft' | 'sent' | 'unknown' | 'discarded'

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
  /** The member's Google account (their ACB email). */
  from: string
  to: MailRecipientView[]
  cc: MailRecipientView[]
  subject: string
  /** Null once deleted (30 days after sent / discarded). */
  body: string | null
  bodyDeleted: boolean
  /** Links in the body (「本文にリンクが N つあります」). */
  linkCount: number
  minutesId: string | null
  dealId: string | null
  sentAt: string | null
  /** Gmail's message id (only after a confirmed send). */
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
  minutesId?: string
  dealId?: string
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
  /** Sent, but Gmail's answer was lost: 「届いたか分かりません。Gmail の送信済みを確かめてください」. Never re-sent. */
  | { outcome: 'unknown'; draft: OutboundMailView; message: string }
