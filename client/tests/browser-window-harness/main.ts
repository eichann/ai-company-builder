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
import { app, BrowserWindow, nativeImage, session } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createBrowserWindowShell, type BrowserShellWindow } from '../../electron/browser-window'
import { browserPartition } from '../../electron/features/browser/controller'
import { createKeptLogins } from '../../electron/features/browser/kept-logins'
import { createBrowserRunner } from '../../electron/features/browser/runner'
import type { BrowserSiteSetting } from '../../../shared/core/browser-operation'
import { browserLoginHelpers, createBrowserCheckerRegistry, createBrowserConnectors } from '../../shared/browser-checkers'
import { lstepConnector } from '../../connectors/lstep'
import { LSTEP_DECLARATION } from '../../connectors/lstep/declaration'
import { browserReadPartition, browserWritePartition } from '../../shared/browser-operation'
import { browseLogStep, pageWithScreen, parseBrowseAnswer, type BrowserActResult, type BrowserBrowseAction } from '../../shared/browser-browse'
import { createRunGate, encodeForm, FORM_CONTENT_TYPE, type BrowserChecker, type BrowserRunSurface, type BrowserStepRecord } from '../../shared/browser-runner'
import { readBrowserFacts } from '../../shared/browser-facts'
import { parseBrowserHtml } from '../../electron/features/browser/html'
import { fakePlansServer, type FakeServerFaults } from '../browser-plans-fake'
import { startSites, type Sites } from './sites'
import { createBrowserRecorder } from '../../shared/browser-recorder'
import { BROWSE_TYPED_VALUE_SCRIPT, BROWSER_BROWSE_WORLD } from '../../shared/browser-browse-script'
import { browserRecordingProblem } from '../../../shared/core/browser-recording'
import { newRecordingDigest } from '../../electron/features/browser/recording'
import { createFrameWriter } from '../../electron/features/browser/frame-writes'
import { wireBrowserWork } from '../../electron/features/browser/work'
import { createBrowserContext } from '../../electron/features/browser/context'
import type { PreviewOperator } from '../../electron/features/browser/preview'
import type { BrowserLinesAnswer } from '../../electron/features/browser/lines-api'
import { BROWSER_OPERATOR_TOOLSETS, type BrowserOperatorToolset } from '../../shared/browser-operator-toolsets'

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
// The whole harness (the operator's window tools added ~20 s of scenarios on a quiet Mac, a write run ~10 s; a busy shared Mac took
// 140 s; on a loaded shared Mac on 2026-11-28 the operator's window tools alone took 189 s; the completion regression adds
// ~10 s): room for a busy runner.
setTimeout(() => fail(new Error('the harness timed out')), 300_000)

async function focusScenario(shell: ReturnType<typeof createBrowserWindowShell>, site: BrowserSiteSetting) {
  const appWindow = new BrowserWindow({ width: 300, height: 200, show: true })
  await appWindow.loadURL('data:text/html,<input autofocus>')
  app.focus({ steal: true })
  appWindow.focus()
  await wait(500)
  const shown = async (inactive: boolean) => {
    const partition = browserPartition(inactive ? 'focus-inactive' : 'focus-active', 'company-1', 'op.test')
    trustTestCertificate(partition)
    const win = shell.open({ partition, site, onClosed: () => {}, ...(inactive ? { inactive: true } : {}) })
    await loaded(win)
    await wait(800)
    const answer = { visible: win.webContents.isDestroyed() ? false : BrowserWindow.fromWebContents(win.webContents)?.isVisible() ?? false, appKeepsKeyboard: BrowserWindow.getFocusedWindow() === appWindow }
    win.close()
    appWindow.focus()
    await wait(300)
    return answer
  }
  const before = BrowserWindow.getFocusedWindow() === appWindow
  const inactive = await shown(true)
  const active = await shown(false)
  appWindow.destroy()
  return { appFocusedFirst: before, inactive, active }
}

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
  // A run that opened the window again waits for its first page (agent-browser.md "The window a run needs").
  const cut = new AbortController()
  cut.abort()
  result.whenLoadedCut = await win.whenLoaded!(cut.signal)
  result.whenLoaded = await win.whenLoaded!(new AbortController().signal)
  result.whenLoadedUrl = page.getURL()
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
  result.recording = await recordingScenarios(win, shell, site, js)
  result.browse = await browseScenarios(win, sites)
  result.work = await workScenarios(win, sites)
  result.workPress = await workPressScenario(win, sites)
  // The same regression in every tool set (agent-browser.md "The operator's tool sets"): the site starts afresh for each.
  const flows: Record<string, unknown> = {}
  for (const toolset of BROWSER_OPERATOR_TOOLSETS) {
    sites.flow.length = 0
    flows[toolset] = await workFlowScenario(win, sites, toolset)
  }
  result.workFlows = flows
  result.verify = await verifyScenarios(win)

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

  // A window a run opens again is shown without taking the keyboard from the app's window (agent-browser.md "The window a
  // run needs"); 「開いてログイン」's window takes it.
  // A shell that shows its windows (the main one here keeps them hidden).
  result.focus = await focusScenario(createBrowserWindowShell({ log: { warn() {} }, loginHelpers }), site)

  // A certificate the system does not trust is refused, never bypassed.
  const untrusted = browserPartition('user-1', 'company-1', 'untrusted.test')
  trustTestCertificate(untrusted)
  const other = shell.open({ partition: untrusted, site: { host: 'untrusted.test', level: 'read', assetHosts: [] }, onClosed: () => {} })
  await loaded(other)
  await wait(500)
  result.untrustedUrl = other.webContents.getURL()
  other.close()

  result.kept = await keptScenario(shell, site)

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
 * Recording (agent-browser.md "Recording"): the person's trusted clicks and typing on the operated page are observed
 * through the window's one debugger owner and kept in their kept form only; the page's own forged calls are not; the
 * AI cannot enter the window while it records (nor a recording start while the AI holds it), the preview reads
 * nothing meanwhile; a window closed while recording ends it as `closed`.
 */
async function recordingScenarios(win: BrowserShellWindow, shell: ReturnType<typeof createBrowserWindowShell>, site: BrowserSiteSetting, js: (code: string) => Promise<unknown>) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  BrowserWindow.fromWebContents(page)?.showInactive()
  await page.loadURL('https://op.test/rec-form')
  await wait(800)
  const recorder = createBrowserRecorder({ domain: 'op.test', digest: newRecordingDigest(), now: () => Date.now() })
  const ended: string[] = []
  out.started = await win.record.start({ observe: o => recorder.observe(o), ended: r => ended.push(r) })
  // A page already loaded navigating within itself (History API) before any new load is a page line too.
  await js(`history.pushState({}, '', '/rec-form/77'); 1`)
  await wait(300)
  // Reload so the page's load (its own script's read, its forged calls) is observed too.
  await page.loadURL('https://op.test/rec-form')
  await wait(1200)
  const hooks = { stopped: () => false, pageRead: () => true, sessionRequest: () => ({ allow: false as const, reason: 'test' }) }
  out.aiWhileRecording = await win.run.enterAi(hooks as never)
  out.previewWhileRecording = await win.preview.read('/rec-api/1').then(() => 'read', () => 'refused')
  const clickOn = async (id: string) => {
    const r = await js(`(() => { const b = document.getElementById('${id}').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`) as [number, number]
    page.sendInputEvent({ type: 'mouseDown', x: Math.round(r[0]), y: Math.round(r[1]), button: 'left', clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', x: Math.round(r[0]), y: Math.round(r[1]), button: 'left', clickCount: 1 })
    await wait(300)
  }
  // Each field is entered by a click and left by a click elsewhere (a Tab's target depends on the runner's focus).
  await clickOn('end')
  page.insertText('2026-12-03')
  await clickOn('pw')
  page.insertText('pw-secret-value-7777')
  await clickOn('end')
  await clickOn('save')
  await clickOn('pick')
  // A whole row the page made a button, and a field named by text elsewhere on the page: no label from either.
  await clickOn('row')
  await clickOn('memo2')
  page.insertText('memo-value-4321')
  await clickOn('end')
  await wait(1000)
  await win.record.stop()
  const content = recorder.content()
  out.content = content
  out.problem = browserRecordingProblem(content, 'op.test')
  out.ended = ended
  // Once stopped, the AI can take the window again.
  out.aiAfter = await win.run.enterAi(hooks as never)
  // …and while it holds it, no recording starts.
  out.recordWhileAi = await win.record.start({ observe: () => {}, ended: () => {} })
  await win.run.leaveAi()
  // A window closed while recording: the recording hears `closed`.
  const partition2 = browserPartition('user-2', 'company-1', 'op.test')
  trustTestCertificate(partition2)
  const other = shell.open({ partition: partition2, site, onClosed: () => {} })
  await loaded(other)
  await wait(500)
  const endedOther: string[] = []
  out.otherStarted = await other.record.start({ observe: () => {}, ended: r => endedOther.push(r) })
  other.close()
  await wait(500)
  out.endedOnClose = endedOther
  await page.loadURL('https://op.test/')
  await wait(800)
  return out
}

/**
 * The operator's window tools (agent-browser.md "The operator's window tools"): in the window's `ai` mode with a gate that
 * refuses every write, the operator's real presses and typing — a form's submit, a button that writes by fetch, one behind a
 * confirm dialog — send nothing; a link to another site goes nowhere; a page of the site opens; the snapshot never reads a
 * password field's value.
 */
async function browseScenarios(win: BrowserShellWindow, sites: Sites) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  await page.loadURL('https://op.test/browse')
  await wait(800)
  const writesBefore = sites.hits.filter(h => h.method !== 'GET' && h.method !== 'HEAD').length
  // File choosers the page opened (the gate's DevTools connection tells every listener).
  let choosers = 0
  const onMessage = (_e: unknown, method: string) => { if (method === 'Page.fileChooserOpened') choosers++ }
  out.entered = await win.browse.enter(() => false)
  page.debugger.on('message', onMessage)
  const signal = new AbortController().signal
  /** One action as the operator's loop runs it: its outcome word (the whole result kept in `last`). */
  let last: BrowserActResult | null = null
  const act = async (a: BrowserBrowseAction, s: AbortSignal) => { last = await win.browse.act(a, s); return last.outcome }
  const snapshot = async () => {
    const s = await win.browse.snapshot()
    return (name: string) => s?.elements.find(e => e.name === name)?.ref ?? -1
  }
  /** The page's own record of the presses that reached it (its script, sites.ts). */
  const pressed = async (): Promise<string[]> => JSON.parse(String(await page.executeJavaScript('JSON.stringify(window.__clicks || [])', true).catch(() => '[]')))
  /**
   * A press, done again (at most 3 times) until the page saw it: on a busy machine a real press may land before the page is
   * drawn. What is asserted is what the presses could never do (a write, another site), so a retry hides nothing.
   */
  const press = async (name: string, id: string): Promise<string> => {
    let result = 'failed'
    for (let i = 0; i < 3; i++) {
      const ref = await snapshot()
      result = await act({ do: 'click', ref: ref(name) }, signal)
      if ((await pressed()).includes(id)) return result
      await wait(300)
    }
    return `${result} (not seen by the page)`
  }
  const first = await snapshot()
  out.snapshot = await win.browse.snapshot()
  out.typed = await act({ do: 'type', ref: first('検索'), text: '山田花子' }, signal)
  out.typedResult = last
  out.typedValue = await page.executeJavaScript(`document.getElementById('q').value`, true)
  out.selected = await act({ do: 'select', ref: first('並び順'), option: '古い順' }, signal)
  out.selectedValue = await page.executeJavaScript(`document.getElementById('order').value`, true)
  // The form's submit: its POST is refused by the gate, and the page is left on its error page.
  out.submit = await act({ do: 'click', ref: first('保存して送信') }, signal)
  await act({ do: 'go', path: '/browse' }, signal)
  out.fetchClick = await press('すぐ保存', 'fetch')
  out.confirmClick = await press('消す', 'confirm')
  out.confirmResult = last
  out.evilClick = await press('外のサイト', 'evil')
  out.urlAfterEvil = page.getURL()
  // A link of the site: pressed again until the page went there (it is a press that may land before a frame is drawn).
  for (let i = 0; i < 3 && page.getURL() !== 'https://op.test/browse-next'; i++) {
    const ref = await snapshot()
    out.next = await act({ do: 'click', ref: ref('次のページ') }, signal)
    for (let j = 0; j < 30 && page.getURL() !== 'https://op.test/browse-next'; j++) await wait(100)
  }
  out.urlAfterNext = page.getURL()
  out.back = await act({ do: 'back' }, signal)
  out.urlAfterBack = page.getURL()
  // An address that would name another host (the parser refuses it first; the window checks again).
  out.goOther = await act({ do: 'go', path: '@evil.test/x' }, signal)
  out.go = await act({ do: 'go', path: '/browse-next' }, signal)
  out.urlAfterGo = page.getURL()
  // A navigation to a page that never answers ends when the run is stopped (and the load is stopped).
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 500)
  const hangAt = Date.now()
  out.hang = await act({ do: 'go', path: '/browse-hang' }, stop.signal)
  out.hangMs = Date.now() - hangAt
  // A press that starts a write for later (a timer): once the operator leaves, the page was loaded afresh, so it never fires.
  await act({ do: 'go', path: '/browse' }, signal)
  // A file chooser never opens a dialog of this computer (intercepted; its event comes a moment after the press).
  for (let i = 0; i < 3 && choosers === 0; i++) {
    out.pick = await press('ファイルを選ぶ', 'pick')
    for (let j = 0; j < 10 && choosers === 0; j++) await wait(100)
  }
  out.choosers = choosers
  out.later = await press('あとで保存', 'later')
  // A page that asks to stay (beforeunload) while a debounced save waits: it is let go all the same (review M).
  out.draft = await press('下書き', 'draft')
  page.debugger.removeListener('message', onMessage)
  await win.browse.leave()
  out.openAfterLeave = !page.isDestroyed()
  out.urlAfterLeave = page.isDestroyed() ? '' : page.getURL()
  // The writes the presses scheduled (4 s, 4.5 s) would have gone by now.
  await wait(5500)
  out.writes = sites.hits.filter(h => h.method !== 'GET' && h.method !== 'HEAD').slice(writesBefore).map(h => `${h.method} ${h.host}${h.path}`)
  out.evilHits = sites.hits.filter(h => h.host === 'evil.test' && h.path.startsWith('/browse')).length
  // A folder tree driven by script alone (no link or button): its items are listed once each as `item`, a press on one
  // reaches the page's handler, and a card whose handler saves by fetch writes nothing (the gate holds every write).
  // Its own run of the operator (entered again), so nothing of it touches the presses above.
  out.treeEntered = await win.browse.enter(() => false)
  const treeWritesBefore = sites.hits.filter(h => h.method !== 'GET' && h.method !== 'HEAD').length
  await act({ do: 'go', path: '/browse-tree' }, signal)
  const domSize = () => page.executeJavaScript(`document.documentElement.outerHTML.length`, true)
  const before = await domSize()
  const tree = await win.browse.snapshot()
  out.treeItems = tree?.elements.filter(e => e.role === 'item').map(e => e.name)
  out.treeLogLabels = tree?.elements.filter(e => e.role === 'item').map(e => e.logLabel)
  out.treeNames = tree?.elements.map(e => e.name)
  out.treeViewport = tree?.viewport
  // The operator's screen: a JPEG at most 1280 wide, the folder's mark drawn on its box (the mark's colour at its edge).
  if (tree) {
    const shot = await win.browse.screenshot?.(tree)
    const image = shot ? nativeImage.createFromBuffer(Buffer.from(shot.data)) : null
    out.shotType = shot?.mediaType
    out.shotJpeg = shot ? Buffer.from(shot.data).subarray(0, 3).toString('hex') : ''
    out.shotSize = image?.getSize()
    const folder = tree.elements.find(e => e.name === '▸キャンペーン')
    if (image && folder?.box && tree.viewport) {
      const { width } = image.getSize()
      const bitmap = image.toBitmap()
      const scale = width / tree.viewport[0]
      const at = (x: number, y: number) => { const o = (Math.round(y) * width + Math.round(x)) * 4; return { r: bitmap[o + 2], g: bitmap[o + 1], b: bitmap[o] } }
      out.markEdge = at(folder.box[0] * scale + 1, (folder.box[1] + folder.box[3] / 2) * scale)
      out.pageInside = at((folder.box[0] + folder.box[2] - 4) * scale, (folder.box[1] + folder.box[3] / 2) * scale)
    }
  }
  // The marks are drawn on the captured pixels: the page's document is as it was before the snapshot and the screen.
  out.treeDomBefore = before
  out.treeDomAfterShot = await domSize()
  out.folderClick = await press('▸キャンペーン', 'f1')
  out.treeShown = (await win.browse.snapshot())?.text
  out.cardClick = await press('すぐ反映（下書き）', 'card')
  await win.browse.leave()
  await wait(500)
  out.treeWrites = sites.hits.filter(h => h.method !== 'GET' && h.method !== 'HEAD').slice(treeWritesBefore).map(h => `${h.method} ${h.host}${h.path}`)
  // A long list whose row menu is appended last (production 2026-11-27): the elements are ordered before the cap — the
  // open menu first, then what is on the screen —, so the menu's choices get refs and a press on one reaches the page.
  // Its own failure is its own (never the whole harness's): the assertions name what is missing.
  try {
    out.menuEntered = await win.browse.enter(() => false)
    await act({ do: 'go', path: '/browse-menu' }, signal)
    const list = await win.browse.snapshot()
    out.menuList = list && {
      count: list.elements.length, omitted: list.omitted ?? 0,
      // Every element on the screen is listed, before any off the screen; the last rows (off the screen) are the ones left out.
      boxes: list.elements.map(e => !!e.box),
      names: list.elements.map(e => e.name),
    }
    out.moreClick = await press('その他1', 'more1')
    const menu = await win.browse.snapshot()
    out.menuOpen = menu && {
      first: menu.elements.slice(0, 2).map(e => ({ ref: e.ref, role: e.role, name: e.name, box: !!e.box })),
      count: menu.elements.length,
      // The second row's 「…」 lies under the menu: listed, but no mark where the menu covers it.
      coveredBox: menu.elements.find(e => e.name === 'その他2')?.box ?? null,
      coveredListed: menu.elements.some(e => e.name === 'その他2'),
    }
    out.copyClick = await press('コピーを作成', 'copy')
    // Pressing by position (the screen image's pixels): what has no ref is pressed where the image shows it; the window's
    // hit-test refuses a file field or its label, a point off the screen and a page that moved since its snapshot.
    const cssBox = async (id: string) => JSON.parse(String(await page.executeJavaScript(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`, true))) as { x: number; y: number; width: number; height: number }
    const shown = async () => {
      const snap = await win.browse.snapshot()
      const shot = snap ? await win.browse.screenshot?.(snap) : null
      return snap ? pageWithScreen(snap, shot ?? null) : null
    }
    /** The operator's answer to press the middle of an element, in the screen image's pixels, as the loop runs it. */
    const pressAt = async (id: string, dx = 0) => {
      const at = await shown()
      const b = await cssBox(id)
      if (!at?.screen || !at.viewport) return { problem: 'no screen' }
      const sx = at.screen[0] / at.viewport[0]
      const sy = at.screen[1] / at.viewport[1]
      const parsed = parseBrowseAnswer(JSON.stringify({ do: 'click', x: Math.floor((b.x + b.width / 2 + dx) * sx), y: Math.floor((b.y + b.height / 2) * sy) }), { snapshot: at, items: 0 })
      if ('problem' in parsed) return { problem: parsed.problem }
      const aimed = await win.browse.aim!(parsed.answer)
      const log = aimed.ok ? browseLogStep(parsed.answer, at, 'op.test', aimed) : null
      const acted = aimed.ok ? await act(parsed.answer, signal) : null
      return { aimed, label: log?.label ?? null, acted, listed: at.elements.some(e => e.name === '共有する') }
    }
    out.byPosition = await pressAt('share')
    out.byPositionSeen = (await pressed()).includes('share')
    out.fileLabel = await pressAt('uplabel')
    out.fileField = await pressAt('up')
    out.fileSeen = (await pressed()).includes('up')
    // Off the screen: the parser refuses a point outside the image, the hit-test one outside the viewport.
    const offAt = await shown()
    out.offParsed = offAt?.screen ? parseBrowseAnswer(JSON.stringify({ do: 'click', x: offAt.screen[0], y: 5 }), { snapshot: offAt, items: 0 }) : null
    out.offAim = offAt?.viewport ? await win.browse.aim!({ do: 'click', x: offAt.viewport[0] + 5, y: 5 }) : null
    // The page moved between the snapshot (and its screen) and the press: refused as moved, nothing pressed.
    const beforeShift = await shown()
    const memo = await cssBox('memo')
    await page.executeJavaScript(`document.getElementById('fields').insertAdjacentHTML('beforebegin', '<div style="height: 50px">お知らせ</div>')`, true)
    out.movedAim = beforeShift ? await win.browse.aim!({ do: 'click', x: memo.x + 5, y: memo.y + 5 }) : null
    // An element that became a floating layer since the snapshot (its z-index raised, its box the same): refused as moved.
    const beforeLayer = await shown()
    await page.executeJavaScript(`document.getElementById('note').style.zIndex = '40'`, true)
    const note = await cssBox('note')
    out.layerAim = beforeLayer ? await win.browse.aim!({ do: 'click', x: note.x + 5, y: note.y + 5 }) : null
    // Typing into the field that has the focus (pressed by position first); a password field is never typed into.
    out.memoPress = await pressAt('memo')
    const typeAnswer = parseBrowseAnswer(JSON.stringify({ do: 'type', text: 'こんにちは' }), { snapshot: await shown(), items: 0 })
    out.typeAim = 'answer' in typeAnswer ? await win.browse.aim!(typeAnswer.answer) : typeAnswer
    out.typed = 'answer' in typeAnswer ? await act(typeAnswer.answer, signal) : null
    out.memoValue = await page.executeJavaScript(`document.getElementById('memo').value`, true)
    out.pwPress = await pressAt('pw')
    out.pwAim = 'answer' in typeAnswer ? await win.browse.aim!(typeAnswer.answer) : null
    out.pwTyped = 'answer' in typeAnswer ? await act(typeAnswer.answer, signal) : null
    out.pwValue = await page.executeJavaScript(`document.getElementById('pw').value`, true)
  } catch (e) {
    out.menuError = String(e)
  } finally {
    await win.browse.leave()
  }
  await page.loadURL('https://op.test/')
  await wait(500)
  return out
}

/**
 * What a press did (agent-browser.md "What a press did"; sites.ts `/verify`): a ref whose row was re-used after the
 * snapshot, a ref under a banner, a listed button whose words changed in place and an unlisted line whose words changed
 * (pressed by position) are refused and never pressed; a listed button still pressed by position when something else on
 * the page moved; a confirm and an alert told with their text (the confirm cancelled); what each field holds after typing.
 */
async function verifyScenarios(win: BrowserShellWindow) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  const js = (code: string) => page.executeJavaScript(code, true)
  const signal = new AbortController().signal
  const clicks = async (): Promise<string[]> => JSON.parse(String(await js('JSON.stringify(window.__clicks || [])').catch(() => '[]')))
  const clear = () => js('window.__clicks = []; 1')
  const refOf = async (name: string, nth = 0) => (await win.browse.snapshot())?.elements.filter(e => e.name === name)[nth]?.ref ?? -1
  /** A press by ref, done again (at most 3 times) until the page saw it (a press may land before the page is drawn). */
  const press = async (name: string, id: string, nth = 0): Promise<BrowserActResult | null> => {
    let r: BrowserActResult | null = null
    for (let i = 0; i < 3; i++) {
      r = await win.browse.act({ do: 'click', ref: await refOf(name, nth) }, signal)
      if ((await clicks()).includes(id)) return r
      await wait(300)
    }
    return r
  }
  /** The operator's answer to press the middle of an element by position, parsed as the loop does, on the page shown now. */
  const pointAt = async (id: string) => {
    await js(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'center' }); 1`)
    const snap = await win.browse.snapshot()
    const shot = snap ? await win.browse.screenshot?.(snap) : null
    const at = snap ? pageWithScreen(snap, shot ?? null) : null
    const b = JSON.parse(String(await js(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`))) as { x: number; y: number; width: number; height: number }
    if (!at?.screen || !at.viewport) return null
    const parsed = parseBrowseAnswer(JSON.stringify({ do: 'click', x: Math.floor((b.x + b.width / 2) * at.screen[0] / at.viewport[0]), y: Math.floor((b.y + b.height / 2) * at.screen[1] / at.viewport[1]) }), { snapshot: at, items: 0 })
    return 'answer' in parsed ? parsed.answer : null
  }
  try {
    out.entered = await win.browse.enter(() => false)
    await win.browse.act({ do: 'go', path: '/verify' }, signal)
    await wait(300)
    // 1. The rows re-sort between the snapshot and the press: 山田's 保存 is now 佐藤's row — never pressed.
    const yamada = await refOf('保存', 0)
    await js('resort(); 1')
    out.recycle = await win.browse.act({ do: 'click', ref: yamada }, signal)
    out.recycleClicks = await clicks()
    // Read again: the first row's 保存 is 佐藤's (33), and the press says what it reached.
    out.recycleAgain = await press('保存', 'item-33')
    out.recycleAgainClicks = await clicks()
    await clear()
    // 1b. Rows alike in their first 200 characters: the whole row's words are compared — refused after the re-sort.
    const longFirst = await refOf('登録', 0)
    await js('resortLong(); 1')
    out.long = await win.browse.act({ do: 'click', ref: longFirst }, signal)
    // Two 開く with no words around them: they cannot be told apart — refused, never pressed.
    out.twin = await win.browse.act({ do: 'click', ref: await refOf('開く', 0) }, signal)
    out.longClicks = await clicks()
    await clear()
    // 1c. The row re-sorts on mousedown (after the check, before the click): the result says the row changed.
    out.down = await press('更新', 'down-丁')
    out.downClicks = await clicks()
    await clear()
    // 1d. The page stops the click in its own capturing listener and saves: the click is unknown, and the page wrote.
    out.stopper = await press('送る', 'stopper')
    await clear()
    // 2. A banner over the button after the snapshot: refused as covered; neither the button nor the banner is pressed.
    // Centred first (where a press scrolls it), so the banner lies over it where it will be pressed, whatever the window's size.
    await js("document.getElementById('save').scrollIntoView({ block: 'center', inline: 'center' }); 1")
    const save = await refOf('保存する')
    await js('cover(); 1')
    out.covered = await win.browse.act({ do: 'click', ref: save }, signal)
    out.coveredClicks = await clicks()
    await js('uncover(); 1')
    out.saveAgain = await press('保存する', 'save')
    await clear()
    // 3. By position: something else on the page moved (a block grew below), the listed button at the point is the same —
    // pressed; its words then turn 保存 → 削除 in place after the snapshot — refused, never pressed.
    const swapPoint = await pointAt('swap')
    await js('growElsewhere(); 1')
    out.stillAim = swapPoint ? await win.browse.aim!(swapPoint) : 'no point'
    out.still = swapPoint ? await win.browse.act(swapPoint, signal) : 'no point'
    out.stillClicks = await clicks()
    await clear()
    const swapAgain = await pointAt('swap')
    await js('swap(); 1')
    out.swapAim = swapAgain ? await win.browse.aim!(swapAgain) : 'no point'
    out.swap = swapAgain ? await win.browse.act(swapAgain, signal) : 'no point'
    // A column moves another listed button under the point (二番目's place now shows 一番目): refused, never pressed.
    await js("document.getElementById('x2').scrollIntoView({ block: 'center' }); 1")
    const x2Point = await pointAt('x2')
    await js('shiftCol(); 1')
    out.colAim = x2Point ? await win.browse.aim!(x2Point) : 'no point'
    out.col = x2Point ? await win.browse.act(x2Point, signal) : 'no point'
    out.colClicks = await clicks()
    await clear()
    // An unlisted line (no ref) whose words change after the snapshot: refused too.
    const plain = await pointAt('plain')
    out.plainListed = ((await win.browse.snapshot())?.elements ?? []).some(e => e.name === '確定')
    await js('retext(); 1')
    out.plain = plain ? await win.browse.act(plain, signal) : 'no point'
    out.swapClicks = await clicks()
    await clear()
    // 4. A confirm (the app cancels it: the save does not happen) and an alert, told with their text.
    out.confirm = await press('確認して保存', 'not-confirmed')
    out.alert = await press('知らせる', 'alerted')
    out.dialogClicks = await clicks()
    // 5. Typing: what each field holds afterwards.
    const typeInto = async (name: string, text: string) => win.browse.act({ do: 'type', ref: await refOf(name), text }, signal)
    out.code = await typeInto('コード', 'ABCDEFGHIJ')
    out.tel = await typeInto('電話', '03-1234-5678')
    out.day = await typeInto('開始日', '2026-12-03')
    out.amount = await typeInto('金額', '12,000')
    out.memoListed = ((await win.browse.snapshot())?.elements ?? []).find(e => e.name === 'メモ')?.role ?? null
    out.memo = await typeInto('メモ', 'メモの本文')
    out.memoShown = ((await win.browse.snapshot())?.elements ?? []).find(e => e.name === 'メモ')?.value ?? null
    // A password field's value is never read back, even when the field typed into is one (a second layer: typing into a
    // password field is refused before). A text field's is, the same way.
    const pwRef = await refOf('合言葉')
    await js(`document.getElementById('pw').value = 'pw-secret-4242'; 1`)
    const readBack = async (ref: number) => {
      await page.executeJavaScriptInIsolatedWorld(BROWSER_BROWSE_WORLD, [{ code: `window.__acbAim.typing(${ref})` }])
      return page.executeJavaScriptInIsolatedWorld(BROWSER_BROWSE_WORLD, [{ code: BROWSE_TYPED_VALUE_SCRIPT }])
    }
    out.pwReadBack = await readBack(pwRef)
    out.codeReadBack = await readBack(await refOf('コード'))
  } catch (e) {
    out.error = String(e)
  } finally {
    await win.browse.leave()
  }
  await page.loadURL('https://op.test/')
  await wait(500)
  return out
}

/**
 * A write run (agent-browser.md "Writes within frames, in the app"): the window holds every write its page makes and the
 * real frame writer decides it against a fake of the server's frames routes — a save within the plan is sent once with the
 * page's own cookie and CSRF header and its answer reaches the page without Set-Cookie; two saves at once go one after the
 * other; an autosave outside the plan, an upload with a file and a fourth save past the frame's max are never sent; a
 * save whose permit comes after the run stopped is not sent; a write whose answer is lost reaches the site once and the
 * run sends nothing more; a never-read address is refused.
 */
async function workScenarios(win: BrowserShellWindow, sites: Sites) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  const js = (code: string) => page.executeJavaScript(code, true)
  let going = true
  let permitDelay = 0
  let nextWrite = 0
  const calls: Array<{ kind: string; body: unknown; at: number }> = []
  const api = {
    async framePermit(_c: string, _r: string, body: unknown): Promise<BrowserLinesAnswer> {
      calls.push({ kind: 'permit', body, at: Date.now() })
      if (permitDelay) await wait(permitDelay)
      const frame = (body as { frame: number }).frame
      return { kind: 'ok', value: { write: ++nextWrite, frame, permittedAt: new Date().toISOString(), validMs: 5000 } }
    },
    async frameReport(_c: string, _r: string, body: unknown): Promise<BrowserLinesAnswer> {
      calls.push({ kind: 'report', body, at: Date.now() })
      return { kind: 'ok', value: { outcome: 'applied' } }
    },
  }
  const writer = createFrameWriter({
    companyId: 'company-1', runId: `bf_${'a'.repeat(32)}`, host: 'op.test', api, going: () => going, stepsSoFar: () => 0,
    frames: [
      { frame: 1, method: 'POST', path: '/work/save', query: null, fields: {}, max: 4, left: 4 },
      { frame: 2, method: 'POST', path: '/work/lost', query: null, fields: {}, max: 2, left: 2 },
    ],
  })
  await page.loadURL('https://op.test/work')
  await js(`document.cookie = 'sid=1; Secure; Path=/'; 1`)
  // The writer the window's holds go to (a second one for the last scenario).
  let current = writer
  out.entered = await win.browse.enter(() => false, {
    holdWrite: held => current.hold(held), neverRead: p => p.startsWith('/work/never'),
    // As the work wires it (work.ts): unknown only when a page's original may have gone out (not parked yet).
    detached: mayHaveGone => { if (mayHaveGone) current.abandon('detached'); else current.close() },
  })
  out.save = await js(`save('a')`)
  out.both = await js(`Promise.all([save('b'), save('c')])`)
  out.auto = await js(`auto()`)
  out.upload = await js(`upload()`)
  out.never = await js(`fetch('/work/never?x=1').then(r => r.status, () => 'refused')`)
  // The run stops while the permit is on its way: the write is never sent (the unit is used all the same).
  permitDelay = 700
  setTimeout(() => { going = false }, 200)
  out.stopped = await js(`save('e')`)
  permitDelay = 0
  going = true
  // The frame's max (4) is reached: one more save is refused without asking.
  const permitsBefore = calls.filter(c => c.kind === 'permit').length
  out.pastMax = await js(`save('d')`)
  out.permitsForPastMax = calls.filter(c => c.kind === 'permit').length - permitsBefore
  // The answer lost: sent once, then nothing more in the run.
  out.lost = await js(`lost()`)
  out.lockedAfterLost = writer.locked()
  await wait(1500)
  out.afterLost = await js(`save('f')`)
  const ses = page.session
  out.windowCookies = (await ses.cookies.get({ url: 'https://op.test/' })).map(c => c.name)
  // The window's DevTools connection goes while a save is held (its permit on the way): the page's original was parked, so
  // nothing reaches the site — neither the run's copy nor the original — and the write is not sent
  // (tests/browser-write-detach-electron.test.ts cuts it at every moment and in every way).
  const second = createFrameWriter({
    companyId: 'company-1', runId: `bf_${'c'.repeat(32)}`, host: 'op.test', going: () => true, stepsSoFar: () => 0,
    frames: [{ frame: 1, method: 'POST', path: '/work/save', query: null, fields: {}, max: 2, left: 2 }],
    api: {
      async framePermit(_c, _r, body) { calls.push({ kind: 'permit2', body, at: Date.now() }); await wait(800); return { kind: 'ok', value: { write: 1, frame: 1, permittedAt: new Date().toISOString(), validMs: 5000 } } },
      async frameReport(_c, _r, body) { calls.push({ kind: 'report2', body, at: Date.now() }); return { kind: 'ok', value: {} } },
    },
  })
  current = second
  const detachedSave = js(`save('g')`)
  await wait(300)
  page.debugger.detach()
  out.detachedSave = await Promise.race([detachedSave, wait(5000).then(() => 'no answer')])
  await wait(1500)
  out.detachedRecords = second.records().map(r => r.outcome)
  await win.browse.leave()
  // Kept so the later login tests count from the same start, whatever set it.
  await ses.cookies.remove('https://op.test/', 'rotated')
  out.calls = calls.map(c => ({ kind: c.kind, body: c.body }))
  out.reportsBeforePermits = (() => {
    // Every permit after the first comes after the previous write's report (one write at a time).
    const permits = calls.filter(c => c.kind === 'permit')
    const reports = calls.filter(c => c.kind === 'report')
    return permits.slice(1).every((p, i) => reports[i] !== undefined && reports[i].at <= p.at)
  })()
  out.records = writer.records().map(r => ({ line: r.line, outcome: r.outcome }))
  out.log = writer.log()
  out.work = sites.work.map(w => ({ ...w }))
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(300)
  return out
}

/**
 * The write task wired (work.ts) on the real window: the operator presses a save whose page sends its write two seconds
 * later (after main's moment) to a site that answers after 2.5 s, then presses again at once — before that write is even
 * held. The app waits for the first press's write before a second press and does not do it (its own rule, not the
 * operator's words), so the site gets one save — the frame allows two.
 */
async function workPressScenario(win: BrowserShellWindow, sites: Sites) {
  const out: Record<string, unknown> = {}
  const page = win.webContents
  await page.loadURL('https://op.test/work-slow')
  await wait(500)
  const hitsBefore = sites.work.filter(w => w.path === '/work/slow').length
  const RUN = `bf_${'d'.repeat(32)}`
  const ok = (value: unknown): BrowserLinesAnswer => ({ kind: 'ok', value })
  let permits = 0
  const api = {
    async runStart() { return ok({ runId: `bo_${'d'.repeat(32)}`, leaseMs: 120_000 }) },
    async runContinue() { return ok({}) },
    async runFinish() { return ok({}) },
    async frameStart() {
      return ok({
        runId: RUN, state: 'open', endReason: null, host: 'op.test', source: 'skill', skill: 'slow', planHash: `sha256:${'e'.repeat(64)}`,
        needsApproval: false, approval: 'pre_approved', createdAt: '', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: null,
        frames: [{ frame: 1, method: 'POST', path: '/work/slow', fields: {}, max: 2, used: 0, left: 2 }], writes: [],
        approvalToken: null, afterRead: [], neverRead: [],
      })
    },
    async framePermit(_c: string, _r: string, body: { frame: number }) { permits++; return ok({ write: permits, frame: body.frame, permittedAt: new Date().toISOString(), validMs: 5000 }) },
    async frameReport() { return ok({}) },
    async frameEnd() { return ok({}) },
    async frameGet() { return { kind: 'no-answer' } as BrowserLinesAnswer },
  }
  const histories: unknown[] = []
  let step = 0
  const operator: PreviewOperator = {
    model: 'm',
    async resolve() { return { ok: true, cli: { path: '/bin/true', pathDirs: [] } } },
    async step(job) {
      const m = job.material as { page: { elements: Array<{ ref: number; name: { outside: string } }> }; history: unknown[] }
      histories.push(m.history)
      const save = m.page.elements.find(e => e.name.outside === '遅い保存')?.ref ?? -1
      step++
      if (step === 1) return { ok: true, text: JSON.stringify({ do: 'click', ref: save }) }
      // At once: the first save's write is not held yet (the page sends it two seconds after the press). The app waits for
      // it before this press (up to `pressGapMs` after the first) and does not do the press: no timing of the operator's.
      if (step === 2) return { ok: true, text: JSON.stringify({ do: 'click', ref: save }) }
      return { ok: true, text: JSON.stringify({ do: 'done', result: '済み', unread: [] }) }
    },
  }
  const works = wireBrowserWork({
    aiSwitch: () => true, userId: () => 'u-1', context: createBrowserContext({ userId: () => 'u-1', aiSwitch: () => true }),
    stopped: () => false, window: () => win.browse, reader: () => ({ async read() { return { status: 404, body: '' } }, closed: () => false }),
    registered: () => true, api: api as never, operator: () => operator, cliPath: () => '/bin/true', parentEnv: () => ({}),
    writeStartMs: 300,
  })
  out.words = (await works.work({
    companyId: 'company-1', conversationId: null, companyRoot: null, site: 'op.test', task: '保存する', skill: 'slow', items: [],
    signal: new AbortController().signal, onCard: () => {},
  })).words
  // Anything the page might still send later would have gone by now.
  await wait(3000)
  out.hits = sites.work.filter(w => w.path === '/work/slow').length - hitsBefore
  out.permits = permits
  out.histories = histories
  await page.loadURL('https://op.test/').catch(() => {})
  await wait(300)
  return out
}

/**
 * The completion regression (agent-browser.md "The operator works from the approved steps"): a company Skill's write task
 * on a generic copy-and-register flow (sites.ts `/flow`) through the real window, the real wiring (work.ts, frame-writes,
 * the window's held writes) and a scripted operator — no model. The preview answers a plan, the card is approved, the work
 * opens a row's menu, copies, chooses the setting again in the dialog and decides (the page writes the copy), types the
 * person's name and date on the copy's page and registers (the page writes again), then is done. Exactly the two writes,
 * each within its frame and once, must reach the site: any later guard that stops this flow fails it. Since the run's
 * promise (agent-browser.md "The run's promise", "Sent is not done") the Skill binds the registration's name and date to
 * the person's values and lists the copy's body: the promise is made, nothing is asked, the copy's id counts as made by
 * the run, and reading the copy back matches what was promised — "済みました". Run once per tool set (agent-browser.md "The
 * operator's tool sets"): the operator answers in that set's words; its steps and stops are counted for comparison.
 */
async function workFlowScenario(win: BrowserShellWindow, sites: Sites, toolset: BrowserOperatorToolset) {
  const out: Record<string, unknown> = { toolset }
  const toolsets: Array<string | null> = []
  let stops = 0
  // A computer-use set types into the field pressed just before: its typing is a press of the field, then the text.
  let typeNext: string | null = null
  // Today's action in the set's words.
  const inSet = (o: Record<string, unknown>): Record<string, unknown> => {
    switch (toolset) {
      case 'current': return o
      case 'compact':
        if (o.do === 'type') return { do: 'set', ref: o.ref, value: o.text }
        if (o.do === 'select') return { do: 'set', ref: o.ref, value: o.option }
        return o
      case 'playwright':
        if (o.do === 'click') return { do: 'browser_click', target: o.ref, element: '部品' }
        if (o.do === 'type') return { do: 'browser_type', target: o.ref, element: '入力欄', text: o.text }
        if (o.do === 'select') return { do: 'browser_select_option', target: o.ref, element: '設定', values: [o.option] }
        if (o.do === 'wait') return { do: 'browser_wait_for', time: o.seconds }
        return o
      case 'openai':
      case 'anthropic':
        if (o.do === 'type') { typeNext = o.text as string; return { do: 'click', ref: o.ref } }
        if (o.do === 'wait') return toolset === 'openai' ? { type: 'wait' } : { action: 'wait', duration: o.seconds }
        return o
    }
  }
  await win.webContents.loadURL('https://op.test/flow')
  await wait(300)
  const RUN = `bf_${'f'.repeat(32)}`
  const PLAN = `sha256:${'f'.repeat(64)}`
  const STEPS = '# SKILL.md\n1. 一覧の行のメニューから「コピー」\n2. 設定を「B設定」に選び直して「決定」\n3. 名前と日付を入れて「登録」'
  const ok = (value: unknown): BrowserLinesAnswer => ({ kind: 'ok', value })
  const calls: string[] = []
  const promises: unknown[] = []
  const checks: unknown[] = []
  let permits = 0
  const api = {
    async runStart() { calls.push('runStart'); return ok({ runId: `bo_${'f'.repeat(32)}`, leaseMs: 120_000 }) },
    async runContinue() { return ok({}) },
    async runFinish() { return ok({}) },
    async frameStart() {
      return ok({
        runId: RUN, state: 'waiting', endReason: null, host: 'op.test', source: 'skill', skill: '.claude/skills/flow', planHash: PLAN,
        needsApproval: true, approval: null, createdAt: '', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), endedAt: null,
        frames: [
          { frame: 1, method: 'POST', path: '/flow/copy', fields: {}, max: 1, used: 0, left: 1, body: ['source', 'setting'] },
          { frame: 2, method: 'POST', path: '/flow/items/{n}', fields: {}, max: 1, used: 0, left: 1, body: ['name', 'date'], bind: { name: '名前', date: '日付' } },
        ],
        // The copy read back by what it made, the registration by its own address: every write the site took is read again.
        writes: [], approvalToken: 'a'.repeat(64), afterRead: ['/flow/items/{created}', '/flow/items/{n}'], neverRead: [],
        steps: { state: 'sealed', hash: `sha256:${crypto.createHash('sha256').update(STEPS, 'utf8').digest('hex')}` },
      })
    },
    async frameApprove() { calls.push('approve'); return ok({}) },
    async framePromise(_c: string, _r: string, body: unknown) { calls.push('promise'); promises.push(body); return ok({ made: true }) },
    async framePromiseAdd() { calls.push('promise-add'); return ok({ added: 1 }) },
    async framePermit(_c: string, _r: string, body: { frame: number; request: { path: string }; check?: unknown }) { calls.push(`permit ${body.frame} ${body.request.path}`); checks.push(body.check ?? null); permits++; return ok({ write: permits, frame: body.frame, permittedAt: new Date().toISOString(), validMs: 5000 }) },
    async frameReport(_c: string, _r: string, body: { result: string }) { calls.push(`report ${body.result}`); return ok({}) },
    async frameEnd() { return ok({}) },
    async frameGet() { return { kind: 'no-answer' } as BrowserLinesAnswer },
  }
  type Material = {
    phase: string
    person: { said: string[]; values: Array<{ label: string; value: string }> }
    steps: string | null
    plan?: unknown
    request: string | null
    page: { text: { outside: string }; elements: Array<{ ref: number; role: string; name: { outside: string } }> }
  }
  const materials: Material[] = []
  const done = { menu: false, copy: false, selected: false, decided: false, name: false, date: false, registered: false }
  const operator: PreviewOperator = {
    model: 'm',
    async resolve() { return { ok: true, cli: { path: '/bin/true', pathDirs: [] } } },
    async step(job) {
      const m = job.material as Material
      materials.push(m)
      toolsets.push(job.toolset ?? null)
      const answer = (o: Record<string, unknown>) => {
        if (o.do === 'stop') stops++
        return { ok: true as const, text: JSON.stringify(inSet(o)) }
      }
      if (job.prompt === 'work-preview') {
        return answer({ do: 'plan', summary: '秋の回をコピーして登録します', affects: 'なし', values: [{ label: 'コピー元', value: '秋の回' }], unread: [] })
      }
      // The text after its field was pressed (a computer-use set's own `type`, into the field pressed just before).
      if (typeNext !== null) {
        const text = typeNext
        typeNext = null
        return { ok: true as const, text: JSON.stringify(toolset === 'openai' ? { type: 'type', text } : { action: 'type', text }) }
      }
      const el = (name: string) => m.page.elements.find(e => e.name.outside === name)
      const value = (label: string) => m.person.values.find(v => v.label === label)?.value ?? ''
      if (done.registered && m.page.text.outside.includes('登録しました')) return answer({ do: 'done', result: '登録しました', unread: [] })
      const register = el('登録')
      if (register) {
        if (!done.name) { done.name = true; return answer({ do: 'type', ref: el('名前')?.ref, text: value('名前') }) }
        if (!done.date) { done.date = true; return answer({ do: 'type', ref: el('日付')?.ref, text: value('日付') }) }
        if (!done.registered) { done.registered = true; return answer({ do: 'click', ref: register.ref }) }
        return answer({ do: 'wait', seconds: 1 })
      }
      if (done.decided) return answer({ do: 'wait', seconds: 1 })
      const decide = el('決定')
      if (decide) {
        if (!done.selected) { done.selected = true; return answer({ do: 'select', ref: el('設定')?.ref, option: 'B設定' }) }
        done.decided = true
        return answer({ do: 'click', ref: decide.ref })
      }
      const copy = el('コピー')
      if (copy && !done.copy) { done.copy = true; return answer({ do: 'click', ref: copy.ref }) }
      const menu = el('メニュー')
      if (menu && !done.menu) { done.menu = true; return answer({ do: 'click', ref: menu.ref }) }
      return answer({ do: 'stop', why: 'blocked', unread: [] })
    },
  }
  const works = wireBrowserWork({
    aiSwitch: () => true, userId: () => 'u-1', context: createBrowserContext({ userId: () => 'u-1', aiSwitch: () => true }),
    // The page-less read session, as the site answers a GET of the copy: what the copy and the registration wrote, as JSON.
    stopped: () => false, window: () => win.browse,
    reader: () => ({
      async read(address: string) {
        if (!/^\/flow\/items\/99$/.test(address)) return { status: 404, body: '' }
        const parts = sites.flow.filter(f => f.path === '/flow/copy' || f.path === address).map(f => JSON.parse(f.body) as Record<string, unknown>)
        return parts.length > 0 ? { status: 200, body: JSON.stringify(Object.assign({}, ...parts)) } : { status: 404, body: '' }
      },
      closed: () => false,
    }),
    registered: () => true, api: api as never, operator: () => operator, cliPath: () => '/bin/true', parentEnv: () => ({}),
    skillSteps: async () => ({ kind: 'text', text: STEPS }),
    writeStartMs: 200, pressGapMs: 300,
    toolset: () => toolset,
  })
  const started = Date.now()
  const working = works.work({
    companyId: 'company-1', conversationId: null, companyRoot: '/company', site: 'op.test', task: '秋の回をコピーして冬の回を登録して', skill: 'flow', items: [],
    said: ['元の行は変えない'], values: [{ label: '名前', value: '【冬の回】' }, { label: '日付', value: '2026-12-03' }],
    signal: new AbortController().signal, onCard: () => {},
  })
  for (let i = 0; i < 600; i++) {
    const card = works.card('company-1', RUN)
    if (card?.ok && card.view.phase === 'ready') { await works.approve('company-1', RUN, PLAN); break }
    await wait(50)
  }
  out.words = (await working).words
  out.ms = Date.now() - started
  await wait(500)
  out.flow = sites.flow.map(f => ({ ...f }))
  out.calls = calls
  out.done = done
  out.workMaterials = materials.filter(m => m.phase === 'work').map(m => ({ person: m.person, steps: m.steps, plan: m.plan, request: m.request }))
  out.promises = promises
  out.checks = checks
  // For comparing the tool sets: the operator's steps (the preview's and the work's), its stops and the set each was started with.
  out.operatorSteps = materials.length
  out.workSteps = materials.filter(m => m.phase === 'work').length
  out.stops = stops
  out.toolsets = toolsets
  const card = works.card('company-1', RUN)
  out.cardState = card?.ok ? card.view.card?.state ?? null : null
  await win.webContents.loadURL('https://op.test/').catch(() => {})
  await wait(300)
  return out
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

/**
 * A login kept on this PC (agent-browser.md "Keeping a login on disk"): Electron keeps a `persist:` partition's cookies in
 * `<userData>/Partitions/<name>` (where the kept logins are looked for and removed), the window's page-less sessions stay
 * in memory, and removing it leaves no folder and no cookie in the live session.
 */
async function keptScenario(shell: ReturnType<typeof createBrowserWindowShell>, site: BrowserSiteSetting) {
  const out: Record<string, unknown> = {}
  // Where it really is: the kept logins' check refuses a path with a link in it (the test's temp folder is /var → /private/var).
  const partitions = path.join(fs.realpathSync(path.join(dir, 'userData')), 'Partitions')
  const kept = createKeptLogins({ partitionsDir: () => partitions, clearSession: p => shell.clearPartition(p), platformEncloses: true, log: { warn() {} } })
  const partition = kept.partition('user-1', 'company-1', 'op.test')!
  const folder = partition.slice('persist:'.length)
  trustTestCertificate(partition)
  const win = shell.open({ partition, site, onClosed: () => {} })
  await loaded(win)
  await win.webContents.executeJavaScript(`document.cookie = 'sid=kept; Secure; Max-Age=3600'; 1`, true)
  const ses = session.fromPartition(partition)
  await ses.cookies.flushStore()
  out.cookiesKept = (await ses.cookies.get({})).length
  out.folderMade = fs.existsSync(path.join(partitions, folder))
  out.pagelessOnDisk = fs.readdirSync(partitions).filter(name => name.startsWith(folder) && name !== folder)
  win.close()
  out.removed = await kept.remove({ all: true })
  out.folderLeft = fs.existsSync(path.join(partitions, folder))
  out.cookiesAfter = (await ses.cookies.get({})).length
  out.reusable = kept.partition('user-1', 'company-1', 'op.test')
  return out
}

// Closing the test's windows must not end the run (the app's own main.ts keeps running likewise).
app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
