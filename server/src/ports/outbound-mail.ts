/**
 * Outbound mail's own rows (milestone 4 G8, `.claude/rules/outbound-mail.md`),
 * behind the company handle (`outbound`): every method is limited to the
 * handle's company. The content itself (canonical text + hash per version) is
 * in `fixed_payloads` (owner kind `outbound_message`); the state lives in the
 * company map (record type `outbound_message`).
 */
import type { RecipientSource } from '../../shared/core/mail'

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
  minutesId: string | null
  dealId: string | null
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
  actorKind: 'human' | 'ai'
  createdAt: string
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
