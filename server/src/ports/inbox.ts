/**
 * The inbox (来た連絡, `.claude/rules/inbox.md`) behind the company handle:
 * every method is limited to the handle's company. Pointers and times only.
 *
 * Also the seam the core connectors fill (`InboxSource`): a connector that
 * serves the `mail` role's `read` lists a member's new messages for the
 * server clock's poll (A1 Gmail); one that is told by events (A3 Slack)
 * calls the inbox's `receive` itself.
 */
/** The inbox's channels (shared/types/inbox.ts `InboxChannel`; ports import no API contract). */
export type InboxChannel = 'email' | 'chat'

export interface InboxMessageRow {
  channel: InboxChannel
  messageId: string
  interactionId: string
  direction: 'in' | 'out'
  occurredAt: string
  seenAt: string
  /** The connector's opaque pointer to the message (null for rows made before B4). */
  sourceRef: string | null
  /**
   * Whose mailbox the pointer is in (the member whose poll or events reported it; null for rows
   * made before 2026-11-05): a mail pointer is read, archived and put back only with that member's
   * own permission (inbox.md "Mail archived in the mailbox").
   */
  reporterId?: string | null
}

export interface InboxConnectionRow {
  userId: string
  channel: InboxChannel
  connectedAt: string
  checkedUntil: string
  /** Where the source's change log was last read (`InboxSource.leftSince`; null: not yet). */
  leftCursor?: string | null
}

export interface InboxGapRow {
  userId: string
  channel: InboxChannel
  from: string
  to: string
  notedAt: string
}

export interface InboxRepository {
  settings(): { settings: string; updatedAt: string; updatedBy: string | null } | null
  saveSettings(settings: string, at: string, by: string): void

  message(channel: InboxChannel, messageId: string): InboxMessageRow | null
  /** The interactions any of these messages belong to (a thread's earlier messages), oldest message first. */
  interactionsOf(channel: InboxChannel, messageIds: string[]): string[]
  messagesOf(interactionId: string): InboxMessageRow[]
  /** The newest incoming message whose id starts with `prefix` (a chat DM's `<channel>:`), at or after `since` and before `before`. */
  latestIncoming(channel: InboxChannel, prefix: string, since: string, before: string): InboxMessageRow | null
  /** false when the message was already there (another reporter got there first). */
  insertMessage(row: InboxMessageRow): boolean

  connection(userId: string, channel: InboxChannel): InboxConnectionRow | null
  connections(userId: string): InboxConnectionRow[]
  /** Every connected member of a channel (the server clock's poll). */
  connected(channel: InboxChannel): InboxConnectionRow[]
  /** Adds the connection or replaces its times. */
  putConnection(row: InboxConnectionRow): void
  setCheckedUntil(userId: string, channel: InboxChannel, at: string): void
  setLeftCursor(userId: string, channel: InboxChannel, cursor: string | null): void
  /** The pointers ACB took out of the mailbox inbox with one `archived_there` entry (its version): what its undo puts back. */
  putArchived(interactionId: string, entryVersion: number, sourceRefs: string[]): void
  archived(interactionId: string, entryVersion: number): string[] | null
  addGap(row: InboxGapRow): void
  gaps(userId: string): InboxGapRow[]
}

/** A core connector's way to list a member's new messages (the `mail` role's `read`). */
export interface InboxSource {
  /**
   * Messages of the member that came at or after `since` (oldest first, each
   * shaped as `IncomingMessage` in shared/types/inbox.ts — the inbox checks
   * every one and skips what is not), or
   * `not-connected` when the member has no grant now (their connection is
   * kept: when they reconnect, the window starts where it stopped).
   * `{ messages, readFrom }` when the source stopped at its limit: only what
   * came at or after `readFrom` was listed (the span before is an unchecked gap).
   */
  listSince(companyId: string, userId: string, since: string): Promise<unknown[] | { messages: unknown[]; readFrom: string } | 'not-connected'>
  /**
   * Whether a read of the member works now (for Gmail: granted, their 受信を読む
   * and the company's switches on): the poll connects such a member before
   * reading (a first connection starts then).
   */
  ready?(companyId: string, userId: string): Promise<boolean>
  /** The mailbox as members call it (「Gmail」): the inbox's notes say 「Gmail ではアーカイブ済み」. */
  label?: string
  /**
   * Conversations (`threadRef`s) that may have left the member's inbox since `cursor` — archived,
   * trashed or deleted there — and the cursor to start from next time. `threadRefs: null` when there
   * was no cursor or it is too old: the caller then asks `inInbox` for the records it watches.
   * Read with the member's own read permission; `not-connected` keeps the cursor.
   */
  leftSince?(companyId: string, userId: string, cursor: string | null): Promise<{ cursor: string; threadRefs: string[] | null } | 'not-connected'>
  /** Whether each conversation still has a message in the member's inbox (false: archived, trashed, gone; left out: unknown). */
  inInbox?(companyId: string, userId: string, threadRefs: string[]): Promise<Record<string, boolean> | 'not-connected'>
  /**
   * These messages (`sourceRef`s ACB took in from the member's own mailbox) taken out of their inbox,
   * or put back (`back`), with their own permission to do so (owner decision 2026-11-05) — never the
   * whole conversation, so a message ACB has not read yet stays where it is. Taking out changes only
   * a message in the inbox now (one the member archived themselves, or never in it, is left alone).
   * `changed`: the pointers actually changed, in the order given — also when it stopped partway;
   * `stop`: why it stopped before the end (`not-allowed`: no permission, or a switch turned off —
   * nothing more is sent; `failed`: Google refused or did not answer), null when it went through.
   */
  archive?(companyId: string, userId: string, sourceRefs: string[], back: boolean): Promise<{ changed: string[]; stop: 'not-allowed' | 'failed' | null }>
}
