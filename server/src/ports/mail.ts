/**
 * The core role メールを読む・送る (`mail`, `.claude/rules/connector-roles.md`):
 * reading a member's received mail (`read`) and sending a mail the member
 * confirmed (`send`), always with that member's own permission at the
 * provider. Provider-neutral: Google implements it today
 * (`services/google-mail.ts`); the role resolver picks the provider per company
 * (`services/connector-role-providers.ts`).
 *
 * Reading stores nothing and logs no content (no subject, address or body):
 * the caller gets the message now and keeps only what its own rules allow.
 */

export interface MailAddress {
  /** Lower case. */
  email: string
  /** The display name as written (may be empty). */
  name: string
}

/** One received message's header facts (no body). */
export interface MailSummary {
  /** The provider's message id (opaque). */
  id: string
  /** The provider's conversation id (opaque). */
  threadId: string
  from: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  /** When the provider received it (ISO 8601), null when unknown. */
  receivedAt: string | null
  /** The `Message-ID` header (`<…>`), null when absent. */
  messageIdHeader: string | null
  /** The `In-Reply-To` header, null when absent. */
  inReplyTo: string | null
  /** A mailing list / newsletter (List-Id, List-Unsubscribe, Precedence bulk/list, or the provider's promotions / social category). */
  bulk: boolean
  /** Sent by a machine (Auto-Submitted other than `no`, an auto-reply). */
  automated: boolean
}

/** A message with its text (on demand). */
export interface MailMessage extends MailSummary {
  /** Plain text (from text/plain, else HTML with the tags removed), NFC, `\n`. */
  text: string
  /** True when the text was cut at the reader's limit. */
  truncated: boolean
}

/**
 * Why a read gave no answer: not-connected (the member has not allowed it),
 * turned-off (the member turned 受信を読む off), stopped (the company's switch,
 * the operator, no usable connector), choice-needed (two connectors and the
 * admin has not chosen), not-found, unavailable (the provider did not answer).
 */
export type MailReadFailure = 'not-connected' | 'turned-off' | 'stopped' | 'choice-needed' | 'not-found' | 'unavailable'

export type MailRead<T> = { ok: true; value: T } | { ok: false; reason: MailReadFailure }

export interface MailListQuery {
  /** Only messages received at or after this time (ms since the epoch). */
  afterMs: number
  /** The previous page's `nextPageToken`. */
  pageToken?: string
  /** At most this many per page (1–50; default 25). */
  max?: number
}

/**
 * A conversation in the member's own mailbox, read on demand (the card's 元のスレッド,
 * `.claude/rules/outbound-mail.md` "Replies"): its messages oldest first, the newest
 * ones at most (`more` when earlier ones were left out). Nothing is kept.
 */
export interface MailThread {
  /** The provider's conversation id (opaque). */
  id: string
  messages: MailMessage[]
  more: boolean
}

export interface MailReader {
  /** The member's own received messages (inbox, newest first), header facts only. */
  listMessages(companyId: string, userId: string, query: MailListQuery): Promise<MailRead<{ messages: MailSummary[]; nextPageToken: string | null }>>
  /** One of the member's own messages with its text. */
  getMessage(companyId: string, userId: string, messageId: string): Promise<MailRead<MailMessage>>
  /** One conversation of the member's own mailbox with each message's text. */
  getThread(companyId: string, userId: string, threadId: string): Promise<MailRead<MailThread>>
}

/** A send's outcome (never retried by the provider: `unknown` may have been sent). */
export type MailSendResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown'; reason: string; status?: number; googleReason?: string }

/** Whether the member can send now, and from which account. */
export type MailSenderAccount =
  | { ok: true; account: string }
  /** consent-needed: the member has not allowed sending; turned-off: they turned it off; unavailable: no usable connector. */
  | { ok: false; reason: 'consent-needed' | 'turned-off' | 'unavailable' }

export interface MailSender {
  /** The account a send would go out from (the member's own permission), or why not. */
  senderAccount(companyId: string, userId: string): Promise<MailSenderAccount>
  /**
   * Sends an RFC 5322 message (base64url) once; never retried. `threadId`: a reply
   * into the member's own conversation (its headers carry In-Reply-To / References).
   */
  send(companyId: string, userId: string, raw: string, options?: { threadId?: string }): Promise<MailSendResult>
}
