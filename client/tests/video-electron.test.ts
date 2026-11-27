/**
 * Company videos in a real Electron (files-and-editor.md "Videos"): what only Chromium's media
 * player can show. Through the app's own scheme registration and handlers and under the app page's
 * CSP, a video whose index sits 3 MB past its start (as cameras write `.mov`) gets its duration and
 * seeks — which needs a standard scheme answering byte ranges —, a VP9 `.mp4` plays, a ProRes
 * `.mov` fails as "not supported" (the editor then offers 「ほかのアプリで開く」), and a video outside
 * the company folder, or reached through a link out of it, never plays. Runs where a window can be
 * made: macOS (CI "Client tests 2/2 (macOS)"), or Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, stopWithTempDirs } from '../../shared/testing/temp-dirs'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

interface Played { ok: boolean; duration?: number; at?: number; paused?: boolean; code?: number; timeout?: boolean }
let videos: Record<string, Played>

before(async () => {
  if (!canRun) return
  const dir = fs.realpathSync(makeTempDir('acb-video-electron-'))
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/video-electron-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', VIDEO_TEST_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stopWithTempDirs(child)
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    // On a timeout the child is killed and its end awaited before failing, so the folder it writes in can be
    // removed after it (`shared/testing/temp-dirs.ts`).
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 120_000)
    child.on('close', () => { clearTimeout(timer); if (timedOut) reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)); else resolve(`${out}\n${err.slice(-4000)}`) })
  })
  const resultFile = path.join(dir, 'result.json')
  const text = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
  const result = JSON.parse(text) as { error?: string; videos: Record<string, Played> }
  assert.equal(result.error, undefined, result.error)
  videos = result.videos
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('a video whose index is at its end gets its length and seeks: the scheme answers byte ranges, under the app page\'s CSP', { skip }, () => {
  const v = videos.indexAtEnd
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.duration, 1)
  assert.ok(Math.abs((v.at ?? 0) - 0.8) < 0.05, JSON.stringify(v))
  assert.equal(v.paused, true, 'nothing plays by itself')
  assert.equal(videos.vp9.ok, true, JSON.stringify(videos.vp9))
})

test('a codec Chromium lacks (ProRes) fails as not supported, so the editor can offer another app', { skip }, () => {
  assert.deepEqual(videos.prores, { ok: false, code: 4 })
})

test('a video outside the company folder, or through a link leading out of it, never plays', { skip }, () => {
  assert.equal(videos.outside.ok, false)
  assert.equal(videos.linkOut.ok, false)
})
