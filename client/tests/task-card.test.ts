// The task card (client/shared/task-card.ts, electron/features/tasks/ipc.ts, tasks-ui.md "The
// card"). Guards: the assignee completes only by saying whose OK it was (and from 未着手 by
// starting first), the requester completes plainly; the AI's own steps and what the member's
// place does not allow are never offered (the requester cannot 「受けられない」); the OK reads
// as "A さんが B さんの了承を得たとして完了" — never as an approval; what the AI prepared is apart
// from the other links; a run with an unknown outside result offers reconciling, not 「もう一度」;
// a run id or operation key that could reshape the URL never reaches the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { LedgerEntry } from '../../shared/core/record-ledger'
import type { AiRunView } from '../../shared/types/ai-runs'
import type { RecordDetail, RecordSummary } from '../../shared/types/records'
import { taskCardOf, type TaskCardSources } from '../shared/task-card'
import { createTasksApi } from '../electron/features/tasks/ipc'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const ME = 'u-sato'
const BOSS = 'u-abe'
const people = { [ME]: '佐藤', [BOSS]: '阿部', 'u-tanaka': '田中' }

function task(state: string, fields: Record<string, string | null>): RecordSummary {
  return { id: 'task-0000aa', type: 'task', typeVersion: 7, title: '見積書', summary: '', path: null, state, fields, version: 4, updatedAt: '2026-11-05T01:00:00.000Z' }
}
function card(record: RecordSummary, over: Partial<TaskCardSources> = {}) {
  const detail: RecordDetail = { record, links: [] }
  return taskCardOf({ me: ME, detail, def: defs.get('task'), defs, entries: [], people, runs: [], ...over })
}
const offered = (c: ReturnType<typeof card>) => Object.fromEntries(c.actions.map(a => [a.action, { needsOk: a.needsOk, startFirst: a.startFirst }]))

test('the assignee completes by saying whose OK it was (starting first from 未着手); the requester completes plainly', () => {
  const asAssignee = offered(card(task('todo', { assignee: ME, requested_by: BOSS })))
  assert.deepEqual(asAssignee.complete, { needsOk: true, startFirst: true })
  assert.equal(asAssignee.decline !== undefined, true)
  const started = offered(card(task('in_progress', { assignee: ME, requested_by: BOSS })))
  assert.deepEqual(started.complete, { needsOk: true, startFirst: false })
  const asRequester = offered(card(task('in_progress', { assignee: 'u-tanaka', requested_by: ME })))
  assert.deepEqual(asRequester.complete, { needsOk: false, startFirst: false })
  assert.equal(asRequester.decline, undefined)
  assert.equal(asRequester.start, undefined)
})

test('the AI\'s own steps are never offered; 引き受ける only to the assignee', () => {
  const preparing = offered(card(task('preparing', { assignee: ME, requested_by: BOSS })))
  assert.equal(preparing.finish_prep, undefined)
  assert.equal(preparing.hand_over, undefined)
  assert.ok(preparing.take_over)
  assert.ok(offered(card(task('awaiting_acceptance', { assignee: ME, requested_by: BOSS }))).accept)
  assert.equal(offered(card(task('awaiting_acceptance', { assignee: 'u-tanaka', requested_by: ME }))).accept, undefined)
})

test('an OK reads as 「A さんが B さんの了承を得たとして完了」, in the card and in 経緯', () => {
  const entries = [{ version: 5, action: 'complete', actorId: ME, actorKind: 'human', at: '2026-11-05T02:00:00.000Z', note: '', fromState: 'in_progress', toState: 'done',
    changes: [{ field: 'ok_by', before: null, after: BOSS }, { field: 'ok_note', before: null, after: '口頭で' }] }] as unknown as LedgerEntry[]
  const c = card(task('done', { assignee: ME, requested_by: BOSS, ok_by: BOSS, ok_note: '口頭で' }), { entries })
  assert.equal(c.okLine, '佐藤さんが阿部さんの了承を得たとして完了にしました（口頭で）')
  assert.equal(c.history[0].text, '佐藤さんが阿部さんの了承を得たとして完了にしました（口頭で）')
  assert.ok(!JSON.stringify(c).includes('承認'))
})

test('what the AI prepared is apart from the other links; a run with an unknown result offers reconciling only', () => {
  const draft: RecordSummary = { ...task('draft', {}), id: 'outbound_message-01', type: 'outbound_message', title: 'お礼メール' }
  const bundle: RecordSummary = { ...task('open', {}), id: 'deal-0001ab', type: 'deal', title: 'A社' }
  const detail: RecordDetail = {
    record: task('todo', { assignee: ME, requested_by: BOSS }),
    links: [{ name: 'prepared', direction: 'out', record: draft }, { name: 'bundle', direction: 'out', record: bundle }, { name: 'files', direction: 'out', path: '営業/見積.xlsx', broken: false }],
  }
  const runs = [{ id: 'run-1', recordId: 'task-0000aa', needsPerson: true, label: '外への操作の結果が分かりません', operations: [{ key: 'mail-send-1', kind: 'outbound', state: 'unknown', ref: null, updatedAt: '' }] }] as unknown as AiRunView[]
  const c = taskCardOf({ me: ME, detail, def: defs.get('task'), defs, entries: [], people, runs })
  assert.deepEqual(c.prepared.map(p => p.id), ['outbound_message-01'])
  assert.deepEqual(c.links.map(l => l.record?.id), ['deal-0001ab'])
  assert.deepEqual(c.files, [{ path: '営業/見積.xlsx', broken: false }])
  assert.deepEqual(c.runs, [{ runId: 'run-1', label: '外への操作の結果が分かりません', canRetry: false, unknown: [{ key: 'mail-send-1', kind: 'outbound' }] }])
})

test('a run id or operation key that could reshape the URL never reaches the server', async () => {
  let calls = 0
  const api = createTasksApi({ baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} }, fetch: (async () => { calls++; return new Response('{}') }) as unknown as typeof fetch })
  assert.equal((await api.retryRun('co1', '../records')).success, false)
  assert.equal((await api.reconcile('co1', 'run-1', '..', true)).success, false)
  assert.equal((await api.reconcile('co1', 'run-1', 'a/b', true)).success, false)
  assert.equal(calls, 0)
})

test('「タグの候補」 adds tags only where the member may set them: requester or assignee, not a finished task', () => {
  assert.equal(card(task('todo', { assignee: ME, requested_by: BOSS })).canSetTags, true)
  assert.equal(card(task('in_progress', { assignee: 'u-tanaka', requested_by: ME })).canSetTags, true)
  assert.equal(card(task('todo', { assignee: 'u-tanaka', requested_by: BOSS })).canSetTags, false)
  assert.equal(card(task('done', { assignee: ME, requested_by: BOSS })).canSetTags, false)
})
