/**
 * The RFC 2822 message Gmail receives (server/src/lib/mail-message.ts, outbound-mail.md).
 * Protects: nothing in a draft can add a header or a recipient (a line break in the subject,
 * an address carrying another one) — the builder throws instead of sending; Japanese subjects
 * travel as RFC 2047 words and bodies as base64, so the text arrives as written.
 */
import { describe, expect, it } from 'vitest'
import { buildMailMessage, encodeHeaderWords, gmailRaw } from '../../src/lib/mail-message'
import { CORE_TYPE_FILES, coreTypeDefinitions } from '../../../shared/core/core-types'
import { awaitReplyDefault, awaitReplyUntilProblem, mailContentCanonical } from '../../../shared/core/mail'
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
