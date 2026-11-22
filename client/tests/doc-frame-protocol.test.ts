// acb-doc:// (the HTML viewer, .claude/rules/doc-frame.md): a grant reaches only regular files
// inside the opened document's own folder — never `..` (also encoded), hidden names, links, another
// repository (a private folder's clone), a folder this computer did not download, a file over
// 20 MB, a type that is not served — every refusal is the same 404 that names nothing, and every
// answer carries the CSP with no network source. The IPC hands grants to the main window only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createDocFrames, MAX_GRANTS_PER_OWNER, type DocFrameDeps } from '../electron/features/doc-frames/protocol'
import { registerDocFramesIpc } from '../electron/features/doc-frames/ipc'
import {
  docFrameCsp, docFramePolicy, docFileType, isFromDocFrame, parseDocFrameUrl, DOC_MAX_FILE_BYTES,
} from '../shared/doc-frame'

const quiet = { warn: () => {} }
const TOKEN = 'a'.repeat(32)
const MAIN = 1

function world(options: { notDownloaded?: string[]; ownerAlive?: (id: number) => boolean } = {}) {
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

  const paths = new AllowedRoots()
  paths.add(root)
  let tokens = 0
  const deps: DocFrameDeps = {
    paths,
    notDownloaded: () => options.notDownloaded ?? ['営業/notdl', 'notdl'],
    ownerAlive: options.ownerAlive ?? (() => true),
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

test('a wrong token, a closed view, a gone window: nothing is served', async () => {
  let alive = true
  const w = world({ ownerAlive: () => alive })
  const doc = await w.open('営業/report.html')
  const file = new URL(doc).pathname
  await refusedAs(w, `acb-doc://${'f'.repeat(32)}${file}`)
  // Only its own window closes a grant.
  w.frames.close(doc, MAIN + 1)
  assert.equal((await w.get(doc)).status, 200)
  w.frames.close(doc, MAIN)
  await refusedAs(w, doc)
  const again = await w.open('営業/report.html')
  alive = false
  await refusedAs(w, again)
  alive = true
  await refusedAs(w, again)
})

test('two views of one file hold two grants; closing one leaves the other', async () => {
  const w = world()
  const a = await w.open('営業/report.html')
  const b = await w.open('営業/report.html')
  assert.notEqual(a, b)
  w.frames.close(a, MAIN)
  await refusedAs(w, a)
  assert.equal((await w.get(b)).status, 200)
  w.frames.closeAllOf(MAIN)
  await refusedAs(w, b)
})

test('a window holds at most the newest grants; the oldest is revoked', async () => {
  const w = world()
  const first = await w.open('営業/report.html')
  for (let i = 0; i < MAX_GRANTS_PER_OWNER; i++) await w.open('営業/report.html')
  await refusedAs(w, first)
})

test('a grant closed while its file is read answers nothing', async () => {
  const w = world()
  let doc = ''
  let closeDuring = false
  w.deps.notDownloaded = () => { if (closeDuring) w.frames.close(doc, MAIN); return [] }
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
  assert.equal(await reason(42), 'not_found')
})

test('a web request is the session guard\'s when the frame or one of its parents shows a document', () => {
  assert.equal(isFromDocFrame([`acb-doc://${TOKEN}/a.html`]), true)
  assert.equal(isFromDocFrame(['about:srcdoc', `ACB-DOC://${TOKEN}/a.html`, 'file:///app/index.html']), true)
  assert.equal(isFromDocFrame(['file:///app/index.html']), false)
  assert.equal(isFromDocFrame(['acb-plugin://p/1.0.0/ui/index.html', 'http://localhost:5173/']), false)
  assert.equal(isFromDocFrame([]), false)
})

test('docFrames:open grants only to the main window\'s page, after the path was judged; close likewise', async () => {
  const w = world()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  const fromMain = (event: unknown) => (event as { main: boolean }).main
  registerDocFramesIpc(ipc as never, { docFrames: w.frames, fromMainWindow: fromMain as never })
  const ev = (main: boolean, id = MAIN) => ({ main, sender: { id, isDestroyed: () => false, send: () => {} } })
  const open = handlers.get('docFrames:open')!
  const file = path.join(w.root, '営業/report.html')
  const fromChat = await open(ev(false, 7), file) as { ok: boolean; reason?: string }
  assert.deepEqual([fromChat.ok, fromChat.reason], [false, 'not_allowed'])
  assert.deepEqual(await open(ev(true), path.join(w.base, 'x.html')), await w.frames.check(path.join(w.base, 'x.html')))
  const granted = await open(ev(true), file) as { ok: true; url: string }
  assert.equal(granted.ok, true)
  await handlers.get('docFrames:close')!(ev(false), granted.url)
  assert.equal((await w.get(granted.url)).status, 200, 'another window cannot close it')
  await handlers.get('docFrames:close')!(ev(true), granted.url)
  await refusedAs(w, granted.url)
})
