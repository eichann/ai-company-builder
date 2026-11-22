/**
 * The HTML viewer's document frame in a real Electron (doc-frame.md): what only a browser engine
 * can show — a document under acb-doc://, in `<iframe sandbox="allow-scripts">`, runs its inline
 * and module scripts and shows the images of its own folder, but reaches no network (fetch, XHR,
 * WebSocket, beacon, web image / script / stylesheet, navigating itself to a web address), no file
 * outside its folder, no storage and nothing of the app (`window.electronAPI`, the parent page).
 * The internet is a local HTTP server that counts what reaches it. Runs where a window can be made:
 * macOS (CI "Client tests 2/2 (macOS)"; .github/scripts/client-tests.mjs), or Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
  url: string
  doc: Record<string, unknown>
  hostAPI: string
  ownProcess: boolean
  afterClose: string[]
  topLevel: string
  hits: string[]
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

let result: Result

before(async () => {
  if (!canRun) return
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-doc-frame-electron-')))
  const port = await freePort()
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/doc-frame-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', DOC_TEST_DIR: dir, DOC_TEST_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)) }, 120_000)
    child.on('exit', () => { clearTimeout(timer); resolve(out + (out.includes('RESULT ') ? '' : `\n${err.slice(-4000)}`)) })
  })
  fs.rmSync(dir, { recursive: true, force: true })
  const line = output.split('\n').find(l => l.startsWith('RESULT '))
  assert.ok(line, `no result from the Electron harness:\n${output}`)
  result = JSON.parse(line.slice('RESULT '.length)) as Result
  assert.equal(result.error, undefined, result.error)
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('nothing a document does reaches the network, its own navigation to the web included', { skip }, () => {
  assert.deepEqual(result.hits, [])
  assert.equal(result.doc.fetchWeb, 'refused')
  assert.equal(result.doc.xhr, 'refused')
  assert.equal(result.doc.websocket, 'refused')
  assert.equal(result.doc.webImage, 'failed')
  assert.equal(result.doc.webScriptRan, false)
  // sendBeacon answers true (queued); the CSP refuses the send itself: `hits` above holds no /beacon.
  // Not even its own folder through fetch: connect-src 'none'.
  assert.equal(result.doc.fetchOwnFolder, 'refused')
})

test('the document runs its scripts and shows images of its own folder, nothing outside it', { skip }, () => {
  assert.equal(result.doc.inlineRan, true)
  assert.equal(result.doc.moduleRan, true, 'a module script of its folder runs (the scheme is corsEnabled)')
  assert.equal(result.doc.sameFolderImage, 'loaded')
  assert.equal(result.doc.dotDotImage, 'failed')
  assert.equal(result.doc.encodedDotDotImage, 'failed')
  assert.equal(result.doc.linkImage, 'failed')
  assert.equal(result.doc.hiddenImage, 'failed')
})

test('the document gets nothing of the app and no storage: opaque origin, no preload, no parent', { skip }, () => {
  assert.equal(result.hostAPI, 'object', 'control: the host page has the preload\'s API')
  assert.equal(result.doc.electronAPI, 'undefined')
  assert.match(String(result.doc.parentAPI), /^threw SecurityError$/)
  assert.match(String(result.doc.parentDocument), /^threw SecurityError$/)
  assert.match(String(result.doc.localStorage), /^threw SecurityError$/)
  assert.match(String(result.doc.cookie), /^threw SecurityError$/)
  assert.match(String(result.doc.indexedDB), /^threw SecurityError$/)
  assert.equal(result.doc.origin, 'null')
  assert.equal(result.ownProcess, true, 'the document runs in a renderer process of its own')
})

test('a closed view\'s address serves nothing; a document opened at the top level is still sandboxed', { skip }, () => {
  assert.ok(result.afterClose.length > 0)
  for (const line of result.afterClose) assert.match(line, /^404 /, line)
  assert.equal(result.topLevel, 'null threw SecurityError')
})
