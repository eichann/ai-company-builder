/**
 * Integration Test: the administrator / FDE guide at /manual-admin/ (server.md "The
 * administrator guide").
 *
 * - Built from `manual-admin/` by the members' manual's build (same rules; no images folder is
 *   fine while no page shows a picture), into a site of its own.
 * - Answered to an owner or admin of at least one company — this one or another — with the
 *   manual's strict headers; checked on every request, so a role taken away counts at once.
 * - Any other signed-in account (a member, a department manager, someone in no company) gets,
 *   for every path, exactly the 404 of a path that names nothing: nothing tells the guide exists.
 * - Without a session: the manual's answers (401, or for a browser the sign-in page with a way
 *   back inside /manual-admin/ only).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { request as httpRequest } from 'http'
import type { AddressInfo } from 'net'

type SessionUser = { id: string; email: string; name: string; image: null; emailVerified: boolean }
// Who the request is signed in as (null: no session); each test sets it.
const session = vi.hoisted(() => ({ user: null as null | SessionUser }))

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
const CO = 'mg-company'
const OTHER = 'mg-other'
const SALES = 'mg-sales'

const as = (id: string): SessionUser => ({ id, email: `${id}@example.com`, name: id, image: null, emailVerified: true })
const USERS = {
  owner: as('mg-owner'),
  admin: as('mg-admin'),
  member: as('mg-member'),
  manager: as('mg-manager'),
  // Signed in on this server, member of no company.
  outsider: as('mg-outsider'),
  // A plain member here, admin of another company: allowed (the guide is the same for every company).
  memberHereAdminThere: as('mg-member-admin-there'),
  // Admin of the other company only.
  adminElsewhereOnly: as('mg-admin-elsewhere'),
  // Member of two companies, admin of neither.
  memberOfTwo: as('mg-member-two'),
}

let root: string
let site: string
let memberSite: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any

const ts = () => new Date().toISOString()
function membership(userId: string, companyId: string, role: string) {
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`m-${userId}-${companyId}`, userId, companyId, role, ts(), ts())
}

function writeSource(dir: string, pages: Record<string, string>) {
  // No images/ folder at all: the guide has no pictures yet.
  mkdirSync(join(dir, 'pages'), { recursive: true })
  for (const [name, text] of Object.entries(pages)) writeFileSync(join(dir, 'pages', name), text)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'acb-manual-admin-'))
  site = join(root, 'admin-site')
  memberSite = join(root, 'member-site')
  const { buildManualSite } = await import('../../src/lib/manual-build')
  const source = join(root, 'manual-admin')
  writeSource(source, {
    'index.md': '# 管理者・FDE の手引き\n\n[部署](03-busho.md)\n\n［写真：/companies/…/departments — 部署の一覧］\n\n<script>alert(1)</script>\n',
    '03-busho.md': '# 部署\n\n## 部署を作る\n\n本文\n',
  })
  buildManualSite(source, site, TOKENS, 'manual-admin')
  const memberSource = join(root, 'manual')
  writeSource(memberSource, { 'index.md': '# ACB の使い方\n' })
  buildManualSite(memberSource, memberSite, TOKENS, 'manual')
  // Beside the built files, never listed in the manifest.
  writeFileSync(join(site, 'notes.txt'), 'not part of the guide')
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE-SECRET')
  process.env.MANUAL_ADMIN_DIR = site
  process.env.MANUAL_DIR = memberSite
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, USERS.owner.id, ts(), ts())
  }
  membership(USERS.owner.id, CO, 'owner')
  membership(USERS.admin.id, CO, 'admin')
  membership(USERS.member.id, CO, 'member')
  membership(USERS.manager.id, CO, 'member')
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, '営業部', '営業部', 'Folder', '#000000', 0, 1, ?, ?)`).run(SALES, CO, ts(), ts())
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, SALES, USERS.manager.id, ts())
  membership(USERS.memberHereAdminThere.id, CO, 'member')
  membership(USERS.memberHereAdminThere.id, OTHER, 'admin')
  membership(USERS.adminElsewhereOnly.id, OTHER, 'admin')
  membership(USERS.memberOfTwo.id, CO, 'member')
  membership(USERS.memberOfTwo.id, OTHER, 'member')
  app = (await import('../../src/app')).app
})

afterAll(() => {
  delete process.env.MANUAL_ADMIN_DIR
  delete process.env.MANUAL_DIR
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => { session.user = null })

// Every file of the built guide, and its Content-Type.
const FILES: Record<string, string> = {
  '/manual-admin/': 'text/html; charset=utf-8',
  '/manual-admin/index.html': 'text/html; charset=utf-8',
  '/manual-admin/03-busho.html': 'text/html; charset=utf-8',
  '/manual-admin/manual.css': 'text/css; charset=utf-8',
  '/manual-admin/manifest.json': 'application/json; charset=utf-8',
}
// Paths that name nothing (or that the site never serves).
const NOTHING = [
  '/manual-admin/no-such-page.html', '/manual-admin/notes.txt', '/manual-admin/images/', '/manual-admin/images/x.png',
  '/manual-admin/%2e%2e/outside.txt', '/manual-admin/..%2foutside.txt', '/manual-admin/%2fetc%2fpasswd',
  '/manual-admin/.manifest.json', '/manual-admin/Index.html', '/manual-admin//index.html',
]

function expectStrictHeaders(res: Response, path: string) {
  expect(res.headers.get('content-security-policy'), path).toMatch(/^default-src 'none'; style-src 'self'; img-src 'self';/)
  expect(res.headers.get('content-security-policy'), path).not.toMatch(/script-src/)
  expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
  expect(res.headers.get('x-frame-options'), path).toBe('DENY')
  expect(res.headers.get('referrer-policy'), path).toBe('no-referrer')
  expect(res.headers.get('cross-origin-resource-policy'), path).toBe('same-origin')
}

/** The parts of a refusal another caller could compare: status, body and the headers that matter. */
async function shape(res: Response) {
  const headers: Record<string, string | null> = {}
  for (const name of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-frame-options',
    'referrer-policy', 'cross-origin-resource-policy', 'etag', 'vary', 'location']) headers[name] = res.headers.get(name)
  return { status: res.status, body: await res.text(), headers }
}

describe('building the administrator guide', () => {
  it('builds with no images folder, carries no script, and names the guide in each title', () => {
    const html = readFileSync(join(site, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('href="03-busho.html"')
    expect(html).toContain('［写真：')
    expect(readFileSync(join(site, '03-busho.html'), 'utf8')).toContain('<title>部署 — AI Company Builder 管理者・FDE の手引き</title>')
    const manifest = JSON.parse(readFileSync(join(site, 'manifest.json'), 'utf8'))
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual(['03-busho.html', 'index.html', 'manual.css'])
  })

  it('stops when a page shows a picture and there is no images folder, and builds the repository\'s manual-admin/', async () => {
    const { buildManualSite } = await import('../../src/lib/manual-build')
    const dir = join(root, 'bad-picture')
    writeSource(dir, { 'index.md': '# x\n\n![画面](../images/home.png)\n' })
    expect(() => buildManualSite(dir, join(dir, 'out'), TOKENS, 'manual-admin')).toThrow(/manual-admin|images\/home\.png/)
    const real = buildManualSite(join(__dirname, '../../../manual-admin'), join(root, 'real'), TOKENS, 'manual-admin')
    expect(real.pages[0].id).toBe('index')
    expect(real.pages.length).toBeGreaterThan(1)
  })
})

describe('GET /manual-admin/ for owners and admins', () => {
  const ALLOWED = ['owner', 'admin', 'memberHereAdminThere', 'adminElsewhereOnly'] as const

  it.each(ALLOWED)('answers every file to %s, with the strict headers', async (who) => {
    session.user = USERS[who]
    for (const [path, type] of Object.entries(FILES)) {
      const res = await app.request(path)
      expect(res.status, `${who} ${path}`).toBe(200)
      expect(res.headers.get('content-type'), path).toBe(type)
      expect(res.headers.get('cache-control'), path).toBe('private, no-cache')
      expect(res.headers.get('etag'), path).toMatch(/^"[0-9a-f]{64}"$/)
      expectStrictHeaders(res, path)
    }
    const redirect = await app.request('/manual-admin')
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('/manual-admin/index.html')
    expectStrictHeaders(redirect, '/manual-admin')
  })

  it('serves the guide, not the members\' manual (each site from its own folder), and answers 304 for an unchanged file', async () => {
    session.user = USERS.admin
    expect(await (await app.request('/manual-admin/index.html')).text()).toContain('管理者・FDE の手引き')
    expect(await (await app.request('/manual/index.html')).text()).toContain('ACB の使い方')
    const first = await app.request('/manual-admin/03-busho.html')
    const again = await app.request('/manual-admin/03-busho.html', { headers: { 'If-None-Match': first.headers.get('etag') } })
    expect(again.status).toBe(304)
  })

  it('answers 404 to anything the site does not hold: beside the site, listings, traversal, hidden names, case', async () => {
    session.user = USERS.owner
    for (const path of NOTHING) {
      const res = await app.request(path)
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).toMatch(/^(Not found|\{"error":"Not found","code":"NOT_FOUND"\})$/)
    }
  })

  it('serves nothing through raw ../ segments sent over HTTP', async () => {
    session.user = USERS.owner
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
      for (const path of ['/manual-admin/../outside.txt', '/manual-admin/images/../../outside.txt', '/manual-admin/..\\outside.txt']) {
        const res = await get(path)
        expect(res.body, path).not.toContain('OUTSIDE-SECRET')
        expect(res.status, path).not.toBe(200)
      }
    } finally {
      server.close()
    }
  })

  it('asks again on every request: an admin made a member is refused at once', async () => {
    const demoted = as('mg-demoted')
    membership(demoted.id, CO, 'admin')
    session.user = demoted
    expect((await app.request('/manual-admin/index.html')).status).toBe(200)
    db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND company_id = ?').run('member', demoted.id, CO)
    expect((await app.request('/manual-admin/index.html')).status).toBe(404)
    db.prepare('DELETE FROM memberships WHERE user_id = ?').run(demoted.id)
  })

  it('answers 404 when the guide was not built', async () => {
    session.user = USERS.owner
    process.env.MANUAL_ADMIN_DIR = join(root, 'nothing-here')
    try {
      expect((await app.request('/manual-admin/')).status).toBe(404)
    } finally {
      process.env.MANUAL_ADMIN_DIR = site
    }
  })
})

describe('GET /manual-admin/ for anyone else signed in', () => {
  const REFUSED = ['member', 'manager', 'outsider', 'memberOfTwo'] as const

  it.each(REFUSED)('gives %s, for every path, exactly the answer of a path that names nothing', async (who) => {
    // What an owner gets for a path that names nothing: the answer every refusal must equal.
    session.user = USERS.owner
    const nothing = await shape(await app.request('/manual-admin/no-such-page.html'))
    const etag = (await app.request('/manual-admin/03-busho.html')).headers.get('etag')!
    expect(nothing.status).toBe(404)
    expect(nothing.headers['cache-control']).toBe('no-store')
    session.user = USERS[who]
    const html = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    for (const path of ['/manual-admin', ...Object.keys(FILES), ...NOTHING.slice(0, 4)]) {
      for (const headers of [{}, html, { 'If-None-Match': etag }]) {
        const res = await app.request(path, { headers })
        expect(await shape(res), `${who} ${path} ${JSON.stringify(headers)}`).toEqual(nothing)
      }
    }
  })
})

describe('GET /manual-admin/ without a session', () => {
  const PATHS = ['/manual-admin', ...Object.keys(FILES), ...NOTHING.slice(0, 4)]

  it('answers 401 with one body to every path, the strict headers and nothing to cache', async () => {
    for (const path of PATHS) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(await res.text(), path).toBe('Unauthorized')
      expect(res.headers.get('cache-control'), path).toBe('no-store')
      expect(res.headers.get('etag'), path).toBeNull()
      expectStrictHeaders(res, path)
    }
  })

  it('sends a browser to the sign-in page, back to that page or the guide\'s index, never outside /manual-admin/', async () => {
    const back = (location: string | null) => {
      const url = new URL(location!, 'https://acb.example')
      expect(url.origin + url.pathname).toBe('https://acb.example/login')
      return url.searchParams.get('redirect')
    }
    const html = { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }
    const expected: Record<string, string> = {
      '/manual-admin': '/manual-admin/index.html',
      '/manual-admin/': '/manual-admin/index.html',
      '/manual-admin/03-busho.html': '/manual-admin/03-busho.html',
      '/manual-admin/no-such-page.html': '/manual-admin/no-such-page.html',
      '/manual-admin//evil.example': '/manual-admin/index.html',
      '/manual-admin/%2F%2Fevil.example': '/manual-admin/index.html',
      '/manual-admin/..%2F..%2Flogin': '/manual-admin/index.html',
      '/manual-admin/%5Cevil.example': '/manual-admin/index.html',
      '/manual-admin/https:%2F%2Fevil.example': '/manual-admin/index.html',
      '/manual-admin/notes.txt': '/manual-admin/index.html',
    }
    for (const [path, target] of Object.entries(expected)) {
      const res = await app.request(path, html)
      expect(res.status, path).toBe(302)
      expect(back(res.headers.get('location')), path).toBe(target)
      expect(res.headers.get('cache-control'), path).toBe('no-store')
      expectStrictHeaders(res, path)
    }
  })
})
