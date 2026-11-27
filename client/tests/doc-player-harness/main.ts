// The Electron side of tests/doc-player-electron.test.ts: the app's real scheme registration, document
// views (doc-view.ts), ACB's players over Drive embeds (createDrivePlayerShell + features/doc-frames/
// players.ts) and a local fake of the server's stream route (`/api/companies/:id/me/google/drive/view/:fileId`,
// answering byte ranges of a real clip, refusing a file until it was "picked"). Shows a document with
// Drive embeds the way the viewer does, and measures where the players go, that a `<video>` in a player
// plays and seeks through `acb-drive-video://` with 206 answers, and that closing aborts its stream.
// Writes what happened to `<PLAYER_TEST_DIR>/result.json` (temporary name, then renamed). Started with
// `NODE_OPTIONS=--import tsx`. `PLAYER_TEST_SCHEME` (a JSON privileges object) replaces the player
// scheme's privileges, so the test can show what each one holds.
import { app, BrowserWindow, protocol, session, webContents as allWebContents, type WebContents } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { registerLocalFileScheme } from '../../electron/electron-adapter'
import { createDocViewShell, createDrivePlayerShell } from '../../electron/doc-view'
import { createDocFrames } from '../../electron/features/doc-frames/protocol'
import { createDocViews } from '../../electron/features/doc-frames/views'
import { createDrivePlayers } from '../../electron/features/doc-frames/players'
import { DRIVE_PLAYER_SCHEME } from '../../shared/doc-drive-player'

const dir = process.env.PLAYER_TEST_DIR!
const fixtures = path.join(import.meta.dirname, '..', 'fixtures', 'video')
app.setPath('userData', path.join(dir, 'userData'))
if (process.env.PLAYER_TEST_SCHEME) {
  // The mutation runs: the player scheme with other privileges (the rest of the app's list as it is).
  const original = protocol.registerSchemesAsPrivileged.bind(protocol)
  protocol.registerSchemesAsPrivileged = list => original(list.map(s => (s.scheme === DRIVE_PLAYER_SCHEME ? { scheme: s.scheme, privileges: JSON.parse(process.env.PLAYER_TEST_SCHEME!) } : s)))
}
registerLocalFileScheme()

const result: Record<string, unknown> = {}
const writeResult = (value: unknown) => {
  const file = path.join(dir, 'result.json')
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}
const fail = (error: unknown) => {
  writeResult({ error: error instanceof Error ? error.stack : String(error), partial: result })
  app.exit(1)
}
setTimeout(() => fail(new Error('the harness timed out')), 100_000)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const SCRIPTED = 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS'
const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
/** The server's own deadline per answer (ms), applied to B's paced answers: it cuts them while the player reads slowly. */
const ANSWER_MS = Number(process.env.PLAYER_TEST_ANSWER_MS) || 1500
const drive = (id: string, rest = '/preview') => `https://drive.google.com/file/d/${id}${rest}`

/** The fixture with 3 MB of padding before its index (`moov`), as cameras write a `.mov`: the player must seek to read it. */
function indexFarAtTheEnd(file: string): Buffer {
  const data = fs.readFileSync(file)
  let at = 0
  while (at < data.length && data.toString('latin1', at + 4, at + 8) !== 'moov') at += data.readUInt32BE(at)
  if (at >= data.length) throw new Error('no moov box in the fixture')
  const pad = Buffer.alloc(3 * 1024 * 1024)
  pad.writeUInt32BE(pad.length, 0)
  pad.write('free', 4, 'latin1')
  return Buffer.concat([data.subarray(0, at), pad, data.subarray(at)])
}

/** The server's stream route, faked: ranges of at most 512 KB (a shorter 206, as the real route's ceiling), A refused until picked. */
async function fakeServer(clip: Buffer) {
  const requests: Array<{ path: string; range: string | null; cookie: string | null; status: number; closedEarly: boolean }> = []
  let picked = false
  const server = http.createServer((req, res) => {
    const entry = { path: req.url ?? '', range: (req.headers.range as string | undefined) ?? null, cookie: (req.headers.cookie as string | undefined) ?? null, status: 0, closedEarly: false }
    requests.push(entry)
    res.on('close', () => { if (!res.writableFinished) entry.closedEarly = true })
    const m = /^\/api\/companies\/c1\/me\/google\/drive\/view\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')
    const refuse = (status: number, code: string, error: string) => {
      entry.status = status
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error, code }))
    }
    if (!m) return refuse(404, 'NOT_FOUND', 'Not found')
    if (m[1] === A && !picked) return refuse(403, 'DRIVE_VIEW_NOT_PICKED', 'この動画はまだ選ばれていません。')
    if (m[1] !== A && m[1] !== B) return refuse(403, 'DRIVE_VIEW_NOT_PICKED', 'この動画はまだ選ばれていません。')
    const r = /^bytes=(\d+)-(\d*)$/.exec(entry.range ?? '')
    if (!r) return refuse(416, 'DRIVE_VIEW_RANGE_NEEDED', '範囲が必要です。')
    const start = Number(r[1])
    if (start >= clip.length) {
      entry.status = 416
      return res.writeHead(416, { 'Content-Range': `bytes */${clip.length}` }).end()
    }
    const end = Math.min(r[2] === '' ? clip.length - 1 : Number(r[2]), clip.length - 1, start + (Number(process.env.PLAYER_TEST_CHUNK) || 512 * 1024) - 1)
    entry.status = 206
    res.writeHead(206, { 'Content-Type': 'video/quicktime', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${clip.length}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' })
    // B is paced (a slow upstream): a player closed while it streams must abort it; the server's own
    // deadline per answer (as the real route's `answerMs`) cuts each answer that runs longer.
    if (m[1] === B) {
      const deadline = setTimeout(() => res.destroy(), ANSWER_MS)
      res.on('close', () => clearTimeout(deadline))
      let at = start
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return }
        const next = Math.min(at + 4096, end + 1)
        res.write(clip.subarray(at, next))
        at = next
        if (at > end) { clearInterval(timer); res.end() }
      }, 50)
      res.on('close', () => clearInterval(timer))
      return
    }
    res.end(clip.subarray(start, end + 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { requests, port, pick: () => { picked = true }, close: () => server.close() }
}

async function run() {
  const clip = indexFarAtTheEnd(path.join(fixtures, 'h264-index-at-end.mov'))
  const fake = await fakeServer(clip)
  const company = path.join(dir, 'company')
  const folder = path.join(company, '営業')
  fs.mkdirSync(folder, { recursive: true })
  // A document with two Drive embeds at known places, a decoy its script adds (an id main never read),
  // and a tall page (scrolling moves the embeds).
  fs.writeFileSync(path.join(folder, 'report.html'), `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>
<iframe id="a" src="${drive(A)}" style="position:absolute;left:100px;top:200px;width:320px;height:180px;border:0"></iframe>
<video id="b" style="position:absolute;left:460px;top:400px;width:240px;height:135px"><source src="${drive(B, '/view')}"></video>
<iframe id="c" src="${drive(C)}" style="position:absolute;left:100px;top:1500px;width:320px;height:180px;border:0"></iframe>
<div style="height:3000px"></div>
<script>const big = document.createElement('video'); big.setAttribute('src', 'https://example.invalid/' + 'x'.repeat(50 * 1024 * 1024)); big.style.cssText = 'position:absolute;left:0;top:0;width:50px;height:50px'; document.body.appendChild(big)
const d = document.createElement('iframe'); d.src = ${JSON.stringify(drive(SCRIPTED))}; d.style.cssText = 'position:absolute;left:500px;top:20px;width:200px;height:120px;border:0'; document.body.appendChild(d)</script>
</body></html>`)
  fs.writeFileSync(path.join(folder, 'other.html'), '<!doctype html><p>other</p>')
  const docFrames = createDocFrames({
    paths: { validate: p => { if (!path.resolve(p).startsWith(company + path.sep)) throw new Error('outside'); return path.resolve(p) }, rootOf: () => company },
    notDownloaded: () => [],
    log: { warn: () => {} },
  })
  const picks: string[] = []
  let redirectTo: string | null = null
  const players = createDrivePlayers({
    // The server's answers, with one page answer redirected on demand (the redirect guard).
    shell: server => createDrivePlayerShell({
      ...server,
      serve: async request => {
        if (redirectTo && /\/\?v=/.test(request.url)) { const to = redirectTo; redirectTo = null; return new Response(null, { status: 302, headers: { Location: to } }) }
        return server.serve(request)
      },
      log: { warn: () => {} },
    }),
    stream: (companyId, fileId, range, signal) => fetch(`http://127.0.0.1:${fake.port}/api/companies/${companyId}/me/google/drive/view/${fileId}`, { signal, headers: { Cookie: 'session=member', ...(range ? { Range: range } : {}) } }),
    pick: async (_companyId, fileId) => { picks.push(fileId); fake.pick(); return { ok: true, kept: true } },
    openExternal: async () => {},
  })
  const views = createDocViews({ frames: docFrames, shell: createDocViewShell({ serve: r => docFrames.serve(r), log: { warn: () => {} } }), players })
  const win = new BrowserWindow({ show: true, width: 1000, height: 760, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadURL('data:text/html,<p>app</p>')
  // Shown and focused: the keyboard focus is measured (a hidden window has none).
  for (let i = 0; i < 30 && !win.isFocused(); i++) { if (process.platform === "darwin") app.focus({ steal: true }); win.focus(); await wait(100) }
  win.focus()
  win.webContents.focus()
  const checked = await docFrames.check(path.join(folder, 'report.html'))
  if (!checked.ok) throw new Error(`check refused: ${checked.reason}`)
  const viewId = await views.open(checked.doc, views.begin(win.webContents.id), '', 'c1')
  if (viewId === null) throw new Error('no view')
  const doc = allWebContents.fromId(viewId)!
  for (let i = 0; i < 50 && (doc.isLoading() || !doc.getURL()); i++) await wait(100)
  await wait(300)
  const area = { x: 20, y: 30, width: 800, height: 600 }
  views.place(viewId, win.webContents.id, area)
  /** The players' views in the window, by the page they show. */
  const playerViews = () => win.contentView.children
    .map(v => v as unknown as { webContents: WebContents; getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean })
    .filter(v => v.webContents && !v.webContents.isDestroyed() && v.webContents.id !== viewId)
  const visibleBounds = () => playerViews().filter(v => v.getVisible()).map(v => v.getBounds()).sort((a, b) => a.x - b.x)
  // Waits on the condition itself, up to 10 s (shared CI runners are slow), then a little for the last move.
  const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await wait(50); await wait(200) }
  /** The players are exactly at these rectangles (what the test asserts), not just some of them. */
  const placedAt = (want: Array<{ x: number; y: number; width: number; height: number }>) => () => JSON.stringify(visibleBounds()) === JSON.stringify(want)
  await settle(placedAt([{ x: 120, y: 230, width: 320, height: 180 }, { x: 480, y: 430, width: 240, height: 135 }]))
  result.placedAtZoom1 = visibleBounds()
  // Scrolled by 100 px: the player follows the embed.
  await doc.executeJavaScript('window.scrollTo(0, 100)', true).catch(() => 'threw')
  await settle(placedAt([{ x: 120, y: 130, width: 320, height: 180 }, { x: 480, y: 330, width: 240, height: 135 }]))
  result.placedScrolled = visibleBounds()
  // The document's own zoom 1.5 (scrolled back to the top).
  await doc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => 'threw')
  views.zoom(viewId, win.webContents.id, 1.5)
  await settle(placedAt([{ x: 170, y: 330, width: 480, height: 270 }]))
  result.placedAtZoom15 = visibleBounds()
  views.zoom(viewId, win.webContents.id, 1)
  // Cut by the area's bottom edge: the player covers only what is inside, its video keeps its size.
  await doc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => 'threw')
  views.place(viewId, win.webContents.id, { ...area, height: 300 })
  await settle(placedAt([{ x: 120, y: 230, width: 320, height: 100 }]))
  result.placedCut = visibleBounds()
  views.place(viewId, win.webContents.id, area)
  await settle(() => visibleBounds().length === 2 && visibleBounds().some(b => b.height === 180))
  result.playerCount = playerViews().length
  result.playerUrls = playerViews().map(v => v.webContents.getURL().replace(/\/\/[0-9a-f]{32}\//, '//<token>/'))
  // Hidden with the document (an overlay of the app): every player hidden too.
  views.place(viewId, win.webContents.id, null)
  await wait(300)
  result.hiddenWithDocument = playerViews().map(v => v.getVisible())
  views.place(viewId, win.webContents.id, area)
  await settle(() => visibleBounds().length > 0)
  // A press within ACTION_GUARD_MS of a player appearing is not taken (clickjacking).
  await wait(600)

  // ［ここで再生］ on A's poster: not picked yet → the Picker (faked) → plays; seek to 80 %.
  const playerA = playerViews().find(v => v.getBounds().x === area.x + 100)!
  const pa = playerA.webContents
  result.keyboardBeforePress = { app: win.webContents.isFocused(), player: playerViews().some(v => v.webContents.isFocused()), doc: doc.isFocused(), windowFocused: win.isFocused() }
  // Pressed until it is taken (a press right after the player appeared or moved is not: clickjacking).
  for (let i = 0; i < 100 && !(await pa.executeJavaScript('!!document.querySelector("video")', true).catch(() => false)); i++) {
    if (i % 10 === 0) await pa.executeJavaScript(`document.querySelector('a[href="play"]')?.click()`, true).catch(() => 'threw')
    await wait(100)
  }
  result.picks = [...picks]
  result.played = await pa.executeJavaScript(`new Promise(resolve => {
    const v = document.querySelector('video')
    if (!v) { resolve({ ok: false, page: document.body.innerText }); return }
    v.muted = true
    const done = r => resolve(r)
    setTimeout(() => done({ ok: false, timeout: true, ready: v.readyState, code: v.error && v.error.code }), 20000)
    const seek = () => { v.pause(); const d = v.duration; v.onseeked = () => done({ ok: true, duration: d, at: v.currentTime }); v.currentTime = d * 0.8 }
    if (v.readyState >= 1) seek(); else { v.onloadedmetadata = seek; v.onerror = () => done({ ok: false, code: v.error && v.error.code }) }
  })`, true).catch(() => 'threw')
  result.streamRequests = fake.requests.filter(r => r.path.endsWith(A)).map(r => ({ range: r.range, status: r.status, cookie: r.cookie }))
  // Hidden while it plays (an overlay of the app): paused and stopped; ［続きから再生］ goes on from where it was.
  // Paused at 0.5 s (it was sought to 0.8 s above): where it is when it is hidden.
  await pa.executeJavaScript('new Promise(r => { const v = document.querySelector("video"); v.onseeked = () => r(0); v.currentTime = 0.5; setTimeout(r, 3000) })', true).catch(() => {})
  views.place(viewId, win.webContents.id, null)
  await wait(800)
  result.whileHidden = await pa.executeJavaScript('({ video: !!document.querySelector("video"), text: document.body.innerText })', true).catch(() => 'threw')
  views.place(viewId, win.webContents.id, area)
  await settle(() => visibleBounds().length >= 2)
  await wait(600)
  // Pressed until it is taken (a press right after the player appeared or moved is not: clickjacking).
  for (let i = 0; i < 100 && !(await pa.executeJavaScript('!!document.querySelector("video")', true).catch(() => false)); i++) {
    if (i % 10 === 0) await pa.executeJavaScript(`document.querySelector('a[href="play"]')?.click()`, true).catch(() => 'threw')
    await wait(100)
  }
  result.resumed = await pa.executeJavaScript(`new Promise(resolve => {
    const v = document.querySelector('video')
    if (!v) { resolve({ src: null, at: null }); return }
    v.muted = true
    const done = () => resolve({ src: v.getAttribute('src'), at: v.currentTime })
    if (v.readyState >= 1) done(); else v.onloadedmetadata = done
    setTimeout(done, 10000)
  })`, true).catch(() => 'threw')
  // Another player's page cannot reach A's video: its own CSP (media-src 'self') and the session's hook by page id.
  const playerB = playerViews().find(v => v !== playerA)!
  const aToken = /\/\/([0-9a-f]{32})\//.exec(pa.getURL())![1]
  const before = fake.requests.length
  result.otherPlayerReach = await playerB.webContents.executeJavaScript(`new Promise(resolve => { const v = document.createElement('video'); v.onloadedmetadata = () => resolve('loaded'); v.onerror = () => resolve('refused'); setTimeout(() => resolve('timeout'), 3000); v.src = '${DRIVE_PLAYER_SCHEME}://${aToken}/video'; document.body.appendChild(v) })`, true).catch(() => 'threw')
  result.otherPlayerServerRequests = fake.requests.length - before

  // Its pages loaded again and again while shown (checking, picking, playing, paused, playing): the keyboard stays the app's.
  await wait(400)
  result.keyboardAfterLoads = { app: win.webContents.isFocused(), player: playerViews().some(v => v.webContents.isFocused()), windowFocused: win.isFocused() }
  // The player's own guards: it goes only to its own page; no popup, no redirect, no permission.
  const pb = playerB.webContents
  const bUrl = pb.getURL()
  for (const to of [`${DRIVE_PLAYER_SCHEME}://${aToken}/?v=1`, 'https://example.invalid/', 'data:text/html,x', `http://127.0.0.1:${fake.port}/nav`]) {
    await pb.executeJavaScript(`location.href = ${JSON.stringify(to)}`, true).catch(() => {})
  }
  await wait(500)
  result.navigationStayed = pb.getURL() === bUrl
  const windowsBefore = BrowserWindow.getAllWindows().length
  result.popup = await pb.executeJavaScript(`window.open('https://example.invalid/') === null ? 'null' : 'window'`, true).catch(() => 'threw')
  result.windowsAfterPopup = BrowserWindow.getAllWindows().length - windowsBefore
  result.permission = await pb.executeJavaScript('Notification.requestPermission()', true).catch(() => 'threw')
  redirectTo = `${DRIVE_PLAYER_SCHEME}://${/\/\/([0-9a-f]{32})\//.exec(bUrl)![1]}/browser`
  await pb.executeJavaScript('location.reload()', true).catch(() => {})
  await wait(800)
  result.redirectFollowed = /\/browser$/.test(pb.getURL())
  // Its session lets out only a player's own address (the hook), and only it serves the scheme.
  const probesBefore = fake.requests.filter(r => r.path === '/probe').length
  result.sessionFetch = await session.fromPartition('acb-player').fetch(`http://127.0.0.1:${fake.port}/probe`).then(() => 'reached', () => 'refused')
  result.sessionFetchReached = fake.requests.filter(r => r.path === '/probe').length - probesBefore
  result.schemeServedOn = {
    player: session.fromPartition('acb-player').protocol.isProtocolHandled(DRIVE_PLAYER_SCHEME),
    document: session.fromPartition('acb-doc').protocol.isProtocolHandled(DRIVE_PLAYER_SCHEME),
    app: session.defaultSession.protocol.isProtocolHandled(DRIVE_PLAYER_SCHEME),
  }
  await pb.loadURL(bUrl.replace(/\?v=\d+/, '?v=99')).catch(() => {})
  await wait(800)

  // A player over the area (the band's row) stays above an embed's player made after it.
  views.playDriveVideo(viewId, win.webContents.id, 0)
  await wait(800)
  await doc.executeJavaScript('window.scrollTo(0, 1400)', true).catch(() => 'threw')
  await settle(() => playerViews().length === 4)
  const top = win.contentView.children.at(-1) as unknown as { webContents?: WebContents }
  result.overlayOnTop = playerViews().length === 4 && !!top.webContents && await top.webContents.executeJavaScript('!!document.querySelector(\'a[href="close"]\')', true).catch(() => 'threw')
  await wait(600)
  await top.webContents!.executeJavaScript(`document.querySelector('a[href="close"]').click()`, true).catch(() => {})
  await wait(500)
  await doc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => 'threw')
  await settle(() => visibleBounds().length >= 2)
  await wait(600)

  // B plays from a paced upstream whose answers the server cuts at its deadline: main asks again from the
  // byte not yet passed on, and the player goes on. Closing the document's view then aborts its stream.
  // Pressed until it is taken (a press right after the page's layout moved the player is not: clickjacking).
  for (let i = 0; i < 100 && !fake.requests.some(r => r.path.endsWith(B) && r.status === 206 && r.range !== 'bytes=0-0'); i++) {
    if (i % 10 === 0) await pb.executeJavaScript(`document.querySelector('a[href="play"]')?.click()`, true).catch(() => 'threw')
    await wait(100)
  }
  await wait(ANSWER_MS * 3)
  const streamingB = fake.requests.filter(r => r.path.endsWith(B) && r.range !== 'bytes=0-0')
  result.bRanges = streamingB.map(r => r.range)
  result.bAfterCuts = await pb.executeJavaScript('(() => { const v = document.querySelector("video"); return v ? { error: v.error && v.error.code, buffered: v.buffered.length ? v.buffered.end(0) : 0 } : { page: document.body.innerText } })()', true).catch(() => 'threw')
  result.bStreamingBeforeClose = streamingB.length > 0
  views.close(viewId, win.webContents.id)
  await wait(1000)
  result.bClosedEarly = streamingB.some(r => r.closedEarly)
  result.playersAfterClose = playerViews().length
  result.countsAfterClose = players.counts()
  fake.close()
  writeResult(result)
  app.exit(0)
}

void app.whenReady().then(() => run().catch(fail))
