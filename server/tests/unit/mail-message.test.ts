/**
 * The RFC 2822 message Gmail receives (server/src/lib/mail-message.ts, outbound-mail.md).
 * Protects: nothing in a draft can add a header or a recipient (a line break in the subject,
 * an address carrying another one) — the builder throws instead of sending; Japanese subjects
 * travel as RFC 2047 words and bodies as base64, so the text arrives as written.
 */
import { describe, expect, it } from 'vitest'
import { buildMailMessage, encodeHeaderWords, gmailRaw } from '../../src/lib/mail-message'

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
