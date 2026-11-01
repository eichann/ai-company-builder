// The task list in main (electron/features/tasks/ipc.ts, client/shared/tasks.ts,
// .claude/rules/tasks-ui.md). Guards: each record is shown once and in the right place (a
// request the member must accept is not 「あなたの番」 work yet, a reply they wait for is not
// something to do now); only a task the member asked of themselves can be finished from the
// list; the one-line add makes a task only the member sees, assigned to them; an action name
// never reaches the server's URL as a path; records off is no list, not an error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTasksApi } from '../electron/features/tasks/ipc'
import { classifyTasks, type TaskSources } from '../shared/tasks'
import type { RecordSummary } from '../../shared/types/records'

const ME = 'u-me'
function rec(id: string, state: string, fields: Record<string, string | null> = {}, extra: Partial<RecordSummary> = {}): RecordSummary {
  return { id, type: 'task', typeVersion: 7, title: id, summary: '', path: null, state, fields: { assignee: ME, requested_by: ME, ...fields }, version: 3, updatedAt: '2026-11-05T01:00:00.000Z', ...extra }
}
const src = (over: Partial<TaskSources>): TaskSources => ({
  me: ME, myTurn: [], aiTurn: [], asked: [], doneToday: [], typeLabels: { task: 'タスク' }, people: { 'u-tanaka': '田中', [ME]: '佐藤' }, bundles: {}, ...over,
})

test('each record is placed once: 引き受け待ち, the member\'s turn, a reply waited for, the AI, others, today\'s done', () => {
  const items = classifyTasks(src({
    myTurn: [rec('task-acc001', 'awaiting_acceptance', { requested_by: 'u-tanaka' }), rec('task-todo01', 'todo'), rec('task-wait01', 'waiting', { waiting_on: '先方の見積' })],
    aiTurn: [rec('task-prep01', 'preparing'), rec('task-todo01', 'todo')],
    asked: [rec('task-ask001', 'in_progress', { assignee: 'u-tanaka' }), rec('task-ask002', 'awaiting_acceptance', { assignee: 'u-tanaka' }), rec('task-todo01', 'todo')],
    doneToday: [rec('task-done01', 'done')],
    bundles: { 'task-todo01': { id: 'project-abcdef', title: 'AI の仕組みづくり' } },
  }))
  const at = Object.fromEntries(items.map(i => [i.id, [i.turn, i.waitingFor]]))
  assert.equal(items.length, 7)
  assert.deepEqual(at['task-acc001'], ['acceptance', null])
  assert.deepEqual(at['task-todo01'], ['mine', null])
  assert.deepEqual(at['task-wait01'], ['others', '返事待ち：先方の見積'])
  assert.deepEqual(at['task-prep01'], ['ai', null])
  assert.deepEqual(at['task-ask001'], ['others', '田中さんの番'])
  assert.deepEqual(at['task-ask002'], ['others', '田中さんに頼んだ・引き受け待ち'])
  assert.deepEqual(at['task-done01'], ['done', null])
  assert.equal(items.find(i => i.id === 'task-todo01')?.bundle?.title, 'AI の仕組みづくり')
})

test('only a task the member asked of themselves may be finished from the list', () => {
  const items = classifyTasks(src({ myTurn: [rec('task-own001', 'todo'), rec('task-from01', 'todo', { requested_by: 'u-tanaka' })] }))
  assert.equal(items.find(i => i.id === 'task-own001')?.own, true)
  assert.equal(items.find(i => i.id === 'task-from01')?.own, false)
})

function harness(answers: Record<string, { status: number; body: unknown }>) {
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const api = createTasksApi({
    baseUrl: () => 'https://acb.test',
    cookies: () => ['session=abc'],
    log: { warn: () => {} },
    now: () => Date.parse('2026-11-05T06:00:00.000Z'),
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ url, method: String(init.method), body })
      const path = url.replace('https://acb.test', '')
      const a = answers[`${init.method} ${path}`] ?? answers[path] ?? { status: 404, body: {} }
      return new Response(JSON.stringify(a.body), { status: a.status })
    }) as unknown as typeof fetch,
  })
  return { api, requests }
}

test('the one-line add makes a task only the member sees, assigned to them, with its due and tags', async () => {
  const h = harness({ '/api/me': { status: 200, body: { data: { id: ME } } }, 'POST /api/companies/co1/records/item': { status: 201, body: { data: { record: { id: 'task-new001' } } } } })
  const r = await h.api.create('co1', { title: '見積を直す', due: '2026-11-06T15:00', tags: ['営業'] })
  assert.deepEqual(r, { success: true, recordId: 'task-new001' })
  const sent = h.requests.find(q => q.url.endsWith('/records/item'))
  assert.deepEqual(sent?.body, { type: 'task', title: '見積を直す', personal: true, fields: { assignee: ME, due: '2026-11-06T15:00', tags: ['営業'] } })
  assert.equal((await h.api.create('co1', { title: 'x', due: '明日' })).success, false)
})

test('an action name or record id that is not one never reaches the server', async () => {
  const h = harness({})
  for (const action of ['../share', 'complete/../../x', 'Complete']) {
    assert.equal((await h.api.act('co1', 'task-abc123', { action, expectedVersion: 1 })).success, false)
  }
  assert.equal((await h.api.act('co1', '../task-abc123', { action: 'accept', expectedVersion: 1 })).success, false)
  assert.equal(h.requests.length, 0)
})

test('records off for the company: no list, not an error', async () => {
  const h = harness({ '/api/me': { status: 200, body: { data: { id: ME } } }, 'GET /api/companies/co1/records/my-turn': { status: 404, body: { code: 'RECORDS_DISABLED' } } })
  assert.deepEqual(await h.api.list('co1'), { success: true, data: { available: false, listDepartmentIds: null, items: [] } })
})
