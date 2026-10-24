import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AGENT_EVENTS_SEND_INTERVAL_MS, createAgentEventSender, safeSegment, type AgentEventSender, type SenderClock } from '../electron/services/agent-event-sender'
import { createSession } from '../electron/services/session'
import { parseAgentToolEvent, type AgentToolEvent } from '../../shared/types/agent-events'

// ---------------------------------------------------------------------------
// Fakes: a clock whose timers run only when the test advances it, and a
// server behind fetch whose answers the test scripts.
// ---------------------------------------------------------------------------

function fakeClock(start = Date.parse('2026-10-25T00:00:00Z')) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: SenderClock = {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(handle) { timers.delete(handle as number) },
  }
  return {
    clock,
    get now() { return now },
    set now(value: number) { now = value },
    /** Runs every timer due within `ms`, in time order. */
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = end
    },
    pendingTimers: () => timers.size,
  }
}

interface Call { url: string; cookie: string; events: AgentToolEvent[] }
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'network'

function fakeServer() {
  const calls: Call[] = []
  const answers: Answer[] = []
  let fallback: Answer = { status: 200 }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as AgentToolEvent[]
    calls.push({ url, cookie: String((init?.headers as Record<string, string>)?.Cookie ?? ''), events })
    const answer = answers.shift() ?? fallback
    if (answer === 'network') throw new TypeError('fetch failed')
    const body = answer.body ?? (answer.status < 300 ? { success: true, data: { accepted: events.length, duplicates: 0, rejected: 0 } } : { error: 'x' })
    return new Response(JSON.stringify(body), { status: answer.status, headers: answer.headers })
  }) as unknown as typeof fetch
  return {
    fetch: fetchFn,
    calls,
    answer(...next: Answer[]) { answers.push(...next) },
    setFallback(answer: Answer) { fallback = answer },
  }
}

let seq = 0
function event(over: Partial<AgentToolEvent> = {}): AgentToolEvent {
  seq++
  return {
    version: 1,
    id: `ev-${seq}-${randomUUID().slice(0, 8)}`,
    callId: `call-${seq}`,
    at: '2026-10-25T00:00:00.000Z',
    conversationId: 'conv-1',
    turnId: `turn-${seq}`,
    companyId: 'c1',
    agent: 'claude-code',
    tool: 'Read',
    category: 'read',
    target: { kind: 'file', path: '営業/提案.md' },
    decision: 'auto-allowed',
    outcome: 'ok',
    ...over,
  }
}

function setup(options: { user?: string | null; limits?: Parameters<typeof createAgentEventSender>[0]['limits']; dir?: string; fetch?: typeof fetch } = {}) {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'acb-agent-events-'))
  const time = fakeClock()
  const server = fakeServer()
  const session = createSession()
  const lines: string[] = []
  const signIn = (user: string) => {
    session.update([`better-auth.session_token=${user}-token.sig`])
    session.setUserId(user)
  }
  if (options.user !== null) signIn(options.user ?? 'u1')
  const make = () => createAgentEventSender({
    dir: () => dir,
    baseUrl: () => 'https://acb.example',
    cookies: session.cookies,
    userId: session.userId,
    fetch: options.fetch ?? server.fetch,
    clock: time.clock,
    log: { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) },
    limits: options.limits,
  })
  const sender = make()
  return { dir, time, server, session, sender, lines, signIn, make }
}

async function tick(sender: AgentEventSender, time: ReturnType<typeof fakeClock>, ms: number) {
  await sender.whenIdle()
  time.advance(ms)
  await sender.whenIdle()
}

const queueFile = (dir: string, user: string, company: string) => path.join(dir, safeSegment(user), `${safeSegment(company)}.jsonl`)
const readQueue = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: number; e: AgentToolEvent }) : []

// ---------------------------------------------------------------------------

test('events wait 60 s, then go out in one batch with the session cookie; sent events leave the disk', async () => {
  const { sender, server, time, dir } = setup()
  await sender.whenIdle()
  const a = event(); const b = event()
  sender.add(a); sender.add(b)
  await tick(sender, time, 1_000)
  // Written to disk first (0600 file in a 0700 folder), nothing sent yet.
  const file = queueFile(dir, 'u1', 'c1')
  assert.deepEqual(readQueue(file).map(l => l.e.id), [a.id, b.id])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(server.calls.length, 0)
  await tick(sender, time, 58_000)
  assert.equal(server.calls.length, 0, 'not before the minute')

  await tick(sender, time, 1_000)
  assert.equal(server.calls.length, 1)
  assert.equal(server.calls[0].url, 'https://acb.example/api/companies/c1/agent-events')
  assert.match(server.calls[0].cookie, /u1-token/)
  assert.deepEqual(server.calls[0].events.map(e => e.id), [a.id, b.id])
  // What goes out is what the server accepts, unchanged.
  for (const e of server.calls[0].events) assert.deepEqual(parseAgentToolEvent(e), e)

  await tick(sender, time, 1_000)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(sender.pending(), { 'u1/c1': 0 })
  // Nothing more to send: no further request.
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 1)
})

test('the interval is one minute; a turn end sends 2 s later; an empty queue never sends', async () => {
  assert.equal(AGENT_EVENTS_SEND_INTERVAL_MS, 60_000)
  const { sender, server, time } = setup()
  await sender.whenIdle()
  // Nothing waits: neither the turn end nor time sends anything.
  sender.turnEnded()
  await tick(sender, time, 5 * 60_000)
  assert.equal(server.calls.length, 0)

  sender.add(event()); sender.add(event())
  await tick(sender, time, 5_000)
  sender.turnEnded()
  await tick(sender, time, 1_000)
  assert.equal(server.calls.length, 0)
  await tick(sender, time, 1_000)
  assert.equal(server.calls.length, 1, 'two seconds after the turn ended')
  assert.equal(server.calls[0].events.length, 2)
  // The minute timer of those events does not fire a second request.
  await tick(sender, time, 5 * 60_000)
  assert.equal(server.calls.length, 1)

  // A turn end does not jump a backoff.
  server.answer('network')
  sender.add(event())
  sender.turnEnded()
  await tick(sender, time, 2_000)
  assert.equal(server.calls.length, 2)
  sender.turnEnded()
  await tick(sender, time, 2_000)
  assert.equal(server.calls.length, 2, 'still backing off')
  await tick(sender, time, 8_000)
  assert.equal(server.calls.length, 3)
})

test('the recorder passes the turn end to its sinks', async () => {
  const { createAgentEventRecorder } = await import('../electron/services/agent-events')
  let ended = 0
  const recorder = createAgentEventRecorder({ log: () => {}, sinks: [{ add() {}, turnEnded() { ended++ } }, { add() {} }] })
  recorder.turnEnded()
  assert.equal(ended, 1)
})

test('a full batch (200) goes out at once; batches never exceed 200', async () => {
  const { sender, server, time } = setup()
  await sender.whenIdle()
  for (let i = 0; i < 450; i++) sender.add(event())
  await tick(sender, time, 0)
  await tick(sender, time, 0)
  await tick(sender, time, 0)
  assert.deepEqual(server.calls.map(c => c.events.length), [200, 200])
  await tick(sender, time, 60_000)
  assert.deepEqual(server.calls.map(c => c.events.length), [200, 200, 50])
  assert.equal(new Set(server.calls.flatMap(c => c.events.map(e => e.id))).size, 450)
})

test('one queue per company; each batch goes to its own company', async () => {
  const { sender, server, time } = setup()
  await sender.whenIdle()
  sender.add(event({ companyId: 'c1' }))
  sender.add(event({ companyId: 'c2' }))
  sender.add(event({ companyId: 'c1' }))
  await tick(sender, time, 60_000)
  const byUrl = Object.fromEntries(server.calls.map(c => [c.url.split('/')[5], c.events.length]))
  assert.deepEqual(byUrl, { c1: 2, c2: 1 })
})

test('events with no signed-in account or no company are dropped, counted and logged once', async () => {
  const { sender, server, time, lines } = setup({ user: null })
  sender.add(event())
  sender.add(event())
  sender.add(event({ companyId: undefined }))
  await tick(sender, time, 20_000)
  assert.equal(server.calls.length, 0)
  assert.equal(sender.stats().droppedNoAccount, 3)
  assert.equal(lines.filter(l => l.includes('no signed-in account')).length, 1)
})

test('an account switch never mixes queues: the old account’s events wait for that account', async () => {
  const { sender, server, time, session, signIn, dir } = setup({ user: 'alice' })
  await sender.whenIdle()
  const fromAlice = event()
  sender.add(fromAlice)
  // Alice signs out before the send; Bob signs in on the same app.
  session.clear(); sender.signedOut()
  signIn('bob'); sender.sessionStarted()
  const fromBob = event()
  sender.add(fromBob)
  await tick(sender, time, 60_000)
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 1)
  assert.match(server.calls[0].cookie, /bob-token/)
  assert.deepEqual(server.calls[0].events.map(e => e.id), [fromBob.id])
  // Alice's event is still on disk, in her own folder.
  assert.deepEqual(readQueue(queueFile(dir, 'alice', 'c1')).map(l => l.e.id), [fromAlice.id])

  // Alice signs in again: now (and only now) her event goes, with her cookie.
  session.clear(); sender.signedOut()
  signIn('alice'); sender.sessionStarted()
  await tick(sender, time, 0)
  assert.equal(server.calls.length, 2)
  assert.match(server.calls[1].cookie, /alice-token/)
  assert.deepEqual(server.calls[1].events.map(e => e.id), [fromAlice.id])
})

test('a turn keeps the account it started under, even if another account signs in mid-turn', async () => {
  const { sender, server, time, session, signIn } = setup({ user: 'alice' })
  await sender.whenIdle()
  const first = event({ turnId: 'T' })
  sender.add(first)
  session.clear(); signIn('bob')
  const late = event({ turnId: 'T' })
  sender.add(late)
  // A turn that first reported while nobody was signed in is never filed.
  session.clear()
  const orphan = event({ turnId: 'U' })
  sender.add(orphan)
  signIn('bob')
  sender.add(event({ turnId: 'U' }))
  sender.sessionStarted()
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 0, 'alice is not signed in, bob has nothing of his own')
  assert.deepEqual(sender.pending(), { 'alice/c1': 2 })
  assert.equal(sender.stats().droppedNoAccount, 2)
})

test('the queue survives a restart; a torn last line is skipped and the file rewritten', async () => {
  const first = setup()
  await first.sender.whenIdle()
  const a = event(); const b = event()
  first.sender.add(a); first.sender.add(b)
  await tick(first.sender, first.time, 1_000)
  const file = queueFile(first.dir, 'u1', 'c1')
  // A crash in the middle of the next append.
  fs.appendFileSync(file, '{"t":1,"e":{"id":"tor')

  const second = setup({ dir: first.dir })
  second.server.setFallback('network') // keep them waiting, to look at the file
  second.sender.sessionStarted()
  await tick(second.sender, second.time, 1_000)
  assert.deepEqual(readQueue(file).map(l => l.e.id), [a.id, b.id], 'rewritten without the torn line')
  assert.ok(second.lines.some(l => l.includes('skipped 1 unreadable line')))
  assert.equal(second.server.calls.length, 1, 'events left from before are sent at sign-in, without waiting')
  second.server.setFallback({ status: 200 })
  const c = event()
  second.sender.add(c)
  await tick(second.sender, second.time, 20_000)
  assert.deepEqual(second.server.calls.slice(1).flatMap(x => x.events.map(e => e.id)), [a.id, b.id, c.id])
})

test('quit writes what was only in memory, synchronously; the next start sends it', async () => {
  const first = setup()
  const a = event(); const b = event()
  first.sender.add(a)
  await tick(first.sender, first.time, 1_000)
  first.sender.add(b)
  // b is only in memory (its write is 1 s away): quit appends it.
  first.sender.flushSync()
  const file = queueFile(first.dir, 'u1', 'c1')
  assert.deepEqual(readQueue(file).map(l => l.e.id), [a.id, b.id])
  // Nothing is sent or written after quit.
  first.sender.add(event())
  await tick(first.sender, first.time, 60_000)
  assert.equal(first.server.calls.length, 0)
  assert.equal(readQueue(file).length, 2)

  const second = setup({ dir: first.dir })
  second.sender.sessionStarted()
  await tick(second.sender, second.time, 0)
  await tick(second.sender, second.time, 0)
  assert.deepEqual(second.server.calls.flatMap(x => x.events.map(e => e.id)), [a.id, b.id])
})

test('quit while the queue file is still being read goes to a side file that the next start merges', async () => {
  const first = setup()
  const a = event()
  first.sender.add(a) // the queue's first read of its file is still running
  first.sender.flushSync()
  const file = queueFile(first.dir, 'u1', 'c1')
  assert.equal(readQueue(file + '.quit').length, 1)

  const second = setup({ dir: first.dir })
  second.sender.sessionStarted()
  await tick(second.sender, second.time, 0)
  await tick(second.sender, second.time, 1_000)
  assert.deepEqual(second.server.calls.flatMap(x => x.events.map(e => e.id)), [a.id])
  assert.equal(fs.existsSync(file + '.quit'), false)
})

test('caps: over the byte limit or older than 7 days, the oldest are dropped and counted', async () => {
  const { sender, time, lines, session } = setup({ limits: { maxQueueBytes: 3_000 } })
  await sender.whenIdle()
  session.clear() // offline-like: nothing is sent, everything waits
  sender.signedOut()
  // Events of an earlier turn keep their account.
  const owner = event({ turnId: 'keep' })
  session.update(['better-auth.session_token=u1-token.sig']); session.setUserId('u1')
  sender.add(owner)
  session.clear()
  for (let i = 0; i < 30; i++) sender.add(event({ turnId: 'keep' }))
  await tick(sender, time, 1_000)
  const waiting = sender.pending()['u1/c1']
  assert.ok(waiting > 0 && waiting < 31, `kept ${waiting}`)
  assert.equal(sender.stats().droppedCap, 31 - waiting)
  assert.ok(lines.some(l => /dropped the \d+ oldest event/.test(l)))

  // Age: 8 days later the next event pushes the old ones out.
  time.now += 8 * 24 * 60 * 60 * 1000
  sender.add(event({ turnId: 'keep' }))
  assert.equal(sender.pending()['u1/c1'], 1)
})

test('401: kept, no retries until the next sign-in', async () => {
  const { sender, server, time } = setup()
  await sender.whenIdle()
  server.answer({ status: 401 })
  sender.add(event())
  await tick(sender, time, 60_000)
  await tick(sender, time, 10 * 60_000)
  assert.equal(server.calls.length, 1)
  sender.sessionStarted()
  await tick(sender, time, 0)
  assert.equal(server.calls.length, 2)
  assert.deepEqual(sender.pending(), { 'u1/c1': 0 })
})

test('404 "not a member": the queue and its file are deleted; another 404 is retried later', async () => {
  const { sender, server, time, dir } = setup()
  await sender.whenIdle()
  server.answer({ status: 404, body: { error: 'Company not found or access denied' } })
  sender.add(event())
  await tick(sender, time, 1_000)
  const file = queueFile(dir, 'u1', 'c1')
  assert.ok(fs.existsSync(file))
  await tick(sender, time, 59_000)
  assert.deepEqual(sender.pending(), {})
  assert.equal(fs.existsSync(file), false)

  server.answer({ status: 404, body: { error: 'Not Found' } })
  sender.add(event({ companyId: 'c2' }))
  await tick(sender, time, 60_000)
  assert.deepEqual(sender.pending(), { 'u1/c2': 1 })
  await tick(sender, time, 5 * 60_000)
  assert.equal(server.calls.length, 3)
  assert.deepEqual(sender.pending(), { 'u1/c2': 0 })
})

test('413 / 400: the batch is halved; a single event still refused is dropped — never a loop', async () => {
  const bad = event()
  const fine = [event(), event(), event()]
  let requests = 0
  const sent: string[] = []
  // The server refuses any request that contains `bad`.
  const refuseBad = (async (_url: string, init?: RequestInit) => {
    requests++
    const ids = (JSON.parse(String(init?.body)).events as AgentToolEvent[]).map(e => e.id)
    if (ids.includes(bad.id)) return new Response('{"error":"x"}', { status: requests === 1 ? 413 : 400 })
    sent.push(...ids)
    return new Response(JSON.stringify({ success: true, data: { accepted: ids.length, duplicates: 0, rejected: 0 } }), { status: 200 })
  }) as unknown as typeof fetch
  const { sender, time } = setup({ fetch: refuseBad })
  await sender.whenIdle()
  for (const e of [fine[0], bad, fine[1], fine[2]]) sender.add(e)
  for (let i = 0; i < 10; i++) await tick(sender, time, 60_000)
  assert.deepEqual(sender.pending(), { 'u1/c1': 0 })
  assert.equal(sender.stats().droppedRejected, 1)
  // [4] 413 → [2] 400 → [1] ok → [2] 400 → [1] 400, dropped → [1] ok → [1] ok
  assert.ok(requests <= 7, `requests: ${requests}`)
  assert.deepEqual(sent.sort(), fine.map(e => e.id).sort())
})

test('2xx with rejected events: the batch is done and the count logged', async () => {
  const { sender, server, time, lines } = setup()
  await sender.whenIdle()
  server.answer({ status: 200, body: { success: true, data: { accepted: 1, duplicates: 0, rejected: 1 } } })
  sender.add(event()); sender.add(event())
  await tick(sender, time, 60_000)
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 1)
  assert.equal(sender.stats().droppedRejected, 1)
  assert.ok(lines.some(l => l.includes('refused 1 event')))
})

test('429 honours Retry-After', async () => {
  const { sender, server, time } = setup()
  await sender.whenIdle()
  server.answer({ status: 429, headers: { 'Retry-After': '120' } })
  sender.add(event())
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 1)
  await tick(sender, time, 119_000)
  assert.equal(server.calls.length, 1)
  await tick(sender, time, 1_000)
  assert.equal(server.calls.length, 2)
  assert.deepEqual(sender.pending(), { 'u1/c1': 0 })
})

test('network errors and 5xx back off exponentially up to 5 minutes; one request in flight', async () => {
  const { sender, server, time } = setup()
  await sender.whenIdle()
  server.setFallback('network')
  server.answer({ status: 503 })
  sender.add(event())
  const at: number[] = []
  const start = time.now
  for (let i = 0; i < 200; i++) {
    const before = server.calls.length
    await tick(sender, time, 5_000)
    if (server.calls.length > before) at.push((time.now - start) / 1000)
  }
  const gaps = at.slice(1).map((t, i) => t - at[i])
  // 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s (capped).
  assert.deepEqual(gaps.slice(0, 6), [10, 20, 40, 80, 160, 300])
  // Events added meanwhile do not start a second request.
  sender.add(event())
  assert.equal(server.calls.length, at.length)
  server.setFallback({ status: 200 })
  sender.sessionStarted() // a fresh sign-in retries at once
  await tick(sender, time, 0)
  assert.deepEqual(sender.pending(), { 'u1/c1': 0 })
})

test('signed out: no sending; the queue stays for the same account', async () => {
  const { sender, server, time, session, signIn } = setup()
  await sender.whenIdle()
  sender.add(event())
  session.clear(); sender.signedOut()
  await tick(sender, time, 60_000)
  assert.equal(server.calls.length, 0)
  signIn('u1'); sender.sessionStarted()
  await tick(sender, time, 0)
  assert.equal(server.calls.length, 1)
})

test('the session forgets the account when new cookies arrive, and only learns one with cookies', () => {
  const session = createSession()
  session.setUserId('a')
  assert.equal(session.userId(), null)
  session.update(['better-auth.session_token=x.y'])
  session.setUserId('a')
  assert.equal(session.userId(), 'a')
  session.update(['better-auth.session_token=z.w'])
  assert.equal(session.userId(), null)
  session.setUserId('b')
  session.clear()
  assert.equal(session.userId(), null)
})

test('safeSegment never yields a path separator or a dot name', () => {
  for (const id of ['..', '.', 'a/b', 'a\\b', 'ユーザー', 'x.y']) {
    const s = safeSegment(id)
    assert.ok(!s.includes('/') && !s.includes('\\') && !s.includes('.'), s)
    assert.equal(decodeURIComponent(s), id)
  }
})

test('logs never contain event contents', async () => {
  const { sender, server, time, lines } = setup()
  await sender.whenIdle()
  server.answer('network', { status: 413 }, { status: 400 })
  sender.add(event({ target: { kind: 'file', path: '人事/給与-秘密.md' } }))
  sender.add(event({ target: { kind: 'file', path: '人事/給与-秘密.md' } }))
  for (let i = 0; i < 6; i++) await tick(sender, time, 20_000)
  assert.ok(lines.length > 0)
  for (const line of lines) assert.ok(!line.includes('給与') && !line.includes('ev-'), line)
})
