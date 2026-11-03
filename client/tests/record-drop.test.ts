// A record dropped on a consultation's input (record-drop.ts): the AI gets a compact summary of it
// once — enough to answer without calling records_get — and only with the message it was dropped for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { RecordDetail, RecordSummary } from '../../shared/types/records'
import { droppedRecordIdsOf, droppedRecordSummary, droppedRecordsContext, readDroppedRecords, withTextBeforeLatestUserMessage } from '../shared/record-drop'

const TYPES = new Map(coreTypeDefinitions().map(t => [t.name, t]))
const rec = (over: Partial<RecordSummary>): RecordSummary => ({
  id: 'task-0001ab', type: 'task', typeVersion: 12, title: '見積を直す', summary: '', path: null, state: 'in_progress',
  fields: {}, version: 3, updatedAt: '2026-11-03T10:00:00Z', ...over,
})

// What the owner asked the summary to carry: title, kind, state, whose turn, due, and its links
// (files, consultations, まとまり, 相手) — so the AI can answer about it straight away.
test('a dropped やること is summarised with its state, whose turn, due and links', () => {
  const detail: RecordDetail & { people: Record<string, string> } = {
    record: rec({ fields: { assignee: 'u-sato', requested_by: 'u-abe', due: '2026-11-07' }, summary: 'A社向けの見積を10月の単価で直す' }),
    links: [
      { name: 'files', direction: 'out', path: '営業部/見積/A社.xlsx' },
      { name: 'files', direction: 'out', path: '営業部/古い.md', broken: true },
      { name: 'bundle', direction: 'out', record: rec({ id: 'project-0002cd', type: 'project', title: 'A社の更新', state: 'active' }) },
      { name: 'counterpart', direction: 'out', record: rec({ id: 'customer-0003ef', type: 'customer', title: '株式会社A', state: null }) },
      { name: 'related', direction: 'out', record: rec({ id: 'decision-0004gh', type: 'decision', title: '値引きは5%まで', state: 'confirmed' }) },
    ],
    people: { 'u-sato': '佐藤', 'u-abe': '阿部' },
  }
  const text = droppedRecordSummary(detail, TYPES, ['見積の相談'])
  assert.match(text, /やること『見積を直す』（task-0001ab）/)
  assert.match(text, /状態：進めている/)
  assert.match(text, /番：佐藤さんの番/)
  assert.match(text, /期限 2026-11-07/)
  assert.match(text, /担当 佐藤/)
  assert.match(text, /要約：A社向けの見積/)
  assert.match(text, /つながったファイル：営業部\/見積\/A社\.xlsx、営業部\/古い\.md（つながりが切れています）/)
  assert.match(text, /まとまり：プロジェクト『A社の更新』/)
  assert.match(text, /相手：『株式会社A』/)
  assert.match(text, /つながっている記録：.*決めたこと『値引きは5%まで』/)
  assert.match(text, /相談：「見積の相談」/)
  // A person id never stands in for a name.
  assert.doesNotMatch(text, /u-sato/)
})

test('a waiting or finished やること says so instead of a person', () => {
  assert.match(droppedRecordSummary({ record: rec({ state: 'waiting', fields: { waiting_on: '先方の返事' } }), links: [] }, TYPES), /番：返事待ち（先方の返事）/)
  assert.doesNotMatch(droppedRecordSummary({ record: rec({ state: 'done' }), links: [] }, TYPES), /番：/)
})

// The AI is told the summary comes once and to dig with records_get later; nothing readable → nothing sent.
test('the context names itself as a one-time summary and is absent when nothing could be read', () => {
  const ctx = droppedRecordsContext([null, '■ やること『見積を直す』'])!
  assert.match(ctx, /1回だけ/)
  assert.match(ctx, /records_get/)
  assert.match(ctx, /■ やること『見積を直す』/)
  assert.equal(droppedRecordsContext([null, null]), null)
  assert.equal(droppedRecordsContext([]), null)
})

// A request carries record ids only: anything else would be put into a server path.
test('a request\'s dropped records are well-formed ids, once each, at most five', () => {
  assert.deepEqual(droppedRecordIdsOf(['task-0001ab', 'task-0001ab', '../x', 7, 'deal-0002cd']), ['task-0001ab', 'deal-0002cd'])
  assert.deepEqual(droppedRecordIdsOf('task-0001ab'), [])
  assert.equal(droppedRecordIdsOf(Array.from({ length: 9 }, (_, i) => `task-00000${i}`)).length, 5)
  assert.deepEqual(readDroppedRecords([{ id: 'task-0001ab', title: 'a', word: 'やること' }, { id: 'bad', title: 'b', word: 'x' }]), [{ id: 'task-0001ab', title: 'a', word: 'やること' }])
})

// Only the message it was dropped for carries it: earlier user messages (sent again on a fresh
// session) must not get it, or the AI would read it as said every turn.
test('the summary goes into the latest user message only, before the member\'s words', () => {
  const messages = [
    { role: 'user', content: '前の質問' },
    { role: 'assistant', content: '前の答え' },
    { role: 'user', content: [{ type: 'text', text: 'これはいつまで？' }] },
  ]
  const out = withTextBeforeLatestUserMessage(messages, 'SUMMARY')
  assert.equal(out[0].content, '前の質問')
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'SUMMARY' }, { type: 'text', text: 'これはいつまで？' }])
  assert.deepEqual(messages[2].content, [{ type: 'text', text: 'これはいつまで？' }], 'the input is not changed')
})
