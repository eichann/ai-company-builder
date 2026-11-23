// The Electron side of tests/browser-window-electron.test.ts: runs the app's real browser window
// (electron/browser-window.ts) against the local sites (./sites.ts) and writes what happened as JSON to
// `<BROWSER_TEST_DIR>/result.json` (written whole, then renamed: the test reads it after the process
// exited — a long line on stdout could be cut when Electron quits before its pipe is drained). Started by
// the test with `NODE_OPTIONS=--import tsx`.
//
// The certificate: production code trusts only what the system trusts. This harness alone trusts
// its own self-signed certificate for the three test hosts, on the test session only
// (`setCertificateVerifyProc`, matched by fingerprint and host); `untrusted.test` is served with the
// same certificate but not trusted here, so the window's own refusal of a bad certificate is seen.
import { app, BrowserWindow, session } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createBrowserWindowShell, type BrowserShellWindow } from '../../electron/browser-window'
import { browserPartition } from '../../electron/features/browser/controller'
import { createBrowserRunner } from '../../electron/features/browser/runner'
import type { BrowserSiteSetting } from '../../../shared/core/browser-operation'
import { browserLoginHelpers, createBrowserCheckerRegistry, createBrowserConnectors } from '../../shared/browser-checkers'
import { lstepConnector } from '../../connectors/lstep'
import { LSTEP_DECLARATION } from '../../connectors/lstep/declaration'
import { browserReadPartition, browserWritePartition } from '../../shared/browser-operation'
import { createRunGate, encodeForm, FORM_CONTENT_TYPE, type BrowserChecker, type BrowserRunSurface, type BrowserStepRecord } from '../../shared/browser-runner'
import { readBrowserFacts } from '../../shared/browser-facts'
import { parseBrowserHtml } from '../../electron/features/browser/html'
import { fakePlansServer, type FakeServerFaults } from '../browser-plans-fake'
import { startSites, type Sites } from './sites'

const dir = process.env.BROWSER_TEST_DIR!
const [port, evilPort, udpPort] = (process.env.BROWSER_TEST_PORTS ?? '').split(',').map(Number)
const TRUSTED = ['op.test', 'assets.test', 'evil.test', 'helper.test', 'helper-parts.test']
app.commandLine.appendSwitch('host-rules', [
  ...['op.test', 'assets.test', 'untrusted.test', 'helper.test', 'helper-parts.test'].map(h => `MAP ${h} 127.0.0.1:${port}`),
  `MAP evil.test 127.0.0.1:${evilPort}`,
].join(', '))
app.setPath('userData', path.join(dir, 'userData'))
app.setPath('downloads', path.join(dir, 'downloads'))
fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })

const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'cert.pem')))
const fingerprint = `sha256/${crypto.createHash('sha256').update(certificate.raw).digest('base64')}`
const trustTestCertificate = (partition: string) => {
  session.fromPartition(partition).setCertificateVerifyProc((request, callback) => {
    callback(TRUSTED.includes(request.hostname) && request.certificate.fingerprint === fingerprint ? 0 : -3)
  })
}

// A run's write gets a fresh session of its own (browser-window.ts): it trusts the test certificate too.
let sessionsCreated = 0
app.on('session-created', created => {
  sessionsCreated++
  created.setCertificateVerifyProc((request, callback) => {
    callback(TRUSTED.includes(request.hostname) && request.certificate.fingerprint === fingerprint ? 0 : -3)
  })
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const result: Record<string, unknown> = {}
/** The result, whole: written to a temporary name and renamed, so the test never reads half of it. */
const writeResult = (value: unknown) => {
  const file = path.join(dir, 'result.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}
const fail = (error: unknown) => {
  writeResult({ error: error instanceof Error ? error.stack : String(error) })
  app.exit(1)
}
setTimeout(() => fail(new Error('the harness timed out')), 90_000)

function loaded(win: BrowserShellWindow): Promise<void> {
  return new Promise(resolve => {
    if (!win.webContents.isLoading() && win.webContents.getURL()) { resolve(); return }
    win.webContents.once('did-stop-loading', () => resolve())
  })
}

async function run() {
  const sites = await startSites(dir, { site: port, evil: evilPort, udp: udpPort })
  const refusalLog: string[] = []
  // The bundled Lステップ declaration's login helpers, with test hosts for Google's (helper.test framed and
  // posted to, helper-parts.test its parts) and op.test for the site.
  const loginHelpers = browserLoginHelpers([LSTEP_DECLARATION.replace('host: manager.linestep.net', 'host: op.test')
    .replace('[d1nhtjid4lgi9y.cloudfront.net, profile.line-scdn.net]', '[assets.test]')
    .replace('host: www.google.com', 'host: helper.test').replace('host: www.gstatic.com', 'host: helper-parts.test')])
  const shell = createBrowserWindowShell({ show: false, log: { warn: line => { refusalLog.push(String(line)) } }, loginHelpers })
  const site: BrowserSiteSetting = { host: 'op.test', level: 'write', assetHosts: ['assets.test'] }
  const partition = browserPartition('user-1', 'company-1', 'op.test')
  result.partitionInMemory = !partition.startsWith('persist:')
  trustTestCertificate(partition)
  let closed = false
  const win = shell.open({ partition, site, onClosed: () => { closed = true } })
  const page = win.webContents
  await loaded(win)
  await wait(1500)
  const js = (code: string) => page.executeJavaScript(code, true).catch((error: unknown) => { throw new Error(`${String(error)} in: ${code.slice(0, 80)}`) })

  // The member clicks every way out (a user gesture each).
  // A click that cannot run (the page was left) is recorded, and the run goes on to count what leaked.
  const clicksNotRun: string[] = []
  for (const id of ['popup', 'js', 'nav', 'redirect-nav', 'download', 'download-evil']) {
    await js(`document.getElementById('${id}').click()`).catch(() => { clicksNotRun.push(id) })
    await wait(400)
  }
  await js(`window.open('https://evil.test/window-open'); 1`).catch(() => { clicksNotRun.push('window.open') })
  result.clicksNotRun = clicksNotRun
  result.urlDuringClicks = page.getURL()
  if (clicksNotRun.length > 0) { await page.loadURL('https://op.test/').catch(() => {}); await wait(500) }
  result.notificationPermission = await js(`Notification.requestPermission()`)
  result.geolocation = await js(`new Promise(r => navigator.geolocation.getCurrentPosition(() => r('granted'), e => r('denied:' + e.code)))`)
  result.assetScriptRan = await js(`window.assetScript === true`)
  // Nothing of the app reaches the page: no preload bridge, no Node.
  result.pageGlobals = await js(`[typeof window.electronAPI, typeof require, typeof process].join(',')`)
  await wait(1500)
  result.urlAfterClicks = page.getURL()
  result.windowsAfterClicks = BrowserWindow.getAllWindows().length
  result.downloads = fs.readdirSync(path.join(dir, 'downloads'))

  // The member's own write in `human` mode goes out as in any browser.
  result.humanPost = await js(`fetch('/human-save', { method: 'POST', body: 'h' }).then(r => r.status, () => 'refused')`)

  // `ai` mode, no approved step: every write to the operated host is refused, reads still pass.
  await win.setMode('ai', { stopped: () => false })
  const aiWrites = async () => ({
    fetch: await js(`fetch('/ai-fetch', { method: 'POST', body: 'ok' }).then(r => r.status, () => 'refused')`),
    xhr: await js(`new Promise(r => { const x = new XMLHttpRequest(); x.open('PUT', '/ai-xhr'); x.onload = () => r(x.status); x.onerror = () => r('refused'); x.send('ok') })`),
    beacon: await js(`navigator.sendBeacon('/ai-beacon', 'ok')`),
    websocket: await js(`new Promise(r => { const w = new WebSocket('wss://op.test/ai-ws'); w.onerror = () => r('refused'); w.onopen = () => r('open') })`),
    read: await js(`fetch('/ai-read').then(r => r.status, () => 'refused')`),
  })
  result.aiWithoutStep = await aiWrites()
  await js(`document.getElementById('form').submit()`)
  await wait(1000)
  result.urlAfterForm = page.getURL()
  // The refused form left an error page: back to the site (a read, allowed in `ai` mode).
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(500)
  // A dedicated worker's write is the page's too: the gate sees it.
  result.aiWorker = await js(`new Promise(r => { const w = new Worker('/worker.js'); w.onmessage = e => r(e.data); w.onerror = () => r('no worker') })`)
  // Writes sent while the page goes away (keepalive fetch, beacon on pagehide / unload).
  await js(`addEventListener('pagehide', () => {
    fetch('/ai-keepalive', { method: 'POST', body: 'k', keepalive: true }).catch(() => {})
    navigator.sendBeacon('/ai-unload-beacon', 'b')
  }); 1`)
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(1000)

  // An approved step: only the write its decider says yes to goes out.
  await win.setMode('ai', { stopped: () => false, decide: write => write.url === 'https://op.test/ai-ok' && write.body === 'approved' })
  result.aiApproved = await js(`fetch('/ai-ok', { method: 'POST', body: 'approved' }).then(r => r.status, () => 'refused')`)
  result.aiNotApproved = await js(`fetch('/ai-not-ok', { method: 'POST', body: 'approved' }).then(r => r.status, () => 'refused')`)
  result.aiOverride = await js(`fetch('/ai-ok', { method: 'POST', body: 'approved', headers: { 'X-HTTP-Method-Override': 'DELETE' } }).then(r => r.status, () => 'refused')`)
  // The emergency stop: the same approved write is refused.
  await win.setMode('ai', { stopped: () => true, decide: () => true })
  result.aiStopped = await js(`fetch('/ai-ok', { method: 'POST', body: 'approved' }).then(r => r.status, () => 'refused')`)
  await win.setMode('human')
  result.humanAgain = await js(`fetch('/human-again', { method: 'POST', body: 'h' }).then(r => r.status, () => 'refused')`)

  result.helpers = await helperScenarios(win, js)
  result.runner = await runnerScenarios(win, site, sites, js, partition)

  // The login: a cookie and storage of the site, then cleared.
  await js(`document.cookie = 'sid=1; Secure; Max-Age=3600'; localStorage.setItem('k', 'v'); 1`)
  const ses = session.fromPartition(partition)
  result.cookiesBefore = (await ses.cookies.get({})).length
  result.partitionFolders = fs.existsSync(path.join(dir, 'userData', 'Partitions')) ? fs.readdirSync(path.join(dir, 'userData', 'Partitions')) : []
  // The page tries to keep its window open (the member already clicked in it, so the handler counts).
  await js(`addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' }); 1`)
  win.close()
  await wait(500)
  result.closed = closed
  result.refusalLog = refusalLog
  // With its window closed the session reaches nowhere.
  result.afterClose = await ses.fetch('https://op.test/after-close').then(r => r.status, () => 'refused')
  await shell.clearPartition(partition)
  result.cookiesAfter = (await ses.cookies.get({})).length

  // A certificate the system does not trust is refused, never bypassed.
  const untrusted = browserPartition('user-1', 'company-1', 'untrusted.test')
  trustTestCertificate(untrusted)
  const other = shell.open({ partition: untrusted, site: { host: 'untrusted.test', level: 'read', assetHosts: [] }, onClosed: () => {} })
  await loaded(other)
  await wait(500)
  result.untrustedUrl = other.webContents.getURL()
  other.close()

  // Late arrivals (reports are sent after a delay): give them a moment.
  await wait(2000)
  result.hits = sites.hits
  result.evilConnections = sites.evilConnections
  result.udpPackets = sites.udpPackets
  sites.close()
  writeResult(result)
  app.quit()
}

/**
 * Login helpers (agent-browser.md "Login helpers") on a login page with a CAPTCHA-like frame
 * (sites.ts `/login-captcha`): they work in `human` mode; entering `ai` mode with the frame still there
 * leaves the page not clean (the run stops: `pageClean`); in `ai` mode on a page without it, the page's new frame, script and fetch of the helpers
 * reach nothing; back in `human` they work again.
 */
async function helperScenarios(win: BrowserShellWindow, js: (code: string) => Promise<unknown>) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  const hooks = { stopped: () => false, pageRead: () => true, sessionRequest: () => ({ allow: false as const, reason: 'none' }) }
  const subframes = () => page.mainFrame.framesInSubtree.filter(f => f !== page.mainFrame).map(f => f.url)
  // The site's start page frames hosts it does not list (refused, never loaded): no reason to stop the AI.
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(1000)
  out.refusedFrames = subframes()
  out.enteredWithRefusedFrames = await win.run.enterAi(hooks)
  out.cleanWithRefusedFrames = win.run.pageClean()
  await win.run.leaveAi()
  await page.loadURL('https://op.test/login-captcha').catch(() => {})
  await wait(2000)
  out.humanFrames = subframes()
  out.humanApiScript = await js('window.helperApi === true')
  out.humanFrameDone = await js(`new Promise(r => { const f = document.getElementById('captcha'); let n = 0; const t = setInterval(() => { if (window.__captchaDone || ++n > 30) { clearInterval(t); r(window.__captchaDone ?? null) } }, 100) })`)
  out.cleanWithFrameInHuman = win.run.pageClean()
  // In ai mode the frame is still there: the page is not clean (a run stops at its next check), and the
  // helpers are shut meanwhile.
  out.enteredWithFrame = await win.run.enterAi(hooks)
  out.cleanWithFrameInAi = win.run.pageClean()
  out.helperFetchInAiWithFrame = await js(`fetch('https://helper.test/recaptcha/api.js?during=1').then(r => r.status, () => 'refused')`)
  await win.run.leaveAi()
  // A page without the frame: the AI starts; nothing the page does reaches a helper meanwhile.
  await page.loadURL('https://op.test/after-login').catch(() => {})
  await wait(500)
  out.enterClean = await win.run.enterAi(hooks)
  out.cleanAfterLogin = win.run.pageClean()
  out.aiScript = await js(`new Promise(r => { const s = document.createElement('script'); s.src = 'https://helper-parts.test/recaptcha/frame.js?ai=1'; s.onload = () => r('loaded'); s.onerror = () => r('refused'); document.head.append(s) })`)
  out.aiFetch = await js(`fetch('https://helper.test/recaptcha/reload?ai=1', { method: 'POST', body: 'r' }).then(r => r.status, () => 'refused')`)
  await js(`(() => { const f = document.createElement('iframe'); f.src = 'https://helper.test/recaptcha/anchor?ai=1'; document.body.append(f); return 1 })()`)
  await wait(1500)
  out.aiFrames = subframes()
  await win.run.leaveAi()
  // Back to the member: the same frame loads again.
  await page.loadURL('https://op.test/after-login').catch(() => {})
  await wait(300)
  await js(`(() => { const f = document.createElement('iframe'); f.src = 'https://helper.test/recaptcha/anchor?again=1'; document.body.append(f); return 1 })()`)
  await wait(1500)
  out.againFrames = subframes()
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(300)
  return out
}

const PLAN_A = 'bp_00000000000000000000000000000a0a'
const PLAN_B = 'bp_00000000000000000000000000000b0b'
const PLAN_C = 'bp_00000000000000000000000000000c0c'
const PLAN_D = 'bp_00000000000000000000000000000d0d'
const PLAN_E = 'bp_00000000000000000000000000000e0e'
const PLAN_F = 'bp_00000000000000000000000000000f0f'
const PLAN_G = 'bp_00000000000000000000000000000101'
const PLAN_H = 'bp_00000000000000000000000000000202'
/**
 * A sandboxed frame the page makes while the AI operates (opaque origin, possibly a process of its own —
 * DevTools Fetch on the page does not see such a frame), whose script at once tries a write and a read
 * of the operated host (agent-browser.md "Login helpers").
 */
const SANDBOXED_FRAME = `(() => {
  const f = document.createElement('iframe')
  f.setAttribute('sandbox', 'allow-scripts')
  f.srcdoc = '<script>fetch("https://op.test/line/frame-write", { method: "POST", body: "x", mode: "no-cors" }).catch(() => {}); fetch("https://op.test/line/frame-read", { mode: "no-cors" }).catch(() => {})<' + '/script>'
  document.body.append(f)
  return 1
})()`
const COMBINATION = { declarationHash: `sha256:${'d'.repeat(64)}`, checkerHash: `sha256:${'c'.repeat(64)}`, factsVersion: 2 }

/**
 * The test site's checker with facts the runner can compare (version 2): the account, the step's parent
 * and its state read by the checker's own view from the reminder page (as 0.6.1 does), everything else
 * fixed values stamped from the site's JSON list of reminders (0.6.1's other reads are the unit tests'
 * job, client/tests/browser-execute.test.ts). What is real here is the window: the read and write
 * sessions, the permit inside the write's chunk and the last check right before the request leaves.
 */
function harnessFacts(real: BrowserChecker): BrowserChecker {
  return {
    ...real,
    facts: {
      version: 2,
      next: (v, answers) => answers.length === 0
        ? [{ read: 'reminder', values: { reminder: v.target.reminder } }, { read: 'reminders', values: { group: '29529' }, page: 1 }]
        : [],
      read: (v, answers) => {
        const page = answers[0]
        const view = page && page.ok && page.kind === 'html' ? real.view(v, [{ path: `/line/episode/show/${v.target.reminder}`, body: page.body }]) : null
        const unknown = { status: 'unknown' as const, from: 0 }
        if (!view?.state || !view.account) return { facts: { account: unknown, step_parent: unknown, state: unknown, names: unknown, templates: unknown, schedule: unknown, shared_with: unknown } }
        const templates = Object.fromEntries([...view.state.templates, v.change.template].map(id => [id, { name: `テンプレ${id}`, kind: 'text', body: `本文${id}` }]))
        return {
          facts: {
            account: { status: 'known', value: { id: view.account }, from: 0, rawMarkup: true },
            step_parent: { status: 'known', value: { reminder: v.target.reminder }, from: 0, rawMarkup: true },
            state: { status: 'known', value: { templates: [...view.state.templates] }, complete: true, from: 0, rawMarkup: true },
            names: { status: 'known', value: { reminder: '架空のリマインダ', step: '3日前 09:00' }, from: 1 },
            templates: { status: 'known', value: templates, complete: true, from: 1 },
            schedule: { status: 'known', value: { timing: '3日前 09:00' }, complete: true, from: 1 },
            shared_with: { status: 'known', value: { count: 1, items: ['第1回'] }, complete: true, from: 1 },
          },
        }
      },
    },
  }
}

/**
 * The operation runner (agent-browser.md "The runner") on a Lステップ-like site (sites.ts): the member
 * is logged in (a cookie) and shows the reminder page; the runner works through the window's session
 * while the page tries everything it can.
 */
async function runnerScenarios(win: BrowserShellWindow, site: BrowserSiteSetting, sites: Sites, js: (code: string) => Promise<unknown>, partition: string) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  await js(`document.cookie = 'sid=1; Secure; Max-Age=3600'; 1`)
  // A cookie scoped to the write's own path: the site needs it on the write.
  await page.session.cookies.set({ url: 'https://op.test/line/episode/step/pack', name: 'wp', value: '1', path: '/line/episode/step/pack', secure: true, httpOnly: true })
  const sessionsBefore = sessionsCreated
  await page.loadURL('https://op.test/line/episode/show/101')
  await wait(300)
  // The bundled Lステップ declaration with the test hosts in place of the real ones.
  const text = LSTEP_DECLARATION.replace('host: manager.linestep.net', 'host: op.test')
    .replace('[d1nhtjid4lgi9y.cloudfront.net, profile.line-scdn.net]', '[assets.test]')
  const connector = createBrowserConnectors([text])
  const lstepCheckers = lstepConnector({ account: html => /data-account-id="([^"]+)"/.exec(html)?.[1] ?? null }).checkers
  const checker = harnessFacts(lstepCheckers[0])
  const checkers = createBrowserCheckerRegistry([checker])
  const readers = lstepConnector().readers
  const browser = connector('lstep', '0.6.3')!
  const operation = browser.operations.reminder_step_add_template
  const records: BrowserStepRecord[] = []
  let stopped = false
  let monoJump = 0
  let beforeRead: (() => Promise<void>) | null = null
  // The window as the runner gets it; the harness may act once, right before the run's own first read
  // (after the facts were read again through the read session).
  const window = {
    run: {
      ...win.run,
      async request(r: { method: string; path: string }) {
        if (r.method === 'GET' && beforeRead) { const act = beforeRead; beforeRead = null; await act() }
        return win.run.request(r)
      },
    } satisfies BrowserRunSurface,
    preview: win.preview,
  }
  // Each plan: registered with the facts read from the site now (through the window's read session),
  // approved, and served by its own fake server.
  const servers: Record<string, ReturnType<typeof fakePlansServer>> = {}
  const plan = async (planId: string, over: { target?: Record<string, string>; change: Record<string, string>; account?: string }, faults: FakeServerFaults = {}) => {
    const values = { target: over.target ?? { reminder: '101', step: '201' }, change: over.change }
    const read = await readBrowserFacts({
      checker, browser, operation, factsVersion: 2, values: { target: { reminder: '101', step: '201' }, change: over.change }, readers,
      read: address => win.preview.read(address).catch(() => 'failed' as const), parseHtml: parseBrowserHtml, now: () => new Date(),
    })
    const facts = { ...read.facts! }
    if (over.account) facts.account = { ...facts.account, value: { id: over.account } } as typeof facts.account
    servers[planId] = fakePlansServer({
      planId, companyId: 'company-1', connector: { id: 'lstep', version: '0.6.3', ...COMBINATION }, operation: 'reminder_step_add_template',
      account: over.account ?? 'ACC1', target: values.target, change: values.change, facts, createdAt: Date.now() - 1000,
    }, faults)
  }
  const route = (id: string) => servers[Object.keys(servers).find(k => id === k || id.endsWith(k.slice(-16)))!].api
  const runner = createBrowserRunner({
    aiSwitch: () => true,
    plans: {
      approve: (c, p, h) => route(p).approve(c, p, h), claim: (c, p) => route(p).claim(c, p), cancel: (c, p) => route(p).cancel(c, p),
      permit: (c, e, sec, signal) => route(e).permit(c, e, sec, signal), report: (e, sec, b) => route(e).report(e, sec, b),
    },
    connector, combination: () => COMBINATION, checker: id => checkers.get(id), reader: id => readers.find(r => r.id === id),
    site: () => site, stopped: () => stopped, window: () => window, parse: parseBrowserHtml, context: () => () => true,
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } },
    now: () => Date.now(), monoMs: () => performance.now() + monoJump,
  })
  const runPlan = (planId: string) => runner.run({ companyId: 'company-1', planId, contentHash: servers[planId].contentHash })

  // The happy path, while the page sends the same write, a timer's autosave, an undeclared read and a
  // tampered form.
  await plan(PLAN_A, { change: { template: '301' } })
  beforeRead = async () => {
    out.attack = await js('window.__attack()')
    await wait(1500)
  }
  out.happy = await runPlan(PLAN_A)
  out.happyReports = servers[PLAN_A].state.reports
  out.stepAfterHappy = [...sites.lstep['201']]
  // The write's session holds nothing of the login once the write is done.
  out.writeSessionCookies = (await session.fromPartition(browserWritePartition(partition)).cookies.get({})).length
  out.readSessionCookies = (await session.fromPartition(browserReadPartition(partition)).cookies.get({})).length
  // The preview reads with the member's login through the read session and leaves the window alone:
  // what the member is typing in the page stays.
  await js(`(() => { const i = document.createElement('input'); i.id = '__typing'; i.value = '入力中'; document.body.append(i); return 1 })()`)
  const previewHits = sites.hits.length
  out.previewRead = await win.preview.read('/line/episode/show/101').then(r => r.status, () => 'refused')
  out.previewReachedSite = sites.hits.slice(previewHits).filter(h => h.path === '/line/episode/show/101').length
  // A declared read with a query (Lステップ's reminders, page 1): exactly that address reaches the site;
  // one no declared read can have (percent-encoded) is refused before anything is sent.
  const queryHits = sites.hits.length
  out.previewQueryRead = await win.preview.read('/api/episodes?group=29529&page=1').then(r => r.status, () => 'refused')
  out.previewEncodedRead = await win.preview.read('/api/episodes?group=%32%39&page=1').then(r => r.status, () => 'refused')
  out.previewQueryPaths = sites.hits.slice(queryHits).filter(h => h.path.startsWith('/api/')).map(h => h.path)
  out.typingAfterPreview = await js(`document.getElementById('__typing')?.value ?? null`)
  out.readSessionCookiesAfterPreview = (await session.fromPartition(browserReadPartition(partition)).cookies.get({})).length
  // The plan was approved for another LINE account than the page shows: the facts read again differ.
  await plan(PLAN_B, { change: { template: '302' }, account: 'ACC2' })
  out.wrongAccount = await runPlan(PLAN_B)
  // The emergency stop arrives during the run (right before its own first read, after the facts).
  await plan(PLAN_C, { change: { template: '303' } })
  beforeRead = async () => { stopped = true }
  out.stoppedMidRun = await runPlan(PLAN_C)
  stopped = false
  // The answer to the write is lost: unknown, and the same plan never runs again.
  await plan(PLAN_D, { change: { template: '999' } })
  out.lost = await runPlan(PLAN_D)
  out.lostAgain = await runPlan(PLAN_D)
  out.lostReports = servers[PLAN_D].state.reports
  // A page over the size main reads is refused whole, never read cut short (the facts read again fail).
  await plan(PLAN_E, { target: { reminder: '103', step: '201' }, change: { template: '305' } })
  out.oversize = await runPlan(PLAN_E)
  // The permit answered, but by the monotonic clock it is 5 s old by the last check: the window's write
  // session never ends the request (nothing reaches the site), and the server is told "failed".
  await plan(PLAN_F, { change: { template: '306' } }, { onPermit: () => { monoJump += 5000 } })
  out.late = await runPlan(PLAN_F)
  out.lateReports = servers[PLAN_F].state.reports
  // A script left in the page makes a sandboxed frame once the window is in ai mode (right before the run's
  // first read): the run stops before the permit.
  const frameFacts = () => ({ main: page.mainFrame.processId, frames: page.mainFrame.framesInSubtree.filter(f => f !== page.mainFrame).map(f => ({ origin: f.origin, processId: f.processId })) })
  await page.loadURL('https://op.test/line/episode/show/101').catch(() => {})
  await wait(300)
  await plan(PLAN_G, { change: { template: '307' } })
  beforeRead = async () => { await js(SANDBOXED_FRAME); await wait(500); out.sandboxedFrame = frameFacts() }
  out.frameBeforeRead = await runPlan(PLAN_G)
  // The same frame made while the permit is asked: the last check before the request leaves stops it.
  await page.loadURL('https://op.test/line/episode/show/101').catch(() => {})
  await wait(300)
  await plan(PLAN_H, { change: { template: '308' } }, { onPermit: async () => { await js(SANDBOXED_FRAME); await wait(500) } })
  out.frameAtPermit = await runPlan(PLAN_H)
  out.frameAtPermitReports = servers[PLAN_H].state.reports
  out.records = records.map(r => `${r.planId.slice(-1)}:${r.state}`)

  // The gate itself on the real window: an armed write of step 201 / template 304.
  await page.loadURL('https://op.test/line/episode/show/101').catch(() => {})
  await wait(300)
  const gate = createRunGate({
    host: 'op.test', operation: connector('lstep', '0.6.3')!.operations.reminder_step_add_template,
    values: { target: { reminder: '101', step: '201' }, change: { template: '304' } },
    readPaths: ['/line/episode/show/101'], stopped: () => false,
  })
  out.gateReady = await win.run.enterAi(gate.hooks)
  const send = (pairs: Record<string, string>) => win.run.write({
    method: 'POST', path: '/line/episode/step/pack/template', contentType: FORM_CONTENT_TYPE,
    body: encodeForm(Object.entries({ content_id: '201', template_id: '304', _token: 'tok', _lm_user_id: 'u1', ...pairs })),
  }, { ready: async () => true, beforeSend: () => true }).then(r => (r.sent && r.answer ? r.answer.status : 'refused'), () => 'refused')
  out.notArmed = await send({})
  gate.arm(0)
  out.otherStep = await send({ content_id: '202' })
  out.otherTemplate = await send({ template_id: '305' })
  out.extraKey = await send({ broadcast: '1' })
  out.armedWrite = await send({})
  out.secondSend = await send({})
  out.undeclaredRead = await win.run.request({ method: 'GET', path: '/line/episode/show/102' }).then(r => r.status, () => 'refused')
  out.declaredRead = await win.run.request({ method: 'GET', path: '/line/episode/show/101' }).then(r => r.status, () => 'refused')
  out.pageUndeclaredRead = await js(`fetch('/line/autosave-state').then(r => r.status, () => 'refused')`)
  out.pageDeclaredRead = await js(`fetch('/line/episode/show/101').then(r => r.status, () => 'refused')`)
  await win.run.leaveAi()
  out.gateRefusals = [...gate.refusals()]
  // Every read and write of every run went through the window's one read and one write session, made
  // with the window: the runs make none (they do not pile up).
  out.writeSessionsCreated = sessionsCreated - sessionsBefore
  await page.session.cookies.remove('https://op.test/line/episode/step/pack', 'wp')
  // Back to the site's start page for the rest of the harness.
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(300)
  return out
}

// Closing the test's windows must not end the run (the app's own main.ts keeps running likewise).
app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
