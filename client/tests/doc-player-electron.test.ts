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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, stopWithTempDirs } from '../../shared/testing/temp-dirs'

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const canRun = process.platform === 'darwin' || (process.platform === 'linux' && !!process.env.DISPLAY)

type Bounds = { x: number; y: number; width: number; height: number }
interface Result {
  error?: string
  placedAtZoom1: Bounds[]
  placedScrolled: Bounds[]
  placedAtZoom15: Bounds[]
  placedCut: Bounds[]
  blockedTold: Array<{ count: number; hosts: string[] }>
  playerCount: number
  playerUrls: string[]
  hiddenWithDocument: boolean[]
  keyboardBeforePress: { app: boolean; player: boolean; doc: boolean; windowFocused: boolean }
  keyboardAfterLoads: { app: boolean; player: boolean; windowFocused: boolean }
  picks: string[]
  played: { ok: boolean; duration?: number; at?: number; page?: string }
  streamRequests: Array<{ range: string | null; status: number; cookie: string | null }>
  otherPlayerReach: string
  otherPlayerServerRequests: number
  bStreamingBeforeClose: boolean
  whileHidden: { video: boolean; text: string }
  resumed: { src: string; at: number }
  navigationStayed: boolean
  popup: string
  windowsAfterPopup: number
  permission: string
  redirectFollowed: boolean
  sessionFetch: string
  sessionFetchReached: number
  schemeServedOn: { player: boolean; document: boolean; app: boolean }
  overlayOnTop: boolean
  bRanges: string[]
  bAfterCuts: { error?: number | null; buffered?: number; page?: string }
  bClosedEarly: boolean
  playersAfterClose: number
  countsAfterClose: { players: number; streams: number }
}

async function runHarness(scheme?: object): Promise<Result> {
  const dir = fs.realpathSync(makeTempDir('acb-doc-player-electron-'))
  const electron = createRequire(import.meta.url)('electron') as string
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(clientDir, 'tests/doc-player-harness/main.ts')], {
      cwd: clientDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '--import tsx', PLAYER_TEST_DIR: dir, ...(scheme ? { PLAYER_TEST_SCHEME: JSON.stringify(scheme) } : {}) },
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
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 150_000)
    child.on('close', () => { clearTimeout(timer); if (timedOut) reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)); else resolve(`${out}\n${err.slice(-4000)}`) })
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

test('the band counts none of the document\'s Drive embeds (Chromium reports a refused frame as `https://drive.google.com` alone, before main has read the document); another host still counts', { skip }, () => {
  // Refused by the CSP: the page's own embeds (A, B's <source>, C), the script's iframe (another id: Chromium's
  // report cannot tell it from the others) and an image from cdn.example — only the image is a missing part.
  const told = result.blockedTold
  assert.deepEqual(told.at(-1), { count: 1, hosts: ['cdn.example'] }, JSON.stringify(told))
  assert.ok(told.every(t => !t.hosts.includes('drive.google.com')), `never Drive on the way either: ${JSON.stringify(told)}`)
})

test('the players hide with the document (an overlay of the app)', { skip }, () => {
  assert.deepEqual(result.hiddenWithDocument, [false, false])
})

test('loading the players never takes the keyboard from the app', { skip }, t => {
  // The window must hold the system's focus to measure this: on a developer's computer where another app
  // took it back, say so rather than pass without measuring. On CI it must be measured.
  if (!(result.keyboardBeforePress.windowFocused && result.keyboardAfterLoads.windowFocused) && !process.env.CI) { t.skip('the window did not keep the focus on this computer'); return }
  assert.deepEqual(result.keyboardBeforePress, { app: true, player: false, doc: false, windowFocused: true })
  assert.deepEqual(result.keyboardAfterLoads, { app: true, player: false, windowFocused: true }, 'its pages loaded again while shown took nothing either')
})

test('［ここで再生］: not picked → the Picker, then the video plays and seeks through the scheme, 206 by 206 with the member\'s session', { skip }, () => {
  assert.deepEqual(result.picks, ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'])
  assert.deepEqual(result.played, { ok: true, duration: 1, at: 0.8 })
  const [refused, probe, ...ranges] = result.streamRequests
  assert.deepEqual([refused.status, probe.status], [403, 206], 'not picked, then picked')
  // The server answers 512 KB at most per request; the index is 3 MB past the start: main joined the
  // server's chunks (each its own request) into the ranges the player asked, or the player sought there.
  // How many ranges Chromium asks depends on timing (CI's macOS runners asked 2: the start and the index),
  // so only the start and a range near the end are required.
  assert.ok(ranges.length >= 2, JSON.stringify(ranges))
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

test('hidden while it plays: paused and stopped (nothing plays unseen); ［続きから再生］ goes on from where it was', { skip }, () => {
  assert.equal(result.whileHidden.video, false)
  assert.match(result.whileHidden.text, /一時停止しました/)
  assert.equal(result.resumed.src, 'video#t=0.5')
  // Read after it resumed: it may already have played on a little (CI's runners measured 0.61), but it never
  // starts again from the beginning.
  assert.ok(result.resumed.at >= 0.45 && result.resumed.at <= 1, JSON.stringify(result.resumed))
})

test('the player\'s own guards: only its own page, no popup, no redirect, no permission; its session lets out nothing else and alone serves the scheme', { skip }, () => {
  assert.equal(result.navigationStayed, true, 'another player\'s page, the web, data:, a local address')
  assert.deepEqual([result.popup, result.windowsAfterPopup], ['null', 0])
  assert.equal(result.redirectFollowed, false)
  assert.equal(result.permission, 'denied')
  assert.deepEqual([result.sessionFetch, result.sessionFetchReached], ['refused', 0])
  assert.deepEqual(result.schemeServedOn, { player: true, document: false, app: false })
})

test('a player over the area stays above an embed\'s player made after it', { skip }, () => {
  assert.equal(result.overlayOnTop, true)
})

test('the server cutting its answers at its deadline (the player reading slowly): main asks again from where they stopped and the video goes on', { skip }, () => {
  const starts = result.bRanges.map(r => Number(/^bytes=(\d+)/.exec(r)?.[1]))
  assert.ok(starts.some(start => start > 0 && start % (512 * 1024) !== 0), `asked again mid-chunk: ${JSON.stringify(result.bRanges)}`)
  assert.equal(result.bAfterCuts.error ?? null, null, JSON.stringify(result.bAfterCuts))
  assert.ok((result.bAfterCuts.buffered ?? 0) > 0)
})
