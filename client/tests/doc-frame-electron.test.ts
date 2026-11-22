/**
 * The HTML viewer's document view in a real Electron (doc-frame.md): what only a browser engine can
 * show. A document, in a view of its own on the in-memory document session, runs its inline and
 * module scripts and shows the images of its own folder, but reaches no network — fetch, XHR,
 * WebSocket, beacon, web image / script / stylesheet, and also what no request hook sees
 * (preconnect, preload, prefetch, DNS prefetch, a report, STUN, TURN over TCP with a secret in its
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
  hits: string[]
  connections: Record<string, number>
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
  for (const name of ['web', 'preconnect', 'preload', 'prefetch', 'dnsprefetch', 'turn', 'report']) ports[name] = await freePort()
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
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)) }, 130_000)
    child.on('exit', () => { clearTimeout(timer); resolve(out + (out.includes('RESULT ') ? '' : `\n${err.slice(-4000)}`)) })
  })
  fs.rmSync(dir, { recursive: true, force: true })
  const line = output.split('\n').find(l => l.startsWith('RESULT '))
  assert.ok(line, `no result from the Electron harness:\n${output}`)
  result = JSON.parse(line.slice('RESULT '.length)) as Result
  assert.equal(result.error, undefined, result.error)
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('nothing a document does reaches the network: requests, its own navigation, preconnect, preload, reports, STUN, TURN', { skip }, () => {
  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.connections, {}, 'not even a TCP connection or a UDP datagram')
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

test('the app\'s page reloading closes its document views and revokes their grants', { skip }, () => {
  assert.deepEqual(result.afterReload, { viewGone: true, served: 404 })
})
