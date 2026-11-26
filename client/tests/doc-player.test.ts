// ACB's player over a document's Google Drive videos (doc-frame.md "ACB's player over Drive embeds
// (plan 4)"), main's side without Electron: the real protocol, document registry and players, with fake
// shells (a document view whose embeds main reads, player views that record what they are told) and a
// fake stream route. Which file a player plays is main's alone — an id it read from the document's own
// bytes, or a Drive link the member pressed —; the window and the player's page only name a view and an
// index (or a link's number, or an action); each player's token is its own and goes with it; a range is
// forwarded and its 206 passed on (the server's chunks joined into the range asked); closing aborts the
// stream; players hide with the document and close on another page, a closed view, a sign-out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createDocFrames } from '../electron/features/doc-frames/protocol'
import { createDocViews, type DocViewHandle, type DocViewHooks, type DocViewPort } from '../electron/features/doc-frames/views'
import { registerDocViewsIpc } from '../electron/features/doc-frames/ipc'
import { createDrivePlayers, type DrivePlayerHooks, type DriveViewPickResult, type EmbedBox } from '../electron/features/doc-frames/players'
import { drivePlayerPage, PLAYER_PAGE_CSP } from '../electron/features/doc-frames/player-page'
import { embedPlacement, overlayPlacement, parseByteRange, parseContentRange, parseDrivePlayerUrl, drivePlayerRefusal, type DrivePlayerPlacement } from '../shared/doc-drive-player'
import type { DocViewBounds, DocViewEvent } from '../shared/doc-frame'

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const NOT_READ = 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN'
const drive = (id: string, rest = '/preview') => `https://drive.google.com/file/d/${id}${rest}`
const MAIN = 1
const OTHER_WINDOW = 2
const AREA = { x: 10, y: 20, width: 800, height: 600 }
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('a player\'s address: only its token and the page, its video or a known action', () => {
  const t = 'a'.repeat(32)
  assert.deepEqual(parseDrivePlayerUrl(`acb-drive-video://${t}/?v=3`), { token: t, kind: 'page' })
  assert.deepEqual(parseDrivePlayerUrl(`acb-drive-video://${t}/video`), { token: t, kind: 'video' })
  assert.deepEqual(parseDrivePlayerUrl(`acb-drive-video://${t}/play`), { token: t, kind: 'action', action: 'play' })
  for (const bad of [`acb-drive-video://${t}/../x`, `acb-drive-video://${t}/video/x`, `acb-drive-video://${t}/%76ideo`, `acb-drive-video://${t.slice(1)}/`, `acb-drive-video://user@${t}/`, `acb-drive-video://${t}:1/`, `acb-doc://${t}/`, `acb-drive-video://${t}/eval`]) {
    assert.equal(parseDrivePlayerUrl(bad), null, bad)
  }
})

test('the player\'s page: no network in its CSP, one script by hash, the server\'s sentence escaped', () => {
  assert.doesNotMatch(PLAYER_PAGE_CSP, /https?:|wss?:|\*|unsafe-eval|'unsafe-inline'[^;]*script/)
  assert.match(PLAYER_PAGE_CSP, /default-src 'none'/)
  assert.match(PLAYER_PAGE_CSP, /media-src 'self'/)
  assert.match(PLAYER_PAGE_CSP, /script-src 'sha256-[A-Za-z0-9+/=]+'/)
  const page = drivePlayerPage({ kind: 'error', message: '<img src=x onerror=alert(1)>', retry: true, browser: true }, false)
  assert.doesNotMatch(page, /<img/)
  assert.match(page, /ACB のプレイヤー/, 'ACB\'s mark on every page')
  assert.match(drivePlayerPage({ kind: 'poster' }, true), /href="close"/, 'a player over the area can be closed')
  assert.doesNotMatch(drivePlayerPage({ kind: 'poster' }, false), /href="close"/)
})

test('placement: over the part of the embed inside the area, the video keeping its size; cosmetic boxes that make no sense place nothing', () => {
  assert.deepEqual(embedPlacement(AREA, { x: 100, y: 50, width: 320, height: 180 }), { bounds: { x: 110, y: 70, width: 320, height: 180 }, stage: { x: 0, y: 0, width: 320, height: 180 } })
  assert.deepEqual(embedPlacement(AREA, { x: 100, y: -80, width: 320, height: 180 }), { bounds: { x: 110, y: 20, width: 320, height: 100 }, stage: { x: 0, y: -80, width: 320, height: 180 } }, 'scrolled half out at the top')
  assert.equal(embedPlacement(AREA, { x: 100, y: 700, width: 320, height: 180 }), null, 'below the area')
  for (const bad of [{ x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 5, height: 300 }, { x: 0, y: 0, width: 1e9, height: 300 }]) assert.equal(embedPlacement(AREA, bad), null)
  const over = overlayPlacement(AREA)!
  assert.ok(over.bounds.x >= AREA.x && over.bounds.y >= AREA.y && over.bounds.x + over.bounds.width <= AREA.x + AREA.width && over.bounds.y + over.bounds.height <= AREA.y + AREA.height)
  assert.equal(overlayPlacement({ x: 0, y: 0, width: 100, height: 100 }), null)
})

test('ranges: one `bytes=a-b` / `bytes=a-` and a 206\'s exact Content-Range only', () => {
  assert.deepEqual(parseByteRange('bytes=5-'), { start: 5, end: null })
  assert.deepEqual(parseByteRange('bytes=5-9'), { start: 5, end: 9 })
  for (const bad of ['bytes=-5', 'bytes=9-5', 'bytes=1-2,4-5', 'items=1-2', null]) assert.equal(parseByteRange(bad), null)
  assert.deepEqual(parseContentRange('bytes 0-9/100'), { start: 0, end: 9, size: 100 })
  for (const bad of ['bytes */100', 'bytes 5-4/100', 'bytes 0-100/100', null]) assert.equal(parseContentRange(bad), null)
})

test('the server\'s refusal is said in its own words; a file that is not a video offers no ［もう一度］', () => {
  assert.deepEqual(drivePlayerRefusal(429, { error: '今日はこれ以上再生できません。', code: 'DRIVE_VIEW_MEMBER_DAY' }), { kind: 'error', message: '今日はこれ以上再生できません。', retry: true, browser: true })
  assert.equal(drivePlayerRefusal(403, { error: '動画ではありません', code: 'DRIVE_VIEW_NOT_VIDEO' }).retry, false)
  assert.match(drivePlayerRefusal(500, null).message, /読み込めませんでした/)
})

/** A clip the fake stream route serves, at most `chunk` bytes per answer (the real route's ceiling). */
const CLIP = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251))

function world(options: { chunk?: number; picked?: Set<string>; wrongStart?: (start: number) => number } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-doc-player-')))
  const root = path.join(base, 'company')
  fs.mkdirSync(path.join(root, '営業'), { recursive: true })
  fs.writeFileSync(path.join(root, '営業/report.html'), `<iframe src="${drive(A)}"></iframe><video src="${drive(B, '/view')}"></video><a href="other.html">次</a>`)
  fs.writeFileSync(path.join(root, '営業/other.html'), '<p>other</p>')
  const paths = new AllowedRoots()
  paths.add(root)
  let tokens = 0
  const frames = createDocFrames({ paths, notDownloaded: () => [], newToken: () => (tokens++).toString(16).padStart(32, '0'), log: { warn: () => {} } })
  const hooksOf = new Map<number, DocViewHooks>()
  const shownUrl = new Map<number, string>()
  /** What each document view's page lays out (the document's own DOM: it may lie). */
  const embeds = new Map<number, EmbedBox[]>()
  const areas = new Map<number, DocViewBounds | null>()
  let next = 100
  const load = async (id: number, url: string) => {
    shownUrl.set(id, url)
    const answer = await frames.serve({ url, method: 'GET' })
    await answer.arrayBuffer()
    if (answer.status === 200) hooksOf.get(id)?.onPageStart(id, url)
  }
  const shell: DocViewPort = {
    onWindowReset: () => {},
    watch: () => {},
    async create(_windowId, hooks): Promise<DocViewHandle> {
      const id = next++
      hooksOf.set(id, hooks)
      return {
        id,
        show: url => { void load(id, url) },
        destroy: () => hooksOf.get(id)?.onGone(id),
        closeKeepingPlace: async () => null,
        place: bounds => { areas.set(id, bounds && { ...bounds }) },
        zoom: () => {},
        reload: () => { void load(id, shownUrl.get(id)!) },
        inReviewWorld: async () => null,
        releaseKeyboard: () => {},
        placedArea: () => areas.get(id) ?? null,
        readEmbeds: async () => embeds.get(id) ?? [],
      }
    },
  }
  // The players' shell: views that record where they are and what they load.
  const playerViews = new Map<number, { hooks: DrivePlayerHooks; loads: string[]; placed: DrivePlayerPlacement | null; destroyed: boolean }>()
  let nextPlayer = 500
  const streams: Array<{ companyId: string; fileId: string; range: string | null; signal: AbortSignal }> = []
  const picked = options.picked ?? new Set<string>()
  const chunk = options.chunk ?? 1000
  const picks: string[] = []
  let pickAnswer: (fileId: string) => Promise<DriveViewPickResult> = async fileId => { picked.add(fileId); return { ok: true, kept: true } }
  const opened: string[] = []
  const events: Array<[number, DocViewEvent]> = []
  const queued: Array<() => void> = []
  let server: { serve: (r: { url: string; method: string; range: string | null }) => Promise<Response>; owns: (id: number, url: string) => boolean } | null = null
  const players = createDrivePlayers({
    shell: s => {
      server = s
      return {
        async create(_windowId, hooks) {
          const id = nextPlayer++
          const view = { hooks, loads: [] as string[], placed: null as DrivePlayerPlacement | null, destroyed: false }
          playerViews.set(id, view)
          return { id, load: url => { view.loads.push(url) }, place: placement => { view.placed = placement }, destroy: () => { view.destroyed = true } }
        },
      }
    },
    stream: async (companyId, fileId, range, signal) => {
      streams.push({ companyId, fileId, range, signal })
      if (!picked.has(fileId)) return Response.json({ error: 'この動画はまだ選ばれていません。', code: 'DRIVE_VIEW_NOT_PICKED' }, { status: 403 })
      const r = parseByteRange(range)!
      const end = Math.min(r.end ?? CLIP.length - 1, CLIP.length - 1, r.start + chunk - 1)
      const said = options.wrongStart?.(r.start) ?? r.start
      return new Response(CLIP.subarray(r.start, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${said}-${end}/${CLIP.length}`, 'Content-Length': String(end - r.start + 1) } })
    },
    pick: async (_companyId, fileId) => { picks.push(fileId); return pickAnswer(fileId) },
    openExternal: async url => { opened.push(url) },
    notify: (windowId, event) => events.push([windowId, event]),
    later: (fn, ms) => { if (ms === 0) queued.push(fn); return () => {} },
  })
  const views = createDocViews({
    frames,
    shell,
    notify: (windowId, event) => events.push([windowId, event]),
    later: (fn, ms) => { if (ms === 0) queued.push(fn); return () => {} },
    players,
  })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, { frames, views, fromMainWindow: ((event: { main: boolean }) => event.main) as never, openExternal: async url => { opened.push(url) } })
  const ev = (main: boolean, windowId = MAIN) => ({ main, sender: { id: windowId } })
  const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); while (queued.length > 0) queued.shift()!() } }
  const open = async (companyId: unknown = 'c1') => {
    const result = await handlers.get('docView:open')!(ev(true), path.join(root, '営業/report.html'), companyId) as { ok: true; viewId: number }
    assert.ok(result.ok)
    await settle()
    return result.viewId
  }
  /** The document shown over the area with its embeds laid out where the page says. */
  const show = async (viewId: number, laidOut: EmbedBox[]) => {
    embeds.set(viewId, laidOut)
    await handlers.get('docView:setBounds')!(ev(true), viewId, AREA)
    await settle()
  }
  const playersOf = () => [...playerViews.entries()].filter(([, v]) => !v.destroyed)
  const press = async (playerId: number, action: Parameters<DrivePlayerHooks['onAction']>[1]) => {
    playerViews.get(playerId)!.hooks.onAction(playerId, action)
    await settle()
  }
  const page = async (playerId: number) => {
    const view = playerViews.get(playerId)!
    return (await server!.serve({ url: view.loads.at(-1)!, method: 'GET', range: null })).text()
  }
  const tokenOf = (playerId: number) => parseDrivePlayerUrl(playerViews.get(playerId)!.loads.at(-1))!.token
  return {
    root, views, players, handlers, ev, open, show, settle, playersOf, playerViews, press, page, tokenOf, streams, picks, opened, events, picked, load, shownUrl, hooksOf,
    server: () => server!,
    setPick: (fn: typeof pickAnswer) => { pickAnswer = fn },
  }
}

const box = (x: number, y: number, width = 320, height = 180) => ({ x, y, width, height })

test('a player goes over an element only when its src names an id main read itself; the page\'s layout only moves it', async () => {
  const w = world()
  const viewId = await w.open()
  await w.show(viewId, [
    // An element the document's script made, naming a file main never read: no player.
    { src: drive(NOT_READ), box: box(0, 0) },
    // The document moves A's element where it likes: A's player goes there, still playing A.
    { src: drive(A, '/view?usp=sharing'), box: box(100, 300) },
    // A second element naming A again (a lie about layout): the first one counts.
    { src: drive(A), box: box(400, 0) },
    // Not Drive's own host.
    { src: `https://docs.google.com/file/d/${B}/view`, box: box(0, 400) },
  ])
  const live = w.playersOf()
  assert.equal(live.length, 1, 'one player: A')
  assert.deepEqual(live[0][1].placed?.bounds, { x: 110, y: 320, width: 320, height: 180 })
  await w.press(live[0][0], 'play')
  assert.ok(w.streams.length > 0 && w.streams.every(s => s.fileId === A), 'it plays A, the id main read, whatever the page lays out')
  assert.ok(w.streams.every(s => s.companyId === 'c1'))
})

test('the window names a video by view and index only: the band\'s ［ACB で再生］ plays main\'s own id, for its own window\'s view only', async () => {
  const w = world({ picked: new Set([A, B]) })
  const viewId = await w.open()
  await w.show(viewId, [])
  const play = (event: unknown, view: unknown, index: unknown) => w.handlers.get('docView:playDriveVideo')!(event, view, index)
  for (const [event, view, index] of [[w.ev(false), viewId, 0], [w.ev(true, OTHER_WINDOW), viewId, 0], [w.ev(true), viewId + 1, 0], [w.ev(true), viewId, 2], [w.ev(true), viewId, '1'], [w.ev(true), viewId, 0.5], [w.ev(true), viewId, B]] as const) await play(event, view, index)
  await w.settle()
  assert.equal(w.playersOf().length, 0, 'a frame of the page, another window, another view, an index not held, an id: nothing')
  await play(w.ev(true), viewId, 1)
  await w.settle()
  const [[id, view]] = w.playersOf()
  assert.ok(view.placed && view.placed.bounds.width > 0, 'over the area')
  assert.match(await w.page(id), /href="close"/)
  await w.press(id, 'play')
  assert.ok(w.streams.every(s => s.fileId === B))
  await w.press(id, 'close')
  assert.equal(w.playersOf().length, 0)
})

test('a Drive link the member pressed: the window gets a number, never the id; only that number plays it, once, in its own window', async () => {
  const w = world({ picked: new Set([A]) })
  const viewId = await w.open()
  await w.show(viewId, [])
  w.hooksOf.get(viewId)!.onLink(viewId, drive(A, '/view?resourcekey=SECRET'))
  const link = w.events.find(([, e]) => e.kind === 'link')![1] as Extract<DocViewEvent, { kind: 'link' }>
  assert.equal(typeof link.videoLink, 'number')
  assert.doesNotMatch(JSON.stringify(link.videoLink), /AAAA/)
  await new Promise(resolve => setTimeout(resolve, 1100))
  w.hooksOf.get(viewId)!.onLink(viewId, 'https://example.com/page')
  const plain = w.events.filter(([, e]) => e.kind === 'link').at(-1)![1] as Extract<DocViewEvent, { kind: 'link' }>
  assert.equal(plain.videoLink, undefined, 'another site is no video')
  const playLink = (event: unknown, n: unknown) => w.handlers.get('docView:playLinkedVideo')!(event, viewId, n)
  await playLink(w.ev(true, OTHER_WINDOW), link.videoLink)
  await playLink(w.ev(false), link.videoLink)
  await playLink(w.ev(true), (link.videoLink ?? 0) + 1)
  await playLink(w.ev(true), A)
  await w.settle()
  assert.equal(w.playersOf().length, 0)
  await playLink(w.ev(true), link.videoLink)
  await w.settle()
  const [[id]] = w.playersOf()
  await w.press(id, 'play')
  assert.ok(w.streams.length > 0 && w.streams.every(s => s.fileId === A))
  await w.press(id, 'close')
  await playLink(w.ev(true), link.videoLink)
  await w.settle()
  assert.equal(w.playersOf().length, 0, 'a number plays once')
})

test('［ここで再生］: not picked → the Picker for that one video → plays; a cancelled pick says so and offers ［もう一度］', async () => {
  const w = world()
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  const [[id]] = w.playersOf()
  assert.match(await w.page(id), /ここで再生/)
  w.setPick(async () => ({ ok: false, reason: 'cancelled', message: '' }))
  await w.press(id, 'play')
  assert.deepEqual(w.picks, [A])
  assert.match(await w.page(id), /選ばれなかった/)
  assert.match(await w.page(id), /href="play"/)
  w.setPick(async fileId => { w.picked.add(fileId); return { ok: true, kept: true } })
  await w.press(id, 'play')
  assert.match(await w.page(id), /<video/)
  await w.press(id, 'browser')
  assert.deepEqual(w.opened, [`https://drive.google.com/file/d/${A}/view`])
})

test('the video\'s range is forwarded and its 206 passed on whole: the server\'s chunks joined in order, each asked from where the last ended', async () => {
  const w = world({ picked: new Set([A]), chunk: 1000 })
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  const [[id]] = w.playersOf()
  await w.press(id, 'play')
  const url = `acb-drive-video://${w.tokenOf(id)}/video`
  w.streams.length = 0
  const answer = await w.server().serve({ url, method: 'GET', range: 'bytes=200-' })
  assert.equal(answer.status, 206)
  assert.equal(answer.headers.get('content-range'), `bytes 200-2499/${CLIP.length}`)
  assert.equal(answer.headers.get('content-length'), '2300')
  assert.equal(answer.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await answer.arrayBuffer()), CLIP.subarray(200))
  assert.deepEqual(w.streams.map(s => s.range), ['bytes=200-', 'bytes=1200-2499', 'bytes=2200-2499'])
  const exact = await w.server().serve({ url, method: 'GET', range: 'bytes=10-19' })
  assert.equal(exact.headers.get('content-range'), `bytes 10-19/${CLIP.length}`)
  assert.deepEqual(Buffer.from(await exact.arrayBuffer()), CLIP.subarray(10, 20))
})

test('a token is its own player\'s: refused for another player\'s page, after close, and for a player not playing', async () => {
  const w = world({ picked: new Set([A, B]) })
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }, { src: drive(B), box: box(0, 300) }])
  const [[a], [b]] = w.playersOf()
  const videoA = `acb-drive-video://${w.tokenOf(a)}/video`
  assert.equal((await w.server().serve({ url: videoA, method: 'GET', range: 'bytes=0-' })).status, 404, 'a poster plays nothing')
  await w.press(a, 'play')
  assert.equal(w.server().owns(a, videoA), true)
  assert.equal(w.server().owns(b, videoA), false, 'another player\'s page')
  assert.equal((await w.server().serve({ url: videoA, method: 'POST', range: 'bytes=0-' })).status, 404)
  w.views.close(viewId, MAIN)
  assert.equal(w.server().owns(a, videoA), false)
  assert.equal((await w.server().serve({ url: videoA, method: 'GET', range: 'bytes=0-' })).status, 404, 'revoked with its player')
})

test('closing a player aborts its streams (the server releases their slots); a sign-out closes every player', async () => {
  const w = world({ picked: new Set([A]), chunk: 100 })
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  const [[a]] = w.playersOf()
  await w.press(a, 'play')
  const answer = await w.server().serve({ url: `acb-drive-video://${w.tokenOf(a)}/video`, method: 'GET', range: 'bytes=0-' })
  const reader = answer.body!.getReader()
  await reader.read()
  const live = w.streams.at(-1)!
  assert.equal(live.signal.aborted, false)
  w.players.closeAll()
  assert.equal(live.signal.aborted, true)
  assert.deepEqual(w.players.counts(), { players: 0, streams: 0 })
  assert.equal(w.playersOf().length, 0)
})

test('players hide with the document (an overlay, another tab) and close on another page of the folder, its view closed', async () => {
  const w = world()
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  const [[a, view]] = w.playersOf()
  assert.ok(view.placed)
  await w.handlers.get('docView:setBounds')!(w.ev(true), viewId, null)
  await w.settle()
  assert.equal(view.placed, null, 'hidden with the document')
  await w.handlers.get('docView:setBounds')!(w.ev(true), viewId, AREA)
  await w.settle()
  assert.ok(view.placed, 'back with it')
  const own = w.shownUrl.get(viewId)!
  await w.load(viewId, `${own.slice(0, own.lastIndexOf('/'))}/other.html`)
  await w.settle()
  assert.equal(w.playerViews.get(a)!.destroyed, true, 'another page of the folder: none of the document\'s players')
  await w.load(viewId, own)
  await w.settle()
  assert.equal(w.playersOf().length, 1, 'back on the document')
  w.views.close(viewId, MAIN)
  assert.equal(w.playersOf().length, 0)
})

test('without a company (the user manual, an older renderer) no player is made', async () => {
  const w = world()
  const viewId = await w.open('../../bad id')
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  assert.equal(w.playersOf().length, 0)
})

test('a later chunk that is not exactly the rest (another start) ends the answer with an error, never passed on as the bytes asked', async () => {
  const w = world({ picked: new Set([A]), chunk: 1000, wrongStart: start => (start === 1000 ? 900 : start) })
  const viewId = await w.open()
  await w.show(viewId, [{ src: drive(A), box: box(0, 0) }])
  const [[id]] = w.playersOf()
  await w.press(id, 'play')
  const answer = await w.server().serve({ url: `acb-drive-video://${w.tokenOf(id)}/video`, method: 'GET', range: 'bytes=0-' })
  assert.equal(answer.status, 206)
  await assert.rejects(answer.arrayBuffer())
})

test('another page of the folder closes the player over the area too (the band\'s row it played)', async () => {
  const w = world({ picked: new Set([A]) })
  const viewId = await w.open()
  await w.show(viewId, [])
  await w.handlers.get('docView:playDriveVideo')!(w.ev(true), viewId, 0)
  await w.settle()
  assert.equal(w.playersOf().length, 1)
  const own = w.shownUrl.get(viewId)!
  await w.load(viewId, `${own.slice(0, own.lastIndexOf('/'))}/other.html`)
  await w.settle()
  assert.equal(w.playersOf().length, 0)
})
