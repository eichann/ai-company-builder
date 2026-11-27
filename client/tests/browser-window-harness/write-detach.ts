// The Electron side of tests/browser-write-detach-electron.test.ts (agent-browser.md "Writes within frames, in the app"):
// a write run's page write is held by the app's real window while the window's DevTools connection goes — the connection
// detached, the window closed, the page reloaded — before the permit, while the run's copy is on its way, and after the
// site's answer. A fictional site counts what reaches it: the run's copy (sent from main's write session) or the page's own
// original (Chromium lets go of a paused request when the connection goes). Writes `<BROWSER_TEST_DIR>/result.json`.
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { createBrowserWindowShell } from '../../electron/browser-window'
import { browserPartition } from '../../electron/features/browser/controller'
import { createFrameWriter } from '../../electron/features/browser/frame-writes'
import type { BrowserSiteSetting } from '../../../shared/core/browser-operation'
import type { BrowserLinesAnswer } from '../../electron/features/browser/lines-api'

const dir = process.env.BROWSER_TEST_DIR!
const port = Number(process.env.BROWSER_TEST_PORT)
app.commandLine.appendSwitch('host-rules', `MAP op.test 127.0.0.1:${port}`)
app.setPath('userData', path.join(dir, 'userData'))
// Only this harness trusts its own certificate, for the test host only (production code never sets a certificate check).
const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'cert.pem')))
const fingerprint = `sha256/${crypto.createHash('sha256').update(certificate.raw).digest('base64')}`
app.on('session-created', s => s.setCertificateVerifyProc((r, cb) => cb(r.hostname === 'op.test' && r.certificate.fingerprint === fingerprint ? 0 : -3)))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const writeResult = (value: unknown) => {
  const file = path.join(dir, 'result.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}
setTimeout(() => { writeResult({ error: 'the harness timed out' }); app.exit(1) }, 200_000)

/** A save that reached the site: the run's copy (main's request: `no-cors`) or the page's own original. */
interface Hit { name: string; original: boolean; end: number }
const hits: Hit[] = []
const answerAfter = new Map<string, number>()
const PAGE = `<!doctype html><meta charset="utf-8"><title>w</title><p>w</p><script>
window.save = name => fetch('/w/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
  .then(async r => ({ status: r.status, body: await r.json() }), () => 'failed')
window.keep = name => { fetch('/w/save', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {}); return 'sent' }
window.form = name => { const f = document.createElement('form'); f.method = 'POST'; f.action = '/w/save'; const i = document.createElement('input'); i.name = 'name'; i.value = name; f.appendChild(i); document.body.appendChild(f); f.submit(); return 'sent' }
</script>`

function startSite() {
  const tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }
  https.createServer(tls, (req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method === 'GET') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return }
      let name = '?'
      try { name = String(req.headers['content-type']?.startsWith('application/json') ? JSON.parse(body).name : new URLSearchParams(body).get('name')) } catch { /* ? */ }
      // The run's copy is main's own request (Chromium marks it `no-cors`); the page's fetch is `cors`, its form `navigate`.
      const hit: Hit = { name, original: req.headers['sec-fetch-mode'] !== 'no-cors', end: 0 }
      hits.push(hit)
      setTimeout(() => { hit.end = Date.now(); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 7, name })) }, answerAfter.get(name) ?? 200)
    })
  }).listen(port, '127.0.0.1')
}

type When = 'before-permit' | 'sending' | 'after-answer'
type How = 'detach' | 'close' | 'reload'
type Kind = 'fetch' | 'keepalive' | 'form'

const site: BrowserSiteSetting = { host: 'op.test', level: 'write', assetHosts: [] }
const shell = createBrowserWindowShell({ show: false, log: { warn: () => {} } })

async function one(i: number, when: When, how: How, kind: Kind) {
  const name = `w${i}`
  const win = shell.open({ partition: browserPartition(`user-${i}`, 'company-1', 'op.test'), site, onClosed: () => {} })
  const page = win.webContents
  await new Promise<void>(resolve => { if (!page.isLoading() && page.getURL()) resolve(); else page.once('did-stop-loading', () => resolve()) })
  await page.loadURL('https://op.test/w')
  let permits = 0
  const reports: string[] = []
  const writer = createFrameWriter({
    companyId: 'company-1', runId: `bf_${'a'.repeat(32)}`, host: 'op.test', going: () => true, stepsSoFar: () => 0,
    frames: [{ frame: 1, method: 'POST', path: '/w/save', query: null, fields: {}, max: 4, left: 4 }],
    api: {
      async framePermit(): Promise<BrowserLinesAnswer> {
        permits++
        if (when === 'before-permit') await wait(1500)
        return { kind: 'ok', value: { write: 1, frame: 1, permittedAt: new Date().toISOString(), validMs: 5000 } }
      },
      async frameReport(_c, _r, body): Promise<BrowserLinesAnswer> {
        reports.push(body.result)
        if (when === 'after-answer') await wait(1500)
        return { kind: 'ok', value: {} }
      },
    },
  })
  // As the work wires it (work.ts): unknown only when an original may have gone out; else nothing more is sent.
  const entered = await win.browse.enter(() => false, {
    holdWrite: held => writer.hold(held), neverRead: () => false,
    detached: mayHaveGone => { if (mayHaveGone) writer.abandon('detached'); else writer.close() },
  })
  answerAfter.set(name, when === 'sending' ? 2500 : 200)
  const pageAnswer = page.executeJavaScript(kind === 'fetch' ? `save('${name}')` : kind === 'keepalive' ? `keep('${name}')` : `form('${name}')`, true).catch(() => 'page gone')
  // The moment the connection goes: the permit on its way; the copy at the site (no answer yet); the answer given (its
  // report on its way, so the page's request is still held).
  if (when === 'before-permit') await wait(400)
  else {
    const until = Date.now() + 5000
    while (Date.now() < until && !hits.some(h => h.name === name && (when === 'sending' || h.end > 0))) await wait(20)
    await wait(100)
  }
  if (how === 'detach') page.debugger.detach()
  else if (how === 'close') win.close()
  else page.reload()
  const answer = await Promise.race([pageAnswer, wait(3000).then(() => 'no answer')])
  // Every held write decided (a copy cut on its way keeps its own result), then a moment for a late original.
  await Promise.race([writer.idle(), wait(8000)])
  await wait(1500)
  const mine = hits.filter(h => h.name === name)
  const out = {
    when, how, kind, entered, permits, reports,
    copies: mine.filter(h => !h.original).length, originals: mine.filter(h => h.original).length,
    records: writer.records().map(r => r.outcome), page: answer,
  }
  try { if (!page.isDestroyed()) await win.browse.leave() } catch { /* gone */ }
  try { win.close() } catch { /* gone */ }
  return out
}

/** The same window and page, nothing cut: the page still gets the site's answer through the held write (its flow goes on). */
async function uncut(i: number) {
  const win = shell.open({ partition: browserPartition(`user-${i}`, 'company-1', 'op.test'), site, onClosed: () => {} })
  const page = win.webContents
  await new Promise<void>(resolve => { if (!page.isLoading() && page.getURL()) resolve(); else page.once('did-stop-loading', () => resolve()) })
  await page.loadURL('https://op.test/w')
  const writer = createFrameWriter({
    companyId: 'company-1', runId: `bf_${'b'.repeat(32)}`, host: 'op.test', going: () => true, stepsSoFar: () => 0,
    frames: [{ frame: 1, method: 'POST', path: '/w/save', query: null, fields: {}, max: 4, left: 4 }],
    api: {
      async framePermit() { return { kind: 'ok', value: { write: 1, frame: 1, permittedAt: new Date().toISOString(), validMs: 5000 } } },
      async frameReport() { return { kind: 'ok', value: {} } },
    },
  })
  await win.browse.enter(() => false, { holdWrite: held => writer.hold(held), neverRead: () => false, detached: () => writer.abandon('detached') })
  const answer = await page.executeJavaScript(`save('w${i}')`, true)
  // A form's navigation: the page lands on the address it posted to with the site's answer (the parked address never shows).
  const landed = new Promise<void>(resolve => page.once('did-stop-loading', () => resolve()))
  await page.executeJavaScript(`form('f${i}')`, true)
  await Promise.race([landed, wait(5000)])
  const formLanded = { url: page.getURL(), text: await page.executeJavaScript('document.body.innerText', true).catch(() => null) }
  const mine = hits.filter(h => h.name === `w${i}` || h.name === `f${i}`)
  await win.browse.leave()
  win.close()
  return { answer, formLanded, copies: mine.filter(h => !h.original).length, originals: mine.filter(h => h.original).length, records: writer.records().map(r => r.outcome) }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  startSite()
  const cases: Array<[When, How, Kind]> = [
    ['before-permit', 'detach', 'fetch'], ['sending', 'detach', 'fetch'], ['after-answer', 'detach', 'fetch'],
    ['before-permit', 'detach', 'form'], ['sending', 'detach', 'keepalive'],
    // A keepalive write outlives its page: closing the window let its original out before the fix.
    ['before-permit', 'close', 'keepalive'], ['sending', 'close', 'keepalive'], ['after-answer', 'close', 'keepalive'],
    ['sending', 'reload', 'fetch'],
  ]
  const out: unknown[] = []
  let i = 0
  for (const [when, how, kind] of cases) out.push(await one(i++, when, how, kind))
  writeResult({ cases: out, uncut: await uncut(i++) })
  app.exit(0)
}).catch(error => { writeResult({ error: error instanceof Error ? error.stack : String(error) }); app.exit(1) })
