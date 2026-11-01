/**
 * The core role チャットの連絡を受け取る・返す (`chat`, `.claude/rules/connector-roles.md`)
 * as the core services use it on demand: reading one thread of the member's
 * chat with their own permission (`receive`), and replying into it as them
 * (`reply`). Provider-neutral: Slack implements it today
 * (`services/slack-chat.ts`); the role resolver picks the provider per
 * company (`services/connector-role-providers.ts`).
 *
 * Reading stores nothing and logs no content (no text, no name): the caller
 * gets the thread now and keeps nothing of it.
 */

/** Where a thread is: the chat service's channel id and the thread's root message (opaque). */
export interface ChatThreadRef {
  channelId: string
  threadTs: string
}

export interface ChatMessage {
  /** The message's id in the channel (opaque). */
  ts: string
  /** The sender's id at the chat service (opaque). */
  authorId: string | null
  /** The sender's display name as the service gives it (may be null). */
  authorName: string | null
  /** The member themselves wrote it. */
  mine: boolean
  /** When it was written (ISO 8601), null when unknown. */
  at: string | null
  /** The text as written (NFC, `\n`), cut at the reader's limit. */
  text: string
  truncated: boolean
}

export interface ChatThread {
  ref: ChatThreadRef
  /** Oldest first, the newest ones at most (`more` when earlier ones were left out). */
  messages: ChatMessage[]
  more: boolean
}

/**
 * Why a read gave no answer: not-connected (the member has not allowed it),
 * turned-off (the member turned reading off), stopped (the company's switch,
 * the operator, no usable connector), choice-needed, not-found, unavailable.
 */
export type ChatReadFailure = 'not-connected' | 'turned-off' | 'stopped' | 'choice-needed' | 'not-found' | 'unavailable'
export type ChatRead<T> = { ok: true; value: T } | { ok: false; reason: ChatReadFailure }

export interface ChatReader {
  /** One thread the member can see, with their own permission. */
  thread(companyId: string, userId: string, ref: ChatThreadRef): Promise<ChatRead<ChatThread>>
}

/** A reply's outcome (never retried: `unknown` may have been posted). `ts`: the posted message's id. */
export type ChatSendResult =
  | { ok: true; ts: string | null }
  | { ok: false; kind: 'not-sent' | 'refused' | 'rate-limited' | 'server-error' | 'unknown'; reason: string; status?: number }

/** Whether the member can reply now, and as which account (the address their grant is for). */
export type ChatReplierAccount =
  | { ok: true; account: string }
  | { ok: false; reason: 'consent-needed' | 'turned-off' | 'unavailable' }

export interface ChatSender {
  replierAccount(companyId: string, userId: string): Promise<ChatReplierAccount>
  /** Posts `text` into the thread as the member, once; never retried. */
  reply(companyId: string, userId: string, ref: ChatThreadRef, text: string): Promise<ChatSendResult>
}
