/**
 * The RFC 2822 message Gmail's `users.messages.send` takes as `raw`
 * (`.claude/rules/outbound-mail.md`): plain text, UTF-8, the subject as RFC
 * 2047 encoded words, the body base64. Built only from a draft version the
 * server holds (addresses already `normalizeEmail`'d, subject and body checked
 * by `mailContentProblems`) — and checked again here, so nothing can add a
 * header or a recipient: an address that is not a plain address, or a
 * subject with a line break, throws instead of being sent.
 */
import { randomBytes } from 'crypto'
import { canonicalMailText, normalizeEmail } from '../../shared/core/mail'

export interface MailMessageInput {
  from: string
  to: readonly string[]
  cc: readonly string[]
  subject: string
  body: string
  /** RFC 2822 date (tests pass a fixed one). */
  date: Date
  /** The right-hand side of Message-ID (the From's domain). */
  messageIdDomain?: string
}

/** `=?UTF-8?B?…?=` words of at most 75 characters, split on whole characters. */
export function encodeHeaderWords(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && !text.includes('=?')) return text
  const words: string[] = []
  let chunk = ''
  for (const ch of text) {
    // 36 bytes of UTF-8 → 48 base64 characters: a word of 60, a header line within 78.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 36) { words.push(chunk); chunk = '' }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

function address(raw: string): string {
  const e = normalizeEmail(raw)
  if (e === null || e !== raw) throw new Error('mail-message: not a plain address')
  return e
}

/** The whole message (CRLF line ends). */
export function buildMailMessage(m: MailMessageInput): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(m.subject)) throw new Error('mail-message: control character in the subject')
  if (m.to.length === 0) throw new Error('mail-message: no recipient')
  const from = address(m.from)
  const to = m.to.map(address)
  const cc = m.cc.map(address)
  const domain = m.messageIdDomain ?? from.slice(from.indexOf('@') + 1)
  const body = Buffer.from(canonicalMailText(m.body).replace(/\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWords(canonicalMailText(m.subject))}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

/** The `raw` field: base64url of the message. */
export function gmailRaw(message: string): string {
  return Buffer.from(message, 'utf8').toString('base64url')
}
