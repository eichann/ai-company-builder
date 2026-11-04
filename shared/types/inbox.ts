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
}
