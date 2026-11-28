/**
 * API contract of the inbox (来た連絡, stage 3 B2, `.claude/rules/inbox.md`):
 * what a core connector hands the inbox for one message (`IncomingMessage` —
 * pointers and minimal metadata, never a body), and what the member routes
 * and the AI's routes answer.
 */
import type { IntakeSettings } from '../core/intake-settings'

/** The inbox's channels: mail (the `mail` role) and chat (the `chat` role: Slack DMs and mentions). */
export type InboxChannel = 'email' | 'chat'
export const INBOX_CHANNELS: readonly InboxChannel[] = ['email', 'chat']
/** A message's title while it has no subject (a chat message, a mail without one), until the owner's AI names it. */
export const INBOX_NO_SUBJECT = '（件名なし）'
/** The longest title the owner's AI gives a message without a subject. */
export const INBOX_AI_TITLE_MAX = 60

/** A person or address on a message. A connector that knows the member (Slack) says so. */
export interface IncomingParty {
  /** The address as written (mail), or the chat service's user id. */
  address: string
  /** The ACB member, when the connector knows it (otherwise mail is matched by the members' addresses). */
  memberId?: string | null
  /** The display name as written (kept only as `counterpart_text`, short). */
  name?: string | null
}

/**
 * One message a core connector noticed (Gmail polled by the server clock,
 * Slack by its events). No body, no attachment: what the AI needs it reads
 * through the role from the member's PC, by `sourceRef` / `threadRef`.
 */
export interface IncomingMessage {
  channel: InboxChannel
  /** Unique per channel in the company: RFC Message-ID for mail; `<channel>:<ts>` for chat. */
  messageId: string
  /** Message ids this one answers (In-Reply-To / References; a chat thread's root). */
  references?: string[]
  /** The connector's pointer to the thread in the reporting member's account (opaque). */
  threadRef?: string | null
  /** The connector's pointer to the message (opaque, e.g. `gmail:<id>`). */
  sourceRef: string
  /** When it was sent (ISO). */
  occurredAt: string
  /** Subject (mail) or a short title the connector made (chat); ≤ 200 kept. */
  subject?: string | null
  from: IncomingParty
  /**
   * Mail: the Sender header's address when it differs from From (an invitation sent "via Google
   * Calendar" comes From its organizer). Only matched against a connected service's senders
   * (shared/core/notification-senders.ts); never kept.
   */
  senderAddress?: string | null
  to: IncomingParty[]
  cc?: IncomingParty[]
  /** The reporting member sent it (their Sent folder / their own chat message). */
  outgoing?: boolean
  /** Newsletter or mass mailing (List-Unsubscribe, Precedence: bulk). */
  bulk?: boolean
  /** Automatic (Auto-Submitted, an out-of-office reply, a no-reply sender). */
  automated?: boolean
  /** Spam or phishing by the service's own mark: never taken in. */
  spam?: boolean
}

/** What happened to one message (the connector logs counts only). */
export type IntakeOutcome =
  | 'created'      // a new interaction
  | 'continued'    // joined the thread's interaction
  | 'duplicate'    // already seen
  | 'skipped'      // spam, internal, CC only, not addressed: nothing written

/** `GET /api/companies/:id/inbox/status`: the member's own connections. */
export interface InboxStatus {
  connections: Array<{
    channel: InboxChannel
    connectedAt: string
    /** Messages before this were looked at. */
    checkedUntil: string
  }>
  /** Spans nobody checked (a connection broken for more than 7 days): shown, never hidden. */
  gaps: Array<{ channel: InboxChannel; from: string; to: string }>
}

/** One row of 「やることにしなかった一覧」 (the member's own, newest first). */
export interface SetAsideItem {
  recordId: string
  title: string
  channel: string | null
  from: string | null
  occurredAt: string | null
  /** Why it was left out: `bulk`, `automated`, or the AI's / the member's note. */
  reason: string | null
  /** Who left it out: the intake (`acb:inbox`), the AI, the member. */
  by: 'intake' | 'ai' | 'human'
}

export interface SetAsideList {
  items: SetAsideItem[]
}

/** `GET|PUT /api/companies/:id/inbox-settings`. */
export interface InboxSettingsView {
  settings: IntakeSettings
  canEdit: boolean
  updatedAt: string | null
  updatedBy: string | null
}

/** `POST /api/companies/:id/inbox/backfill` 「過去7日を見直す」. */
export interface InboxBackfillRequest {
  channel: InboxChannel
}

/**
 * The AI's judgement of an interaction in its turn
 * (`POST /api/records-ai/inbox/items/:recordId/judgement`, an act token).
 */
export interface InboxJudgementRequest {
  expectedVersion: number
  /**
   * reply: a 返事のお願い is made; no_reply: handled, nothing to do;
   * set_aside: やることにしなかった (refused when a person took it up);
   * unsure: 確認待ち, the assignee decides; task: a task the AI made with
   * `records_create` (owner-only, linking this message as `interaction`) is
   * the work it asks for (B4).
   */
  outcome: 'reply' | 'no_reply' | 'set_aside' | 'unsure' | 'task'
  /** One or two sentences: why (kept in the ledger's note). */
  reason: string
  /**
   * A short title for the message (≤ 60 kept on the message). It becomes the message's title only
   * when it has none (「（件名なし）」: chat, a mail without a subject) and is the owner's own
   * record — never over a subject. reply: also the 返事のお願い's title (default: the message's).
   */
  title?: string
  /** reply: 終わりの条件 (返事が来れば・日程が決まれば …). */
  endCondition?: string
  /** reply: a deadline written in the message (`YYYY-MM-DD[THH:MM]`); else the company's 目安. */
  deadline?: string
  /** reply: the sentence the deadline came from (≤ 200). */
  deadlineNote?: string
  /** task: the task made for it (it must link this interaction as `interaction`). */
  taskId?: string
}

export interface InboxJudgementResult {
  interactionId: string
  state: string
  /** The 返事のお願い made (reply). */
  replyRequestId: string | null
  /** The task it became (task). */
  taskId?: string | null
  /** reply: the member had already answered in the thread, so no 返事のお願い was made. */
  alreadyReplied?: true
}

/**
 * `GET /api/records-ai/inbox/items/:recordId` (an interaction, or a 返事のお願い and its interaction):
 * what the AI judges by — pointers, state, what was made for it; never a body (the thread itself is
 * A4's `GET /api/records-ai/threads/:recordId`, shared/types/threads.ts).
 */
export interface InboxItemView {
  recordId: string
  channel: string | null
  threadRef: string | null
  sourceRef: string | null
  messages: Array<{ messageId: string; direction: 'in' | 'out'; occurredAt: string }>
  /** The interaction's state and version now (the judgement's expectedVersion). */
  state: string | null
  version: number
  title: string
  /** The non-final 返事のお願い and the tasks already made for it, that the member reads (a run done twice reuses them). */
  replyRequests: Array<{ id: string; state: string | null }>
  tasks: Array<{ id: string; title: string }>
  /** The 相手 linked (名寄せ), when the member reads it. */
  counterpart: { id: string; title: string } | null
  /**
   * Asked by a 返事のお願い's id (B5): it, and why it is the AI's turn — `draft` (準備中: the reply's
   * draft), `follow_up` (準備中 after 返事の見込み passed: a nudge's draft), `check_reply` (確かめ中:
   * a reply came; its content decides), else `none`.
   */
  request?: {
    id: string
    state: string | null
    version: number
    purpose: 'draft' | 'follow_up' | 'check_reply' | 'none'
    waitUntil: string | null
    due: string | null
    endCondition: string | null
    triggerKind: string | null
  }
  /**
   * In 「返事のあとを確かめる」 (`replied`, interaction v7, owner FB #19): the member's own reply was seen
   * and these tasks made from the message are still open — the member's own, from this message. The
   * AI decides each (`POST …/reply-check`); `canComplete: false` = it waits for a check (確かめてから):
   * leave it open with a note.
   */
  replyCheck?: { tasks: Array<{ id: string; title: string; state: string | null; version: number; canComplete: boolean }> }
}

/**
 * The member's AI after their own reply (`POST /api/records-ai/inbox/items/:recordId/reply-check`,
 * an act token): for each task made from this message, `done` (the reply finished it: completed,
 * the member told, undone like any entry) or `open` (work remains: a note 「返事は済み」). Only tasks
 * the item view lists under `replyCheck`; anything else is refused before anything is written.
 */
export interface InboxReplyCheckRequest {
  expectedVersion: number
  tasks: Array<{ taskId: string; outcome: 'done' | 'open'; note?: string }>
}

export interface InboxReplyCheckResult {
  interactionId: string
  state: string
  tasks: Array<{ taskId: string; outcome: 'done' | 'open'; ok: boolean; version?: number }>
}

/**
 * 「連絡」1枚 (owner decision 2026-11-28, UX stage 2 「5番」): a 来た連絡 (`interaction`) and its 返事のお願い
 * (`reply_request`) stay two records; the app shows them as one card. Session routes under
 * `/api/companies/:companyId/inbox/items/:interactionId/…` (inbox.md "One contact"). Additive: an older
 * app keeps the two records' own actions.
 */

/** A 返事のお願い of the contact, as its reader sees it. */
export interface ContactReplyView {
  id: string
  title: string
  state: string | null
  version: number
  /** 担当 (a member id), null when none. */
  assignee: string | null
  due: string | null
  /** 返事の目安 (the app shows 「目安：」 when it equals `due`). */
  guidelineDue: string | null
  /** 返事待ち: 追いかけの日 (返事の見込み). */
  waitUntil: string | null
  /** Drafts of the reply still in 下書き that the member reads (the AI's prepared ones and the card's own). */
  drafts: Array<{ id: string; version: number }>
  /** Which of the finishing actions the member may press now (the engine's own answer: from + who). */
  may: { replied_elsewhere: boolean; close: boolean; drop: boolean }
}

/** `GET …/inbox/items/:recordId/contact` (an interaction, or a 返事のお願い of it): the card's whole contact. */
export interface ContactView {
  interaction: {
    id: string
    title: string
    state: string | null
    version: number
    assignee: string | null
    /** Whether the member may press 「済んだ」 (settle) on it now. */
    maySettle: boolean
  }
  /** Every 返事のお願い of it the member reads, open ones first, then newest. */
  replyRequests: ContactReplyView[]
  /** The やること made from it (`interaction` link) that the member reads. */
  tasks: Array<{ id: string; title: string; state: string | null; version: number; assignee: string | null }>
}

/** How the 返事のお願い ends: 「もう返した」, 「終わりにする」 (済んだ・もう待たない), 「返事をしない」 (note required). */
export type ContactReplyEnd = 'replied_elsewhere' | 'close' | 'drop'

/**
 * `POST …/inbox/items/:interactionId/finish`: the 返事のお願い's end and — when the contact is the member's to
 * close (確認待ち) — its 「済んだ」, written together or not at all. Each part carries the version the card read.
 */
export interface ContactFinishRequest {
  interaction: { expectedVersion: number }
  replyRequest: { id: string; expectedVersion: number; action: ContactReplyEnd; note?: string }
}

/**
 * What happened to one part: `done` (written now), `already` (this very change by this member was written by an
 * earlier press — the request seen twice), `unchanged` (nothing to do: the contact is not in 確認待ち).
 * `version` is the ledger entry to take back (`done` / `already`), else null.
 */
export interface ContactPartResult {
  recordId: string
  outcome: 'done' | 'already' | 'unchanged'
  state: string | null
  /** The record's version now. */
  recordVersion: number
  version: number | null
}

export interface ContactFinishResult {
  interaction: ContactPartResult
  replyRequest: ContactPartResult
}

/**
 * `POST …/inbox/items/:interactionId/finish/undo`: take back what one finish wrote, both or neither. `version` is
 * each part's entry (`ContactPartResult.version`), `expectedVersion` the record's version the card read. Leave out
 * `interaction` when its part was `unchanged`.
 */
export interface ContactUndoRequest {
  interaction?: { version: number; expectedVersion: number }
  replyRequest: { id: string; version: number; expectedVersion: number }
}

export interface ContactUndoResult {
  interaction: ContactPartResult | null
  replyRequest: ContactPartResult
}
