/**
 * Main's requests through a window's page-less sessions (electron/features/browser/read-session.ts;
 * agent-browser.md "The operator and the preview", design memo §33 2-4): one lane per session name,
 * each request one chunk — prepare, request, clean-up — so a read given up half-way (its request
 * stopped) never has its late clean-up clear a newer read's login or connection, also when the window
 * was closed and opened again on the same partition. A fake session holds cookies and connections and
 * says what each request saw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserNotSentError, createSessionLanes, exactRead, throughSession, writeThroughSession, type PagelessSession } from '../electron/features/browser/read-session'
import { browserReadPartition, browserWritePartition } from '../shared/browser-operation'

/** One Electron session by name (the same object for a reopened window), with a slow clean-up when asked. */
function fakeSessions() {
  const store = new Map<string, { cookies: Set<string>; connections: number; log: string[] }>()
  const of = (name: string) => {
    let s = store.get(name)
    if (!s) { s = { cookies: new Set(), connections: 0, log: [] }; store.set(name, s) }
    return s
  }
  const open = (name: string, o: { cookie: string; slowWipeMs?: number; slowSendMs?: number }): PagelessSession => {
    const s = of(name)
    let wipes = 0
    return {
      async wipe() {
        wipes++
        // The clean-up after the request (every second wipe) is the slow one.
        if (o.slowWipeMs && wipes % 2 === 0) await new Promise(r => setTimeout(r, o.slowWipeMs))
        s.cookies.clear()
        s.connections = 0
        s.log.push(`wipe:${o.cookie}`)
      },
      async guard() { s.log.push(`guard:${o.cookie}`) },
      async copyCookies() { s.cookies.add(o.cookie); s.log.push(`copy:${o.cookie}`) },
      async send(request, signal) {
        s.connections++
        if (o.slowSendMs) await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, o.slowSendMs)
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
        })
        s.log.push(`send:${o.cookie}:${[...s.cookies].join(',')}`)
        return { status: 200, body: `${request.url} with ${[...s.cookies].join(',')}` }
      },
    }
  }
  return { open, of }
}

const allow = () => true
const URL_A = 'https://shop.example.net/a'

test('a read given up half-way still ends with its clean-up before the next read starts: the old clean-up never clears the new read\'s login', async () => {
  const lanes = createSessionLanes()
  const sessions = fakeSessions()
  const key = browserReadPartition('acb-browser-x')
  const old = sessions.open(key, { cookie: 'old', slowSendMs: 200, slowWipeMs: 100 })
  const stop = new AbortController()
  const first = throughSession(lanes, key, old, { method: 'GET', url: URL_A }, allow, stop.signal)
  await new Promise(r => setTimeout(r, 20))
  stop.abort()
  await assert.rejects(first, /aborted/)
  // The window is closed and opened again on the same partition: a new session object, the same lane.
  const fresh = sessions.open(key, { cookie: 'new' })
  const answer = await throughSession(lanes, key, fresh, { method: 'GET', url: URL_A }, allow)
  assert.equal(answer.body, `${URL_A} with new`, 'the new read had its own login, and only its own')
  const log = sessions.of(key).log
  assert.ok(log.lastIndexOf('wipe:old') < log.indexOf('wipe:new'), log.join(' '))
  assert.deepEqual(log.slice(log.indexOf('wipe:new')), ['wipe:new', 'guard:new', 'copy:new', 'send:new:new', 'wipe:new'])
  // Afterwards the session holds nothing.
  assert.equal(sessions.of(key).cookies.size, 0)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(lanes.busy(), [], 'a finished lane is let go')
})

test('reads of one session run one at a time; another session\'s lane is its own', async () => {
  const lanes = createSessionLanes()
  const sessions = fakeSessions()
  const read = browserReadPartition('acb-browser-y')
  const write = browserWritePartition('acb-browser-y')
  const a = throughSession(lanes, read, sessions.open(read, { cookie: 'a', slowSendMs: 50 }), { method: 'GET', url: URL_A }, allow)
  const b = throughSession(lanes, read, sessions.open(read, { cookie: 'b' }), { method: 'GET', url: URL_A }, allow)
  const w = throughSession(lanes, write, sessions.open(write, { cookie: 'w' }), { method: 'POST', url: URL_A, body: 'x=1' }, allow)
  assert.deepEqual((await Promise.all([a, b, w])).map(r => r.body), [`${URL_A} with a`, `${URL_A} with b`, `${URL_A} with w`])
  const log = sessions.of(read).log
  assert.ok(log.indexOf('send:a:a') < log.indexOf('wipe:b'), log.join(' '))
})

test('a request that fails still cleans its session up, and the lane goes on', async () => {
  const lanes = createSessionLanes()
  const sessions = fakeSessions()
  const key = browserReadPartition('acb-browser-z')
  const broken: PagelessSession = { ...sessions.open(key, { cookie: 'x' }), send: async () => { throw new Error('no answer') } }
  await assert.rejects(throughSession(lanes, key, broken, { method: 'GET', url: URL_A }, allow), /no answer/)
  assert.equal(sessions.of(key).log.at(-1), 'wipe:x')
  assert.equal((await throughSession(lanes, key, sessions.open(key, { cookie: 'y' }), { method: 'GET', url: URL_A }, allow)).status, 200)
})

test('a chunk whose window is no longer the one open when its turn comes sends nothing, and still cleans up', async () => {
  const lanes = createSessionLanes()
  const sessions = fakeSessions()
  const key = browserReadPartition('acb-browser-w')
  let open = true
  const slow = throughSession(lanes, key, sessions.open(key, { cookie: 'a', slowSendMs: 50 }), { method: 'GET', url: URL_A }, allow)
  const queued = throughSession(lanes, key, sessions.open(key, { cookie: 'b' }), { method: 'GET', url: URL_A }, allow, undefined, () => open)
  open = false
  await slow
  await assert.rejects(queued, /window closed/)
  const log = sessions.of(key).log
  assert.equal(log.some(l => l.startsWith('send:b')), false, log.join(' '))
  assert.equal(log.at(-1), 'wipe:b')
  // Closed while its chunk was being prepared: still nothing sent.
  let stillOpen = true
  const base = sessions.open(key, { cookie: 'c' })
  const closing: PagelessSession = { ...base, copyCookies: async url => { await base.copyCookies(url); stillOpen = false } }
  await assert.rejects(throughSession(lanes, key, closing, { method: 'GET', url: URL_A }, allow, undefined, () => stillOpen), /window closed/)
  assert.equal(sessions.of(key).log.some(l => l.startsWith('send:c')), false)
  assert.equal(sessions.of(key).cookies.size, 0)
})

test('a preview read lets through exactly its own address: GET, no added query, no body', () => {
  const rule = exactRead(URL_A)
  assert.equal(rule({ method: 'GET', url: URL_A }), true)
  assert.equal(rule({ method: 'HEAD', url: URL_A }), false)
  assert.equal(rule({ method: 'POST', url: URL_A, body: 'a=1' }), false)
  assert.equal(rule({ method: 'GET', url: `${URL_A}/b` }), false)
  assert.equal(rule({ method: 'GET', url: `${URL_A}?x=1` }), false, 'a query the read does not declare')
  assert.equal(rule({ method: 'GET', url: 'https://shop.example.net/elsewhere' }), false, 'a redirect\'s target or a page\'s part')
})

test('a declared read with a query lets through exactly the built address: no extra, reordered, changed, encoded or repeated parameter', () => {
  const built = 'https://shop.example.net/api/episodes?group=29529&page=1'
  const rule = exactRead(built)
  assert.equal(rule({ method: 'GET', url: built }), true)
  for (const url of [
    `${built}&x=1`, // an extra parameter
    'https://shop.example.net/api/episodes?page=1&group=29529', // reordered
    'https://shop.example.net/api/episodes?group=29530&page=1', // another value
    'https://shop.example.net/api/episodes?group=%32%39%35%32%39&page=1', // the same value, percent-encoded
    'https://shop.example.net/api/episodes?Group=29529&page=1', // another spelling of the name
    `${built}&page=2`, // a second page
    'https://shop.example.net/api/episodes?group=29529', // a parameter missing
    'https://shop.example.net/api/episodes', // no query
    `${built}#x`,
  ]) assert.equal(rule({ method: 'GET', url }), false, url)
  assert.equal(rule({ method: 'POST', url: built, body: 'a=1' }), false)
  // An address no declared read can have is never let through, even when asked for exactly.
  for (const url of [
    'https://shop.example.net/api/episodes?group=%32',
    'https://shop.example.net/api/episodes?group=1&group=2',
    'https://shop.example.net/api/episodes?group=1&GROUP=2',
    'https://shop.example.net/api/episodes?',
    'https://shop.example.net/api/episodes?_method=DELETE',
    'https://shop.example.net/api/episodes?q=a+b',
    'https://shop.example.net/api/episodes?a=1&b=2&c=3&d=4&e=5&f=6',
    'https://shop.example.net/a/../b',
  ]) assert.equal(exactRead(url)({ method: 'GET', url }), false, url)
})

// ---------------------------------------------------------------------------
// A run's write (6b-2c): prepared, then the permit, then the last check right before it leaves
// ---------------------------------------------------------------------------

/** A write session as the shell's: `send` asks `beforeSend` right before the request is ended. */
function writeSession(o: { failPrepare?: boolean; afterEnd?: 'answer' | 'error' } = {}) {
  const log: string[] = []
  const session: PagelessSession = {
    async wipe() { log.push('wipe') },
    async guard() { if (o.failPrepare) throw new Error('window closed'); log.push('guard') },
    async copyCookies() { log.push('cookies') },
    async send(_request, _signal, beforeSend) {
      let go = true
      if (beforeSend) { try { go = beforeSend() === true } catch { go = false } }
      if (!go) throw new BrowserNotSentError('stopped right before sending')
      log.push('end')
      if (o.afterEnd === 'error') throw new Error('connection reset')
      return { status: 302, body: '' }
    },
  }
  return { session, log }
}

const WRITE_REQUEST = { method: 'POST', url: URL_A, contentType: 'application/x-www-form-urlencoded', body: 'a=1' }

test('a run\'s write asks for the permit only once its session is prepared, and the last check right before it leaves', async () => {
  const { session, log } = writeSession()
  const outcome = await writeThroughSession(createSessionLanes(), 'w', session, WRITE_REQUEST, allow, {
    async ready() { log.push('permit'); return true },
    beforeSend() { log.push('last check'); return true },
  }, () => true)
  assert.deepEqual(outcome, { sent: true, answer: { status: 302, body: '' } })
  assert.deepEqual(log, ['wipe', 'guard', 'cookies', 'permit', 'last check', 'end', 'wipe'])
})

test('a write is "not sent" only when it provably never left: a failed preparation, no permit, the last check saying no or throwing', async () => {
  type Steps = { ready: () => Promise<boolean>; beforeSend: () => boolean }
  const cases: Array<[string, ReturnType<typeof writeSession>, Steps, string]> = [
    ['prepare', writeSession({ failPrepare: true }), { ready: async () => true, beforeSend: () => true }, 'prepare'],
    ['no permit', writeSession(), { ready: async () => false, beforeSend: () => true }, 'ready'],
    ['the permit throws', writeSession(), { ready: async () => { throw new Error('x') }, beforeSend: () => true }, 'ready'],
    ['the last check says no', writeSession(), { ready: async () => true, beforeSend: () => false }, 'before-send'],
    ['the last check throws', writeSession(), { ready: async () => true, beforeSend: () => { throw new Error('x') } }, 'before-send'],
  ]
  for (const [label, { session, log }, steps, stage] of cases) {
    assert.deepEqual(await writeThroughSession(createSessionLanes(), 'w', session, WRITE_REQUEST, allow, steps, () => true), { sent: false, stage }, label)
    assert.equal(log.includes('end'), false, label)
    assert.equal(log.at(-1), 'wipe', `${label}: cleared afterwards`)
  }
  // A window closed before, or while, the session was prepared: the permit is never asked.
  for (const openFor of [0, 1]) {
    let asked = false
    let looks = 0
    const closed = writeSession()
    assert.deepEqual(await writeThroughSession(createSessionLanes(), 'w', closed.session, WRITE_REQUEST, allow,
      { ready: async () => { asked = true; return true }, beforeSend: () => true }, () => looks++ < openFor), { sent: false, stage: 'prepare' })
    assert.equal(asked, false, `open for ${openFor} look(s)`)
  }
})

test('a failure after the request left is "sent, no answer" — never "not sent"', async () => {
  const { session, log } = writeSession({ afterEnd: 'error' })
  assert.deepEqual(await writeThroughSession(createSessionLanes(), 'w', session, WRITE_REQUEST, allow,
    { ready: async () => true, beforeSend: () => true }, () => true), { sent: true, answer: null })
  assert.ok(log.includes('end'))
})
