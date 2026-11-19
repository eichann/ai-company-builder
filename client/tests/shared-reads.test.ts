// The two small helpers behind 「同じものを 1 回だけ聞く」 (plan 「問い合わせを減らす計画」 段1;
// ipc-and-main-process.md "Shared reads"): reads asked at the same moment share one request, and
// a burst of push signals is handled once — without ever using an answer that is too old or for
// someone else, and without letting a signal wait more than the bound.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInFlightReads } from '../electron/services/in-flight-reads'
import { COALESCE_MAX_MS, createBoundedCoalescer } from '../electron/services/bounded-coalescer'
import { createPushSignalFanout } from '../electron/services/push-signal-fanout'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise(r => setImmediate(r))

/** A read that counts its runs and answers only when told (`answer(n, value)`). */
function slowRead() {
  const runs: Array<{ resolve: (v: string) => void }> = []
  const run = () => { const d = deferred<string>(); runs.push(d); return d.promise }
  return { runs, run }
}

test('two consumers asking the same question at the same moment share one request; another company or question is its own', async () => {
  const reads = createInFlightReads(() => 'server|session')
  const r = slowRead()
  const a = reads.read('co-a', 'my-turn', r.run)
  const b = reads.read('co-a', 'my-turn', r.run)
  const other = reads.read('co-b', 'my-turn', r.run)
  const otherKey = reads.read('co-a', 'ai-turn', r.run)
  assert.equal(r.runs.length, 3)
  r.runs[0].resolve('turn of A')
  assert.deepEqual(await a, { discarded: false, value: 'turn of A' })
  assert.deepEqual(await b, { discarded: false, value: 'turn of A' })
  r.runs[1].resolve('x'); r.runs[2].resolve('y')
  await Promise.all([other, otherKey])
  // Settled: nothing kept, the next ask is a new request.
  void reads.read('co-a', 'my-turn', r.run)
  assert.equal(r.runs.length, 4)
})

test('a change while a read is on its way: whoever asks afterwards gets a read of their own at once (never waiting behind the older one), shared among them', async () => {
  const reads = createInFlightReads(() => 'server|session')
  const r = slowRead()
  const before = reads.read('co-a', 'my-turn', r.run)
  reads.changed('co-a')
  const after1 = reads.read('co-a', 'my-turn', r.run)
  const after2 = reads.read('co-a', 'my-turn', r.run)
  assert.equal(r.runs.length, 2, 'the read after the change starts at once, one for both who asked after it')
  r.runs[1].resolve('after the change')
  assert.deepEqual(await after1, { discarded: false, value: 'after the change' })
  assert.deepEqual(await after2, { discarded: false, value: 'after the change' })
  r.runs[0].resolve('before the change')
  // The older read settled last: who waited on it gets the newer answer, never the older one.
  assert.deepEqual(await before, { discarded: false, value: 'after the change' })
})

test('the older read settling first is answered as it was (it was right when asked); nothing is kept once all have settled', async () => {
  const reads = createInFlightReads(() => 'server|session')
  const r = slowRead()
  const before = reads.read('co-a', 'my-turn', r.run)
  reads.changed('co-a')
  const after = reads.read('co-a', 'my-turn', r.run)
  r.runs[0].resolve('before the change')
  assert.deepEqual(await before, { discarded: false, value: 'before the change' })
  r.runs[1].resolve('after the change')
  assert.deepEqual(await after, { discarded: false, value: 'after the change' })
  await tick()
  const next = slowRead()
  const again = reads.read('co-a', 'my-turn', next.run)
  assert.equal(next.runs.length, 1, 'asked again, not answered from memory')
  next.runs[0].resolve('later')
  assert.deepEqual(await again, { discarded: false, value: 'later' })
})

test('an answer that arrives after sign-out, another sign-in or a server change is discarded — for everyone who waited on it', async () => {
  let scope = 'server-1|session-1'
  const reads = createInFlightReads(() => scope)
  const r = slowRead()
  const a = reads.read('co-a', 'my-turn', r.run)
  const b = reads.read('co-a', 'my-turn', r.run)
  scope = 'server-1|' // signed out
  r.runs[0].resolve('the previous account\'s turn')
  assert.deepEqual(await a, { discarded: true })
  assert.deepEqual(await b, { discarded: true })
  // A new session never joins the old one's read.
  const old = reads.read('co-a', 'calendar', r.run)
  scope = 'server-1|session-2'
  void reads.read('co-a', 'calendar', r.run)
  assert.equal(r.runs.length, 3)
  scope = 'server-2|session-2'
  r.runs[1].resolve('old')
  assert.deepEqual(await old, { discarded: true })
})

test('A → B → A: the read for A asked again after a change wins even when the earlier one answers last, so A never goes back to the older answer', async () => {
  const reads = createInFlightReads(() => 'server|session')
  const r = slowRead()
  const shown: string[] = []
  const first = reads.read('co-a', 'list', r.run).then(x => { if (!x.discarded) shown.push(x.value) })
  void reads.read('co-b', 'list', r.run)
  reads.changed('co-a')
  const second = reads.read('co-a', 'list', r.run).then(x => { if (!x.discarded) shown.push(x.value) })
  r.runs[2].resolve('A (new)')
  await second
  r.runs[0].resolve('A (old)')
  await first
  assert.deepEqual(shown, ['A (new)', 'A (new)'])
})

test('a burst of signals for one company is handled once, within the window from the first; a steady stream is still handled every window (no starvation)', () => {
  const timers: Array<{ fn: () => void; at: number; cancelled?: boolean }> = []
  let now = 0
  const flushed: Array<{ key: string; at: number; kinds: string[] }> = []
  const c = createBoundedCoalescer<'records' | 'notifications'>({
    windowMs: 250,
    flush: (key, kinds) => flushed.push({ key, at: now, kinds: [...kinds].sort() }),
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t },
    clearTimeout: h => { (h as { cancelled?: boolean }).cancelled = true },
  })
  const advance = (to: number) => {
    for (;;) {
      const next = timers.filter(t => !t.cancelled && t.at <= to).sort((x, y) => x.at - y.at)[0]
      if (!next) break
      next.cancelled = true
      now = next.at
      next.fn()
    }
    now = to
  }
  // A signal every 50 ms for 1 s, records and notifications mixed.
  for (let t = 0; t < 1000; t += 50) {
    advance(t)
    c.push('co-a', t % 100 === 0 ? 'records' : 'notifications')
  }
  advance(2000)
  assert.ok(flushed.length >= 4, `handled every window, not starved (${flushed.length})`)
  let last = 0
  for (const f of flushed) {
    assert.ok(f.at - last <= 250 + 50, 'no signal waits longer than the window')
    last = f.at
  }
  assert.deepEqual(flushed[0], { key: 'co-a', at: 250, kinds: ['notifications', 'records'] })
  assert.throws(() => createBoundedCoalescer({ windowMs: COALESCE_MAX_MS + 1, flush: () => {} }), /1000/)
})

test('push signals: the change is marked at once, a burst of records + notifications re-reads once, notifications alone only the notices', () => {
  const timers: Array<() => void> = []
  const events: string[] = []
  const fanout = createPushSignalFanout({
    windowMs: 250,
    changed: c => events.push(`changed ${c}`),
    records: c => events.push(`records ${c}`),
    noticesOnly: c => events.push(`notices ${c}`),
    setTimeout: fn => { timers.push(fn); return fn },
    clearTimeout: () => {},
  })
  fanout.records('co-a')
  fanout.notifications('co-a')
  fanout.records('co-a')
  fanout.notifications('co-b')
  assert.deepEqual(events, ['changed co-a', 'changed co-a', 'changed co-a', 'changed co-b'], 'marked before any wait')
  for (const fn of timers.splice(0)) fn()
  assert.deepEqual(events.slice(4), ['records co-a', 'notices co-b'])
})

test('sign-out: push signals still waiting are dropped, never handled for the next account', () => {
  const timers: Array<{ fn: () => void; cancelled?: boolean }> = []
  const handled: string[] = []
  const fanout = createPushSignalFanout({
    windowMs: 250, changed: () => {}, records: c => handled.push(c), noticesOnly: c => handled.push(c),
    setTimeout: fn => { const t = { fn }; timers.push(t); return t },
    clearTimeout: h => { (h as { cancelled?: boolean }).cancelled = true },
  })
  fanout.records('co-a')
  fanout.stop()
  for (const t of timers) if (!t.cancelled) t.fn()
  assert.deepEqual(handled, [])
})
