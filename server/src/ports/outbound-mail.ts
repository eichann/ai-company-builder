/**
 * Outbound mail's own rows (milestone 4 G8, `.claude/rules/outbound-mail.md`),
 * behind the company handle (`outbound`): every method is limited to the
 * handle's company. The content itself (canonical text + hash per version) is
 * in `fixed_payloads` (owner kind `outbound_message`); the state lives in the
 * company map (record type `outbound_message`).
 */
import type { MailAttachment, RecipientSource } from '../../shared/core/mail'

export interface OutboundRecipientRow {
  ref: string
  email: string
  name: string | null
  source: RecipientSource
}

/** One draft (= one outbound_message record). */
export interface OutboundMailRow {
  messageId: string
  authorId: string
  /** The member's Google account / ACB email at drafting. */
  fromEmail: string
  /** The meeting the mail is about (column `minutes_id`, named before the type was renamed). */
  meetingId: string | null
  /** The まとまり (a record implementing `bundle`) it is about (column `deal_id`). */
  bundleId: string | null
  createdAt: string
  /** When it became sent / discarded (the retention clock); null while draft / unknown. */
  finishedAt: string | null
  /** When the body was deleted (retention). */
  bodyDeletedAt: string | null
}

/** The recipients of one content version (the canonical text holds the rest). */
export interface OutboundVersionRow {
  messageId: string
  version: number
  to: OutboundRecipientRow[]
  cc: OutboundRecipientRow[]
  /** The PDFs of this version, in order (none for versions made before attachments). */
  attachments?: MailAttachment[]
  actorKind: 'human' | 'ai'
  createdAt: string
}

/** A stored attachment of a draft (one per distinct file); `bytes` null once deleted. */
export interface OutboundAttachmentRow {
  messageId: string
  sha256: string
  name: string
  size: number
  bytes: Uint8Array | null
  addedBy: string
  addedAt: string
  bytesDeletedAt: string | null
}

export type OutboundSendOutcome = 'sending' | 'sent' | 'unknown' | 'not-sent' | 'refused'

/** One send attempt: written BEFORE Gmail is called (the operation record). */
export interface OutboundSendRow {
  id: string
  messageId: string
  version: number
  hash: string
  by: string
  startedAt: string
  outcome: OutboundSendOutcome
  /** A fixed word (Google's short reason code or ours); never content. */
  reason: string | null
  providerMessageId: string | null
  finishedAt: string | null
}

export interface OutboundMailRepository {
  insertMail(row: OutboundMailRow): void
  mail(messageId: string): OutboundMailRow | null
  setFinished(messageId: string, at: string | null): void
  /** Drafts finished before `before` whose body is not yet deleted. */
  finishedBefore(before: string, limit: number): OutboundMailRow[]
  markBodyDeleted(messageId: string, at: string): void

  insertVersion(row: OutboundVersionRow): void
  version(messageId: string, version: number): OutboundVersionRow | null

  /** Keeps a file's bytes for a draft (once per sha256; a row whose bytes were deleted gets them again). */
  putAttachment(row: { messageId: string; sha256: string; name: string; size: number; bytes: Uint8Array; addedBy: string; addedAt: string }): void
  /** A stored file of a draft (with its bytes, null once deleted), or null. */
  attachment(messageId: string, sha256: string): OutboundAttachmentRow | null
  /** The sha256 of a draft's files whose bytes were deleted. */
  deletedAttachmentBytes(messageId: string): string[]
  /** Deletes the bytes of a draft's files, except those named in `keep`; the rows stay. Returns how many. */
  deleteAttachmentBytes(messageId: string, at: string, keep?: readonly string[]): number

  /** Addresses a person typed for this draft (「あなたが入力」). */
  typedRecipients(messageId: string): OutboundRecipientRow[]
  addTypedRecipient(messageId: string, row: OutboundRecipientRow, by: string, at: string): void

  /**
   * Starts a send: inserts the row as `sending` unless another send of the
   * same draft is `sending` or `unknown` (then false, nothing written).
   */
  startSend(row: OutboundSendRow): boolean
  finishSend(id: string, outcome: Exclude<OutboundSendOutcome, 'sending'>, reason: string | null, providerMessageId: string | null, at: string): void
  /** The latest send of a draft. */
  lastSend(messageId: string): OutboundSendRow | null
  /** Settles an `unknown` send (the person said whether it was sent). */
  resolveSend(id: string, outcome: 'sent' | 'not-sent', at: string): void
  /** Lower-case domains of every recipient of a send that went out (sent). */
  sentDomains(): string[]
}
