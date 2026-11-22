// The Electron side of tests/doc-frame-electron.test.ts: the app's real scheme registration, document
// session and views (doc-view.ts), grants and server (features/doc-frames/), showing a document the
// way the viewer will — a view of its own in a window whose page has a preload — while local
// listeners stand for the internet: one raw TCP listener per probe (fetch, XHR, WebSocket, beacon,
// image, script, stylesheet, navigation, and what no request hook sees: preconnect, preload,
// prefetch, DNS prefetch, a report, TURN over TCP), counting accepted connections — a TLS handshake
// that then fails still counts —, names mapped with Chromium's `host-rules` (a loopback address
// would bypass any proxy), and a UDP socket for STUN. Every probe is https / wss: acb-doc is a
// secure scheme, so an http probe would be stopped by mixed-content blocking before any guard.
// Prints what happened as one `RESULT {json}` line. Started with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow, session, webContents as allWebContents } from 'electron'
import dgram from 'node:dgram'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { registerLocalFileScheme } from '../../electron/electron-adapter'
import { createDocViewShell, DOC_PARTITION } from '../../electron/doc-view'
import { startRefusingProxy } from '../../electron/browser-window'
import { createDocFrames } from '../../electron/features/doc-frames/protocol'
import { createDocViews } from '../../electron/features/doc-frames/views'

const dir = process.env.DOC_TEST_DIR!
const ports = JSON.parse(process.env.DOC_TEST_PORTS!) as Record<string, number>
const TCP_NAMES = ['fetch', 'xhr', 'ws', 'beacon', 'img', 'script', 'style', 'nav', 'popup', 'preconnect', 'preload', 'prefetch', 'dnsprefetch', 'turn', 'report']
app.commandLine.appendSwitch('host-rules', TCP_NAMES.map(n => `MAP ${n}.test 127.0.0.1:${ports[n]}`).join(', '))
app.setPath('userData', path.join(dir, 'userData'))
registerLocalFileScheme()

const result: Record<string, unknown> = {}
const fail = (error: unknown) => {
  console.log(`RESULT ${JSON.stringify({ error: error instanceof Error ? error.stack : String(error) })}`)
  app.exit(1)
}
setTimeout(() => fail(new Error('the harness timed out')), 100_000)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==', 'base64')
const WEB = (name: string) => `https://${name}.test`

function probes(): string {
  // Runs inside the document (an inline script: allowed by the owner's decision).
  return `
const r = { inlineRan: true }
window.__r = null
const settle = p => p.then(() => 'reached', e => 'refused')
const add = (rel, href, as) => { const l = document.createElement('link'); l.rel = rel; l.href = href; if (as) l.as = as; document.head.appendChild(l) }
r.electronAPI = typeof window.electronAPI
r.nodeGlobals = [typeof require, typeof process].join(',')
try { localStorage.setItem('k', 'v'); r.localStorage = 'ok' } catch (e) { r.localStorage = 'threw ' + e.name }
try { document.cookie = 'a=b'; r.cookie = 'ok ' + document.cookie } catch (e) { r.cookie = 'threw ' + e.name }
try { indexedDB.open('x'); r.indexedDB = 'ok' } catch (e) { r.indexedDB = 'threw ' + e.name }
r.origin = self.origin
const img = src => new Promise(resolve => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('failed'); i.src = src; document.body.appendChild(i) })
// What no request hook sees: the listeners count connections.
add('preconnect', 'https://preconnect.test/')
add('preload', 'https://preload.test/x.png', 'image')
add('prefetch', 'https://prefetch.test/x')
add('dns-prefetch', 'https://dnsprefetch.test/')
try {
  const pc = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:127.0.0.1:${ports.stun}' },
    { urls: 'turn:turn.test:3478?transport=tcp', username: 'secret-in-username', credential: 'x' },
  ] })
  pc.createDataChannel('x')
  pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {})
  r.rtc = 'made'
} catch (e) { r.rtc = 'threw ' + e.name }
;(async () => {
  r.fetchWeb = await settle(fetch('${WEB('fetch')}/fetch'))
  r.fetchOwnFolder = await settle(fetch('style.css'))
  r.xhr = await new Promise(resolve => { const x = new XMLHttpRequest(); x.onload = () => resolve('reached'); x.onerror = () => resolve('refused'); try { x.open('GET', '${WEB('xhr')}/xhr'); x.send() } catch (e) { resolve('refused') } })
  r.websocket = await new Promise(resolve => { try { const w = new WebSocket('wss://ws.test/ws'); w.onopen = () => resolve('reached'); w.onerror = () => resolve('refused') } catch (e) { resolve('refused') } })
  try { navigator.sendBeacon('${WEB('beacon')}/beacon', 'x') } catch (e) {}
  r.webImage = await img('${WEB('img')}/img.png')
  r.sameFolderImage = await img('images/graph.png')
  r.dotDotImage = await img('../other/secret.png')
  r.encodedDotDotImage = await img('%2e%2e/other/secret.png')
  r.linkImage = await img('link.png')
  r.hiddenImage = await img('.hidden/x.png')
  r.localFileImage = await img('local-file://${encodeURI(path.join(dir, 'company', 'other', 'secret.png'))}')
  r.fileImage = await img('file://${encodeURI(path.join(dir, 'company', 'other', 'secret.png'))}')
  // A violation of the document's own meta CSP (font-src), whose report-uri names a web address.
  r.fontViolation = await document.fonts.load('16px probe').then(() => 'loaded', () => 'refused')
  r.moduleRan = window.moduleRan === true
  r.webScriptRan = window.webScriptRan === true
  try { r.popup = window.open('${WEB('popup')}/popup') === null ? 'null' : 'window' } catch (e) { r.popup = 'threw' }
  window.__r = r
})()
`
}

function setUp() {
  const company = path.join(dir, 'company')
  const folder = path.join(company, '営業')
  for (const d of ['images', '.hidden']) fs.mkdirSync(path.join(folder, d), { recursive: true })
  fs.mkdirSync(path.join(company, 'other'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'report.html'), `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="font-src 'none'; report-uri https://report.test/r"><style>@font-face { font-family: probe; src: url(probe.woff2) }</style>
<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="${WEB('style')}/web.css">
<script src="${WEB('script')}/cdn.js"></script><script type="module" src="mod.js"></script>
</head><body><p>資料</p><script>${probes()}</script></body></html>`)
  fs.writeFileSync(path.join(folder, 'page2.html'), '<!doctype html><p>2</p>')
  fs.writeFileSync(path.join(folder, 'style.css'), 'p { color: red }')
  fs.writeFileSync(path.join(folder, 'mod.js'), 'window.moduleRan = true\n')
  fs.writeFileSync(path.join(folder, 'images', 'graph.png'), PNG)
  fs.writeFileSync(path.join(folder, '.hidden', 'x.png'), PNG)
  fs.writeFileSync(path.join(company, 'other', 'secret.png'), PNG)
  fs.writeFileSync(path.join(company, 'other', 'other.html'), '<!doctype html><p>other</p>')
  fs.symlinkSync('../other/secret.png', path.join(folder, 'link.png'))
  fs.writeFileSync(path.join(dir, 'preload.js'), "require('electron').contextBridge.exposeInMainWorld('electronAPI', { marker: 'acb' })\n")
  fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><p>app</p>')
  return { company, folder }
}

async function listen() {
  const connections: Record<string, number> = {}
  const servers: Array<net.Server | dgram.Socket> = []
  for (const name of TCP_NAMES) {
    const s = net.createServer(socket => { connections[name] = (connections[name] ?? 0) + 1; socket.on('error', () => {}); socket.destroy() })
    await new Promise<void>(resolve => s.listen(ports[name], '127.0.0.1', resolve))
    servers.push(s)
  }
  const udp = dgram.createSocket('udp4')
  udp.on('message', () => { connections.stun = (connections.stun ?? 0) + 1 })
  await new Promise<void>(resolve => udp.bind(ports.stun, '127.0.0.1', resolve))
  servers.push(udp)
  return { connections, close: () => servers.forEach(s => s.close()) }
}

async function run() {
  const net0 = await listen()
  const { company, folder } = setUp()
  const docFrames = createDocFrames({
    paths: {
      validate: p => { if (!path.resolve(p).startsWith(company + path.sep)) throw new Error('outside'); return path.resolve(p) },
      rootOf: () => company,
    },
    notDownloaded: () => [],
    log: { warn: () => {} },
  })
  const shown = new Map<number, string>()
  // The first preparation of the session fails (its proxy cannot be set); the next open must recover.
  let proxyTries = 0
  const shell = createDocViewShell({
    serve: request => docFrames.serve(request),
    refusingProxy: async () => { if (proxyTries++ === 0) throw new Error('no proxy this time'); return startRefusingProxy() },
    log: { warn: () => {} },
  })
  const views = createDocViews({
    frames: docFrames,
    // Remember each view's address (the renderer never gets it) to probe it after the view is gone.
    shell: { onWindowReset: listener => shell.onWindowReset(listener), watch: windowId => shell.watch(windowId), create: async (windowId, onGone) => {
      const handle = await shell.create(windowId, onGone)
      return handle && { id: handle.id, destroy: handle.destroy, show: url => { shown.set(handle.id, url); handle.show(url) } }
    } },
  })

  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(dir, 'preload.js'), contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(dir, 'app.html'))
  const openView = async (file: string) => {
    const checked = await docFrames.check(file)
    if (!checked.ok) throw new Error(`check refused: ${checked.reason}`)
    return views.open(checked.doc, views.begin(win.webContents.id))
  }
  result.firstOpenWithoutProxy = await openView(path.join(folder, 'report.html'))
  const open = async (file: string) => {
    const viewId = await openView(file)
    if (viewId === null) throw new Error('no view')
    const contents = allWebContents.fromId(viewId)!
    for (let i = 0; i < 50 && (contents.isLoading() || !contents.getURL()); i++) await wait(100)
    return { viewId, contents, url: shown.get(viewId)! }
  }
  const doc = await open(path.join(folder, 'report.html'))
  const js = (code: string) => doc.contents.executeJavaScript(code, true)
  for (let i = 0; i < 100 && !(await js('window.__r')); i++) await wait(100)
  result.doc = await js('window.__r')
  // Until the viewer shows it (A2): hidden and silent.
  result.hidden = { muted: doc.contents.isAudioMuted(), visibility: await js('document.visibilityState') }
  result.hostAPI = await win.webContents.executeJavaScript('typeof window.electronAPI', true)
  result.windowsAfterPopup = BrowserWindow.getAllWindows().length
  // Give preconnect, WebRTC and reports time to try.
  await wait(3000)

  // The session: in memory, only acb-doc handled, the app's schemes not; the app's session not acb-doc.
  const ses = session.fromPartition(DOC_PARTITION)
  result.session = {
    persistent: ses.isPersistent(),
    docHandled: ses.protocol.isProtocolHandled('acb-doc'),
    localFileHandled: ses.protocol.isProtocolHandled('local-file'),
    pluginHandled: ses.protocol.isProtocolHandled('acb-plugin'),
    defaultServesDoc: session.defaultSession.protocol.isProtocolHandled('acb-doc'),
    viewPartitionIsDoc: doc.contents.session === ses,
  }

  // Navigations of the document: each refused, the page stays.
  const other = await open(path.join(company, 'other', 'other.html')).catch(() => null)
  const otherUrl = other?.url ?? `acb-doc://${'f'.repeat(32)}/other.html`
  const targets: Record<string, string> = {
    data: 'data:text/html,<p>x</p>',
    localFile: `local-file://${encodeURI(path.join(company, 'other', 'secret.png'))}`,
    file: `file://${encodeURI(path.join(company, 'other', 'other.html'))}`,
    plugin: 'acb-plugin://p/1.0.0/ui/index.html',
    otherToken: otherUrl,
    web: `${WEB('nav')}/nav`,
    ownCss: doc.url.replace(/report\.html$/, 'style.css'),
  }
  const navigations: Record<string, string> = {}
  for (const [name, target] of Object.entries(targets)) {
    await js(`location.href = ${JSON.stringify(target)}`).catch(() => {})
    await wait(600)
    navigations[name] = doc.contents.getURL() === doc.url ? 'stayed' : 'moved'
  }
  // A page of its own grant is allowed (control).
  await js(`location.href = 'page2.html'`).catch(() => {})
  await wait(800)
  navigations.ownPage = doc.contents.getURL().endsWith('/page2.html') ? 'moved' : 'stayed'
  result.navigations = navigations

  // The app's page reloads: every view of the window closes and its grant goes.
  win.webContents.reload()
  await wait(1500)
  result.afterReload = {
    viewGone: !allWebContents.fromId(doc.viewId) || allWebContents.fromId(doc.viewId)!.isDestroyed(),
    served: (await docFrames.serve({ url: doc.url, method: 'GET' })).status,
  }
  result.partitionFolders = fs.existsSync(path.join(dir, 'userData', 'Partitions')) ? fs.readdirSync(path.join(dir, 'userData', 'Partitions')) : []
  result.connections = net0.connections
  net0.close()
  console.log(`RESULT ${JSON.stringify(result)}`)
  app.exit(0)
}

app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
