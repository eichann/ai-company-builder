// The Electron side of tests/doc-frame-electron.test.ts: the app's real acb-doc:// registration,
// service and session guard (electron-adapter.ts, features/doc-frames/protocol.ts) with a document
// shown the way the viewer will show it — `<iframe sandbox="allow-scripts">` in a page whose
// preload exposes `window.electronAPI` — and a local HTTP server standing for the internet. Prints
// what happened as one `RESULT {json}` line. Started by the test with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { guardDocFrameNetwork, registerLocalFileScheme, serveDocFrames } from '../../electron/electron-adapter'
import { createDocFrames } from '../../electron/features/doc-frames/protocol'

const dir = process.env.DOC_TEST_DIR!
const port = Number(process.env.DOC_TEST_PORT)
const NET = `http://127.0.0.1:${port}`
app.setPath('userData', path.join(dir, 'userData'))

const result: Record<string, unknown> = {}
const fail = (error: unknown) => {
  console.log(`RESULT ${JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })}`)
  app.exit(1)
}
setTimeout(() => fail(new Error('the harness timed out')), 90_000)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==', 'base64')

function probes(): string {
  // Runs inside the document (an inline script: allowed by the owner's decision).
  return `
const r = { inlineRan: true }
const settle = p => p.then(() => 'reached', e => 'refused')
r.electronAPI = typeof window.electronAPI
try { r.parentAPI = typeof parent.electronAPI } catch (e) { r.parentAPI = 'threw ' + e.name }
try { r.parentDocument = typeof parent.document.body } catch (e) { r.parentDocument = 'threw ' + e.name }
try { localStorage.setItem('k', 'v'); r.localStorage = 'ok' } catch (e) { r.localStorage = 'threw ' + e.name }
try { document.cookie = 'a=b'; r.cookie = 'ok ' + document.cookie } catch (e) { r.cookie = 'threw ' + e.name }
try { indexedDB.open('x'); r.indexedDB = 'ok' } catch (e) { r.indexedDB = 'threw ' + e.name }
r.origin = self.origin
const img = src => new Promise(resolve => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('failed'); i.src = src; document.body.appendChild(i) })
;(async () => {
  r.fetchWeb = await settle(fetch('${NET}/fetch'))
  r.fetchOwnFolder = await settle(fetch('style.css'))
  r.xhr = await new Promise(resolve => { const x = new XMLHttpRequest(); x.onload = () => resolve('reached'); x.onerror = () => resolve('refused'); try { x.open('GET', '${NET}/xhr'); x.send() } catch (e) { resolve('refused') } })
  r.websocket = await new Promise(resolve => { try { const w = new WebSocket('${NET.replace('http', 'ws')}/ws'); w.onopen = () => resolve('reached'); w.onerror = () => resolve('refused') } catch (e) { resolve('refused') } })
  try { r.beacon = navigator.sendBeacon('${NET}/beacon', 'x') } catch (e) { r.beacon = 'threw' }
  r.webImage = await img('${NET}/img.png')
  r.sameFolderImage = await img('images/graph.png')
  r.dotDotImage = await img('../other/secret.png')
  r.encodedDotDotImage = await img('%2e%2e/other/secret.png')
  r.linkImage = await img('link.png')
  r.hiddenImage = await img('.hidden/x.png')
  r.moduleRan = window.moduleRan === true
  r.webScriptRan = window.webScriptRan === true
  parent.postMessage({ type: 'doc-result', result: r }, '*')
  // Last: the frame navigates itself to the web (the CSP does not cover this; the session guard does).
  setTimeout(() => { location.href = '${NET}/nav' }, 200)
})()
`
}

function setUp() {
  const company = path.join(dir, 'company')
  const folder = path.join(company, '営業')
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true })
  fs.mkdirSync(path.join(folder, '.hidden'), { recursive: true })
  fs.mkdirSync(path.join(company, 'other'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'report.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="${NET}/web.css">
<script src="${NET}/cdn.js"></script><script type="module" src="mod.js"></script>
</head><body><p>資料</p><script>${probes()}</script></body></html>`)
  fs.writeFileSync(path.join(folder, 'style.css'), 'p { color: red }')
  fs.writeFileSync(path.join(folder, 'mod.js'), 'window.moduleRan = true\n')
  fs.writeFileSync(path.join(folder, 'images', 'graph.png'), PNG)
  fs.writeFileSync(path.join(folder, '.hidden', 'x.png'), PNG)
  fs.writeFileSync(path.join(company, 'other', 'secret.png'), PNG)
  fs.symlinkSync('../other/secret.png', path.join(folder, 'link.png'))
  fs.writeFileSync(path.join(dir, 'preload.js'), "require('electron').contextBridge.exposeInMainWorld('electronAPI', { marker: 'acb' })\n")
  return { company, folder }
}

registerLocalFileScheme()

async function run() {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/cdn.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.webScriptRan = true'); return }
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => { hits.push(`upgrade ${req.url}`); socket.destroy() })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))

  const { company, folder } = setUp()
  const served: string[] = []
  let ownerId = -1
  const docFrames = createDocFrames({
    paths: {
      validate: p => { if (!path.resolve(p).startsWith(company + path.sep)) throw new Error('outside'); return path.resolve(p) },
      rootOf: () => company,
    },
    notDownloaded: () => [],
    ownerAlive: id => id === ownerId,
    log: { warn: () => {} },
  })
  serveDocFrames({
    serve: async request => {
      const response = await docFrames.serve(request)
      served.push(`${response.status} ${new URL(request.url).pathname}`)
      return response
    },
  })
  guardDocFrameNetwork()

  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(dir, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  ownerId = win.webContents.id
  const checked = await docFrames.check(path.join(folder, 'report.html'))
  if (!checked.ok) throw new Error(`check refused: ${checked.reason}`)
  const url = docFrames.grant(checked.doc, ownerId)
  result.url = url
  const host = path.join(dir, 'host.html')
  fs.writeFileSync(host, `<!doctype html><script>window.results = []; addEventListener('message', e => { if (e.data && e.data.type === 'doc-result') window.results.push(e.data.result) })</script>
<iframe id="doc" sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" src="${url}"></iframe>`)
  await win.loadFile(host)
  const js = (code: string) => win.webContents.executeJavaScript(code, true)
  for (let i = 0; i < 100 && (await js('window.results.length')) === 0; i++) await wait(100)
  result.doc = (await js('window.results'))[0]
  result.hostAPI = await js("typeof window.electronAPI")
  const frame = win.webContents.mainFrame.frames[0]
  result.ownProcess = !!frame && frame.osProcessId !== win.webContents.mainFrame.osProcessId
  await wait(1500)

  // The view closed: the grant is revoked, and a new frame at the same address gets nothing.
  docFrames.close(url, ownerId)
  served.length = 0
  await js(`(() => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = ${JSON.stringify(url)}; document.body.appendChild(f) })()`)
  await wait(1000)
  result.afterClose = [...served]

  // Opened at the top level (outside the app's frame), the CSP's sandbox still makes the origin opaque.
  const top = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  ownerId = top.webContents.id
  const again = await docFrames.check(path.join(folder, 'report.html'))
  if (!again.ok) throw new Error('check refused')
  await top.loadURL(docFrames.grant(again.doc, ownerId)).catch(() => {})
  await wait(500)
  result.topLevel = await top.webContents.executeJavaScript(`(() => { let s; try { localStorage.getItem('k'); s = 'ok' } catch (e) { s = 'threw ' + e.name } return self.origin + ' ' + s })()`, true)
  await wait(500)

  result.hits = hits
  server.close()
  console.log(`RESULT ${JSON.stringify(result)}`)
  app.exit(0)
}

app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
