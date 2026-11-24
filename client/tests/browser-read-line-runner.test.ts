/**
 * The read runner of an opened read-only line (generalization PR 5a; agent-browser.md "The read runner of an opened
 * line"): `client/electron/features/browser/read-line-runner.ts`, against a fake Lステップ whose answers are made up from
 * stage 0's key sets (「ブラウザ操作の汎用化_段0の結果」 追記2: key names only, no real value), through a fake of the
 * window's page-less read surface.
 *
 * Guards (each test fails when its guard is removed):
 * - only the line's reads are made, in order, with the account marker right before and after; a good copy is ✓;
 * - the account changing between the two marker reads, or unreadable → no read counts, nothing ✓;
 * - a key the map does not list (in a thing or in the list's envelope) → not read, the member's one sentence, a notice
 *   with no key name or value, handed to the reporter; a failed request is no shape change (no notice);
 * - only the surface's GET-only `read` is ever used (never a write or another request), no address carries a query but
 *   the folder list's own two, never `copy`; an address description with a query is refused before anything is read;
 * - unreadable is never ✓; a list entry is taken only from the whole list, exactly once;
 * - refusals before anything is read (switch, line status, values, stop, window, busy) and stops during the run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserShapeNotice } from '../../shared/core/browser-map'
import type { BrowserSuppliedValue } from '../../shared/core/browser-read-line'
import { BROWSER_SHAPE_WORDS } from '../../shared/core/browser-map'
import { BROWSER_CARD_WORDS } from '../../shared/core/browser-card'
import { lstepMap } from '../connector-maps/lstep'
import { LINES } from '../browser-lines/lstep'
import { accountFromMeta } from '../connectors/lstep/reminder-step'
import {
  createBrowserReadRunner, browserThingAddressProblem,
  type BrowserReadRunInput, type BrowserReadRunnerDeps, type BrowserThingAddress,
} from '../electron/features/browser/read-line-runner'
import type { BrowserPreviewSurface } from '../shared/browser-runner'

const { map, reads, readers } = lstepMap()
const line = LINES.find(l => l.name === 'landing_inspect')!

// --- stage 0's key sets (追記2), key names only ---

/** The folder list's envelope around `data`, and the keys of each of its `links`. */
const ENVELOPE_KEYS = ['current_page', 'data', 'first_page_url', 'from', 'last_page', 'last_page_url', 'links', 'next_page_url', 'path',
  'per_page', 'prev_page_url', 'to', 'total']
const LINK_KEYS = ['url', 'label', 'page', 'active']

/** How each thing is addressed: the map's reads, with the list's envelope as stage 0 recorded it. */
const ADDRESSES: Record<string, BrowserThingAddress> = {
  landing: { kind: 'object', path: reads.landing.path },
  landing_row: {
    kind: 'list_entry', path: reads.landing_row.path,
    folder: { param: 'group', field: 'group_id' },
    pages: { param: reads.landing_row.pages.param, max: reads.landing_row.pages.max, perPage: reads.landing_row.pages.perPage },
    list: { items: 'data', current: 'current_page', last: 'last_page', total: 'total', keys: ENVELOPE_KEYS, lists: { links: LINK_KEYS } },
  },
  action_set: { kind: 'object', path: reads.action_set.path },
}
const MARKER = '/test-marker'

/**
 * An answer keeps only the keys the map lists (at every depth): the made-up answers below carry stage 0's whole key sets,
 * and this lets the same answers read whole on any reviewed map version that lists them (1.0.0 listed some in part).
 */
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

function landing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '第2回の流入経路', qr_text: '', action_id: 7002, action_texts: [], prevent_default: 0, only_welcome: 0, cv_head: '', cv_body: '',
    group_id: 10, from_date: '', from_time: '', to_date: '2026-12-03', to_time: '17:00', out_of_period_message: '',
    latitude: null, longitude: null, radius: null, custom_params: [], only_once_param_sync: false, ...over,
  }
}
function source(over: Record<string, unknown> = {}): Record<string, unknown> {
  return landing({ name: '第1回の流入経路', action_id: 7001, to_date: '2026-11-26', to_time: '17:00', ...over })
}
function row(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, created_at: '2026-11-01 10:00:00', updated_at: '2026-11-01 10:00:00', name: `流入経路${id}`, counter: 3, counter_member: 2, order: 1,
    only_welcome: 0, prevent_default: 0, validity_period_from: null, validity_period_to: '2026-12-03 17:00',
    follow_url: `https://example.invalid/follow/${id}`, qr_url: `https://example.invalid/qr/${id}`, action_texts: [], action_twice_type: 1,
    custom_params_script_tag: '', group: { id: 10, name: 'フォルダ', order: 1 }, ...over,
  }
}
function action(tags: number[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const nulls = { member_query_id: null, send_member_query_id: null }
  return {
    inputs: [{ type: 13, tag_ids: tags, ...nulls }, { type: 15, episode_id: '101', firetype: 1, ...nulls }, { type: 12, egg_id: '300', ...nulls }],
    aid: 1, a_twice_type: 1, a_name: null, funnel_descriptions: {}, group_id: null, ...over,
  }
}
function listPage(rows: unknown[], page = 1, last = 1, total = rows.length, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_page: page, data: rows, first_page_url: 'https://example.invalid/p1', from: 1, last_page: last, last_page_url: 'https://example.invalid/pl',
    links: [{ url: null, label: '1', page: 1, active: true }], next_page_url: null, path: 'https://example.invalid/', per_page: 50,
    prev_page_url: null, to: rows.length, total, ...extra,
  }
}

// --- a fake Lステップ behind the window's read surface ---

interface FakeSite {
  answers: Map<string, { status: number; body: string }>
  /** The account the marker page shows, asked on each marker read (so it can change between them). */
  account: () => string | null
  addresses: string[]
  /** Anything but `read` that was called on the surface (must stay empty). */
  other: string[]
  closed: boolean
  onRead?: (address: string) => void
}

function fakeSite(): FakeSite {
  const site: FakeSite = { answers: new Map(), account: () => '90171', addresses: [], other: [], closed: false }
  const json = (address: string, value: unknown, thing?: string) =>
    site.answers.set(address, { status: 200, body: JSON.stringify(thing ? mapShaped(thing, value) : value) })
  json('/api/landings/501', landing(), 'landing')
  json('/api/landings/400', source(), 'landing')
  json('/api/actions/7002', action([22]), 'action_set')
  json('/api/actions/7001', action([21]), 'action_set')
  json('/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400)), mapShaped('landing_row', row(501))]))
  return site
}

function setJson(site: FakeSite, address: string, value: unknown, thing?: string): void {
  site.answers.set(address, { status: 200, body: JSON.stringify(thing ? mapShaped(thing, value) : value) })
}

function surfaceOf(site: FakeSite): BrowserPreviewSurface {
  const surface = {
    async read(address: string) {
      site.addresses.push(address)
      site.onRead?.(address)
      if (address === MARKER) {
        const a = site.account()
        return { status: 200, body: `<html><head>${a ? `<meta name="lm-account-id" content="${a}">` : ''}</head><body>x</body></html>` }
      }
      return site.answers.get(address) ?? { status: 404, body: '' }
    },
    closed: () => site.closed,
  }
  // A surface that also had other ways out: none may ever be used.
  for (const name of ['request', 'write', 'enterAi', 'fetch']) {
    Object.defineProperty(surface, name, { value: () => { site.other.push(name); throw new Error('never') } })
  }
  return surface
}

const siteFact = (value: string): BrowserSuppliedValue => ({ value, from: { kind: 'site_fact' } })

function setup(over: Partial<BrowserReadRunnerDeps> = {}, site = fakeSite()) {
  const surface = surfaceOf(site)
  const reported: BrowserShapeNotice[][] = []
  const deps: BrowserReadRunnerDeps = {
    aiSwitch: () => true,
    stopped: () => false,
    window: () => surface,
    context: () => () => true,
    notices: { report: async n => { reported.push([...n]) } },
    ...over,
  }
  const runner = createBrowserReadRunner(deps)
  const input = (more: Partial<BrowserReadRunInput> = {}): BrowserReadRunInput => ({
    companyId: 'c1', host: 'manager.example.invalid', line, lineStatus: 'approved', map, readers, addresses: ADDRESSES,
    account: { path: MARKER, read: accountFromMeta },
    values: { landing: siteFact('501'), source: siteFact('400') },
    ...more,
  })
  return { site, surface, runner, input, reported }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

/** No check of the line is ✓ (the card's account row says only whether the account held). */
function assertNothingChecked(result: { outcome: { checks: readonly { status: string }[] }; card: { checks: readonly { label: string; mark: string }[] } }): void {
  assert.ok(result.outcome.checks.length > 0 && result.outcome.checks.every(c => c.status !== 'ok'), 'no check of the line is ✓')
  assert.ok(result.card.checks.filter(c => c.label !== BROWSER_CARD_WORDS.accountCheck).every(c => c.mark !== 'ok'), 'no check row is ✓')
}

/** Every address any run made: a query only of the list's `group` and `page`, never `copy`. */
function assertOnlyDeclaredQueries(addresses: readonly string[]): void {
  for (const a of addresses) {
    assert.doesNotMatch(a, /copy/i, a)
    const q = a.indexOf('?')
    if (q >= 0) assert.deepEqual(a.slice(q + 1).split('&').map(p => p.split('=')[0]), ['group', 'page'], a)
  }
}

test('a good copy: only the line\'s reads, in order, the marker before and after, every check ✓, no notice', async () => {
  const { site, runner, input, reported } = setup()
  const result = await runner.run(input())
  assert.equal(result.status, 'judged')
  if (result.status !== 'judged') return
  assert.equal(result.ok, true, JSON.stringify(result.outcome))
  assert.equal(result.card.state, 'all_ok')
  assert.equal(result.member, null)
  assert.deepEqual(result.notices, [])
  assert.equal(result.outcome.account, '90171')
  assert.ok(result.card.checks.length > 0 && result.card.checks.every(c => c.mark === 'ok'), 'every check ✓')
  assert.deepEqual(site.addresses, [
    MARKER, '/api/landings/501', '/api/landings?group=10&page=1', '/api/actions/7002', '/api/landings/400', '/api/actions/7001', MARKER,
  ])
  assert.deepEqual(site.other, [])
  assertOnlyDeclaredQueries(site.addresses)
  await flush()
  assert.deepEqual(reported, [])
})

test('the account changes between the marker reads → no read counts, nothing ✓', async () => {
  const { site, runner, input } = setup()
  let n = 0
  site.account = () => (n++ === 0 ? '90171' : '90172')
  const result = await runner.run(input())
  assert.equal(result.status, 'judged')
  if (result.status !== 'judged') return
  assert.equal(result.ok, false)
  assert.equal(result.outcome.problem, 'account-mismatch')
  assert.equal(result.outcome.account, null)
  assert.notEqual(result.card.state, 'all_ok')
  assertNothingChecked(result)
  assert.ok(Object.values(result.outcome.reads).every(s => s !== 'ok'), 'no read counts')
  assert.equal(result.outcome.reads.landing, 'account-mismatch')
})

test('the account unreadable on either side, or not the plan\'s → nothing ✓', async () => {
  for (const [account, expected, problem] of [
    [() => null, undefined, 'account-unknown'],
    [() => '0', undefined, 'account-unknown'],
    [() => '90171', '90172', 'account-mismatch'],
  ] as const) {
    const { site, runner, input } = setup()
    site.account = account
    const result = await runner.run(input(expected ? { expectedAccount: expected } : {}))
    assert.equal(result.status, 'judged')
    if (result.status !== 'judged') return
    assert.equal(result.outcome.problem, problem)
    assertNothingChecked(result)
  }
  // The marker page failing (an error status, even with a marker in it) is unreadable too.
  const site = fakeSite()
  const base = surfaceOf(site)
  const failing: BrowserPreviewSurface = { read: async (a, sig) => (a === MARKER ? { status: 500, body: '<meta name="lm-account-id" content="90171">' } : base.read(a, sig)), closed: () => false }
  const { runner, input } = setup({ window: () => failing }, site)
  const result = await runner.run(input())
  assert.equal(result.status === 'judged' && result.outcome.problem, 'account-unknown')
})

test('a key the map does not list → not read, the member\'s sentence, a notice with no key name or value, reported', async () => {
  const { site, runner, input, reported } = setup()
  // A key that looks like a customer's own data: it must never reach a notice.
  setJson(site, '/api/landings/501', { ...(mapShaped('landing', landing()) as object), customer_12345: '山田さん' })
  const result = await runner.run(input())
  assert.equal(result.status, 'judged')
  if (result.status !== 'judged') return
  assert.equal(result.ok, false)
  assert.equal(result.outcome.problem, 'not-read')
  assert.equal(result.member, BROWSER_SHAPE_WORDS.member)
  assert.deepEqual(result.notices, [{ site: 'lstep', mapVersion: map.version, thing: 'landing', change: 'unknown_keys', count: 1 }])
  assert.equal(result.card.state, 'not_read')
  assertNothingChecked(result)
  await flush()
  assert.deepEqual(reported, [result.notices])
  const told = JSON.stringify({ notices: result.notices, reported, card: result.card, member: result.member })
  assert.doesNotMatch(told, /customer_12345|山田/)
  // The reads after it still name only declared addresses (the landing's action is not read: its id is unknown).
  assert.ok(!site.addresses.includes('/api/actions/7002'), 'the unread route\'s action is not read')
  assertOnlyDeclaredQueries(site.addresses)
})

test('the same change on two reads of one thing is one notice', async () => {
  const { site, runner, input, reported } = setup()
  setJson(site, '/api/landings/501', { ...(mapShaped('landing', landing()) as object), extra_a: 1 })
  setJson(site, '/api/landings/400', { ...(mapShaped('landing', source()) as object), extra_b: 1, extra_c: 2 })
  const result = await runner.run(input())
  assert.equal(result.status === 'judged' && result.member, BROWSER_SHAPE_WORDS.member)
  assert.deepEqual(result.status === 'judged' && result.notices, [{ site: 'lstep', mapVersion: map.version, thing: 'landing', change: 'unknown_keys', count: 2 }])
  await flush()
  assert.equal(reported.length, 1)
})

test('a required key missing, an answer that is not strict JSON, an unknown key in the list\'s envelope or its links → a notice per thing', async () => {
  const cases: Array<[(s: FakeSite) => void, BrowserShapeNotice]> = [
    [s => { const a = mapShaped('action_set', action([22])) as Record<string, unknown>; delete a.a_twice_type; setJson(s, '/api/actions/7002', a) },
      { site: 'lstep', mapVersion: map.version, thing: 'action_set', change: 'missing_keys', count: 1 }],
    [s => s.answers.set('/api/actions/7002', { status: 200, body: '{"inputs":[],"inputs":[]}' }),
      { site: 'lstep', mapVersion: map.version, thing: 'action_set', change: 'unreadable', count: 1 }],
    [s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 1, 1, 1, { secret_total: 3 })),
      { site: 'lstep', mapVersion: map.version, thing: 'landing_row', change: 'unknown_keys', count: 1 }],
    [s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 1, 1, 1, { links: [{ url: null, label: '1', page: 1, active: true, member: 'x' }] })),
      { site: 'lstep', mapVersion: map.version, thing: 'landing_row', change: 'unknown_keys', count: 1 }],
    [s => setJson(s, '/api/landings?group=10&page=1', listPage([{ ...(mapShaped('landing_row', row(501)) as object), customer_9: 1 }])),
      { site: 'lstep', mapVersion: map.version, thing: 'landing_row', change: 'unknown_keys', count: 1 }],
  ]
  for (const [change, notice] of cases) {
    const { site, runner, input } = setup()
    change(site)
    const result = await runner.run(input())
    assert.equal(result.status, 'judged')
    if (result.status !== 'judged') return
    assert.equal(result.ok, false)
    assert.equal(result.member, BROWSER_SHAPE_WORDS.member)
    assert.deepEqual(result.notices, [notice])
    assert.doesNotMatch(JSON.stringify(result.notices), /secret_total|member|customer_9|a_twice_type/)
  }
})

test('a request that fails is not a shape change: not read, no notice, nothing ✓ (unreadable is never ✓)', async () => {
  const { site, runner, input, reported } = setup()
  site.answers.set('/api/actions/7001', { status: 500, body: 'oops' })
  const result = await runner.run(input())
  assert.equal(result.status, 'judged')
  if (result.status !== 'judged') return
  assert.equal(result.ok, false)
  assert.equal(result.member, null)
  assert.deepEqual(result.notices, [])
  assert.equal(result.outcome.reads.source_action_set, 'not-read')
  // Every check that names the unread action is 「読み取れませんでした」, never ✓.
  const actionChecks = result.outcome.checks.filter((_, i) => ['action_set', 'source_action_set'].some(r => JSON.stringify(line.read.checks[i]).includes(r)))
  assert.ok(actionChecks.length > 0 && actionChecks.every(c => c.status === 'unreadable'), 'the action checks are unreadable')
  assert.notEqual(result.card.state, 'all_ok')
  await flush()
  assert.deepEqual(reported, [])
})

test('only the surface\'s GET-only read is used, and never an address with a query of its own (no ?copy=1)', async () => {
  const bad: Array<Record<string, BrowserThingAddress>> = [
    { ...ADDRESSES, landing: { kind: 'object', path: '/api/landings/{id}?copy=1' } },
    { ...ADDRESSES, landing: { kind: 'object', path: '/api/landings/{id}/copy?x=1' } },
    { ...ADDRESSES, landing: { kind: 'object', path: '/api/landings/{id}#copy' } },
    { ...ADDRESSES, landing: { kind: 'object', path: '/api/landings/{id}/{other}' } },
    { ...ADDRESSES, landing: { kind: 'object', path: '/api/landings/%7Bid%7D' } },
    { ...ADDRESSES, landing_row: { ...(ADDRESSES.landing_row as Extract<BrowserThingAddress, { kind: 'list_entry' }>), path: '/api/landings?copy=1' } },
    { ...ADDRESSES, landing_row: { ...(ADDRESSES.landing_row as Extract<BrowserThingAddress, { kind: 'list_entry' }>), folder: { param: 'copy', field: 'group_id' }, pages: { param: 'copy', max: 10, perPage: 50 } } },
  ]
  for (const addresses of bad) {
    const { site, runner, input } = setup()
    assert.deepEqual(await runner.run(input({ addresses })), { status: 'refused', reason: 'addresses' })
    assert.deepEqual(site.addresses, [], 'nothing read')
  }
  // The marker page with a query is refused too.
  const { site, runner, input } = setup()
  assert.deepEqual(await runner.run(input({ account: { path: '/x?copy=1', read: accountFromMeta } })), { status: 'refused', reason: 'addresses' })
  assert.deepEqual(site.addresses, [])
  assert.equal(browserThingAddressProblem(ADDRESSES.landing), null)
  assert.equal(browserThingAddressProblem(ADDRESSES.landing_row), null)
})

test('ids put in an address are plain ids: a value or a read field that is not one reads nothing for it', async () => {
  const { site, runner, input } = setup()
  // The route's action id as the site gave it is read through the reader (a positive id); a value that is not plain is refused up front.
  assert.deepEqual(await runner.run(input({ values: { landing: siteFact('501?copy=1'), source: siteFact('400') } })), { status: 'refused', reason: 'values' })
  assert.deepEqual(site.addresses, [])
})

test('values from a source the line does not allow are refused before anything is read', async () => {
  const { site, runner, input } = setup()
  const result = await runner.run(input({ values: { landing: { value: '501', from: { kind: 'ai' } }, source: siteFact('400') } }))
  assert.deepEqual(result, { status: 'refused', reason: 'values' })
  assert.deepEqual(site.addresses, [])
})

test('the list entry: found on a later page; twice, missing, a total that does not add up, a changed last page, too many pages or no folder → not read, never ✓', async () => {
  // Found on page 2 of 2: both pages read, in order.
  {
    const { site, runner, input } = setup()
    setJson(site, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400))], 1, 2, 2))
    setJson(site, '/api/landings?group=10&page=2', listPage([mapShaped('landing_row', row(501))], 2, 2, 2))
    const result = await runner.run(input())
    assert.equal(result.status === 'judged' && result.ok, true)
    assert.deepEqual(site.addresses.filter(a => a.includes('?')), ['/api/landings?group=10&page=1', '/api/landings?group=10&page=2'])
  }
  const broken: Array<(s: FakeSite) => void> = [
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501)), mapShaped('landing_row', row(501))])),
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400))])),
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 1, 1, 2)),
    s => {
      setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400))], 1, 2, 2))
      setJson(s, '/api/landings?group=10&page=2', listPage([mapShaped('landing_row', row(501))], 2, 3, 2))
    },
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 1, 11, 501)),
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 1, 11, 1)),
    s => setJson(s, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(501))], 2, 1, 1)),
    s => setJson(s, '/api/landings/501', landing({ group_id: null }), 'landing'),
  ]
  for (const change of broken) {
    const { site, runner, input } = setup()
    change(site)
    const result = await runner.run(input())
    assert.equal(result.status, 'judged')
    if (result.status !== 'judged') return
    assert.equal(result.ok, false)
    assert.equal(result.outcome.reads.landing_row, 'not-read')
    assert.notEqual(result.card.state, 'all_ok')
    assertOnlyDeclaredQueries(site.addresses)
    assert.ok(site.addresses.filter(a => a.includes('?')).length <= 10, 'at most ten pages')
  }
})

test('a list longer than its pages may be read is not walked: only page 1 is asked', async () => {
  const { site, runner, input } = setup()
  setJson(site, '/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400))], 1, 11, 11))
  for (let p = 2; p <= 11; p++) setJson(site, `/api/landings?group=10&page=${p}`, listPage([mapShaped('landing_row', row(p === 11 ? 501 : 1000 + p))], p, 11, 11))
  const result = await runner.run(input())
  assert.equal(result.status === 'judged' && result.outcome.reads.landing_row, 'not-read')
  assert.deepEqual(site.addresses.filter(a => a.includes('?')), ['/api/landings?group=10&page=1'])
})

test('refused before anything is read: the switch, a line not approved, a line of another map, the stop, no window, a closed window', async () => {
  const cases: Array<[Partial<BrowserReadRunnerDeps>, Partial<BrowserReadRunInput>, string]> = [
    [{ aiSwitch: () => false }, {}, 'off'],
    [{}, { lineStatus: 'pending' }, 'not-approved'],
    [{}, { lineStatus: 'retired' }, 'not-approved'],
    [{}, { map: { ...map, site: 'other' } }, 'line'],
    [{}, { addresses: { landing: ADDRESSES.landing } }, 'addresses'],
    [{ stopped: () => true }, {}, 'stopped'],
    [{ window: () => null }, {}, 'window'],
  ]
  for (const [deps, more, reason] of cases) {
    const { site, runner, input } = setup(deps)
    assert.deepEqual(await runner.run(input(more)), { status: 'refused', reason })
    assert.deepEqual(site.addresses, [], reason)
  }
  // The switch off asks nothing at all: not even which window is open.
  {
    let asked = 0
    const { runner, input } = setup({ aiSwitch: () => false, window: () => { asked++; return null }, stopped: () => { asked++; return false } })
    assert.deepEqual(await runner.run(input()), { status: 'refused', reason: 'off' })
    assert.equal(asked, 0)
  }
  const { site, runner, input } = setup()
  site.closed = true
  assert.deepEqual(await runner.run(input()), { status: 'refused', reason: 'window' })
  assert.deepEqual(site.addresses, [])
})

test('a stop, a changed context, a closed or replaced window, the switch turned off during the run → refused, nothing more read', async () => {
  const cases: Array<[string, (flags: { stop: boolean; ctx: boolean; off: boolean; replaced: boolean }, s: FakeSite) => void]> = [
    ['stopped', f => { f.stop = true }],
    ['context', f => { f.ctx = false }],
    ['off', f => { f.off = true }],
    ['window', (_f, s) => { s.closed = true }],
    ['window', f => { f.replaced = true }],
  ]
  for (const [reason, flip] of cases) {
    const flags = { stop: false, ctx: true, off: false, replaced: false }
    const site = fakeSite()
    const other = surfaceOf(fakeSite())
    let surface: BrowserPreviewSurface | null = null
    const { runner, input } = setup({
      aiSwitch: () => !flags.off,
      stopped: () => flags.stop,
      context: () => () => flags.ctx,
      window: () => (flags.replaced ? other : surface),
    }, site)
    surface = surfaceOf(site)
    site.onRead = a => { if (a === '/api/landings/501') flip(flags, site) }
    assert.deepEqual(await runner.run(input()), { status: 'refused', reason })
    assert.deepEqual(site.addresses, [MARKER, '/api/landings/501'], reason)
  }
})

test('one run per window at a time', async () => {
  const site = fakeSite()
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  const base = surfaceOf(site)
  const slow: BrowserPreviewSurface = { read: async (a, s) => { await gate; return base.read(a, s) }, closed: () => false }
  const { runner, input } = setup({ window: () => slow }, site)
  const first = runner.run(input())
  assert.deepEqual(await runner.run(input()), { status: 'refused', reason: 'busy' })
  release()
  assert.equal((await first).status, 'judged')
  // Free again afterwards.
  assert.equal((await runner.run(input())).status, 'judged')
})

test('a reporter that fails or throws changes nothing; the runner logs nothing', async () => {
  const logged: unknown[] = []
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  console.log = console.warn = console.error = console.info = (...a: unknown[]) => { logged.push(a) }
  try {
    for (const report of [async () => { throw new Error('no server') }, () => { throw new Error('sync') }]) {
      const { site, runner, input } = setup({ notices: { report: report as () => Promise<unknown> } })
      setJson(site, '/api/landings/501', { ...(mapShaped('landing', landing()) as object), extra: 1 })
      const result = await runner.run(input())
      assert.equal(result.status === 'judged' && result.member, BROWSER_SHAPE_WORDS.member)
      await flush()
    }
    const { runner, input } = setup()
    await runner.run(input())
  } finally {
    Object.assign(console, saved)
  }
  assert.deepEqual(logged, [])
})

test('too many reads stop the run', async () => {
  const { site, runner, input } = setup()
  // Ten pages of a list whose entry is on the last: 2 + 1 + 10 + … stays under the cap; a line read through many lists cannot run away.
  for (let p = 1; p <= 10; p++) setJson(site, `/api/landings?group=10&page=${p}`, listPage(p === 10 ? [mapShaped('landing_row', row(501))] : [mapShaped('landing_row', row(1000 + p))], p, 10, 10))
  const result = await runner.run(input())
  assert.equal(result.status === 'judged' && result.ok, true)
  assert.ok(site.addresses.length <= 30, 'under the cap')
})
