/**
 * 「ブラウザ操作」's writes on the new path wired in main (generalization PR 5c; agent-browser.md "Writing on the new path"):
 * `browser_write` → the card in memory → the member confirms each person's value (main window only) → main reads the site
 * and the server makes the draft (a fake of routes/browser-lines.ts) → ［任せる］ with the hash the card showed → the write
 * runner over a fake Lステップ → the card's result. The real bundled map, `landing_create`, declaration and opened list
 * (the line's row marked approved here, as the owner's review would); the tag's address and the writers are test data.
 *
 * Guards (each fails when its guard is removed; mutation-checked):
 * - the AI's words are fixed: no value it proposed, no value the site showed, no hash, no result;
 * - nothing is read from the site or asked of the server until every person's value is confirmed on the card, and the
 *   server gets those values as the person's, confirmed; a target can never be "confirmed" by a press;
 * - only the main window's page acts on the card, only for the member who has it;
 * - ［任せる］ runs only with the hash the card showed, only once the plan is ready;
 * - as written today (pending) or without its site's writers, nothing is proposed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstepConnector } from '../connectors/lstep'
import { lstepReadLines } from '../connector-maps/lstep'
import { LINES } from '../browser-lines/lstep'
import opened from '../../shared/browser-connectors/opened.json'
import { canonicalJson } from '../../shared/core/fixed-content'
import type { BrowserOpenedFile } from '../../shared/core/browser-opened'
import { createBrowserContext } from '../electron/features/browser/context'
import { wireBrowserWriteLines } from '../electron/features/browser/write-lines'
import { browserInspectForTurn } from '../electron/browser-request/inspect-tool'
import { BROWSER_WRITE_WORDS, type BrowserLineWriters, type BrowserWriteGetResult } from '../shared/browser-line-writes'
import type { BrowserRunSurface, BrowserStepRecord, BrowserWriteOutcome } from '../shared/browser-runner'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'

const HOST = 'manager.linestep.net'
const COMPANY = 'company-1'
const ACCOUNT = '90171'
const lstep = lstepConnector()
const site = lstepReadLines()
const { map } = site
const SOURCE_NAME = '第1回の流入経路（ひみつ）'
const TAG_NAME = '参加者_ひみつ'
const PROPOSED = { source: '2597458', tag: '61', name: '試験_20261203', to_date: '2026-12-03', to_time: '18:20' }

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
  name: SOURCE_NAME, qr_text: '', action_id: 7001, action_texts: [], prevent_default: 0, only_welcome: 0, cv_head: '', cv_body: '',
  group_id: 10, from_date: '', from_time: '', to_date: '2026-11-26', to_time: '17:00', out_of_period_message: '',
  latitude: null, longitude: null, radius: null, custom_params: [], only_once_param_sync: false, ...over,
})
const nulls = { member_query_id: null, send_member_query_id: null }
const action = (tags: number[]) => ({ inputs: [{ type: 13, tag_ids: tags, ...nulls }, { type: 15, episode_id: '101', firetype: 1, ...nulls }, { type: 12, egg_id: '300', ...nulls }], aid: 1, a_twice_type: 1, a_name: null, funnel_descriptions: {}, group_id: null })

/** The real opened list with `landing_create`'s row on the bundled map marked approved. */
function approvedOpened(): BrowserOpenedFile {
  const file = JSON.parse(JSON.stringify(opened)) as BrowserOpenedFile
  const row = file.lines.find(l => l.name === 'landing_create' && l.mapVersion === map.version)!
  assert.equal(row.status, 'pending', 'as written today the line is pending')
  row.status = 'approved'
  return file
}

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

function harness(o: { openedFile?: unknown; writers?: BrowserLineWriters } = {}) {
  const landings = new Map<string, Record<string, unknown>>([['2597458', landing()]])
  const actions = new Map<string, Record<string, unknown>>([['7001', action([21])]])
  const reads: string[] = []
  const writes: string[] = []
  const server: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = []
  let nextId = 8800
  const get = (a: string) => {
    reads.push(a)
    if (a === site.account.path) return { status: 200, body: `<html><head><meta name="lm-account-id" content="${ACCOUNT}"></head></html>` }
    let m = /^\/api\/landings\/(\d+)$/.exec(a)
    if (m && landings.has(m[1])) return { status: 200, body: JSON.stringify(mapShaped('landing', landings.get(m[1]))) }
    m = /^\/api\/actions\/(\d+)$/.exec(a)
    if (m && actions.has(m[1])) return { status: 200, body: JSON.stringify(mapShaped('action_set', actions.get(m[1]))) }
    if (a === '/test-tags/61') return { status: 200, body: JSON.stringify({ id: 61, name: TAG_NAME }) }
    return { status: 404, body: '' }
  }
  const preview = { async read(a: string) { return get(a) }, closed: () => false }
  let hooks: Parameters<BrowserRunSurface['enterAi']>[0] | null = null
  const run: BrowserRunSurface = {
    async enterAi(h) { hooks = h; return true },
    async leaveAi() { hooks = null },
    pageClean: () => true,
    async request() { throw new Error('never') },
    async write(r, steps): Promise<BrowserWriteOutcome> {
      if (!(await steps.ready())) return { sent: false, stage: 'ready' }
      if (!steps.beforeSend()) return { sent: false, stage: 'before-send' }
      if (!hooks?.sessionRequest({ method: r.method, url: `https://${HOST}${r.path}`, body: r.body }).allow) return { sent: true, answer: null }
      writes.push(r.path)
      const b = JSON.parse(r.body) as Record<string, unknown>
      const id = String(nextId++)
      if (r.path === '/test/actions') { actions.set(id, action([Number(b.tag)])); return { sent: true, answer: { status: 200, body: JSON.stringify({ aid: Number(id) }) } } }
      landings.set(id, landing({ ...landings.get(String(b.from)), name: b.name, to_date: b.to_date, to_time: b.to_time, action_id: Number(b.action_id) }))
      return { sent: true, answer: { status: 200, body: JSON.stringify({ id: Number(id) }) } }
    },
    closed: () => false,
  }
  // A fake of the server's routes: the draft's fixed content from what the app sent, the state table's order kept simply.
  let content = ''
  const recorded = new Map<number, string>()
  const fetchFake = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://acb.example', '')
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    server.push({ method: String(init.method), path, body, headers: init.headers as Record<string, string> })
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } })
    if (path.endsWith('/browser-line-plans')) {
      content = canonicalJson({
        shape: 2, company: COMPANY, user: 'user-1', conversation: body?.conversationId ?? null, line: body?.line, values: body?.values,
        writes: [{ kind: 'create' }, { kind: 'create' }], locks: ['k'], site: 'lstep', host: HOST, account: body?.account,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      return ok({ id: `bl_${'c'.repeat(32)}`, state: 'draft', contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}` }, 201)
    }
    if (path.endsWith('/approve')) return ok({})
    if (path.endsWith('/claim')) return ok({ executionId: `bw_${'d'.repeat(32)}`, secret: 'e'.repeat(64), fixed: { content, contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}` } })
    if (path.endsWith('/permit')) {
      const index = body?.index as number
      return ok({ index, permittedAt: new Date().toISOString(), validMs: 5000, createdTarget: index === 2 ? recorded.get(1) ?? null : null })
    }
    if (path.endsWith('/report')) { if (body?.createdId) recorded.set(body.index as number, body.createdId as string); return ok({ outcome: 'applied' }) }
    return ok({ execution: null })
  }) as unknown as typeof fetch
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (c: string, h: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(c, h) }, on() {} } as unknown as IpcRegistrar
  const on = () => true
  const user = () => 'user-1'
  const records: BrowserStepRecord[] = []
  const wiring = wireBrowserWriteLines(ipc, {
    aiSwitch: on, fromMainWindow: event => (event as { sender: { id: number } }).sender.id === 1,
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], userId: user, context: createBrowserContext({ userId: user, aiSwitch: on }),
    stopped: () => false, siteLevel: () => 'write', windows: { runWindow: () => run, previewWindow: () => preview },
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } }, busyWindows: new Set(),
    sites: [{ map: site.map, readers: site.readers, addresses: { ...site.addresses, tag: { kind: 'object', path: '/test-tags/{id}' } }, account: site.account, writers: o.writers ?? WRITERS }],
    lines: LINES, declarations: [lstep.declaration], fetch: fetchFake, openedFile: o.openedFile ?? approvedOpened(),
  })
  const ev = (sender: number) => ({ sender: { id: sender, isDestroyed: () => false, send() {} } }) as unknown as IpcInvokeEvent
  const call = (channel: string, sender: number, ...args: unknown[]) => handlers.get(channel)!(ev(sender), COMPANY, ...args) as Promise<BrowserWriteGetResult>
  const cards: string[] = []
  const tool = () => browserInspectForTurn({ inspectAvailable: () => true, inspect: async () => ({ kind: 'refused', words: '' }) },
    { companyId: COMPANY, conversationId: 'conv-1', signal: new AbortController().signal, onCard: id => cards.push(id) }, wiring)!.write!
  return { wiring, call, cards, tool, reads, writes, server }
}

test('the AI proposes and gets fixed words only; nothing is read or asked until every person\'s value is confirmed on the card', async () => {
  const h = harness()
  const words = await h.tool().execute({ site: 'lstep', line: 'landing_create', values: PROPOSED })
  assert.equal(words, BROWSER_WRITE_WORDS.proposed)
  for (const v of [...Object.values(PROPOSED), SOURCE_NAME, TAG_NAME, 'sha256']) assert.ok(!words.includes(v))
  assert.equal(h.cards.length, 1)
  assert.deepEqual(h.reads, [])
  assert.deepEqual(h.server, [])
  const id = h.cards[0]
  // ［任せる］ before the plan exists: refused. A target cannot be "confirmed" by a press.
  assert.equal((await h.call('browserLines:runWrite', 1, id, `sha256:${'0'.repeat(64)}`)).ok, false)
  assert.equal((await h.call('browserLines:confirmValue', 1, id, 'source')).ok, false)
  // Another window, or another member's card: refused.
  assert.equal((await h.call('browserLines:confirmValue', 2, id, 'name')).ok, false)
  await h.call('browserLines:confirmValue', 1, id, 'name')
  await h.call('browserLines:confirmValue', 1, id, 'to_date')
  assert.deepEqual(h.reads, [], 'still one value to confirm: nothing read')
  const ready = await h.call('browserLines:confirmValue', 1, id, 'to_time')
  assert.ok(ready.ok)
  if (!ready.ok) return
  assert.equal(ready.view.phase, 'ready')
  const made = h.server.find(s => s.path.endsWith('/browser-line-plans'))!
  const values = made.body as { values: Record<string, { from: unknown }>; account: string }
  assert.deepEqual(values.values.name.from, { kind: 'person', confirmed: true })
  assert.deepEqual(values.values.source.from, { kind: 'site_fact' })
  assert.equal(values.account, ACCOUNT)
  // The card shows what was read (the member's), never handed to the AI.
  assert.ok(JSON.stringify(ready.view.card).includes(SOURCE_NAME))
  assert.deepEqual(h.writes, [])
})

test('［任せる］ runs only with the hash the card showed, from the main window; then both writes in order', async () => {
  const h = harness()
  await h.tool().execute({ site: 'lstep', line: 'landing_create', values: PROPOSED })
  const id = h.cards[0]
  for (const n of ['name', 'to_date', 'to_time']) await h.call('browserLines:confirmValue', 1, id, n)
  const card = await h.call('browserLines:writeCard', 1, id)
  assert.ok(card.ok)
  if (!card.ok) return
  const hash = card.view.contentHash!
  assert.equal((await h.call('browserLines:runWrite', 1, id, `sha256:${'0'.repeat(64)}`)).ok, false)
  assert.equal((await h.call('browserLines:runWrite', 2, id, hash)).ok, false)
  assert.deepEqual(h.writes, [])
  const done = await h.call('browserLines:runWrite', 1, id, hash)
  assert.ok(done.ok)
  if (!done.ok) return
  assert.equal(done.view.result?.outcome, 'succeeded')
  assert.equal(done.view.result?.done.length, 2)
  assert.deepEqual(h.writes, ['/test/actions', '/test/landings'])
  // The secret went only in its header; the report carried no session.
  const report = h.server.find(s => s.path === '/api/browser-line-executions/report')!
  assert.equal(report.headers['X-ACB-Browser-Execution'], 'e'.repeat(64))
  assert.equal(report.headers.Cookie, undefined)
  // Pressed again: nothing more is sent.
  assert.equal((await h.call('browserLines:runWrite', 1, id, hash)).ok, false)
  assert.equal(h.writes.length, 2)
})

test('as written today (pending), or without the site\'s writers, nothing is proposed', async () => {
  const today = harness({ openedFile: opened })
  assert.equal(await today.tool().execute({ site: 'lstep', line: 'landing_create', values: PROPOSED }), BROWSER_WRITE_WORDS.notApproved)
  const none = harness({ writers: {} })
  assert.equal(await none.tool().execute({ site: 'lstep', line: 'landing_create', values: PROPOSED }), BROWSER_WRITE_WORDS.notSupported)
  assert.deepEqual([...today.cards, ...none.cards], [])
})
