/**
 * The RFC 2822 message Gmail receives (server/src/lib/mail-message.ts, outbound-mail.md).
 * Protects: nothing in a draft can add a header or a recipient (a line break in the subject,
 * an address carrying another one) — the builder throws instead of sending; Japanese subjects
 * travel as RFC 2047 words and bodies as base64, so the text arrives as written.
 */
import { describe, expect, it } from 'vitest'
import { buildMailMessage, encodeHeaderWords, gmailRaw, rfc2231Parameter } from '../../src/lib/mail-message'
import { CORE_TYPE_FILES, coreTypeDefinitions } from '../../../shared/core/core-types'
import { awaitReplyDefault, awaitReplyUntilProblem, looksLikePdf, mailContentCanonical, sanitizeAttachmentName } from '../../../shared/core/mail'
import { compareTypeDefinitions, parseTypeFile } from '../../../shared/core/record-types'

const base = { from: 'sato@div.example', to: ['suzuki@a-corp.example'], cc: [], subject: 'お礼', body: '本文', date: new Date('2026-11-05T06:52:00Z') }
const headersOf = (m: string) => m.slice(0, m.indexOf('\r\n\r\n')).replace(/\r\n /g, ' ').split('\r\n')

describe('buildMailMessage', () => {
  it('a Japanese subject as encoded words, a base64 body, exactly the headers it should have', () => {
    const m = buildMailMessage({ ...base, cc: ['tanaka@div.example'], subject: '本日はありがとうございました（株式会社サンプル 様）', body: '鈴木様\n\nありがとうございました。\n' })
    const h = headersOf(m)
    expect(h.map(l => l.slice(0, l.indexOf(':')))).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding'])
    const subject = h.find(l => l.startsWith('Subject:'))!
    expect(subject).toMatch(/^Subject: (=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?)+$/)
    for (const line of m.slice(0, m.indexOf('\r\n\r\n')).split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    const decoded = subject.slice(9).split(' ').map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')
    expect(decoded).toBe('本日はありがとうございました（株式会社サンプル 様）')
    const body = Buffer.from(m.slice(m.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8')
    expect(body).toBe('鈴木様\r\n\r\nありがとうございました。\r\n')
    expect(Buffer.from(gmailRaw(m), 'base64url').toString('utf8')).toBe(m)
  })

  it('refuses a subject that would start another header, and any address that is not one plain address', () => {
    expect(() => buildMailMessage({ ...base, subject: 'お礼\r\nBcc: spy@attacker.example' })).toThrow()
    expect(() => buildMailMessage({ ...base, subject: 'お礼\nBcc: spy@attacker.example' })).toThrow()
    for (const bad of ['a@b.example\r\nBcc: spy@attacker.example', 'a@b.example, spy@attacker.example', '"x" <spy@attacker.example>', 'A@B.example']) {
      expect(() => buildMailMessage({ ...base, to: [bad] }), bad).toThrow()
      expect(() => buildMailMessage({ ...base, cc: [bad] }), bad).toThrow()
      expect(() => buildMailMessage({ ...base, from: bad }), bad).toThrow()
    }
    expect(() => buildMailMessage({ ...base, to: [] })).toThrow()
  })

  it('plain ASCII stays readable; text that looks like an encoded word is encoded', () => {
    expect(encodeHeaderWords('Thank you')).toBe('Thank you')
    expect(encodeHeaderWords('=?UTF-8?B?x?=')).toMatch(/^=\?UTF-8\?B\?/)
  })
})

describe('a reply (outbound-mail.md "Replies")', () => {
  it('carries its own Message-ID, In-Reply-To and References', () => {
    const h = headersOf(buildMailMessage({ ...base, messageId: '<acb.1@div.example>', inReplyTo: '<m2@a.example>', references: ['<m1@a.example>', '<m2@a.example>'] }))
    expect(h).toContain('Message-ID: <acb.1@div.example>')
    expect(h).toContain('In-Reply-To: <m2@a.example>')
    expect(h).toContain('References: <m1@a.example> <m2@a.example>')
  })

  it('a message id from the thread that could end the header or add another is refused, not sent', () => {
    expect(() => buildMailMessage({ ...base, inReplyTo: '<m2@a.example>\r\nBcc: spy@attacker.example' })).toThrow()
    expect(() => buildMailMessage({ ...base, references: ['<m1@a.example> <x@y>'] })).toThrow()
    expect(() => buildMailMessage({ ...base, messageId: 'no-brackets@a.example' })).toThrow()
  })

  it('a draft made before replies keeps its hash; a reply\'s thread is part of what is hashed', () => {
    const content = { from: 'sato@div.example', to: ['suzuki@a-corp.example'], cc: [], subject: 'お礼', body: '本文' }
    expect(mailContentCanonical(content)).toBe('{"attachments":[],"body":"本文","cc":[],"from":"sato@div.example","subject":"お礼","to":["suzuki@a-corp.example"],"v":1}')
    const a = mailContentCanonical({ ...content, reply: { threadId: 't1', inReplyTo: '<m2@a.example>', references: ['<m2@a.example>'] } })
    const b = mailContentCanonical({ ...content, reply: { threadId: 't2', inReplyTo: '<m2@a.example>', references: ['<m2@a.example>'] } })
    expect(a).not.toBe(b)
  })

  it('outbound_message 5 only adds to 3 (the interaction it answers, the Slack thread; 返事を待つ and the task)', () => {
    const before = parseTypeFile('outbound_message', OUTBOUND_MESSAGE_V3_TEXT)
    if (!before.ok) throw new Error(before.errors.join())
    const now = coreTypeDefinitions().find(d => d.name === 'outbound_message')!
    const change = compareTypeDefinitions(before.definition, now)
    expect(change.breaking).toEqual([])
    expect(change.versionProblem).toBeNull()
    expect(now.version).toBe(5)
    expect(now.links.interaction.target).toBe('interaction')
    expect(Object.keys(now.fields)).toEqual(expect.arrayContaining(['expects_reply', 'reply_wait_until']))
    expect(now.links.task.target).toBe('task')
  })

  it('reply_request 4 only adds to 3 (the task a mail we sent first came from, an origin link)', () => {
    const v3 = CORE_TYPE_FILES.reply_request.replace(/version: \d+/, 'version: 3').split('\n').filter(l => !l.startsWith('  task:')).join('\n')
    const before = parseTypeFile('reply_request', v3)
    if (!before.ok) throw new Error(before.errors.join())
    const now = coreTypeDefinitions().find(d => d.name === 'reply_request')!
    const change = compareTypeDefinitions(before.definition, now)
    expect(change.breaking).toEqual([])
    expect(change.versionProblem).toBeNull()
    expect(now.links.task).toMatchObject({ target: 'task', origin: true })
  })
})

describe('返事を待つ: the day to notice silence (outbound-mail.md "Waiting for their answer")', () => {
  it('the third business day after sending: weekends, public holidays and the company\'s own days off skipped', () => {
    // Mon 2026-11-02 10:00 in Tokyo; 11-03 (Tue) is 文化の日.
    const monday = new Date('2026-11-02T01:00:00.000Z')
    expect(awaitReplyDefault(monday)).toBe('2026-11-06')
    expect(awaitReplyDefault(monday, ['2026-11-05'])).toBe('2026-11-09')
    // Friday 19:00 in Tokyo: Mon, (文化の日), Wed, Thu.
    expect(awaitReplyDefault(new Date('2026-10-30T10:00:00.000Z'))).toBe('2026-11-05')
    // Thursday 15:30 UTC is already Friday 00:30 in Tokyo: the count starts from Friday.
    expect(awaitReplyDefault(new Date('2026-10-29T15:30:00.000Z'))).toBe('2026-11-05')
  })

  it('the picked day: today up to 180 days ahead, a real date', () => {
    const now = new Date('2026-11-02T01:00:00.000Z')
    expect(awaitReplyUntilProblem('2026-11-02', now)).toBeNull()
    expect(awaitReplyUntilProblem('2027-05-01', now)).toBeNull()
    for (const bad of ['2026-11-01', '2027-05-02', '2026-02-30', '2026-11-05T09:00', 20261105, null]) expect(awaitReplyUntilProblem(bad, now), String(bad)).not.toBeNull()
  })
})

const OUTBOUND_MESSAGE_V3_TEXT = `---
label: 送るもの
version: 3
implements: [prepared]
storage: server
fields:
  requested_by:        { label: 作った人, kind: person, source: server }
  assignee:            { label: 担当, kind: person, source: server }
  subject:             { label: 件名, kind: text, source: server }
  payload_hash:        { label: 内容の印, kind: text, source: server }
  payload_version:     { label: 中身の版, kind: number, source: server }
  sent_at:             { label: 送った日時, kind: datetime, source: server }
  provider_message_id: { label: 送った先での番号, kind: text, source: server }
  channel:             { label: 経路, kind: choice, options: [email, slack], option_labels: { email: メール, slack: Slack }, source: server }
links:
  bundle:              { label: まとまり, interface: bundle, cardinality: one, inverse: messages }
  meeting:             { label: 会議, target: meeting, cardinality: one, inverse: messages }
states: [draft, sent, unknown, discarded]
initial: draft
final: [sent, discarded]
---
# 送るもの
`

describe('attachments (outbound-mail.md "Attachments")', () => {
  const content = { from: 'sato@div.example', to: ['suzuki@a-corp.example'], cc: [], subject: 'お礼', body: '本文' }
  const OLD = '{"attachments":[],"body":"本文","cc":[],"from":"sato@div.example","subject":"お礼","to":["suzuki@a-corp.example"],"v":1}'
  const file = { name: '提案書（株式会社サンプル様）.pdf', size: 5, sha256: 'a'.repeat(64) }

  it('additive: a mail without files keeps exactly the canonical text (and hash) it always had; a file changes it, and so does each of its facts', () => {
    expect(mailContentCanonical({ ...content, attachments: [] })).toBe(OLD)
    expect(mailContentCanonical(content)).toBe(OLD)
    const one = mailContentCanonical({ ...content, attachments: [file] })
    expect(one).toContain('"attachments":[{"name":"提案書（株式会社サンプル様）.pdf","sha256":"' + 'a'.repeat(64) + '","size":5}]')
    for (const other of [{ ...file, name: '提案書.pdf' }, { ...file, size: 6 }, { ...file, sha256: 'b'.repeat(64) }]) {
      expect(mailContentCanonical({ ...content, attachments: [other] })).not.toBe(one)
    }
    const second = { ...file, sha256: 'c'.repeat(64) }
    expect(mailContentCanonical({ ...content, attachments: [file, second] })).not.toBe(mailContentCanonical({ ...content, attachments: [second, file] }))
  })

  it('a file name: the last path segment, NFC, no control or direction characters, ending .pdf, ≤ 120 characters', () => {
    expect(sanitizeAttachmentName('営業部/.personal/提案書/A社/提案書.pdf')).toBe('提案書.pdf')
    expect(sanitizeAttachmentName('C:\\Users\\x\\見積.PDF')).toBe('見積.PDF')
    expect(sanitizeAttachmentName('提案\r\nBcc: x@y.example.pdf')).toBe('提案Bcc: x@y.example.pdf')
    expect(sanitizeAttachmentName('invoice\u202Efdp.exe')).toBeNull()
    expect(sanitizeAttachmentName('ガ'.normalize('NFD') + '.pdf')).toBe('ガ.pdf')
    for (const bad of ['proposal.exe', '.pdf', '', 'a/', `${'あ'.repeat(117)}.pdf`, 3, null]) expect(sanitizeAttachmentName(bad), String(bad)).toBeNull()
    expect(sanitizeAttachmentName(`${'あ'.repeat(116)}.pdf`)).not.toBeNull()
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(looksLikePdf(new TextEncoder().encode('%PDF'))).toBe(false)
    expect(looksLikePdf(new TextEncoder().encode('MZ%PDF-'))).toBe(false)
  })

  const pdfBytes = (text: string) => new TextEncoder().encode(`%PDF-1.7\n${text}`)
  const headerBlock = (m: string) => m.slice(0, m.indexOf('\r\n\r\n'))

  it('without files the message is the one ACB always built, byte for byte', () => {
    const plain = buildMailMessage({ ...base, messageId: '<acb.1@div.example>' })
    expect(buildMailMessage({ ...base, messageId: '<acb.1@div.example>', attachments: [] })).toBe(plain)
    expect(headersOf(plain).at(-2)).toBe('Content-Type: text/plain; charset=UTF-8')
  })

  it('multipart/mixed: the text part, then each PDF base64 with Content-Disposition attachment and its name as RFC 2231 continuations', () => {
    const name = `${'提案書'.repeat(10)}（株式会社サンプル様）"; filename=evil.exe.pdf`
    const bytes = pdfBytes('x'.repeat(200))
    const m = buildMailMessage({ ...base, messageId: '<acb.1@div.example>', attachments: [{ name, bytes }] })
    const boundary = /boundary="([^"]+)"/.exec(headerBlock(m))![1]
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    const parts = m.split(`--${boundary}`)
    expect(parts.at(-1)).toBe('--\r\n')
    const [text, pdf] = parts.slice(1, 3)
    expect(text).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(Buffer.from(text.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8')).toBe('本文')
    const head = pdf.split('\r\n\r\n')[0].replace(/\r\n /g, ' ')
    expect(head).toMatch(/Content-Type: application\/pdf; name\*0\*=UTF-8''/)
    expect(head).toMatch(/Content-Disposition: attachment; filename\*0\*=UTF-8''/)
    // The name never closes the parameter: no quote, semicolon or space survives inside a value.
    const disposition = /Content-Disposition: attachment; (.*?)(\r?\n|$)/.exec(head.split('Content-Transfer-Encoding')[0])![1]
    const pieces = disposition.split('; ').map(p => /^filename\*(\d+)\*=(.*)$/.exec(p.trim())!)
    for (const p of pieces) expect(p[2].replace(/^UTF-8''/, '')).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/)
    const decoded = decodeURIComponent(pieces.map(p => p[2].replace(/^UTF-8''/, '')).join(''))
    expect(decoded).toBe(name)
    expect(Buffer.from(pdf.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(rfc2231Parameter('filename', '%%%%', 4)).toBe("filename*0*=UTF-8''%25;\r\n filename*1*=%25;\r\n filename*2*=%25;\r\n filename*3*=%25")
  })

  it('refuses a file that is not a PDF or a name that was not made plain — nothing to send', () => {
    expect(() => buildMailMessage({ ...base, attachments: [{ name: 'a.pdf', bytes: new TextEncoder().encode('MZ...') }] })).toThrow()
    expect(() => buildMailMessage({ ...base, attachments: [{ name: 'a\r\nBcc: spy@attacker.example.pdf', bytes: pdfBytes('') }] })).toThrow()
    expect(() => buildMailMessage({ ...base, attachments: [{ name: 'dir/a.pdf', bytes: pdfBytes('') }] })).toThrow()
  })
})
