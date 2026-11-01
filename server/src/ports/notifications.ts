/**
 * The notices (知らせ, stage 2 S5, `.claude/rules/notifications.md`), behind
 * the company handle (`notifications`): every method is limited to the
 * handle's company, and every read or write names the member (`userId`), so a
 * call for one member never reaches another's rows. A notice holds no text:
 * kind, record, version, actor — the text is built when it is read.
 */

export interface NotificationRow {
  id: string
  userId: string
  kind: string
  recordId: string
  recordVersion: number
  /** The ledger action it came from ('' for a notice computed when read: overdue, AI turn stuck). */
  action: string
  actorId: string | null
  actorKind: 'human' | 'ai' | 'external' | null
  /** Computed notices: one per key and member (e.g. `overdue:<record>:<due>`); null otherwise. */
  dedupeKey: string | null
  createdAt: string
  readAt: string | null
  /**
   * The absent member this notice is for (records.md "Absence and the delegate"):
   * set on a delegate's copy of the absentee's notice, and on a stop told to a
   * department manager. Absent / null otherwise.
   */
  forUserId?: string | null
}

export interface NotificationRepository {
  /** Insert these notices; a row whose dedupe key the member already has is skipped. The ids written. */
  insert(rows: NotificationRow[]): string[]
  /** The member's newest notices (newest first), at most `limit`. */
  list(userId: string, limit: number): NotificationRow[]
  /** Mark the member's notices read (`ids` null = all of them); the number changed. */
  markRead(userId: string, ids: string[] | null, at: string): number
  /** Forget the member's notices made before `before`. */
  prune(userId: string, before: string): void
  /** The member's kind switches (JSON object kind → boolean), or null when never set. */
  settings(userId: string): string | null
  setSettings(userId: string, kinds: string, at: string): void
}
