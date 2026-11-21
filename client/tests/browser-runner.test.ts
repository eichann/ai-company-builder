/**
 * 「ブラウザ操作」's operation runner (agent-browser.md "The runner"), the parts that need no browser:
 * the run's gate (which request of a run may go out), the approved plan, Lステップ's checker and its
 * bundled declaration, the runner's steps against a fake window, the per-step record, and that the AI
 * cannot reach a run in this version. The same gate inside a real Electron window:
 * browser-window-electron.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { PluginBrowser } from '../../shared/core/plugin-browser-declaration'
import {
  createRunGate, encodeForm, parseBrowserRunPlan,
  type BrowserRunGateHooks, type BrowserRunSurface, type BrowserStepRecord,
} from '../shared/browser-runner'
import { decideAiRead, decideWindowRequest, type BrowserWindowState } from '../shared/browser-operation'
import { createBrowserCheckerRegistry, createBrowserConnectors, parseBrowserDeclaration } from '../shared/browser-checkers'
import { lstepConnector } from '../connectors/lstep'
import { LSTEP_DECLARATION } from '../connectors/lstep/declaration'
import { createLstepReminderStepChecker, LSTEP_REMINDER_STEP_CHECKER } from '../connectors/lstep/reminder-step'
import { createBrowserRunner, type BrowserRunnerDeps } from '../electron/features/browser/runner'
import { createBrowserRunRecords } from '../electron/features/browser/run-records'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'manager.linestep.net'
const declaration = parseBrowserDeclaration(LSTEP_DECLARATION)!
const operation = declaration.browser.operations.reminder_step_add_template
const values = { target: { reminder: '101', step: '201' }, change: { template: '301' } }
const READ = '/line/episode/show/101'
const WRITE = '/line/episode/step/pack/template'
const url = (p: string) => `https://${HOST}${p}`
const planned = (over: Record<string, string> = {}) =>
  encodeForm(Object.entries({ content_id: '201', template_id: '301', _token: 'tok', _lm_user_id: 'u1', ...over }))
const gateOf = (stopped = () => false) => createRunGate({ host: HOST, operation, values, readPaths: [READ], stopped })

// ---------------------------------------------------------------------------
// The run's gate
// ---------------------------------------------------------------------------

test('the gate lets the one declared write through only while armed, with exactly the plan\'s values, once', () => {
  const gate = gateOf()
  const send = (body: string | undefined, method = 'POST', p = WRITE) => gate.hooks.sessionRequest({ method, url: url(p), body })
  assert.deepEqual(send(planned()), { allow: false, reason: 'not-armed' }, 'nothing before the runner arms it (a page XHR, a timer)')
  gate.arm(0)
  assert.deepEqual(send(planned({ content_id: '202' })), { allow: false, reason: 'wrong-value' }, 'another step')
  assert.deepEqual(send(planned({ template_id: '302' })), { allow: false, reason: 'wrong-value' }, 'another template')
  assert.deepEqual(send(planned({ extra: '1' })), { allow: false, reason: 'extra-key' })
  assert.deepEqual(send(`${planned()}&content_id=201`), { allow: false, reason: 'repeated-key' })
  assert.deepEqual(send(`${planned()}&_method=DELETE`), { allow: false, reason: 'method-override' })
  assert.deepEqual(send(undefined), { allow: false, reason: 'no-body' }, 'a body the gate could not read (an upload)')
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'POST', url: `${url(WRITE)}?x=1`, body: planned() }), { allow: false, reason: 'query' })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'POST', url: `http://${HOST}${WRITE}`, body: planned() }), { allow: false, reason: 'host' })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'POST', url: `https://evil.example.net${WRITE}`, body: planned() }), { allow: false, reason: 'host' })
  assert.deepEqual(send(planned(), 'PUT'), { allow: false, reason: 'not-declared' })
  assert.deepEqual(send(planned()), { allow: true })
  assert.equal(gate.sent(0), true)
  assert.deepEqual(send(planned()), { allow: false, reason: 'not-armed' }, 'a second send of the same write')
  assert.throws(() => gate.arm(0), 'a declared write is never armed twice')
})

test('the gate refuses every write while the AI is stopped, armed or not', () => {
  let stopped = false
  const gate = gateOf(() => stopped)
  gate.arm(0)
  stopped = true
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'POST', url: url(WRITE), body: planned() }), { allow: false, reason: 'stopped' })
  assert.equal(gate.sent(0), false)
})

test('a run reads only its checker\'s declared paths; the page\'s parts load, nothing else of the operated host', () => {
  const gate = gateOf()
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'GET', url: url(READ) }), { allow: true })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'GET', url: url('/line/episode/show/102') }), { allow: false, reason: 'undeclared-read' })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'GET', url: url('/delete') }), { allow: false, reason: 'undeclared-read' })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'GET', url: `${url(READ)}?all=1` }), { allow: false, reason: 'query' })
  assert.deepEqual(gate.hooks.sessionRequest({ method: 'GET', url: url(READ), body: 'x' }), { allow: false, reason: 'read-body' })
  // The page's own reads.
  assert.equal(gate.hooks.pageRead({ url: url('/js/app.js'), resourceType: 'Script' }), true)
  assert.equal(gate.hooks.pageRead({ url: url('/js/app.js?v=3'), resourceType: 'Script' }), false, 'a part with a query (a GET with parameters) does not load')
  assert.equal(gate.hooks.pageRead({ url: url('/delete?id=1'), resourceType: 'Image' }), false)
  assert.equal(gate.hooks.pageRead({ url: url('/img/a.png'), resourceType: 'Image' }), true)
  assert.equal(gate.hooks.pageRead({ url: url(READ), resourceType: 'Document' }), true)
  assert.equal(gate.hooks.pageRead({ url: url('/api/autosave'), resourceType: 'XHR' }), false)
  assert.equal(gate.hooks.pageRead({ url: url('/line/remove?id=1'), resourceType: 'Document' }), false)
  assert.equal(gate.hooks.pageRead({ url: `${url(READ)}?x=1`, resourceType: 'Fetch' }), false)
  assert.equal(gate.hooks.pageRead({ url: 'https://d1nhtjid4lgi9y.cloudfront.net/a.css', resourceType: 'Stylesheet' }), true, 'another host is the request hook\'s')
})

test('in ai mode the window\'s session lets nothing from outside its page reach the operated host — not even main\'s own declared read path (main reads through a page-less session); in human mode the member\'s browsing is untouched', () => {
  const site: BrowserSiteSetting = { host: HOST, level: 'write', assetHosts: [] }
  const ai: BrowserWindowState = { site, mode: 'ai', aiGateReady: true }
  const req = (method: string, p: string, fromWindow: boolean, body?: string) => ({ url: url(p), method, resourceType: 'xhr', fromWindow, body })
  // A service worker's read of the very path main reads, or its write: refused (design memo §33 2-4).
  assert.deepEqual(decideWindowRequest(ai, req('GET', READ, false)), { allow: false, reason: 'ai-outside' })
  assert.deepEqual(decideWindowRequest(ai, req('HEAD', READ, false)), { allow: false, reason: 'ai-outside' })
  assert.deepEqual(decideWindowRequest(ai, req('POST', WRITE, false, planned())), { allow: false, reason: 'ai-unchecked-write' })
  // The page's own read of that path is the page gate's (the run's read rule), not refused here.
  assert.deepEqual(decideWindowRequest(ai, req('GET', READ, true)), { allow: true })
  // In human mode the site's rule alone: the member's own page and its worker reach the site.
  const human: BrowserWindowState = { site, mode: 'human', aiGateReady: false }
  assert.equal(decideWindowRequest(human, req('GET', READ, false)).allow, true)
  assert.equal(decideWindowRequest(human, req('GET', '/other', false)).allow, true)
  assert.equal(decideWindowRequest(human, req('POST', WRITE, false, planned())).allow, true)
})

test('the page\'s reads in a run follow the run\'s read rule on the operated host only', () => {
  const site: BrowserSiteSetting = { host: HOST, level: 'write', assetHosts: ['cdn.example.net'] }
  const gate = gateOf()
  assert.equal(decideAiRead(site, { url: url('/api/poll'), resourceType: 'XHR' }, gate.hooks.pageRead), false)
  assert.equal(decideAiRead(site, { url: url(READ), resourceType: 'XHR' }, gate.hooks.pageRead), true)
  assert.equal(decideAiRead(site, { url: 'https://cdn.example.net/a.js', resourceType: 'XHR' }, () => false), true)
  assert.equal(decideAiRead(site, { url: url('/x'), resourceType: 'XHR' }, () => { throw new Error('x') }), false)
  assert.equal(decideAiRead(site, { url: url('/x'), resourceType: 'XHR' }, undefined), true, 'no run: reads pass as before')
})

// ---------------------------------------------------------------------------
// The approved plan
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000
const planInput = (over: Record<string, unknown> = {}) => ({
  planId: 'plan-1', companyId: 'c1', connector: { id: 'lstep', version: '0.3.0' }, operation: 'reminder_step_add_template',
  account: 'ACC1', target: values.target, change: values.change, before: { templates: ['300'] }, approvedAt: NOW - 1000, expiresAt: NOW + 60_000, ...over,
})

test('a plan is taken only in its exact shape, unexpired and never valid for more than a day', () => {
  assert.ok('value' in parseBrowserRunPlan(planInput(), NOW))
  assert.deepEqual(parseBrowserRunPlan(planInput({ expiresAt: NOW }), NOW), { error: 'expired' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ expiresAt: NOW + 25 * 3600_000 }), NOW), { error: 'expiresAt' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ account: '' }), NOW), { error: 'account' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ account: 'a b' }), NOW), { error: 'account' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ before: { templates: ['<script>'] } }), NOW), { error: 'before' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ target: { reminder: 1 } }), NOW), { error: 'target' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ connector: { id: 'lstep', version: 'latest' } }), NOW), { error: 'connector' })
  // Approved more than a day ago: never, whatever its expiry says; approved "in the future": not a plan.
  assert.deepEqual(parseBrowserRunPlan(planInput({ approvedAt: NOW - 24 * 3600_000 - 1 }), NOW), { error: 'expired' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ approvedAt: NOW + 3600_000 }), NOW), { error: 'approvedAt' })
  assert.deepEqual(parseBrowserRunPlan(planInput({ approvedAt: undefined }), NOW), { error: 'approvedAt' })
})

// ---------------------------------------------------------------------------
// Lステップ's checker and its bundled declaration
// ---------------------------------------------------------------------------

/** A reminder page in the shapes captured on the real site (values made up). */
function lstepPage(o: { account?: string; reminder?: string; steps: Record<string, string[]>; token?: string | string[] }): string {
  const reminder = o.reminder ?? '101'
  const tokens = Array.isArray(o.token) ? o.token : [o.token ?? 'tok']
  let hole = 500
  return `<html><header><span data-account-id="${o.account ?? 'ACC1'}">LINE</span></header>
${tokens.map(t => `<input type="hidden" name="_token" value="${t}">`).join('')}<input name="_lm_user_id" type="hidden" value="u1">
${Object.entries(o.steps).map(([step, templates]) => `<div id="templateStep${step}">
${templates.map(t => `<a onclick="openModal(${reminder}, ${step}, ${hole++}, ${t}, 1)">msg</a>`).join('\n')}</div>`).join('\n')}</html>`
}
const accountReader = (html: string) => /data-account-id="([^"]+)"/.exec(html)?.[1] ?? null
const checker = createLstepReminderStepChecker(accountReader)
/** What the composition root hands the runner: Lステップ's declaration and checkers. */
const connectors = createBrowserConnectors([lstepConnector().declaration])
const checkers = (account?: (html: string) => string | null) => createBrowserCheckerRegistry(lstepConnector({ account }).checkers)
const read = (body: string) => [{ path: READ, body }]

test('Lステップ\'s checker reads the step\'s templates, the account and the CSRF token; a step elsewhere or an id like 0 is no target', () => {
  assert.deepEqual(checker.readPaths(values), [READ])
  const view = checker.view(values, read(lstepPage({ steps: { 201: ['300'], 2010: ['900'], 202: ['301'] } })))
  assert.deepEqual(view, { account: 'ACC1', state: { templates: ['300'] }, ignored: { _token: 'tok', _lm_user_id: 'u1' }, problem: undefined })
  // The step is not on this reminder's page (step 2010 is not step 201).
  assert.equal(checker.view(values, read(lstepPage({ steps: { 202: ['300'] } }))).state, null)
  assert.equal(checker.view(values, read(lstepPage({ steps: { 2010: [] } }))).state, null)
  // The step's box must be an id attribute in the markup, exactly once: not in a comment, a script, a
  // text area or another attribute, never twice.
  const box = (html: string) => checker.view(values, read(`<input type="hidden" name="_token" value="tok"><span data-account-id="ACC1"></span>${html}`)).state
  assert.deepEqual(box('<div id="templateStep201"></div>'), { templates: [] })
  assert.equal(box('<!-- <div id="templateStep201"></div> -->'), null)
  assert.equal(box('<script>const x = \'<div id="templateStep201">\'</script>'), null)
  assert.equal(box('<textarea><div id="templateStep201"></div></textarea>'), null)
  assert.equal(box('<div data-id="templateStep201"></div>'), null)
  assert.equal(box('<div id="templateStep201"></div><p id="templateStep201"></p>'), null)
  // Every slot in the box is this reminder's and this step's; a slot of the step outside its box is not the page we think.
  assert.equal(box('<div id="templateStep201"><a onclick="openModal(999, 201, 1, 300, 1)"></a></div>'), null)
  assert.equal(box('<div id="templateStep201"><a onclick="openModal(101, 202, 1, 300, 1)"></a></div>'), null)
  assert.equal(box('<div id="templateStep201"></div><div id="templateStep202"><a onclick="openModal(101, 201, 1, 300, 1)"></a></div>'), null)
  // A call in a script or a comment is not a slot.
  assert.deepEqual(box('<div id="templateStep201"><!-- openModal(101, 201, 1, 300, 1) --></div>'), { templates: [] })
  assert.deepEqual(box('<div id="templateStep201"><a onclick="openModal(101, 201, 1, 300, 1)"></a></div>'), { templates: ['300'] })
  // A slot of the step under another reminder: not what we think it is.
  assert.equal(checker.view(values, read(lstepPage({ reminder: '999', steps: { 201: ['300'] } }))).state, null)
  // A later operation's extra target id (a slot to remove) is held to the same rule.
  for (const bad of [{ ...values, target: { reminder: '101', step: '0' } }, { ...values, change: { template: '-1' } }, { ...values, target: { reminder: '101', step: '201', hole: 'all' } }]) {
    assert.equal(checker.view(bad, read(lstepPage({ steps: { 0: [], 201: [] } }))).state, null)
  }
  // Two different tokens: none taken, the write cannot be made.
  assert.equal(checker.view(values, read(lstepPage({ steps: { 201: [] }, token: ['a', 'b'] }))).problem, 'csrf-missing')
})

test('the app\'s own Lステップ checker reads the account from the page\'s lm-account-id meta: one value, else none (a run then stops before writing)', () => {
  const account = (head: string) => checkers().get(LSTEP_REMINDER_STEP_CHECKER)!.view(values, read(`<html><head>${head}</head><body>${lstepPage({ steps: { 201: [] } })}</body></html>`)).account
  assert.equal(account('<meta name="lm-account-id" content="5550001">'), '5550001')
  assert.equal(account('<meta content="5550001" name="lm-account-id">'), '5550001')
  // The same value twice is one account; two different values are none.
  assert.equal(account('<meta name="lm-account-id" content="5550001"><meta name="lm-account-id" content="5550001">'), '5550001')
  assert.equal(account('<meta name="lm-account-id" content="5550001"><meta name="lm-account-id" content="5550002">'), null)
  // Missing, empty, not a positive integer, or only inside a comment or a script: none.
  assert.equal(account(''), null)
  assert.equal(account('<meta name="lm-account-id" content="">'), null)
  assert.equal(account('<meta name="lm-account-id" content="0">'), null)
  assert.equal(account('<meta name="lm-account-id" content="all">'), null)
  assert.equal(account('<!-- <meta name="lm-account-id" content="5550001"> -->'), null)
  assert.equal(account('<script>"<meta name=\\"lm-account-id\\" content=\\"5550001\\">"</script>'), null)
  // A meta of another name is not the account.
  assert.equal(account('<meta name="lm-account" content="5550001">'), null)
})

test('the bundled declaration passes the core\'s checks, names a reviewed checker, and an unknown checker id is never run', () => {
  const bundled = connectors('lstep', '0.3.0')
  assert.ok(bundled)
  assert.equal(bundled.host, HOST)
  assert.deepEqual(operation.writes, [{ method: 'POST', path: WRITE, encoding: 'form', body: { content_id: { field: 'step' }, template_id: { field: 'template' } }, ignoreBody: ['_token', '_lm_user_id'] }])
  assert.deepEqual(operation.expect, [{ list: 'templates', change: 'add', field: 'template' }])
  assert.ok(checkers().get(operation.checker))
  assert.equal(checkers().get('lstep.remove_everything'), undefined)
  assert.equal(connectors('lstep', '0.1.0'), null)
  // Two checkers with one id: a run must never pick one of two readers.
  assert.throws(() => createBrowserCheckerRegistry([checker, checker]))
})

// ---------------------------------------------------------------------------
// The runner against a fake window and site
// ---------------------------------------------------------------------------

interface FakeSite {
  steps: Record<string, string[]>
  account: string
  posts: string[]
  /** Called on each read the site answers (to change something mid-run). */
  onRead?: () => void
  /** The POST's answer is lost (applied or not). */
  lose?: 'applied' | 'not-applied'
  /** The write is refused by the site (nothing changes): the status it answers (default 422). */
  reject?: boolean
  rejectStatus?: number
}

function fakeSurface(site: FakeSite) {
  let hooks: BrowserRunGateHooks | null = null
  const calls: string[] = []
  let closed = false
  const surface: BrowserRunSurface = {
    async enterAi(h) { hooks = h; calls.push('ai'); return true },
    async leaveAi() { hooks = null; calls.push('human') },
    async request({ method, path: p, body }) {
      // As the window's request hook does: in ai mode the run's gate decides.
      if (!hooks || !hooks.sessionRequest({ method, url: url(p), body }).allow) throw new Error('refused')
      if (method === 'GET') {
        site.onRead?.()
        return { status: 200, body: lstepPage({ account: site.account, steps: site.steps }) }
      }
      site.posts.push(body ?? '')
      const form = new URLSearchParams(body)
      if (site.lose === 'applied') site.steps[form.get('content_id')!].push(form.get('template_id')!)
      if (site.lose) throw new Error('connection reset')
      if (site.reject) return { status: site.rejectStatus ?? 422, body: '' }
      site.steps[form.get('content_id')!].push(form.get('template_id')!)
      return { status: 302, body: '' }
    },
    closed: () => closed,
  }
  return { surface, calls, close: () => { closed = true } }
}

function harness(o: { plan?: Record<string, unknown>; site?: Partial<FakeSite>; deps?: Partial<BrowserRunnerDeps>; records?: BrowserStepRecord[] } = {}) {
  const site: FakeSite = { steps: { 201: ['300'] }, account: 'ACC1', posts: [], ...o.site }
  const fake = fakeSurface(site)
  const records: BrowserStepRecord[] = [...(o.records ?? [])]
  let stopped = false
  let policy: BrowserSiteSetting | null = { host: HOST, level: 'write', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }
  const runner = createBrowserRunner({
    aiSwitch: () => true,
    approvedPlan: async id => (id === 'plan-1' ? planInput(o.plan) : null),
    connector: connectors,
    checker: id => checkers(accountReader).get(id),
    site: () => policy,
    stopped: () => stopped,
    window: () => fake.surface,
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } },
    now: () => NOW,
    log: { warn: () => {} },
    ...o.deps,
  })
  return { runner, site, records, fake, stop: () => { stopped = true }, dropSite: () => { policy = null } }
}

test('a run sends exactly the planned write once and confirms it on the page', async () => {
  const h = harness()
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'succeeded' })
  assert.deepEqual(h.site.posts, [planned()])
  assert.deepEqual(h.site.steps[201], ['300', '301'])
  assert.deepEqual(h.records.map(r => r.state), ['pending', 'sent', 'succeeded'])
  assert.deepEqual(h.fake.calls, ['ai', 'human'], 'back to the member\'s mode')
  // The record keeps ids and fixed words only: no account, template or token.
  assert.doesNotMatch(JSON.stringify(h.records), /ACC1|301|tok|u1/)
})

test('a plan that started once never runs again (also after its answer was lost)', async () => {
  const h = harness({ site: { lose: 'applied' } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'unknown', reason: 'no-answer' })
  assert.equal(h.site.posts.length, 1)
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'refused', reason: 'already-ran' })
  assert.equal(h.site.posts.length, 1, 'never sent again by itself')
  assert.deepEqual(h.records.map(r => r.state), ['pending', 'sent', 'unknown'])
})

test('the wrong account, an account that cannot be read, a missing target or a changed state stop before any write', async () => {
  const cases: Array<[Parameters<typeof harness>[0], string]> = [
    [{ site: { account: 'ACC2' } }, 'account-mismatch'],
    [{ deps: { checker: id => checkers().get(id) } }, 'account-unknown'],
    [{ site: { steps: { 202: [] } } }, 'target-missing'],
    [{ site: { steps: { 201: ['300', '305'] } } }, 'before-changed'],
  ]
  for (const [setup, reason] of cases) {
    const h = harness(setup)
    assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'stopped', reason }, reason)
    assert.deepEqual(h.site.posts, [], reason)
    assert.equal(h.records.at(-1)?.state, 'failed')
  }
})

test('a stop or a policy change during the run stops it before the write', async () => {
  for (const change of ['stop', 'policy'] as const) {
    const h = harness()
    h.site.onRead = () => (change === 'stop' ? h.stop() : h.dropSite())
    const result = await h.runner.run('plan-1')
    assert.equal(result.outcome, 'stopped', change)
    assert.deepEqual(h.site.posts, [], change)
    assert.deepEqual(h.fake.calls, ['ai', 'human'])
  }
})

test('a plan that expires during the run stops before the write', async () => {
  let now = NOW
  const h = harness({ deps: { now: () => now } })
  h.site.onRead = () => { now = NOW + 61_000 }
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'stopped', reason: 'expired' })
  assert.deepEqual(h.site.posts, [])
})

test('a plan approved more than a day ago stops before the write, whatever its expiry', async () => {
  let now = NOW
  const h = harness({ deps: { now: () => now }, plan: { approvedAt: NOW - 24 * 3600_000 + 1000 } })
  h.site.onRead = () => { now = NOW + 2000 }
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'stopped', reason: 'expired' })
  assert.deepEqual(h.site.posts, [])
})

test('a target field no write carries must be one the checker confirms on the page', async () => {
  const lax = { ...checker, confirms: ['step'] }
  const h = harness({ deps: { checker: () => lax } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'refused', reason: 'target-unconfirmed' })
  assert.deepEqual(h.site.posts, [])
})

test('a step record carries our fixed words only, never a checker\'s text', async () => {
  const chatty = { ...checker, view: (v: typeof values, r: Parameters<typeof checker.view>[1]) => ({ ...checker.view(v, r), problem: 'token ACC1 tok' }) }
  const h = harness({ deps: { checker: () => chatty } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'stopped', reason: 'checker-problem' })
  assert.equal(h.records.at(-1)?.reason, 'checker-problem')
})

test('nothing starts for an expired plan, a stopped AI, a site not allowed, an unknown checker or a type that needs more', async () => {
  assert.deepEqual(await harness({ plan: { expiresAt: NOW - 1 } }).runner.run('plan-1'), { outcome: 'refused', reason: 'expired' })
  const stopped = harness(); stopped.stop()
  assert.deepEqual(await stopped.runner.run('plan-1'), { outcome: 'refused', reason: 'stopped' })
  const off = harness(); off.dropSite()
  assert.deepEqual(await off.runner.run('plan-1'), { outcome: 'refused', reason: 'policy' })
  const readOnly = harness({ deps: { site: () => ({ host: HOST, level: 'read', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }) } })
  assert.deepEqual(await readOnly.runner.run('plan-1'), { outcome: 'refused', reason: 'policy' }, 'the site\'s level is 見るだけ')
  assert.deepEqual(await harness({ deps: { checker: () => undefined } }).runner.run('plan-1'), { outcome: 'refused', reason: 'unknown-checker' })
  const otherChecker: PluginBrowser = { ...declaration.browser, operations: { reminder_step_add_template: { ...operation, checker: 'lstep.something_else' } } }
  assert.deepEqual(await harness({ deps: { connector: () => otherChecker } }).runner.run('plan-1'), { outcome: 'refused', reason: 'unknown-checker' })
  // A registry answering with a checker made for another type is not that type's checker.
  assert.deepEqual(await harness({ deps: { connector: () => otherChecker, checker: () => checker } }).runner.run('plan-1'), { outcome: 'refused', reason: 'unknown-checker' })
  assert.deepEqual(await harness({ plan: { change: { template: '301', extra: '1' } } }).runner.run('plan-1'), { outcome: 'refused', reason: 'plan' })
  assert.deepEqual(await harness({ deps: { window: () => null } }).runner.run('plan-1'), { outcome: 'refused', reason: 'no-window' })
  assert.deepEqual(await harness().runner.run('plan-2'), { outcome: 'refused', reason: 'no-plan' })
})

test('the page must end as the type\'s expect says: a removal of something the person did not see there never starts', async () => {
  // The same site and checker; the declaration says the step loses the template instead of gaining it.
  const removing: PluginBrowser = { ...declaration.browser, operations: { reminder_step_add_template: { ...operation, expect: [{ list: 'templates', change: 'remove', field: 'template' }] } } }
  const h = harness({ deps: { connector: () => removing } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'refused', reason: 'cannot-come-true' })
  assert.deepEqual(h.site.posts, [], 'nothing sent')
  assert.deepEqual(h.fake.calls, [], 'the window never left the member\'s mode')
  // With the template there before, the run goes ahead and judges the page by the declaration: the
  // fake site adds it (a second copy), which is not what this type expects.
  const seen = harness({ deps: { connector: () => removing }, plan: { before: { templates: ['300', '301'] } }, site: { steps: { 201: ['300', '301'] } } })
  assert.deepEqual(await seen.runner.run('plan-1'), { outcome: 'unknown', reason: 'other-state' })
})

test('a type whose page would look the same afterwards never runs: a refused write could not be told from a done one', async () => {
  // Added and taken away again: `expectedAfter` equals what the person saw, so a 422 with nothing changed would read as success.
  const same: PluginBrowser = { ...declaration.browser, operations: { reminder_step_add_template: { ...operation, expect: [{ list: 'templates', change: 'add', field: 'template' }, { list: 'templates', change: 'remove', field: 'template' }] } } }
  const h = harness({ deps: { connector: () => same }, site: { reject: true } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'refused', reason: 'no-visible-change' })
  assert.deepEqual(h.site.posts, [], 'nothing sent')
})

test('nothing is sent when the step\'s state cannot be kept first', async () => {
  const h = harness({ deps: { records: { has: () => false, put: () => { throw new Error('disk full') } } } })
  assert.deepEqual(await h.runner.run('plan-1'), { outcome: 'refused', reason: 'records-unavailable' })
  assert.deepEqual(h.site.posts, [])
  let puts = 0
  const second = harness({ deps: { records: { has: () => false, put: () => { if (++puts === 2) throw new Error('disk full') } } } })
  assert.equal((await second.runner.run('plan-1')).outcome, 'stopped')
  assert.deepEqual(second.site.posts, [], 'the "sent" mark comes before the send')
})

test('after the send: failed only when the site refused it (4xx) and nothing changed; anything else not planned = unknown', async () => {
  const rejected = harness({ site: { reject: true } })
  assert.deepEqual(await rejected.runner.run('plan-1'), { outcome: 'failed', reason: 'refused-by-site' })
  // Answered "fine" (302, 200) or a 5xx, yet nothing to see: not known to have failed.
  for (const status of [200, 302, 500]) {
    const quiet = harness({ site: { reject: true, rejectStatus: status } })
    assert.deepEqual(await quiet.runner.run('plan-1'), { outcome: 'unknown', reason: 'unchanged-unrefused' }, String(status))
  }
  // No slot before and none after: the page may not be read the way we think.
  const empty = harness({ site: { reject: true, steps: { 201: [] } }, plan: { before: { templates: [] } } })
  assert.deepEqual(await empty.runner.run('plan-1'), { outcome: 'unknown', reason: 'empty-state' })
  const lostNotApplied = harness({ site: { lose: 'not-applied' } })
  assert.equal((await lostNotApplied.runner.run('plan-1')).outcome, 'unknown', 'no answer is never read as "not done"')
  const other = harness()
  let reads = 0
  other.site.onRead = () => { if (++reads === 2) other.site.steps[201].push('999') }
  assert.deepEqual(await other.runner.run('plan-1'), { outcome: 'unknown', reason: 'other-state' })
})

test('with the build\'s switch (off in 6b) a run is refused at once: no plan asked, no window touched, nothing read or sent', async () => {
  let asked = 0
  const h = harness()
  const runner = createBrowserRunner({
    approvedPlan: async () => { asked++; return planInput() },
    connector: connectors, checker: id => checkers(accountReader).get(id), site: () => { asked++; return null },
    stopped: () => false, window: () => { asked++; return h.fake.surface },
    records: { has: () => { asked++; return false }, put: () => { asked++ } }, now: () => NOW,
  })
  assert.deepEqual(await runner.run('plan-1'), { outcome: 'refused', reason: 'off' })
  assert.equal(asked, 0)
  assert.deepEqual(h.site.posts, [])
})

test('one run per window at a time', async () => {
  let release: () => void = () => {}
  const h = harness({ plan: {} })
  const slowPlans: Record<string, unknown> = { 'plan-1': planInput(), 'plan-2': planInput({ planId: 'plan-2' }) }
  const gate = new Promise<void>(r => { release = r })
  const runner = createBrowserRunner({
    aiSwitch: () => true,
    approvedPlan: async id => slowPlans[id],
    connector: connectors,
    checker: id => checkers(accountReader).get(id),
    site: () => ({ host: HOST, level: 'write', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }),
    stopped: () => false,
    window: () => ({ ...h.fake.surface, enterAi: async hooks => { await gate; return h.fake.surface.enterAi(hooks) } }),
    records: { has: () => false, put: () => {} },
    now: () => NOW,
  })
  const first = runner.run('plan-1')
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(await runner.run('plan-2'), { outcome: 'refused', reason: 'busy' })
  release()
  assert.equal((await first).outcome, 'succeeded')
})

// ---------------------------------------------------------------------------
// The record kept on this PC
// ---------------------------------------------------------------------------

test('the run record survives a restart and an unreadable one refuses every run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-runs-'))
  try {
    const file = path.join(dir, 'runs.json')
    const records = createBrowserRunRecords(file, { warn: () => {} })
    assert.equal(records.has('plan-1'), false)
    records.put({ planId: 'plan-1', operation: 'reminder_step_add_template', step: 0, state: 'sent', at: NOW })
    assert.equal(createBrowserRunRecords(file, { warn: () => {} }).has('plan-1'), true, 'after a restart')
    assert.throws(() => records.put({ planId: 'plan-2', operation: 'x', step: 0, state: 'sent', reason: 'ACC1 template 301' as never, at: NOW }), 'no values')
    fs.writeFileSync(file, '{oops')
    const broken = createBrowserRunRecords(file, { warn: () => {} })
    assert.equal(broken.has('plan-9'), true)
    assert.throws(() => broken.put({ planId: 'plan-9', operation: 'x', step: 0, state: 'pending', at: NOW }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The AI's entry stays closed in this version
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })
}

test('nothing in the app can start a run yet: no module imports the runner, no IPC channel or preload method reaches it', () => {
  const app = [...sourceFiles(path.join(clientDir, 'electron')), ...sourceFiles(path.join(clientDir, 'src')), ...sourceFiles(path.join(clientDir, 'shared')), ...sourceFiles(path.join(clientDir, 'connectors'))]
  const rel = (f: string) => path.relative(clientDir, f)
  const mentioning = (re: RegExp) => app.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  // Nothing outside features/browser names the runner module, however it is written.
  assert.deepEqual(mentioning(/browser\/runner(\.js|\.ts)?['"]/).filter(f => !f.startsWith('electron/features/browser/')), [])
  // Inside it, only its own record store, and only for a type.
  const inside = app.filter(f => rel(f).startsWith('electron/features/browser/') && rel(f) !== 'electron/features/browser/runner.ts'
    && /from ['"]\.\/runner(\.js|\.ts)?['"]/.test(fs.readFileSync(f, 'utf8'))).map(rel)
  assert.deepEqual(inside, ['electron/features/browser/run-records.ts'])
  assert.match(fs.readFileSync(path.join(clientDir, 'electron/features/browser/run-records.ts'), 'utf8'), /import type \{ BrowserRunRecords \} from '\.\/runner'/)
  assert.deepEqual(mentioning(/\bcreateBrowserRunner\b/), ['electron/features/browser/runner.ts'])
  // Only the controller hands out a window to run in; only the runner (and the window that defines it) enters ai mode for a run.
  assert.deepEqual(mentioning(/\brunWindow\b/), ['electron/features/browser/controller.ts'])
  assert.deepEqual(mentioning(/\benterAi\b/), ['electron/browser-window.ts', 'electron/features/browser/runner.ts', 'shared/browser-runner.ts'])
  // The browser's IPC is exactly the member's three buttons and the change event.
  const inventory = fs.readFileSync(path.join(clientDir, 'tests/ipc-harness/ipc-inventory.txt'), 'utf8').split('\n')
  assert.deepEqual(inventory.filter(l => /^(main\.handle|main\.on|contract\.invoke|contract\.send|contract\.sync|contract\.events) browser:/.test(l)).map(l => l.split(' ')[1]).sort(),
    ['browser:changed', 'browser:clearLogin', 'browser:clearLogin', 'browser:open', 'browser:open', 'browser:sites', 'browser:sites'])
  // No agent, chat server or renderer code names the runner, its gate or a run.
  for (const f of app.filter(f => /electron\/agents\/|chat-server|electron\/preload|\/src\//.test(f))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /createBrowserRunner|browser-runner|runWindow|enterAi/, path.relative(clientDir, f))
  }
})
