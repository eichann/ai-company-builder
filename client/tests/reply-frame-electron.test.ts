/**
 * A rich reply's frame in a real Electron (chat-ui-and-history.md "Rich replies: the reply's closed frame"): main's
 * backstop. A frame showing a srcdoc never navigates away from it, even through a link the renderer's guards would
 * have missed, because `keepAppPageInWindow` refuses it (`will-frame-navigate`, client/shared/srcdoc-frames.ts) —
 * the page would arrive without the frame's policy. A new srcdoc from the app still loads. The same window without
 * that guard does navigate (the check can fail). The web is a local listener that counts what reaches it. Runs where
 * a window can be made: macOS (CI "Client tests 2/2 (macOS)"), or Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, stopWithTempDirs } from '../../shared/testing/temp-dirs'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

interface Run { frameAfterPress: string | null; newReplyLoaded: boolean; frameAfterNewReply: string | null; pageStayed: boolean }
let result: { guarded: Run; unguarded: Run }
const reached: string[] = []

before(async () => {
  if (!canRun) return
  const server = http.createServer((req, res) => { reached.push(req.url ?? ''); res.end('<p>外のページ</p>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const dir = fs.realpathSync(makeTempDir('acb-reply-frame-electron-'))
  const electron = createRequire(import.meta.url)('electron') as string
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(electron, [path.join(clientDir, 'tests/reply-frame-electron-harness/main.ts')], {
        cwd: clientDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', REPLY_FRAME_TEST_DIR: dir, REPLY_FRAME_TARGET: `http://127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      stopWithTempDirs(child)
      let out = ''
      let err = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      // On a timeout the child is killed and its end awaited before failing (`shared/testing/temp-dirs.ts`).
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120_000)
      child.on('close', () => { clearTimeout(timer); if (timedOut) reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)); else resolve(`${out}\n${err.slice(-4000)}`) })
    })
    const resultFile = path.join(dir, 'result.json')
    const text = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null
    assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
    const read = JSON.parse(text) as typeof result & { error?: string }
    assert.equal(read.error, undefined, read.error)
    result = read
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    server.close()
  }
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('a link in a reply\'s frame that would move the frame is refused by main: the frame stays on its reply, nothing reached', { skip }, () => {
  assert.equal(result.guarded.frameAfterPress, 'about:srcdoc')
  assert.deepEqual(reached.filter(url => url.startsWith('/guarded')), [])
  assert.equal(result.guarded.pageStayed, true)
})

test('the app still gives the frame its next reply (a new srcdoc loads under the guard)', { skip }, () => {
  assert.equal(result.guarded.newReplyLoaded, true)
  assert.equal(result.guarded.frameAfterNewReply, 'about:srcdoc')
})

test('without the guard the same press does move the frame: the check above can fail', { skip }, () => {
  assert.deepEqual(reached.filter(url => url.startsWith('/unguarded')), ['/unguarded'])
  assert.match(result.unguarded.frameAfterPress ?? '', /^http:\/\/127\.0\.0\.1:\d+\/unguarded$/)
})
