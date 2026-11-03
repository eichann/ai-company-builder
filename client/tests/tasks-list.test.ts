// The task list in main (electron/features/tasks/ipc.ts, client/shared/tasks.ts,
// .claude/rules/tasks-ui.md). Guards: each record is shown once and in the right place (a
// request the member must accept is not 「あなたの番」 work yet, a reply they wait for is not
// something to do now); what the row's ☑ does (task v9); the one-line add makes a task only the member sees, assigned to them; an action name
// never reaches the server's URL as a path; records off is no list, not an error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTasksApi } from '../electron/features/tasks/ipc'
import { cameBackLine, classifyTasks, defaultWaitUntil, waitChoices, type TaskSources } from '../shared/tasks'
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

test('返事待ち (task version 12): the row says its 見込み; once the clock gave it back, 「…が来ていません（n日）」 in business days', () => {
  const items = classifyTasks(src({
    today: '2026-11-09', holidays: [],
    myTurn: [
      rec('task-wait01', 'waiting', { waiting_on: '先方からの返事', wait_until: '2026-11-06' }),
      // Began Tue 11-03 (文化の日) 10:00 JST; today Mon 11-09 → Wed, Thu, Fri, Mon = 4.
      rec('task-back01', 'todo', { waiting_on: '先方からの返事', wait_until: '2026-11-06' }, { waitCameBack: { waitedSince: '2026-11-03T01:00:00.000Z', overAt: '2026-11-07T00:00:00.000Z' } }),
      rec('task-back02', 'todo', { wait_until: '2026-11-06' }, { waitCameBack: { waitedSince: null, overAt: '2026-11-07T00:00:00.000Z' } }),
      // A past 見込み alone (no mark from the server) is not 「来ていません」.
      rec('task-todo01', 'todo', { waiting_on: 'x', wait_until: '2026-11-01' }),
    ],
  }))
  const at = Object.fromEntries(items.map(i => [i.id, [i.turn, i.waitingFor]]))
  assert.deepEqual(at['task-wait01'], ['others', '返事待ち：先方からの返事（11/6 ごろまで）'])
  assert.deepEqual(at['task-back01'], ['mine', '先方からの返事が来ていません（4日）'])
  assert.deepEqual(at['task-back02'], ['mine', '返事が来ていません'])
  assert.deepEqual(at['task-todo01'], ['mine', null])
  // The company's own holiday is not counted.
  assert.equal(cameBackLine('先方からの返事', '2026-11-03T01:00:00.000Z', '2026-11-09', ['2026-11-05']), '先方からの返事が来ていません（3日）')
})

test('「いつごろ来そうか」 chips: 明日 (the next business day), 3日後 (3 business days, the default), 来週 (same weekday, or the next business day)', () => {
  // Monday 11-02; 11-03 文化の日.
  assert.deepEqual(waitChoices('2026-11-02').map(c => [c.label, c.until]), [['次の営業日', '2026-11-04'], ['3日後', '2026-11-06'], ['来週', '2026-11-09']])
  assert.equal(defaultWaitUntil('2026-11-02'), '2026-11-06')
  // Wednesday 11-04 with the company's own holiday on Friday 11-06.
  assert.deepEqual(waitChoices('2026-11-04', ['2026-11-06']).map(c => [c.label, c.until]), [['明日', '2026-11-05'], ['3日後', '2026-11-10'], ['来週', '2026-11-11']])
  // Friday → 明日 is Saturday: the next business day is Monday; 来週 Friday 11-13.
  assert.deepEqual(waitChoices('2026-11-06').map(c => [c.label, c.until]), [['次の営業日', '2026-11-09'], ['3日後', '2026-11-11'], ['来週', '2026-11-13']])
  // 来週 on a holiday (11-23 勤労感謝の日, Monday) → the business day after it.
  assert.equal(waitChoices('2026-11-16').find(c => c.key === 'next-week')?.until, '2026-11-24')
})

test('each item carries the interfaces its type implements (a plugin\'s peek lists by them, A6)', () => {
  const items = classifyTasks(src({
    typeImplements: { task: ['request'] },
    myTurn: [rec('task-req001', 'todo'), rec('meeting-ab1234', 'read', {}, { type: 'meeting' })],
  }))
  assert.deepEqual(items.find(i => i.id === 'task-req001')?.implements, ['request'])
  assert.equal(items.find(i => i.id === 'meeting-ab1234')?.implements, undefined)
})

test('☑ (task v9): 完了 from any state but 準備中; asked with 確かめてから → 見てもらう; done → やり直す only for who asked; never on what the member asked of someone', () => {
  const items = classifyTasks(src({
    myTurn: [
      rec('task-own001', 'todo'), rec('task-acc001', 'awaiting_acceptance', { requested_by: 'u-tanaka' }),
      rec('task-tell01', 'todo', { requested_by: 'u-tanaka', when_done: 'notify' }),
      rec('task-chk001', 'in_progress', { requested_by: 'u-tanaka', when_done: 'check', reviewer: 'u-tanaka' }),
      rec('task-rev001', 'review', { assignee: 'u-tanaka', requested_by: ME, when_done: 'check', reviewer: ME }),
    ],
    aiTurn: [rec('task-prep01', 'preparing')],
    asked: [rec('task-ask001', 'in_progress', { assignee: 'u-tanaka' })],
    doneToday: [rec('task-done01', 'done'), rec('task-done02', 'done', { requested_by: 'u-tanaka' })],
  }))
  const check = (id: string) => items.find(i => i.id === id)?.check
  assert.deepEqual(check('task-own001'), { action: 'complete' })
  assert.deepEqual(check('task-acc001'), { action: 'complete' })
  assert.deepEqual(check('task-tell01'), { action: 'complete' })
  assert.deepEqual(check('task-chk001'), { action: 'request_review', reviewer: 'u-tanaka' })
  assert.deepEqual(check('task-rev001'), { action: 'complete' })
  assert.equal(check('task-prep01'), undefined)
  assert.equal(check('task-ask001'), undefined)
  assert.deepEqual(check('task-done01'), { action: 'reopen' })
  assert.equal(check('task-done02'), undefined)
})

// Guards the row's 「人に頼んだもの」 mark (owner 2026-11-02): a task asked of someone else showed the
// task icon, read as 「もう済んだ」; the member's own, one asked of them, or a finished one never gets it.
test('「人に頼んだもの」 only on an unfinished task the member asked of someone else', () => {
  const items = classifyTasks(src({
    myTurn: [rec('task-own001', 'todo'), rec('task-acc001', 'awaiting_acceptance', { requested_by: 'u-tanaka' })],
    asked: [rec('task-ask001', 'awaiting_acceptance', { assignee: 'u-tanaka' }), rec('task-ask002', 'in_progress', { assignee: 'u-tanaka' })],
    doneToday: [rec('task-done01', 'done', { assignee: 'u-tanaka' })],
  }))
  const asked = (id: string) => items.find(i => i.id === id)?.askedOfOthers === true
  assert.deepEqual(['task-own001', 'task-acc001', 'task-ask001', 'task-ask002', 'task-done01'].map(asked), [false, false, true, true, false])
})

// Owner decision 2026-11-03: a company without mail or chat sees no mail / chat parts, but never
// loses work — a 返事のお願い or 確認待ち left from before a disconnect is listed until it is finished.
test('a 返事のお願い or a 来た連絡 to confirm in the member\'s turn is listed as theirs, with nothing about connections asked', async () => {
  const reply = rec('reply_request-0001', 'open', { requested_by: null }, { type: 'reply_request', title: 'Re: 見積のご相談' })
  const unsure = rec('interaction-0001', 'unsure', { requested_by: null }, { type: 'interaction', title: '日程のご相談' })
  const items = classifyTasks(src({ myTurn: [reply, unsure], typeLabels: { task: 'タスク', reply_request: '返事のお願い', interaction: '来た連絡' } }))
  assert.deepEqual(items.map(i => [i.id, i.turn]), [['reply_request-0001', 'mine'], ['interaction-0001', 'mine']])

  // Main reads the list with the company's switches saying neither mail nor chat is connected.
  const h = harness({
    '/api/me': { status: 200, body: { data: { id: ME } } },
    '/api/companies/co1/records/my-turn': { status: 200, body: { data: { records: [reply, unsure] } } },
    '/api/companies/co1/records/ai-turn': { status: 200, body: { data: { records: [] } } },
    'POST /api/companies/co1/records/query': { status: 200, body: { data: { records: [] } } },
    '/api/companies/co1/me/work-switches': { status: 200, body: { data: { channels: { mail: false, chat: false } } } },
  })
  const listed = await h.api.list('co1')
  assert.ok(listed.success && listed.data.available)
  assert.deepEqual(listed.data.items.filter(i => i.turn === 'mine').map(i => i.id).sort(), ['interaction-0001', 'reply_request-0001'])
})

function harness(answers:Record<string, { status: number; body: unknown }>) {
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

test('「頼む」 from the one line: shared with the department\'s readers (never owner-only), 終わったら, and the checker when 確かめてから', async () => {
  const h = harness({ '/api/me': { status: 200, body: { data: { id: ME } } }, 'POST /api/companies/co1/records/item': { status: 201, body: { data: { record: { id: 'task-new002' } } } } })
  const sent = () => h.requests.filter(q => q.url.endsWith('/records/item')).at(-1)?.body
  await h.api.create('co1', { title: '見積を直す', assignee: 'u-tanaka', whenDone: 'check', folder: '営業部', bundleId: 'deal-a00001' })
  assert.deepEqual(sent(), {
    type: 'task', title: '見積を直す', folder: '営業部', links: { bundle: 'deal-a00001' },
    fields: { assignee: 'u-tanaka', when_done: 'check', reviewer: ME },
  })
  // 知らせるだけ is the default; 全社 (no folder) is the whole company, as records made before.
  await h.api.create('co1', { title: '資料を送る', assignee: 'u-tanaka' })
  assert.deepEqual(sent(), { type: 'task', title: '資料を送る', fields: { assignee: 'u-tanaka', when_done: 'notify' } })
  // The member themselves as 担当 is their own task: owner-only, no 終わったら.
  await h.api.create('co1', { title: '自分の', assignee: ME, whenDone: 'check' })
  assert.deepEqual(sent(), { type: 'task', title: '自分の', personal: true, fields: { assignee: ME } })
  const before = h.requests.length
  for (const bad of [{ assignee: '../x' }, { whenDone: 'later' }, { folder: '../営業部' }, { folder: '/Users/me/会社' }, { bundleId: 'deal/../x' }]) {
    assert.equal((await h.api.create('co1', { title: 'x', assignee: 'u-tanaka', ...bad } as never)).success, false, JSON.stringify(bad))
  }
  assert.equal(h.requests.length, before)
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

test('a meeting the server asks about waits in あなたの番 to be chosen, once, with its group', () => {
  const meeting: RecordSummary = { ...rec('meeting-00aa11', 'read', { assignee: ME }), type: 'meeting' }
  const q = { recordId: 'meeting-00aa11', title: 'A社 定例', version: 4, meetingAt: '2026-11-04T05:00:00.000Z', readAt: '2026-11-04T06:00:00.000Z', group: { key: 'g1', label: 'A社' }, suggested: null }
  const items = classifyTasks(src({ bundleQuestions: [q], doneToday: [meeting] }))
  assert.equal(items.length, 1)
  assert.deepEqual([items[0].turn, items[0].needsBundle, items[0].waitingFor, items[0].version], ['mine', true, 'どの案件・プロジェクトの会議か選んでください', 4])
  assert.deepEqual(items[0].bundleGroup, { key: 'g1', label: 'A社' })
})

test('a suggested まとまり asks 「『…』の会議ですか？」 and is only carried, never linked by the list', () => {
  const q = { recordId: 'meeting-00aa12', title: 'A社 定例', version: 4, meetingAt: null, readAt: '2026-11-04T06:00:00.000Z', group: { key: 'g1', label: 'A社' }, suggested: { id: 'deal-abcdef01', title: 'A社 研修導入', typeLabel: '案件' } }
  const [item] = classifyTasks(src({ bundleQuestions: [q] }))
  assert.equal(item.waitingFor, '『A社 研修導入』の会議ですか？')
  assert.deepEqual(item.suggestedBundle, { id: 'deal-abcdef01', title: 'A社 研修導入' })
  assert.equal(item.bundle, null)
  const [plain] = classifyTasks(src({ bundleQuestions: [{ ...q, suggested: null }] }))
  assert.equal(plain.suggestedBundle, undefined)
  assert.equal(plain.waitingFor, 'どの案件・プロジェクトの会議か選んでください')
})

test('which meetings ask is the server\'s answer: the app adds none and drops none; an older server asks nothing', async () => {
  const empty = { status: 200, body: { data: { total: 0, records: [] } } }
  const question = (id: string) => ({ recordId: id, title: id, version: 2, meetingAt: null, readAt: '2026-11-04T06:00:00.000Z', group: { key: id, label: id }, suggested: null })
  for (const [answer, expected] of [
    [{ status: 200, body: { data: { days: 7, questions: [question('meeting-free01'), question('meeting-free02')] } } }, ['meeting-free01', 'meeting-free02']],
    [{ status: 404, body: { error: 'Not found' } }, []],
  ] as const) {
    const asked: string[] = []
    const routes: Record<string, { status: number; body: unknown }> = {
      '/api/me': { status: 200, body: { data: { id: ME } } },
      'GET /api/companies/co1/records/my-turn': empty, 'GET /api/companies/co1/records/ai-turn': empty,
      'GET /api/companies/co1/me/minutes/bundle-questions': answer,
    }
    const api = createTasksApi({
      baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} }, now: () => Date.parse('2026-11-05T06:00:00.000Z'),
      fetch: (async (url: string, init: RequestInit) => {
        const path = url.replace('https://acb.test', '')
        asked.push(`${init.method} ${path}`)
        if (path.endsWith('/records/query')) return new Response(JSON.stringify(empty.body), { status: 200 })
        const a = routes[`${init.method} ${path}`] ?? routes[path] ?? { status: 503, body: {} }
        return new Response(JSON.stringify(a.body), { status: a.status })
      }) as unknown as typeof fetch,
    })
    const r = await api.list('co1')
    assert.ok(r.success)
    assert.deepEqual(r.data.items.filter(i => i.needsBundle).map(i => i.id), expected)
    // No meeting is looked up to decide it here.
    assert.equal(asked.some(a => a.includes('/records/item/meeting-')), false)
  }
})

test('a row\'s 案件・プロジェクト chip names the kind as the company calls it (bundle kinds), else the type\'s label', () => {
  const items = classifyTasks(src({
    myTurn: [rec('task-a00001', 'todo'), rec('task-b00001', 'todo')],
    typeLabels: { task: 'タスク', project: 'プロジェクト', deal: '案件' },
    bundles: { 'task-a00001': { id: 'project-abc123', title: '新サービス' }, 'task-b00001': { id: 'deal-abc123', title: 'A社' } },
    bundleKindNames: { project: '取り組み' },
  }))
  assert.equal(items.find(i => i.id === 'task-a00001')?.bundle?.typeLabel, '取り組み')
  assert.equal(items.find(i => i.id === 'task-b00001')?.bundle?.typeLabel, '案件')
})

test('an AI proposal put away (dismissed) is not among today\'s done', () => {
  const items = classifyTasks(src({ doneToday: [rec('task-done01', 'done'), rec('task-prop01', 'dismissed')] }))
  assert.deepEqual(items.map(i => i.id), ['task-done01'])
})

test('bundle kinds: what the server names each department\'s kind, as it answered; a bad company id never reaches it', async () => {
  const kinds = {
    core: { type: 'project', name: '取り組み', source: 'core' },
    departments: [{ departmentId: 'd1', folder: '営業部', kind: { type: 'deal', name: '案件', source: 'plugin' } }],
    kinds: [{ type: 'deal', name: '案件', source: 'plugin' }, { type: 'project', name: '取り組み', source: 'core' }],
  }
  const h = harness({ 'GET /api/companies/co1/records/bundle-kinds': { status: 200, body: { data: kinds } } })
  assert.deepEqual(await h.api.bundleKinds('co1'), { success: true, kinds })
  assert.equal((await h.api.bundleKinds('../x')).success, false)
  assert.equal(h.requests.length, 1)
  // An older server without the route: a failure the screen can fall back from, not a crash.
  const old = harness({})
  const r = await old.api.bundleKinds('co1')
  assert.equal(r.success, false)
})
