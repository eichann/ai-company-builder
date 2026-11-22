/**
 * 「ブラウザ操作」's operation runner (agent-browser.md "The runner"), the parts that need no browser:
 * the run's gate (which request of a run may go out), the approved plan, Lステップ's checker and its
 * bundled declaration, the per-step record, and that the AI cannot reach a run in this version. A
 * run itself (claim, re-read, permit, send, report): browser-execute.test.ts. The same gate inside a
 * real Electron window: browser-window-electron.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunGate, encodeForm, parseBrowserRunPlan } from '../shared/browser-runner'
import { decideAiRead, decideWindowRequest, type BrowserWindowState } from '../shared/browser-operation'
import { createBrowserCheckerRegistry, createBrowserConnectors, parseBrowserDeclaration } from '../shared/browser-checkers'
import { lstepConnector } from '../connectors/lstep'
import { LSTEP_DECLARATION } from '../connectors/lstep/declaration'
import { createLstepReminderStepChecker, LSTEP_REMINDER_STEP_CHECKER } from '../connectors/lstep/reminder-step'
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
  planId: 'plan-1', companyId: 'c1', connector: { id: 'lstep', version: '0.6.0' }, operation: 'reminder_step_add_template',
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
  // Only real markup: not spelled inside an attribute value, a style, a noscript or a template.
  assert.equal(account(`<div title='<meta name="lm-account-id" content="5550001">'></div>`), null)
  assert.equal(account(`<div title='a>b <meta name="lm-account-id" content="5550001">'></div>`), null, 'a > inside a quoted value does not end the tag')
  assert.equal(account(`<meta name="lm-account-id" content="5550001"><div title='<meta name="lm-account-id" content="999">'></div>`), '5550001')
  assert.equal(account('<style>/* <meta name="lm-account-id" content="5550001"> */</style>'), null)
  assert.equal(account('<noscript><meta name="lm-account-id" content="5550001"></noscript>'), null)
  assert.equal(account('<template><meta name="lm-account-id" content="5550001"></template>'), null)
  // A meta of another name is not the account.
  assert.equal(account('<meta name="lm-account" content="5550001">'), null)
})

test('the bundled declaration passes the core\'s checks, names a reviewed checker, and an unknown checker id is never run', () => {
  const bundled = connectors('lstep', '0.6.0')
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
// The record kept on this PC
// ---------------------------------------------------------------------------

test('the run record survives a restart and an unreadable one refuses every run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-runs-'))
  try {
    const file = path.join(dir, 'runs.json')
    const records = createBrowserRunRecords(file, { warn: () => {} })
    assert.equal(records.has('plan-1'), false)
    records.put({ planId: 'plan-1', operation: 'reminder_step_add_template', step: 0, state: 'permit-asked', at: NOW })
    assert.equal(createBrowserRunRecords(file, { warn: () => {} }).has('plan-1'), true, 'after a restart')
    assert.throws(() => records.put({ planId: 'plan-2', operation: 'x', step: 0, state: 'permit-asked', reason: 'ACC1 template 301' as never, at: NOW }), 'no values')
    fs.writeFileSync(file, '{oops')
    const broken = createBrowserRunRecords(file, { warn: () => {} })
    assert.equal(broken.has('plan-9'), true)
    assert.throws(() => broken.put({ planId: 'plan-9', operation: 'x', step: 0, state: 'claimed', at: NOW }))
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

// 6b-2d: the runner is wired, and the card's ［任せる］ (`browserPlans:run`, main window only) is its one way in.
test('only the card\'s ［任せる］ reaches the runner: one composition makes it, one IPC handler runs it, no agent, chat server or page names it', () => {
  const app = [...sourceFiles(path.join(clientDir, 'electron')), ...sourceFiles(path.join(clientDir, 'src')), ...sourceFiles(path.join(clientDir, 'shared')), ...sourceFiles(path.join(clientDir, 'connectors'))]
  const rel = (f: string) => path.relative(clientDir, f)
  const mentioning = (re: RegExp) => app.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  // Nothing outside features/browser names the runner module, however it is written.
  assert.deepEqual(mentioning(/browser\/runner(\.js|\.ts)?['"]/).filter(f => !f.startsWith('electron/features/browser/')), [])
  // Inside it, the wiring alone takes a value from it; the others only its types.
  const inside = app.filter(f => rel(f).startsWith('electron/features/browser/') && rel(f) !== 'electron/features/browser/runner.ts'
    && /from ['"]\.\/runner(\.js|\.ts)?['"]/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  assert.deepEqual(inside, ['electron/features/browser/plans-api.ts', 'electron/features/browser/plans-ipc.ts', 'electron/features/browser/register.ts', 'electron/features/browser/run-records.ts', 'electron/features/browser/wire.ts'])
  for (const f of inside.filter(f => f !== 'electron/features/browser/wire.ts')) {
    assert.doesNotMatch(fs.readFileSync(path.join(clientDir, f), 'utf8'), /^import \{[^}]*\} from '\.\/runner'/m, `${f} takes only types from the runner`)
  }
  assert.deepEqual(mentioning(/\bcreateBrowserRunner\b/), ['electron/features/browser/runner.ts', 'electron/features/browser/wire.ts'])
  // The IPC module gets the runner injected and calls it in exactly one handler: browserPlans:run, after the sender check.
  const ipcSource = fs.readFileSync(path.join(clientDir, 'electron/features/browser/plans-ipc.ts'), 'utf8')
  assert.equal(ipcSource.match(/runner\.run\(/g)?.length, 1)
  const runHandler = ipcSource.slice(ipcSource.indexOf("ipc.handle('browserPlans:run'"), ipcSource.indexOf("ipc.handle('browserPlans:cancel'"))
  assert.match(runHandler, /runner\.run\(/)
  assert.ok(runHandler.indexOf('deps.fromMainWindow(event)') < runHandler.indexOf('runner.run('))
  // Only the controller hands out a window to run in (the wiring passes it on); only the runner (and the window that defines it) enters ai mode.
  assert.deepEqual(mentioning(/\brunWindow\b/), ['electron/features/browser/controller.ts', 'electron/features/browser/wire.ts'])
  assert.deepEqual(mentioning(/\benterAi\b/), ['electron/browser-window.ts', 'electron/features/browser/runner.ts', 'shared/browser-runner.ts'])
  // The browser's IPC is the member's three buttons, the change event and the plan card's five channels.
  const inventory = fs.readFileSync(path.join(clientDir, 'tests/ipc-harness/ipc-inventory.txt'), 'utf8').split('\n')
  assert.deepEqual(inventory.filter(l => /^(main\.handle|main\.on|contract\.invoke|contract\.send|contract\.sync|contract\.events) browser(Plans)?:/.test(l)).map(l => l.split(' ')[1]).sort(),
    ['browser:changed', 'browser:clearLogin', 'browser:clearLogin', 'browser:open', 'browser:open', 'browser:sites', 'browser:sites',
      'browserPlans:cancel', 'browserPlans:cancel', 'browserPlans:confirm', 'browserPlans:confirm', 'browserPlans:get', 'browserPlans:get',
      'browserPlans:list', 'browserPlans:list', 'browserPlans:run', 'browserPlans:run'])
  // No agent, chat server, preload or renderer code names the runner, its gate or a run window.
  for (const f of app.filter(f => /electron\/agents\/|chat-server|electron\/preload|\/src\//.test(f))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /createBrowserRunner|createRunGate|runWindow|enterAi/, path.relative(clientDir, f))
  }
})
