/**
 * The write runner of an opened line (generalization PR 5c; agent-browser.md "Writing on the new path";
 * `client/electron/features/browser/write-line-runner.ts`), against a fake Lステップ (answers made up from stage 0's key
 * sets, no real value), a fake of the plan routes that keeps the state table's order, a fake window that sends a write
 * only as the real shell does (the session prepared → `ready` → `beforeSend` → the run's gate on the request) and the
 * real read runner, map 1.0.4 and `landing_create` (handed in as approved; it is `pending` in the opened list). The
 * route's tag address and both writers are test data: the real ones wait for the owner's test write (PR 7).
 *
 * Guards (each test fails when its guard is removed or inverted; mutation-checked):
 * - no write leaves without its own permit, and every write is exactly the writer's request held to its mechanics;
 * - a write whose answer was lost is `unknown`: never sent again and no later write is ever asked or sent;
 * - stopping after write 1 (harmless prefix) leaves only the created action: the route is never created, the rest given back;
 * - a read after a write that differs from the prediction (or a created object that is not as planned) is never `done`;
 * - write 2 goes only to the id the server recorded for write 1 (`createdTarget`); another binding → not sent;
 * - the plan as the server fixed it must be what the card showed (hash, values, account, line); the reads again must
 *   equal what the person saw; this PC never runs a plan twice; the switch off asks nothing;
 * - an add_child (form) write carries exactly the declared keys with the plan's values.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../shared/core/fixed-content'
import type { BrowserMap } from '../../shared/core/browser-map'
import type { BrowserOpenedLine } from '../../shared/core/browser-opened'
import type { BrowserSuppliedValue } from '../../shared/core/browser-read-line'
import { lstepMap } from '../connector-maps/lstep'
import { LINES } from '../browser-lines/lstep'
import { createBrowserReadRunner, type BrowserThingAddress } from '../electron/features/browser/read-line-runner'
import { createBrowserWriteRunner, type BrowserWriteRunInput, type BrowserWriteRunnerDeps, type BrowserWriteRunSite } from '../electron/features/browser/write-line-runner'
import type { BrowserLinesAnswer, BrowserLineWritesApi } from '../electron/features/browser/lines-api'
import { FORM_TYPE, browserStoppedLists, browserWriteSentences, type BrowserLineWriter, type BrowserLineWriters } from '../shared/browser-line-writes'
import type { BrowserRunGateHooks, BrowserRunSurface, BrowserStepRecord, BrowserWriteOutcome } from '../shared/browser-runner'

const HOST = 'manager.linestep.net'
const CO = 'co-1'
const ACCOUNT = '90171'
const { map, reads, readers } = lstepMap()
const line = LINES.find(l => l.name === 'landing_create')!
const sha = (t: string) => `sha256:${createHash('sha256').update(t, 'utf8').digest('hex')}`

function mapShaped(thing: string, value: unknown, prefix = ''): unknown {
  const keys = map.things[thing].keys
  if (Array.isArray(value)) return value.map(v => mapShaped(thing, v, `${prefix}[]`))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (Object.prototype.hasOwnProperty.call(keys, p)) out[k] = mapShaped(thing, v, p)
  }
  return out
}
const landing = (over: Record<string, unknown> = {}) => ({
  name: '第1回の流入経路', qr_text: '', action_id: 7001, action_texts: [], prevent_default: 0, only_welcome: 0, cv_head: '', cv_body: '',
  group_id: 10, from_date: '', from_time: '', to_date: '2026-11-26', to_time: '17:00', out_of_period_message: '',
  latitude: null, longitude: null, radius: null, custom_params: [], only_once_param_sync: false, ...over,
})
const nulls = { member_query_id: null, send_member_query_id: null }
const action = (tags: number[], over: Record<string, unknown> = {}) => ({
  inputs: [{ type: 13, tag_ids: tags, ...nulls }, { type: 15, episode_id: '101', firetype: 1, ...nulls }, { type: 12, egg_id: '300', ...nulls }],
  aid: 1, a_twice_type: 1, a_name: null, funnel_descriptions: {}, group_id: null, ...over,
})

// --- a fake Lステップ: reads, and the two creates the test writers send ---

interface Site {
  landings: Map<string, Record<string, unknown>>
  actions: Map<string, Record<string, unknown>>
  tags: Map<string, Record<string, unknown>>
  account: string
  /** Every write that reached the site (method, path, body). */
  writes: Array<{ method: string; path: string; body: string }>
  nextId: number
  /** Per write path: lose the answer (it still lands), refuse it, or change what lands. */
  lose: Set<string>
  tamper?: (path: string, made: Record<string, unknown>) => void
  onWrite?: (path: string) => void
  /** Other things of a test map: reads and writes by exact address. */
  extraGet?: (address: string) => { status: number; body: string } | null
  extraPost?: Record<string, (body: string) => { status: number; body: string }>
}
function fakeSite(): Site {
  return {
    landings: new Map([['2597458', landing()]]), actions: new Map([['7001', action([21])]]), tags: new Map([['61', { id: 61, name: '参加者_20261203' }]]),
    account: ACCOUNT, writes: [], nextId: 8800, lose: new Set(),
  }
}
function get(site: Site, address: string): { status: number; body: string } {
  if (address === '/test-marker') return { status: 200, body: site.account }
  const extra = site.extraGet?.(address)
  if (extra) return extra
  let m = /^\/api\/landings\/(\d+)$/.exec(address)
  if (m && site.landings.has(m[1])) return { status: 200, body: JSON.stringify(mapShaped('landing', site.landings.get(m[1]))) }
  m = /^\/api\/actions\/(\d+)$/.exec(address)
  if (m && site.actions.has(m[1])) return { status: 200, body: JSON.stringify(mapShaped('action_set', site.actions.get(m[1]))) }
  m = /^\/test-tags\/(\d+)$/.exec(address)
  if (m && site.tags.has(m[1])) return { status: 200, body: JSON.stringify(site.tags.get(m[1])) }
  return { status: 404, body: '' }
}
function post(site: Site, path: string, body: string): { status: number; body: string } {
  site.writes.push({ method: 'POST', path, body })
  site.onWrite?.(path)
  const handler = site.extraPost?.[path]
  if (handler) return handler(body)
  const b = JSON.parse(body) as Record<string, unknown>
  const id = String(site.nextId++)
  if (path === '/test/actions') {
    const made = action([Number(b.tag)], { a_name: (site.actions.get(String(b.from)) as Record<string, unknown>).a_name })
    site.tamper?.(path, made)
    site.actions.set(id, made)
    return { status: 200, body: JSON.stringify({ aid: Number(id) }) }
  }
  const made = landing({ ...site.landings.get(String(b.from)), name: b.name, to_date: b.to_date, to_time: b.to_time, action_id: Number(b.action_id) })
  site.tamper?.(path, made)
  site.landings.set(id, made)
  return { status: 200, body: JSON.stringify({ id: Number(id) }) }
}

/** The test writers (the real ones come with the owner's test write): JSON bodies naming the original and the set fields. */
const WRITERS: BrowserLineWriters = {
  'action_set.create_from': {
    mechanics: { method: 'POST', path: '/test/actions', encoding: 'json' },
    async build({ original, set }) { return { request: { method: 'POST', path: '/test/actions', contentType: 'application/json', body: JSON.stringify({ from: original?.id, tag: set?.tags }) } } },
    createdId: a => String((JSON.parse(a.body) as { aid?: unknown }).aid ?? ''),
  },
  'landing.create_from': {
    mechanics: { method: 'POST', path: '/test/landings', encoding: 'json' },
    async build({ original, set }) { return { request: { method: 'POST', path: '/test/landings', contentType: 'application/json', body: JSON.stringify({ from: original?.id, ...set }) } } },
    createdId: a => String((JSON.parse(a.body) as { id?: unknown }).id ?? ''),
  },
}

const ADDRESSES: Record<string, BrowserThingAddress> = {
  landing: { kind: 'object', path: reads.landing.path },
  action_set: { kind: 'object', path: reads.action_set.path },
  tag: { kind: 'object', path: '/test-tags/{id}' },
}

// --- the window: writes only as the shell sends them, through the run's gate ---

interface Win { site: Site; closed: boolean; clean: boolean; hooks: BrowserRunGateHooks | null; mode: 'human' | 'ai'; gateRefused: number }
function fakeWindow(site: Site): Win & { run: BrowserRunSurface; preview: { read(a: string): Promise<{ status: number; body: string }>; closed(): boolean } } {
  const w: Win = { site, closed: false, clean: true, hooks: null, mode: 'human', gateRefused: 0 }
  const run: BrowserRunSurface = {
    async enterAi(hooks) { w.hooks = hooks; w.mode = 'ai'; return !w.closed },
    async leaveAi() { w.hooks = null; w.mode = 'human' },
    pageClean: () => w.clean && !w.closed,
    async request() { throw new Error('the write runner never reads through the run surface') },
    async write(r, steps): Promise<BrowserWriteOutcome> {
      if (w.closed || !w.hooks) return { sent: false, stage: 'prepare' }
      let go = false
      try { go = await steps.ready() } catch { go = false }
      if (!go) return { sent: false, stage: 'ready' }
      let last = false
      try { last = steps.beforeSend() } catch { last = false }
      if (!last) return { sent: false, stage: 'before-send' }
      // The request left: the session's one hook asks the run's gate (a refusal cancels it: no answer).
      const decision = w.hooks.sessionRequest({ method: r.method, url: `https://${HOST}${r.path}`, body: r.body })
      if (!decision.allow) { w.gateRefused++; return { sent: true, answer: null } }
      const answer = post(site, r.path, r.body)
      return site.lose.has(r.path) ? { sent: true, answer: null } : { sent: true, answer }
    },
    closed: () => w.closed,
  }
  const preview = { async read(a: string) { if (w.closed) throw new Error('closed'); return get(site, a) }, closed: () => w.closed }
  return Object.assign(w, { run, preview })
}

// --- a fake of the plan routes, keeping the state table's order (a permit per write, k only after k−1 done) ---

interface Api extends BrowserLineWritesApi {
  calls: string[]
  permits: number[]
  reports: Array<{ index: number; result: string; reason?: string; createdId?: string }>
  recorded: Map<number, string>
  /** Per write index: refuse its permit, or answer nothing. */
  permitAnswer?: (index: number) => BrowserLinesAnswer | null
  bindOther?: boolean
  claimContent?: (c: Record<string, unknown>) => Record<string, unknown>
}
function fakeApi(content: Record<string, unknown>): Api {
  const api: Api = {
    calls: [], permits: [], reports: [], recorded: new Map(),
    async createWrites() { return { kind: 'refused', code: null } },
    async get() { return { kind: 'refused', code: null } },
    async approve() { api.calls.push('approve'); return { kind: 'ok', value: {} } },
    async claim() {
      api.calls.push('claim')
      const fixed = canonicalJson(api.claimContent ? api.claimContent(content) : content)
      return { kind: 'ok', value: { executionId: `bw_${'a'.repeat(32)}`, secret: 's'.repeat(64), fixed: { content: fixed, contentHash: sha(canonicalJson(content)) } } }
    },
    async cancel() { api.calls.push('cancel'); return { kind: 'ok', value: {} } },
    async permit(_c, _e, _s, index) {
      api.calls.push(`permit:${index}`)
      const special = api.permitAnswer?.(index)
      if (special) return special
      if (index > 1 && api.reports.find(r => r.index === index - 1)?.result !== 'done') return { kind: 'refused', code: 'BROWSER_LINE_NOT_IN_ORDER' }
      api.permits.push(index)
      const target = index === 2 ? (api.bindOther ? '9999' : api.recorded.get(1) ?? null) : null
      return { kind: 'ok', value: { index, permittedAt: new Date().toISOString(), validMs: 5000, createdTarget: target } }
    },
    async report(_s, body) {
      api.calls.push(`report:${body.index}:${body.result}`)
      api.reports.push(body)
      if (body.createdId) api.recorded.set(body.index, body.createdId)
      return { kind: 'ok', value: { outcome: 'applied' } }
    },
    async confirm() { return { kind: 'ok', value: {} } },
  }
  return api
}

// --- the world ---

const person = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'person', confirmed: true } })
const siteFact = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'site_fact' } })
const VALUES = { source: siteFact('2597458'), tag: siteFact('61'), name: person('試験_20261203'), to_date: person('2026-12-03'), to_time: person('18:20') }
const REF = { site: 'lstep', line: line.name, version: line.version, mapVersion: map.version, meaningHash: 'sha256:' + '1'.repeat(64), mechanicsHash: 'sha256:' + '2'.repeat(64) }
const T0 = Date.parse('2026-11-25T03:00:00.000Z')

function world(opts: { line?: BrowserOpenedLine; map?: BrowserMap; writers?: BrowserLineWriters; addresses?: Record<string, BrowserThingAddress>; readers?: typeof readers; values?: Record<string, BrowserSuppliedValue>; site?: Site } = {}) {
  const site = opts.site ?? fakeSite()
  const win = fakeWindow(site)
  const theLine = opts.line ?? line
  const theMap = opts.map ?? map
  const theReaders = opts.readers ?? readers
  const values = opts.values ?? VALUES
  const content: Record<string, unknown> = {
    shape: 2, company: CO, user: 'u-alice', conversation: null, line: REF, values, writes: (theLine.writes ?? []).map(() => ({ kind: 'create' })),
    locks: ['k'], site: 'lstep', host: HOST, account: ACCOUNT, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 3_600_000).toISOString(),
  }
  const api = fakeApi(content)
  const records: BrowserStepRecord[] = []
  let now = T0
  let on = true
  let stopped = false
  const reader = createBrowserReadRunner({
    aiSwitch: () => on, stopped: () => stopped, window: () => win.preview, context: () => () => true, now: () => now,
  })
  const deps: BrowserWriteRunnerDeps = {
    aiSwitch: () => on, api, read: input => reader.run(input), stopped: () => stopped, allowed: () => true,
    window: () => (win.closed ? null : { run: win.run, preview: win.preview }), context: () => () => true,
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } }, now: () => now, monoMs: () => now, log: { warn: () => {} },
  }
  const runner = createBrowserWriteRunner(deps)
  const runSite: BrowserWriteRunSite = {
    host: HOST, ref: REF, line: theLine, lineStatus: 'approved', map: theMap, readers: theReaders, addresses: opts.addresses ?? ADDRESSES,
    account: { path: '/test-marker', read: (html: string) => html }, writers: opts.writers ?? WRITERS,
  }
  async function prepared() {
    const r = await reader.run({ companyId: CO, host: HOST, line: theLine, lineStatus: 'approved', map: theMap, readers: theReaders, addresses: runSite.addresses, account: runSite.account, values, expectedAccount: ACCOUNT })
    if (r.status !== 'judged') throw new Error(`not read: ${r.reason}`)
    assert.ok(r.ok, 'the card\'s read makes a plan')
    const before = Object.fromEntries(Object.entries(r.facts.reads).map(([k, v]) => [k, v.status === 'read' ? v.state : {}]))
    return { values, account: ACCOUNT, before }
  }
  const input = async (over: Partial<BrowserWriteRunInput> = {}): Promise<BrowserWriteRunInput> =>
    ({ companyId: CO, planId: `bl_${'b'.repeat(32)}`, contentHash: sha(canonicalJson(content)), site: runSite, prepared: await prepared(), ...over })
  return {
    site, win, api, records, runner, content, input,
    setNow: (t: number) => { now = t }, switchOff: () => { on = false }, stop: () => { stopped = true },
  }
}

test('landing_create runs in order: write 1 under its own permit, done with the action it created, then write 2 bound to that id', async () => {
  const w = world()
  const r = await w.runner.run(await w.input())
  assert.equal(r.outcome, 'succeeded')
  assert.deepEqual(r.states, ['done', 'done'])
  assert.deepEqual(w.api.calls, ['approve', 'claim', 'permit:1', 'report:1:done', 'permit:2', 'report:2:done'])
  assert.deepEqual(w.site.writes.map(x => x.path), ['/test/actions', '/test/landings'])
  assert.deepEqual(w.api.reports.map(x => x.createdId), ['8800', '8801'])
  // Write 2 set the route's action to what write 1 made (the server's recorded id).
  assert.equal(JSON.parse(w.site.writes[1].body).action_id, '8800')
  assert.equal(w.win.mode, 'human', 'the window always goes back')
})

test('no write leaves without its own permit: a refused permit, no answer, or a late one send nothing', async () => {
  for (const answer of [{ kind: 'refused', code: 'BROWSER_AI_STOPPED' } as BrowserLinesAnswer, { kind: 'no-answer' } as BrowserLinesAnswer]) {
    const w = world()
    w.api.permitAnswer = i => (i === 1 ? answer : null)
    const r = await w.runner.run(await w.input())
    assert.equal(w.site.writes.length, 0)
    assert.ok(r.outcome === 'stopped' || r.outcome === 'failed')
    // A refusal: the server settled it, nothing reported; no answer: not_sent reported.
    assert.deepEqual(w.api.reports.map(x => x.result), answer.kind === 'refused' ? [] : ['not_sent'])
  }
  // The permit came, but 5 s passed on the way: the last check says no.
  const w = world()
  const real = w.api.permit.bind(w.api)
  w.api.permit = async (...a) => { const x = await real(...a); w.setNow(T0 + 5_000); return x }
  const r = await w.runner.run(await w.input())
  assert.equal(r.outcome, 'failed')
  assert.equal(r.reason, 'permit-late')
  assert.equal(w.site.writes.length, 0)
})

test('the second write is never asked or sent after the first one\'s answer is lost (unknown); nothing is resent', async () => {
  const w = world()
  w.site.lose.add('/test/actions')
  const r = await w.runner.run(await w.input())
  assert.equal(r.outcome, 'unknown')
  assert.deepEqual(r.states, ['unknown', 'pending'])
  assert.equal(w.site.writes.length, 1, 'the lost write reached the site once and was never sent again')
  assert.deepEqual(w.api.calls, ['approve', 'claim', 'permit:1', 'report:1:unknown'])
  // This PC never runs the plan again.
  const again = await w.runner.run(await w.input())
  assert.equal(again.reason, 'already-ran')
  assert.equal(w.site.writes.length, 1)
})

test('a stop after write 1 (the harmless prefix) leaves only the created action: the route is never created, the rest given back', async () => {
  const w = world()
  const report = w.api.report.bind(w.api)
  w.api.report = async (s, body) => { const a = await report(s, body); if (body.index === 1) w.stop(); return a }
  const r = await w.runner.run(await w.input())
  assert.equal(r.outcome, 'stopped')
  assert.equal(r.reason, 'stopped')
  assert.deepEqual(r.states, ['done', 'pending'])
  assert.deepEqual(w.site.writes.map(x => x.path), ['/test/actions'])
  assert.equal(w.site.landings.size, 1, 'no route was created; the source route is untouched')
  assert.deepEqual(w.site.landings.get('2597458'), landing())
  assert.ok(w.api.calls.includes('cancel'))
  assert.ok(!w.api.calls.includes('permit:2'))
})

test('a read after a write that is not the prediction is never done: unknown, nothing more sent', async () => {
  // The new action kept the source's tag as well (a copy still on the source), the new route changed its time, the source moved.
  const tampers: Array<(s: Site) => void> = [
    s => { s.tamper = (p, made) => { if (p === '/test/actions') made.inputs = action([21, 61]).inputs } },
    s => { s.tamper = (p, made) => { if (p === '/test/landings') made.to_time = '17:00' } },
    s => { s.tamper = (p) => { if (p === '/test/actions') s.landings.set('2597458', landing({ name: '変わった' })) } },
  ]
  for (const t of tampers) {
    const w = world()
    t(w.site)
    const r = await w.runner.run(await w.input())
    assert.equal(r.outcome, 'unknown')
    assert.ok(!r.states.includes('done') || r.states[0] === 'done')
    assert.ok(w.api.reports.at(-1)?.result === 'unknown')
    assert.equal(w.api.reports.filter(x => x.result === 'done').length, r.states.filter(s => s === 'done').length)
  }
})

test('a create whose answer names no new id, or an id read before (the source itself), is never done', async () => {
  for (const createdId of [() => null, () => '7001', () => '0']) {
    const w = world({ writers: { ...WRITERS, 'action_set.create_from': { ...WRITERS['action_set.create_from'], createdId } } })
    const r = await w.runner.run(await w.input())
    assert.equal(r.outcome, 'unknown')
    assert.deepEqual(w.api.reports.map(x => x.result), ['unknown'])
    assert.equal(w.site.writes.length, 1)
  }
})

test('write 2 goes only to the id the server recorded for write 1: another binding is not sent', async () => {
  const w = world()
  w.api.bindOther = true
  const r = await w.runner.run(await w.input())
  assert.equal(r.outcome, 'partial')
  assert.equal(r.reason, 'created-target')
  assert.deepEqual(w.site.writes.map(x => x.path), ['/test/actions'])
  assert.deepEqual(w.api.reports.map(x => x.result), ['done', 'not_sent'])
})

test('the gate lets through only the armed request, byte for byte, once', async () => {
  const w = world({ writers: { ...WRITERS, 'action_set.create_from': { ...WRITERS['action_set.create_from'], async build({ original, set }) {
    // A writer whose request changes between the build and the send (it cannot: the gate holds the built bytes).
    const req = { method: 'POST', path: '/test/actions', contentType: 'application/json', body: JSON.stringify({ from: original?.id, tag: set?.tags }) }
    setTimeout(() => { req.body = JSON.stringify({ from: original?.id, tag: '9' }) }, 0)
    return { request: req }
  } } } })
  const real = w.win.run.write.bind(w.win.run)
  w.win.run.write = async (r, steps) => real({ ...r, body: r.body.replace('"61"', '"62"') }, steps)
  const r = await w.runner.run(await w.input())
  assert.equal(w.site.writes.length, 0, 'a body other than the armed one never reaches the site')
  assert.equal(w.win.gateRefused, 1)
  assert.equal(r.outcome, 'unknown', 'the request had left the app: never not_sent')
})

test('what the server fixed must be what the card showed, and the reads again what the person saw', async () => {
  const mismatch: Array<(c: Record<string, unknown>) => Record<string, unknown>> = [
    c => ({ ...c, account: '1' }),
    c => ({ ...c, values: { ...VALUES, name: person('別の名前') } }),
    c => ({ ...c, host: 'evil.example' }),
    c => ({ ...c, line: { ...REF, line: 'other' } }),
  ]
  for (const m of mismatch) {
    // The server's own draft differs from what main sent (its hash consistent with it, so only the fields tell).
    const w = world()
    Object.assign(w.content, m({ ...w.content }))
    const r = await w.runner.run(await w.input())
    assert.equal(r.reason, 'fixed-mismatch')
    assert.equal(w.site.writes.length, 0)
    assert.ok(w.api.calls.includes('cancel') && !w.api.calls.some(c => c.startsWith('permit')))
  }
  // A claim whose content does not hash to what the card showed.
  const x = world()
  x.api.claimContent = c => ({ ...c, account: '1' })
  assert.equal((await x.runner.run(await x.input())).reason, 'fixed-mismatch')
  assert.equal(x.site.writes.length, 0)
  const w = world()
  const input = await w.input()
  w.site.landings.set('2597458', landing({ to_time: '18:00' }))
  const r = await w.runner.run(input)
  assert.equal(r.reason, 'before-changed')
  assert.equal(w.site.writes.length, 0)
  // Another account in the window: the reads do not count.
  const v = world()
  const i2 = await v.input()
  v.site.account = '555'
  assert.equal((await v.runner.run(i2)).reason, 'read-failed')
  assert.equal(v.site.writes.length, 0)
})

test('nothing is asked with the switch off, a line not approved, or a write without its site\'s writer', async () => {
  const w = world()
  w.switchOff()
  assert.equal((await w.runner.run(await w.input().catch(() => ({} as BrowserWriteRunInput)))).reason, 'off')
  const x = world()
  const inp = await x.input()
  assert.equal((await x.runner.run({ ...inp, site: { ...inp.site, lineStatus: 'pending' } })).reason, 'not-approved')
  assert.equal((await x.runner.run({ ...inp, site: { ...inp.site, writers: { 'action_set.create_from': WRITERS['action_set.create_from'] } } })).reason, 'not-supported')
  assert.deepEqual(x.api.calls, [])
})

// --- one add_child (a form write), on a small example map ---

const CARD_MAP: BrowserMap = {
  site: 'lstep', version: '9.9.9', account: { label: 'アカウント' },
  things: {
    card: {
      label: 'カード', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, items: { kind: 'id_set', label: '入っているもの' } },
      keys: { id: 'required', items: 'required' }, must_hold: { account: true },
      writes: { add_child: { items: 'item' } }, delivers: 'none',
    },
    item: {
      label: 'もの', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' }, must_hold: { account: true },
    },
  },
} as BrowserMap
const CARD_LINE: BrowserOpenedLine = {
  name: 'card_add', version: '1.0.0', label: 'カードに足す',
  read: {
    site: 'lstep',
    values: { card: { kind: 'id', role: 'target', from: ['site_fact'] }, item: { kind: 'id', role: 'target', from: ['site_fact'] } },
    reads: [{ name: 'card', thing: 'card', id: { value: 'card' } }, { name: 'item', thing: 'item', id: { value: 'item' } }],
    checks: [],
  },
  writes: [{ read: 'card', verb: 'add_child', field: 'items', value: 'item' }],
  readLabels: { card: 'カード', item: '足すもの' },
  show: [],
}

test('an add_child is one form write: exactly the declared keys with the plan\'s values and the page\'s token; a writer adding a key is refused', async () => {
  const formWriter = (extra = '', tokenKey = '_token'): BrowserLineWriter => ({
    mechanics: { method: 'POST', path: '/test/cards/add', encoding: 'form', form: { card_id: '{id}', item_id: '{value}' }, ignoreBody: ['_token'] },
    async build({ ids, read }) {
      // The page's token, read through the window's read session (GET only).
      const page = await read('/test-cards/11/edit')
      const token = page?.body.match(/token=([a-z]+)/)?.[1]
      if (!token) return { problem: 'csrf-missing' }
      return { request: { method: 'POST', path: '/test/cards/add', contentType: FORM_TYPE, body: `card_id=${ids!.id}&item_id=${ids!.value}&${tokenKey}=${token}${extra}` } }
    },
  })
  const addresses: Record<string, BrowserThingAddress> = { card: { kind: 'object', path: '/test-cards/{id}' }, item: { kind: 'object', path: '/test-items/{id}' } }
  const make = (writer: BrowserLineWriter) => {
    const site = fakeSite()
    const card = { id: 11, items: [1] }
    site.extraGet = a => a === '/test-cards/11' ? { status: 200, body: JSON.stringify(card) }
      : a === '/test-items/22' ? { status: 200, body: JSON.stringify({ id: 22, name: 'もの22' }) }
        : a === '/test-cards/11/edit' ? { status: 200, body: '<form>token=abc</form>' } : null
    site.extraPost = { '/test/cards/add': () => { card.items.push(22); return { status: 302, body: '' } } }
    const cardReaders = {
      card: (a: unknown) => { const x = a as { id: number; items: number[] }; return { id: String(x.id), items: x.items.map(String) } },
      item: (a: unknown) => { const x = a as { id: number; name: string }; return { id: String(x.id), name: x.name } },
    } as typeof readers
    return world({ line: CARD_LINE, map: CARD_MAP, addresses, readers: cardReaders, writers: { 'card.add_child': writer }, values: { card: siteFact('11'), item: siteFact('22') }, site })
  }
  const good = make(formWriter())
  const r = await good.runner.run(await good.input())
  assert.equal(r.outcome, 'succeeded')
  assert.deepEqual(good.site.writes.map(x => x.body), ['card_id=11&item_id=22&_token=abc'])
  assert.deepEqual(good.api.calls, ['approve', 'claim', 'permit:1', 'report:1:done'])
  // A writer whose body carries one more key never gets a permit.
  const bad = make(formWriter('&extra=1'))
  const b = await bad.runner.run(await bad.input())
  assert.equal(b.reason, 'plan')
  assert.equal(bad.site.writes.length, 0)
  assert.ok(!bad.api.calls.some(c => c.startsWith('permit')))
  // …and one whose page field is another key (the same count of keys) likewise.
  const other = make(formWriter('', 'note'))
  assert.equal((await other.runner.run(await other.input())).reason, 'plan')
  assert.equal(other.site.writes.length, 0)
})

test('the stopped card (§16-3): a write in doubt is never under 「していないこと」, and nothing is offered to do by hand while one is in doubt', () => {
  const sentences = browserWriteSentences(line, map, { name: '試験_20261203', to_date: '2026-12-03', to_time: '18:20' })
  assert.equal(sentences.length, 2)
  assert.ok(sentences[1].includes('試験_20261203') && sentences[1].includes('新しいアクション'))
  const doubt = browserStoppedLists(sentences, ['done', 'unknown'])
  assert.deepEqual(doubt.done, [sentences[0]])
  assert.deepEqual(doubt.unknown, [sentences[1]])
  assert.deepEqual(doubt.notDone, [])
  assert.deepEqual(doubt.byHand, [])
  const partial = browserStoppedLists(sentences, ['done', 'pending'])
  assert.deepEqual(partial.notDone, [sentences[1]])
  assert.equal(partial.byHand.length, 1)
})
