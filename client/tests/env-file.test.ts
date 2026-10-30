import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEnvChanges, envChangeRefusal, envStatus, parseEnvFile } from '../shared/env-file'

test('parse: comments, blanks, quotes, a later line wins', () => {
  assert.deepEqual(parseEnvFile('# c\n\nA=1\n B = "two words" \nC=\'q\'\nnoequals\n=empty\nD=x=y\nA=2\n'), { A: '2', B: 'two words', C: 'q', D: 'x=y' })
})

test('status: set and last four only for long values; never the value', () => {
  const status = envStatus('LONG=FAKE-value-abcd1234\nSHORT=pin1\nEMPTY=\n')
  assert.deepEqual(status, { LONG: { set: true, last4: '1234' }, SHORT: { set: true }, EMPTY: { set: false } })
  assert.ok(!JSON.stringify(status).includes('pin1'))
})

test('apply: replaces in place, keeps comments and other lines, removes, appends', () => {
  const before = '# keys\nA=old\nB=keep\nA=dup\nC=gone\n'
  assert.equal(applyEnvChanges(before, { A: 'new', C: null, D: 'a b', E: 'say "hi"' }),
    '# keys\nA=new\nB=keep\nD="a b"\nE=\'say "hi"\'\n')
  assert.equal(applyEnvChanges('', { A: '' }), '')
  assert.equal(applyEnvChanges('A=1', { A: null }), '')
  assert.deepEqual(parseEnvFile(applyEnvChanges('', { H: 'a#b', Q: "it's" })), { H: 'a#b', Q: "it's" })
})

test('refusal: bad names, line breaks, non-strings', () => {
  assert.equal(envChangeRefusal({ OK_1: 'v', GONE: null }), null)
  assert.match(envChangeRefusal({ '1A': 'v' }) ?? '', /名前に使えません/)
  assert.match(envChangeRefusal({ 'A=B': 'v' }) ?? '', /名前に使えません/)
  assert.match(envChangeRefusal({ A: 'x\nB=injected' }) ?? '', /改行/)
  assert.match(envChangeRefusal({ A: 5 as unknown as string }) ?? '', /読み取れません/)
})
