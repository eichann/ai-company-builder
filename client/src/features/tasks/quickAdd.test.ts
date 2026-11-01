// The one-line add (quickAdd.ts). Guards: what the member typed becomes the title, a due in
// company time and tags — nothing they typed is dropped when a word is not understood; a tag
// spelled differently from one in use is caught (so the list does not split into near twins).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyNow } from './model'
import { parseQuickAdd, similarTag, tagChoices } from './quickAdd'

// Thursday 2026-11-05 15:45 in Japan.
const NOW = companyNow(Date.parse('2026-11-05T06:45:00.000Z'))

test('title, due with a time and tags from one line', () => {
  assert.deepEqual(parseQuickAdd('見積を直す 明日15時まで #営業', NOW), { title: '見積を直す', due: '2026-11-06T15:00', tags: ['営業'] })
  assert.deepEqual(parseQuickAdd('請求書 11/20 #経理 #月末', NOW), { title: '請求書', due: '2026-11-20', tags: ['経理', '月末'] })
  assert.deepEqual(parseQuickAdd('資料を送る 今日中', NOW), { title: '資料を送る', due: '2026-11-05', tags: [] })
  assert.deepEqual(parseQuickAdd('研修の準備 来週', NOW).due, '2026-11-09')
  assert.deepEqual(parseQuickAdd('電話 月曜 10:30', NOW).due, '2026-11-09T10:30')
  assert.deepEqual(parseQuickAdd('年賀状 1/10', NOW).due, '2027-01-10')
})

test('words it does not understand stay in the title', () => {
  assert.deepEqual(parseQuickAdd('競合の価格を調べる', NOW), { title: '競合の価格を調べる', due: null, tags: [] })
  assert.equal(parseQuickAdd('13/40 の件', NOW).due, null)
})

test('a tag in use spelled differently is offered; one in use as typed is not', () => {
  assert.equal(similarTag('ｴｲｷﾞｮｳ', ['エイギョウ', '経理']), 'エイギョウ')
  assert.equal(similarTag('sales', ['Sales']), 'Sales')
  assert.equal(similarTag('経理', ['経理']), null)
  assert.equal(similarTag('新しい', ['経理']), null)
  assert.deepEqual(tagChoices('見積 #え', ['営業', 'えいが', 'エイ']), ['えいが', 'エイ'])
  assert.equal(tagChoices('見積', ['営業']), null)
})
