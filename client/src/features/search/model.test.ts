// 探す's kind chips (model.ts). Guards: a chip only for a kind that has something (an empty chip
// leads nowhere); bundles found across departments are named by the kinds found, never 「まとまり」;
// what the member does reads as one やること chip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RecordViewSummary } from '../../../shared/record-views'
import { chipOf, findChips } from './model'

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
