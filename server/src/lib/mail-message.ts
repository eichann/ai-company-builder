/**
 * The RFC 2822 message Gmail's `users.messages.send` takes as `raw`
 * (`.claude/rules/outbound-mail.md`): plain text, UTF-8, the subject as RFC
 * 2047 encoded words, the body base64. With PDFs attached (outbound-mail.md
 * "Attachments") it is `multipart/mixed`: the same text part, then each file
 * base64 with `Content-Disposition: attachment` and its name as an RFC 2231
 * extended parameter (percent-encoded UTF-8, split into continuations), so a
 * name can never close the parameter or start a header. Built only from a draft version the
 * server holds (addresses already `normalizeEmail`'d, subject and body checked
 * by `mailContentProblems`) — and checked again here, so nothing can add a
 * header or a recipient: an address that is not a plain address, or a
 * subject with a line break, throws instead of being sent.
 */
import { randomBytes } from 'crypto'
import { canonicalMailText, looksLikePdf, MESSAGE_ID_RE, normalizeEmail, REPLY_REFERENCES_MAX, sanitizeAttachmentName } from '../../shared/core/mail'

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
  /** This message's own Message-ID (`<…>`); a random one when absent. */
  messageId?: string
  /** A reply (outbound-mail.md "Replies"): the message it answers and the thread's ids. */
  inReplyTo?: string
  references?: readonly string[]
  /** PDFs to attach, in order (each name already `sanitizeAttachmentName`'d; the bytes start `%PDF-`). */
  attachments?: ReadonlyArray<{ name: string; bytes: Uint8Array }>
}

function messageIdHeader(value: string): string {
  if (!MESSAGE_ID_RE.test(value)) throw new Error('mail-message: not one message id')
  return value
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

/** RFC 2231 attr-chars: everything else is percent-encoded. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/

/**
 * `<param>*0*=UTF-8''…; <param>*1*=…` (RFC 2231 §3, §4): the value as percent-encoded UTF-8 in
 * pieces of at most `piece` characters, never splitting an escape. Only attr-chars and `%` remain.
 */
export function rfc2231Parameter(param: string, value: string, piece = 50): string {
  let encoded = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte)
    encoded += byte < 0x80 && ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  const pieces: string[] = []
  let i = 0
  while (i < encoded.length) {
    let end = Math.min(i + piece, encoded.length)
    // Never cut a %XX in two.
    if (encoded[end - 1] === '%') end -= 1
    else if (encoded[end - 2] === '%') end -= 2
    pieces.push(encoded.slice(i, end))
    i = end
  }
  return pieces.map((p, n) => `${param}*${n}*=${n === 0 ? "UTF-8''" : ''}${p}`).join(';\r\n ')
}

function base64Lines(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n')
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
  const body = base64Lines(Buffer.from(canonicalMailText(m.body).replace(/\n/g, '\r\n'), 'utf8'))
  const files = m.attachments ?? []
  for (const f of files) {
    if (sanitizeAttachmentName(f.name) !== f.name) throw new Error('mail-message: not a plain attachment name')
    if (!looksLikePdf(f.bytes)) throw new Error('mail-message: an attachment that is not a PDF')
  }
  const boundary = `acb-mixed-${randomBytes(16).toString('hex')}`
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWords(canonicalMailText(m.subject))}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId ? messageIdHeader(m.messageId) : `<${randomBytes(16).toString('hex')}@${domain}>`}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${messageIdHeader(m.inReplyTo)}`] : []),
    ...(m.references && m.references.length > 0 ? [`References: ${m.references.slice(-REPLY_REFERENCES_MAX).map(messageIdHeader).join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
  ]
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']
  // Without files: exactly the message ACB always sent.
  if (files.length === 0) return `${[...headers, ...textPart].join('\r\n')}\r\n\r\n${body}\r\n`
  const parts = [
    `${textPart.join('\r\n')}\r\n\r\n${body}`,
    ...files.map(f => [
      `Content-Type: application/pdf;\r\n ${rfc2231Parameter('name', f.name)}`,
      `Content-Disposition: attachment;\r\n ${rfc2231Parameter('filename', f.name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(f.bytes),
    ].join('\r\n')),
  ]
  return `${[...headers, `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`].join('\r\n')}\r\n\r\n`
    + parts.map(p => `--${boundary}\r\n${p}\r\n`).join('') + `--${boundary}--\r\n`
}

/** The message as the bytes Gmail's upload endpoint takes (`message/rfc822`; the builder writes ASCII only). */
export function mailBytes(message: string): Uint8Array {
  return new Uint8Array(Buffer.from(message, 'utf8'))
}

/** The `raw` field: base64url of the message. */
export function gmailRaw(message: string): string {
  return Buffer.from(message, 'utf8').toString('base64url')
}
