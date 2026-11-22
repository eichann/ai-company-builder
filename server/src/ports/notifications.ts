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
  /** '' for a notice about no record (the morning summary). */
  recordId: string
  recordVersion: number
  /**
   * The ledger action it came from ('' for a computed notice: overdue, AI turn stuck, morning summary, due tomorrow). A
   * recordless notice brought back once (`remindOnce`: a stopped chain's reminder) carries that reminder's mark here.
   */
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
  /**
   * Bring the member's notice with this dedupe key back once (jobs.md "A stopped chain", its reminder): unread again,
   * dated `at` (so it is on top) and marked `mark` (its `action`) — only while its `action` is still '' (compare-and-set:
   * once, however many clocks, restarts or servers ask). Whether it was brought back now.
   */
  remindOnce(userId: string, dedupeKey: string, mark: string, at: string): boolean
  /** The members of this company who already have a notice with this dedupe key. */
  usersWithKey(dedupeKey: string): string[]
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
