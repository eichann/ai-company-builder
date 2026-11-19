// 「あなたの番」, 「AI の番」 and 「今日の予定」 asked once for the consumers that need them at the same
// moment (plan 「問い合わせを減らす計画」 段1; ipc-and-main-process.md "Shared reads"), with the real
// task list, title-bar watcher and received-minutes checker of main and a fake server. Guards:
// - the task list and the watcher share one my-turn request; the list and the checker one ai-turn
//   request; the task list and 「確かめること」 one calendar request;
// - after the member's own write (a press, the renderer's reload after it) the read is a fresh one;
// - an answer that arrives after sign-out is never shown or notified;
// - the watcher's 「もう 1 回」 still reads again after a signal that came while it read;
// - a change of the notices alone never re-reads the task list: main tells it (`onTurnChanged`,
//   `onAiTurnChanged` → records:changed) only when 「あなたの番」 / 「AI の番」 changed and no
//   records signal had told it already.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInFlightReads } from '../electron/services/in-flight-reads'
import { createTurnReads } from '../electron/services/turn-reads'
import { createCalendarTodayReads } from '../electron/services/calendar-today-reads'
import { createTasksApi } from '../electron/features/tasks/ipc'
import { createNotificationsWatcher } from '../electron/features/notifications/watcher'
import { createMinutesChecker } from '../electron/features/minutes/checker'
import { createCalendarApi } from '../electron/features/calendar/ipc'

const BASE = 'https://acb.example.jp'
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }
const quiet = { warn: () => {}, log: () => {} }

const task = (id: string, title = 'やること') => ({ id: `task-${id}abcdef`, type: 'task', title, state: 'doing', version: 1, fields: { due: '2026-11-19' } })

/** A server whose answers can be held back per path (`hold`), counting what was asked. */
function fakeServer() {
  const asked: Array<{ method: string; path: string }> = []
  const held = new Map<string, Array<() => void>>()
  const holding = new Set<string>()
  let myTurn: unknown[] = []
  let notices: unknown[] = []
  let aiTurn: unknown[] = []
  let granted = true
  let calendarEvents = 0
  const answer = (method: string, path: string): unknown => {
    if (path === '/api/me') return { data: { id: 'u1' } }
    const p = path.replace(/^\/api\/companies\/co/, '')
    if (p === '/records/my-turn') return { data: { records: myTurn, total: myTurn.length } }
    if (p === '/records/ai-turn') return { data: { records: aiTurn } }
    if (p === '/me/notifications') return { data: { available: true, unread: notices.length, items: notices } }
    if (p === '/me/google') return { data: { connected: granted, features: granted ? ['minutes'] : [] } }
    if (p === '/me/minutes/check') return { data: { checked: true, stale: [] } }
    if (p === '/me/calendar/today') return { data: { date: '2026-11-19', timeZone: 'Asia/Tokyo', events: [], reason: calendarEvents ? null : 'not-connected' } }
    if (p === '/records/query') return { data: { records: [] } }
    if (p === '/records/types') return { data: { types: [] } }
    if (p === '/members') return { data: [] }
    if (method === 'POST') return { data: { record: {} } }
    return null
  }
  const fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    const method = init?.method ?? 'GET'
    asked.push({ method, path: path.replace(/^\/api\/companies\/co/, '') })
    // What the server says when the request reaches it (a held answer is not newer than that).
    const body = answer(method, path)
    if (holding.has(path.replace(/^\/api\/companies\/co/, ''))) {
      await new Promise<void>(resolve => {
        const key = path.replace(/^\/api\/companies\/co/, '')
        held.set(key, [...(held.get(key) ?? []), resolve])
      })
    }
    return new Response(JSON.stringify(body ?? { error: 'Not found' }), { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return {
    fetch, asked,
    count: (path: string, method = 'GET') => asked.filter(a => a.path === path && a.method === method).length,
    hold: (path: string) => { holding.add(path) },
    release: (path: string) => { holding.delete(path); for (const r of held.get(path) ?? []) r(); held.delete(path) },
    set: (v: { myTurn?: unknown[]; notices?: unknown[]; aiTurn?: unknown[]; granted?: boolean; calendarAllowed?: boolean }) => {
      if (v.granted !== undefined) granted = v.granted
      if (v.calendarAllowed !== undefined) calendarEvents = v.calendarAllowed ? 1 : 0
      if (v.myTurn) myTurn = v.myTurn
      if (v.notices) notices = v.notices
      if (v.aiTurn) aiTurn = v.aiTurn
    },
  }
}

/** main.ts's composition, in small: one in-flight reader per server × session, handed to each feature. */
function app() {
  const server = fakeServer()
  let cookies = ['s=1']
  const reads = createInFlightReads(() => `${BASE}\n${cookies.join('; ')}`)
  const turns = createTurnReads({ baseUrl: () => BASE, cookies: () => cookies, reads, fetch: server.fetch })
  const told = { turn: 0, aiTurn: 0, notices: 0 }
  const timers: Array<() => void> = []
  const tasks = createTasksApi({ baseUrl: () => BASE, cookies: () => cookies, fetch: server.fetch, log: quiet, turns, changed: c => reads.changed(c), now: () => Date.parse('2026-11-19T03:00:00Z') })
  const watcher = createNotificationsWatcher({
    baseUrl: () => BASE, cookies: () => cookies, fetch: server.fetch, log: quiet, myTurn: turns,
    onChanged: () => { told.notices++ }, onTurnChanged: () => { told.turn++ },
    setInterval: fn => { timers.push(fn); return timers.length }, clearInterval: () => {},
    now: () => Date.parse('2026-11-19T03:00:00Z'),
  })
  const minutes = createMinutesChecker({
    baseUrl: () => BASE, cookies: () => cookies, fetch: server.fetch, log: quiet, aiTurn: turns, changed: c => reads.changed(c),
    onChanged: () => {}, onAiTurnChanged: () => { told.aiTurn++ },
    setInterval: fn => { timers.push(fn); return timers.length }, clearInterval: () => {},
  })
  const calendar = createCalendarTodayReads({ reads, read: createCalendarApi({ baseUrl: () => BASE, cookies: () => cookies, fetch: server.fetch, log: quiet }).today })
  return { server, reads, tasks, watcher, minutes, calendar, told, timers, signOut: () => { cookies = [] }, signIn: (c: string[]) => { cookies = c } }
}

test('the task list and the title bar asking at the same moment: one my-turn request; the list and the received minutes: one ai-turn request', async () => {
  const a = app()
  await a.watcher.watch('co')
  await a.minutes.watch('co')
  const before = { my: a.server.count('/records/my-turn'), ai: a.server.count('/records/ai-turn') }
  a.server.hold('/records/my-turn')
  a.server.hold('/records/ai-turn')
  // A records signal: the watcher and the checker look again, and the renderer reads the list.
  a.watcher.signal('co', true)
  a.minutes.recordsSignal('co')
  const list = a.tasks.list('co')
  await tick()
  a.server.release('/records/my-turn')
  a.server.release('/records/ai-turn')
  const r = await list
  await tick()
  assert.equal(r.success, true)
  assert.equal(a.server.count('/records/my-turn') - before.my, 1)
  assert.equal(a.server.count('/records/ai-turn') - before.ai, 1)
})

test('today\'s calendar asked by the task list and 「確かめること」 at the same moment: one request', async () => {
  const a = app()
  a.server.hold('/me/calendar/today')
  const one = a.calendar.today('co')
  const two = a.calendar.today('co')
  await tick()
  a.server.release('/me/calendar/today')
  assert.equal((await one).success, true)
  assert.equal((await two).success, true)
  assert.equal(a.server.count('/me/calendar/today'), 1)
})

test('after the member\'s own write the list is read fresh: never answered with a read that began before the write', async () => {
  const a = app()
  a.server.set({ myTurn: [task('aaaa', '見積を直す')] })
  a.server.hold('/records/my-turn')
  const preWrite = a.tasks.list('co')
  await tick()
  // ［完了にする］ while that read is on its way; the server's turn is empty after it.
  a.server.set({ myTurn: [] })
  const act = await a.tasks.act('co', 'task-aaaaabcdef', { action: 'complete', expectedVersion: 1 })
  assert.equal(act.success, true)
  const postWrite = a.tasks.list('co')
  await tick()
  a.server.release('/records/my-turn')
  await preWrite
  const after = await postWrite
  assert.equal(a.server.count('/records/my-turn'), 2)
  assert.ok(after.success && after.data.items.every(i => i.id !== 'task-aaaaabcdef'), 'the done task does not come back')

  // The renderer's reload after a press it made elsewhere (another feature's write): `fresh`.
  a.server.set({ myTurn: [task('bbbb')] })
  a.server.hold('/records/my-turn')
  const looking = a.tasks.list('co')
  await tick()
  a.server.set({ myTurn: [] })
  const fresh = a.tasks.list('co', { fresh: true })
  await tick()
  a.server.release('/records/my-turn')
  await looking
  const freshAnswer = await fresh
  assert.equal(a.server.count('/records/my-turn'), 4)
  assert.ok(freshAnswer.success && freshAnswer.data.items.length === 0)
})

test('an answer that arrives after sign-out is never shown or notified: neither the title bar nor the list uses it', async () => {
  const a = app()
  await a.watcher.watch('co')
  const shown = a.watcher.state('co')
  const changesBefore = a.told.notices
  a.server.set({ myTurn: [task('cccc', '前のアカウントのやること')] })
  a.server.hold('/records/my-turn')
  a.watcher.signal('co')
  const list = a.tasks.list('co')
  await tick()
  a.signOut()
  a.server.release('/records/my-turn')
  const r = await list
  await tick()
  assert.equal(r.success, false)
  assert.equal(a.told.notices, changesBefore)
  assert.deepEqual(a.watcher.state('co'), shown)
})

test('the watcher\'s 「もう 1 回」 is kept: a signal while it reads makes it read again after, and the newer answer is what shows', async () => {
  const a = app()
  await a.watcher.watch('co')
  a.server.hold('/records/my-turn')
  a.watcher.signal('co', true)
  await tick()
  // Another change while that read is on its way (main marks it at once, then signals).
  a.server.set({ myTurn: [task('dddd', '新しく来たやること')] })
  a.reads.changed('co')
  a.watcher.signal('co', true)
  a.server.release('/records/my-turn')
  await tick(20)
  a.server.release('/records/my-turn')
  await tick(20)
  assert.deepEqual(a.watcher.state('co').myTurn.items.map(i => i.title), ['新しく来たやること'])
})

test('notices alone never re-read the task list; a turn the watcher found changed without a records signal does, once', async () => {
  const a = app()
  await a.watcher.watch('co')
  assert.equal(a.told.turn, 0, 'the first look is not a change')
  // A notifications signal alone (a notice marked read on another PC): the bell changes, the turn does not.
  a.server.set({ notices: [{ id: 'n1', kind: 'request_done', text: '完了しました', recordId: 'task-eeeeabcdef', createdAt: '2026-11-19T00:00:00Z', read: false }] })
  a.watcher.signal('co')
  await tick(20)
  assert.ok(a.told.notices >= 1)
  assert.equal(a.told.turn, 0)
  // A records signal: main already sent records:changed, so the watcher says nothing more.
  a.server.set({ myTurn: [task('ffff')] })
  a.watcher.signal('co', true)
  await tick(20)
  assert.equal(a.told.turn, 0)
  // The 5-minute look finds the turn changed (a signal was lost): the list hears it once.
  a.server.set({ myTurn: [task('ffff'), task('gggg')] })
  a.timers[0]()
  await tick(20)
  assert.equal(a.told.turn, 1)
})

test('the received minutes found changed by a check (no records signal) tell the task list; a records signal\'s look does not', async () => {
  const a = app()
  await a.minutes.watch('co')
  assert.equal(a.told.aiTurn, 0)
  const meeting = { id: 'meeting-abcdef12', type: 'meeting', title: '定例', state: 'received', version: 3, fields: {} }
  a.server.set({ aiTurn: [meeting] })
  a.minutes.recordsSignal('co')
  await tick(20)
  assert.equal(a.told.aiTurn, 0)
  a.server.set({ aiTurn: [] })
  await a.minutes.checkNow('co')
  assert.equal(a.told.aiTurn, 1)
})

test('a look whose answer was discarded at a sign-out still runs the look the next account asked meanwhile (あなたの番 and the received minutes are not left empty)', async () => {
  const a = app()
  await a.watcher.watch('co')
  await a.minutes.watch('co')
  a.server.hold('/records/my-turn')
  a.server.hold('/records/ai-turn')
  // X's looks are on their way…
  a.watcher.signal('co', true)
  a.minutes.recordsSignal('co')
  await tick()
  // …X signs out, Y signs in and the app watches the company again.
  a.signOut()
  a.watcher.stop()
  a.minutes.stop()
  a.signIn(['s=Y'])
  a.server.set({ myTurn: [task('yyyy', 'Y さんのやること')], aiTurn: [{ id: 'meeting-yyyyyy12', type: 'meeting', title: 'Y さんの会議', state: 'received', version: 1, fields: {} }] })
  void a.watcher.watch('co')
  void a.minutes.watch('co')
  await tick()
  a.server.release('/records/my-turn')
  a.server.release('/records/ai-turn')
  await tick(30)
  assert.deepEqual(a.watcher.state('co').myTurn.items.map(i => i.title), ['Y さんのやること'])
  assert.deepEqual((await a.minutes.notices('co')).notices.map(n => n.title), ['Y さんの会議'])
})

test('today\'s calendar read again after the Google permission changed is fresh: never the read begun before the change', async () => {
  const a = app()
  a.server.hold('/me/calendar/today')
  const before = a.calendar.today('co')
  await tick()
  a.server.set({ calendarAllowed: true })
  const after = a.calendar.today('co', { fresh: true })
  await tick()
  a.server.release('/me/calendar/today')
  await before
  const r = await after
  assert.equal(a.server.count('/me/calendar/today'), 2)
  assert.ok(r.success && r.data.reason === null, 'the answer after the permission came')
})

test('the minutes permission coming or going tells the banner and the list (records:changed), as minutes:changed did', async () => {
  const a = app()
  await a.minutes.watch('co')
  assert.equal(a.told.aiTurn, 0)
  a.server.set({ granted: false })
  await a.minutes.checkNow('co')
  assert.equal(a.told.aiTurn, 1)
  await a.minutes.checkNow('co')
  assert.equal(a.told.aiTurn, 1, 'still off: nothing new')
  a.server.set({ granted: true })
  await a.minutes.checkNow('co')
  assert.equal(a.told.aiTurn, 2)
})
