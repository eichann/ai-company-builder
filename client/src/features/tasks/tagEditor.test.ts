// The card's tag editor rules (tagEditor.ts). Guards: a word spelled like a tag in use is added
// as that tag (no 「ｴｲｷﾞｮｳ」 next to 「エイギョウ」); typing offers the tags in use containing it,
// most used first, without the task's own; the server's limits are said before anything is sent;
// the hint names a bundle only when the typed word is its whole name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleNamed, newTagOffer, tagOptions, tagToAdd } from './tagEditor'

const inUse = ['営業', '営業部', '見積', 'エイギョウ']
const rows = (o: ReturnType<typeof tagOptions>) => o.map(x => `${x.selected ? '✓' : ''}${x.tag}`)

test('the popover lists the task\'s tags (checked) and the tags in use containing what is typed, each once, the exact spelling first', () => {
  assert.deepEqual(rows(tagOptions('', ['見積'], inUse)), ['✓見積', '営業', '営業部', 'エイギョウ'])
  assert.deepEqual(rows(tagOptions('営業', ['営業'], inUse)), ['✓営業', '営業部'])
  // Loosely spelled: 「ｴｲｷﾞｮｳ」 finds エイギョウ; 「部」 only 営業部.
  assert.deepEqual(rows(tagOptions('ｴｲｷﾞｮｳ', [], inUse)), ['エイギョウ'])
  assert.deepEqual(rows(tagOptions('部', [], inUse)), ['営業部'])
  // The exact word first, so Enter picks it rather than a longer tag.
  assert.deepEqual(rows(tagOptions('営業', [], ['営業部', '営業'])), ['営業', '営業部'])
})

test('「『〇〇』を作る」 only when no row is that word already (loosely)', () => {
  assert.equal(newTagOffer('急ぎ', tagOptions('急ぎ', [], inUse)), '急ぎ')
  assert.equal(newTagOffer('えいぎょう', tagOptions('えいぎょう', [], inUse)), null)
  assert.equal(newTagOffer('営', tagOptions('営', [], inUse)), '営')
  assert.equal(newTagOffer('  ', tagOptions('', [], inUse)), null)
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
