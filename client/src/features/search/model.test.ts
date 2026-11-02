// 探す's kind chips (model.ts). Guards: a chip only for a kind that has something (an empty chip
// leads nowhere); bundles found across departments are named by the kinds found, never 「まとまり」;
// what the member does reads as one やること chip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordViewSummary } from '../../../shared/record-views'
import { chipOf, findChips, paletteItems } from './model'

const rec = (id: string, thing: RecordViewSummary['thing'], typeLabel: string): RecordViewSummary =>
  ({ id, type: id.split('-')[0], typeLabel, kind: 'other', title: id, summary: '', stateLabel: null, updatedAt: '', thing })

test('only kinds with something get a chip, in a fixed order, with counts', () => {
  const chips = findChips([rec('decision-a', 'decision', '決めたこと'), rec('task-a', 'task', 'やること'), rec('task-b', 'minutes_check', '議事録を確認する')], 2)
  assert.deepEqual(chips.map(c => [c.id, c.label, c.count]), [['task', 'やること', 2], ['decision', '決めたこと', 1], ['file', 'ファイル', 2]])
  assert.deepEqual(findChips([], 0), [])
})

test('bundles of mixed kinds are named by the kinds found; drafts alone read as drafts', () => {
  const chips = findChips([rec('deal-a', 'bundle', '案件'), rec('project-a', 'bundle', 'プロジェクト'), rec('outbound_message-a', 'outbound', '送るメールの下書き')], 0)
  assert.deepEqual(chips.map(c => c.label), ['案件・プロジェクト', '送るメールの下書き'])
  assert.ok(!chips.some(c => c.label.includes('まとまり')))
  assert.equal(chipOf(rec('reply_request-a', 'reply_request', '返事のお願い')), 'task')
})

test('⌘K: nothing typed lists the open tabs; typed, the records found first, then files by name (A–Z folded), capped', () => {
  const recent = [{ key: 'acb-record:task-a', recordId: 'task-a', record: { type: 'task', title: '見積を直す' } }, { key: '/r/営業/a.md', path: '営業/a.md' }]
  assert.deepEqual(paletteItems('', ['営業/a.md'], [], recent).map(i => [i.title, i.kindName]), [['見積を直す', 'やること'], ['a.md', 'ファイル']])
  const files = ['営業/Proposal.md', '営業/memo.md', ...Array.from({ length: 40 }, (_, i) => `x/proposal${i}.md`)]
  const items = paletteItems('PROPOSAL', files, [rec('deal-a', 'bundle', '案件')], [])
  assert.equal(items[0].recordId, 'deal-a')
  assert.equal(items[1].path, '営業/Proposal.md')
  assert.ok(!items.some(i => i.path === '営業/memo.md'))
  assert.equal(items.filter(i => i.path).length, 30)
})
