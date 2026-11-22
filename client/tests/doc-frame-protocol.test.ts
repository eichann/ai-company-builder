// acb-doc:// (the HTML viewer, .claude/rules/doc-frame.md): a grant reaches only regular files
// inside the opened document's own folder — never `..` (also encoded), hidden names, links, another
// repository (a private folder's clone), a folder this computer did not download, a file over
// 20 MB, a type that is not served, a file swapped in while the request runs — every refusal is the
// same 404 that names nothing, and every answer carries the CSP with no network source. A grant
// belongs to one view and goes with it; the IPC opens views for the main window only, before any
// file is looked at.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createDocFrames, type DocFrameDeps } from '../electron/features/doc-frames/protocol'
import { createDocViews, MAX_VIEWS_PER_WINDOW, type DocViewHandle, type DocViewHooks, type DocViewPort, LINK_INTERVAL_MS } from '../electron/features/doc-frames/views'
import { registerDocViewsIpc } from '../electron/features/doc-frames/ipc'
import {
  docFrameCsp, docFramePolicy, docFileType, docSessionRequestAllowed, docViewBounds, docViewNavigationAllowed, docViewOnScreen, parseDocFrameUrl, DOC_MAX_FILE_BYTES,
} from '../shared/doc-frame'

const quiet = { warn: () => {} }
const TOKEN = 'a'.repeat(32)
const MAIN = 1

function world(options: { notDownloaded?: string[] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-doc-frame-')))
  const root = path.join(base, 'company')
  const write = (rel: string, content: string | Buffer = 'x') => {
    const target = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    return target
  }
  write('営業/report.html', '<!doctype html><link rel=stylesheet href=style.css><img src=images/graph.png>')
  write('営業/style.css', 'body{}')
  write('営業/images/graph.png', 'PNG')
  write('営業/資料.png', 'PNG')
  write('営業/data.json', '{}')
  write('営業/notes.md', '# x')
  write('営業/.hidden/x.png', 'PNG')
  write('営業/.secret.png', 'PNG')
  write('営業/sub/.git/config', '[core]')
  write('営業/sub/inner.png', 'PNG')
  write('営業/private/.git/HEAD', 'ref: refs/heads/main')
  write('営業/private/a.png', 'PNG')
  write('営業/notdl/x.png', 'PNG')
  write('営業/ガイド/x.png', 'PNG')
  write('営業/hard.png', 'PNG')
  fs.linkSync(path.join(root, '営業/hard.png'), path.join(root, 'other-hard.png'))
  write('other/secret.png', 'SECRET')
  fs.symlinkSync('../other/secret.png', path.join(root, '営業/link.png'))
  fs.symlinkSync('../other', path.join(root, '営業/linkdir'))
  fs.symlinkSync(path.join(root, 'other'), path.join(root, '営業/images/abs'))
  // A named pipe would hold the read forever.
  if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(root, '営業/pipe.png')])
  // Links that stay inside the folder are refused too: no link is ever followed.
  fs.symlinkSync('images', path.join(root, '営業/alias'))
  fs.symlinkSync('images/graph.png', path.join(root, '営業/alias.png'))
  // A large file without writing 20 MB (sparse).
  const big = write('営業/big.png', '')
  fs.truncateSync(big, DOC_MAX_FILE_BYTES + 1)
  write('営業/big.html', '')
  fs.truncateSync(path.join(root, '営業/big.html'), DOC_MAX_FILE_BYTES + 1)
  write('営業/.hidden.html', '<p>')
  write('.git/report.html', '<p>')
  write('notdl/doc.html', '<p>')
  fs.symlinkSync('report.html', path.join(root, '営業/linked.html'))
  write('other/plain.html', '<p>')
  write('top.html', '<p>')

  const paths = new AllowedRoots()
  paths.add(root)
  let tokens = 0
  const deps: DocFrameDeps = {
    paths,
    notDownloaded: () => options.notDownloaded ?? ['営業/notdl', 'notdl'],
    newToken: () => (tokens++).toString(16).padStart(32, '0'),
    log: quiet,
  }
  const frames = createDocFrames(deps)
  const open = async (rel: string, owner = MAIN) => {
    const checked = await frames.check(path.join(root, ...rel.split('/')))
    assert.ok(checked.ok, `${rel}: ${JSON.stringify(checked)}`)
    return frames.grant(checked.doc, owner)
  }
  const get = async (url: string) => {
    const r = await frames.serve({ url, method: 'GET' })
    return { status: r.status, text: await r.text(), headers: r.headers }
  }
  /** The address of a file under the grant's folder, with each name encoded as Chromium would. */
  const under = (docUrl: string, ...names: string[]) => `${docUrl.slice(0, docUrl.lastIndexOf('/'))}/${names.map(encodeURIComponent).join('/')}`
  return { base, root, deps, frames, open, get, under }
}

const NOT_FOUND = { status: 404, text: 'Not found' }
const refusedAs = async (w: ReturnType<typeof world>, url: string) => {
  const r = await w.get(url)
  assert.deepEqual({ status: r.status, text: r.text }, NOT_FOUND, url)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
}

test('the address grammar: only plain names under a token, one decoding, nothing hidden', () => {
  assert.deepEqual(parseDocFrameUrl(`acb-doc://${TOKEN}/a/b.png?v=3#x`), { token: TOKEN, segments: ['a', 'b.png'] })
  assert.deepEqual(parseDocFrameUrl(`acb-doc://${TOKEN}/%E8%B3%87%E6%96%99.png`), { token: TOKEN, segments: ['資料.png'] })
  // A literal % that was encoded once is a name; it is decoded once only.
  assert.deepEqual(parseDocFrameUrl(`acb-doc://${TOKEN}/100%25.png`), { token: TOKEN, segments: ['100%.png'] })
  assert.deepEqual(parseDocFrameUrl(`acb-doc://${TOKEN}/%252e%252e/x.png`), { token: TOKEN, segments: ['%2e%2e', 'x.png'] })
  for (const bad of [
    `acb-doc://${TOKEN}/../x.png`, `acb-doc://${TOKEN}/a/../../x.png`, `acb-doc://${TOKEN}/%2e%2e/x.png`,
    `acb-doc://${TOKEN}/%2E%2e/x.png`, `acb-doc://${TOKEN}/./x.png`, `acb-doc://${TOKEN}/%2e/x.png`,
    `acb-doc://${TOKEN}/a%2f..%2fx.png`, `acb-doc://${TOKEN}/a%5cx.png`, `acb-doc://${TOKEN}/a\\x.png`,
    `acb-doc://${TOKEN}//etc/passwd`, `acb-doc://${TOKEN}/a//x.png`, `acb-doc://${TOKEN}/`,
    `acb-doc://${TOKEN}/.git/config`, `acb-doc://${TOKEN}/%2egit/config`, `acb-doc://${TOKEN}/a/.claude/x.js`,
    `acb-doc://${TOKEN}/.backups/x.html`, `acb-doc://${TOKEN}/x%00.png`, `acb-doc://${TOKEN}/%E0%A4%A.png`,
    `acb-doc://${TOKEN}`, `acb-doc://user@${TOKEN}/x.png`, `acb-doc://${TOKEN}:80/x.png`, `acb-doc://${TOKEN.toUpperCase()}/x.png`,
    `acb-doc://abc/x.png`, `acb-doc://${TOKEN}0/x.png`, `acb-plugin://${TOKEN}/x.png`, `file:///etc/passwd`,
  ]) assert.equal(parseDocFrameUrl(bad), null, bad)
})

test('the default policy names no network source, and the CSP closes every other way out', () => {
  const policy = docFramePolicy(TOKEN)
  const all = [policy.scriptSources, policy.styleSources, policy.imgSources, policy.fontSources, policy.mediaSources, policy.frameSources].flat()
  for (const source of all) assert.match(source, /^(acb-doc:\/\/a{32}|'unsafe-inline'|data:|blob:)$/, source)
  const csp = docFrameCsp(policy)
  assert.doesNotMatch(csp, /https?:|wss?:|\*|'self'|'unsafe-eval'/)
  const directives = new Map(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  assert.deepEqual(directives.get('default-src'), ["'none'"])
  for (const name of ['connect-src', 'frame-src', 'child-src', 'worker-src', 'object-src', 'manifest-src', 'form-action', 'base-uri', 'media-src']) {
    assert.deepEqual(directives.get(name), ["'none'"], name)
  }
  assert.deepEqual(directives.get('script-src'), [`acb-doc://${TOKEN}`, "'unsafe-inline'"])
  assert.deepEqual(directives.get('img-src'), [`acb-doc://${TOKEN}`, 'data:', 'blob:'])
  assert.deepEqual(directives.get('sandbox'), ['allow-scripts'])
})

test('served types: pages, styles, scripts, images, fonts; never data or anything else', () => {
  for (const [name, type] of [['a.HTML', 'text/html; charset=utf-8'], ['a.css', 'text/css; charset=utf-8'], ['a.js', 'text/javascript; charset=utf-8'], ['a.svg', 'image/svg+xml'], ['a.woff2', 'font/woff2']]) {
    assert.equal(docFileType(name), type, name)
  }
  for (const name of ['a.md', 'a.json', 'a.csv', 'a.txt', 'a.env', 'a', 'a.html.bak', 'toString', 'a.__proto__', 'a.constructor']) assert.equal(docFileType(name), null, name)
})

test('the document, its styles and images in its own folder (and below) are served with the CSP', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  assert.match(doc, /^acb-doc:\/\/[0-9a-f]{32}\/report\.html$/)
  assert.doesNotMatch(doc, new RegExp(w.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the address carries no absolute path')
  const page = await w.get(doc)
  assert.equal(page.status, 200)
  assert.match(page.text, /style\.css/)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('content-security-policy'), docFrameCsp(docFramePolicy(new URL(doc).host)))
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(page.headers.get('x-dns-prefetch-control'), 'off')
  assert.equal((await w.get(w.under(doc, 'style.css'))).headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal((await w.get(`${w.under(doc, 'images', 'graph.png')}?v=2`)).text, 'PNG')
  assert.equal((await w.get(w.under(doc, '資料.png'))).status, 200)
})

test('a request never leaves the document\'s folder: traversal, links, hidden names, data files', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  const folder = doc.slice(0, doc.lastIndexOf('/'))
  for (const url of [
    `${folder}/%2e%2e/other/secret.png`, `${folder}/..%2fother%2fsecret.png`, `${folder}/link.png`,
    `${folder}/linkdir/secret.png`, `${folder}/images/abs/secret.png`, `${folder}/.hidden/x.png`, `${folder}/.secret.png`,
    `${folder}/data.json`, `${folder}/notes.md`, `${folder}/missing.png`, `${folder}/images`, `${folder}/hard.png`,
    `${folder}/alias/graph.png`, `${folder}/alias.png`, `${folder}/pipe.png`,
  ]) await refusedAs(w, url)
})

test('another repository below the folder (a private folder\'s clone) is never entered, for its readers too', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  await refusedAs(w, w.under(doc, 'private', 'a.png'))
  await refusedAs(w, w.under(doc, 'sub', 'inner.png'))
})

test('a folder this computer did not download is refused, whatever its spelling (case, NFC / NFD)', async () => {
  for (const [spelling, folder] of [['営業/notdl', 'notdl'], ['営業/NOTDL', 'notdl'], ['営業/ガイド'.normalize('NFD'), 'ガイド']]) {
    const w = world({ notDownloaded: [spelling] })
    const doc = await w.open('営業/report.html')
    assert.equal((await w.get(w.under(doc, folder, 'x.png'))).status, 404, spelling)
    assert.equal((await w.get(w.under(doc, 'style.css'))).status, 200)
  }
  // The control: without the exclusion the same file is served.
  const w = world({ notDownloaded: [] })
  assert.equal((await w.get(w.under(await w.open('営業/report.html'), 'ガイド', 'x.png'))).status, 200)
})

test('a file over 20 MB is not served', async () => {
  const w = world()
  await refusedAs(w, w.under(await w.open('営業/report.html'), 'big.png'))
})

test('a wrong token or a revoked grant serves nothing; revoking one view leaves another\'s', async () => {
  const w = world()
  const doc = await w.open('営業/report.html', 10)
  const other = await w.open('営業/report.html', 11)
  assert.notEqual(doc, other)
  await refusedAs(w, `acb-doc://${'f'.repeat(32)}${new URL(doc).pathname}`)
  w.frames.revoke(10)
  await refusedAs(w, doc)
  assert.equal((await w.get(other)).status, 200)
})

test('a grant revoked while its file is read answers nothing', async () => {
  const w = world()
  let doc = ''
  let closeDuring = false
  w.deps.notDownloaded = () => { if (closeDuring) w.frames.revoke(MAIN); return [] }
  doc = await w.open('営業/report.html')
  closeDuring = true
  await refusedAs(w, doc)
})

test('a folder swapped for a link after opening serves nothing', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  fs.renameSync(path.join(w.root, '営業'), path.join(w.root, '営業-moved'))
  fs.symlinkSync(path.join(w.root, '営業-moved'), path.join(w.root, '営業'))
  await refusedAs(w, doc)
})

test('every refusal is the same answer: no folder or file name in it', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  const answers = new Set<string>()
  for (const url of [w.under(doc, 'private', 'a.png'), w.under(doc, 'notdl', 'x.png'), w.under(doc, 'link.png'), `acb-doc://${'f'.repeat(32)}/x.png`]) {
    const r = await w.get(url)
    answers.add(`${r.status} ${r.text} ${[...r.headers].sort().join(',')}`)
  }
  assert.equal(answers.size, 1, [...answers].join('\n'))
  assert.equal((await w.frames.serve({ url: doc, method: 'POST' })).status, 404)
})

test('what may be opened: an .html file of a company folder, downloaded, not hidden, not a link, ≤ 20 MB', async () => {
  const w = world()
  const reason = async (p: string) => { const r = await w.frames.check(p); return r.ok ? 'ok' : r.reason }
  const at = (rel: string) => path.join(w.root, ...rel.split('/'))
  assert.equal(await reason(at('営業/report.html')), 'ok')
  assert.equal(await reason(at('営業/style.css')), 'not_html')
  assert.equal(await reason(path.join(w.base, 'elsewhere.html')), 'not_allowed')
  assert.equal(await reason(at('営業/linkdir/plain.html')), 'not_allowed', 'a linked folder on the way, even one pointing inside the company')
  assert.equal(await reason(at('営業/linked.html')), 'not_allowed')
  assert.equal(await reason(at('営業/.hidden.html')), 'not_allowed')
  assert.equal(await reason(at('.git/report.html')), 'not_allowed')
  assert.equal(await reason(at('notdl/doc.html')), 'not_downloaded')
  assert.equal(await reason(at('営業/big.html')), 'too_large')
  assert.equal(await reason(at('営業/gone.html')), 'not_found')
  assert.equal(await reason(at('top.html')), 'top_level', 'its scripts could read every served file of the company')
  assert.equal(await reason(42), 'not_found')
})

test('the document session lets out only its own scheme and in-memory data', () => {
  for (const url of [`acb-doc://${TOKEN}/a.png`, 'data:image/png;base64,AA==', 'blob:null/1', 'about:blank']) assert.equal(docSessionRequestAllowed(url), true, url)
  for (const url of ['https://example.com/', 'http://127.0.0.1/', 'wss://x/', 'ws://x/', 'file:///etc/passwd', 'local-file:///x', 'acb-plugin://p/1/ui/a.html', 'ftp://x/', 'chrome://gpu', 'acb-docx://a/b', 'no scheme']) {
    assert.equal(docSessionRequestAllowed(url), false, url)
  }
})

test('a document view goes only to an .html page of its own grant, never elsewhere', () => {
  const own = (p: string) => `acb-doc://${TOKEN}/${p}`
  assert.equal(docViewNavigationAllowed(TOKEN, own('b.html'), true), true)
  assert.equal(docViewNavigationAllowed(TOKEN, own('sub/c.htm?x#y'), true), true)
  for (const url of [
    own('style.css'), own('.hidden.html'), own('%2e%2e/x.html'), `acb-doc://${'b'.repeat(32)}/b.html`, 'data:text/html,<p>', 'file:///etc/passwd',
    'local-file:///Users/me/a.html', 'acb-plugin://p/1.0.0/ui/index.html', 'https://example.com/a.html', 'javascript:alert(1)', 'about:blank',
  ]) assert.equal(docViewNavigationAllowed(TOKEN, url, true), false, url)
  assert.equal(docViewNavigationAllowed(TOKEN, own('b.html'), false), false, 'a frame inside the document goes nowhere')
  assert.equal(docViewNavigationAllowed(null, own('b.html'), true), false, 'a view without a grant goes nowhere')
})

/** A fake shell: views with ids from 100, and what happened to them; `hold` keeps each creation waiting. */
function fakeShell(options: { fail?: boolean; hold?: boolean } = {}) {
  let next = 100
  const shown = new Map<number, string>()
  const destroyed: number[] = []
  const watched: number[] = []
  const hooksOf = new Map<number, DocViewHooks>()
  /** What the registry asked of each view: placements, zooms, reloads. */
  const calls: Array<[number, string, unknown?]> = []
  const waiting: Array<() => void> = []
  const made = { count: 0 }
  let reset: (windowId: number) => void = () => {}
  const port: DocViewPort = {
    onWindowReset: listener => { reset = listener },
    watch: windowId => { watched.push(windowId) },
    async create(_windowId, hooks): Promise<DocViewHandle | null> {
      if (options.hold) await new Promise<void>(resolve => waiting.push(resolve))
      if (options.fail) return null
      made.count++
      const id = next++
      hooksOf.set(id, hooks)
      return {
        id,
        show: url => { shown.set(id, url) },
        destroy: () => { destroyed.push(id); hooksOf.get(id)?.onGone(id) },
        place: bounds => { calls.push([id, 'place', bounds]) },
        zoom: factor => { calls.push([id, 'zoom', factor]) },
        reload: () => { calls.push([id, 'reload']) },
      }
    },
  }
  const release = async () => { for (const resolve of waiting.splice(0)) resolve(); await new Promise(resolve => setImmediate(resolve)) }
  return {
    port, shown, destroyed, watched, made, release, calls,
    crash: (id: number) => hooksOf.get(id)?.onGone(id),
    link: (id: number, url: string) => hooksOf.get(id)?.onLink(id, url),
    resetWindow: (windowId: number) => reset(windowId),
  }
}

const reportDoc = async (w: ReturnType<typeof world>) => {
  const checked = await w.frames.check(path.join(w.root, '営業/report.html'))
  assert.ok(checked.ok)
  return checked.doc
}

test('a view holds its own grant: closed by its window, destroyed, crashed or its window reset, the grant goes', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const openIn = async (windowId: number) => (await views.open(await reportDoc(w), views.begin(windowId)))!
  const a = await openIn(MAIN)
  const b = await openIn(MAIN)
  const c = await openIn(MAIN + 1)
  const d = await openIn(MAIN)
  const url = (id: number) => shell.shown.get(id)!
  assert.match(url(a), /^acb-doc:\/\/[0-9a-f]{32}\/report\.html$/)
  assert.equal((await w.get(url(a))).status, 200)
  // Only its own window closes a view.
  views.close(a, MAIN + 1)
  assert.equal((await w.get(url(a))).status, 200)
  views.close(a, MAIN)
  await refusedAs(w, url(a))
  assert.ok(shell.destroyed.includes(a))
  // Its page crashed or the view was destroyed elsewhere.
  shell.crash(b)
  await refusedAs(w, url(b))
  // The window reloaded: its views go, another window's stay.
  shell.resetWindow(MAIN)
  await refusedAs(w, url(d))
  assert.ok(shell.destroyed.includes(d))
  assert.equal((await w.get(url(c))).status, 200)
})

test('a window holds at most the newest views; opening one more closes the oldest and its grant', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const doc = await reportDoc(w)
  const first = (await views.open(doc, views.begin(MAIN)))!
  for (let i = 0; i < MAX_VIEWS_PER_WINDOW; i++) await views.open(doc, views.begin(MAIN))
  await refusedAs(w, shell.shown.get(first)!)
  assert.deepEqual(shell.destroyed, [first])
})

test('opens running at the same time cannot pass the cap: 40 at once leave the newest 32 with grants', async () => {
  const w = world()
  const shell = fakeShell({ hold: true })
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const doc = await reportDoc(w)
  const opening = Array.from({ length: 40 }, () => views.open(doc, views.begin(MAIN)))
  await shell.release()
  const ids = (await Promise.all(opening)) as number[]
  const served = await Promise.all(ids.map(async id => (await w.get(shell.shown.get(id)!)).status))
  assert.equal(served.filter(status => status === 200).length, MAX_VIEWS_PER_WINDOW)
  assert.equal(shell.destroyed.length, 40 - MAX_VIEWS_PER_WINDOW)
  for (const id of shell.destroyed) assert.equal(served[ids.indexOf(id)], 404)
})

test('a page that reloads or crashes while an open is under way gets no view and no grant', async () => {
  // While the file is checked (before the view is made).
  {
    const w = world()
    const shell = fakeShell()
    const views = createDocViews({ frames: w.frames, shell: shell.port })
    const ticket = views.begin(MAIN)
    assert.deepEqual(shell.watched, [MAIN], 'the page is watched from the moment the member asked')
    const doc = await reportDoc(w)
    shell.resetWindow(MAIN)
    assert.equal(await views.open(doc, ticket), null)
    assert.deepEqual([shell.made.count, shell.shown.size], [0, 0], 'no view is even made for the gone page')
    // A new open for the reloaded page works.
    assert.notEqual(await views.open(doc, views.begin(MAIN)), null)
  }
  // While the view is made.
  {
    const w = world()
    const shell = fakeShell({ hold: true })
    const views = createDocViews({ frames: w.frames, shell: shell.port })
    const opening = views.open(await reportDoc(w), views.begin(MAIN))
    await new Promise(resolve => setImmediate(resolve))
    shell.resetWindow(MAIN)
    await shell.release()
    assert.equal(await opening, null)
    assert.deepEqual(shell.destroyed, [100], 'the view finished for the gone page is destroyed')
    assert.equal(shell.shown.size, 0, 'and was never given a grant')
  }
})

test('a view that cannot be made gets no grant', async () => {
  const w = world()
  const views = createDocViews({ frames: w.frames, shell: fakeShell({ fail: true }).port })
  assert.equal(await views.open(await reportDoc(w), views.begin(MAIN)), null)
})

test('docView:open notes the page before the file is checked: a reload during the check registers nothing', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const frames = { check: async (p: unknown) => { const r = await w.frames.check(p); shell.resetWindow(MAIN); return r } }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, { frames, views, fromMainWindow: (() => true) as never })
  const answer = await handlers.get('docView:open')!({ sender: { id: MAIN } }, path.join(w.root, '営業/report.html')) as { ok: boolean; reason?: string }
  assert.deepEqual([answer.ok, answer.reason, shell.shown.size], [false, 'unavailable', 0])
})

test('docView:open is the main window\'s page\'s only, decided before any file is looked at; close likewise', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  let checks = 0
  const frames = { check: (p: unknown) => { checks++; return w.frames.check(p) } }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, { frames, views, fromMainWindow: ((event: { main: boolean }) => event.main) as never })
  const ev = (main: boolean, id = MAIN) => ({ main, sender: { id, isDestroyed: () => false, send: () => {} } })
  const open = handlers.get('docView:open')!
  const file = path.join(w.root, '営業/report.html')
  const fromChat = await open(ev(false, 7), file) as { ok: boolean; reason?: string }
  assert.deepEqual([fromChat.ok, fromChat.reason, checks], [false, 'not_allowed', 0], 'not the main window: nothing read')
  assert.deepEqual(await open(ev(true), path.join(w.base, 'x.html')), await w.frames.check(path.join(w.base, 'x.html')))
  const opened = await open(ev(true), file) as { ok: true; viewId: number }
  assert.equal(opened.ok, true)
  assert.deepEqual(Object.keys(opened).sort(), ['ok', 'viewId'], 'the renderer never gets the address')
  const url = shell.shown.get(opened.viewId)!
  await handlers.get('docView:close')!(ev(false), opened.viewId)
  assert.equal((await w.get(url)).status, 200, 'another window cannot close it')
  await handlers.get('docView:close')!(ev(true), opened.viewId)
  await refusedAs(w, url)
  const unmade = createDocViews({ frames: w.frames, shell: fakeShell({ fail: true }).port })
  registerDocViewsIpc(ipc as never, { frames: w.frames, views: unmade, fromMainWindow: (() => true) as never })
  assert.equal((await handlers.get('docView:open')!(ev(true), file) as { reason: string }).reason, 'unavailable')
})

test('the file opened is the file at the real location: a swap while the request runs serves nothing', async () => {
  const w = world()
  const doc = await w.open('営業/report.html')
  const realOpen = fsp.open
  const realRealpath = fsp.realpath
  const secret = path.join(w.root, 'other', 'secret.png')
  try {
    // A folder on the way swapped for a link at the moment of opening, swapped back before the check.
    fsp.open = (async (file: string, ...rest: unknown[]) =>
      (realOpen as (...a: unknown[]) => unknown)(String(file).endsWith('style.css') ? secret : file, ...rest)) as typeof fsp.open
    await refusedAs(w, w.under(doc, 'style.css'))
    fsp.open = realOpen
    // Swapped during the read: the second look at the real location finds another file.
    let looks = 0
    fsp.realpath = (async (p: string, ...rest: unknown[]) => {
      const real = await (realRealpath as (...a: unknown[]) => Promise<string>)(p, ...rest)
      return String(p).endsWith('style.css') && ++looks === 2 ? path.join(path.dirname(real), 'images', 'graph.png') : real
    }) as typeof fsp.realpath
    await refusedAs(w, w.under(doc, 'style.css'))
    assert.equal(looks, 2)
  } finally {
    fsp.open = realOpen
    fsp.realpath = realRealpath
  }
  assert.equal((await w.get(w.under(doc, 'style.css'))).status, 200, 'control: unswapped it is served')
})

test('a view is placed, zoomed and reloaded only by its own window; a placement that is not four sane numbers hides it', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const id = (await views.open(await reportDoc(w), views.begin(MAIN)))!
  views.place(id, MAIN + 1, { x: 0, y: 0, width: 100, height: 100 })
  views.zoom(id, MAIN + 1, 2)
  views.reload(id, MAIN + 1)
  views.place(999, MAIN, { x: 0, y: 0, width: 100, height: 100 })
  assert.deepEqual(shell.calls, [], 'another window (or an unknown view) changes nothing')
  views.place(id, MAIN, { x: 10.4, y: 20.6, width: 300, height: 200 })
  views.place(id, MAIN, null)
  for (const bad of [{ x: 0, y: 0, width: 0, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 1e9, height: 10 }, { x: '0', y: 0, width: 10, height: 10 }, 'full', undefined]) {
    views.place(id, MAIN, bad)
  }
  assert.deepEqual(shell.calls, [
    [id, 'place', { x: 10, y: 21, width: 300, height: 200 }],
    [id, 'place', null],
    ...Array.from({ length: 6 }, () => [id, 'place', null]),
  ], 'a placement that is not four sane numbers hides the view rather than placing it somewhere')
  shell.calls.length = 0
  views.zoom(id, MAIN, 40)
  views.zoom(id, MAIN, 0.01)
  views.zoom(id, MAIN, 'big')
  views.reload(id, MAIN)
  assert.deepEqual(shell.calls, [[id, 'zoom', 3], [id, 'zoom', 0.5], [id, 'reload']], 'zoom kept within the steps; a non-number ignored')
})

test('where a placement lands: the app page\'s zoom applied, cut to the window, nothing when it is off the window', () => {
  assert.deepEqual(docViewOnScreen({ x: 100, y: 50, width: 400, height: 300 }, 1, [1200, 800]), { x: 100, y: 50, width: 400, height: 300 })
  assert.deepEqual(docViewOnScreen({ x: 100, y: 50, width: 400, height: 300 }, 1.5, [1200, 800]), { x: 150, y: 75, width: 600, height: 450 })
  assert.deepEqual(docViewOnScreen({ x: -20, y: 700, width: 400, height: 300 }, 1, [1200, 800]), { x: 0, y: 700, width: 380, height: 100 })
  assert.equal(docViewOnScreen({ x: 1300, y: 0, width: 400, height: 300 }, 1, [1200, 800]), null)
  assert.equal(docViewBounds({ x: 1, y: 1, width: 0.2, height: 5 }), null)
})

test('the window hears of a link the member pressed (web only, at most one a second) and of a view that went by itself', async () => {
  const w = world()
  const shell = fakeShell()
  let clock = 10_000
  const told: Array<[number, unknown]> = []
  const views = createDocViews({ frames: w.frames, shell: shell.port, notify: (windowId, event) => told.push([windowId, event]), now: () => clock })
  const doc = await reportDoc(w)
  const a = (await views.open(doc, views.begin(MAIN)))!
  const b = (await views.open(doc, views.begin(MAIN + 1)))!
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@example.com', 'acb-plugin://p/x', 'not a url']) shell.link(a, url)
  assert.deepEqual(told, [], 'only a web address may reach the member\'s browser')
  shell.link(a, 'https://example.com/report?from=doc')
  shell.link(a, 'https://evil.example/again')
  clock += LINK_INTERVAL_MS - 1
  shell.link(a, 'https://evil.example/again')
  clock += 1
  shell.link(b, 'http://example.org/')
  shell.link(a, 'https://example.com/2')
  assert.deepEqual(told, [
    [MAIN, { viewId: a, kind: 'link', url: 'https://example.com/report?from=doc' }],
    [MAIN + 1, { viewId: b, kind: 'link', url: 'http://example.org/' }],
    [MAIN, { viewId: a, kind: 'link', url: 'https://example.com/2' }],
  ], 'a page cannot queue confirmations; each window hears of its own views only')
  told.length = 0
  views.close(a, MAIN)
  shell.link(a, 'https://example.com/3')
  assert.deepEqual(told, [], 'closed by its window: nothing to tell, and a closed view asks nothing')
  shell.crash(b)
  assert.deepEqual(told, [[MAIN + 1, { viewId: b, kind: 'gone' }]])
  // The cap: the oldest closes without its window asking, so the window is told.
  told.length = 0
  const first = (await views.open(doc, views.begin(MAIN)))!
  for (let i = 0; i < MAX_VIEWS_PER_WINDOW; i++) await views.open(doc, views.begin(MAIN))
  assert.deepEqual(told, [[MAIN, { viewId: first, kind: 'gone' }]])
})

test('docView:setBounds / setZoom / reload are the main window\'s page\'s only', async () => {
  const w = world()
  const shell = fakeShell()
  const views = createDocViews({ frames: w.frames, shell: shell.port })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, { frames: w.frames, views, fromMainWindow: ((event: { main: boolean }) => event.main) as never })
  const id = (await views.open(await reportDoc(w), views.begin(MAIN)))!
  const ev = (main: boolean) => ({ main, sender: { id: MAIN } })
  const box = { x: 0, y: 0, width: 50, height: 50 }
  await handlers.get('docView:setBounds')!(ev(false), id, box)
  await handlers.get('docView:setZoom')!(ev(false), id, 2)
  await handlers.get('docView:reload')!(ev(false), id)
  assert.deepEqual(shell.calls, [], 'a frame inside the page or another window changes nothing')
  await handlers.get('docView:setBounds')!(ev(true), id, box)
  await handlers.get('docView:setZoom')!(ev(true), id, 2)
  await handlers.get('docView:reload')!(ev(true), id)
  assert.deepEqual(shell.calls, [[id, 'place', box], [id, 'zoom', 2], [id, 'reload']])
})
