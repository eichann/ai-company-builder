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

test('each item carries the interfaces its type implements (a plugin\'s peek lists by them, A6)', () => {
  const items = classifyTasks(src({
    typeImplements: { task: ['request'] },
    myTurn: [rec('task-req001', 'todo'), rec('meeting-ab1234', 'read', {}, { type: 'meeting' })],
  }))
  assert.deepEqual(items.find(i => i.id === 'task-req001')?.implements, ['request'])
  assert.equal(items.find(i => i.id === 'meeting-ab1234')?.implements, undefined)
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

test('linking a file sends only a path inside the company folder; taking it away uses the remove route', async () => {
  const h = harness({
    'POST /api/companies/co1/records/item/task-abc123/file-links': { status: 200, body: { data: { changed: true } } },
    'POST /api/companies/co1/records/item/task-abc123/file-links/remove': { status: 200, body: { data: { changed: true } } },
  })
  for (const bad of ['/Users/me/会社/見積.xlsx', '../見積.xlsx', '営業/../../x', 'C:/x', '']) {
    assert.equal((await h.api.linkFile('co1', 'task-abc123', bad, 3, false)).success, false, bad)
  }
  assert.equal(h.requests.length, 0)
  assert.equal((await h.api.linkFile('co1', 'task-abc123', '営業/見積.xlsx', 3, false)).success, true)
  assert.equal((await h.api.linkFile('co1', 'task-abc123', '営業/見積.xlsx', 4, true)).success, true)
  assert.deepEqual(h.requests.map(r => [r.url.replace('https://acb.test/api/companies/co1', ''), r.body]), [
    ['/records/item/task-abc123/file-links', { path: '営業/見積.xlsx', expectedVersion: 3 }],
    ['/records/item/task-abc123/file-links/remove', { path: '営業/見積.xlsx', expectedVersion: 4 }],
  ])
})

test('「部署に出す」 sends only a company folder at the version shown; the server\'s refusal comes back in its words', async () => {
  const h = harness({
    'POST /api/companies/co1/records/item/task-abc123/share': { status: 200, body: { data: { record: { id: 'task-abc123' } } } },
    'POST /api/companies/co1/records/item/task-old123/share': { status: 409, body: { code: 'NOT_PERSONAL', error: 'もう部署に出ています。' } },
  })
  for (const bad of ['/Users/me/会社/営業', '../営業', '営業/../../x', '']) {
    assert.equal((await h.api.share('co1', 'task-abc123', bad, 3)).success, false, bad)
  }
  assert.equal((await h.api.share('co1', '../task-abc123', '営業', 3)).success, false)
  assert.equal(h.requests.length, 0)
  assert.deepEqual(await h.api.share('co1', 'task-abc123', '営業', 3), { success: true, recordId: 'task-abc123' })
  assert.deepEqual(h.requests.map(r => [r.url.replace('https://acb.test/api/companies/co1', ''), r.body]), [
    ['/records/item/task-abc123/share', { folder: '営業', expectedVersion: 3 }],
  ])
  const refused = await h.api.share('co1', 'task-old123', '営業', 2)
  assert.equal(refused.success, false)
  assert.equal(!refused.success && refused.error, 'もう部署に出ています。')
})

test('a meeting read without a まとまり waits in あなたの番 to be chosen, once', () => {
  const meeting: RecordSummary = { ...rec('meeting-00aa11', 'read', { assignee: ME }), type: 'meeting' }
  const items = classifyTasks(src({ meetingsWithoutBundle: [meeting], doneToday: [meeting] }))
  assert.equal(items.length, 1)
  assert.deepEqual([items[0].turn, items[0].needsBundle, items[0].waitingFor], ['mine', true, 'どのまとまり（案件など）の会議か選んでください'])
})

test('only meetings whose まとまり was read as missing ask; none where the company has no まとまり', async () => {
  const meetingRead = (id: string) => ({ id, type: 'meeting', typeVersion: 2, title: id, summary: '', path: null, state: 'read', fields: { assignee: ME }, version: 5, updatedAt: '' })
  const empty = { status: 200, body: { data: { total: 0, records: [] } } }
  const base = {
    '/api/me': { status: 200, body: { data: { id: ME } } },
    'GET /api/companies/co1/records/my-turn': empty, 'GET /api/companies/co1/records/ai-turn': empty,
    'GET /api/companies/co1/records/item/meeting-linked1': { status: 200, body: { data: { record: meetingRead('meeting-linked1'), links: [{ name: 'bundle', direction: 'out', record: { id: 'deal-abcdef', type: 'deal', title: 'A社' } }] } } },
    'GET /api/companies/co1/records/item/meeting-free01': { status: 200, body: { data: { record: meetingRead('meeting-free01'), links: [] } } },
  }
  const query = (bundles: number) => async (body: Record<string, unknown>) =>
    body.type === 'meeting' ? { data: { total: 3, records: [meetingRead('meeting-linked1'), meetingRead('meeting-free01'), meetingRead('meeting-unread1')] } }
      : body.implements === 'bundle' ? { data: { total: bundles, records: [] } } : { data: { total: 0, records: [] } }
  for (const [bundles, expected] of [[2, ['meeting-free01']], [0, []]] as const) {
    const answer = query(bundles)
    const api = createTasksApi({
      baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} }, now: () => Date.parse('2026-11-05T06:00:00.000Z'),
      fetch: (async (url: string, init: RequestInit) => {
        const path = url.replace('https://acb.test', '')
        if (path.endsWith('/records/query')) return new Response(JSON.stringify(await answer(JSON.parse(String(init.body)))), { status: 200 })
        const a = (base as Record<string, { status: number; body: unknown }>)[`${init.method} ${path}`] ?? (base as Record<string, { status: number; body: unknown }>)[path] ?? { status: 503, body: {} }
        return new Response(JSON.stringify(a.body), { status: a.status })
      }) as unknown as typeof fetch,
    })
    const r = await api.list('co1')
    assert.ok(r.success)
    assert.deepEqual(r.data.items.filter(i => i.needsBundle).map(i => i.id), expected)
  }
})
