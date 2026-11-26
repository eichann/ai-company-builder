/**
 * ACB's player over a document's Google Drive embeds in a real Electron (doc-frame.md "ACB's player over
 * Drive embeds (plan 4)"): through the app's real scheme registration, document view and player shell,
 * against a local fake of the server's stream route. A player goes exactly over each embed main read
 * from the document (following the document's scroll and zoom, cut by the area's edge), none over an
 * element the document's script made, all hidden with the document; ［ここで再生］ picks the video when
 * the server says it is not picked, then a `<video>` in the player plays and seeks through
 * `acb-drive-video://` (206 answers, the member's session, the server's chunks joined into the range
 * the player asked); another player's page cannot reach that video; closing the document aborts a
 * player's stream on the server. A second run without the scheme's `standard` privilege shows it is
 * what lets the video seek. Runs where a window can be made: macOS (CI "Client tests 2/2 (macOS)"), or
 * Linux with a display.
 */
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

type Bounds = { x: number; y: number; width: number; height: number }
interface Result {
  error?: string
  placedAtZoom1: Bounds[]
  placedScrolled: Bounds[]
  placedAtZoom15: Bounds[]
  placedCut: Bounds[]
  playerCount: number
  playerUrls: string[]
  hiddenWithDocument: boolean[]
  keyboardBeforePress: { app: boolean; player: boolean; doc: boolean; windowFocused: boolean }
  picks: string[]
  played: { ok: boolean; duration?: number; at?: number; page?: string }
  streamRequests: Array<{ range: string | null; status: number; cookie: string | null }>
  otherPlayerReach: string
  otherPlayerServerRequests: number
  bStreamingBeforeClose: boolean
  bClosedEarly: boolean
  playersAfterClose: number
  countsAfterClose: { players: number; streams: number }
}

async function runHarness(scheme?: object): Promise<Result> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-doc-player-electron-')))
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/doc-player-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', PLAYER_TEST_DIR: dir, ...(scheme ? { PLAYER_TEST_SCHEME: JSON.stringify(scheme) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)) }, 150_000)
    child.on('close', () => { clearTimeout(timer); resolve(`${out}\n${err.slice(-4000)}`) })
  })
  const resultFile = path.join(dir, 'result.json')
  const text = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
  const result = JSON.parse(text) as Result
  assert.equal(result.error, undefined, result.error)
  return result
}

let result: Result
let withoutStandard: Result

before(async () => {
  if (!canRun) return
  result = await runHarness()
  withoutStandard = await runHarness({ secure: true })
})

const skip = canRun ? false : 'needs a window (macOS, or Linux with a display)'

test('a player goes exactly over each Drive embed main read, following the document\'s scroll and zoom, cut by the area', { skip }, () => {
  // The area at (20, 30); the iframe at (100, 200) 320×180, the <video><source> at (460, 400) 240×135.
  assert.deepEqual(result.placedAtZoom1, [{ x: 120, y: 230, width: 320, height: 180 }, { x: 480, y: 430, width: 240, height: 135 }])
  assert.deepEqual(result.placedScrolled, [{ x: 120, y: 130, width: 320, height: 180 }, { x: 480, y: 330, width: 240, height: 135 }], 'scrolled by 100 px')
  assert.deepEqual(result.placedAtZoom15, [{ x: 170, y: 330, width: 480, height: 270 }], 'the document at 150 %: the second embed is below the area now')
  assert.deepEqual(result.placedCut, [{ x: 120, y: 230, width: 320, height: 100 }], 'the area 300 px high: only the part inside it')
  assert.equal(result.playerCount, 2, 'none over the iframe the document\'s script made (an id main never read)')
  assert.deepEqual(result.playerUrls, ['acb-drive-video://<token>/?v=1', 'acb-drive-video://<token>/?v=1'])
})

test('the players hide with the document (an overlay of the app)', { skip }, () => {
  assert.deepEqual(result.hiddenWithDocument, [false, false])
})

test('loading the players never takes the keyboard from the app', { skip }, t => {
  // The window must hold the system's focus to measure this: on a computer where another app took it back
  // (a developer's busy desktop), say so rather than pass without measuring. CI's runner keeps it.
  if (!result.keyboardBeforePress.windowFocused) { t.skip('the window did not keep the focus on this computer'); return }
  assert.deepEqual(result.keyboardBeforePress, { app: true, player: false, doc: false, windowFocused: true })
})

test('［ここで再生］: not picked → the Picker, then the video plays and seeks through the scheme, 206 by 206 with the member\'s session', { skip }, () => {
  assert.deepEqual(result.picks, ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'])
  assert.deepEqual(result.played, { ok: true, duration: 1, at: 0.8 })
  const [refused, probe, ...ranges] = result.streamRequests
  assert.deepEqual([refused.status, probe.status], [403, 206], 'not picked, then picked')
  // The server answers 512 KB at most per request; the index is 3 MB past the start: main joined the
  // server's chunks (each its own request) into the ranges the player asked, or the player sought there.
  assert.ok(ranges.length >= 3, JSON.stringify(ranges))
  assert.ok(ranges.every(r => r.status === 206 && r.cookie === 'session=member' && /^bytes=\d+-\d*$/.test(r.range ?? '')), JSON.stringify(ranges))
  assert.ok(ranges.some(r => Number(/^bytes=(\d+)/.exec(r.range ?? '')?.[1]) >= 3 * 1024 * 1024), 'the bytes near the end (the index) were asked for')
})

test('another player\'s page cannot reach a player\'s video', { skip }, () => {
  assert.equal(result.otherPlayerReach, 'refused')
  assert.equal(result.otherPlayerServerRequests, 0)
})

test('closing the document closes its players and aborts a stream on the server', { skip }, () => {
  assert.equal(result.bStreamingBeforeClose, true, 'control: B was streaming')
  assert.equal(result.bClosedEarly, true)
  assert.equal(result.playersAfterClose, 0)
  assert.deepEqual(result.countsAfterClose, { players: 0, streams: 0 })
})

test('without the scheme\'s `standard` privilege the video never gets past its first range', { skip }, () => {
  assert.equal(withoutStandard.played.ok, false)
  assert.equal(result.played.ok, true, 'control')
})
