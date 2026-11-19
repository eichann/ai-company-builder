/**
 * 「ブラウザ操作」's window in a real Electron (electron/browser-window.ts; agent-browser.md "The
 * app's window"): the guards only a browser engine can show — what a page can reach, what the
 * member's clicks can open, the `ai`-mode write gate over DevTools Fetch, clearing a login.
 *
 * The sites are local: one HTTPS server on 127.0.0.1 (tests/browser-window-harness/sites.ts) with a
 * self-signed certificate made here by `openssl`, the names mapped to it with Chromium's
 * `host-rules`. Only the harness trusts that certificate, on the test session and for the test
 * hosts (production code never sets a certificate check). Runs where a window can be made: macOS
 * (CI "Client tests 2/2 (macOS)"; .github/scripts/client-tests.mjs), or Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

interface Hit { host: string; method: string; path: string; body: string }
interface Result {
  error?: string
  notificationPermission: string
  geolocation: string
  assetScriptRan: boolean
  pageGlobals: string
  urlAfterClicks: string
  windowsAfterClicks: number
  refusalLog: string[]
  downloads: string[]
  humanPost: number | string
  aiWithoutStep: { fetch: unknown; xhr: unknown; beacon: unknown; websocket: unknown; read: unknown }
  aiApproved: unknown
  aiNotApproved: unknown
  aiOverride: unknown
  aiStopped: unknown
  humanAgain: unknown
  cookiesBefore: number
  closed: boolean
  afterClose: unknown
  cookiesAfter: number
  hits: Hit[]
  evilConnections: number
  udpPackets: number
  partitionInMemory: boolean
  partitionFolders: string[]
  aiWorker: unknown
  clicksNotRun: string[]
  urlDuringClicks: string
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

function makeCertificate(dir: string) {
  const config = path.join(dir, 'cert.cnf')
  fs.writeFileSync(config, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = op.test',
    '[ext]', 'subjectAltName = DNS:op.test, DNS:assets.test, DNS:evil.test, DNS:untrusted.test',
  ].join('\n'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', config], { stdio: 'ignore' })
}

let result: Result

before(async () => {
  if (!canRun) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-browser-window-'))
  makeCertificate(dir)
  const ports = [await freePort(), await freePort(), await freePort()]
  // The `electron` package names its binary (downloaded on first use since Electron 42).
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/browser-window-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', BROWSER_TEST_DIR: dir, BROWSER_TEST_PORTS: ports.join(',') },
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
const hitsTo = (host: string) => result.hits.filter(h => h.host === host)

test('nothing a page or a click does reaches a host the site does not list', { skip }, () => {
  // fetch, XHR, image, beacon, WebSocket, iframe, a redirect to it, window.open, a target=_blank
  // link, a javascript: link, a plain link, a download from it.
  assert.deepEqual(hitsTo('evil.test'), [])
  assert.deepEqual(result.clicksNotRun, [], 'every click ran on the operated page (none led it away)')
  assert.equal(result.urlDuringClicks, 'https://op.test/')
  assert.equal(result.urlAfterClicks, 'https://op.test/')
  assert.equal(result.windowsAfterClicks, 1, 'no popup window was made')
})

test('what the request hook cannot see goes nowhere either: preconnect, reports, WebRTC (STUN, TURN)', { skip }, () => {
  // Not even a TCP connection to evil.test (a preconnect, a NEL report, TURN over TCP open one).
  assert.equal(result.evilConnections, 0)
  assert.equal(result.udpPackets, 0, 'no STUN datagram')
})

test('the login lives in memory only: no session folder on disk', { skip }, () => {
  assert.equal(result.partitionInMemory, true)
  assert.deepEqual(result.partitionFolders.filter(name => /^acb-browser-/i.test(name)), [])
})

test('the window itself refuses popups, navigations and frames off the operated host (not only the request hook)', { skip }, () => {
  const log = result.refusalLog.join('\n')
  assert.match(log, /to evil\.test \(popup\)/)
  assert.match(log, /to evil\.test \(navigation\)/)
  assert.match(log, /to evil\.test \(frame-navigation\)/)
  assert.match(log, /to assets\.test \(frame-navigation\)/, 'an asset host is never a frame')
  assert.match(log, /to permission \(notifications\)/)
})

test('a refusal is logged by host and reason only, never the address\'s path, query or a body', { skip }, () => {
  assert.ok(result.refusalLog.length > 0)
  for (const line of result.refusalLog) assert.match(line, /^\[browser\] refused \d+ request\(s\) to [a-z0-9.-]+ \([a-z:-]+\)$/, line)
  assert.doesNotMatch(result.refusalLog.join('\n'), /secret|\/fetch|\?/)
})

test('an asset host gets only GET of scripts, styles and images (no fetch, frame or POST)', { skip }, () => {
  const paths = [...new Set(hitsTo('assets.test').map(h => `${h.method} ${h.path}`))].sort()
  assert.deepEqual(paths, ['GET /a.css', 'GET /a.js', 'GET /a.png'])
  assert.equal(result.assetScriptRan, true, 'the site still draws itself from its parts host')
})

test('the page gets nothing of the app, no permission and no download', { skip }, () => {
  assert.equal(result.pageGlobals, 'undefined,undefined,undefined')
  assert.equal(result.notificationPermission, 'denied')
  assert.match(result.geolocation, /^denied/)
  assert.deepEqual(result.downloads, [])
  assert.equal(hitsTo('op.test').some(h => h.path === '/plain'), false, 'http is refused')
})

test('in human mode the member\'s own writes to the operated host go out', { skip }, () => {
  assert.equal(result.humanPost, 200)
  assert.equal(result.humanAgain, 200)
})

test('in ai mode no write reaches the operated host without an approving step; reads still do', { skip }, () => {
  const w = result.aiWithoutStep
  assert.equal(w.fetch, 'refused')
  assert.equal(w.xhr, 'refused')
  assert.equal(w.websocket, 'refused')
  assert.equal(w.read, 200)
  const writes = hitsTo('op.test').filter(h => h.method !== 'GET')
  // Only the member's own (human mode) writes and the one approved write arrived: no beacon, form, XHR, WebSocket.
  assert.deepEqual(writes.map(h => `${h.method} ${h.path} ${h.body}`), ['POST /human-save h', 'POST /ai-ok approved', 'POST /human-again h'])
  assert.equal(hitsTo('op.test').some(h => h.method === 'UPGRADE'), false)
  // A dedicated worker's write and the writes sent as the page goes away are refused too.
  assert.equal(result.aiWorker, 'refused')
  assert.equal(hitsTo('op.test').some(h => ['/ai-worker', '/ai-keepalive', '/ai-unload-beacon', '/ai-form', '/ai-beacon'].includes(h.path)), false)
})

test('in ai mode an approved write goes out; another write, a method override or a stopped AI does not', { skip }, () => {
  assert.equal(result.aiApproved, 200)
  assert.equal(result.aiNotApproved, 'refused')
  assert.equal(result.aiOverride, 'refused')
  assert.equal(result.aiStopped, 'refused')
})

test('a window the app closes cannot be kept open by the page, and its session then reaches nowhere; clearing removes its login', { skip }, () => {
  assert.equal(result.closed, true, 'a beforeunload handler did not keep it open')
  assert.equal(result.afterClose, 'refused')
  assert.equal(result.cookiesBefore, 1)
  assert.equal(result.cookiesAfter, 0)
  assert.equal(hitsTo('op.test').some(h => h.path === '/after-close'), false)
})

test('a certificate the system does not trust is refused, never bypassed', { skip }, () => {
  assert.deepEqual(hitsTo('untrusted.test'), [])
})
