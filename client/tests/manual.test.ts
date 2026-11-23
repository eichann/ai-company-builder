// The user manual in the app (files-and-editor.md "The user manual"):
// - this computer's copy (`features/manual/site.ts`) takes only files the server's manifest names,
//   each checked by size and sha256; a bad file, a bad manifest or an unreachable server leaves the
//   copy as it was (offline: the copy is shown); a server without a manual says so;
// - `manual:open` / `manual:export` answer only the main window's page, before anything is fetched,
//   shown or written; a page is opened through the HTML viewer's own grant (its folder's files only,
//   the heading as the address's fragment) and only a view id goes back;
// - the export writes only into the folder the member chose in the save dialog — never inside a
//   company folder (also through a link), never into a folder that holds something, never replacing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AllowedRoots } from '../electron/allowed-roots'
import { createManualSite, type ManualSite } from '../electron/features/manual/site'
import { registerManualIpc } from '../electron/features/manual/ipc'
import { createDocFrames } from '../electron/features/doc-frames/protocol'
import { createDocViews, type DocViewHandle, type DocViewPort } from '../electron/features/doc-frames/views'
import { MANUAL_WORDS } from '../shared/manual'

const quiet = { warn: () => {} }
const MAIN = 1
const SERVER = 'https://acb.example.com'
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** The server's built site: path → bytes, plus its manifest. */
function builtSite(files: Record<string, string | Buffer> = {}) {
  const all: Record<string, Buffer> = {
    'index.html': Buffer.from('<h1 id="はじめに">使い方</h1><img src="images/shot.png">'),
    'guide.html': Buffer.from('<h1>ファイル</h1>'),
    'manual.css': Buffer.from('body{}'),
    'images/shot.png': PNG,
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  }
  const manifest = {
    format: 1,
    pages: [{ id: 'index', title: '使い方' }, { id: 'guide', title: 'ファイル' }],
    files: Object.entries(all).map(([p, b]) => ({ path: p, sha256: sha(b), size: b.length })),
  }
  return { all, manifest }
}

/** A fake server answering /manual/*; `requests` lists what was asked. */
function fakeServer(site: ReturnType<typeof builtSite> | null, options: { offline?: boolean; tamper?: string; manifest?: unknown } = {}) {
  const requests: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push(url)
    assert.equal(init?.redirect, 'error', 'redirects are refused')
    if (options.offline) throw new TypeError('fetch failed')
    if (!site) return new Response('Not found', { status: 404 })
    const p = url.slice(`${SERVER}/manual/`.length)
    if (p === 'manifest.json') return new Response(JSON.stringify(options.manifest ?? site.manifest))
    const bytes = site.all[p]
    if (!bytes) return new Response('Not found', { status: 404 })
    // Same size, other bytes: only the sha256 tells.
    return new Response(p === options.tamper ? Buffer.from(bytes.map((b, i) => (i === 0 ? b ^ 1 : b))) : bytes)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, requests }
}

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-manual-')))
}

function siteWith(server: ReturnType<typeof fakeServer>, cacheRoot: string): ManualSite {
  return createManualSite({ serverUrl: () => `${SERVER}/`, cacheRoot, fetch: server.fetch, log: quiet })
}

test('the copy holds exactly the files the manifest names, each checked; unchanged files are not fetched again', async () => {
  const cache = tmp()
  const server = fakeServer(builtSite())
  const copy = await siteWith(server, cache).current()
  assert.equal(copy.kind, 'copy')
  if (copy.kind !== 'copy') return
  assert.deepEqual(fs.readdirSync(copy.dir).sort(), ['guide.html', 'images', 'index.html', 'manifest.json', 'manual.css'])
  assert.deepEqual(fs.readFileSync(path.join(copy.dir, 'images/shot.png')), PNG)
  const again = fakeServer(builtSite({ 'guide.html': '<h1>新しい章</h1>' }))
  await siteWith(again, cache).current()
  assert.deepEqual(again.requests.map(u => u.slice(SERVER.length)), ['/manual/manifest.json', '/manual/guide.html'], 'only the changed file is fetched')
  assert.equal(fs.readFileSync(path.join(copy.dir, 'guide.html'), 'utf8'), '<h1>新しい章</h1>')
})

test('a file that differs from the manifest, or a manifest naming another path, changes nothing on disk', async () => {
  const cache = tmp()
  await siteWith(fakeServer(builtSite()), cache).current()
  const tampered = await siteWith(fakeServer(builtSite({ 'guide.html': '<h1>v2</h1>' }), { tamper: 'guide.html' }), cache).current()
  assert.equal(tampered.kind, 'copy')
  if (tampered.kind !== 'copy') return
  assert.equal(fs.readFileSync(path.join(tampered.dir, 'guide.html'), 'utf8'), '<h1>ファイル</h1>', 'the old copy stays whole')
  for (const bad of ['../outside.html', 'images/../../x.png', '.hidden.html', 'sub/page.html', 'images/a.svg', 'notes.txt']) {
    const site = builtSite()
    const manifest = { ...site.manifest, files: [...site.manifest.files, { path: bad, sha256: sha('x'), size: 1 }] }
    const answer = await siteWith(fakeServer(site, { manifest }), cache).current()
    assert.equal(answer.kind, 'copy', bad)
    assert.equal(fs.existsSync(path.join(cache, '..', 'outside.html')), false, bad)
  }
  // No staging folder left behind.
  const folder = fs.readdirSync(cache)[0]
  assert.deepEqual(fs.readdirSync(path.join(cache, folder)), ['site'])
})

test('offline the kept copy is shown; with none, nothing; a server without a manual says so', async () => {
  const cache = tmp()
  assert.equal((await siteWith(fakeServer(builtSite(), { offline: true }), cache).current()).kind, 'none')
  await siteWith(fakeServer(builtSite()), cache).current()
  assert.equal((await siteWith(fakeServer(builtSite(), { offline: true }), cache).current()).kind, 'copy')
  assert.equal((await siteWith(fakeServer(null), cache).current()).kind, 'missing')
})

// --- the IPC ---------------------------------------------------------------------------------

function fakeShell() {
  let next = 100
  const shown = new Map<number, string>()
  const port: DocViewPort = {
    onWindowReset: () => {},
    watch: () => {},
    async create(): Promise<DocViewHandle> {
      const id = next++
      return { id, show: url => { shown.set(id, url) }, destroy: () => {}, place: () => {}, zoom: () => {}, reload: () => {} }
    },
  }
  return { port, shown }
}

function setup(options: { offline?: boolean; savePath?: string | null } = {}) {
  const base = tmp()
  const company = path.join(base, 'company')
  fs.mkdirSync(company)
  const roots = new AllowedRoots()
  roots.add(company)
  const server = fakeServer(builtSite(), { offline: options.offline })
  const site = siteWith(server, path.join(base, 'cache'))
  const frames = createDocFrames({ paths: roots, notDownloaded: () => [], log: quiet })
  const shell = fakeShell()
  const views = createDocViews({ frames, shell: shell.port })
  const dialogs: unknown[] = []
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn) }, on: () => {} }
  registerManualIpc(ipc as never, {
    site, views,
    fromMainWindow: ((event: { main: boolean }) => event.main) as never,
    chooseFolder: async (o) => { dialogs.push(o); return options.savePath === undefined ? path.join(base, 'export') : options.savePath },
    defaultFolder: () => path.join(base, 'Downloads'),
    insideCompanyFolder: target => roots.touches(target),
    log: quiet,
  })
  const ev = (main: boolean) => ({ main, sender: { id: MAIN, isDestroyed: () => false, send: () => {} } })
  return { base, company, server, frames, shell, dialogs, handlers, ev }
}

test('manual:open and manual:export answer the main window only, before anything is fetched or asked', async () => {
  const w = setup()
  const opened = await w.handlers.get('manual:open')!(w.ev(false), 'index', null) as { ok: boolean }
  const exported = await w.handlers.get('manual:export')!(w.ev(false)) as { ok: boolean }
  assert.deepEqual([opened.ok, exported.ok, w.server.requests.length, w.dialogs.length, w.shell.shown.size], [false, false, 0, 0, 0])
  assert.equal(fs.existsSync(path.join(w.base, 'export')), false)
})

test('manual:open shows the page through a grant for the copy alone, at its heading; only the view id goes back', async () => {
  const w = setup()
  const opened = await w.handlers.get('manual:open')!(w.ev(true), 'index', 'はじめに') as { ok: true; viewId: number }
  assert.deepEqual(Object.keys(opened).sort(), ['ok', 'viewId'])
  const url = w.shell.shown.get(opened.viewId)!
  assert.match(url, /^acb-doc:\/\/[0-9a-f]{32}\/index\.html#%E3%81%AF%E3%81%98%E3%82%81%E3%81%AB$/)
  const origin = url.slice(0, url.indexOf('/index.html'))
  const get = (p: string) => w.frames.serve({ url: `${origin}/${p}`, method: 'GET' })
  assert.equal((await get('images/shot.png')).status, 200)
  assert.equal((await get('guide.html')).status, 200)
  for (const p of ['manifest.json', '..%2fcompany', '%2e%2e/cache', '../../company']) assert.equal((await get(p)).status, 404, p)
  // Not a page id, or a page the manual does not have: nothing is shown.
  for (const page of ['../index', 'Index', 'missing', '']) {
    const answer = await w.handlers.get('manual:open')!(w.ev(true), page, null) as { ok: boolean; message?: string }
    assert.equal(answer.ok, false, page)
  }
  assert.equal(w.shell.shown.size, 1)
})

test('manual:open offline with nothing kept says so', async () => {
  const w = setup({ offline: true })
  assert.deepEqual(await w.handlers.get('manual:open')!(w.ev(true), 'index', null), { ok: false, message: MANUAL_WORDS.unreachable })
})

test('manual:export writes the manual into the new folder the member chose, starting the dialog in Downloads', async () => {
  const w = setup()
  const answer = await w.handlers.get('manual:export')!(w.ev(true)) as { ok: boolean; folder?: string }
  assert.deepEqual(answer, { ok: true, folder: path.join(w.base, 'export') })
  assert.deepEqual(fs.readdirSync(answer.folder!).sort(), ['guide.html', 'images', 'index.html', 'manual.css'])
  assert.deepEqual(fs.readFileSync(path.join(answer.folder!, 'images/shot.png')), PNG)
  assert.equal((w.dialogs[0] as { defaultPath: string }).defaultPath, path.join(w.base, 'Downloads', MANUAL_WORDS.defaultFolderName))
})

test('manual:export never writes inside a company folder (also through a link), into a folder holding something, or when cancelled', async () => {
  const base = tmp()
  const inside = setup({ savePath: null })
  assert.deepEqual(await inside.handlers.get('manual:export')!(inside.ev(true)), { ok: false, cancelled: true })

  const intoCompany = setup()
  const target = path.join(intoCompany.company, '使い方')
  const viaLink = path.join(intoCompany.base, 'link-to-company')
  fs.symlinkSync(intoCompany.company, viaLink)
  for (const chosen of [target, path.join(viaLink, '使い方'), intoCompany.company]) {
    const w = setup({ savePath: chosen })
    // The same company folder as `intoCompany`, registered in this world too.
    const roots = new AllowedRoots()
    roots.add(intoCompany.company)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    registerManualIpc({ handle: (c: string, fn: never) => { handlers.set(c, fn) }, on: () => {} } as never, {
      site: siteWith(fakeServer(builtSite()), path.join(base, 'cache')), views: { begin: () => ({ windowId: MAIN, generation: 0 }), open: async () => null },
      fromMainWindow: (() => true) as never, chooseFolder: async () => chosen, defaultFolder: () => base,
      insideCompanyFolder: t => roots.touches(t), log: quiet,
    })
    assert.deepEqual(await handlers.get('manual:export')!(w.ev(true)), { ok: false, message: MANUAL_WORDS.insideCompany }, chosen)
  }
  assert.deepEqual(fs.readdirSync(intoCompany.company), [], 'nothing written in the company folder')

  const full = path.join(base, 'full')
  fs.mkdirSync(full)
  fs.writeFileSync(path.join(full, 'index.html'), 'mine')
  const notEmpty = setup({ savePath: full })
  assert.deepEqual(await notEmpty.handlers.get('manual:export')!(notEmpty.ev(true)), { ok: false, message: MANUAL_WORDS.notEmpty })
  assert.equal(fs.readFileSync(path.join(full, 'index.html'), 'utf8'), 'mine')

  const aFile = path.join(base, 'a-file')
  fs.writeFileSync(aFile, 'mine')
  const onFile = setup({ savePath: aFile })
  assert.equal((await onFile.handlers.get('manual:export')!(onFile.ev(true)) as { ok: boolean }).ok, false)
  assert.equal(fs.readFileSync(aFile, 'utf8'), 'mine')
})
