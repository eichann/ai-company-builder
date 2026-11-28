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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir, stopWithTempDirs } from '../../shared/testing/temp-dirs'

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
  runner: Record<string, unknown>
  helpers: Record<string, unknown>
  recording: Record<string, unknown>
  browse: Record<string, unknown>
  work: Record<string, unknown>
  workPress: Record<string, unknown>
  workFlow: Record<string, unknown>
  workFlowCompact: Record<string, unknown>
  verify: Record<string, unknown>
  kept: Record<string, unknown>
  whenLoadedCut: boolean
  whenLoaded: boolean
  whenLoadedUrl: string
  focus: { appFocusedFirst: boolean; inactive: { visible: boolean; appKeepsKeyboard: boolean }; active: { visible: boolean; appKeepsKeyboard: boolean } }
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
    '[ext]', 'subjectAltName = DNS:op.test, DNS:assets.test, DNS:evil.test, DNS:untrusted.test, DNS:helper.test, DNS:helper-parts.test',
  ].join('\n'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', config], { stdio: 'ignore' })
}

let result: Result

before(async () => {
  if (!canRun) return
  const dir = makeTempDir('acb-browser-window-')
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
    stopWithTempDirs(child)
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    // On a timeout the child is killed and its end awaited before failing, so the folder it writes in can be
    // removed after it (`shared/testing/temp-dirs.ts`).
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 330_000)
    // `close`: the process exited and its output streams ended; the result file was renamed into place before.
    child.on('close', () => { clearTimeout(timer); if (timedOut) reject(new Error(`the Electron harness did not finish:\n${out}\n${err.slice(-4000)}`)); else resolve(`${out}\n${err.slice(-4000)}`) })
  })
  const resultFile = path.join(dir, 'result.json')
  const text = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(text !== null, `no result from the Electron harness:\n${output}`)
  result = JSON.parse(text) as Result
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

test('a run that opened the window waits until its first page has loaded (not past its signal)', { skip }, () => {
  assert.equal(result.whenLoadedCut, false, 'a stopped run does not wait')
  assert.equal(result.whenLoaded, true)
  assert.equal(result.whenLoadedUrl, 'https://op.test/', 'the site\'s page is there when it answers')
})

test('a window a run opens again is shown without taking the keyboard from the app; 「開いてログイン」 takes it', { skip }, () => {
  assert.equal(result.focus.appFocusedFirst, true, JSON.stringify(result.focus))
  assert.deepEqual(result.focus.inactive, { visible: true, appKeepsKeyboard: true })
  assert.deepEqual(result.focus.active, { visible: true, appKeepsKeyboard: false })
})

test('the login lives in memory only: no session folder on disk', { skip }, () => {
  assert.equal(result.partitionInMemory, true)
  assert.deepEqual(result.partitionFolders.filter(name => /^acb-browser-/i.test(name)), [])
})

test('a kept login lives in Partitions/<its name> (its page-less sessions in memory) and removing it leaves nothing', { skip }, () => {
  // agent-browser.md "Keeping a login on disk": the folder is found by its name, so Electron's naming is load-bearing.
  const kept = result.kept as Record<string, unknown>
  assert.equal(kept.cookiesKept, 1)
  assert.equal(kept.folderMade, true, 'the cookies are where the kept logins are looked for')
  assert.deepEqual(kept.pagelessOnDisk, [], 'the read / write sessions never reach the disk')
  assert.equal(kept.removed, true)
  assert.equal(kept.folderLeft, false)
  assert.equal(kept.cookiesAfter, 0, 'the live session holds nothing either')
  assert.equal(kept.reusable, null, 'a removed partition is never used again in this run')
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
  // (The runner's own writes, to /line/…, are the next tests'.)
  // (The recording's page saves through its own fetch, as a person does: the recording tests' own; a write run's, /work/…, the last test's;
  // the completion regression's, /flow/…, its own.)
  const writes = hitsTo('op.test').filter(h => h.method !== 'GET' && !h.path.startsWith('/line/') && !h.path.startsWith('/rec-') && !h.path.startsWith('/work/') && !h.path.startsWith('/flow/'))
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

// ---------------------------------------------------------------------------
// Login helpers (agent-browser.md "Login helpers")
// ---------------------------------------------------------------------------

const helperHits = () => [...hitsTo('helper.test'), ...hitsTo('helper-parts.test')].map(h => `${h.host} ${h.method} ${h.path}`)

test('while the member logs in, the declared login helpers work: the frame, its part and its check by POST, only under their path', { skip }, () => {
  const h = result.helpers
  assert.equal(h.humanApiScript, true)
  assert.equal(h.humanFrameDone, 'checked:200', 'the frame loaded its part and its POST was answered')
  const hits = helperHits()
  for (const want of ['helper.test GET /recaptcha/api.js', 'helper.test GET /recaptcha/anchor?k=1', 'helper-parts.test GET /recaptcha/frame.js', 'helper.test POST /recaptcha/reload?k=1']) {
    assert.ok(hits.includes(want), `${want} in ${hits.join(', ')}`)
  }
  // Outside the prefix, a frame of the parts helper and a beacon reach nothing.
  assert.equal(hits.some(x => x.includes('/other') || x.includes('/recaptcha/framed') || x.includes('/recaptcha/beacon')), false, hits.join(', '))
  assert.match(result.refusalLog.join('\n'), /to helper\.test \(login-helper-path\)/)
  assert.match(result.refusalLog.join('\n'), /to helper-parts\.test \(frame-navigation\)/)
})

test('a helper\'s frame left in the page makes it not clean for the AI, and while the AI operates no helper is reached by frame, script or fetch; back with the member they work again', { skip }, () => {
  const h = result.helpers
  assert.ok((h.humanFrames as string[]).some(u => u.startsWith('https://helper.test/recaptcha/anchor')), String(h.humanFrames))
  assert.equal(h.cleanWithFrameInHuman, false)
  assert.equal(h.enteredWithFrame, true)
  assert.equal(h.cleanWithFrameInAi, false, 'a run stops at its next check')
  assert.equal(h.enterClean, true)
  assert.equal(h.cleanAfterLogin, true)
  // Frames the window refused stay empty documents of the site: they do not keep the AI from operating.
  assert.equal((h.refusedFrames as string[]).length, 2, String(h.refusedFrames))
  assert.equal(h.enteredWithRefusedFrames, true)
  assert.equal(h.cleanWithRefusedFrames, true, String(h.refusedFrames))
  assert.equal(h.aiScript, 'refused')
  assert.equal(h.aiFetch, 'refused')
  assert.equal(h.helperFetchInAiWithFrame, 'refused', 'in ai mode the helpers stay shut, the frame still there or not')
  assert.equal((h.aiFrames as string[]).some(u => u.includes('helper.test')), false, String(h.aiFrames))
  const hits = helperHits()
  assert.equal(hits.some(x => /[?&](ai|during)=1/.test(x)), false, hits.join(', '))
  assert.ok(hits.includes('helper.test GET /recaptcha/anchor?again=1'), 'in human mode again the frame loads')
  assert.ok((h.againFrames as string[]).some(u => u.startsWith('https://helper.test/recaptcha/anchor?again=1')), String(h.againFrames))
})

// ---------------------------------------------------------------------------
// The operation runner on a Lステップ-like site (agent-browser.md "The runner")
// ---------------------------------------------------------------------------

const WRITE_PATH = '/line/episode/step/pack/template'
const writesOfRuns = () => hitsTo('op.test').filter(h => h.method === 'POST' && h.path.startsWith('/line/'))
const idsOf = (body: string) => { const f = new URLSearchParams(body); return `${f.get('content_id')}/${f.get('template_id')}` }

test('a run sends exactly one write with the planned ids through the member\'s login, and the page confirms it', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.happy, { outcome: 'succeeded' })
  assert.deepEqual(r.happyReports, [{ result: 'succeeded' }])
  assert.deepEqual(r.stepAfterHappy, ['300', '301'])
  const happy = writesOfRuns().filter(h => idsOf(h.body) === '201/301')
  assert.equal(happy.length, 1, 'one POST, the runner\'s')
  assert.equal(happy[0].path, WRITE_PATH)
  assert.deepEqual([...new URLSearchParams(happy[0].body).keys()].sort(), ['_lm_user_id', '_token', 'content_id', 'template_id'])
})

test('while a run operates, the page\'s own write (fetch, XHR, a timer\'s autosave, a tampered form) and undeclared reads reach nothing', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.attack, { fetch: 'refused', xhr: 'refused', undeclaredRead: 'refused' })
  // Only the runner's writes ever reached the site: no autosave, no form with the changed hidden field.
  assert.deepEqual(writesOfRuns().map(h => `${h.path} ${idsOf(h.body)}`), [
    `${WRITE_PATH} 201/301`, `${WRITE_PATH} 201/999`, `${WRITE_PATH} 201/304`,
  ])
  assert.equal(hitsTo('op.test').some(h => h.path === '/line/autosave' || h.path === '/line/autosave-state'), false)
})

test('a run stops before writing for another LINE account or an emergency stop during the run', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.wrongAccount, { outcome: 'stopped', reason: 'account-mismatch' })
  assert.deepEqual(r.stoppedMidRun, { outcome: 'stopped', reason: 'stopped' })
  assert.equal(writesOfRuns().some(h => ['201/302', '201/303'].includes(idsOf(h.body))), false)
})

test('a write whose answer is lost is unknown and never sent again', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.lost, { outcome: 'unknown', reason: 'no-answer' })
  assert.deepEqual(r.lostReports, [{ result: 'unknown', reason: 'no-answer' }])
  assert.deepEqual(r.lostAgain, { outcome: 'refused', reason: 'already-ran' })
  assert.equal(writesOfRuns().filter(h => idsOf(h.body) === '201/999').length, 1)
  assert.deepEqual(r.records, [
    'a:claimed', 'a:permit-asked', 'a:succeeded', 'b:claimed', 'b:failed', 'c:claimed', 'c:failed',
    'd:claimed', 'd:permit-asked', 'd:unknown', 'e:claimed', 'e:failed', 'f:claimed', 'f:permit-asked', 'f:failed',
    '1:claimed', '1:failed', '2:claimed', '2:permit-asked', '2:failed',
  ])
})

test('a permit that is 5 s old by the last check right before sending: the window\'s write session never ends the request — nothing reaches the site — and the server is told failed', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.late, { outcome: 'failed', reason: 'permit-late' })
  assert.deepEqual(r.lateReports, [{ result: 'failed', reason: 'permit-late' }])
  assert.equal(writesOfRuns().some(h => idsOf(h.body) === '201/306'), false)
})

test('a sandboxed frame the page makes while the AI operates stops the run — before the permit, or at the last check right before sending — and its own requests to the site reach nothing', { skip }, () => {
  const r = result.runner
  assert.deepEqual(r.frameBeforeRead, { outcome: 'stopped', reason: 'foreign-frames' })
  assert.deepEqual(r.frameAtPermit, { outcome: 'failed', reason: 'foreign-frames' })
  assert.deepEqual(r.frameAtPermitReports, [{ result: 'failed', reason: 'context-changed' }])
  assert.equal(writesOfRuns().some(h => ['201/307', '201/308'].includes(idsOf(h.body))), false)
  // The frame's own write and read, sent the moment it loaded (also while it was still loading at a check).
  assert.equal(hitsTo('op.test').some(h => h.path === '/line/frame-write' || h.path === '/line/frame-read'), false)
  assert.match(result.refusalLog.join('\n'), /to op\.test \(ai-other-frame\)/)
  const facts = r.sandboxedFrame as { main: number; frames: Array<{ origin: string; processId: number }> }
  assert.ok(facts.frames.some(f => f.origin === 'null'), JSON.stringify(facts))
})

test('an answer over the size the runner reads is refused whole, never read cut short', { skip }, () => {
  // The facts read again through the read session: the page is refused whole, so the site cannot be read.
  assert.deepEqual(result.runner.oversize, { outcome: 'stopped', reason: 'read-failed' })
  assert.equal(writesOfRuns().some(h => idsOf(h.body) === '201/305'), false)
})

test('a write carries the cookies of its own address and leaves nothing behind: one write session, cleared', { skip }, () => {
  const r = result.runner
  // The site refuses the write without the cookie scoped to its path (the happy path above succeeded).
  assert.deepEqual(r.happy, { outcome: 'succeeded' })
  assert.equal(r.writeSessionCookies, 0)
  // The read and write sessions are made once with the window; no run makes another.
  assert.equal(r.writeSessionsCreated, 0)
})

test('main reads through the window\'s page-less read session with the member\'s login, never touching the window: what the member types stays, nothing is left in the session', { skip }, () => {
  const r = result.runner
  assert.equal(r.readSessionCookies, 0)
  assert.equal(r.previewRead, 200, 'the login (a cookie the site needs) was carried')
  assert.equal(r.previewReachedSite, 1)
  // A declared read's query reaches the site exactly as built; an encoded one is never sent.
  assert.equal(r.previewQueryRead, 200)
  assert.equal(r.previewEncodedRead, 'refused')
  assert.deepEqual(r.previewQueryPaths, ['/api/episodes?group=29529&page=1'])
  assert.equal(r.typingAfterPreview, '入力中')
  assert.equal(r.readSessionCookiesAfterPreview, 0)
})

test('the run\'s gate on the real window: only the armed write with the plan\'s values, once; only declared reads', { skip }, () => {
  const r = result.runner
  assert.equal(r.gateReady, true)
  assert.equal(r.notArmed, 'refused')
  assert.equal(r.otherStep, 'refused')
  assert.equal(r.otherTemplate, 'refused')
  assert.equal(r.extraKey, 'refused')
  assert.equal(r.armedWrite, 302)
  assert.equal(r.secondSend, 'refused')
  assert.equal(r.undeclaredRead, 'refused')
  assert.equal(r.declaredRead, 200)
  assert.equal(r.pageUndeclaredRead, 'refused')
  assert.equal(r.pageDeclaredRead, 200)
  assert.deepEqual(r.gateRefusals, ['not-armed', 'wrong-value', 'wrong-value', 'extra-key', 'not-armed', 'undeclared-read'])
  assert.equal(hitsTo('op.test').some(h => h.path === '/line/episode/show/102'), false)
  assert.equal(writesOfRuns().some(h => ['202/304', '201/305'].includes(idsOf(h.body))), false)
})

test('recording: the person\'s own clicks and typing are kept in their kept form only; no value, password, Cookie, CSRF or link text', { skip }, () => {
  const r = result.recording
  assert.equal(r.started, true)
  assert.equal(r.problem, null, 'the recording passes the server\'s check as it is')
  const content = r.content as { steps: Array<Record<string, unknown>>; hosts: unknown[] }
  const json = JSON.stringify(content)
  for (const secret of ['2026-12-03', 'pw-secret-value', '7777', 'csrf-in-header', 'csrf-in-body', 'auth-header-6543', '山田', '48213', '90211', 'forged by the page', 'login_pw', '_token', '鈴木', '佐藤', '高橋', 'memo-value']) {
    assert.equal(json.includes(secret), false, secret)
  }
  const kinds = content.steps.map(s => `${s.kind}:${s.kind === 'page' || s.kind === 'send' ? s.address : s.label ?? s.address}`)
  assert.ok(kinds.includes('page:/rec-form'), kinds.join(' | '))
  assert.ok(kinds.includes('page:/rec-form/{n}'), `a same-document navigation before any new load: ${kinds.join(' | ')}`)
  assert.ok(kinds.includes('input:受付終了日'), kinds.join(' | '))
  assert.ok(kinds.includes('input:パスワード'), kinds.join(' | '))
  assert.ok(kinds.includes('click:保存'), kinds.join(' | '))
  assert.ok(kinds.includes('send:/rec-api/{n}'), kinds.join(' | '))
  const password = content.steps.find(s => s.kind === 'input' && s.label === 'パスワード')
  assert.equal(password?.value, 'secret')
  const date = content.steps.find(s => s.kind === 'input' && s.label === '受付終了日')
  const save = content.steps.filter(s => s.kind === 'send' && s.method === 'POST' && s.address === '/rec-save/{n}').at(-1) as { fields: Array<{ name: string; value: string }>; after: number | null; status: number }
  assert.deepEqual(save.fields.map(f => f.name), ['end_date'])
  assert.equal(save.fields[0].value, date?.value, 'the value typed and the value sent are the same symbol')
  assert.equal(save.status, 200)
  const click = content.steps.find(s => s.kind === 'click' && s.label === '保存')
  assert.equal(save.after, click?.id, 'the save follows the press (推定)')
  // The page's own synthetic click and its call of the binding name are not the person's.
  assert.deepEqual(content.steps.filter(s => s.kind === 'click').map(s => `${s.target}:${s.label}`), ['button:保存', 'choice:null', 'button:null'],
    'an option picked from a list, and a whole row made a button, keep no label (their text is often the data itself)')
  const memo = content.steps.find(s => s.kind === 'input' && s.name === 'memo')
  assert.equal(memo?.label, null, 'a field named only by text elsewhere on the page (aria-labelledby) keeps no label')
})

test('recording and the AI never hold the window together; the preview reads nothing while recording; closing the window ends it', { skip }, () => {
  const r = result.recording
  assert.equal(r.aiWhileRecording, false, 'the AI cannot enter the window while it records')
  assert.equal(r.previewWhileRecording, 'refused')
  assert.equal(r.aiAfter, true, 'once stopped, the AI can')
  assert.equal(r.recordWhileAi, false, 'no recording while the AI holds the window')
  assert.deepEqual(r.ended, [], 'stopping is not an end the recording is discarded for')
  assert.equal(r.otherStarted, true)
  assert.deepEqual(r.endedOnClose, ['closed'])
})

test('the operator\'s window tools read only: a submit, a fetch button, a confirmed button and a write scheduled for after the run send nothing; another site is never reached; a stopped navigation ends', { skip }, () => {
  const r = result.browse
  assert.equal(r.entered, true)
  const snap = r.snapshot as { address: string; elements: Array<{ role: string; name: string; value?: string }> }
  assert.equal(snap.address, '/browse')
  assert.equal(JSON.stringify(snap).includes('pw-in-page-5555'), false, 'a password field\'s value is never read')
  assert.deepEqual(snap.elements.find(e => e.role === 'password')?.value, undefined)
  // Real typing and choosing work…
  assert.equal(r.typed, 'ok')
  assert.equal(r.typedValue, '山田花子')
  assert.equal(r.selected, 'ok')
  assert.equal(r.selectedValue, '古い順')
  // …but no press made a write leave the window: the form's submit, a fetch, a confirm (dismissed, never accepted).
  assert.deepEqual(r.writes, [])
  assert.equal(r.evilHits, 0)
  assert.match(String(r.urlAfterEvil), /^https:\/\/op\.test\//)
  // Pages of the site open (a link, back, an address of the site); another site's address does not.
  assert.equal(r.next, 'ok')
  assert.equal(r.urlAfterNext, 'https://op.test/browse-next')
  assert.equal(r.back, 'ok')
  assert.equal(r.urlAfterBack, 'https://op.test/browse')
  assert.equal(r.goOther, 'failed')
  assert.equal(r.urlAfterGo, 'https://op.test/browse-next')
  assert.equal(r.hang, 'failed')
  assert.ok(Number(r.hangMs) < 3000, `a stopped navigation ends at once (${String(r.hangMs)} ms)`)
  for (const k of ['fetchClick', 'confirmClick', 'evilClick', 'later', 'draft']) assert.equal(r[k], 'ok', `${k}: the page saw the press`)
  assert.equal(r.draft, 'ok')
  assert.equal(r.openAfterLeave, true, 'a page asking to stay (beforeunload) is loaded afresh all the same, not closed')
  assert.equal(r.urlAfterLeave, 'https://op.test/browse')
  assert.equal(r.pick, 'ok')
  assert.ok(Number(r.choosers) > 0, 'the page opened a file chooser')
  assert.ok(result.refusalLog.some(l => l.includes('file-chooser')), 'the file chooser was intercepted and refused')
})

test('the operator sees a folder tree driven by script alone: each item listed once (never the list and its spans), a press reaches the page\'s handler, a card that saves by fetch writes nothing; the screen is a JPEG with the marks on the pixels, never in the page', { skip }, () => {
  const r = result.browse
  assert.deepEqual(r.treeItems, ['▸キャンペーン', '▸未分類', '▸アーカイブ', 'すぐ反映（下書き）', '秘密のフォルダ 88123'])
  // A row's or tree item's words are data: never a run-log label (the recording's rule).
  assert.deepEqual(r.treeLogLabels, ['', '', '', '', ''])
  // A file input stays out whatever its tabindex or cursor: no element the operator can press opens a file chooser.
  assert.equal((r.treeNames as string[]).includes('アップロード'), false)
  assert.equal(r.folderClick, 'ok')
  assert.match(String(r.treeShown), /キャンペーン の中身/)
  assert.equal(r.cardClick, 'ok', 'the page saw the press on the card')
  // The card's fetch POST, like every write of the run, never left the window.
  assert.equal(r.treeEntered, true)
  assert.deepEqual(r.treeWrites, [])
  // The screen: a JPEG no wider than 1280 pixels; the folder's mark on its left edge, the page's own white inside it.
  assert.equal(r.shotType, 'image/jpeg')
  assert.equal(r.shotJpeg, 'ffd8ff')
  const size = r.shotSize as { width: number; height: number }
  assert.ok(size.width > 0 && size.width <= 1280 && size.height > 0, JSON.stringify(size))
  const edge = r.markEdge as { r: number; g: number; b: number }
  const inside = r.pageInside as { r: number; g: number; b: number }
  assert.ok(edge.r > 150 && edge.g < 110 && edge.b < 110, `the mark's colour on the box's edge: ${JSON.stringify(edge)}`)
  assert.ok(inside.r > 200 && inside.g > 200 && inside.b > 200, `the page itself inside the box: ${JSON.stringify(inside)}`)
  assert.equal(r.treeDomAfterShot, r.treeDomBefore, 'neither the snapshot nor the screen changed the page\'s document')
})

test('a row menu appended at the end of a long page gets its refs first (production 2026-11-27): the elements are ordered before the cap — the open menu, then the screen, the rest last —, a press on its choice reaches the page, an element it covers has no mark', { skip }, () => {
  const r = result.browse
  assert.equal(r.menuError, undefined)
  assert.equal(r.menuEntered, true)
  const list = r.menuList as { count: number; omitted: number; boxes: boolean[]; names: string[] }
  // More usable elements than the cap: the cap holds, and the rest is counted.
  assert.equal(list.count, 400)
  assert.ok(list.omitted > 0, JSON.stringify(list.omitted))
  // Every element on the screen comes before any off the screen; the rows at the end (off the screen) are the ones cut.
  const firstOff = list.boxes.indexOf(false)
  assert.ok(firstOff > 0, 'some on the screen')
  assert.equal(list.boxes.slice(firstOff).includes(true), false, 'nothing on the screen after the first one off it')
  assert.ok(list.names.includes('経路0') && list.names.includes('その他1'), 'the first rows are there')
  assert.equal(list.names.includes('その他399'), false, 'the last row, off the screen, is left out first')
  assert.equal(r.moreClick, 'ok')
  // The menu's two choices are the first refs, with their marks.
  const open = r.menuOpen as { first: Array<{ ref: number; role: string; name: string; box: boolean }>; count: number; coveredBox: unknown; coveredListed: boolean }
  assert.deepEqual(open.first, [{ ref: 0, role: 'item', name: 'コピーを作成', box: true }, { ref: 1, role: 'item', name: '削除', box: true }])
  assert.equal(open.count, 400)
  assert.equal(open.coveredListed, true)
  assert.equal(open.coveredBox, null, 'no mark on what the open menu covers')
  assert.equal(r.copyClick, 'ok', 'the press on 「コピーを作成」 reached the page')
})

test('pressing by position: a menu choice with no ref is pressed where the screen image shows it and logged by its label; a file field or its label, a point off the screen and a page that moved are refused; typing goes into the focused text field, never a password field', { skip }, () => {
  const r = result.browse
  assert.equal(r.menuError, undefined)
  // The menu's third choice has no sign of a control: no ref — pressed by its place on the image, logged by its own label.
  const by = r.byPosition as { aimed: { ok: boolean; role: string; logLabel: string }; label: string | null; acted: string; listed: boolean }
  assert.equal(by.listed, false, 'it has no ref')
  assert.equal(by.aimed.ok, true, JSON.stringify(by))
  assert.equal(by.label, '共有する')
  assert.equal(by.acted, 'ok')
  assert.equal(r.byPositionSeen, true, 'the page saw the press')
  // A file field and its label: refused before anything is pressed (no file chooser can open).
  assert.deepEqual((r.fileLabel as { aimed: unknown }).aimed, { ok: false, why: 'file' })
  assert.deepEqual((r.fileField as { aimed: unknown }).aimed, { ok: false, why: 'file' })
  assert.equal(r.fileSeen, false)
  // Off the screen: the parser refuses a point outside the image; the window one outside the viewport.
  assert.deepEqual(r.offParsed, { problem: 'point' })
  assert.deepEqual(r.offAim, { ok: false, why: 'outside' })
  // The page moved after its snapshot and screen: the press is refused (the operator sees the page again).
  assert.deepEqual(r.movedAim, { ok: false, why: 'moved' })
  // An element that became a floating layer after the snapshot (same box): the image did not show it on top — refused.
  assert.deepEqual(r.layerAim, { ok: false, why: 'moved' })
  // Typing into the focused field: the text field takes it, logged by its label; a password field never.
  assert.equal((r.memoPress as { acted: string }).acted, 'ok')
  assert.deepEqual(r.typeAim, { ok: true, role: 'textbox', logLabel: 'メモ' })
  assert.equal(r.typed, 'ok')
  assert.equal(r.memoValue, 'こんにちは')
  assert.equal((r.pwPress as { acted: string }).acted, 'ok')
  assert.deepEqual(r.pwAim, { ok: false, why: 'password' })
  assert.equal(r.pwTyped, 'refused')
  assert.equal(r.pwValue, '')
})

test('a write task on the real window: a press while a held write is being sent is not done, so the site gets one save although the frame allows two', { skip }, () => {
  const r = result.workPress
  assert.equal(r.hits, 1, JSON.stringify(r))
  assert.equal(r.permits, 1)
  // The operator was told in fixed words that its press was not done.
  const last = (r.histories as Array<Array<{ do: string; outcome: string; result?: string }>>).at(-1) ?? []
  assert.deepEqual(last.map(h => [h.do, h.outcome, h.result ?? null]), [['click', 'ok', null], ['click', 'refused', '送っている途中なので押していません']])
})

// The completion regression runs once per tool set (agent-browser.md "The operator's tool sets"): the same guards hold in both.
for (const [toolset, key] of [['current', 'workFlow'], ['compact', 'workFlowCompact']] as const) test(`the completion regression (${toolset} tool set): a company Skill's copy-and-register task runs to the end on the real window, and exactly its two writes reach the site, each in its frame, once`, { skip }, t => {
  const r = result[key]
  // Each step's operator was started with this set; its steps and stops are printed for comparing the sets.
  assert.deepEqual(new Set(r.toolsets as string[]), new Set([toolset]))
  t.diagnostic(`toolset=${toolset} operatorSteps=${String(r.operatorSteps)} workSteps=${String(r.workSteps)} stops=${String(r.stops)} ms=${String(r.ms)}`)
  assert.equal(r.stops, 0)
  assert.match(String(r.words), /^済みました。読み直して、約束した値と送った値になっていることを確かめました/, JSON.stringify(r))
  // Exactly the two writes, in order, with the setting chosen again and the person's own values as written.
  assert.deepEqual(r.flow, [
    { path: '/flow/copy', body: JSON.stringify({ source: 12, setting: 'B設定' }) },
    { path: '/flow/items/99', body: JSON.stringify({ name: '【冬の回】', date: '2026-12-03' }) },
  ])
  // The run's promise was made before the card, and nothing was asked (no stop, no question more than before).
  assert.deepEqual((r.calls as string[]).filter(c => c.startsWith('permit') || c.startsWith('report') || c === 'approve' || c.startsWith('promise')), [
    'promise', 'approve', 'permit 1 /flow/copy', 'report done', 'permit 2 /flow/items/99', 'report done',
  ])
  const promise = (r.promises as Array<{ values: unknown[]; binds: Array<{ frame: number; field: string }> }>)[0]
  assert.deepEqual(promise.binds.map(b => [b.frame, b.field]), [[2, 'name'], [2, 'date']])
  assert.equal(JSON.stringify(r.promises).includes('冬の回'), false)
  // Reading the copy back matched what was promised: the card is all ✓.
  assert.equal(r.cardState, 'all_ok')
  // The work had the person's words, the sealed steps and the approved plan — and not the consultation AI's request.
  for (const m of r.workMaterials as Array<{ person: unknown; steps: unknown; plan: unknown; request: unknown }>) {
    assert.deepEqual(m.person, { said: ['元の行は変えない'], values: [{ label: '名前', value: '【冬の回】' }, { label: '日付', value: '2026-12-03' }] })
    assert.match(String(m.steps), /B設定/)
    assert.deepEqual(m.plan, { summary: '秋の回をコピーして登録します', affects: 'なし', values: [{ label: 'コピー元', value: '秋の回' }] })
    assert.equal(m.request, null)
  }
})

test('a write run sends each page write once within the plan: the page\'s own cookie and CSRF, its answer without Set-Cookie, one at a time; outside the plan, a file, past the max, after a stop and after a lost answer nothing is sent', { skip }, () => {
  const r = result.work
  assert.equal(r.entered, true)
  const work = r.work as Array<{ path: string; name: string; cookie: string; csrf: string; start: number; end: number }>
  // (The last scenario's 'g' is the detach's: checked at the end.)
  const saves = work.filter(w => w.path === '/work/save' && w.name !== 'g')
  // Exactly a, b and c reached the site, each once, with the page's cookie and CSRF header as the page made them.
  assert.deepEqual(saves.map(w => w.name).sort(), ['a', 'b', 'c'])
  for (const w of saves) {
    assert.match(w.cookie, /(^|;\s*)sid=1(;|$)/)
    assert.equal(w.csrf, 'csrf-777')
  }
  // The page got the site's answer and its flow went on; the cookie the site set reached neither the page nor the window.
  const save = r.save as { status: number; body: { id: number }; cookie: string }
  assert.equal(save.status, 201)
  assert.equal(save.body.id, 4242)
  assert.equal(save.cookie.includes('rotated'), false)
  assert.equal((r.windowCookies as string[]).includes('rotated'), false)
  // Two saves at once: the second reached the site only after the first was answered (and its result recorded).
  const [b, c] = ['b', 'c'].map(n => saves.find(w => w.name === n)!)
  assert.ok(Math.min(b.end, c.end) <= Math.max(b.start, c.start), 'one write at a time')
  assert.equal(r.reportsBeforePermits, true)
  // Outside the plan, a file, a never-read address, past the frame's max, after the stop: nothing sent.
  assert.equal(r.auto, 'failed')
  assert.equal(r.upload, 'failed')
  assert.equal(r.never, 'refused')
  assert.equal(r.stopped, 'failed')
  assert.equal(r.pastMax, 'failed')
  assert.equal(r.permitsForPastMax, 0)
  assert.equal(result.hits.filter(h => h.path === '/work/auto' || h.path.startsWith('/work/never')).length, 0)
  // The lost answer: one request reached the site (no resend), the run is locked, the next save is not sent.
  assert.equal(r.lost, 'failed')
  assert.equal(work.filter(w => w.path === '/work/lost').length, 1)
  assert.equal(r.lockedAfterLost, true)
  assert.equal(r.afterLost, 'failed')
  assert.equal(saves.some(w => w.name === 'f' || w.name === 'e' || w.name === 'd' || w.name === 'u'), false)
  // The server was told shapes and fixed words only: no cookie, CSRF value or body value in a permit or a report; nor in the log.
  const told = JSON.stringify(r.calls) + JSON.stringify(r.log)
  for (const secret of ['csrf-777', 'sid=1', '"a"', '4242']) assert.equal(told.includes(secret), false, secret)
  const reports = (r.calls as Array<{ kind: string; body: { result?: string } }>).filter(c => c.kind === 'report').map(c => c.body.result)
  assert.deepEqual(reports, ['done', 'done', 'done', 'not_sent', 'unknown'])
  // The DevTools connection gone while a save was held: neither the run's copy nor the page's parked original reached the
  // site, and the write is told not sent (its permit's unit used).
  assert.equal(work.filter(w => w.name === 'g').length, 0)
  assert.deepEqual(r.detachedRecords, ['not-sent'])
  const second = (r.calls as Array<{ kind: string; body: { result?: string } }>).filter(c => c.kind === 'report2').map(c => c.body.result)
  assert.deepEqual(second, ['not_sent'])
})

test('what a press did (the real-window probe of 2026-11-27): a ref whose row was re-used, a ref under a banner, a button whose words changed and an unlisted line whose words changed are never pressed; a press says what it reached; a confirm and an alert are told, the confirm cancelled; typing says what the field holds', { skip }, () => {
  const r = result.verify
  assert.equal(r.error, undefined)
  assert.equal(r.entered, true)
  // 1. The list re-sorted after the snapshot: 山田's 保存 now sits in 佐藤's row — refused, nothing pressed (the probe wrote /p/item/33).
  assert.deepEqual(r.recycle, { outcome: 'refused', why: 'moved' })
  assert.deepEqual(r.recycleClicks, [])
  // Read again, the press reaches the row it names and says what took the click.
  assert.deepEqual(r.recycleAgain, { outcome: 'ok', pressed: { role: 'button', name: '保存', row: 'same' } })
  assert.deepEqual(r.recycleAgainClicks, ['item-33'])
  // Rows alike in their first 200 characters are compared whole; two 開く with no words around them cannot be told apart.
  assert.deepEqual(r.long, { outcome: 'refused', why: 'moved' })
  assert.deepEqual(r.twin, { outcome: 'refused', why: 'moved' })
  assert.deepEqual(r.longClicks, [])
  // The row changed between the check and the click (re-sorted on mousedown): the result says so.
  assert.deepEqual(r.down, { outcome: 'ok', pressed: { role: 'button', name: '更新', row: 'changed' } })
  assert.deepEqual(r.downClicks, ['down-丁'])
  // The page stopped the click before the window's listener: unknown (never "nothing pressed"), and the page wrote.
  assert.deepEqual(r.stopper, { outcome: 'ok', pressed: 'none', pageWrite: true })
  // 2. A banner over the button after the snapshot: refused as covered — neither the button nor the banner pressed.
  assert.deepEqual(r.covered, { outcome: 'refused', why: 'covered' })
  assert.deepEqual(r.coveredClicks, [])
  assert.deepEqual(r.saveAgain, { outcome: 'ok', pressed: { role: 'button', name: '保存する', row: 'same' } })
  // 3. By position: another part of the page moved, the button at the point is the same one — still pressed (not stopped
  // for every small movement)…
  assert.deepEqual(r.stillAim, { ok: true, role: 'button', logLabel: '保存' })
  assert.deepEqual(r.still, { outcome: 'ok', pressed: { role: 'button', name: '保存', row: 'same' } })
  assert.deepEqual(r.stillClicks, ['save'])
  // …but 保存 turned 削除 in the same box, and an unlisted line's words changed: refused, never pressed (the probe sent a delete).
  assert.deepEqual(r.swapAim, { ok: false, why: 'moved' })
  assert.deepEqual(r.swap, { outcome: 'refused', why: 'moved' })
  assert.equal(r.plainListed, false, 'the line has no ref')
  assert.deepEqual(r.plain, { outcome: 'refused', why: 'moved' })
  assert.deepEqual(r.swapClicks, [])
  // Another listed button moved under the point (the page moved): it did not hold that point in the snapshot — refused.
  assert.deepEqual(r.colAim, { ok: false, why: 'moved' })
  assert.deepEqual(r.col, { outcome: 'refused', why: 'moved' })
  assert.deepEqual(r.colClicks, [])
  // 4. A confirm: told with its text, and the page heard 「キャンセル」 (never yes); an alert told with its text.
  assert.deepEqual(r.confirm, { outcome: 'ok', pressed: { role: 'button', name: '確認して保存', row: 'same' }, dialogs: [{ kind: 'confirm', text: '本当に保存しますか？' }] })
  assert.deepEqual(r.alert, { outcome: 'ok', pressed: { role: 'button', name: '知らせる', row: 'same' }, dialogs: [{ kind: 'alert', text: '入力に誤りがあります' }] })
  assert.deepEqual(r.dialogClicks, ['not-confirmed', 'alerted'])
  // 5. Typing: a maxlength cut, a filter that reformatted, a date field and a refused input left empty, a contenteditable memo.
  assert.deepEqual(r.code, { outcome: 'ok', typed: { result: 'value-cut', value: 'ABCDE' } })
  assert.deepEqual(r.tel, { outcome: 'ok', typed: { result: 'value-changed', value: '0312345678' } })
  assert.deepEqual(r.day, { outcome: 'ok', typed: { result: 'value-empty' } })
  assert.deepEqual(r.amount, { outcome: 'ok', typed: { result: 'value-empty' } })
  assert.equal(r.memoListed, 'textbox')
  assert.deepEqual(r.memo, { outcome: 'ok', typed: { result: 'value-same' } })
  assert.equal(r.memoShown, 'メモの本文', 'a contenteditable field shows what it holds')
  assert.equal(r.pwReadBack, null, 'a password field\'s value is never read back')
  assert.equal(r.codeReadBack, JSON.stringify({ value: 'ABCDE' }))
  // The read page's own confirm (「消す」) is told too, and typing into its search field holds what was typed.
  assert.deepEqual((result.browse.confirmResult as { dialogs?: unknown }).dialogs, [{ kind: 'confirm', text: '消しますか？' }])
  assert.deepEqual((result.browse.typedResult as { typed?: unknown }).typed, { result: 'value-same' })
})
