// The Electron side of tests/browser-window-electron.test.ts: runs the app's real browser window
// (electron/browser-window.ts) against the local sites (./sites.ts) and prints what happened as one
// `RESULT {json}` line. Started by the test with `NODE_OPTIONS=--import tsx`.
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
import { createBrowserCheckerRegistry, createBrowserConnectors } from '../../shared/browser-checkers'
import { lstepConnector } from '../../connectors/lstep'
import { LSTEP_DECLARATION } from '../../connectors/lstep/declaration'
import { browserReadPartition, browserWritePartition } from '../../shared/browser-operation'
import { createRunGate, encodeForm, FORM_CONTENT_TYPE, type BrowserRunSurface, type BrowserStepRecord } from '../../shared/browser-runner'
import { startSites, type Sites } from './sites'

const dir = process.env.BROWSER_TEST_DIR!
const [port, evilPort, udpPort] = (process.env.BROWSER_TEST_PORTS ?? '').split(',').map(Number)
const TRUSTED = ['op.test', 'assets.test', 'evil.test']
app.commandLine.appendSwitch('host-rules', [
  ...['op.test', 'assets.test', 'untrusted.test'].map(h => `MAP ${h} 127.0.0.1:${port}`),
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
const fail = (error: unknown) => {
  console.log(`RESULT ${JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })}`)
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
  const shell = createBrowserWindowShell({ show: false, log: { warn: line => { refusalLog.push(String(line)) } } })
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
  console.log(`RESULT ${JSON.stringify(result)}`)
  app.quit()
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
  const checkers = createBrowserCheckerRegistry(lstepConnector({ account: html => /data-account-id="([^"]+)"/.exec(html)?.[1] ?? null }).checkers)
  const records: BrowserStepRecord[] = []
  let stopped = false
  let beforeRead: (() => Promise<void>) | null = null
  // The window as the runner gets it; the harness may act once, right before the run's first read.
  const surface: BrowserRunSurface = {
    ...win.run,
    async request(r) {
      if (r.method === 'GET' && beforeRead) { const act = beforeRead; beforeRead = null; await act() }
      return win.run.request(r)
    },
  }
  const plans: Record<string, Record<string, unknown>> = {}
  const plan = (planId: string, over: Record<string, unknown>) => {
    plans[planId] = {
      planId, companyId: 'company-1', connector: { id: 'lstep', version: '0.5.0' }, operation: 'reminder_step_add_template',
      account: 'ACC1', target: { reminder: '101', step: '201' }, change: { template: '301' }, before: { templates: ['300'] },
      approvedAt: Date.now() - 1000, expiresAt: Date.now() + 120_000, ...over,
    }
  }
  const runner = createBrowserRunner({
    aiSwitch: () => true,
    approvedPlan: async id => plans[id] ?? null,
    connector, checker: id => checkers.get(id), site: () => site, stopped: () => stopped,
    window: () => surface,
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } },
    now: () => Date.now(),
  })

  // The happy path, while the page sends the same write, a timer's autosave, an undeclared read and a
  // tampered form.
  plan('plan-a', {})
  beforeRead = async () => {
    out.attack = await js('window.__attack()')
    await wait(1500)
  }
  out.happy = await runner.run('plan-a')
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
  // Another LINE account shown on the page than the plan's.
  plan('plan-b', { account: 'ACC2', change: { template: '302' }, before: { templates: ['300', '301'] } })
  out.wrongAccount = await runner.run('plan-b')
  // The emergency stop arrives during the run (right before its first read).
  plan('plan-c', { change: { template: '303' }, before: { templates: ['300', '301'] } })
  beforeRead = async () => { stopped = true }
  out.stoppedMidRun = await runner.run('plan-c')
  stopped = false
  // The answer to the write is lost: unknown, and the same plan never runs again.
  plan('plan-d', { change: { template: '999' }, before: { templates: ['300', '301'] } })
  out.lost = await runner.run('plan-d')
  out.lostAgain = await runner.run('plan-d')
  // A page over the size the runner reads is refused whole, never read cut short.
  plan('plan-e', { target: { reminder: '103', step: '201' }, change: { template: '305' } })
  out.oversize = await runner.run('plan-e')
  out.records = records.map(r => `${r.planId}:${r.state}`)

  // The gate itself on the real window: an armed write of step 201 / template 304.
  await page.loadURL('https://op.test/line/episode/show/101').catch(() => {})
  await wait(300)
  const gate = createRunGate({
    host: 'op.test', operation: connector('lstep', '0.5.0')!.operations.reminder_step_add_template,
    values: { target: { reminder: '101', step: '201' }, change: { template: '304' } },
    readPaths: ['/line/episode/show/101'], stopped: () => false,
  })
  out.gateReady = await win.run.enterAi(gate.hooks)
  const send = (pairs: Record<string, string>) => win.run.request({
    method: 'POST', path: '/line/episode/step/pack/template', contentType: FORM_CONTENT_TYPE,
    body: encodeForm(Object.entries({ content_id: '201', template_id: '304', _token: 'tok', _lm_user_id: 'u1', ...pairs })),
  }).then(r => r.status, () => 'refused')
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
