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
 *   notifies nothing), approval requests in their own words;
 * - sign-out forgets everything;
 * - for a department without the task list, its meetings reach the title bar: a まとまり to
 *   choose and received minutes, counted as the member's only when the AI will not read them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser } from '../shared/agent-stop'
import { createAgentPushChannel } from '../electron/services/agent-push-channel'
import { createNotificationsWatcher } from '../electron/features/notifications/watcher'
import { meetingTurns, NO_NOTICES } from '../shared/notifications-app'
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

const task = (id: string, title: string, type = 'task') => ({ id, type, title, state: 'todo', fields: { due: '2026-11-05' } })
const NOTICES = { available: true, unread: 1, items: [{ id: 'n1', kind: 'request_done', recordId: 'task-aaaaaa01', recordType: 'task', recordTitle: 'x', version: 3, text: 'Bobさんが「x」を完了にしました', createdAt: '2026-11-01T00:00:00Z', read: false }] }

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
    ['meeting-read01', 'bundle', true, 'どのまとまり（案件など）の会議か選んでください'],
    // The 相手's one open まとまり, suggested (はい links it; nothing is linked here).
    ['meeting-read02', 'bundle', true, '『A社 研修導入』の会議ですか？'],
    ['meeting-new001', 'minutes', false, 'AI が読み取っています'],
    ['meeting-new002', 'minutes', true, 'AI が読み取れませんでした：議事録が空でした'],
    // Nothing heard from the runner (another window, the setting off): never silent.
    ['meeting-new003', 'minutes', true, '議事録が届きました'],
  ])
  assert.deepEqual(turns.find(t => t.id === 'meeting-read02')?.suggestedBundle, { id: 'deal-abcdef01', title: 'A社 研修導入' })
})
