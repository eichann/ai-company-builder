/**
 * A write run's held page write when the window's DevTools connection goes (agent-browser.md "Writes within frames, in the
 * app"), in a real Electron window against a fictional local HTTPS site (tests/browser-window-harness/write-detach.ts).
 * Chromium lets go of every request paused under DevTools Fetch when the connection goes, past the request hook it already
 * passed: before the fix the page's original then reached the site without a permit (cut before the permit) or after the
 * run's copy (two writes). Whatever the moment and the way it goes, the site gets the permitted copy once or nothing.
 * Runs where a window can be made (macOS in CI, `client-tests.mjs` MACOS).
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
const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

interface Case {
  when: 'before-permit' | 'sending' | 'after-answer'
  how: 'detach' | 'close' | 'reload'
  kind: 'fetch' | 'keepalive' | 'form'
  entered: boolean
  permits: number
  reports: string[]
  copies: number
  originals: number
  records: string[]
  page: unknown
}
interface Result { error?: string; cases: Case[]; uncut: { answer: unknown; copies: number; originals: number; records: string[] } }
let result: Result

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

before(async () => {
  if (!canRun) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-write-detach-'))
  fs.writeFileSync(path.join(dir, 'cert.cnf'), ['[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no', '[dn]', 'CN = op.test', '[ext]', 'subjectAltName = DNS:op.test'].join('\n'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', path.join(dir, 'cert.cnf')], { stdio: 'ignore' })
  const port = await freePort()
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/browser-window-harness/write-detach.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', BROWSER_TEST_DIR: dir, BROWSER_TEST_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { out += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the Electron harness did not finish:\n${out.slice(-4000)}`)) }, 230_000)
    child.on('close', () => { clearTimeout(timer); resolve(out.slice(-4000)) })
  })
  const file = path.join(dir, 'result.json')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
  result = JSON.parse(text) as Result
  assert.equal(result.error, undefined, result.error)
})

const label = (c: Case) => `${c.kind} cut ${c.when} by ${c.how}`

test('whenever and however the window\'s DevTools connection goes, the site gets the permitted copy once or nothing — never the page\'s own original', { skip }, () => {
  assert.equal(result.cases.length, 9)
  for (const c of result.cases) {
    assert.equal(c.entered, true, label(c))
    assert.equal(c.originals, 0, `${label(c)}: the page's original reached the site (${JSON.stringify(c)})`)
    assert.ok(c.copies <= 1, `${label(c)}: two copies`)
    if (c.copies === 1) assert.ok(c.permits >= 1, `${label(c)}: a copy without a permit`)
  }
})

test('cut before the permit nothing reaches the site, and the write is said not sent (no original can have gone)', { skip }, () => {
  for (const c of result.cases.filter(x => x.when === 'before-permit')) {
    assert.equal(c.copies + c.originals, 0, label(c))
    assert.deepEqual(c.records, ['not-sent'], label(c))
    // A permit already given is reported not sent (the server's unit is used; nothing reached the site).
    assert.deepEqual(c.reports, ['not_sent'], label(c))
  }
})

test('a write never says "not sent" when it reached the site, and a copy cut on its way keeps its own result', { skip }, () => {
  for (const c of result.cases) {
    if (c.copies > 0) assert.notEqual(c.records[0], 'not-sent', label(c))
  }
  const sending = result.cases.find(c => c.when === 'sending' && c.how === 'detach' && c.kind === 'fetch')!
  assert.deepEqual(sending.records, ['done'], 'the copy answered after the cut is done, not unknown')
  assert.deepEqual(sending.reports, ['done'])
})

test('uncut, the page still gets the site\'s answer through its held write (its flow goes on)', { skip }, () => {
  assert.deepEqual(result.uncut.answer, { status: 201, body: { id: 7, name: `w${result.cases.length}` } })
  assert.equal(result.uncut.copies, 1)
  assert.equal(result.uncut.originals, 0)
  assert.deepEqual(result.uncut.records, ['done'])
})
