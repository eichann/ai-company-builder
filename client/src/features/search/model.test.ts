// 探す ⌘K (model.ts). Guards: what is listed with nothing typed and in which order, A–Z folding,
// caps per kind. The left tab's chips and rows: find.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordViewSummary } from '../../../shared/record-views'
import { paletteItems } from './model'

const rec = (id: string, thing: RecordViewSummary['thing'], typeLabel: string): RecordViewSummary =>
  ({ id, type: id.split('-')[0], typeLabel, kind: 'other', title: id, summary: '', stateLabel: null, updatedAt: '', thing })

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

test('⌘K: skills match by name or slash command and consultations by title, after the records and before the files', () => {
  const skills = [
    { id: 'company-weekly', name: '週報をまとめる', command: 'weekly-report', group: '全社' },
    { id: 'sales-proposal', name: '提案書のたたき台', command: 'proposal', group: '営業部' },
    { id: 'company-weekly', name: '週報をまとめる', command: 'weekly-report', group: '全社' },
  ]
  const consultations = [{ id: 's1', title: '週報の書き方' }, { id: 's2', title: '見積の相談' }]
  const items = paletteItems('週報', ['営業/週報.md'], [rec('task-a', 'task', 'やること')], [], { skills, consultations })
  assert.deepEqual(items.map(i => [i.title, i.kindName]), [['task-a', 'やること'], ['週報をまとめる', 'スキル'], ['週報の書き方', 'AIへの相談'], ['週報.md', 'ファイル']])
  assert.equal(items[1].skillId, 'company-weekly')
  assert.equal(items[1].detail, '全社')
  assert.equal(items[2].consultationId, 's1')
  assert.deepEqual(paletteItems('WEEKLY', [], [], [], { skills }).map(i => i.skillId), ['company-weekly'])
  // Nothing typed: still only what is open.
  assert.deepEqual(paletteItems('', [], [], [], { skills, consultations }), [])
})
