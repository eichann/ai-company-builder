// The card's tag editor rules (tagEditor.ts). Guards: a word spelled like a tag in use is added
// as that tag (no 「ｴｲｷﾞｮｳ」 next to 「エイギョウ」); typing offers the tags in use containing it,
// most used first, without the task's own; the server's limits are said before anything is sent;
// the hint names a bundle only when the typed word is its whole name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleNamed, tagCandidates, tagToAdd } from './tagEditor'

const inUse = ['営業', '営業部', '見積', 'エイギョウ']

test('typing offers the tags in use that contain it (loosely spelled), most used first, never one the task has', () => {
  assert.deepEqual(tagCandidates('営業', [], inUse), ['営業', '営業部'])
  assert.deepEqual(tagCandidates('営業', ['営業'], inUse), ['営業部'])
  assert.deepEqual(tagCandidates('ｴｲｷﾞｮｳ', [], inUse), ['エイギョウ'])
  assert.deepEqual(tagCandidates('', ['見積'], inUse), ['営業', '営業部', 'エイギョウ'])
})

test('a word spelled like a tag in use is added as that tag; a new word only as typed, normalized', () => {
  assert.deepEqual(tagToAdd('ｴｲｷﾞｮｳ', ['見積'], inUse), { kind: 'add', tags: ['見積', 'エイギョウ'], tag: 'エイギョウ' })
  assert.deepEqual(tagToAdd('  社内　 研修 ', [], inUse), { kind: 'add', tags: ['社内 研修'], tag: '社内 研修' })
  assert.equal(tagToAdd('   ', [], inUse), null)
})

test('the server\'s limits are said in words before anything is sent: length, count, already there', () => {
  assert.equal(tagToAdd('あ'.repeat(41), [], inUse)?.kind, 'refused')
  assert.equal(tagToAdd('新しい', Array.from({ length: 20 }, (_, i) => `t${i}`), inUse)?.kind, 'refused')
  assert.deepEqual(tagToAdd('えいぎょう', ['エイギョウ'], inUse), { kind: 'refused', reason: '#エイギョウ はもう付いています' })
})

test('the 案件 hint: only a bundle whose whole name is the typed word', () => {
  const bundles = [{ id: 'deal-a00001', title: 'A社 研修導入', typeLabel: '案件' }]
  assert.equal(bundleNamed('A社  研修導入', bundles)?.id, 'deal-a00001')
  assert.equal(bundleNamed('A社', bundles), null)
})
