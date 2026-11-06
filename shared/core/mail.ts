/**
 * Outgoing mail (design 節目4 §3-5, §4-2, §4-3, N9): the one copy of what a
 * draft may hold and of its canonical form, for the server (drafts, the send
 * check), the app (the core-drawn mail card) and tests.
 *
 * - Recipients are **verified recipients** only: an address found in a source
 *   other than the AI — the meeting's calendar attendees, the HubSpot contacts
 *   of the deal, ACB members (CC), or one a person typed on the screen
 *   (「あなたが入力」). A draft names them by `ref`; an address the AI wrote
 *   that is in none of these is not even offered (the server keeps refs, not
 *   the AI's text).
 * - Plain text, with up to `ATTACHMENT_LIMITS.count` PDF files attached (plan §14-1: the
 *   proposal a company Skill wrote). Each file is part of the fixed content by its name, size
 *   and sha256, so a changed file is a changed mail.
 * - The canonical form (hashed by the server) is the sender, To, CC, subject,
 *   body with line ends as `\n` and NFC — nothing trimmed: one character's
 *   difference is a different content.
 * - A person presses send; the hash of the version on screen must equal the
 *   server's. Nothing here sends.
 */
import { addBusinessDays, addDays, isCalendarDate } from './business-days'
import { canonicalJson } from './fixed-content'
import type { SourceKind } from './source-slots'
import { japanDateTime } from './task-settings'

export const RECIPIENT_SOURCES = ['calendar', 'hubspot', 'member', 'typed', 'thread'] as const
export type RecipientSource = typeof RECIPIENT_SOURCES[number]

export const RECIPIENT_SOURCE_LABELS: Record<RecipientSource, string> = {
  calendar: 'カレンダーの参加者',
  hubspot: 'HubSpot の連絡先',
  member: 'ACB のメンバー',
  typed: 'あなたが入力',
  thread: 'スレッドの相手',
}

/** A recipient as the server offers it: an opaque ref, the address, a display name and where it was found. */
export interface VerifiedRecipient {
  ref: string
  email: string
  name: string | null
  source: RecipientSource
}

export const MAIL_LIMITS = {
  subject: 200,
  body: 20_000,
  to: 20,
  cc: 20,
} as const

/**
 * A plain address: ASCII local part without quotes, spaces, commas or angle
 * brackets; a dotted domain. Strict on purpose (an address goes into a
 * header; nothing that could add a header or another recipient passes).
 */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** The address in the form ACB compares and stores (trimmed, lower case), or null when it is not a plain address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  if (e.length > 254 || !EMAIL_RE.test(e) || e.includes('..') || e.startsWith('.') || e.split('@')[0].endsWith('.')) return null
  return e
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

/** An address outside the company's own domains (the internal-only meeting test, first-time-recipient notice). */
export function isExternalAddress(email: string, internalDomains: readonly string[]): boolean {
  const d = emailDomain(email)
  return !internalDomains.some(i => d === i.toLowerCase() || d.endsWith(`.${i.toLowerCase()}`))
}

/** Line ends as `\n`, NFC. Nothing else changes (spaces stay). */
export function canonicalMailText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC')
}

/**
 * A reply into a conversation of the member's own mailbox (A4, outbound-mail.md
 * "Replies"): the provider's conversation id and the `In-Reply-To` /
 * `References` the message carries — fixed with the draft, so the hash covers them.
 */
export interface MailReplyHeaders {
  threadId: string
  inReplyTo: string
  references: string[]
}

/** One `Message-ID` as a header may carry it: `<…>` with nothing that could end the header. */
export const MESSAGE_ID_RE = /^<[\x21-\x3b\x3d\x3f-\x7e]{3,250}>$/
export const REPLY_REFERENCES_MAX = 20

/** A file attached to a mail, as the fixed content names it (the bytes are kept by the server). */
export interface MailAttachment {
  /** The file name shown and sent (`sanitizeAttachmentName`). */
  name: string
  /** Bytes. */
  size: number
  /** Lower-case hex sha256 of the bytes. */
  sha256: string
}

/** PDFs only (owner decision §14-1): what a company Skill writes and a customer can open. */
export const ATTACHMENT_LIMITS = {
  count: 3,
  /** All files of one mail together (one file at most the same). */
  totalBytes: 10 * 1024 * 1024,
  name: 120,
} as const
export const ATTACHMENT_CONTENT_TYPE = 'application/pdf'
/** The first bytes of every PDF file. */
export const PDF_MAGIC = '%PDF-'
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** Whether the bytes start like a PDF file (`%PDF-`). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  for (let i = 0; i < PDF_MAGIC.length; i++) if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false
  return true
}

/**
 * The name an attachment is shown and sent under, or null when none fits: the last path segment
 * (no folder ever travels), NFC, without control characters, trimmed, at most
 * `ATTACHMENT_LIMITS.name` characters, ending in `.pdf`. Direction marks go too (a name drawn
 * right to left could hide its real ending).
 */
export function sanitizeAttachmentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const last = raw.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const name = last.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim()
  if (name === '' || name.startsWith('.') || [...name].length > ATTACHMENT_LIMITS.name || !/\.pdf$/i.test(name)) return null
  return name
}

/** Why a mail's list of attachments cannot be (Japanese sentences), or an empty list. */
export function attachmentListProblems(list: readonly MailAttachment[]): string[] {
  const problems: string[] = []
  if (list.length > ATTACHMENT_LIMITS.count) problems.push(`付けられるファイルは ${ATTACHMENT_LIMITS.count} つまでです`)
  if (list.reduce((n, a) => n + a.size, 0) > ATTACHMENT_LIMITS.totalBytes) problems.push('付けるファイルは、合わせて 10 MB までです')
  if (new Set(list.map(a => a.sha256)).size !== list.length) problems.push('同じファイルが2回付いています')
  if (list.some(a => sanitizeAttachmentName(a.name) !== a.name || !SHA256_HEX_RE.test(a.sha256) || !Number.isInteger(a.size) || a.size <= 0)) problems.push('付けるファイルの形が正しくありません')
  return problems
}

export interface MailContent {
  from: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  reply?: MailReplyHeaders
  /** PDFs attached (absent or empty: none — the canonical text of a mail without files is unchanged). */
  attachments?: readonly MailAttachment[]
}

// eslint-disable-next-line no-control-regex
const SUBJECT_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/
// eslint-disable-next-line no-control-regex
const BODY_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Why the content cannot be a draft (Japanese sentences), or an empty list. */
export function mailContentProblems(c: { to: readonly string[]; cc: readonly string[]; subject: string; body: string }): string[] {
  const problems: string[] = []
  if (c.to.length === 0) problems.push('宛先を1つ以上選んでください')
  if (c.to.length > MAIL_LIMITS.to) problems.push(`宛先は ${MAIL_LIMITS.to} 件までです`)
  if (c.cc.length > MAIL_LIMITS.cc) problems.push(`CC は ${MAIL_LIMITS.cc} 件までです`)
  const all = [...c.to, ...c.cc]
  if (all.some(e => normalizeEmail(e) !== e)) problems.push('宛先の形が正しくありません')
  if (new Set(all).size !== all.length) problems.push('同じ宛先が2回入っています')
  if (c.subject.trim() === '') problems.push('件名を書いてください')
  if (c.subject.length > MAIL_LIMITS.subject) problems.push(`件名は ${MAIL_LIMITS.subject} 文字までです`)
  if (SUBJECT_BAD.test(c.subject)) problems.push('件名に改行や使えない文字が入っています')
  if (c.body.trim() === '') problems.push('本文を書いてください')
  if (c.body.length > MAIL_LIMITS.body) problems.push(`本文は ${MAIL_LIMITS.body} 文字までです`)
  if (BODY_BAD.test(c.body)) problems.push('本文に使えない文字が入っています')
  return problems
}

/**
 * The canonical text the server hashes for a mail. Attachments are `{ name, size, sha256 }` in the
 * order attached; a mail without any keeps `attachments: []`, so every hash made before files
 * existed still matches.
 */
export function mailContentCanonical(c: MailContent): string {
  return canonicalJson({
    v: 1,
    from: c.from,
    to: [...c.to],
    cc: [...c.cc],
    subject: canonicalMailText(c.subject),
    body: canonicalMailText(c.body),
    attachments: (c.attachments ?? []).map(a => ({ name: a.name, size: a.size, sha256: a.sha256 })),
    // Only a reply carries it (a draft made before replies keeps its hash).
    ...(c.reply ? { reply: { threadId: c.reply.threadId, inReplyTo: c.reply.inReplyTo, references: [...c.reply.references] } } : {}),
  })
}

/** A reply's subject: the thread's own, with one 「Re: 」. */
export function replySubject(subject: string): string {
  const s = subject.trim()
  return /^re:/i.test(s) ? s : `Re: ${s}`.trim()
}

// ---- Chat replies (A4: Slack's 返事, one `outbound_message` type for every channel) ----

export const CHAT_REPLY_LIMITS = { body: 4_000 } as const

/** A reply posted into a chat thread as the member: the thread is fixed with the draft. */
export interface ChatReplyContent {
  /** The member's ACB email (their chat permission is for it). */
  from: string
  channelId: string
  threadTs: string
  body: string
}

export function chatReplyProblems(c: { body: string }): string[] {
  const problems: string[] = []
  if (c.body.trim() === '') problems.push('本文を書いてください')
  if (c.body.length > CHAT_REPLY_LIMITS.body) problems.push(`本文は ${CHAT_REPLY_LIMITS.body} 文字までです`)
  if (BODY_BAD.test(c.body)) problems.push('本文に使えない文字が入っています')
  return problems
}

export function chatReplyCanonical(c: ChatReplyContent): string {
  return canonicalJson({ v: 1, kind: 'chat_reply', from: c.from, thread: { channel: c.channelId, ts: c.threadTs }, body: canonicalMailText(c.body) })
}

/** Links in a body (shown on the card: 「本文にリンクが N つあります」). */
export function countLinks(body: string): number {
  return (body.match(/\bhttps?:\/\/[^\s<>"'）)]+/gi) ?? []).length
}

/**
 * 「返事を待つ」 at 確かめて送る (outbound-mail.md "Waiting for their answer"): a new mail we send
 * first may wait for the other side's answer. Their silence is noticed on the morning of the day
 * the member picked — by default the third business day after sending (weekends, Japanese public
 * holidays and the company's own holidays are off) — at `AWAIT_REPLY_TIME` (company clock).
 */
export const AWAIT_REPLY_BUSINESS_DAYS = 3
export const AWAIT_REPLY_TIME = '09:00'
/** The furthest day the member may pick (days after today). */
export const AWAIT_REPLY_MAX_DAYS = 180

/** The default day to notice silence: the `AWAIT_REPLY_BUSINESS_DAYS`-th business day after `sentAt` (Japan date). */
export function awaitReplyDefault(sentAt: Date, companyHolidays: Iterable<string> = []): string {
  return addBusinessDays(japanDateTime(sentAt).date, AWAIT_REPLY_BUSINESS_DAYS, companyHolidays)
}

/** Why `until` (a picked day, `YYYY-MM-DD`) cannot be the day to wait until at `now`, or null. */
export function awaitReplyUntilProblem(until: unknown, now: Date): string | null {
  if (!isCalendarDate(until)) return '返事を待つ日は、日付（YYYY-MM-DD）で選んでください。'
  const today = japanDateTime(now).date
  if (until < today) return '返事を待つ日には、今日かそれよりあとの日を選んでください。'
  if (until > addDays(today, AWAIT_REPLY_MAX_DAYS)) return `返事を待つ日は、${AWAIT_REPLY_MAX_DAYS} 日先までで選んでください。`
  return null
}

/** The stored 返事の見込み of a picked day (`wait_until`, the company's clock): that day's morning. */
export const awaitReplyWaitUntil = (until: string) => `${until}T${AWAIT_REPLY_TIME}`

/** 「それでも送る」's reason: one line, 1–200 characters (outbound-mail.md "One send per source"). */
export const RESEND_REASON_MAX = 200

/** The reason as kept (NFC, trimmed), or null when it is not one. */
export function resendReasonOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.normalize('NFC').trim()
  // eslint-disable-next-line no-control-regex
  return v.length >= 1 && v.length <= RESEND_REASON_MAX && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v) ? v : null
}

/** What was sent on the same source, by the source's kind (`shared/core/source-slots.ts`). */
const ALREADY_SENT_WHAT: Record<SourceKind, string> = {
  meeting: 'この会議のお礼メール',
  thread: 'この連絡への返事',
  'follow-up': 'この件の催促',
  bundle: 'この件のメール',
}

/** 「11/06 15:30」 in Japan time. */
export function shortJapanTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const { date, minutes } = japanDateTime(d)
  return `${date.slice(5, 7)}/${date.slice(8, 10)} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * 「この会議のお礼メールは佐藤さんが 11/06 15:30 に送りました」: `who` is the sender's display name,
 * null for the person asking (「あなた」), `''` when the name is not known (「ほかの人」).
 */
export function alreadySentText(kind: SourceKind, who: string | null, at: string): string {
  const by = who === null ? 'あなた' : who === '' ? 'ほかの人' : `${who}さん`
  const when = shortJapanTime(at)
  return `${ALREADY_SENT_WHAT[kind]}は${by}が${when ? ` ${when} に` : ''}送りました`
}

/** What a released app (which knows no 「それでも送る」) shows, as is, after the sentence. */
export const ALREADY_SENT_OLD_APP_TEXT = 'それでも送るときは、アプリを新しくしてから、理由をひとこと書いて送ってください。何も送っていません。'
