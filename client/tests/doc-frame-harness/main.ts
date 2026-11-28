// The Electron side of tests/doc-frame-electron.test.ts: the app's real scheme registration, document
// session and views (doc-view.ts), grants and server (features/doc-frames/), showing a document the
// way the viewer will — a view of its own in a window whose page has a preload — while local
// listeners stand for the internet: one raw TCP listener per probe (fetch, XHR, WebSocket, beacon,
// image, script, stylesheet, navigation, and what no request hook sees: preconnect, preload,
// prefetch, DNS prefetch, TURN over TCP), counting accepted connections — a TLS handshake
// that then fails still counts —, names mapped with Chromium's `host-rules` (a loopback address
// would bypass any proxy), and a UDP socket for STUN. Every probe is https / wss: acb-doc is a
// secure scheme, so an http probe would be stopped by mixed-content blocking before any guard.
// Writes what happened as JSON to `<DOC_TEST_DIR>/result.json` (written whole, then renamed: the test
// reads it after the process exited — a long line on stdout could be cut when Electron quits before
// its pipe is drained). Started with `NODE_OPTIONS=--import tsx`.
import { app, BrowserWindow, session, webContents as allWebContents, type WebContents } from 'electron'
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
const TCP_NAMES = ['fetch', 'xhr', 'ws', 'beacon', 'img', 'script', 'style', 'nav', 'popup', 'preconnect', 'preload', 'prefetch', 'dnsprefetch', 'turn']
app.commandLine.appendSwitch('host-rules', TCP_NAMES.map(n => `MAP ${n}.test 127.0.0.1:${ports[n]}`).join(', '))
app.setPath('userData', path.join(dir, 'userData'))
registerLocalFileScheme()

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
setTimeout(() => fail(new Error('the harness timed out')), 150_000)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==', 'base64')
const WEB = (name: string) => `https://${name}.test`

function probes(): string {
  // Runs inside the document (an inline script: allowed by the owner's decision).
  return `
const r = { inlineRan: true }
window.__r = null
// A document that tries to take the keyboard: autofocus (below) and focus() over and over.
setInterval(() => { try { window.focus(); document.getElementById('grab').focus() } catch (e) {} }, 100)
document.addEventListener('keydown', e => { window.__keys = (window.__keys || '') + e.key })
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
  // For the band (A3): the same host again with a secret in the path and query (twice: one part),
  // and more hosts than the band names. Nothing of a path or query may reach the window.
  await img('${WEB('img')}/secret-path/a.png?q=secret-in-query')
  await img('${WEB('img')}/secret-path/a.png?q=secret-in-query')
  await Promise.all(Array.from({ length: 30 }, (_, i) => img('https://many' + i + '.test/secret-path/p.png?q=secret-in-query')))
  r.sameFolderImage = await img('images/graph.png')
  r.dotDotImage = await img('../other/secret.png')
  r.encodedDotDotImage = await img('%2e%2e/other/secret.png')
  r.linkImage = await img('link.png')
  r.hiddenImage = await img('.hidden/x.png')
  r.localFileImage = await img('local-file://${encodeURI(path.join(dir, 'company', 'other', 'secret.png'))}')
  r.fileImage = await img('file://${encodeURI(path.join(dir, 'company', 'other', 'secret.png'))}')
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
<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="${WEB('style')}/web.css">
<script src="${WEB('script')}/cdn.js"></script><script type="module" src="mod.js"></script>
</head><body><p>資料</p><input id="grab" autofocus><div style="height:3000px"></div><script>${probes()}</script></body></html>`)
  fs.writeFileSync(path.join(folder, 'late.html'), `<!doctype html><meta charset="utf-8"><div style="height:3000px"></div>
<script>addEventListener('load', () => { const i = document.createElement('input'); i.id = 'late'; i.autofocus = true; document.body.prepend(i) })</script>`)
  fs.writeFileSync(path.join(folder, 'page2.html'), '<!doctype html><p>2</p>')
  // Review (doc-frame.md "Review in the document view"): a page that replaces the built-ins the app's
  // piece uses (it must not see or steer the piece) and keeps making a selection and firing synthetic
  // mouse-up / Shift key-up events (they must read nothing) until the harness says stop.
  fs.writeFileSync(path.join(folder, 'review.html'), `<!doctype html><meta charset="utf-8"><p id="t">11月の売上は 2,340 万円で、前年同月比 112% でした。</p>
<script>
const realRange = Range, realSelection = getSelection.bind(window)
window.__called = []
const spy = name => function () { window.__called.push(name); return 'FAKE' }
Selection.prototype.toString = spy('Selection.toString')
window.getSelection = spy('getSelection')
document.createTreeWalker = spy('createTreeWalker')
CSS.highlights.set = spy('CSS.highlights.set')
window.Range = spy('Range')
window.__fake = true
window.__synthetic = 0
setInterval(() => {
  if (!window.__fake) return
  const n = document.getElementById('t').firstChild
  const r = new realRange(); r.setStart(n, 0); r.setEnd(n, 6)
  const s = realSelection(); s.removeAllRanges(); s.addRange(r)
  for (const target of [document, document.body, n.parentElement]) {
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: true, bubbles: true }))
  }
  window.__synthetic++
}, 30)
</script>`)
  fs.writeFileSync(path.join(folder, 'style.css'), 'p { color: red }')
  fs.writeFileSync(path.join(folder, 'mod.js'), 'window.moduleRan = true\n')
  fs.writeFileSync(path.join(folder, 'images', 'graph.png'), PNG)
  fs.writeFileSync(path.join(folder, '.hidden', 'x.png'), PNG)
  fs.writeFileSync(path.join(company, 'other', 'secret.png'), PNG)
  fs.writeFileSync(path.join(company, 'other', 'other.html'), '<!doctype html><p>other</p>')
  fs.symlinkSync('../other/secret.png', path.join(folder, 'link.png'))
  fs.writeFileSync(path.join(dir, 'preload.js'), "require('electron').contextBridge.exposeInMainWorld('electronAPI', { marker: 'acb' })\n")
  fs.writeFileSync(path.join(dir, 'app.html'), '<!doctype html><p>app</p><input id="typing"><script>document.getElementById("typing").focus()</script>')
  // A page the AI made for a rich reply (reply-style.ts), in the member's 今日のフォルダ's page folder, written as if
  // the AI had read a planted mail: it tries the day's own files, the member's other personal files, the company's,
  // a key file outside the company, the app and the web (chat-ui-and-history.md "Page cards in a reply").
  const today = path.join(folder, '.personal', 'inbox', '日付別', '2026', '20261128')
  const pages = path.join(today, 'ページ')
  fs.mkdirSync(pages, { recursive: true })
  fs.mkdirSync(path.join(dir, 'home', '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(today, 'メモ.png'), PNG)
  fs.writeFileSync(path.join(folder, '.personal', '鍵.png'), PNG)
  fs.writeFileSync(path.join(dir, 'home', '.ssh', 'id.png'), PNG)
  fs.writeFileSync(path.join(pages, '図.png'), PNG)
  const fromPage = (p: string) => encodeURI(path.relative(pages, p))
  fs.writeFileSync(path.join(pages, 'planted.html'), `<!doctype html><meta charset="utf-8"><p>比べる表</p><script>
const r = {}
const img = src => new Promise(resolve => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => resolve('failed'); i.src = src; document.body.appendChild(i) })
;(async () => {
  r.ownImage = await img('図.png')
  r.dayFile = await img('${fromPage(path.join(today, 'メモ.png'))}')
  r.encodedDayFile = await img('%2e%2e/' + encodeURIComponent('メモ.png'))
  r.personalFile = await img('${fromPage(path.join(folder, '.personal', '鍵.png'))}')
  r.companyFile = await img('${fromPage(path.join(folder, 'images', 'graph.png'))}')
  r.keyFile = await img('file://${encodeURI(path.join(dir, 'home', '.ssh', 'id.png'))}')
  r.localKeyFile = await img('local-file://${encodeURI(path.join(dir, 'home', '.ssh', 'id.png'))}')
  r.electronAPI = typeof window.electronAPI
  r.parentAPI = (() => { try { return typeof window.parent.electronAPI } catch (e) { return 'threw' } })()
  r.top = window.top === window
  r.fetchWeb = await fetch('${WEB('fetch')}/page?d=' + encodeURIComponent(document.body.innerText)).then(() => 'reached', () => 'refused')
  r.webImage = await img('${WEB('img')}/page.png')
  try { localStorage.setItem('k', 'v'); r.localStorage = 'ok' } catch (e) { r.localStorage = 'threw' }
  window.__r = r
})()
</script>`)
  return { company, folder, pagePath: path.join(pages, 'planted.html') }
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
  const { company, folder, pagePath } = setUp()
  const docFrames = createDocFrames({
    paths: {
      validate: p => { if (!path.resolve(p).startsWith(company + path.sep)) throw new Error('outside'); return path.resolve(p) },
      rootOf: () => company,
    },
    notDownloaded: () => [],
    log: { warn: () => {} },
  })
  const shown = new Map<number, string>()
  const events: unknown[] = []
  /** What the window was told about blocked internet parts (hosts and a count only). */
  const blockedEvents: unknown[] = []
  /** When main sent each of them (the gaps show its throttle, however long the page takes). */
  const blockedTimes: number[] = []
  // The first preparation of the session fails (its proxy cannot be set); the next open must recover.
  let proxyTries = 0
  const shell = createDocViewShell({
    serve: request => docFrames.serve(request),
    refusingProxy: async () => { if (proxyTries++ === 0) throw new Error('no proxy this time'); return startRefusingProxy() },
    log: { warn: () => {} },
  })
  const views = createDocViews({
    frames: docFrames,
    notify: (_windowId, event) => { if (event.kind === 'blocked') { blockedEvents.push(event); blockedTimes.push(performance.now()) } else events.push(event) },
    // Remember each view's address (the renderer never gets it) to probe it after the view is gone.
    shell: { onWindowReset: listener => shell.onWindowReset(listener), watch: windowId => shell.watch(windowId), create: async (windowId, hooks) => {
      const handle = await shell.create(windowId, hooks)
      return handle && { ...handle, show: (url, at) => { shown.set(handle.id, url); handle.show(url, at) } }
    } },
  })

  // Shown and focused: the keyboard focus is measured (a hidden window has none).
  const win = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { preload: path.join(dir, 'preload.js'), contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(dir, 'app.html'))
  win.focus()
  win.webContents.focus()
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
  // The tally is sent at most every 500 ms: wait until it has counted every part the page asked for
  // (the 40 the test expects; 5 s at most, then the test sees what came).
  const lastCount = () => (blockedEvents.at(-1) as { count?: number } | undefined)?.count
  for (let i = 0; i < 100 && lastCount() !== 40; i++) await wait(50)
  result.blocked = [...blockedEvents]
  result.blockedGaps = blockedTimes.slice(1).map((at, i) => at - blockedTimes[i])
  // Until the viewer shows it (A2): hidden and silent.
  result.hidden = { muted: doc.contents.isAudioMuted(), visibility: await js('document.visibilityState') }
  // Loading focuses a view (measured), and the page calls focus() and has autofocus: the keyboard stays the app's.
  const keyboard = () => ({ app: win.webContents.isFocused(), doc: doc.contents.isFocused() })
  result.focusWhileHidden = keyboard()
  /** The view loaded again (its did-finish-load, after the shell's own listener has run). */
  const reloaded = async (viewId: number, contents: WebContents) => {
    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve))
    views.reload(viewId, win.webContents.id)
    if (await Promise.race([loaded.then(() => true), wait(15_000).then(() => false)]) === false) throw new Error('the view did not load again')
  }
  /** Two frames drawn by a shown view: the scroll position, put back in its first frame after the load, is final. */
  const framesDrawn = (contents: WebContents) => contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))', true)
  const reloadSettled = async (viewId: number, contents: WebContents) => {
    await reloaded(viewId, contents)
    await framesDrawn(contents)
  }
  const viewOf = (id: number) => win.contentView.children.find(v => (v as { webContents?: { id: number } }).webContents?.id === id)!
  // The viewer shows it over its tab: placed (times the app page's zoom), visible, unmuted.
  win.webContents.setZoomFactor(1.25)
  views.place(doc.viewId, win.webContents.id, { x: 40, y: 30, width: 400, height: 300 })
  await wait(800)
  result.shown = { bounds: viewOf(doc.viewId).getBounds(), visible: viewOf(doc.viewId).getVisible(), muted: doc.contents.isAudioMuted(), visibility: await js('document.visibilityState'), keyboard: keyboard() }
  win.webContents.setZoomFactor(1)
  // A placement from another window, or not four sane numbers, never moves it somewhere else.
  views.place(doc.viewId, win.webContents.id + 1000, { x: 0, y: 0, width: 800, height: 600 })
  result.otherWindowPlace = viewOf(doc.viewId).getBounds()
  views.place(doc.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  // The member clicks into it: the keyboard is the document's (slides take ← →).
  doc.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.focus()
  await wait(500)
  result.focusAfterClick = keyboard()
  // The app's shortcuts reach the app while the document has the keyboard; its own keys stay with it.
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  const press = (keyCode: string, modifiers: Array<'meta' | 'control' | 'shift' | 'isAutoRepeat'> = []) => {
    doc.contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (!modifiers.length) doc.contents.sendInputEvent({ type: 'char', keyCode })
    doc.contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const shortcuts = () => events.filter(e => (e as { kind: string }).kind === 'shortcut').map(e => {
    const { key } = e as { key: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean } }
    return `${key.metaKey || key.ctrlKey ? 'mod+' : ''}${key.shiftKey ? 'shift+' : ''}${key.key.toLowerCase()}`
  })
  events.length = 0
  await js(`window.__keys = ''; document.getElementById('grab').value = ''; 0`)
  press('K', [mod])
  await wait(200)
  const afterFind = { shortcuts: shortcuts(), keys: await js('window.__keys') }
  events.length = 0
  press('Right')
  press('a')
  press('Space')
  await wait(200)
  const ownKeys = { shortcuts: shortcuts(), keys: await js('window.__keys'), typed: await js(`document.getElementById('grab').value`) }
  events.length = 0
  press('V', [mod, 'shift'])
  press('B', [mod])
  press('B', [mod, 'isAutoRepeat'])
  await js(`window.__keys = ''; 0`)
  press('F', [mod])
  await wait(200)
  const more = { shortcuts: shortcuts(), keys: await js('window.__keys') }
  // A Mac's Ctrl+K is a text field's own key (delete to the line's end): it stays with the document.
  events.length = 0
  await js(`window.__keys = ''; 0`)
  if (mod === 'meta') press('K', ['control'])
  await wait(200)
  const macControl = { shortcuts: shortcuts(), keys: await js('window.__keys') }
  // The document's own synthetic key presses run nothing of the app.
  events.length = 0
  await js(`for (const o of [{ key: 'k', metaKey: true }, { key: 'k', ctrlKey: true }, { key: 'b', metaKey: true, ctrlKey: true }]) { document.dispatchEvent(new KeyboardEvent('keydown', { ...o, bubbles: true })); document.getElementById('grab').dispatchEvent(new KeyboardEvent('keydown', { ...o, bubbles: true })) } 0`)
  await wait(300)
  result.keys = { afterFind, ownKeys, more, macControl, synthetic: shortcuts(), keyboard: keyboard(), mac: mod === 'meta' }
  // Full screen (the viewer's 「全画面」 is the app page's HTML full screen): Escape in the document leaves it.
  win.webContents.focus()
  await win.webContents.executeJavaScript('document.documentElement.requestFullscreen()', true).catch(() => {})
  await wait(1500)
  const fullScreenBefore = win.isFullScreen()
  doc.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.focus()
  await wait(300)
  doc.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  doc.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await wait(1500)
  result.fullScreen = { before: fullScreenBefore, after: win.isFullScreen(), pageFullScreen: await win.webContents.executeJavaScript('!!document.fullscreenElement'), keyboard: keyboard() }
  // Hidden again (an overlay): hidden, muted, and the keyboard the document had goes back to the app.
  doc.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.focus()
  await wait(300)
  const before = keyboard()
  views.place(doc.viewId, win.webContents.id, null)
  await wait(300)
  result.hiddenAgain = { focusedBefore: before.doc, visible: viewOf(doc.viewId).getVisible(), muted: doc.contents.isAudioMuted(), visibility: await js('document.visibilityState'), keyboard: keyboard() }
  // Zoom and reload: the zoom stays, and the scroll position is kept.
  views.place(doc.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  views.zoom(doc.viewId, win.webContents.id, 2)
  await js('window.scrollTo(0, 600)')
  await reloadSettled(doc.viewId, doc.contents)
  // The load focused the view; the shell judges that focus FOCUS_CHECK_DELAY_MS later (2 s at most here).
  for (let i = 0; i < 40 && !keyboard().app; i++) await wait(50)
  result.reloaded = { zoom: doc.contents.getZoomFactor(), scrollY: await js('window.scrollY'), keyboard: keyboard() }
  views.zoom(doc.viewId, win.webContents.id, 1)
  // The member clicks into the document, then goes back to the app within the click's window; the
  // page reloads itself when it loses the keyboard (a load focuses the view): the app keeps it.
  await js('window.onblur = () => location.reload(); 0')
  doc.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.focus()
  await wait(100)
  const clickedIn = keyboard()
  win.webContents.focus()
  await wait(1000)
  for (let i = 0; i < 50 && doc.contents.isLoading(); i++) await wait(100)
  await wait(300)
  result.backToApp = { clickedIn, after: keyboard() }
  result.hostAPI = await win.webContents.executeJavaScript('typeof window.electronAPI', true)
  result.windowsAfterPopup = BrowserWindow.getAllWindows().length
  // Give preconnect and WebRTC time to try.
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
  // A page of its own with no internet parts: the band's tally starts again (the window hears 0; 2 s at most).
  for (let i = 0; i < 40 && lastCount() !== 0; i++) await wait(50)
  result.blockedAfterOwnPage = blockedEvents.at(-1)
  result.navigations = navigations

  // A link to the web: the page navigating by itself asks nobody; right after the member's click it is
  // handed to the window (which asks the member); the navigation stays refused either way.
  events.length = 0
  await wait(1100)
  await js(`location.href = ${JSON.stringify(`${WEB('nav')}/by-itself`)}`).catch(() => {})
  await wait(400)
  doc.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
  doc.contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
  await js(`location.href = ${JSON.stringify(`${WEB('nav')}/pressed?from=doc`)}`).catch(() => {})
  await wait(400)
  result.links = { events: [...events], stayed: doc.contents.getURL().endsWith('/page2.html') }
  // Another view's page crashes: the window is told (the tab says so instead of an empty area).
  events.length = 0
  if (other) other.contents.forcefullyCrashRenderer()
  await wait(800)
  result.crashEvents = [...events]
  result.otherViewId = other?.viewId ?? null

  // A view closed while it has the keyboard (中身 by ⌘⇧V, the tab closed): the keyboard goes back to the app.
  const third = await open(path.join(folder, 'page2.html'))
  views.place(third.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await wait(300)
  // Give the document the keyboard by a click (as the member does). On a busy CI Mac one click was not
  // always enough (the control below failed twice on PR #796): click again until it holds, at most
  // ~3 s, so the test measures the close, not the click's timing.
  for (let i = 0; i < 10 && !third.contents.isFocused(); i++) {
    third.contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 })
    third.contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 })
    third.contents.focus()
    await wait(300)
  }
  const closedHad = { app: win.webContents.isFocused(), doc: third.contents.isFocused() }
  views.close(third.viewId, win.webContents.id)
  await wait(500)
  result.closedWithKeyboard = { before: closedHad, appAfter: win.webContents.isFocused() }

  // A page whose autofocus field comes after its load (a first frame later than the load, as under
  // CPU load, made certain): reloaded, the member stays where they were scrolled. Then hidden and
  // reloaded twice before it is shown again (it draws no frame meanwhile): still kept.
  const late = await open(path.join(folder, 'late.html'))
  const lateJs = (code: string) => late.contents.executeJavaScript(code, true)
  views.place(late.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await framesDrawn(late.contents)
  await lateJs('window.scrollTo(0, 900)')
  await reloadSettled(late.viewId, late.contents)
  const lateShown = { scrollY: await lateJs('window.scrollY'), focused: await lateJs('document.activeElement && document.activeElement.id') }
  // Hidden, the first reload loads at once, or waits until shown when the throttled page does not
  // answer the read (then the second reload, already waiting, adds no load): two loads or one.
  let finishes = 0
  late.contents.on('did-finish-load', () => { finishes++ })
  views.place(late.viewId, win.webContents.id, null)
  views.reload(late.viewId, win.webContents.id)
  for (let i = 0; i < 100 && finishes === 0; i++) await wait(50)
  const expectedLoads = finishes === 0 ? 1 : 2
  views.reload(late.viewId, win.webContents.id)
  views.place(late.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  for (let i = 0; i < 300 && finishes < expectedLoads; i++) await wait(50)
  if (finishes < expectedLoads) throw new Error('the hidden view did not load again once shown')
  await framesDrawn(late.contents)
  result.lateAutofocus = { shown: lateShown, hiddenTwice: await lateJs('window.scrollY') }
  views.close(late.viewId, win.webContents.id)

  // 中身 and back to 見る: the view left for 中身 is hidden at once and closed; the next open of that
  // document starts where the member was (after its late autofocus too). Another close keeps nothing.
  const firstFinish = (contents: WebContents) => new Promise(resolve => contents.once('did-finish-load', resolve))
  const reading = await open(path.join(folder, 'late.html'))
  views.place(reading.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await framesDrawn(reading.contents)
  await reading.contents.executeJavaScript('window.scrollTo(0, 1200)', true)
  views.close(reading.viewId, win.webContents.id, true)
  const hiddenAtOnce = !viewOf(reading.viewId)?.getVisible()
  const back = await open(path.join(folder, 'late.html'))
  if (back.contents.isLoading()) await firstFinish(back.contents)
  views.place(back.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await framesDrawn(back.contents)
  await framesDrawn(back.contents)
  const backY = await back.contents.executeJavaScript('window.scrollY', true)
  views.close(back.viewId, win.webContents.id)
  const again = await open(path.join(folder, 'late.html'))
  views.place(again.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await framesDrawn(again.contents)
  result.backFromSource = {
    hiddenAtOnce,
    oldGone: !allWebContents.fromId(reading.viewId) || allWebContents.fromId(reading.viewId)!.isDestroyed(),
    oldServed: (await docFrames.serve({ url: reading.url, method: 'GET' })).status,
    scrollY: backY,
    plainCloseThenOpen: await again.contents.executeJavaScript('window.scrollY', true),
  }
  views.close(again.viewId, win.webContents.id)

  // A rich reply's page in the 今日のフォルダ, opened as the chat's card opens it (the same check and grant).
  const aiPage = await open(pagePath)
  views.place(aiPage.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  for (let i = 0; i < 100 && !(await aiPage.contents.executeJavaScript('window.__r', true)); i++) await wait(100)
  result.aiPage = await aiPage.contents.executeJavaScript('window.__r', true)
  views.close(aiPage.viewId, win.webContents.id)
  // Its page goes before the next view is made (a view made at once left one whose close threw on the app's reload).
  await wait(500)

  // Review: the page's synthetic events read nothing; the member's real drag reads the real words,
  // through the piece's own built-ins (the page's replaced ones are never called); the marks draw.
  const reviewed = await open(path.join(folder, 'review.html'))
  views.place(reviewed.viewId, win.webContents.id, { x: 0, y: 0, width: 800, height: 600 })
  await framesDrawn(reviewed.contents)
  views.review(reviewed.viewId, win.webContents.id, { selecting: true, quotes: [{ text: '前年同月比 112%', nth: 0, resolved: false }] })
  events.length = 0
  await wait(1200)
  const selectionsOf = () => events.filter(e => (e as { kind: string }).kind === 'selection')
  const syntheticTries = await reviewed.contents.executeJavaScript('window.__fake = false; window.__synthetic', true)
  const afterSynthetic = selectionsOf().length
  // Where the words are, read in a world of the harness's own (the page replaced the main world's built-ins).
  const box = await reviewed.contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
    const n = document.getElementById('t').firstChild
    const at = n.data.indexOf('前年同月比 112%')
    const r = new Range(); r.setStart(n, at); r.setEnd(n, at + '前年同月比 112%'.length)
    const b = r.getBoundingClientRect()
    return { left: Math.round(b.left) + 1, right: Math.round(b.right) - 1, y: Math.round((b.top + b.bottom) / 2) }
  })()` }]) as { left: number; right: number; y: number }
  reviewed.contents.sendInputEvent({ type: 'mouseDown', x: box.left, y: box.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) reviewed.contents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.left + ((box.right - box.left) * i) / 6), y: box.y, button: 'left', modifiers: ['leftButtonDown'] })
  reviewed.contents.sendInputEvent({ type: 'mouseUp', x: box.right, y: box.y, button: 'left', clickCount: 1 })
  for (let i = 0; i < 40 && selectionsOf().length === afterSynthetic; i++) await wait(50)
  await wait(300)
  result.review = {
    syntheticTries,
    afterSynthetic,
    selections: selectionsOf().slice(afterSynthetic),
    pageHooksCalled: await reviewed.contents.executeJavaScript('window.__called', true),
    marked: await reviewed.contents.executeJavaScript("CSS.highlights.has('acb-review')", true),
    found: await views.findQuote(reviewed.viewId, win.webContents.id, 0),
  }
  views.close(reviewed.viewId, win.webContents.id)

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
  writeResult(result)
  app.exit(0)
}

app.on('window-all-closed', () => {})
app.whenReady().then(run).catch(fail)
