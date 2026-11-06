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
  // Noticing one's own turn without Slack (owner decision 2026-11-03): asked of you, the business
  // morning's 「今日のあなたの番」, a due on the next business day.
  'asked',
  'morning_summary',
  'due_tomorrow',
  // Stage 3–4 lanes (plan 段階3・4a・4b 並行): each lane adds its kinds only right
  // below its own marker; the line under each block stays unchanged.
  // lane A ▼ (reserved: connection_broken)
  // ── lane A ▲
  // lane B ▼ (reserved: reply_arrived, intake_unsure, follow_up_ready)
  // The inbox (inbox.md): their reply came to a 返事のお願い; a message waits for its owner's 確認.
  'reply_arrived',
  'intake_unsure',
  // The member's own AI made them a task from a message that came in (owner FB #13): told although
  // their AI was the actor. An app released before it shows the server's text and lists no switch.
  'from_message',
  // The member's own AI completed a task their reply finished (owner FB #19): told although their AI
  // was the actor, with ［元に戻す］ (the undo of that entry). An app released before it shows the text.
  'replied_done',
  // Mail and the mailbox (owner decision 2026-11-05, inbox.md "Mail archived in the mailbox"): a mail
  // archived in Gmail closed its 来た連絡 here; a 来た連絡 closed here archived its mail in Gmail. Both
  // with ［元に戻す］. An app released before it shows the server's text, without the button.
  'mail_left_inbox',
  'mail_archived',
  // ── lane B ▲
  // lane C ▼ (reserved: role_unassigned)
  // ── lane C ▲
  // A meeting's minutes arrived (minutes.md "Meetings for their attendees"): once per meeting, to
  // each member on its list. An app released before it shows the server's text and lists no switch.
  'minutes_arrived',
  // An AI changed a record the member is the assignee of, automatically (a plugin operation applied
  // with `auto` fields, nobody approved it; owner decision 2026-11-06): what changed, the AI's reason
  // and ［元に戻す］. Told although their own AI was the actor. An app released before it shows the text.
  'ai_changed',
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
  delegate_stopped: '不在の人の代わりが受け持てないもの（部署の管理役へ）',
  asked: 'だれかから頼まれた（あなたが担当になった）',
  morning_summary: '営業日の朝の「今日のあなたの番」（件数だけ）',
  due_tomorrow: '担当していることの期限が次の営業日に来る（明日が期限）',
  // lane A ▼
  // ── lane A ▲
  // lane B ▼
  reply_arrived: '返事を待っていた連絡に、相手から返事が来た',
  intake_unsure: '来た連絡を誰が受け持つか決めきれず、確かめてほしい',
  from_message: '来た連絡から、AI があなたのやることを作った',
  replied_done: 'あなたが返事をしたので、AI がやることを完了にした',
  mail_left_inbox: 'Gmail でアーカイブしたメールを、ACB でも閉じた',
  mail_archived: 'ACB で済んだメールを、Gmail でもアーカイブした',
  // ── lane B ▲
  // lane C ▼
  // ── lane C ▲
  minutes_arrived: '出た会議の議事録が届いた',
  ai_changed: '担当している記録を AI が自動で変えた（元に戻せます）',
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
  asked: true,
  morning_summary: true,
  due_tomorrow: true,
  // lane A ▼
  // ── lane A ▲
  // lane B ▼
  reply_arrived: true,
  intake_unsure: true,
  from_message: true,
  replied_done: true,
  mail_left_inbox: true,
  mail_archived: true,
  // ── lane B ▲
  // lane C ▼
  // ── lane C ▲
  minutes_arrived: true,
  ai_changed: true,
  others: false,
}

/**
 * The kinds about no single record: `recordId`, `recordType` and `recordTitle`
 * are '' (the morning summary opens the task list).
 */
/**
 * Notices whose row offers ［元に戻す］: the undo of exactly the entry they tell of (the server refuses
 * when something changed since). `replied_done`: the member's own AI completed their task;
 * `mail_left_inbox` / `mail_archived`: the inbox closed a mail / archived it in the mailbox (its
 * assignee may undo those: `UNDO_BY_ASSIGNEE`).
 */
export const UNDOABLE_NOTIFICATION_KINDS: readonly NotificationKind[] = ['replied_done', 'mail_left_inbox', 'mail_archived']

export const RECORDLESS_NOTIFICATION_KINDS: readonly NotificationKind[] = ['morning_summary']

/** One notice as the member's app shows it. */
export interface NotificationItem {
  id: string
  kind: NotificationKind
  /** '' for a kind about no record (`RECORDLESS_NOTIFICATION_KINDS`). */
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
  /**
   * Present while the app may show this notice as a Mac notification (E-27):
   * unread and still fresh by the company's clock (the morning summary until
   * 15:00 of its day, a due-tomorrow before the due's day, being asked within
   * 12 hours). The server's words; the app shows each notice id once.
   */
  desktop?: { title: string; body: string }
  /**
   * `ai_changed` only: the plugin operation the AI ran, for ［元に戻す］ (the operation's undo through the
   * member's session; the server re-checks everything). `undone`: it was written back already.
   */
  aiChange?: { pluginId: string; operationId: string; undone: boolean }
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
