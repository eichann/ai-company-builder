import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MyBrokerService } from '../../../shared/broker-keys'
import { ownKeyRow } from './own-keys'

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

test('会社優先: the company key where it applies, the own key elsewhere', () => {
  const row = ownKeyRow({ ...base, key: own, companyKeys: [{ displayName: 'x', allDepartments: false, departments: ['営業部'] }] })
  assert.equal(row.status, '会社の鍵')
  assert.match(row.detail, /営業部での相談で、会社の鍵を使います。それ以外では自分の鍵を使います。/)
  assert.equal(ownKeyRow({ ...base, key: own }).status, '自分の鍵（末尾 wxyz）')
})
