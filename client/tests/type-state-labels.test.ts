// A company's own type names its states (`state_labels`, owner decision 2026-11-24): members never
// see `planning` / `open` / `held`. One rule (`stateWord`), used wherever a record's state is shown:
// the record card's header and its linked rows, 探す's rows, the records table's 状態, the summary of
// a record dropped on the chat, and the AI's action tools. A type without names keeps today's words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { parseTypeFile, type TypeDefinition } from '../../shared/core/record-types'
import type { RecordSummary } from '../../shared/types/records'
import { stateWord } from '../shared/thing-words'
import { findHitView, summaryView } from '../shared/record-views'
import { droppedRecordSummary } from '../shared/record-drop'
import { createRecordsTableApi } from '../electron/features/records-table/ipc'
import { actionToolSpecs } from '../electron/records/tools'

// The shape of the first real company type (クロチャレの回), with its states named.
const ROUND = `---
label: クロチャレの回
version: 2
storage: server
fields:
  day1: { label: DAY1（開催日）, kind: date, source: server }
states: [planning, open, held, cancelled]
state_labels: { planning: 準備中, open: 受付中, held: 開催済み, cancelled: やめた回 }
initial: planning
final: [held, cancelled]
actions:
  open_entry: { label: 受付を始めた, from: [planning], to: open, who: [anyone, ai], note: optional, history_line: true }
  mark_held:  { label: 開催した, from: [open], to: held, who: [anyone, ai], note: optional, history_line: true }
---
`
function round(text = ROUND): TypeDefinition {
  const r = parseTypeFile('crochallenge_round', text)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.definition
}
const unnamed = () => round(ROUND.replace(/^state_labels: .*\n/m, ''))
const rec = (state: string, over: Partial<RecordSummary> = {}): RecordSummary => ({
  id: 'crochallenge_round-0001ab', type: 'crochallenge_round', typeVersion: 2, title: '12/3回', summary: '', path: null, state,
  fields: {}, version: 1, updatedAt: '2026-11-24T00:00:00Z', ...over,
})

test('a state is shown by the type\'s own name; without one, as before (the core\'s words, else as it is)', () => {
  const def = round()
  assert.equal(stateWord('planning', def.name, def.stateLabels), '準備中')
  assert.equal(stateWord('open', def.name, def.stateLabels), '受付中')
  // The type's name wins over the core's shared word for the same state.
  assert.equal(stateWord('cancelled', def.name, def.stateLabels), 'やめた回')
  const plain = unnamed()
  assert.equal(stateWord('planning', plain.name, plain.stateLabels), 'planning')
  assert.equal(stateWord('cancelled', plain.name, plain.stateLabels), 'やめた（しまった）')
  assert.equal(stateWord('review', 'task', undefined), '確かめてもらっている')
  // Only the type's own names count: a state called like an object's built-in is not "named".
  assert.equal(stateWord('constructor', def.name, def.stateLabels), 'constructor')
})

test('the record card, its linked rows and 探す show the named state', () => {
  const def = round()
  assert.equal(summaryView(rec('open'), def).stateLabel, '受付中')
  assert.equal(findHitView({ record: rec('held'), department: null, mine: false } as never, def).record.stateLabel, '開催済み')
  assert.equal(summaryView(rec('open'), unnamed()).stateLabel, 'open', 'a type without names: unchanged')
})

test('the records table\'s 状態 column shows the named state', async () => {
  const def = round()
  const fetch = (async (url: string) => {
    const path = new URL(url).pathname
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path.endsWith('/records/types')) return json({ data: { types: [...coreTypeDefinitions(), def].map(d => ({ definition: d, source: 'file', versions: [d.version] })) } })
    if (path.endsWith('/members')) return json({ data: [] })
    if (path.endsWith('/records/query')) return json({ data: { total: 2, records: [rec('planning'), rec('held', { id: 'crochallenge_round-0002cd' })] } })
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  const api = createRecordsTableApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, log: { warn: () => {} } })
  const page = await api.page('c1', { kind: 'crochallenge_round', openOnly: false, offset: 0 })
  assert.ok(page.success)
  assert.deepEqual(page.rows.map(r => r.stateLabel), ['準備中', '開催済み'])
})

test('a record dropped on the chat is summarised with its named state, and so are the records linked to it', () => {
  const def = round()
  const types = new Map([...coreTypeDefinitions(), def].map(t => [t.name, t]))
  const task = { ...rec('todo'), id: 'task-0003ef', type: 'task', title: '告知を出す' }
  const text = droppedRecordSummary({ record: rec('planning'), links: [{ name: 'related', direction: 'in', record: task }] }, types)
  assert.match(text, /状態：準備中/)
  const fromTask = droppedRecordSummary({ record: task, links: [{ name: 'related', direction: 'out', record: rec('open') }] }, types)
  assert.match(fromTask, /『12\/3回』（crochallenge_round-0001ab・受付中）/)
})

test('the AI\'s action tool names the states it moves between, and says to use the names with the member', () => {
  const tool = actionToolSpecs([round()]).find(s => s.name === 'crochallenge_round__open_entry')!
  assert.match(tool.description, /準備中（planning） → 受付中（open）/)
  assert.match(tool.description, /メンバーには状態を表示名で言う/)
  const plain = actionToolSpecs([unnamed()]).find(s => s.name === 'crochallenge_round__open_entry')!
  assert.match(plain.description, /（planning → open）/)
  assert.doesNotMatch(plain.description, /表示名/)
})
