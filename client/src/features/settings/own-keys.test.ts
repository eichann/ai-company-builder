import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyBrokerService } from '../../../shared/broker-keys'
import { envKeysToMove, ownKeyRow } from './own-keys'

const base: MyBrokerService = {
  service: 'openai', label: 'OpenAI', category: 'tool', rule: 'company-first',
  ownKey: { allowed: true, hosts: ['api.openai.com'] }, companyKeys: [], key: null,
}
const own = { id: 'k', displayName: '私の鍵', last4: 'wxyz', hosts: ['api.openai.com'], status: 'active' as const, secretUpdatedAt: '' }

test('the page never promises a key the server would not use', () => {
  // 会社の鍵だけ: an own key left over from before is not used.
  const companyOnly = ownKeyRow({ ...base, rule: 'company-only', ownKey: { allowed: false, reason: 'company-only' }, key: own })
  assert.equal(companyOnly.status, '自分の鍵（使われません）')
  assert.equal(companyOnly.canRegister, false)
  // 自分の鍵だけ: a company key the member may use is not used.
  assert.equal(ownKeyRow({ ...base, rule: 'user-only', companyKeys: [{ displayName: 'x', allDepartments: true, departments: [] }] }).status, '未設定')
  // A key an admin stopped is not used.
  assert.equal(ownKeyRow({ ...base, key: { ...own, status: 'disabled' } }).tone, 'warn')
})

test('a key in the .env is offered for moving only where the server would take it as one\'s own key', () => {
  const env = { OPENAI_API_KEY: { set: true, last4: 'abcd' }, GOOGLE_API_KEY: { set: true, last4: 'efgh' }, ANTHROPIC_API_KEY: { set: false }, CUSTOM: { set: true } }
  const data = {
    enabled: true, memberKeysAllowed: true,
    services: [base, { ...base, service: 'gemini', label: 'Google Gemini', rule: 'company-only' as const, ownKey: { allowed: false as const, reason: 'company-only' as const } }],
  }
  const rows = envKeysToMove(env, data)
  // Only built-in services' names that are set; nothing else in the .env is touched.
  assert.deepEqual(rows.map(r => [r.name, r.service, r.canMove]), [['OPENAI_API_KEY', 'openai', true], ['GOOGLE_API_KEY', 'gemini', false]])
  assert.match(rows[1].note, /会社の鍵だけを使う設定です。移したいときは管理者に頼んでください。/)
  // Offline or the broker off: nothing can be moved.
  assert.ok(envKeysToMove(env, null).every(r => !r.canMove))
  assert.ok(envKeysToMove(env, { ...data, enabled: false }).every(r => !r.canMove))
})

test('会社優先: the company key where it applies, the own key elsewhere', () => {
  const row = ownKeyRow({ ...base, key: own, companyKeys: [{ displayName: 'x', allDepartments: false, departments: ['営業部'] }] })
  assert.equal(row.status, '会社の鍵')
  assert.match(row.detail, /営業部での相談で、会社の鍵を使います。それ以外では自分の鍵を使います。/)
  assert.equal(ownKeyRow({ ...base, key: own }).status, '自分の鍵（末尾 wxyz）')
})
