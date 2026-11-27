// Google Drive videos in an HTML document (doc-frame.md "The band of blocked internet parts (A3)",
// plan A): main reads them from the exact bytes it serves for the view's own document — only the
// static `src` of <video>, <source> and <iframe>, only https://drive.google.com file links (the core's
// rule) — keeps the ids, tells the window counts only, and opens Drive's own page for a row in the
// member's browser, built from the id: never the page's own address, never for another window, a frame
// inside the page, an unknown view or an index it does not hold. Nothing new reaches the view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createDocFrames } from '../electron/features/doc-frames/protocol'
import { createDocViews, type DocViewHandle, type DocViewHooks, type DocViewPort } from '../electron/features/doc-frames/views'
import { registerDocViewsIpc } from '../electron/features/doc-frames/ipc'
import { DOC_DRIVE_VIDEOS_MAX, driveVideoIdsOf, driveVideoViewUrl } from '../shared/doc-drive-videos'
import { docFrameCsp, docFramePolicy, type DocViewEvent } from '../shared/doc-frame'
import { makeTempDir } from '../../shared/testing/temp-dirs'

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const E = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'
const file = (id: string, rest = '/view') => `https://drive.google.com/file/d/${id}${rest}`
const ids = (html: string) => driveVideoIdsOf(html).ids

test('Drive videos are read from the static src of <video>, <source> and <iframe> only, as the parser reads attributes', () => {
  assert.deepEqual(ids(`<video src="${file(A)}"></video>`), [A])
  assert.deepEqual(ids(`<VIDEO controls><SOURCE type=video/mp4 SRC='${file(B, '/view?usp=sharing')}'></VIDEO>`), [B], 'names in any case, single quotes')
  assert.deepEqual(ids(`<iframe width=640 src=${file(C, '/preview')} allow=autoplay></iframe>`), [C], 'Drive\'s 埋め込む player, unquoted')
  assert.deepEqual(ids(`<video src="https://drive.google.com/uc?export=download&amp;id=${A}">`), [A], '&amp; in the address')
  assert.deepEqual(ids(`<video\nsrc = "${file(A)}"\n>`), [A], 'spaces and line breaks around =')
  assert.deepEqual(ids(`<video title="a > b" src="${file(A)}">`), [A], 'a > inside a quoted value does not end the tag')
  assert.deepEqual(ids(`<video src="${file(A)}" src="${file(B)}">`), [A], 'the first src counts, as in the browser')
  // Not videos of the page: links (they go through the link confirmation), images, other attributes, other tags.
  assert.deepEqual(ids(`<a href="${file(A)}">動画</a>`), [])
  assert.deepEqual(ids(`<img src="${file(A)}">`), [])
  assert.deepEqual(ids(`<video poster="${file(A)}" data-src="${file(B)}"></video>`), [])
  assert.deepEqual(ids(`<videox src="${file(A)}"><embed src="${file(B)}"><object data="${file(C)}">`), [])
  assert.deepEqual(ids(`<p>${file(A)}</p>`), [], 'an address in the text')
  // Static only: markup in comments, scripts and inert templates is not the page's.
  assert.deepEqual(ids(`<!-- <video src="${file(A)}"> --><script>const v = '<video src="${file(B)}">'</script><template><iframe src="${file(C)}"></iframe></template>`), [])
  assert.deepEqual(ids(`<SCRIPT>x('</scriptx><video src="${file(A)}">')</Script ><video src="${file(B)}">`), [B], 'the script ends at its own end tag only')
  assert.deepEqual(ids(`<iframe src="${file(A, '/preview')}"><video src="${file(B)}"></iframe>`), [A], 'an iframe\'s content is text, its src is read')
  assert.deepEqual(ids(`<noembed><video src="${file(A)}"></noembed><noframes><video src="${file(B)}"></noframes><video src="${file(C)}">`), [C])
  assert.deepEqual(ids(`<plaintext><video src="${file(A)}">`), [], 'plaintext runs to the end')
  assert.deepEqual(ids(`<!--><video src="${file(A)}"><!---><video src="${file(B)}"><!-- --><video src="${file(C)}">`), [A, B, C], '<!--> and <!---> end at once')
})

test('only https Drive file links on exactly drive.google.com: look-alike hosts, http, a port, user-info, folders and Docs are not', () => {
  for (const bad of [
    `http://drive.google.com/file/d/${A}/view`,
    `https://drive.google.com.evil.example/file/d/${A}/view`,
    `https://evil.example/drive.google.com/file/d/${A}/view`,
    `https://drive-google.com/file/d/${A}/view`,
    `https://drive.google.co/file/d/${A}/view`,
    `https://drive.google.com./file/d/${A}/view`,
    `https://xn--drive-google-com.example/file/d/${A}/view`,
    `https://drive.google.com:8443/file/d/${A}/view`,
    `https://user@drive.google.com/file/d/${A}/view`,
    `https://user:pw@drive.google.com/file/d/${A}/view`,
    `https://docs.google.com/file/d/${A}/view`,
    `https://docs.google.com/presentation/d/${A}/edit`,
    `https://drive.google.com/drive/folders/${A}`,
    `https://drive.google.com/file/d/short/view`,
    `https://drive.google.com/file/d/${A}%2F..%2Fx/view`,
    `//drive.google.com/file/d/${A}/view`,
    `javascript:'https://drive.google.com/file/d/${A}/view'`,
  ]) assert.deepEqual(ids(`<video src="${bad}"></video>`), [], bad)
})

test('each video once, in the order written, at most DOC_DRIVE_VIDEOS_MAX; total counts every different one', () => {
  const many = Array.from({ length: DOC_DRIVE_VIDEOS_MAX + 3 }, (_, i) => `ID${String(i).padStart(2, '0')}xxxxxxxxxxxxxxxxxxxxxxxx`)
  const html = [B, A, B, ...many, A].map(id => `<iframe src="${file(id, '/preview')}"></iframe>`).join('\n')
  const found = driveVideoIdsOf(html)
  assert.equal(found.ids.length, DOC_DRIVE_VIDEOS_MAX)
  assert.deepEqual(found.ids.slice(0, 3), [B, A, many[0]])
  assert.equal(found.total, many.length + 2)
  assert.deepEqual(driveVideoIdsOf('<p>nothing</p>'), { ids: [], total: 0 })
})

test('one linear pass: a 20 MB page of tags, unclosed quotes, script end look-alikes or bare < is read quickly', () => {
  const MB20 = 20 * 1024 * 1024
  const fill = (unit: string) => unit.repeat(Math.ceil(MB20 / unit.length)).slice(0, MB20)
  const pages = [
    fill(`<video src="${file(A)}"><source src=x>`),
    fill('<a b c d e f g h i j k l m n o p q r s t u v w x y z '),
    fill('<<<<<<<<<<<<<<<<'),
    `<script>${fill('</ </s </scrip')}`,
    `<video src="${fill('x')}`,
    `<video ${fill('a=b ')}`,
    fill('<!--'),
  ]
  for (const html of pages) {
    const started = performance.now()
    driveVideoIdsOf(html)
    const took = performance.now() - started
    assert.ok(took < 2000, `${html.slice(0, 20)}…: ${Math.round(took)} ms`)
  }
})

test('the address opened is Drive\'s own page for the id, built from the id alone', () => {
  assert.equal(driveVideoViewUrl(A), `https://drive.google.com/file/d/${A}/view`)
  for (const bad of ['', 'short', `${A}/../x`, `${A}?x=1`, `${A}#x`, 'a b c d e f g h']) assert.equal(driveVideoViewUrl(bad), null, bad)
})

test('the view\'s policy still names no network source (nothing is loaded for a Drive video)', () => {
  const csp = docFrameCsp(docFramePolicy('a'.repeat(32)))
  assert.doesNotMatch(csp, /https?:|wss?:|google|\*/)
  assert.match(csp, /media-src 'none'/)
  assert.match(csp, /frame-src 'none'/)
})

// Main: the real protocol and registry, with a fake shell whose views load what they are shown the way
// Chromium does (a GET through the protocol), so the list comes from the bytes served.
const MAIN = 1
const OTHER_WINDOW = 2

function world() {
  const base = fs.realpathSync(makeTempDir('acb-doc-drive-'))
  const root = path.join(base, 'company')
  const write = (rel: string, content: string) => {
    const target = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  write('営業/report.html', `<video src="${file(A, '/view?usp=sharing&resourcekey=SECRET')}"></video><iframe src="${file(B, '/preview')}"></iframe><a href="other.html">次</a>`)
  write('営業/other.html', `<video src="${file(C)}"></video>`)
  write('営業/style.css', `/* <video src="${file(C)}"> */`)
  const paths = new AllowedRoots()
  paths.add(root)
  let tokens = 0
  const frames = createDocFrames({ paths, notDownloaded: () => [], newToken: () => (tokens++).toString(16).padStart(32, '0'), log: { warn: () => {} } })
  const hooksOf = new Map<number, DocViewHooks>()
  const shownUrl = new Map<number, string>()
  let next = 100
  /** A page navigation (`did-navigate` after its answer), or a part of the page (`navigate: false`: a style). */
  const load = async (id: number, url: string, navigate = true) => {
    if (navigate) shownUrl.set(id, url)
    const answer = await frames.serve({ url, method: 'GET' })
    await answer.arrayBuffer()
    if (answer.status === 200 && navigate) hooksOf.get(id)?.onPageStart(id, url)
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
        place: () => {},
        zoom: () => {},
        reload: () => { void load(id, shownUrl.get(id)!) },
        inReviewWorld: async () => null,
        releaseKeyboard: () => {},
      }
    },
  }
  const events: Array<[number, DocViewEvent]> = []
  // Main's deferred work runs when the test lets it (`flush`): a read never happens on the request's path.
  const queued: Array<() => void> = []
  const reads = { count: 0 }
  const views = createDocViews({
    frames,
    shell,
    notify: (windowId, event) => events.push([windowId, event]),
    later: fn => { queued.push(fn); return () => {} },
    readDriveVideos: html => { reads.count++; return driveVideoIdsOf(html) },
  })
  const flush = () => { while (queued.length > 0) queued.shift()!() }
  const opened: string[] = []
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, {
    frames,
    views,
    fromMainWindow: ((event: { main: boolean }) => event.main) as never,
    openExternal: async url => { opened.push(url) },
  })
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); flush() }
  const open = async (windowId = MAIN) => {
    const result = await handlers.get('docView:open')!({ main: true, sender: { id: windowId } }, path.join(root, '営業/report.html')) as { ok: true; viewId: number }
    assert.ok(result.ok)
    await settle()
    return result.viewId
  }
  const ev = (main: boolean, windowId = MAIN) => ({ main, sender: { id: windowId } })
  const openVideo = async (event: unknown, viewId: unknown, index: unknown) => { await handlers.get('docView:openDriveVideo')!(event, viewId, index) }
  const videoEvents = () => events.filter(([, e]) => e.kind === 'driveVideos')
  return { root, write, frames, views, events, videoEvents, opened, open, ev, openVideo, settle, flush, reads, shownUrl, hooksOf, load }
}

test('main reads the videos from its own document as served and tells its window counts only', async () => {
  const w = world()
  const viewId = await w.open()
  assert.deepEqual(w.videoEvents(), [[MAIN, { viewId, kind: 'driveVideos', count: 2, total: 2, seen: 2 }]])
  assert.doesNotMatch(JSON.stringify(w.events), /AAAA|BBBB|drive\.google|SECRET/, 'no id or address leaves main')
})

test('docView:openDriveVideo opens only the canonical Drive page of a held id, for the main window\'s main frame and the view\'s own window', async () => {
  const w = world()
  const viewId = await w.open()
  await w.openVideo(w.ev(false), viewId, 0)
  assert.deepEqual(w.opened, [], 'a frame inside the page, or another window')
  await w.openVideo(w.ev(true, OTHER_WINDOW), viewId, 0)
  assert.deepEqual(w.opened, [], 'a view of another window')
  for (const bad of [999, viewId + 1, '100', null]) await w.openVideo(w.ev(true), bad, 0)
  assert.deepEqual(w.opened, [], 'an unknown view')
  for (const bad of [2, -1, 1.5, '0', NaN, null]) await w.openVideo(w.ev(true), viewId, bad)
  assert.deepEqual(w.opened, [], 'an index the view does not hold')
  await w.openVideo(w.ev(true), viewId, 0)
  await w.openVideo(w.ev(true), viewId, 1)
  assert.deepEqual(w.opened, [`https://drive.google.com/file/d/${A}/view`, `https://drive.google.com/file/d/${B}/view`], 'Drive\'s own page, not the address the page wrote (its query, its key)')
  w.views.close(viewId, MAIN)
  await w.openVideo(w.ev(true), viewId, 0)
  assert.equal(w.opened.length, 2, 'a closed view opens nothing')
})

test('every serve of its document reads it again (an auto refresh): a new video is told with seen grown; the same file says nothing', async () => {
  const w = world()
  const viewId = await w.open()
  const reload = async () => { w.views.reload(viewId, MAIN); await w.settle() }
  await reload()
  assert.equal(w.videoEvents().length, 1, 'the same file served again tells nothing')
  w.write('営業/report.html', `<iframe src="${file(B, '/preview')}"></iframe>`)
  await reload()
  assert.deepEqual(w.videoEvents().at(-1)![1], { viewId, kind: 'driveVideos', count: 1, total: 1, seen: 2 })
  await w.openVideo(w.ev(true), viewId, 1)
  assert.deepEqual(w.opened, [], 'the list is the one last served')
  w.write('営業/report.html', `<iframe src="${file(B, '/preview')}"></iframe><video src="${file(C)}"></video>`)
  await reload()
  assert.deepEqual(w.videoEvents().at(-1)![1], { viewId, kind: 'driveVideos', count: 2, total: 2, seen: 3 })
  await w.openVideo(w.ev(true), viewId, 1)
  assert.deepEqual(w.opened, [`https://drive.google.com/file/d/${C}/view`])
})

test('another page of the folder (or a style of it) is never read; while it is shown no video is listed, back on the document they are', async () => {
  const w = world()
  const viewId = await w.open()
  const own = w.shownUrl.get(viewId)!
  const style = `${own.slice(0, own.lastIndexOf('/'))}/style.css`
  await w.load(viewId, style, false)
  w.flush()
  assert.equal(w.videoEvents().length, 1, 'a served style is not the document')
  const other = `${own.slice(0, own.lastIndexOf('/'))}/other.html`
  await w.load(viewId, other)
  w.flush()
  assert.deepEqual(w.videoEvents().at(-1)![1], { viewId, kind: 'driveVideos', count: 0, total: 0, seen: 2 }, 'the document\'s videos are not offered over page B, nor B\'s read')
  await w.openVideo(w.ev(true), viewId, 0)
  assert.deepEqual(w.opened, [])
  await w.load(viewId, own)
  w.flush()
  assert.deepEqual(w.videoEvents().at(-1)![1], { viewId, kind: 'driveVideos', count: 2, total: 2, seen: 2 })
})

test('a closed view is told nothing more', async () => {
  const w = world()
  const viewId = await w.open()
  const own = w.shownUrl.get(viewId)!
  w.views.close(viewId, MAIN)
  const before = w.events.length
  w.write('営業/report.html', `<video src="${file(C)}"></video>`)
  await w.load(viewId, own)
  w.flush()
  assert.equal(w.events.length, before)
})

test('the document is read after its answer went, once per file version, one read at a time: asking for itself as an image or a frame reads nothing more', async () => {
  const w = world()
  const viewId = await w.open()
  assert.equal(w.reads.count, 1)
  const own = w.shownUrl.get(viewId)!
  // The page asks for itself as an image (in a loop) and as a frame: the same file, nothing read again.
  for (let i = 0; i < 5; i++) await w.load(viewId, `${own}?${i}`, false)
  w.flush()
  assert.equal(w.reads.count, 1)
  assert.equal(w.videoEvents().length, 1)
  // A changed file: the answer comes first, the read after it.
  w.write('営業/report.html', `<video src="${file(C)}"></video>`)
  await w.load(viewId, own)
  assert.equal(w.reads.count, 1, 'not on the request\'s path')
  w.flush()
  assert.equal(w.reads.count, 2)
  // Changed three times while a read waits: the one under way, then only the newest.
  w.write('営業/report.html', `<video src="${file(A)}"></video>`)
  await w.load(viewId, own, false)
  w.write('営業/report.html', `<video src="${file(B)}"></video><!-- longer -->`)
  await w.load(viewId, own, false)
  w.write('営業/report.html', `<video src="${file(B)}"></video><video src="${file(C)}"></video>`)
  await w.load(viewId, own, false)
  w.flush()
  assert.equal(w.reads.count, 4)
  await w.openVideo(w.ev(true), viewId, 1)
  assert.deepEqual(w.opened, [`https://drive.google.com/file/d/${C}/view`], 'the newest file\'s list')
})

test('the document asked for from another page of the folder does not bring its videos back there; back on the document they are offered again', async () => {
  const w = world()
  const viewId = await w.open()
  const own = w.shownUrl.get(viewId)!
  await w.load(viewId, `${own.slice(0, own.lastIndexOf('/'))}/other.html`)
  w.flush()
  assert.equal(w.videoEvents().at(-1)![1].count, 0)
  // Page B asks for the document (an image, a frame) — also a changed one, which is read.
  w.write('営業/report.html', `<video src="${file(C)}"></video>`)
  await w.load(viewId, `${own}?from-b`, false)
  w.flush()
  assert.equal(w.reads.count, 2)
  assert.equal(w.videoEvents().at(-1)![1].count, 0, 'nothing offered over page B')
  await w.openVideo(w.ev(true), viewId, 0)
  assert.deepEqual(w.opened, [], 'nor opened from it')
  await w.load(viewId, own)
  w.flush()
  assert.deepEqual(w.videoEvents().at(-1)![1], { viewId, kind: 'driveVideos', count: 1, total: 1, seen: 3 })
  await w.openVideo(w.ev(true), viewId, 0)
  assert.deepEqual(w.opened, [`https://drive.google.com/file/d/${C}/view`])
})

test('a listener that throws never stops the document being served', async () => {
  const w = world()
  const viewId = await w.open()
  w.frames.onDocumentServed(() => { throw new Error('boom') })
  const answer = await w.frames.serve({ url: w.shownUrl.get(viewId)!, method: 'GET' })
  assert.equal(answer.status, 200)
})

test('a blocked Drive embed of one of the document\'s own videos is not counted as a missing internet part (ACB\'s player shows it); any other Drive file or host still is', async () => {
  const w = world()
  const viewId = await w.open()
  const hooks = w.hooksOf.get(viewId)!
  const blockedCounts = () => w.events.filter(([, e]) => e.kind === 'blocked').map(([, e]) => (e as { count: number }).count)
  hooks.onBlocked(viewId, file(B, '/preview'))
  hooks.onBlocked(viewId, file(A, '/view?usp=sharing'))
  assert.deepEqual(blockedCounts(), [], 'the document\'s own Drive videos are ACB\'s player\'s')
  hooks.onBlocked(viewId, file(C, '/preview'))
  hooks.onBlocked(viewId, 'https://cdn.example/lib.js')
  w.flush()
  assert.equal(blockedCounts().at(-1), 2, 'a Drive file the document does not embed, and another host, are counted')
  // While the document is being read again (an auto refresh after an edit), a Drive embed waits for the
  // read; then only what the document does not embed is counted (a page load starts a new tally).
  w.write('営業/report.html', `<iframe src="${file(A, '/preview')}"></iframe><iframe src="${file(E, '/preview')}"></iframe><p>直しました</p>`)
  await w.load(viewId, w.shownUrl.get(viewId)!)
  const before = blockedCounts().length
  hooks.onBlocked(viewId, file(E, '/preview'))
  hooks.onBlocked(viewId, file('DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', '/preview'))
  assert.equal(blockedCounts().length, before, 'nothing counted while the document is still being read')
  w.flush()
  assert.equal(blockedCounts().at(-1), 1, 'after the read: the video the edit added is not counted, another Drive file is')
})

test('Chromium reports a refused Drive frame by its origin alone: not counted when the document embeds Drive videos — also when it arrives before main has read the document — and counted when it embeds none', async () => {
  const blockedCounts = (w: ReturnType<typeof world>) => w.events.filter(([, e]) => e.kind === 'blocked').map(([, e]) => (e as { count: number }).count)
  // Measured (Electron 45): an <iframe src=".../file/d/<id>/preview"> refused by the CSP arrives as
  // `https://drive.google.com`, while the page's answer is parsed — before main has read the bytes.
  const w = world()
  const serve = w.frames.serve.bind(w.frames)
  let early = true
  w.frames.serve = async request => {
    if (early) { early = false; for (const [id, hooks] of w.hooksOf) hooks.onBlocked(id, 'https://drive.google.com') }
    return serve(request)
  }
  const viewId = await w.open()
  w.hooksOf.get(viewId)!.onBlocked(viewId, 'https://drive.google.com/')
  w.flush()
  assert.deepEqual(blockedCounts(w), [], 'the document\'s own embed is ACB\'s player\'s, before and after the read')
  w.hooksOf.get(viewId)!.onBlocked(viewId, 'https://cdn.example/lib.js')
  w.flush()
  assert.equal(blockedCounts(w).at(-1), 1, 'another host still counts')

  const none = world()
  none.write('営業/report.html', '<p>動画なし</p>')
  const plain = await none.open()
  none.hooksOf.get(plain)!.onBlocked(plain, 'https://drive.google.com')
  none.flush()
  assert.equal(blockedCounts(none).at(-1), 1, 'a document with no Drive video: a Drive frame is a missing part')
})
