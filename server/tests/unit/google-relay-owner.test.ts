/**
 * Unit Test: who owns a sheet the relay writes into (`sheetOwnership`, shared/core/google-relay.ts;
 * B-H1, owner decision 2026-11-04 「会社の Workspace の中の表だけに書ける」). Only an owner of the
 * company's own domain passes; anything Drive leaves unclear is outside (fail closed).
 */
import { describe, expect, it } from 'vitest'
import { sheetOwnership } from '../../../shared/core/google-relay'

const owners = (...emails: unknown[]) => ({ owners: emails.map(emailAddress => ({ emailAddress })) })

describe('sheetOwnership', () => {
  it('inside only when every owner is an account of the company domain (letters\' case aside)', () => {
    expect(sheetOwnership(owners('sato@div.example'), 'div.example')).toBe('inside')
    expect(sheetOwnership(owners('Sato@DIV.Example'), 'div.example')).toBe('inside')
    expect(sheetOwnership(owners('sato@div.example'), 'DIV.example')).toBe('inside')
  })

  it('outside: another domain, a look-alike or sub-domain, a second outside owner', () => {
    expect(sheetOwnership(owners('suzuki@a-corp.example'), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('x@evil-div.example'), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('x@sub.div.example'), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('x@div.example.evil'), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('x@div.example@evil.example'), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('sato@div.example', 'x@a-corp.example'), 'div.example')).toBe('outside')
  })

  it('outside when Drive does not say: no owners, no address, a broken answer, no company domain', () => {
    expect(sheetOwnership({}, 'div.example')).toBe('outside')
    expect(sheetOwnership({ owners: [] }, 'div.example')).toBe('outside')
    expect(sheetOwnership({ owners: [{ displayName: 'Suzuki' }] }, 'div.example')).toBe('outside')
    expect(sheetOwnership(owners(42), 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('@div.example'), 'div.example')).toBe('outside')
    expect(sheetOwnership(null, 'div.example')).toBe('outside')
    expect(sheetOwnership([owners('sato@div.example')], 'div.example')).toBe('outside')
    expect(sheetOwnership(owners('sato@div.example'), '')).toBe('outside')
  })

  it('a shared drive is its own answer (Drive names no owner there), whatever owners claim', () => {
    expect(sheetOwnership({ driveId: '0AB' }, 'div.example')).toBe('shared-drive')
    expect(sheetOwnership({ driveId: '0AB', ...owners('sato@div.example') }, 'div.example')).toBe('shared-drive')
  })
})
