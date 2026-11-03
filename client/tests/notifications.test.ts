/**
 * The title bar's 「あなたの番」 and bell in the app's main process (stage 2 S5,
 * `.claude/rules/notifications.md` "The app").
 *
 * Guards (each mutation-checked):
 * - a `notifications` push event only makes main ask again (onNotifications),
 *   and one carrying more than kind + version is dropped;
 * - a parser that does not know a kind (a released app meeting `notifications`)
 *   drops it and keeps the connection;
 * - the watcher reads with the session in the Cookie header (never the URL),
 *   and a signal for a company not on screen asks nothing;
 * - a Mac notification only for an item new in 「あなたの番」 (the first look
 *   notifies nothing), approval requests in their own words, or a notice the
 *   server marks fresh (`desktop`) — once per PC, kept across a restart, the
 *   morning summary opening the task list; being asked speaks for its turn item;
 * - the title bar counts and lists only this week's turn — a task not started with no due or due
 *   after this week rests in the list (the server's morning summary counts the same);
 * - sign-out forgets everything;
 * - for a department without the task list, its meetings reach the title bar: a まとまり to
 *   choose and received minutes, counted as the member's only when the AI will not read them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser } from '../shared/agent-stop'
import { createAgentPushChannel } from '../electron/services/agent-push-channel'
import { createNotificationsWatcher } from '../electron/features/notifications/watcher'
import { meetingTurns, NO_NOTICES, turnGroups } from '../shared/notifications-app'
import type { TaskListItem } from '../shared/tasks'

const V1 = 'a'.repeat(32)
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const quiet = { log: () => {}, warn: () => {} }

function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
  }
}

test('a notifications event only asks again; one with content is dropped', async () => {
  const stream = sseResponse()
  const heard: string[] = []
  const refreshed: string[] = []
  const records: string[] = []
  const channel = createAgentPushChannel({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'],
    refresh: id => refreshed.push(id), onRecords: id => records.push(id), onNotifications: id => heard.push(id),
    fetch: (async () => stream.response) as unknown as typeof fetch,
    log: quiet, random: () => 0.5, setTimeout: () => 0, clearTimeout: () => {},
  })
  channel.watch('co')
  await tick()
  stream.send(`event: notifications\ndata: {"kind":"notifications","version":"${V1}","text":"山田さんが完了にしました"}\n\n`)
  stream.send(`event: notifications\ndata: {"kind":"notifications","version":"${V1}"}\n\n`)
  await tick(); await tick()
  assert.deepEqual(heard, ['co'])
  assert.deepEqual(refreshed, [])
  assert.deepEqual(records, [])
  channel.stopAll()
})

test('an app that does not know a kind drops it and keeps reading', () => {
  const parser = createSseParser()
  const items = parser.push(`event: someday\ndata: {"kind":"someday","version":"${V1}"}\n\nevent: policy\ndata: {"kind":"policy","version":"${V1}"}\n\n`)
  assert.deepEqual(items.map(i => i.type), ['dropped', 'event'])
  assert.equal(parser.overflow, false)
})

interface Server { turn: unknown[]; notices: unknown; calls: Array<{ url: string; headers: Record<string, string> }> }

function fakeServer(server: Server) {
  return (async (url: string, init: RequestInit) => {
    server.calls.push({ url, headers: init.headers as Record<string, string> })
    if (url.endsWith('/records/my-turn')) return Response.json({ success: true, data: { total: server.turn.length, records: server.turn } })
    if (url.endsWith('/me/notifications')) return Response.json({ success: true, data: server.notices })
    return Response.json({ success: true, data: {} })
  }) as unknown as typeof fetch
}

// Started (in_progress): this week's turn whatever the day the test runs (shared/core/turn-timing.ts).
const task = (id: string, title: string, type = 'task') => ({ id, type, title, state: 'in_progress', fields: { due: '2026-11-05' } })
const NOTICES = { available: true, unread: 1, items: [{ id: 'n1', kind: 'request_done', recordId: 'task-aaaaaa01', recordType: 'task', recordTitle: 'x', version: 3, text: 'Bobさんが「x」を完了にしました', createdAt: '2026-11-01T00:00:00Z', read: false }] }

test('the title bar counts only this week\'s turn: a task not started with no due or due after this week rests', async () => {
  const todo = (id: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, type: 'task', title: id, state: 'todo', fields, ...extra })
  const server: Server = {
    turn: [
      todo('task-week0001', { due: '2026-11-08' }), // Sunday: still this week
      todo('task-over0002', { due: '2026-11-01' }), // overdue
      todo('task-next0003', { due: '2026-11-09' }), // next week, not started: 先のこと
      todo('task-none0004', {}), // no due, not started: いつか
      { ...todo('task-strt0005', {}), state: 'in_progress' }, // started
      todo('task-mins0006', { task_kind: 'minutes_review' }), // a minutes check waits for a press
      todo('task-prep0007', { prep_summary: '下書きを用意しました' }), // the AI handed it over
      todo('task-back0008', {}, { waitCameBack: { waitedSince: null, overAt: '2026-11-02T00:00:00Z' } }),
      { id: 'approval-appr0009', type: 'approval', title: '承認', state: 'pending', fields: {} },
    ],
    notices: { available: true, unread: 0, items: [] }, calls: [],
  }
  const watcher = createNotificationsWatcher({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], onChanged: () => {},
    fetch: fakeServer(server), log: quiet, setInterval: () => 0, clearInterval: () => {},
    now: () => Date.parse('2026-11-03T01:00:00Z'), // Tuesday 10:00 in Japan
  })
  await watcher.watch('co')
  const { myTurn } = watcher.state('co')
  assert.deepEqual(myTurn.items.map(i => i.id), ['task-week0001', 'task-over0002', 'task-strt0005', 'task-mins0006', 'task-prep0007', 'task-back0008', 'approval-appr0009'])
  assert.equal(myTurn.total, 7)
  assert.equal(myTurn.resting, 2)
})

test('the watcher reads with the session in a header; a Mac notification only for what is new', async () => {
  const server: Server = { turn: [task('task-aaaaaa01', '見積書')], notices: NOTICES, calls: [] }
  const shown: Array<[string, string]> = []
  const changed: string[] = []
  const watcher = createNotificationsWatcher({
    baseUrl: () => 'https://acb.example.jp/', cookies: () => ['better-auth.session_token=SECRET.sig'],
    onChanged: id => changed.push(id), desktopNotify: (title, body) => shown.push([title, body]),
    fetch: fakeServer(server), log: quiet, setInterval: () => 0, clearInterval: () => {},
  })
  await watcher.watch('co')
  assert.equal(watcher.state('co').myTurn.total, 1)
  assert.equal(watcher.state('co').notices.unread, 1)
  assert.deepEqual(changed, ['co'])
  // The first look notifies nothing: what was waiting is not news.
  assert.deepEqual(shown, [])
  for (const c of server.calls) {
    assert.ok(!c.url.includes('SECRET'))
    assert.equal(c.headers.Cookie, 'better-auth.session_token=SECRET.sig')
  }

  server.turn = [task('task-aaaaaa01', '見積書'), task('approval-bbbbbb02', '値引きの承認', 'approval'), task('task-cccccc03', '議事録を読む')]
  const before = server.calls.length
  watcher.signal('other-co')
  await tick()
  assert.equal(server.calls.length, before, 'a signal for a company not on screen asks nothing')
  watcher.signal('co')
  await tick(); await tick()
  assert.deepEqual(shown, [['承認のお願いが来ました', '値引きの承認'], ['あなたの番に新しく来ました', '議事録を読む']])
  // Asked again with nothing new: nothing more.
  watcher.signal('co')
  await tick(); await tick()
  assert.equal(shown.length, 2)

  watcher.stop()
  assert.deepEqual(watcher.state('co'), NO_NOTICES)
})

test('a 返事待ち task the clock gave back is news once (Mac notification), though it was in the list while it waited', async () => {
  const waiting = { id: 'task-aaaaaa01', type: 'task', title: '見積の返事', state: 'waiting', fields: {} }
  const server: Server = { turn: [waiting], notices: NOTICES, calls: [] }
  const shown: Array<[string, string]> = []
  const watcher = createNotificationsWatcher({
    baseUrl: () => 'https://acb.example.jp/', cookies: () => ['s=1'], onChanged: () => {}, desktopNotify: (title, body) => shown.push([title, body]),
    fetch: fakeServer(server), log: quiet, setInterval: () => 0, clearInterval: () => {},
  })
  await watcher.watch('co')
  // The member started it themselves: same item, nothing new.
  server.turn = [{ ...waiting, state: 'in_progress' }]
  watcher.signal('co')
  await tick(); await tick()
  assert.deepEqual(shown, [])
  server.turn = [{ ...waiting, state: 'todo', waitCameBack: { waitedSince: '2026-11-02T01:00:00.000Z', overAt: '2026-11-07T00:00:00.000Z' } }]
  watcher.signal('co')
  await tick(); await tick()
  assert.deepEqual(shown, [['返事の見込みを過ぎました（あなたの番に戻りました）', '見積の返事']])
  watcher.signal('co')
  await tick(); await tick()
  assert.equal(shown.length, 1)
  watcher.stop()
})

test('the server’s fresh notices are Mac notifications once per PC — also on the first look, across a restart; being asked speaks for its new turn item', async () => {
  const morning = { id: 'n-morning', kind: 'morning_summary', recordId: '', recordType: '', recordTitle: '', version: 0, text: '今日のあなたの番 2件（期限が今日 1件）', createdAt: '2026-11-04T23:30:00Z', read: false, desktop: { title: '今日のあなたの番 2件（期限が今日 1件）', body: 'やることの一覧で確かめてください' } }
  const stale = { ...morning, id: 'n-old', text: '11月2日の「今日のあなたの番」（朝の知らせ）', desktop: undefined }
  const server: Server = { turn: [task('task-aaaaaa01', '見積書')], notices: { available: true, unread: 2, items: [morning, stale] }, calls: [] }
  const shown: Array<[string, string, string]> = []
  let saved: string[] = []
  const store = { load: () => saved, save: (ids: string[]) => { saved = ids } }
  const start = () => createNotificationsWatcher({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], onChanged: () => {},
    desktopNotify: (title, body, click) => shown.push([title, body, click.target]), shownNotices: store,
    fetch: fakeServer(server), log: quiet, setInterval: () => 0, clearInterval: () => {},
  })
  let watcher = start()
  await watcher.watch('co')
  // The record-less morning summary is kept (it opens the task list); only the fresh one is shown.
  assert.deepEqual(watcher.state('co').notices.items.map(i => i.id), ['n-morning', 'n-old'])
  assert.deepEqual(shown, [['今日のあなたの番 2件（期限が今日 1件）', 'やることの一覧で確かめてください', 'tasks']])
  watcher.signal('co')
  await tick(); await tick()
  assert.equal(shown.length, 1)
  // Quit and start again the same morning: not shown twice.
  watcher.stop()
  watcher = start()
  await watcher.watch('co')
  assert.equal(shown.length, 1)

  // Asked: the notice speaks for the new turn item — one notification, the asker's words.
  const asked = { id: 'n-asked', kind: 'asked', recordId: 'task-bbbbbb02', recordType: 'task', recordTitle: '提案書', version: 1, text: 'Aliceさんから「提案書」を頼まれました', createdAt: '2026-11-05T01:00:00Z', read: false, desktop: { title: 'Aliceさんから頼まれました', body: '提案書' } }
  server.notices = { available: true, unread: 3, items: [asked, morning, stale] }
  server.turn = [task('task-aaaaaa01', '見積書'), task('task-bbbbbb02', '提案書')]
  watcher.signal('co')
  await tick(); await tick()
  assert.deepEqual(shown.slice(1), [['Aliceさんから頼まれました', '提案書', 'app']])
  // A notice id from the server that is not a plain id, or a record-less row of a kind about a record, is dropped.
  server.notices = { available: true, unread: 2, items: [{ ...asked, id: 'bad id!' }, { ...asked, id: 'n-x', recordId: '' }] }
  watcher.signal('co')
  await tick(); await tick()
  assert.deepEqual(watcher.state('co').notices.items, [])
  assert.equal(shown.length, 2)
  watcher.stop()
})

test('records off: no title bar parts; refusals of bad input', async () => {
  const watcher = createNotificationsWatcher({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], onChanged: () => {},
    fetch: (async (url: string) => (url.endsWith('/records/my-turn')
      ? Response.json({ error: 'off' }, { status: 404 })
      : Response.json({ success: true, data: { available: false, unread: 0, items: [] } }))) as unknown as typeof fetch,
    log: quiet, setInterval: () => 0, clearInterval: () => {},
  })
  await watcher.watch('co')
  assert.equal(watcher.state('co').available, false)
  assert.deepEqual(await watcher.markRead('co', ['bad id!']), { success: false, error: '入力が正しくありません。' })
  assert.deepEqual(await watcher.markRead('../x', 'all'), { success: false, error: '入力が正しくありません。' })
})

test('a department without the task list still gets its meetings: a まとまり to choose and received minutes, waiting only when the AI will not read them', () => {
  const item = (id: string, over: Partial<TaskListItem>): TaskListItem => ({
    id, type: 'meeting', typeLabel: '会議', title: id, state: 'received', stateLabel: null, version: 2, due: null, tags: [], turn: 'ai',
    waitingFor: null, personal: false, own: false, actingFor: null, bundle: null, finishedAt: null, ...over,
  })
  const items = [
    item('meeting-read01', { state: 'read', turn: 'mine', needsBundle: true }),
    item('meeting-read02', { state: 'read', turn: 'mine', needsBundle: true, suggestedBundle: { id: 'deal-abcdef01', title: 'A社 研修導入' } }),
    item('meeting-new001', {}),
    item('meeting-new002', {}),
    item('meeting-new003', {}),
    item('task-prep0001', { type: 'task', typeLabel: 'タスク', state: 'preparing' }),
    item('task-mine0001', { type: 'task', typeLabel: 'タスク', state: 'todo', turn: 'mine' }),
  ]
  const turns = meetingTurns(items, [
    { recordId: 'meeting-new001', state: 'running', reason: '', canRetry: false, canHand: false },
    { recordId: 'meeting-new002', state: 'failed', reason: '議事録が空でした', canRetry: true, canHand: false },
  ])
  assert.deepEqual(turns.map(t => [t.id, t.kind, t.needsPerson, t.text]), [
    ['meeting-read01', 'bundle', true, 'どの案件・プロジェクトの会議か選んでください'],
    // The 相手's one open まとまり, suggested (はい links it; nothing is linked here).
    ['meeting-read02', 'bundle', true, '『A社 研修導入』の会議ですか？'],
    ['meeting-new001', 'minutes', false, 'AI が読み取っています'],
    ['meeting-new002', 'minutes', true, 'AI が読み取れませんでした：議事録が空でした'],
    // Nothing heard from the runner (another window, the setting off): never silent.
    ['meeting-new003', 'minutes', true, '議事録が届きました'],
  ])
  // In the department's kind's name: the umbrella word 「まとまり」 never shows (owner 2026-11-02).
  assert.equal(meetingTurns(items, [], '案件')[0].text, 'どの案件の会議か選んでください')
  assert.deepEqual(turns.find(t => t.id === 'meeting-read02')?.suggestedBundle, { id: 'deal-abcdef01', title: 'A社 研修導入' })
})

test('「あなたの番」 by kind, each with what to do; the same kind once, in the order first met (I.2)', () => {
  const groups = turnGroups([
    { id: 'approval-a', type: 'approval', title: '値引き', state: 'pending', due: null },
    { id: 'task-a', type: 'task', title: '見積', state: 'todo', due: null },
    { id: 'approval-b', type: 'approval', title: '発注', state: 'pending', due: null },
    { id: 'outbound_message-a', type: 'outbound_message', title: 'お礼', state: 'draft', due: null },
  ])
  assert.deepEqual(groups.map(g => [g.line, g.items.map(i => i.id)]), [
    ['承認のお願い 2件 — 承認してください', ['approval-a', 'approval-b']],
    ['やること 1件', ['task-a']],
    ['送るメールの下書き 1件 — 確かめて送ってください', ['outbound_message-a']],
  ])
})
