/**
 * Integration Test: the user manual (取説, server.md "The user manual").
 *
 * - The build (lib/manual-build.ts) turns manual/pages/*.md into pages that carry
 *   no script whatever the Markdown holds (raw HTML, event attributes,
 *   `javascript:` links), rewrites page links and ../images/ pictures, and stops
 *   on a link or picture that is not the manual's own.
 * - `/manual/` answers every file of the built site to a signed-in caller, with
 *   the strict CSP, nosniff, `private, no-cache` and ETag; and nothing else: no
 *   file that only sits in the folder, no listing, no `..` (encoded or not), no link.
 * - Without a session every path gets the same answer (401, or for a browser
 *   opening a page the sign-in page with a way back inside `/manual/` only), with
 *   the same strict headers and nothing cached.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { request as httpRequest } from 'http'
import type { AddressInfo } from 'net'
import { makeTempDir } from '../../shared/testing/temp-dirs'

// Who the request is signed in as (null: no session); each test sets it.
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; image: null; emailVerified: boolean } }))

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join: joinPath } = await import('path')
  return {
    authDb: new Database(joinPath(process.env.DATA_DIR!, 'auth.sqlite')),
    getUserFromRequest: vi.fn(async () => session.user),
    getUsersByIds: vi.fn().mockReturnValue(new Map()),
    auth: {
      handler: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const TOKENS = join(__dirname, '../../shared/design-tokens')
// A PNG's first bytes are enough: the build copies, it does not decode.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

let root: string
let source: string
let site: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any

function writeSource(dir: string, pages: Record<string, string>, images: Record<string, Buffer> = {}) {
  mkdirSync(join(dir, 'pages'), { recursive: true })
  mkdirSync(join(dir, 'images'), { recursive: true })
  for (const [name, text] of Object.entries(pages)) writeFileSync(join(dir, 'pages', name), text)
  for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, 'images', name), bytes)
}

beforeAll(async () => {
  root = makeTempDir('acb-manual-')
  source = join(root, 'manual')
  site = join(root, 'site')
  writeSource(source, {
    'index.md': [
      '# ACB の使い方',
      '',
      '[ファイルの章](guide.md) と [見出しへ](./guide.md#ファイルを開く) と [外](https://example.com/x)',
      '',
      '![画面](../images/files-tab.png)',
      '',
      '<script>alert("raw")</script>',
      '',
      '<img src="x" onerror="alert(1)">',
      '',
      '<iframe src="https://evil.example"></iframe>',
      '',
      '<a href="javascript:alert(1)">押す</a>',
    ].join('\n'),
    'guide.md': '# ファイル\n\n## ファイルを開く\n\n本文\n',
  }, { 'files-tab.png': PNG, 'unused.png': PNG })
  const { buildManualSite } = await import('../../src/lib/manual-build')
  buildManualSite(source, site, TOKENS, 'manual')
  // Beside the built files, never listed in the manifest: none of these may be served.
  writeFileSync(join(site, 'notes.txt'), 'not part of the manual')
  writeFileSync(join(site, 'extra.html'), '<p>not listed</p>')
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE-SECRET')
  process.env.MANUAL_DIR = site
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(await import('../../src/db')).initDatabase()
  app = (await import('../../src/app')).app
})

afterAll(() => {
  delete process.env.MANUAL_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('building the manual', () => {
  it('writes pages that carry no script, whatever the Markdown holds', () => {
    const html = readFileSync(join(site, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onerror/i)
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toMatch(/<iframe/i)
    expect(html).toContain('<title>ACB の使い方 — AI Company Builder の使い方</title>')
  })

  it('makes page links .html, keeps a heading, and points pictures at images/', () => {
    const html = readFileSync(join(site, 'index.html'), 'utf8')
    expect(html).toContain('href="guide.html"')
    expect(html).toContain(`href="guide.html#${encodeURIComponent('ファイルを開く')}"`)
    expect(html).toContain('src="images/files-tab.png"')
    expect(readFileSync(join(site, 'guide.html'), 'utf8')).toContain('id="ファイルを開く"')
    const manifest = JSON.parse(readFileSync(join(site, 'manifest.json'), 'utf8'))
    expect(manifest.files.map((f: { path: string }) => f.path).sort())
      .toEqual(['guide.html', 'images/files-tab.png', 'index.html', 'manual.css'])
    expect(manifest.pages).toEqual([{ id: 'index', title: 'ACB の使い方' }, { id: 'guide', title: 'ファイル' }])
  })

  it('stops on a link or picture that is not the manual\'s own, and writes nothing over a folder it did not make', async () => {
    const { buildManualSite } = await import('../../src/lib/manual-build')
    const cases: Record<string, string> = {
      'unknown page': '# x\n\n[どこか](missing.md)',
      'a file link': '# x\n\n[x](file:///etc/passwd)',
      'a script link': '# x\n\n[押す](javascript:alert(1))',
      'a web picture': '# x\n\n![x](https://example.com/a.png)',
      'a picture outside images': '# x\n\n![x](../../secret.png)',
      'a missing picture': '# x\n\n![x](../images/none.png)',
      'an svg picture': '# x\n\n![x](../images/a.svg)',
    }
    for (const [name, text] of Object.entries(cases)) {
      const dir = join(root, `bad-${name.replace(/ /g, '-')}`)
      writeSource(dir, { 'index.md': text }, { 'a.svg': Buffer.from('<svg/>') })
      expect(() => buildManualSite(dir, join(dir, 'out'), TOKENS, 'manual'), name).toThrow()
    }
    const notOurs = join(root, 'not-ours')
    mkdirSync(notOurs)
    writeFileSync(join(notOurs, 'keep.txt'), 'keep')
    expect(() => buildManualSite(source, notOurs, TOKENS, 'manual')).toThrow()
    expect(readFileSync(join(notOurs, 'keep.txt'), 'utf8')).toBe('keep')
  })
})

const MEMBER = { id: 'user-reader', email: 'reader@example.com', name: '読む人', image: null, emailVerified: true }

describe('GET /manual/ signed in', () => {
  beforeEach(() => { session.user = MEMBER })
  afterEach(() => { session.user = null })

  it('answers every built file to a signed-in account, with the strict headers', async () => {
    const expected: Record<string, string> = {
      '/manual/': 'text/html; charset=utf-8',
      '/manual/index.html': 'text/html; charset=utf-8',
      '/manual/guide.html': 'text/html; charset=utf-8',
      '/manual/manual.css': 'text/css; charset=utf-8',
      '/manual/images/files-tab.png': 'image/png',
      '/manual/manifest.json': 'application/json; charset=utf-8',
    }
    for (const [path, type] of Object.entries(expected)) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type'), path).toBe(type)
      expect(res.headers.get('content-security-policy'), path).toMatch(/^default-src 'none'; style-src 'self'; img-src 'self';/)
      expect(res.headers.get('content-security-policy'), path).not.toMatch(/script-src/)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(res.headers.get('cache-control'), path).toBe('private, no-cache')
      expect(res.headers.get('etag'), path).toMatch(/^"[0-9a-f]{64}"$/)
    }
    const png = await app.request('/manual/images/files-tab.png')
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG)
  })

  it('sends /manual to the index page and answers 304 for an unchanged file', async () => {
    const redirect = await app.request('/manual')
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/manual/index.html')
    const first = await app.request('/manual/guide.html')
    const again = await app.request('/manual/guide.html', { headers: { 'If-None-Match': first.headers.get('etag') } })
    expect(again.status).toBe(304)
  })

  it('answers 404 for anything else: files beside the site, listings, traversal, hidden names', async () => {
    const refused = [
      '/manual/notes.txt', '/manual/extra.html', '/manual/images/unused.png', '/manual/images/', '/manual/images',
      '/manual/%2e%2e/outside.txt', '/manual/..%2foutside.txt', '/manual/images/..%2f..%2foutside.txt',
      '/manual/images/%2e%2e%2fmanifest.json', '/manual/%2fetc%2fpasswd', '/manual/.manifest.json',
      '/manual/Index.html', '/manual/index.html%00.png', '/manual//index.html',
    ]
    for (const path of refused) {
      const res = await app.request(path)
      // The manual's own 404, or the app's when the path never reached the manual's route.
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).toMatch(/^(Not found|\{"error":"Not found","code":"NOT_FOUND"\})$/)
    }
  })

  it('serves nothing through raw ../ segments sent over HTTP', async () => {
    const { serve } = await import('@hono/node-server')
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise(resolve => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
        let body = ''
        res.on('data', d => { body += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
    try {
      for (const path of ['/manual/../outside.txt', '/manual/images/../../outside.txt', '/manual/..\\outside.txt']) {
        const res = await get(path)
        expect(res.body, path).not.toContain('OUTSIDE-SECRET')
        expect(res.status, path).not.toBe(200)
      }
    } finally {
      server.close()
    }
  })

  it('does not follow a link put in place of a listed file', async () => {
    const target = join(site, 'guide.html')
    const kept = readFileSync(target)
    unlinkSync(target)
    symlinkSync(join(root, 'outside.txt'), target)
    try {
      const res = await app.request('/manual/guide.html')
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('OUTSIDE-SECRET')
    } finally {
      unlinkSync(target)
      writeFileSync(target, kept)
    }
  })

  it('answers 404 when the manual was not built', async () => {
    process.env.MANUAL_DIR = join(root, 'nothing-here')
    try {
      expect((await app.request('/manual/')).status).toBe(404)
    } finally {
      process.env.MANUAL_DIR = site
    }
  })
})

describe('GET /manual/ without a session', () => {
  // A page, a picture, the stylesheet, the manifest, /manual itself, a file beside the site and a
  // path that names nothing: no answer may tell them apart.
  const PATHS = [
    '/manual', '/manual/', '/manual/index.html', '/manual/guide.html', '/manual/images/files-tab.png', '/manual/manual.css',
    '/manual/manifest.json', '/manual/notes.txt', '/manual/no-such-page.html', '/manual/images/', '/manual/images/unused.png', '/manual/Index.html',
  ]

  function expectStrictHeaders(res: Response, path: string) {
    expect(res.headers.get('content-security-policy'), path).toMatch(/^default-src 'none'; style-src 'self'; img-src 'self';/)
    expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
    expect(res.headers.get('x-frame-options'), path).toBe('DENY')
    expect(res.headers.get('cache-control'), path).toBe('no-store')
    expect(res.headers.get('etag'), path).toBeNull()
  }

  it('answers 401 with one body to every path, the strict headers and nothing to cache', async () => {
    for (const path of PATHS) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.text(), path).toBe('Unauthorized')
      expectStrictHeaders(res, path)
    }
    // An ETag a browser kept from a signed-in visit opens nothing either.
    session.user = MEMBER
    const etag = (await app.request('/manual/guide.html')).headers.get('etag')!
    session.user = null
    expect((await app.request('/manual/guide.html', { headers: { 'If-None-Match': etag } })).status).toBe(401)
  })

  it('sends a browser opening a page to the sign-in page, back to that page or the index, never outside /manual/', async () => {
    const back = (location: string | null) => {
      const url = new URL(location!, 'https://acb.example')
      expect(url.origin + url.pathname).toBe('https://acb.example/login')
      return url.searchParams.get('redirect')
    }
    const html = { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }
    const expected: Record<string, string> = {
      '/manual': '/manual/index.html',
      '/manual/': '/manual/index.html',
      '/manual/guide.html': '/manual/guide.html',
      '/manual/no-such-page.html': '/manual/no-such-page.html', // the same shape as a real page: nothing told
      '/manual/images/files-tab.png': '/manual/images/files-tab.png',
      // Anything that is not one of the manual's file names goes back to the index.
      '/manual//evil.example': '/manual/index.html',
      '/manual/%2F%2Fevil.example': '/manual/index.html',
      '/manual/..%2F..%2Flogin': '/manual/index.html',
      '/manual/%5Cevil.example': '/manual/index.html',
      '/manual/https:%2F%2Fevil.example': '/manual/index.html',
      '/manual/notes.txt': '/manual/index.html',
      '/manual/images/': '/manual/index.html',
    }
    for (const [path, target] of Object.entries(expected)) {
      const res = await app.request(path, html)
      expect(res.status, path).toBe(302)
      expect(back(res.headers.get('location')), path).toBe(target)
      expectStrictHeaders(res, path)
    }
  })
})
