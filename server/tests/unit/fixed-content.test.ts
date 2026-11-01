/**
 * Fixed content, approvals and mail (shared/core fixed-content.ts,
 * approvals.ts, mail.ts; design 節目4 §3-4, §3-5, §4-2, §4-3).
 *
 * Guards:
 * - the canonical form the server hashes changes with any one character
 *   (spaces included) and not with key order — so 「承認した中身と送る中身が
 *   同じ」 is decided on the content, not on how it was serialised;
 * - who may approve: a member alone only for their own `self` request; a
 *   department manager not for an `admin` one;
 * - an address or subject that could add a header or another recipient is
 *   refused before anything is stored.
 */
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { approvalPayloadCanonical, approvalReasonProblem, mayApprove, type ApprovalPayload } from '../../../shared/core/approvals'
import { canonicalJson } from '../../../shared/core/fixed-content'
import { countLinks, mailContentCanonical, mailContentProblems, normalizeEmail, type MailContent } from '../../../shared/core/mail'
import { quoteAppearsIn } from '../../../shared/core/minutes'

const hash = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`

const PAYLOAD: ApprovalPayload = {
  v: 1, kind: 'plugin_operation',
  plugin: { id: 'hubspot', version: '0.2.0', fingerprint: 'f'.repeat(64) },
  mappingVersion: 3, connectionId: 'conn-1', accountId: '1234', operation: 'update_deal',
  record: { id: 'deal-8f3a2c', version: 9 }, object: 'deal', externalId: '9001',
  changes: [{ field: 'amount', property: 'amount', before: 1200000, after: 1500000, rawBefore: '1200000', rawAfter: '1500000' }],
  create: null, basis: { minutesId: null, quote: '金額は150万円で' },
}

const MAIL: MailContent = {
  from: 'sato@div.example', to: ['suzuki@a-corp.example'], cc: ['tanaka@div.example'],
  subject: '本日のお打ち合わせのお礼', body: '鈴木様\n\n本日はありがとうございました。\n',
}

describe('the canonical form fixes the content', () => {
  it('key order does not matter; one character, one space or one value does', () => {
    expect(canonicalJson({ b: 1, a: [1, 'x'] })).toBe(canonicalJson({ a: [1, 'x'], b: 1 }))
    const base = hash(approvalPayloadCanonical(PAYLOAD))
    expect(hash(approvalPayloadCanonical({ ...PAYLOAD, changes: [{ ...PAYLOAD.changes[0], rawAfter: '1500001' }] }))).not.toBe(base)
    expect(hash(approvalPayloadCanonical({ ...PAYLOAD, record: { id: 'deal-8f3a2c', version: 10 } }))).not.toBe(base)

    const mail = hash(mailContentCanonical(MAIL))
    expect(hash(mailContentCanonical({ ...MAIL, body: MAIL.body.replace('。', '。 ') }))).not.toBe(mail)
    expect(hash(mailContentCanonical({ ...MAIL, cc: [] }))).not.toBe(mail)
    // Line ends and composed / decomposed kana are the same text.
    expect(hash(mailContentCanonical({ ...MAIL, body: MAIL.body.replace(/\n/g, '\r\n') }))).toBe(mail)
    expect(hash(mailContentCanonical({ ...MAIL, subject: MAIL.subject.normalize('NFD') }))).toBe(mail)
  })

  it('refuses values with no canonical form rather than guessing', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
    expect(() => canonicalJson({ a: new Date(0) })).toThrow()
  })
})

describe('who may approve', () => {
  it('self: the requester or a stricter role; dept_manager: not the requester alone; admin: owners / admins only', () => {
    const member = { isRequester: true, isDeptManager: false, isAdmin: false }
    const manager = { isRequester: false, isDeptManager: true, isAdmin: false }
    const admin = { isRequester: false, isDeptManager: false, isAdmin: true }
    const other = { isRequester: false, isDeptManager: false, isAdmin: false }
    expect([member, manager, admin, other].map(w => mayApprove('self', w))).toEqual([true, true, true, false])
    expect([member, manager, admin, other].map(w => mayApprove('dept_manager', w))).toEqual([false, true, true, false])
    expect([member, manager, admin, other].map(w => mayApprove('admin', w))).toEqual([false, false, true, false])
  })

  it('an approval needs a reason', () => {
    expect(approvalReasonProblem('')).not.toBeNull()
    expect(approvalReasonProblem('   ')).not.toBeNull()
    expect(approvalReasonProblem('議事録の合意どおり')).toBeNull()
  })
})

describe('mail content', () => {
  it('an address that could carry another header or recipient is not an address', () => {
    for (const bad of ['a@b.example\r\nBcc: x@evil.example', 'a@b.example, c@d.example', '"a"@b.example', 'A <a@b.example>', 'a@localhost', 'a..b@c.example', 'あ@b.example']) {
      expect(normalizeEmail(bad)).toBeNull()
    }
    expect(normalizeEmail(' Suzuki@A-Corp.example ')).toBe('suzuki@a-corp.example')
  })

  it('a subject with a line break, an empty body or a repeated recipient is refused', () => {
    expect(mailContentProblems({ ...MAIL, subject: 'お礼\r\nBcc: x@evil.example' })).toContain('件名に改行や使えない文字が入っています')
    expect(mailContentProblems({ ...MAIL, body: '  ' })).toContain('本文を書いてください')
    expect(mailContentProblems({ ...MAIL, cc: ['suzuki@a-corp.example'] })).toContain('同じ宛先が2回入っています')
    expect(mailContentProblems(MAIL)).toEqual([])
  })

  it('links in the body are counted for the card', () => {
    expect(countLinks('資料：https://example.com/a と http://x.example/b?c=1')).toBe(2)
  })
})

describe('quotes from minutes', () => {
  it('a quote counts only when it is in the text (spacing aside)', () => {
    const text = '鈴木様：チャット窓口も\n最初から入れたいです。\n金額は150万円で調整します。'
    expect(quoteAppearsIn(text, 'チャット窓口も 最初から入れたい')).toBe(true)
    expect(quoteAppearsIn(text, '金額は0円で調整します')).toBe(false)
  })
})
