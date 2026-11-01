/**
 * API contract of the notices (知らせ, stage 2 S5, `.claude/rules/notifications.md`):
 * what happened that concerns the member — the core app draws them under the
 * title bar's bell (plugins never draw a notice). Kept on the server per
 * company × member with their read state, so two PCs agree. A notice holds
 * only what happened (kind, record, version, actor); its text is built when it
 * is read, and only for a record the member can read now.
 */

/**
 * The kinds of notice. A member turns each on or off; `NOTIFICATION_DEFAULTS`
 * is the owner's first setting (E-25: completion of what you asked, approval
 * results and a due pushed back are on; others' affairs are off). What you asked
 * coming back to you (受けられない, task v5) counts as its result: on. What you
 * asked being accepted (引き受ける, task v7) and still waiting for acceptance
 * after a business day (the server clock) are on too (owner decision 2026-11-01).
 */
export const NOTIFICATION_KINDS = [
  'request_done',
  'request_accepted',
  'ok_completed',
  'request_returned',
  'approval_result',
  'due_changed',
  'overdue',
  'ai_turn_stuck',
  'wait_over',
  'acceptance_waiting',
  'delegate_stopped',
  // Stage 3–4 lanes (plan 段階3・4a・4b 並行): each lane adds its kinds only right
  // below its own marker; the line under each block stays unchanged.
  // lane A ▼ (reserved: connection_broken)
  // ── lane A ▲
  // lane B ▼ (reserved: reply_arrived, intake_unsure, follow_up_ready)
  // The inbox (inbox.md): their reply came to a 返事のお願い; a message waits for its owner's 確認.
  'reply_arrived',
  'intake_unsure',
  // ── lane B ▲
  // lane C ▼ (reserved: role_unassigned)
  // ── lane C ▲
  'others',
] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  (NOTIFICATION_KINDS as readonly unknown[]).includes(value)

/** What each kind is called in the member's settings. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  request_done: '頼んだことが終わった・中止になった',
  request_accepted: '頼んだことを引き受けてもらえた',
  ok_completed: 'あなたの OK で完了になった',
  request_returned: '頼んだことが受けられないと戻ってきた',
  approval_result: '承認のお願いの結果（承認・差し戻しなど）',
  due_changed: '頼んだことの期限が変わった',
  overdue: '頼んだことが期限を過ぎた',
  ai_turn_stuck: '頼んだことの AI の番が 24 時間進んでいない',
  wait_over: '待っている返事・届くものの見込みの日時が過ぎた（追いかけの番）',
  acceptance_waiting: '頼んだことが 1 営業日たっても引き受けられていない',
  delegate_stopped: '不在の人の代わりが受け持てないもの（部署の責任者へ）',
  // lane A ▼
  // ── lane A ▲
  // lane B ▼
  reply_arrived: '返事を待っていた連絡に、相手から返事が来た',
  intake_unsure: '来た連絡を誰が受け持つか決めきれず、確かめてほしい',
  // ── lane B ▲
  // lane C ▼
  // ── lane C ▲
  others: 'そのほかの動き（担当になった・差し戻された・中止されたなど）',
}

/** The owner's first setting (E-25). */
export const NOTIFICATION_DEFAULTS: Record<NotificationKind, boolean> = {
  request_done: true,
  request_accepted: true,
  ok_completed: true,
  request_returned: true,
  approval_result: true,
  due_changed: true,
  overdue: true,
  ai_turn_stuck: true,
  wait_over: true,
  acceptance_waiting: true,
  delegate_stopped: true,
  // lane A ▼
  // ── lane A ▲
  // lane B ▼
  reply_arrived: true,
  intake_unsure: true,
  // ── lane B ▲
  // lane C ▼
  // ── lane C ▲
  others: false,
}

/** One notice as the member's app shows it. */
export interface NotificationItem {
  id: string
  kind: NotificationKind
  recordId: string
  recordType: string
  /** The record's title now. */
  recordTitle: string
  /** The record's version the notice is about. */
  version: number
  /** Japanese, built when read. */
  text: string
  /**
   * The absent member it concerns (代わりの人): on a delegate's copy of the
   * absentee's notice, and on a stop told to a department manager.
   */
  forUserId?: string
  createdAt: string
  read: boolean
}

/** `GET /api/companies/:id/me/notifications`. */
export interface NotificationList {
  /** false while the company's records are off: no bell. */
  available: boolean
  /** Unread notices the member may see now (kinds turned on, records they can read). */
  unread: number
  /** Newest first, at most `NOTIFICATION_LIST_MAX`. */
  items: NotificationItem[]
}

export const NOTIFICATION_LIST_MAX = 50

/** `POST …/me/notifications/read`: these notices, or every one of the member's. */
export type NotificationReadRequest = { ids: string[] } | { all: true }

/** `GET|PUT …/me/notifications/settings`. */
export interface NotificationSettings {
  kinds: Record<NotificationKind, boolean>
}
