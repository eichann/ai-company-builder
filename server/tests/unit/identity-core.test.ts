/**
 * The keys a 相手 is matched by (shared/core/identity.ts, identity.md).
 *
 * Guards:
 * - a free-mail domain (and its subdomains) is never a company's domain,
 *   however it is written;
 * - a proposal body never carries control characters or an unbounded reason.
 */
import { describe, expect, it } from 'vitest'
import { companyDomainOfAddress, identityKeysOf, IDENTITY_REASON_MAX, readIdentityProposal } from '../../../shared/core/identity'

describe('free-mail domains', () => {
  it('are never a company domain, however written', () => {
    for (const domain of ['gmail.com', 'GMAIL.COM', '@gmail.com', 'www.gmail.com', 'gmail.com.', 'docomo.ne.jp', 'mail.yahoo.co.jp', 'icloud.com']) {
      expect(identityKeysOf({ counterpart_kind: 'company', domain }).domain, domain).toBeNull()
    }
    expect(identityKeysOf({ counterpart_kind: 'company', email: 'shop@outlook.jp' }).domain).toBeNull()
    expect(companyDomainOfAddress('a@softbank.ne.jp')).toBeNull()
  })

  it('a company’s own domain is kept, normalized; a look-alike of a free-mail domain is not free mail', () => {
    expect(identityKeysOf({ counterpart_kind: 'company', domain: ' WWW.A-Corp.example ' }).domain).toBe('a-corp.example')
    expect(identityKeysOf({ counterpart_kind: 'company', domain: 'notgmail.com' }).domain).toBe('notgmail.com')
    expect(companyDomainOfAddress('x@a-corp.example')).toBe('a-corp.example')
  })
})

describe('proposal bodies', () => {
  it('strip control characters and refuse an overlong reason', () => {
    const r = readIdentityProposal({ a: 'customer-aaaaaaaa', b: 'customer-bbbbbbbb', reason: '同じ\n会社\u0007です' })
    expect(r).toMatchObject({ reason: '同じ 会社 です', confidence: null })
    expect(typeof readIdentityProposal({ a: 'customer-aaaaaaaa', b: 'customer-bbbbbbbb', reason: 'あ'.repeat(IDENTITY_REASON_MAX + 1) })).toBe('string')
    expect(typeof readIdentityProposal({ a: 'customer-aaaaaaaa', b: 'customer-aaaaaaaa', reason: 'x' })).toBe('string')
    expect(typeof readIdentityProposal({ a: '../etc', b: 'customer-aaaaaaaa', reason: 'x' })).toBe('string')
  })
})
