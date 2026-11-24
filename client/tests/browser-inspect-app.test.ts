/**
 * 「ブラウザ操作」's read-only inspection wired end to end in main (generalization PR 5b; agent-browser.md "The inspection in
 * the chat"): `browser_inspect` → the server's plan (a fake of routes/browser-lines.ts) → the read runner over a fake
 * Lステップ behind the member's window → the card in memory → the result in fixed words. The real bundled map, lines,
 * declaration and opened list.
 *
 * Guards (each test fails when its guard is removed):
 * - switched off: no tool, nothing asked of the server or the site;
 * - a line not approved in the opened list, a refusal of the server's gate (not granted, the setting, the stop) or bad
 *   values: nothing is read from the site;
 * - the AI's words carry no value the site showed (names, URLs, the account, tags), only fixed words and marks; the
 *   card (main's memory) carries them, only for the main window and the member who ran it;
 * - only GETs of the map's addresses, on the host of the reviewed declaration; the result goes in fixed words, once;
 * - the turn's signal (the consultation closed or stopped) ends the reads: no card, no result;
 * - unreadable is never ✓ (a route in no folder: its row 「読み取れませんでした」).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstepConnector } from '../connectors/lstep'
import { lstepReadLines } from '../connector-maps/lstep'
import { LINES } from '../browser-lines/lstep'
import opened from '../../shared/browser-connectors/opened.json'
import type { BrowserOpenedFile } from '../../shared/core/browser-opened'
import { createBrowserContext } from '../electron/features/browser/context'
import { wireBrowserInspections } from '../electron/features/browser/inspect'
import { browserInspectForTurn } from '../electron/browser-request/inspect-tool'
import { BROWSER_INSPECT_WORDS, readBrowserCard, type BrowserInspectionGetResult } from '../shared/browser-inspection'
import type { BrowserPreviewSurface } from '../shared/browser-runner'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'

const HOST = 'manager.linestep.net'
const COMPANY = 'company-1'
const PLAN = `bl_${'a'.repeat(32)}`
const ACCOUNT = '90171'
const lstep = lstepConnector()
const site = lstepReadLines()
const { map } = site

// Values the site shows: none of them may reach the AI.
const SECRET_NAME = '第2回の流入経路（ひみつ）'
const SOURCE_NAME = '第1回の流入経路（ひみつ）'
const FOLLOW = 'https://example.invalid/follow/secret-501'
const QR = 'https://example.invalid/qr/secret-501'

/** An answer cut to the keys the map lists (the made-up answers carry stage 0's whole key sets). */
function mapShaped(thing: string, value: unknown, prefix = ''): unknown {
  const keys = map.things[thing].keys ?? {}
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
  name: SECRET_NAME, qr_text: '', action_id: 7002, action_texts: [], prevent_default: 0, only_welcome: 0, cv_head: '', cv_body: '',
  group_id: 10, from_date: '', from_time: '', to_date: '2026-12-03', to_time: '17:00', out_of_period_message: '',
  latitude: null, longitude: null, radius: null, custom_params: [], only_once_param_sync: false, ...over,
})
const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, name: `流入経路${id}`, validity_period_from: null, validity_period_to: '2026-12-03 17:00',
  follow_url: id === 501 ? FOLLOW : `https://example.invalid/follow/${id}`, qr_url: id === 501 ? QR : `https://example.invalid/qr/${id}`,
  group: { id: 10, name: 'フォルダ', order: 1 }, ...over,
})
const action = (tags: number[]) => {
  const nulls = { member_query_id: null, send_member_query_id: null }
  return { inputs: [{ type: 13, tag_ids: tags, ...nulls }, { type: 15, episode_id: '101', firetype: 1, ...nulls }, { type: 12, egg_id: '300', ...nulls }], aid: 1, a_twice_type: 1, a_name: null, funnel_descriptions: {}, group_id: null }
}
const listPage = (rows: unknown[]) => ({
  current_page: 1, data: rows, first_page_url: 'x', from: 1, last_page: 1, last_page_url: 'x', links: [{ url: null, label: '1', page: 1, active: true }],
  next_page_url: null, path: 'x', per_page: 50, prev_page_url: null, to: rows.length, total: rows.length,
})

interface Fake {
  answers: Map<string, unknown>
  reads: string[]
  other: string[]
  hosts: string[]
  server: Array<{ method: string; path: string; body: unknown }>
  createAnswer: { status: number; body: unknown }
  onRead?: (address: string) => void
}

function fake(): Fake {
  const f: Fake = { answers: new Map(), reads: [], other: [], hosts: [], server: [], createAnswer: { status: 201, body: { success: true, data: { id: PLAN } } } }
  f.answers.set('/api/landings/501', mapShaped('landing', landing()))
  f.answers.set('/api/landings/400', mapShaped('landing', landing({ name: SOURCE_NAME, action_id: 7001, to_date: '2026-11-26' })))
  f.answers.set('/api/actions/7002', mapShaped('action_set', action([22])))
  f.answers.set('/api/actions/7001', mapShaped('action_set', action([21])))
  f.answers.set('/api/landings?group=10&page=1', listPage([mapShaped('landing_row', row(400)), mapShaped('landing_row', row(501))]))
  return f
}

function surfaceOf(f: Fake): BrowserPreviewSurface {
  const surface = {
    async read(address: string) {
      f.reads.push(address)
      f.onRead?.(address)
      if (address === site.account.path) return { status: 200, body: `<html><head><meta name="lm-account-id" content="${ACCOUNT}"></head></html>` }
      return f.answers.has(address) ? { status: 200, body: JSON.stringify(f.answers.get(address)) } : { status: 404, body: '' }
    },
    closed: () => false,
  }
  for (const name of ['request', 'write', 'enterAi', 'fetch']) Object.defineProperty(surface, name, { value: () => { f.other.push(name); throw new Error('never') } })
  return surface
}

function harness(o: { on?: () => boolean; openedFile?: unknown; user?: () => string | null; stopped?: boolean } = {}) {
  const f = fake()
  const surface = surfaceOf(f)
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (c: string, h: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(c, h) }, on() {} } as unknown as IpcRegistrar
  const fetchFake = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://acb.example', '')
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    f.server.push({ method: String(init.method), path, body })
    const answer = path.endsWith('/browser-line-plans') ? f.createAnswer : { status: 200, body: { success: true, data: {} } }
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  const on = o.on ?? (() => true)
  const user = o.user ?? (() => 'user-1')
  const context = createBrowserContext({ userId: user, aiSwitch: on })
  const wiring = wireBrowserInspections(ipc, {
    aiSwitch: on, fromMainWindow: event => (event as { sender: { id: number } }).sender.id === 1,
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], userId: user, context,
    stopped: () => o.stopped ?? false,
    window: (_c, host) => { f.hosts.push(host); return surface },
    sites: [{ map: site.map, readers: site.readers, addresses: site.addresses, account: site.account }],
    lines: LINES, declarations: [lstep.declaration], fetch: fetchFake,
    ...(o.openedFile ? { openedFile: o.openedFile } : {}),
  })
  const card = (sender: number, planId = PLAN) => handlers.get('browserLines:card')!({ sender: { id: sender, isDestroyed: () => false, send() {} } } as unknown as IpcInvokeEvent, COMPANY, planId) as Promise<BrowserInspectionGetResult>
  const cards: string[] = []
  const tool = (signal = new AbortController().signal) => browserInspectForTurn(wiring, { companyId: COMPANY, conversationId: 'conv-1', signal, onCard: id => cards.push(id) })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  return { f, wiring, card, cards, tool, flush }
}

const ASK = { site: 'lstep', line: 'landing_inspect', values: { landing: '501', source: '400' } }
const siteValues = [SECRET_NAME, SOURCE_NAME, FOLLOW, QR, ACCOUNT, '2026-12-03', '2026-11-26', '17:00', '22', '21', '流入経路501']

test('the bundled line is the opened list\'s approved row on the bundled map version', () => {
  const row = (opened as BrowserOpenedFile).lines.find(l => l.name === 'landing_inspect' && l.mapVersion === map.version)
  assert.equal(row?.status, 'approved')
})

test('a good inspection: the card holds the site\'s values for the member; the AI gets marks only; the server gets fixed words once', async () => {
  const h = harness()
  const words = await h.tool()!.execute(ASK)
  await h.flush()
  // Only GETs of the map's addresses, on the reviewed declaration's host, the marker before and after.
  assert.deepEqual(h.f.reads, ['/', '/api/landings/501', '/api/landings?group=10&page=1', '/api/actions/7002', '/api/landings/400', '/api/actions/7001', '/'])
  assert.deepEqual(h.f.other, [])
  assert.ok(h.f.hosts.length > 0 && h.f.hosts.every(x => x === HOST))
  // The AI: fixed words and each check's mark; never a value the site showed.
  assert.match(words, /流入経路を点検する/)
  assert.match(words, /✓/)
  for (const v of siteValues) assert.ok(!words.includes(v), `the AI never sees ${v}`)
  assert.deepEqual(h.cards, [PLAN])
  // The server: the plan with the line's own ref and the values as targets; then the result in fixed words, once.
  const create = h.f.server.find(s => s.path === `/api/companies/${COMPANY}/browser-line-plans`)!
  const ref = create.body as { line: { line: string; mapVersion: string }; values: Record<string, { value: string; from: { kind: string } }>; conversationId: string }
  assert.equal(ref.line.line, 'landing_inspect')
  assert.equal(ref.line.mapVersion, map.version)
  assert.deepEqual(ref.values, { landing: { value: '501', from: { kind: 'site_fact' } }, source: { value: '400', from: { kind: 'site_fact' } } })
  const results = h.f.server.filter(s => s.path.endsWith(`/browser-line-plans/${PLAN}/result`))
  assert.equal(results.length, 1)
  assert.deepEqual(Object.keys(results[0].body as object).sort(), ['checks', 'reads'])
  const sent = JSON.stringify(h.f.server)
  for (const v of [SECRET_NAME, SOURCE_NAME, FOLLOW, QR, ACCOUNT]) assert.ok(!sent.includes(v), `the server never gets ${v}`)
  // The card: main's memory, for the main window and this member only.
  const shown = await h.card(1)
  assert.ok(shown.ok)
  const text = JSON.stringify(shown.view.card)
  assert.ok(text.includes(SECRET_NAME) && text.includes(FOLLOW))
  assert.equal(shown.view.card.state, 'all_ok')
  assert.equal((await h.card(2)).ok, false, 'not from a consultation window')
  assert.equal((await h.card(1, `bl_${'b'.repeat(32)}`)).ok, false, 'not another plan')
})

test('another member signed in sees no card; sign-out clears them', async () => {
  let user: string | null = 'user-1'
  const h = harness({ user: () => user })
  await h.tool()!.execute(ASK)
  user = 'user-2'
  assert.equal((await h.card(1)).ok, false)
  user = 'user-1'
  assert.equal((await h.card(1)).ok, true)
  h.wiring.clear()
  assert.equal((await h.card(1)).ok, false)
})

test('switched off: no tool at all, and nothing reaches the server or the site', async () => {
  const h = harness({ on: () => false })
  assert.equal(h.tool(), undefined)
  const out = await h.wiring.inspect({ companyId: COMPANY, conversationId: null, ...ASK, signal: new AbortController().signal })
  assert.deepEqual(out, { kind: 'refused', words: BROWSER_INSPECT_WORDS.off })
  assert.deepEqual(h.f.server, [])
  assert.deepEqual(h.f.reads, [])
})

test('a line not approved in the opened list: refused before the server or the site', async () => {
  const file = JSON.parse(JSON.stringify(opened)) as BrowserOpenedFile
  for (const l of file.lines) if (l.name === 'landing_inspect' && l.mapVersion === map.version) l.status = 'pending'
  const h = harness({ openedFile: file })
  assert.equal(await h.tool()!.execute(ASK), BROWSER_INSPECT_WORDS.notApproved)
  assert.deepEqual(h.f.server, [])
  assert.deepEqual(h.f.reads, [])
})

test('the server\'s gate refuses (not granted, the setting, the stop, not approved there): nothing is read', async () => {
  for (const [code, words] of [
    ['BROWSER_TYPE_NOT_GRANTED', BROWSER_INSPECT_WORDS.notGranted],
    ['BROWSER_NOT_ALLOWED', BROWSER_INSPECT_WORDS.notAllowed],
    ['BROWSER_AI_STOPPED', BROWSER_INSPECT_WORDS.stopped],
    ['BROWSER_LINE_NOT_APPROVED', BROWSER_INSPECT_WORDS.notApproved],
  ] as const) {
    const h = harness()
    h.f.createAnswer = { status: 403, body: { error: 'x', code } }
    assert.equal(await h.tool()!.execute(ASK), words, code)
    assert.deepEqual(h.f.reads, [], code)
    assert.deepEqual(h.cards, [], code)
  }
  const stopped = harness({ stopped: true })
  assert.equal(await stopped.tool()!.execute(ASK), BROWSER_INSPECT_WORDS.stopped)
  assert.deepEqual(stopped.f.server, [])
})

test('values: only the line\'s own names, each a plain id — anything else is refused before the server', async () => {
  for (const values of [{ landing: '501' }, { landing: '501', source: '400', extra: '1' }, { landing: '50 1', source: '400' }, { landing: '../x', source: '400' }, { landing: '501', other: '400' }]) {
    const h = harness()
    const words = await h.tool()!.execute({ ...ASK, values })
    assert.ok(words === BROWSER_INSPECT_WORDS.values || words === BROWSER_INSPECT_WORDS.badInput, JSON.stringify(values))
    assert.deepEqual(h.f.server, [])
    assert.deepEqual(h.f.reads, [])
  }
  const h = harness()
  assert.equal(await h.tool()!.execute({ ...ASK, line: 'step_template_add', values: { reminder: '1', step: '2', template_folder: '3', template: '4' } }), BROWSER_INSPECT_WORDS.unknownLine, 'a line that writes is no inspection')
  assert.deepEqual(h.f.server, [])
})

test('the consultation closed or stopped mid-run: the reads end, no card, no result', async () => {
  const h = harness()
  const turn = new AbortController()
  h.f.onRead = address => { if (address === '/api/actions/7002') turn.abort() }
  const words = await h.tool(turn.signal)!.execute(ASK)
  await h.flush()
  assert.equal(words, BROWSER_INSPECT_WORDS.interrupted)
  assert.ok(!h.f.reads.includes('/api/landings/400'), 'nothing read after the stop')
  assert.deepEqual(h.cards, [])
  assert.equal(h.f.server.filter(s => s.path.endsWith('/result')).length, 0)
  assert.equal((await h.card(1)).ok, false)
})

test('a turn already stopped makes no plan and reads nothing', async () => {
  const h = harness()
  const turn = new AbortController()
  turn.abort()
  assert.equal(await h.tool(turn.signal)!.execute(ASK), BROWSER_INSPECT_WORDS.interrupted)
  assert.deepEqual(h.f.server, [])
  assert.deepEqual(h.f.reads, [])
})

test('unreadable is never ✓: a route in no folder — its row 「読み取れませんでした」, and the AI is told so without a value', async () => {
  const h = harness()
  h.f.answers.set('/api/landings/501', mapShaped('landing', landing({ group_id: null })))
  const words = await h.tool()!.execute(ASK)
  assert.match(words, /読み取れませんでした/)
  assert.ok(!words.includes('全体: すべて ✓'))
  for (const v of siteValues) assert.ok(!words.includes(v), `the AI never sees ${v}`)
  const shown = await h.card(1)
  assert.ok(shown.ok)
  assert.notEqual(shown.view.card.state, 'all_ok')
  const rows = shown.view.card.sections.find(s => s.heading.includes('一覧の行'))!.rows
  assert.ok(rows.every(r => 'value' in r && r.value.status === 'unreadable'))
})

test('a ✗: the AI gets the mark, never the differing fields\' values', async () => {
  const h = harness()
  // The copy still on its source's action (the most common accident): ✗.
  h.f.answers.set('/api/landings/501', mapShaped('landing', landing({ action_id: 7001 })))
  h.f.answers.set('/api/actions/7001', mapShaped('action_set', action([21])))
  const words = await h.tool()!.execute(ASK)
  assert.match(words, /✗/)
  for (const v of siteValues) assert.ok(!words.includes(v), `the AI never sees ${v}`)
})

test('the renderer shows a card only in its shape: a mark outside the four words or a value of another shape is refused', () => {
  const good = { title: 't', state: 'ng', headline: 'h', sections: [{ heading: 's', rows: [{ label: 'l', value: { status: 'read', text: 'x' } }] }], checks: [{ label: 'c', mark: 'ng', fields: [] }], notes: [] }
  assert.ok(readBrowserCard(good))
  assert.equal(readBrowserCard({ ...good, checks: [{ label: 'c', mark: 'yes', fields: [] }] }), null)
  assert.equal(readBrowserCard({ ...good, sections: [{ heading: 's', rows: [{ label: 'l', value: { status: 'read', text: 1 } }] }] }), null)
  assert.equal(readBrowserCard({ ...good, state: 'ok' }), null)
})
