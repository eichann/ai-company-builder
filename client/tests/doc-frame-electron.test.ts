/**
 * The HTML viewer's document view in a real Electron (doc-frame.md): what only a browser engine can
 * show. A document, in a view of its own on the in-memory document session, runs its inline and
 * module scripts and shows the images of its own folder, but reaches no network — https / wss
 * fetch, XHR, WebSocket, beacon, web image / script / stylesheet, and also what no request hook sees
 * (preconnect, preload, prefetch, DNS prefetch, STUN, TURN over TCP with a secret in its
 * user name) —, no file outside its folder, no storage and nothing of the app; it navigates only to
 * a page of its own grant (never `data:`, `local-file:`, `file:`, `acb-plugin:`, another document's
 * token or the web); the app's reload closes it and revokes its grant. The internet is local
 * listeners that count what reaches them. Runs where a window can be made: macOS (CI "Client tests
 * 2/2 (macOS)"; .github/scripts/client-tests.mjs), or Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

interface Result {
  error?: string
  doc: Record<string, unknown>
  hostAPI: string
  windowsAfterPopup: number
  session: Record<string, boolean>
  navigations: Record<string, string>
  afterReload: { viewGone: boolean; served: number }
  partitionFolders: string[]
  connections: Record<string, number>
  hidden: { muted: boolean; visibility: string }
  firstOpenWithoutProxy: number | null
  focusWhileHidden: { app: boolean; doc: boolean }
  shown: { bounds: Record<string, number>; visible: boolean; muted: boolean; visibility: string; keyboard: { app: boolean; doc: boolean } }
  otherWindowPlace: Record<string, number>
  focusAfterClick: { app: boolean; doc: boolean }
  fullScreen: { before: boolean; after: boolean; pageFullScreen: boolean; keyboard: { app: boolean; doc: boolean } }
  hiddenAgain: { focusedBefore: boolean; visible: boolean; muted: boolean; visibility: string; keyboard: { app: boolean; doc: boolean } }
  reloaded: { zoom: number; scrollY: number; keyboard: { app: boolean; doc: boolean } }
  lateAutofocus: { shown: { scrollY: number; focused: string }; hiddenTwice: number }
  backFromSource: { hiddenAtOnce: boolean; oldGone: boolean; oldServed: number; scrollY: number; plainCloseThenOpen: number }
  backToApp: { clickedIn: { app: boolean; doc: boolean }; after: { app: boolean; doc: boolean } }
  links: { events: unknown[]; stayed: boolean }
  crashEvents: unknown[]
  review: { syntheticTries: number; afterSynthetic: number; selections: unknown[]; pageHooksCalled: string[]; marked: boolean; found: string }
  otherViewId: number | null
  keys: {
    afterFind: { shortcuts: string[]; keys: string }
    ownKeys: { shortcuts: string[]; keys: string; typed: string }
    more: { shortcuts: string[]; keys: string }
    macControl: { shortcuts: string[]; keys: string }
    synthetic: string[]
    keyboard: { app: boolean; doc: boolean }
    mac: boolean
  }
  closedWithKeyboard: { before: { app: boolean; doc: boolean }; appAfter: boolean }
  blocked: Array<{ viewId: number; kind: string; count: number; hosts: string[]; hostCount: number }>
  blockedGaps: number[]
  blockedAfterOwnPage: { viewId: number; kind: string; count: number; hosts: string[]; hostCount: number } | undefined
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function freeUdpPort(): Promise<number> {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}

let result: Result

before(async () => {
  if (!canRun) return
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-doc-frame-electron-')))
  const ports: Record<string, number> = { stun: await freeUdpPort() }
  for (const name of ['fetch', 'xhr', 'ws', 'beacon', 'img', 'script', 'style', 'nav', 'popup', 'preconnect', 'preload', 'prefetch', 'dnsprefetch', 'turn']) ports[name] = await freePort()
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/doc-frame-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', DOC_TEST_DIR: dir, DOC_TEST_PORTS: JSON.stringify(ports) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)) }, 180_000)
    // `close`: the process exited and its output streams ended; the result file was renamed into place before.
    child.on('close', () => { clearTimeout(timer); resolve(`${out}\n${err.slice(-4000)}`) })
  })
  const resultFile = path.join(dir, 'result.json')
  const text = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
  result = JSON.parse(text) as Result
  assert.equal(result.error, undefined, result.error)
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('nothing a document does reaches the network: requests, its own navigation, preconnect, preload, STUN, TURN', { skip }, () => {
  assert.deepEqual(result.connections, {}, 'not even a TCP connection (https / wss) or a UDP datagram')
  assert.equal(result.doc.fetchWeb, 'refused')
  assert.equal(result.doc.xhr, 'refused')
  assert.equal(result.doc.websocket, 'refused')
  assert.equal(result.doc.webImage, 'failed')
  assert.equal(result.doc.webScriptRan, false)
  // Not even its own folder through fetch: connect-src 'none'.
  assert.equal(result.doc.fetchOwnFolder, 'refused')
})

test('the document runs its scripts and shows images of its own folder, nothing outside it', { skip }, () => {
  assert.equal(result.doc.inlineRan, true)
  assert.equal(result.doc.moduleRan, true, 'a module script of its folder runs (the scheme is corsEnabled)')
  assert.equal(result.doc.sameFolderImage, 'loaded')
  for (const probe of ['dotDotImage', 'encodedDotDotImage', 'linkImage', 'hiddenImage', 'localFileImage', 'fileImage']) assert.equal(result.doc[probe], 'failed', probe)
})

test('the document gets nothing of the app and no storage: its own session, opaque origin, no preload, no popup', { skip }, () => {
  assert.equal(result.hostAPI, 'object', 'control: the app\'s page has the preload\'s API')
  assert.equal(result.doc.electronAPI, 'undefined')
  assert.equal(result.doc.nodeGlobals, 'undefined,undefined')
  assert.match(String(result.doc.localStorage), /^threw SecurityError$/)
  assert.match(String(result.doc.cookie), /^threw SecurityError$/)
  assert.match(String(result.doc.indexedDB), /^threw SecurityError$/)
  assert.equal(result.doc.origin, 'null')
  assert.equal(result.doc.popup, 'null')
  assert.equal(result.windowsAfterPopup, 1)
})

test('documents live on an in-memory session of their own, which alone serves acb-doc and none of the app\'s schemes', { skip }, () => {
  assert.deepEqual(result.session, {
    persistent: false, docHandled: true, localFileHandled: false, pluginHandled: false, defaultServesDoc: false, viewPartitionIsDoc: true,
  })
  assert.deepEqual(result.partitionFolders.filter(name => /acb-doc/i.test(name)), [])
})

test('a document navigates only to a page of its own grant: never data:, local-file:, file:, acb-plugin:, another token or the web', { skip }, () => {
  const { ownPage, ...refused } = result.navigations
  assert.deepEqual(refused, { data: 'stayed', localFile: 'stayed', file: 'stayed', plugin: 'stayed', otherToken: 'stayed', web: 'stayed', ownCss: 'stayed' })
  assert.equal(ownPage, 'moved', 'control: a page of its own grant')
})

test('until the viewer shows it the view is hidden and muted; a session that could not be prepared is tried again', { skip }, () => {
  assert.deepEqual(result.hidden, { muted: true, visibility: 'hidden' })
  assert.equal(result.firstOpenWithoutProxy, null, 'no view while the proxy cannot be set')
  assert.equal(result.doc.inlineRan, true, 'the next open prepared the session and showed the document')
})

test('the app\'s page reloading closes its document views and revokes their grants', { skip }, () => {
  assert.deepEqual(result.afterReload, { viewGone: true, served: 404 })
})

test('a document never takes the keyboard by itself (its load, focus(), autofocus), hidden or shown; a click gives it the keyboard', { skip }, () => {
  assert.deepEqual(result.focusWhileHidden, { app: true, doc: false }, 'loading focuses a view (Electron 45): the keyboard goes back to the app')
  assert.deepEqual(result.shown.keyboard, { app: true, doc: false }, 'shown, its focus() calls do not take the keyboard either')
  assert.deepEqual(result.focusAfterClick, { app: false, doc: true }, 'control: the member clicked into it')
})

test('a click into the document no longer counts once the member went back to the app: a reload on blur takes nothing', { skip }, () => {
  assert.deepEqual(result.backToApp.clickedIn, { app: false, doc: true }, 'control: the click gave it the keyboard')
  assert.deepEqual(result.backToApp.after, { app: true, doc: false })
})

test('shown over its tab: placed at the app page\'s zoom, visible and unmuted; another window cannot move it', { skip }, () => {
  assert.deepEqual(result.shown.bounds, { x: 50, y: 38, width: 500, height: 375 }, 'CSS px × the app page zoom 1.25')
  assert.deepEqual([result.shown.visible, result.shown.muted, result.shown.visibility], [true, false, 'visible'])
  assert.deepEqual(result.otherWindowPlace, result.shown.bounds)
})

test('hidden again (an overlay, another tab): hidden, muted, and the keyboard the document had goes back to the app', { skip }, () => {
  assert.equal(result.hiddenAgain.focusedBefore, true, 'control: the document had the keyboard')
  assert.deepEqual({ ...result.hiddenAgain, focusedBefore: undefined }, { focusedBefore: undefined, visible: false, muted: true, visibility: 'hidden', keyboard: { app: true, doc: false } })
})

test('Escape in a document shown full screen leaves full screen and gives the keyboard back to the app', { skip }, () => {
  assert.equal(result.fullScreen.before, true, 'control: the app page went full screen')
  assert.deepEqual({ after: result.fullScreen.after, page: result.fullScreen.pageFullScreen, keyboard: result.fullScreen.keyboard }, { after: false, page: false, keyboard: { app: true, doc: false } })
})

test('reloading after the file changed keeps the document\'s zoom and scroll position', { skip }, () => {
  assert.equal(result.reloaded.zoom, 2)
  assert.equal(result.reloaded.scrollY, 600)
  assert.deepEqual(result.reloaded.keyboard, { app: true, doc: false }, 'the reload does not take the keyboard')
  assert.equal(result.lateAutofocus.shown.focused, 'late', 'control: the page focused its autofocus field after the load')
  assert.equal(result.lateAutofocus.shown.scrollY, 900, 'put back after the page\'s first frame, not scrolled back to its autofocus field')
  assert.equal(result.lateAutofocus.hiddenTwice, 900, 'reloaded twice while hidden (no frame drawn): the position not yet put back is kept')
})

test('left for 中身 and back to 見る, the document opens where the member was reading; another close keeps nothing', { skip }, () => {
  const b = result.backFromSource
  assert.equal(b.hiddenAtOnce, true, 'out of sight at once: the tab shows 中身')
  assert.deepEqual({ gone: b.oldGone, served: b.oldServed }, { gone: true, served: 404 }, 'the view and its grant go')
  assert.equal(b.scrollY, 1200)
  assert.equal(b.plainCloseThenOpen, 0, 'control: a plain close (another tab) starts from the top')
})

test('a link to the web is handed to the window only right after the member pressed something; the page never leaves', { skip }, () => {
  assert.deepEqual(result.links.events, [{ viewId: result.links.events.length ? (result.links.events[0] as { viewId: number }).viewId : -1, kind: 'link', url: 'https://nav.test/pressed?from=doc' }])
  assert.equal(result.links.stayed, true)
  assert.deepEqual(result.crashEvents, [{ viewId: result.otherViewId, kind: 'gone' }])
})

test('the app\'s shortcuts reach the app while the document has the keyboard; its own keys and typing stay with it', { skip }, () => {
  const k = result.keys
  assert.deepEqual(k.afterFind, { shortcuts: ['mod+k'], keys: '' }, '⌘K goes to the app (palette), not to the document')
  assert.deepEqual(k.ownKeys.shortcuts, [], 'arrows, letters and Space are the document\'s')
  assert.equal(k.ownKeys.keys, 'ArrowRighta ')
  assert.equal(k.ownKeys.typed, 'a ', 'typing into its own input stays there')
  assert.deepEqual(k.more, { shortcuts: ['mod+shift+v', 'mod+b'], keys: 'f' }, '⌘⇧V (見る｜中身) and ⌘B too; a held key repeats nothing; ⌘F stays the document\'s')
  if (k.mac) assert.deepEqual(k.macControl, { shortcuts: [], keys: 'k' }, 'a Mac\'s Ctrl+K is the document\'s text key')
  assert.deepEqual(k.synthetic, [], 'a document\'s synthetic KeyboardEvent runs nothing of the app')
  assert.deepEqual(k.keyboard, { app: false, doc: true }, 'control: the document had the keyboard all along')
})

test('a view closed while it has the keyboard (中身, the tab closed) gives the keyboard back to the app', { skip }, () => {
  assert.deepEqual(result.closedWithKeyboard.before, { app: false, doc: true }, 'control: the document had the keyboard')
  assert.equal(result.closedWithKeyboard.appAfter, true)
})

test('what a document wanted from the internet reaches the window as hosts and a count only: distinct, capped, a few events, nothing connects', { skip }, () => {
  assert.deepEqual(result.connections, {}, 'reporting loads nothing')
  const last = result.blocked.at(-1)!
  assert.ok(last, 'the window was told')
  // style + script (in the HTML), preload, prefetch, fetch, XHR, WebSocket, beacon, image; the image with a
  // secret path and query once (asked twice); 30 more hosts.
  assert.equal(last.count, 40)
  assert.equal(last.hosts.length, 20, 'at most DOC_BLOCKED_HOSTS_MAX hosts')
  assert.equal(new Set(last.hosts).size, last.hosts.length, 'each host once')
  assert.equal(last.hostCount, 39, '9 hosts and 30 more, counted past the named ones')
  for (const host of ['style.test', 'script.test', 'fetch.test', 'xhr.test', 'ws.test', 'beacon.test', 'img.test']) assert.ok(last.hosts.includes(host), host)
  // Never a path, a query or a scheme: an address can carry what the page holds.
  assert.doesNotMatch(JSON.stringify(result.blocked), /secret|\/|\?|https|wss/)
  // How many events depends on how long the page takes to ask (longer on a busy computer); the gaps do not.
  assert.ok(result.blockedGaps.every(gap => gap >= 450), `told at most every BLOCKED_INTERVAL_MS, not per request (gaps ${result.blockedGaps.map(Math.round).join(', ')} ms)`)
  assert.ok(result.blocked.every(e => e.viewId === last.viewId && e.kind === 'blocked'))
})

test('a new page of the document starts the tally again: the window hears 0 when it wants nothing', { skip }, () => {
  assert.deepEqual(result.blockedAfterOwnPage, { viewId: result.blocked.at(-1)!.viewId, kind: 'blocked', count: 0, hosts: [], hostCount: 0 })
})

test('review: the page\'s synthetic events read nothing; the member\'s drag reads the real words through the app\'s own piece, which the page cannot reach', { skip }, () => {
  assert.ok(result.review.syntheticTries > 10, 'the page kept selecting and firing mouse-up / Shift key-up events')
  assert.equal(result.review.afterSynthetic, 0, 'no selection read from a synthetic event')
  assert.equal(result.review.selections.length, 1)
  assert.deepEqual((result.review.selections[0] as { quote: { text: string } }).quote.text, '前年同月比 112%', 'the real words, not the page\'s FAKE')
  assert.deepEqual(result.review.pageHooksCalled, [], 'the piece never used the built-ins the page replaced (its own world)')
  assert.equal(result.review.marked, true, 'the comment\'s mark is drawn')
  assert.equal(result.review.found, 'shown')
})
