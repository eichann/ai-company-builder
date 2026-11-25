/**
 * 「記録する」 in the app (electron/features/browser/recording.ts; agent-browser.md "Recording"), with a stand-in window and
 * server. The site is fictional. Guards: a recording that cannot start, or whose window closes or loses its connection,
 * is discarded (nothing kept, nothing sent); one cannot start while the AI holds the window (its debugger owner says no)
 * or without this PC allowed or the site in the policy; nothing is sent before ［送る］ and only what the person kept;
 * this PC's key rides only on the send; sign-out discards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_RECORDING_MAIN_WORDS as W, createBrowserRecordings, createBrowserRecordingsHttp } from '../electron/features/browser/recording'
import type { BrowserRecordingObserver, BrowserRecordSurface } from '../shared/browser-recorder'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { browserRecordingProblem } from '../../shared/core/browser-recording'

const CO = 'co-1'
const HOST = 'shop.example.test'

function world(opts: { startOk?: boolean; mayRecord?: boolean; sites?: string[] } = {}) {
  let observer: BrowserRecordingObserver | null = null
  let stopped = 0
  const surface: BrowserRecordSurface = {
    async start(o) { if (opts.startOk === false) return false; observer = o; return true },
    async stop() { stopped++; observer = null },
    active: () => observer !== null,
  }
  const sent: Array<{ companyId: string; body: unknown }> = []
  let answer: 'ok' | 'refused' | 'none' = 'ok'
  const changed: string[] = []
  let user: string | null = 'u-1'
  const sites = opts.sites ?? [HOST]
  const recordings = createBrowserRecordings({
    windows: {
      open: (_c, host) => (sites.includes(host) ? { ok: true } : { ok: false, message: 'not allowed' }),
      recordWindow: (_c, host) => (sites.includes(host) ? surface : null),
    },
    userId: () => user,
    mayRecord: () => opts.mayRecord !== false,
    api: {
      async send(companyId, body) {
        sent.push({ companyId, body: JSON.parse(JSON.stringify(body)) })
        return answer === 'ok' ? { kind: 'ok' } : answer === 'refused' ? { kind: 'refused', message: 'このサイトは、いまは記録できません。' } : { kind: 'no-answer' }
      },
    },
    changed: companyId => changed.push(companyId),
  })
  const observe = (o: Parameters<BrowserRecordingObserver['observe']>[0]) => observer?.observe(o)
  const typed = (value: string) => observe({ kind: 'action', payload: JSON.stringify({ type: 'change', inputType: 'text', label: '受付終了日', name: 'end_date', value }) })
  return {
    recordings, sent, changed, observe, typed,
    end: (reason: 'closed' | 'lost') => observer?.ended(reason),
    answer: (a: typeof answer) => { answer = a },
    signOut: () => { user = null },
    stopped: () => stopped,
  }
}

test('a recording that cannot start is discarded: nothing kept, nothing sent, and the next start is possible', async () => {
  const w = world({ startOk: false })
  const r = await w.recordings.start(CO, HOST)
  assert.deepEqual(r, { ok: false, message: W.cannotStart })
  assert.equal(w.recordings.view(CO).state, 'none')
  assert.deepEqual(w.sent, [])
})

test('closing the window (or losing its connection) while recording discards the recording and tells the screen', async () => {
  for (const reason of ['closed', 'lost'] as const) {
    const w = world()
    assert.equal((await w.recordings.start(CO, HOST)).ok, true)
    w.typed('2026-12-03')
    w.end(reason)
    assert.deepEqual(w.recordings.view(CO), { state: 'none', message: reason === 'closed' ? W.closed : W.lost })
    assert.deepEqual(w.changed, [CO])
    // Nothing of it can be stopped, reviewed or sent any more.
    await w.recordings.stop(CO)
    await w.recordings.send(CO)
    assert.deepEqual(w.sent, [])
  }
})

test('no recording without this PC allowed, for a site the policy does not list, or while another one runs', async () => {
  assert.deepEqual(await world({ mayRecord: false }).recordings.start(CO, HOST), { ok: false, message: W.noPc })
  assert.equal((await world().recordings.start(CO, 'other.example.test')).ok, false)
  const w = world()
  await w.recordings.start(CO, HOST)
  assert.deepEqual(await w.recordings.start(CO, HOST), { ok: false, message: W.busy })
})

test('nothing is sent before ［送る］; the person\'s deleted lines never leave; a refusal keeps it for another try', async () => {
  const w = world()
  await w.recordings.start(CO, HOST)
  w.observe({ kind: 'page', url: `https://${HOST}/orders/48213` })
  w.typed('2026-12-03')
  w.observe({ kind: 'action', payload: JSON.stringify({ type: 'click', role: 'button', label: '保存' }) })
  const stopped = await w.recordings.stop(CO)
  assert.equal(w.stopped(), 1, 'the window is no longer observed once stopped')
  assert.ok(stopped.ok && stopped.view.state === 'review')
  const lines = stopped.ok && stopped.view.state === 'review' ? stopped.view.lines : []
  assert.deepEqual(lines.map(l => `${l.kind} ${l.text}`), ['ページ /orders/{n}', '入力した 「受付終了日」 (end_date) ＝ 値1', '押した 「保存」'])
  assert.deepEqual(w.sent, [])
  w.recordings.removeLine(CO, lines[1].id)
  w.answer('refused')
  const refused = await w.recordings.send(CO)
  assert.ok(refused.ok && refused.view.state === 'review' && refused.view.message?.includes('記録できません'))
  w.answer('ok')
  const done = await w.recordings.send(CO)
  assert.deepEqual(done, { ok: true, view: { state: 'none', message: W.sent } })
  assert.equal(w.sent.length, 2)
  const body = w.sent[1].body as { domain: string; content: { steps: Array<{ kind: string }> } }
  assert.equal(body.domain, HOST)
  assert.deepEqual(body.content.steps.map(s => s.kind), ['page', 'click'])
  assert.equal(JSON.stringify(body).includes('2026-12-03'), false)
  assert.equal(browserRecordingProblem(body.content, HOST), null)
})

test('sign-out discards every recording', async () => {
  const w = world()
  await w.recordings.start(CO, HOST)
  w.recordings.clear()
  assert.equal(w.recordings.view(CO).state, 'none')
  assert.equal(w.stopped(), 1)
})

test('this PC\'s key rides only on the send, with the session; nothing goes without a session', async () => {
  const seen: Request[] = []
  const http = createBrowserRecordingsHttp({
    baseUrl: () => 'https://acb.example.test', cookies: () => ['s=1'], deviceKey: () => 'v1.key',
    fetch: (async (url: string, init: RequestInit) => { seen.push(new Request(url, init)); return new Response(JSON.stringify({ success: true, data: {} }), { status: 201 }) }) as typeof fetch,
  })
  const content = { format: 1 as const, domain: HOST, steps: [{ id: 1, kind: 'page' as const, address: '/' }], hosts: [] }
  assert.deepEqual(await http.send(CO, { domain: HOST, content }), { kind: 'ok' })
  assert.equal(seen[0].headers.get(BROWSER_DEVICE_HEADER), 'v1.key')
  assert.equal(seen[0].headers.get('cookie'), 's=1')
  assert.equal(new URL(seen[0].url).pathname, `/api/companies/${CO}/browser-recordings`)
  const none = createBrowserRecordingsHttp({ baseUrl: () => 'https://acb.example.test', cookies: () => [], deviceKey: () => 'v1.key', fetch: (async () => { throw new Error('asked') }) as typeof fetch })
  assert.deepEqual(await none.send(CO, { domain: HOST, content }), { kind: 'no-answer' })
})

test('discarded or stopped while it is still starting: the window is let go once the start finishes (never left held)', async () => {
  for (const press of ['discard', 'stop'] as const) {
    let release: (ok: boolean) => void = () => {}
    let held = false
    const surface: BrowserRecordSurface = {
      start: () => new Promise<boolean>(resolve => { release = ok => { held = ok; resolve(ok) } }),
      async stop() { held = false },
      active: () => held,
    }
    const recordings = createBrowserRecordings({
      windows: { open: () => ({ ok: true }), recordWindow: () => surface },
      userId: () => 'u-1', mayRecord: () => true, api: { send: async () => ({ kind: 'ok' }) }, changed: () => {},
    })
    const starting = recordings.start(CO, HOST)
    await (press === 'discard' ? recordings.discard(CO) : recordings.stop(CO))
    release(true)
    assert.equal((await starting).ok, false)
    assert.equal(held, false, `${press}: the window is no longer held by a recording`)
    assert.equal(recordings.view(CO).state, 'none')
  }
})
