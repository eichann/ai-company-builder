/**
 * Unit Test: the company creation policy (services/company-creation-policy.ts).
 *
 * Guards: a server with no setting runs the `operator` policy (only server
 * operators create companies), and a server configured with a mode that does
 * not exist yet (`approved`, `self_serve`) or a typo refuses to start instead
 * of running with a rule nobody chose.
 */
import { describe, it, expect } from 'vitest'
import { parseCompanyCreationPolicy } from '../../src/services/company-creation-policy'

describe('COMPANY_CREATION_POLICY', () => {
  it('unset or empty means operator-only', () => {
    for (const raw of [undefined, null, '', '  ']) {
      expect(parseCompanyCreationPolicy(raw), String(raw)).toEqual({ ok: true, policy: 'operator' })
    }
    expect(parseCompanyCreationPolicy(' operator ')).toEqual({ ok: true, policy: 'operator' })
  })

  it('the modes not implemented yet, and unknown values, are refused', () => {
    for (const raw of ['approved', 'self_serve', 'open', 'Operator']) {
      const parsed = parseCompanyCreationPolicy(raw)
      expect(parsed.ok, raw).toBe(false)
    }
    const later = parseCompanyCreationPolicy('self_serve')
    expect(later.ok === false && later.error).toMatch(/not implemented/)
  })
})
