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
import type { BrowserSiteSetting } from '../../../shared/core/browser-operation'
import { startSites } from './sites'

const dir = process.env.BROWSER_TEST_DIR!
const port = Number(process.env.BROWSER_TEST_PORT)
const TRUSTED = ['op.test', 'assets.test', 'evil.test']
app.commandLine.appendSwitch('host-rules', [...TRUSTED, 'untrusted.test'].map(h => `MAP ${h} 127.0.0.1:${port}`).join(', '))
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
  const sites = await startSites(dir, port)
  const refusalLog: string[] = []
  const shell = createBrowserWindowShell({ show: false, log: { warn: line => { refusalLog.push(String(line)) } } })
  const site: BrowserSiteSetting = { host: 'op.test', level: 'write', assetHosts: ['assets.test'] }
  const partition = browserPartition('user-1', 'company-1', 'op.test', 'disk')
  trustTestCertificate(partition)
  let closed = false
  const win = shell.open({ partition, site, onClosed: () => { closed = true } })
  const page = win.webContents
  await loaded(win)
  await wait(1500)
  const js = (code: string) => page.executeJavaScript(code, true)

  // The member clicks every way out (a user gesture each).
  for (const id of ['popup', 'js', 'nav', 'redirect-nav', 'download', 'download-evil']) {
    await js(`document.getElementById('${id}').click()`)
    await wait(400)
  }
  await js(`window.open('https://evil.test/window-open'); 1`)
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

  // The login: a cookie and storage of the site, then cleared.
  await js(`document.cookie = 'sid=1; Secure; Max-Age=3600'; localStorage.setItem('k', 'v'); 1`)
  const ses = session.fromPartition(partition)
  result.cookiesBefore = (await ses.cookies.get({})).length
  win.close()
  await wait(500)
  result.closed = closed
  result.refusalLog = refusalLog
  // With its window closed the session reaches nowhere.
  result.afterClose = await ses.fetch('https://op.test/after-close').then(r => r.status, () => 'refused')
  await shell.clearPartition(partition)
  result.cookiesAfter = (await ses.cookies.get({})).length

  // A certificate the system does not trust is refused, never bypassed.
  const untrusted = browserPartition('user-1', 'company-1', 'untrusted.test', 'memory')
  trustTestCertificate(untrusted)
  const other = shell.open({ partition: untrusted, site: { host: 'untrusted.test', level: 'read', assetHosts: [] }, onClosed: () => {} })
  await loaded(other)
  await wait(500)
  result.untrustedUrl = other.webContents.getURL()
  other.close()

  result.hits = sites.hits
  sites.close()
  console.log(`RESULT ${JSON.stringify(result)}`)
  app.quit()
}

// Closing the test's windows must not end the run (the app's own main.ts keeps running likewise).
app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
