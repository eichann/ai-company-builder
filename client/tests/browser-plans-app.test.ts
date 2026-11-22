/**
 * 「ブラウザ操作」's plans in the app (agent-browser.md "The card, the IPC and the request tool", design
 * 6b-2d): the registration (preview → the checker's facts → POST), the server client, the card's IPC,
 * whether ［任せる］ can be pressed here, the context, this build's combination, the request tool's words,
 * and — with the build's switch as it ships (off) — that nothing reads a site, starts anything or
 * reaches the server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstepConnector } from '../connectors/lstep'
import { createBrowserConnectors } from '../shared/browser-checkers'
import type { BrowserChecker, BrowserRunResult } from '../shared/browser-runner'
import { BROWSER_REQUEST_WORDS } from '../shared/browser-plans'
import type { BrowserPlanView } from '../../shared/types/browser-plans'
import { registerBrowserPlan, type BrowserRegistrationDeps } from '../electron/features/browser/register'
import { createBrowserPlansHttp, BROWSER_EXECUTION_HEADER } from '../electron/features/browser/plans-api'
import { browserCardReadiness, registerBrowserPlansIpc, type BrowserPlansIpcDeps } from '../electron/features/browser/plans-ipc'
import { createBrowserContext } from '../electron/features/browser/context'
import { createCarriedCombinations } from '../electron/features/browser/combination'
import { wireBrowserPlans } from '../electron/features/browser/wire'
import { browserRequestForTurn, createBrowserRequestTools } from '../electron/browser-request/tools'
import type { BrowserApiAnswer } from '../electron/features/browser/runner'
import type { IpcInvokeEvent, IpcRegistrar } from '../electron/ipc/registrar'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOST = 'manager.linestep.net'
const COMPANY = 'company-1'
const PLAN = `bp_${'a'.repeat(32)}`
const EXEC = `bx_${'b'.repeat(32)}`
const HASH = `sha256:${'c'.repeat(64)}`
const SECRET = 'f'.repeat(64)
const REMINDER = '7001001'
const STEP = '7002001'
const ON_STEP = '7003001'
const TO_ADD = '7003002'
const ACCOUNT = '5550001'
const lstep = lstepConnector()
const connector = createBrowserConnectors([lstep.declaration])
const COMBINATION = { declarationHash: `sha256:${'d'.repeat(64)}`, checkerHash: `sha256:${'e'.repeat(64)}`, factsVersion: 2 }
const SITE = { host: HOST, level: 'write' as const, assetHosts: [] }

/** A checker whose facts come from one declared read: the registration's own logic, not the site's reader, is under test. */
function fakeChecker(o: { unknown?: string[]; twoReads?: boolean } = {}): BrowserChecker {
  const known = (value: unknown, complete = false) => ({ status: 'known' as const, value, ...(complete ? { complete: true } : {}), from: 0 })
  const all: Record<string, ReturnType<typeof known>> = {
    account: known({ id: ACCOUNT }),
    step_parent: known({ reminder: REMINDER }),
    names: known({ reminder: '11月のリマインダ', step: '当日' }),
    state: known({ templates: [ON_STEP] }, true),
    templates: known({ [ON_STEP]: { name: '当日のご案内', kind: 'text', body: '本日です' }, [TO_ADD]: { name: '持ち物', kind: 'text', body: '筆記用具' } }, true),
    schedule: known({ timing: '当日 09:00' }, true),
    shared_with: known({ count: 2, items: ['11/26回', '12/3回'] }, true),
  }
  const facts = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, o.unknown?.includes(k) ? { status: 'unknown' as const, from: 0 } : v]))
  return {
    id: 'lstep.reminder_step', confirms: ['reminder', 'step'],
    readPaths: v => [`/line/episode/show/${v.target.reminder}`],
    view: () => ({ account: ACCOUNT, state: { templates: [ON_STEP] }, ignored: {}, problem: null }),
    facts: {
      version: 2,
      next: (_v, answers) => (answers.length === 0 ? [{ read: 'reminder_folders', values: {} }] : answers.length === 1 && o.twoReads ? [{ read: 'template_folders', values: {} }] : []),
      read: () => ({ facts }),
    },
  }
}

function registrationHarness(o: { switchOn?: boolean; checker?: BrowserChecker; candidate?: Partial<{ explanation: string }>; preview?: BrowserRegistrationDeps['preview']; onRead?: () => void; combination?: boolean; stopped?: () => boolean } = {}) {
  const calls = { preview: 0, reads: [] as string[], register: [] as unknown[] }
  const checker = o.checker ?? fakeChecker()
  const deps: BrowserRegistrationDeps = {
    aiSwitch: () => o.switchOn ?? true,
    preview: o.preview ?? (async () => {
      calls.preview++
      return { outcome: 'candidate', target: { reminder: REMINDER, step: STEP }, change: { template: TO_ADD }, explanation: o.candidate?.explanation ?? '段に持ち物のテンプレートを足します' }
    }),
    connector, combination: () => (o.combination === false ? null : COMBINATION),
    checker: id => (id === checker.id ? checker : undefined),
    reader: id => lstep.readers.find(r => r.id === id),
    window: () => ({ closed: () => false, read: async (address: string) => { calls.reads.push(address); o.onRead?.(); return { status: 200, body: JSON.stringify({ data: [] }) } } }),
    parse: () => { throw new Error('no HTML here') },
    plans: { register: async (_c, input) => { calls.register.push(input); return { kind: 'ok', value: { id: PLAN } } } },
    context: () => () => true,
    stopped: o.stopped ?? (() => false),
    now: () => Date.parse('2026-11-22T03:00:00.000Z'),
    log: { warn() {} },
  }
  return { deps, calls }
}

const request = (signal = new AbortController().signal) => ({
  companyId: COMPANY, conversationId: 'conv-1', connector: { id: 'lstep', version: '0.6.0' }, operation: 'reminder_step_add_template',
  hints: { targetHints: { reminder: '11月' }, changeHints: { template: '持ち物' }, reason: '頼まれた' }, signal,
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the switch off: no preview, no page read and no server call — the plan is not made', async () => {
  const { deps, calls } = registrationHarness({ switchOn: false })
  assert.deepEqual(await registerBrowserPlan(request(), deps), { outcome: 'not-made', why: 'off' })
  assert.deepEqual(calls, { preview: 0, reads: [], register: [] })
})

test('a plan is registered with this build\'s combination and the facts the checker read — never the AI\'s words as facts', async () => {
  const { deps, calls } = registrationHarness({ candidate: { explanation: '人数は 999 人です。安全です。' } })
  assert.deepEqual(await registerBrowserPlan(request(), deps), { outcome: 'registered', planId: PLAN })
  assert.deepEqual(calls.reads, ['/api/episode-groups'])
  const body = calls.register[0] as Record<string, unknown>
  assert.deepEqual(
    { connector: body.connector, operation: body.operation, declarationHash: body.declarationHash, checkerHash: body.checkerHash, factsVersion: body.factsVersion, target: body.target, change: body.change, conversationId: body.conversationId },
    { connector: { id: 'lstep', version: '0.6.0' }, operation: 'reminder_step_add_template', ...COMBINATION, target: { reminder: REMINDER, step: STEP }, change: { template: TO_ADD }, conversationId: 'conv-1' })
  const facts = body.facts as Record<string, { status: string; value?: unknown; source: string }>
  assert.deepEqual(facts.schedule.value, { timing: '当日 09:00' })
  assert.equal(facts.schedule.source, '/api/episode-groups')
  // The AI's explanation stays an explanation; no fact carries it.
  assert.equal(body.explanation, '人数は 999 人です。安全です。')
  assert.equal(JSON.stringify(facts).includes('999'), false)
  assert.equal(facts.audience.status, 'unknown')
})

test('a required fact the checker could not read: no plan, nothing sent to the server', async () => {
  const { deps, calls } = registrationHarness({ checker: fakeChecker({ unknown: ['schedule'] }) })
  assert.deepEqual(await registerBrowserPlan(request(), deps), { outcome: 'not-made', why: 'facts' })
  assert.deepEqual(calls.register, [])
})

test('the context changes while the facts are read: no plan registered', async () => {
  let current = true
  const { deps, calls } = registrationHarness({ checker: fakeChecker({ twoReads: true }), onRead: () => { current = false } })
  deps.context = () => () => current
  assert.deepEqual(await registerBrowserPlan(request(), deps), { outcome: 'not-made', why: 'failed' })
  // No further page is read once the context moved, and nothing is registered.
  assert.deepEqual([calls.reads, calls.register], [['/api/episode-groups'], []])
})

test('the emergency stop during a request: no further page read, nothing registered', async () => {
  // Stopped while the facts are read (after the first page) …
  let stop = false
  const during = registrationHarness({ checker: fakeChecker({ twoReads: true }), onRead: () => { stop = true }, stopped: () => stop })
  assert.deepEqual(await registerBrowserPlan(request(), during.deps), { outcome: 'not-made', why: 'failed' })
  assert.deepEqual([during.calls.reads, during.calls.register], [['/api/episode-groups'], []])
  // … and stopped right after the preview: not one page read for the facts.
  let afterPreview = false
  const after = registrationHarness({ stopped: () => afterPreview })
  const preview = after.deps.preview
  after.deps.preview = async (req, current) => { const r = await preview(req, current); afterPreview = true; return r }
  assert.deepEqual(await registerBrowserPlan(request(), after.deps), { outcome: 'not-made', why: 'failed' })
  assert.deepEqual([after.calls.reads, after.calls.register], [[], []])
})

test('the turn stopped (the member, an administrator) while the facts are read: nothing registered', async () => {
  const turn = new AbortController()
  const { deps, calls } = registrationHarness({ checker: fakeChecker({ twoReads: true }), onRead: () => turn.abort('stopped-by-admin') })
  deps.context = scope => createBrowserContext({ userId: () => 'u1' }).capture(scope)
  assert.deepEqual(await registerBrowserPlan(request(turn.signal), deps), { outcome: 'not-made', why: 'failed' })
  assert.deepEqual([calls.reads, calls.register], [['/api/episode-groups'], []])
})

test('no combination of its own in this build: nothing read, nothing registered', async () => {
  const { deps, calls } = registrationHarness({ combination: false })
  assert.deepEqual(await registerBrowserPlan(request(), deps), { outcome: 'not-made', why: 'notAllowed' })
  assert.deepEqual(calls, { preview: 0, reads: [], register: [] })
})

test('the operator could not find it: nothing read or registered (its question stays inside)', async () => {
  const { deps, calls } = registrationHarness({ preview: async () => ({ outcome: 'stopped', why: 'not-found', question: 'どれですか' }) })
  assert.equal((await registerBrowserPlan(request(), deps)).outcome, 'not-found')
  assert.deepEqual([calls.reads, calls.register], [[], []])
})

// ---------------------------------------------------------------------------
// The request tool: the plan number and fixed words only
// ---------------------------------------------------------------------------

test('the request tool answers the plan number and fixed words only; the operator\'s question never reaches the chat AI', async () => {
  const cards: string[] = []
  const made = createBrowserRequestTools(async () => ({ outcome: 'registered', planId: PLAN }), id => cards.push(id))
  const text = await made.execute({ site: 'lstep', operation: 'reminder_step_add_template', target_hints: { reminder: '11月' }, change_hints: {}, reason: 'x' })
  assert.equal(text, BROWSER_REQUEST_WORDS.registered(PLAN))
  assert.deepEqual(cards, [PLAN])
  const notFound = createBrowserRequestTools(async () => ({ outcome: 'not-found', question: '「秘密のテンプレート」でよいですか' }), id => cards.push(id))
  const answer = await notFound.execute({ site: 'lstep', operation: 'reminder_step_add_template', target_hints: {}, change_hints: {}, reason: 'x' })
  assert.equal(answer, BROWSER_REQUEST_WORDS.notFound)
  assert.equal(answer.includes('秘密'), false)
  assert.deepEqual(cards, [PLAN])
  let ran = 0
  const bad = createBrowserRequestTools(async () => { ran++; return { outcome: 'registered', planId: PLAN } }, () => {})
  assert.equal(await bad.execute({ site: 'lstep', operation: 'x', target_hints: { 'a b': 'x' }, change_hints: {}, reason: 'x' }), BROWSER_REQUEST_WORDS.badInput)
  assert.equal(ran, 0)
})

// ---------------------------------------------------------------------------
// The server client
// ---------------------------------------------------------------------------

function fakeFetch(answer: (url: string) => { status: number; body?: unknown } | 'throw' = () => ({ status: 200, body: { data: { ok: true } } })) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string | undefined; method: string }> = []
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as string | undefined, method: init.method ?? 'GET' })
    const a = answer(url)
    if (a === 'throw') throw new Error('offline')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status })
  }) as unknown as typeof fetch
  return { fn, seen }
}

test('the execution\'s secret goes only in its header; the report carries no session; an id that is not the server\'s shape never leaves', async () => {
  const f = fakeFetch()
  const http = createBrowserPlansHttp({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch: f.fn })
  await http.permit(COMPANY, EXEC, SECRET, new AbortController().signal)
  await http.report(EXEC, SECRET, { result: 'failed', reason: 'permit-late' })
  const [permit, report] = f.seen
  assert.equal(permit.url, `https://acb.example/api/companies/${COMPANY}/browser-executions/${EXEC}/send-permit`)
  assert.equal(permit.headers[BROWSER_EXECUTION_HEADER], SECRET)
  assert.equal(permit.headers.Cookie, 's=1')
  assert.equal(`${permit.url}${permit.body ?? ''}`.includes(SECRET), false)
  assert.equal(report.url, 'https://acb.example/api/browser-executions/report')
  assert.equal(report.headers[BROWSER_EXECUTION_HEADER], SECRET)
  assert.equal(report.headers.Cookie, undefined)
  assert.equal(`${report.url}${report.body}`.includes(SECRET), false)
  for (const bad of ['../x', 'a/b', '%2e%2e']) assert.deepEqual(await http.get(bad, PLAN), { kind: 'refused', code: null })
  assert.deepEqual(await http.get(COMPANY, '../../me'), { kind: 'refused', code: null })
  assert.equal(f.seen.length, 2)
})

test('a 4xx is the server\'s refusal with its code; a 5xx, a thrown request or no session is no answer', async () => {
  const f = fakeFetch(url => (url.includes('/claim') ? { status: 409, body: { error: 'x', code: 'BROWSER_PLAN_NOT_APPROVED' } } : url.includes('/approve') ? { status: 500 } : 'throw'))
  const http = createBrowserPlansHttp({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch: f.fn })
  assert.deepEqual(await http.claim(COMPANY, PLAN), { kind: 'refused', code: 'BROWSER_PLAN_NOT_APPROVED' })
  assert.deepEqual(await http.approve(COMPANY, PLAN, HASH), { kind: 'no-answer' })
  assert.deepEqual(await http.cancel(COMPANY, PLAN), { kind: 'no-answer' })
  const signedOut = createBrowserPlansHttp({ baseUrl: () => 'https://acb.example', cookies: () => [], fetch: f.fn })
  const before = f.seen.length
  assert.deepEqual(await signedOut.get(COMPANY, PLAN), { kind: 'no-answer' })
  assert.equal(f.seen.length, before)
})

// ---------------------------------------------------------------------------
// The card's IPC
// ---------------------------------------------------------------------------

function planView(over: Partial<BrowserPlanView> = {}): BrowserPlanView {
  return {
    id: PLAN, state: 'draft', closeReason: null, connector: { id: 'lstep', version: '0.6.0', label: 'Lステップ' }, operation: 'reminder_step_add_template',
    label: 'リマインダの段にテンプレートを足す', sharedNote: null, delivers: 'scheduled', account: ACCOUNT,
    target: { reminder: REMINDER, step: STEP }, change: { template: TO_ADD }, facts: {}, explanation: null,
    createdAt: '2026-11-22T03:00:00.000Z', expiresAt: '2026-11-22T04:00:00.000Z', approvedAt: null, contentHash: HASH, execution: null, ...over,
  }
}

function ipcHarness(over: Partial<BrowserPlansIpcDeps<IpcInvokeEvent>> = {}) {
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (c: string, h: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(c, h) }, on() {} } as unknown as IpcRegistrar
  const calls: string[] = []
  const runs: unknown[] = []
  let release: (r: BrowserRunResult) => void = () => {}
  const ok = (value: unknown): BrowserApiAnswer => ({ kind: 'ok', value })
  registerBrowserPlansIpc(ipc, {
    fromMainWindow: event => event.sender.id === 1,
    plans: {
      get: async (c, p) => { calls.push(`get ${c} ${p}`); return ok(planView()) },
      open: async c => { calls.push(`open ${c}`); return ok({ items: [], more: false }) },
      cancel: async (c, p) => { calls.push(`cancel ${c} ${p}`); return ok(planView({ state: 'closed' })) },
      confirm: async (c, e, r) => { calls.push(`confirm ${c} ${e} ${r}`); return ok({}) },
    },
    runner: { run: input => { runs.push(input); return new Promise(resolve => { release = resolve }) } },
    readiness: async () => { calls.push('readiness'); return { ok: true } },
    stoppedHere: () => false,
    siteHost: () => HOST,
    ...over,
  })
  const from = (id: number) => ({ sender: { id, isDestroyed: () => false, send() {} } })
  return { call: (channel: string, sender: number, ...args: unknown[]) => handlers.get(channel)!(from(sender), ...args), calls, runs, release: (r: BrowserRunResult) => release(r) }
}

test('only the main window\'s own page reaches the plans: any other sender gets nothing and nothing is asked', async () => {
  const h = ipcHarness()
  for (const [channel, args] of [['browserPlans:list', [COMPANY]], ['browserPlans:get', [COMPANY, PLAN]], ['browserPlans:run', [COMPANY, PLAN, HASH]],
    ['browserPlans:cancel', [COMPANY, PLAN]], ['browserPlans:confirm', [COMPANY, EXEC, 'done']]] as const) {
    assert.equal((await h.call(channel, 2, ...args) as { ok: boolean }).ok, false, channel)
  }
  assert.deepEqual([h.calls, h.runs], [[], []])
})

test('［任せる］ hands the runner exactly the company, the plan and the shown hash; anything else is refused at the entry', async () => {
  const h = ipcHarness()
  for (const args of [[COMPANY, PLAN, 'sha256:short'], [COMPANY, 'bp_x', HASH], ['../c', PLAN, HASH], [COMPANY, PLAN, { contentHash: HASH }], [COMPANY, PLAN]]) {
    assert.equal((await h.call('browserPlans:run', 1, ...args) as { ok: boolean }).ok, false)
  }
  assert.equal((await h.call('browserPlans:confirm', 1, COMPANY, EXEC, 'maybe') as { ok: boolean }).ok, false)
  assert.equal((await h.call('browserPlans:get', 1, COMPANY, `${PLAN}/../x`) as { ok: boolean }).ok, false)
  assert.deepEqual([h.calls, h.runs], [[], []])
  const first = h.call('browserPlans:run', 1, COMPANY, PLAN, HASH, 'extra fact')
  assert.deepEqual(h.runs, [{ companyId: COMPANY, planId: PLAN, contentHash: HASH }])
  // While it runs: a second press is not a second run, and the card says it runs here.
  assert.deepEqual(await h.call('browserPlans:run', 1, COMPANY, PLAN, HASH), { ok: true, result: { outcome: 'refused', reason: 'already-running' } })
  const card = await h.call('browserPlans:get', 1, COMPANY, PLAN) as { ok: true; card: { ready: unknown; runningHere: boolean } }
  assert.deepEqual([card.card.ready, card.card.runningHere], [{ ok: false, reason: 'busy' }, true])
  h.release({ outcome: 'succeeded' })
  assert.deepEqual(await first, { ok: true, result: { outcome: 'succeeded' } })
  assert.equal(h.runs.length, 1)
})

test('the card gets only the fields it reads, each of its shape; anything else of the answer stays in main', async () => {
  const extra = { ...planView(), secret: SECRET, content: '{"x":1}', execution: null }
  const h = ipcHarness({ plans: { get: async () => ({ kind: 'ok', value: extra }), open: async () => ({ kind: 'no-answer' }), cancel: async () => ({ kind: 'no-answer' }), confirm: async () => ({ kind: 'no-answer' }) } })
  const got = await h.call('browserPlans:get', 1, COMPANY, PLAN) as { ok: true; card: { plan: Record<string, unknown> } }
  assert.equal(got.ok, true)
  assert.equal(JSON.stringify(got.card.plan).includes(SECRET), false)
  assert.equal('content' in got.card.plan, false)
  for (const bad of [{ ...planView(), contentHash: 'x' }, { ...planView(), state: 'sent' }, { ...planView(), target: { reminder: 7 } },
    { ...planView(), facts: { a: { status: 'known', value: 1 } } }, { ...planView(), execution: { id: '../bx_1', state: 'unknown', claimedAt: '2026-11-22T03:00:00.000Z', permittedAt: null, settledAt: null, confirmableAt: null, voidReason: null, confirmedBy: null } }]) {
    const odd = ipcHarness({ plans: { get: async () => ({ kind: 'ok', value: bad }), open: async () => ({ kind: 'no-answer' }), cancel: async () => ({ kind: 'no-answer' }), confirm: async () => ({ kind: 'no-answer' }) } })
    assert.equal((await odd.call('browserPlans:get', 1, COMPANY, PLAN) as { ok: boolean }).ok, false, JSON.stringify(bad).slice(0, 80))
  }
})

test('a plan the server says is not there reads as not found; an unreachable server as offline', async () => {
  const gone = ipcHarness({ plans: { get: async () => ({ kind: 'refused', code: 'BROWSER_PLAN_NOT_FOUND' }), open: async () => ({ kind: 'no-answer' }), cancel: async () => ({ kind: 'refused', code: 'BROWSER_TOO_EARLY' }), confirm: async () => ({ kind: 'refused', code: 'BROWSER_TOO_EARLY' }) } })
  assert.deepEqual(await gone.call('browserPlans:get', 1, COMPANY, PLAN), { ok: false, offline: false, message: 'この計画は見つかりませんでした。' })
  assert.equal((await gone.call('browserPlans:list', 1, COMPANY) as { offline: boolean }).offline, true)
  assert.match((await gone.call('browserPlans:confirm', 1, COMPANY, EXEC, 'not_done') as { message: string }).message, /まだ確かめられません/)
})

// ---------------------------------------------------------------------------
// Whether ［任せる］ can be pressed on this PC
// ---------------------------------------------------------------------------

test('［任せる］ only where the site\'s window is open and shows the plan\'s account; never while switched off', async () => {
  let account = ACCOUNT
  let closed = false
  const reads: string[] = []
  const checker: BrowserChecker = { ...fakeChecker(), view: () => ({ account, state: { templates: [] }, ignored: {}, problem: null }) }
  const deps = (on = true) => ({
    aiSwitch: () => on, connector, checker: () => checker, site: () => SITE, stopped: () => false,
    window: () => ({ closed: () => closed, read: async (p: string) => { reads.push(p); return { status: 200, body: '<html></html>' } } }),
  })
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), deps(false)), { ok: false, reason: 'off' })
  assert.deepEqual(reads, [], 'switched off: the site is not read')
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), deps()), { ok: true })
  assert.deepEqual(reads, [`/line/episode/show/${REMINDER}`])
  account = '5559999'
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), deps()), { ok: false, reason: 'not-logged-in' })
  account = ACCOUNT
  // The window open and logged in, but the company's setting no longer lists the site, or the AI is stopped.
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), { ...deps(), site: () => null }), { ok: false, reason: 'no-window' })
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), { ...deps(), stopped: () => true }), { ok: false, reason: 'stopped' })
  closed = true
  assert.deepEqual(await browserCardReadiness(COMPANY, planView(), deps()), { ok: false, reason: 'no-window' })
  assert.deepEqual(await browserCardReadiness(COMPANY, planView({ state: 'approved' }), deps()), { ok: false, reason: 'state' })
})

// ---------------------------------------------------------------------------
// The context and this build's combination
// ---------------------------------------------------------------------------

test('a capture reads false after a sign-in change, a changed browser setting, a quit or the turn\'s stop — not after the same setting again', () => {
  let user: string | null = 'u1'
  const ctx = createBrowserContext({ userId: () => user })
  ctx.policyAnswered(COMPANY, { mode: 'on', sites: [SITE] })
  const a = ctx.capture({ companyId: COMPANY })
  ctx.policyAnswered(COMPANY, { mode: 'on', sites: [SITE] })
  assert.equal(a(), true)
  ctx.policyAnswered(COMPANY, { mode: 'off', sites: [] })
  assert.equal(a(), false)
  const b = ctx.capture({ companyId: COMPANY })
  user = 'u2'
  assert.equal(b(), false)
  const stop = new AbortController()
  const c = ctx.capture({ companyId: COMPANY, signal: stop.signal })
  assert.equal(c(), true)
  stop.abort()
  assert.equal(c(), false)
  const d = ctx.capture({ companyId: COMPANY })
  ctx.advance()
  assert.equal(d(), false)
  ctx.quitting()
  assert.equal(ctx.capture({ companyId: COMPANY })(), false)
  user = null
  assert.equal(createBrowserContext({ userId: () => user }).capture({ companyId: COMPANY })(), false, 'signed out')
})

test('the build\'s combination is carried.json\'s row whose declaration hash is the bundled text\'s; anything doubtful is none', () => {
  const carried = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/browser-connectors/carried.json'), 'utf8'))
  const approved = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/browser-connectors/approved.json'), 'utf8')) as { combinations: Array<Record<string, unknown>> }
  const real = createCarriedCombinations(carried, [lstep.declaration])('lstep', '0.6.0')
  assert.ok(real)
  assert.ok(approved.combinations.some(r => r.declarationHash === real.declarationHash && r.checkerHash === real.checkerHash && r.factsVersion === real.factsVersion))
  assert.equal(createCarriedCombinations(carried, [lstep.declaration])('lstep', '0.5.0'), null)
  const row = carried.combinations[0]
  assert.equal(createCarriedCombinations({ format: 1, combinations: [{ ...row, declarationHash: `sha256:${'0'.repeat(64)}` }] }, [lstep.declaration])('lstep', '0.6.0'), null)
  assert.equal(createCarriedCombinations({ format: 1, combinations: [row, { ...row, checkerHash: `sha256:${'1'.repeat(64)}` }] }, [lstep.declaration])('lstep', '0.6.0'), null)
  assert.equal(createCarriedCombinations(carried, [])('lstep', '0.6.0'), null)
})

// ---------------------------------------------------------------------------
// As it ships: the switch off
// ---------------------------------------------------------------------------

test('as it ships (the build\'s switch off): ［任せる］, the request and the tool reach no site, no operator and no server', async () => {
  const handlers = new Map<string, (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (c: string, h: (event: IpcInvokeEvent, ...args: unknown[]) => Promise<unknown>) => { handlers.set(c, h) }, on() {} } as unknown as IpcRegistrar
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-plans-'))
  const touched: string[] = []
  try {
    const wired = wireBrowserPlans(ipc, {
      fromMainWindow: () => true, baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], userId: () => 'u1', userDataDir: () => dir,
      windows: {
        siteNow: () => SITE,
        runWindow: () => { touched.push('run window'); return null },
        previewWindow: () => { touched.push('preview window'); return null },
      },
      stopped: () => false,
      connectors: { declarations: [lstep.declaration], checkers: lstep.checkers, readers: lstep.readers },
      operator: () => { touched.push('operator'); return null },
      cliPath: () => { touched.push('cli'); return '/bin/false' },
      parentEnv: () => ({}),
      fetch: (async () => { touched.push('fetch'); throw new Error('no') }) as unknown as typeof fetch,
      log: { warn() {} },
    })
    const run = await handlers.get('browserPlans:run')!({ sender: { id: 1, isDestroyed: () => false, send() {} } }, COMPANY, PLAN, HASH)
    assert.deepEqual(run, { ok: true, result: { outcome: 'refused', reason: 'off' } })
    assert.equal(wired.requestAvailable(), false)
    // The consultation's turn gets no tool at all (chat-server.ts offers `acb_browser` only when this is given).
    assert.equal(browserRequestForTurn(wired, { companyId: COMPANY, conversationId: null, signal: new AbortController().signal, onPlan: () => {} }), undefined)
    // Switched on, the turn's tool hands the request the turn's own company, consultation and signal (its stop).
    const asked: Array<{ companyId: string; conversationId: string | null; signal: AbortSignal; site: string }> = []
    const turn = new AbortController()
    const tool = browserRequestForTurn({ requestAvailable: () => true, request: async input => { asked.push(input); return { outcome: 'not-made', why: 'off' } } },
      { companyId: COMPANY, conversationId: 'conv-9', signal: turn.signal, onPlan: () => {} })
    assert.equal(await tool?.execute({ site: 'lstep', operation: 'reminder_step_add_template', target_hints: {}, change_hints: {}, reason: 'x' }), BROWSER_REQUEST_WORDS.off)
    assert.equal(asked.length, 1)
    assert.deepEqual([asked[0].companyId, asked[0].conversationId, asked[0].site, asked[0].signal === turn.signal], [COMPANY, 'conv-9', 'lstep', true])
    assert.deepEqual(await wired.request({ companyId: COMPANY, conversationId: null, site: 'lstep', operation: 'reminder_step_add_template', hints: { targetHints: {}, changeHints: {}, reason: '' }, signal: new AbortController().signal }),
      { outcome: 'not-made', why: 'off' })
    assert.deepEqual(touched, [])
    assert.equal(fs.existsSync(path.join(dir, 'browser-runs')), false, 'no run record written')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
