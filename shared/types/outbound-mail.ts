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
 *   POST /outbound/:messageId/attachments   MailAttachInput → { draft } (a new version with the PDF attached)
 *   DELETE /outbound/:messageId/attachments/:sha256?expectedVersion=N → { draft } (a new version without it)
 *   GET  /outbound/:messageId/attachments/:sha256 → the PDF's bytes (a person only: what will be sent)
 *   POST /outbound/:messageId/send          { hash, awaitReply?, attachmentsShown? } → MailSendAnswer (a person only)
 *   POST /outbound/:messageId/resolve       { sent: boolean } → { draft }    (after an unknown send; a person only)
 *   POST /outbound/:messageId/discard       {} → { draft }                   (a person only)
 *
 * Record token (the member's AI): POST /outbound-recipients (read), POST /outbound
 * (act), GET /outbound/:messageId (read), PUT /outbound/:messageId (act), POST and DELETE
 * /outbound/:messageId/attachments… (act: the AI attaches the PDF a company Skill wrote). There is
 * no send, resolve, discard, typed address or attachment download for the AI: no route exists.
 *
 * Attachments (plan §14-1 「承認した送信を中身の版に固定」, outbound-mail.md "Attachments"): a new mail
 * (not a reply, not Slack) may carry up to 3 PDFs, 10 MB together; each is part of the fixed
 * content (name, size, sha256), so attaching or removing one is a new version and a changed file
 * makes the send stop with CONTENT_CHANGED. A send of a version with files must name them in
 * `attachmentsShown` (the sha256 of each file the person was shown): an app that cannot show
 * files cannot send them unseen (ATTACHMENTS_NOT_SHOWN). Codes: ATTACHMENT_INVALID (400, `problems`),
 * ATTACHMENT_NOT_HERE (400: a reply or a Slack reply), ATTACHMENT_NOT_FOUND (404),
 * ATTACHMENT_GONE (410: the bytes were deleted 30 days after sending), ATTACHMENT_CHANGED (409: the
 * stored file no longer matches; nothing sent), ATTACHMENTS_NOT_SHOWN (409).
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
 *
 * Waiting for their answer (owner decision 2026-11-03, outbound-mail.md "Waiting for their
 * answer"): a new mail (not a reply, not Slack) may be sent with `awaitReply: { until }` (a day,
 * `YYYY-MM-DD`): after the send the server makes a 返事のお願い in 返事待ち until that day's morning.
 * The view's `awaitReply` offers it (absent: not offered). Codes: AWAIT_REPLY_NOT_OFFERED (400),
 * AWAIT_REPLY_DATE (400). An app that sends only `{ hash }` waits for nothing (as before).
 */
import type { RecipientSource, VerifiedRecipient } from '../core/mail'
import type { SourceKind } from '../core/source-slots'

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
  /**
   * 「返事を待つ」 at 確かめて送る — only for a new mail (absent for a reply, a Slack reply, or from an
   * older server). `expected`: the drafting AI marked it as expecting an answer (pre-ticked);
   * `defaultUntil`: the third business day from now (`YYYY-MM-DD`); `chosenUntil`: the day chosen
   * when it was sent (null: not waited for).
   */
  awaitReply?: { expected: boolean; defaultUntil: string; chosenUntil: string | null }
  /** The PDFs attached to this version, in order (empty: none; absent from an older server). */
  attachments?: MailAttachmentView[]
}

/** A PDF attached to a version (the fixed content names it; `bytesDeleted` after retention). */
export interface MailAttachmentView {
  name: string
  size: number
  sha256: string
  /** True once the bytes were deleted (30 days after sent / discarded); the name and size stay. */
  bytesDeleted: boolean
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
  /** The やること it is for (a consultation about a task): its まとまり is taken along; a waited answer links to it. */
  taskId?: string
  /** The drafting AI's mark: the mail asks something the other side should answer (pre-ticks 「返事を待つ」). */
  expectsReply?: boolean
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
  expectsReply?: boolean
}

/** 「確かめて送る」's body. */
export interface MailSendInput {
  hash: string
  /** 「返事を待つ」 ticked: the day to notice silence (`YYYY-MM-DD`, today … 180 days). A new mail only. */
  awaitReply?: { until: string }
  /** The sha256 of every file attached to the version shown (required, exactly, when it has files). */
  attachmentsShown?: string[]
  /**
   * 「それでも送る」: the person's reason (1–200 characters) after the card showed an earlier send on
   * the same source (409 `ALREADY_SENT_FOR_SOURCE`); kept in the ledger and the send row.
   */
  resendReason?: string
}

/**
 * An earlier send on the same source that the person may see (409 `ALREADY_SENT_FOR_SOURCE`, and
 * a new draft's answer): the other mail's record id (［開く］ opens its record card), who and when,
 * the source's kind and the sentence 「この会議のお礼メールは〇〇さんが MM/DD HH:MM に送りました」.
 */
export interface MailAlreadySent {
  messageId: string
  by: string
  byName: string | null
  at: string
  kind: SourceKind
  message: string
}

/** Attaching a PDF: POST /outbound/:messageId/attachments (JSON; the bytes as base64). */
export interface MailAttachInput {
  /** The version the change is made on (`OutboundMailView.version`). */
  expectedVersion: number
  /** The file name (a path's last segment is taken; it must end in `.pdf`). */
  name: string
  /** The file's bytes, base64 (standard alphabet); they must start with `%PDF-`. */
  contentBase64: string
}

export type MailSendAnswer =
  | { outcome: 'sent'; draft: OutboundMailView }
  /** Sent, but the answer was lost: 「届いたか分かりません。…を確かめてください」. Never re-sent. */
  | { outcome: 'unknown'; draft: OutboundMailView; message: string }
