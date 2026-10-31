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
 * - Plain text only, no attachments (milestone 4).
 * - The canonical form (hashed by the server) is the sender, To, CC, subject,
 *   body with line ends as `\n` and NFC — nothing trimmed: one character's
 *   difference is a different content.
 * - A person presses send; the hash of the version on screen must equal the
 *   server's. Nothing here sends.
 */
import { canonicalJson } from './fixed-content'

export const RECIPIENT_SOURCES = ['calendar', 'hubspot', 'member', 'typed'] as const
export type RecipientSource = typeof RECIPIENT_SOURCES[number]

export const RECIPIENT_SOURCE_LABELS: Record<RecipientSource, string> = {
  calendar: 'カレンダーの参加者',
  hubspot: 'HubSpot の連絡先',
  member: 'ACB のメンバー',
  typed: 'あなたが入力',
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

export interface MailContent {
  from: string
  to: string[]
  cc: string[]
  subject: string
  body: string
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

/** The canonical text the server hashes for a mail (no attachments in milestone 4). */
export function mailContentCanonical(c: MailContent): string {
  return canonicalJson({
    v: 1,
    from: c.from,
    to: [...c.to],
    cc: [...c.cc],
    subject: canonicalMailText(c.subject),
    body: canonicalMailText(c.body),
    attachments: [],
  })
}

/** Links in a body (shown on the card: 「本文にリンクが N つあります」). */
export function countLinks(body: string): number {
  return (body.match(/\bhttps?:\/\/[^\s<>"'）)]+/gi) ?? []).length
}
