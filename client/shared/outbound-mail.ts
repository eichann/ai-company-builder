import { CONTENT_HASH_RE } from '../../shared/core/fixed-content'
import { ATTACHMENT_LIMITS, RECIPIENT_SOURCE_LABELS, RECIPIENT_SOURCES, RESEND_REASON_MAX, resendReasonOf, sanitizeAttachmentName, SHA256_HEX_RE, type RecipientSource } from '../../shared/core/mail'
import { SOURCE_KINDS }
 from '../../shared/core/source-slots'
import type { MailAlreadySent, MailAttachmentView, MailRecipientsView, MailRecipientView, OutboundMailState, OutboundMailView } from '../../shared/types/outbound-mail'

/**
 * The chat's mail card (milestone 4 G8, `.claude/rules/outbound-mail.md`): when
 * the member's AI drafts a mail (`mail_draft_create` / `mail_draft_update`),
 * main adds the draft to the reply as a data part; it is stored with the
 * message (`mailDrafts`). The card is drawn by the app — the AI's text appears
 * only inside the draft's fields — and its buttons are the person's own,
 * through IPC with the member's session: edit (a new version), 「確かめて送る」
 * (sends the hash of the version shown), 送られていた／送られていなかった, 捨てる.
 * No jargon on the card (no ハッシュ / OAuth).
 */
export const MAIL_DRAFT_PART_TYPE = 'data-mail-draft'

export interface MailDraftCard {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  /** The draft as the server answered (its version and hash: the send carries this hash). */
  draft: OutboundMailView
  /** The AI drafted it (the credential decided). */
  byAi: boolean
  at: string
}

export const MAIL_WORDS = {
  slackDraft: 'Slack の返事の下書き',
  slackWhere: '元の Slack のスレッドに、あなたとして返します。',
  slackSent: 'Slack に返事を送りました。',
  sendButton: '確かめて送る',
  confirmTitle: '送る前に、もう一度確かめてください',
  confirmNote: '中身が変わっていないことを確かめて送ります。送ったメールは取り消せません。',
  confirmSend: 'この内容で送る',
  firstTime: 'この宛先に送るのは初めてです',
  links: (n: number) => `本文にリンクが ${n} つあります`,
  unknown: '届いたか分かりません。Gmail の送信済みを確かめてください。',
  wasSent: '送られていた',
  wasNotSent: '送られていなかった',
  discard: '捨てる',
  edit: '直す',
  save: '保存する',
  consent: 'メールを送る許可',
  consentNote: 'メールを送るには、Google で「メールを送る許可」が要ります。',
  bodyDeleted: '本文は送ってから30日たったため、サーバーから消しました（Gmail の送信済みには残っています）。',
  byAi: 'AI が下書き',
  awaitReply: (day: string) => `返事を待つ（来なければ ${day}の朝に知らせる）`,
  awaitReplyDay: '知らせる日',
  awaitReplyNote: '相手から返事が来たら AI が中身を確かめます。来なければ、その日に AI が催促の下書きを用意します（送るのはあなたです）。',
  awaitReplyPickDay: '知らせる日を選んでください。',
  waitingReply: (day: string) => `相手の返事を待っています（来なければ ${day}の朝に知らせます）。`,
  attachments: '付いているファイル',
  openAttachment: '開いて確かめる',
  removeAttachment: '外す',
  attachmentGone: '送ってから30日たったため、サーバーから消しました',
  attachmentsConfirm: '付いているファイルも、このまま送ります。中身は「開いて確かめる」で見られます。',
  attachmentOpened: 'ファイルを開きました。',
  alreadySentOpen: '開く',
  alreadySentAsk: '送る前に、先に送られたメールを確かめてください。それでも送るときは、理由をひとこと書いてください（経緯に残ります）。',
  resendReason: 'それでも送る理由',
  resendReasonPlaceholder: '例：先方から別の担当者にも送ってほしいと言われたため',
  resendButton: 'それでも送る',
  dontSend: '送らない',
} as const

/** `1234567` → 「1.2 MB」 (the card's size of a file). */
export function fileSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} バイト`
}

export const MAIL_STATE_LABELS: Record<OutboundMailState, string> = {
  draft: '下書き',
  sent: '送りました',
  unknown: '届いたか分かりません',
  discarded: '捨てました',
}

export const sourceLabel = (s: RecipientSource) => RECIPIENT_SOURCE_LABELS[s]

/** How a recipient is shown: 「鈴木 一郎 <suzuki@…>（カレンダーの参加者）」. */
export function recipientLine(r: Pick<MailRecipientView, 'email' | 'name' | 'source'>): string {
  return `${r.name ? `${r.name} <${r.email}>` : r.email}（${sourceLabel(r.source)}）`
}

const STATES = new Set<OutboundMailState>(['draft', 'sent', 'unknown', 'discarded'])
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const nul = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)

function readRecipient(x: unknown): MailRecipientView | undefined {
  if (!x || typeof x !== 'object') return undefined
  const r = x as Record<string, unknown>
  if (!str(r.ref, 40) || !str(r.email, 254) || !(RECIPIENT_SOURCES as readonly string[]).includes(r.source as string)) return undefined
  return { ref: r.ref, email: r.email, name: nul(r.name, 100), source: r.source as RecipientSource, firstTime: r.firstTime === true }
}

/** A draft view from the server or storage, validated (undefined when malformed). */
export function readMailDraft(data: unknown): OutboundMailView | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 80) || !STATES.has(d.state as OutboundMailState) || typeof d.version !== 'number' || !str(d.hash, 80) || !CONTENT_HASH_RE.test(d.hash)) return undefined
  if (!str(d.from, 254) || typeof d.subject !== 'string' || d.subject.length > 1000 || !Array.isArray(d.to) || !Array.isArray(d.cc) || d.to.length > 50 || d.cc.length > 50) return undefined
  const to = d.to.map(readRecipient)
  const cc = d.cc.map(readRecipient)
  if (to.some(r => !r) || cc.some(r => !r)) return undefined
  const body = typeof d.body === 'string' && d.body.length <= 50_000 ? d.body : null
  return {
    id: d.id, state: d.state as OutboundMailState, version: d.version, hash: d.hash,
    channel: d.channel === 'slack' ? 'slack' : 'email', interactionId: nul(d.interactionId, 80), from: d.from,
    to: to as MailRecipientView[], cc: cc as MailRecipientView[], subject: d.subject, body, bodyDeleted: body === null,
    linkCount: typeof d.linkCount === 'number' ? d.linkCount : 0,
    meetingId: nul(d.meetingId, 80), bundleId: nul(d.bundleId, 80), sentAt: nul(d.sentAt, 40), providerMessageId: nul(d.providerMessageId, 100),
    lastChangedBy: d.lastChangedBy === 'ai' ? 'ai' : 'human', updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt.slice(0, 40) : '',
    ...readAwaitReply(d.awaitReply),
    attachments: readAttachments(d.attachments),
  }
}

/** The files of a version as the server listed them (none: an older server, a stored card from before, or a malformed list). */
function readAttachments(v: unknown): MailAttachmentView[] {
  if (!Array.isArray(v) || v.length > ATTACHMENT_LIMITS.count) return []
  const out: MailAttachmentView[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') return []
    const a = x as Record<string, unknown>
    if (typeof a.name !== 'string' || sanitizeAttachmentName(a.name) !== a.name || typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0
      || typeof a.sha256 !== 'string' || !SHA256_HEX_RE.test(a.sha256)) return []
    out.push({ name: a.name, size: a.size, sha256: a.sha256, bytesDeleted: a.bytesDeleted === true })
  }
  return out
}

/** 「返事を待つ」 as the server offered it (absent: not offered — a reply, Slack, an older server or a card stored before). */
function readAwaitReply(v: unknown): Pick<OutboundMailView, 'awaitReply'> {
  if (!v || typeof v !== 'object') return {}
  const a = v as Record<string, unknown>
  if (typeof a.defaultUntil !== 'string' || !DAY_RE.test(a.defaultUntil)) return {}
  const chosen = typeof a.chosenUntil === 'string' && DAY_RE.test(a.chosenUntil) ? a.chosenUntil : null
  return { awaitReply: { expected: a.expected === true, defaultUntil: a.defaultUntil, chosenUntil: chosen } }
}

/** A stored / streamed card, validated (undefined when malformed). */
export function readMailDraftCard(data: unknown): MailDraftCard | undefined {
  if (!data || typeof data !== 'object') return undefined
  const c = data as Record<string, unknown>
  if (!str(c.id, 200) || !str(c.companyId, 200) || !str(c.at, 40)) return undefined
  const draft = readMailDraft(c.draft)
  if (!draft) return undefined
  return { id: c.id, companyId: c.companyId, conversationId: typeof c.conversationId === 'string' ? c.conversationId : null, draft, byAi: c.byAi === true, at: c.at }
}

/**
 * What the AI is told about a draft it made, changed or showed again (`shown`): the content and
 * its state, never a claim that the AI sent anything.
 */
export function aiMailSummary(draft: OutboundMailView, shown = false): Record<string, unknown> {
  return {
    id: draft.id, version: draft.version, state: draft.state,
    to: draft.to.map(r => ({ ref: r.ref, email: r.email, name: r.name, source: r.source })),
    cc: draft.cc.map(r => ({ ref: r.ref, email: r.email, name: r.name, source: r.source })),
    subject: draft.subject, body: draft.body,
    // Names and sizes only (never a path): the member opens each file on the card.
    attachments: (draft.attachments ?? []).map(a => ({ name: a.name, size: a.size })),
    instruction: shown ? SHOWN_INSTRUCTION[draft.state] : 'The draft is shown to the member as a card. It is NOT sent: only the member sends it, from the card (「確かめて送る」). Never say it was sent. To change it, call mail_draft_update with this version as expectedVersion.',
  }
}

const SHOWN_INSTRUCTION: Record<OutboundMailState, string> = {
  draft: 'Shown again to the member as a new card here; nothing was changed. It is NOT sent: only the member sends it, from the card (「確かめて送る」). Never say it was sent. Change it only if the member asks (mail_draft_update with this version as expectedVersion).',
  sent: 'Shown again to the member as a new card here; nothing was changed. The member sent this mail from the card earlier.',
  unknown: 'Shown again to the member as a new card here; nothing was changed. Whether it arrived is unknown: the member checks Gmail\'s sent folder and answers on the card. Do not send or redraft it unless asked.',
  discarded: 'Shown again to the member as a new card here; nothing was changed. The member discarded this mail; it cannot be sent.',
}

export const OUTBOUND_MAIL_OFFLINE_TEXT = 'サーバーに接続できないため、いまは操作できません（オフラインの可能性があります）。'

/** 「開いて確かめる」: the file was saved on this PC and handed to the viewer, or why not. */
export type MailAttachmentOpenResult = { success: true } | { success: false; offline: boolean; error: string }

/** The answer of the card's own actions (IPC `outboundMail:*`), sent with the person's session. */
export type OutboundMailResult =
  | { success: true; draft: OutboundMailView; outcome?: 'sent' | 'unknown'; message?: string; recipients?: MailRecipientsView; recipient?: MailRecipientView }
  | { success: false; offline: boolean; code: string | null; error: string; needsGoogleConsent?: 'mail'; draft?: OutboundMailView; alreadySent?: MailAlreadySent }

/** A version change the card makes (the person's own edit). */
export interface MailDraftEdit {
  expectedVersion: number
  toRefs?: string[]
  ccRefs?: string[]
  subject?: string
  body?: string
}

/** 「返事を待つ」 ticked at 確かめて送る: the day to notice silence (`YYYY-MM-DD`; the server checks the range). */
export interface MailAwaitReply { until: string }

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export function isAwaitReply(v: unknown): v is MailAwaitReply {
  return !!v && typeof v === 'object' && Object.keys(v).length === 1 && typeof (v as MailAwaitReply).until === 'string' && DAY_RE.test((v as MailAwaitReply).until)
}

/** `2026-11-06` → 11月6日（金）. */
export function awaitDayLabel(day: string): string {
  if (!DAY_RE.test(day)) return day
  const [y, m, d] = day.split('-').map(Number)
  const dow = '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${m}月${d}日（${dow}）`
}

/** Validation of what the renderer passes to main (main checks again before calling the server). */
export const MESSAGE_ID_RE = /^outbound_message-[0-9a-z]{6,32}$/
export function isAttachmentId(v: unknown): v is string {
  return typeof v === 'string' && SHA256_HEX_RE.test(v)
}
/** The files the person was shown, as the send names them (each a sha256; at most the limit). */
export function isShownAttachments(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= ATTACHMENT_LIMITS.count && v.every(isAttachmentId)
}
/** 「それでも送る」's reason as main lets it leave: one line, 1–200 characters (the server's own rule). */
export function isResendReason(v: unknown): v is string {
  return typeof v === 'string' && v.length <= RESEND_REASON_MAX * 2 && resendReasonOf(v) !== null
}

/** The earlier send of a 409 `ALREADY_SENT_FOR_SOURCE`, or null when it is not one. */
export function readAlreadySent(v: unknown): MailAlreadySent | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.messageId !== 'string' || !RECORD_ID.test(o.messageId) || typeof o.by !== 'string' || typeof o.at !== 'string' || typeof o.message !== 'string') return null
  if (!(SOURCE_KINDS as readonly unknown[]).includes(o.kind)) return null
  return {
    messageId: o.messageId, by: o.by, byName: typeof o.byName === 'string' ? o.byName : null, at: o.at,
    kind: o.kind as MailAlreadySent['kind'], message: o.message.slice(0, 300),
  }
}
const RECORD_ID = /^outbound_message-[0-9a-z]{6,32}$/

export function isContentHash(v: unknown): v is string {

  return typeof v === 'string' && CONTENT_HASH_RE.test(v)
}
