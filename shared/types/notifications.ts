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
 * coming back to you (受けられない, task v5) counts as its result: on.
 */
export const NOTIFICATION_KINDS = [
  'request_done',
  'ok_completed',
  'request_returned',
  'approval_result',
  'due_changed',
  'overdue',
  'ai_turn_stuck',
  'others',
] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  (NOTIFICATION_KINDS as readonly unknown[]).includes(value)

/** What each kind is called in the member's settings. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  request_done: '頼んだことが終わった・中止になった',
  ok_completed: 'あなたの OK で完了になった',
  request_returned: '頼んだことが受けられないと戻ってきた',
  approval_result: '承認のお願いの結果（承認・差し戻しなど）',
  due_changed: '頼んだことの期限が変わった',
  overdue: '頼んだことが期限を過ぎた',
  ai_turn_stuck: '頼んだことの AI の番が 24 時間進んでいない',
  others: 'そのほかの動き（担当になった・差し戻された・中止されたなど）',
}

/** The owner's first setting (E-25). */
export const NOTIFICATION_DEFAULTS: Record<NotificationKind, boolean> = {
  request_done: true,
  ok_completed: true,
  request_returned: true,
  approval_result: true,
  due_changed: true,
  overdue: true,
  ai_turn_stuck: true,
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
