/**
 * Security Test: Path traversal prevention
 *
 * A company id or repository name taken from the URL never leads outside the
 * repositories directory. Every route that builds a filesystem path from one
 * is sent `..%2F…` ids for real: it answers 400 / 403 / 404, serves nothing
 * of a sentinel repository placed next to the repositories directory
 * (`<DATA_DIR>/outside.git`), and leaves that repository unchanged.
 *
 * Two attackers: a member of their own company only (the realistic one —
 * membership and the path rules both stand in the way), and the same member
 * with a membership row whose company id itself contains `../` (cannot be
 * created through the API: ids are generated) — so the path rules are shown
 * to hold on their own, not only behind the membership check.
 *
 * Folder names: isValidFolderName below (shared/core/names.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

// u-attacker: a member of their own company only. u-dotted: also has a
// membership row for the company id "../outside".
const current = vi.hoisted(() => ({ user: 'u-attacker' }))

// Mock auth so importing the routes does not load the real auth module,
// which calls process.exit(1) at import time when AUTH_SECRET is unset.
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    ({ id: current.user, email: `${current.user}@example.com`, name: current.user, image: null, emailVerified: true })),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { isValidFolderName } from '../../shared/core/names'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const OWN = 'pt-own'
/** The company id the second attacker is (impossibly) a member of. */
const DOTTED = '../outside'
const SECRET = 'SENTINEL-CONTENT-8d1f'
const REFUSED = [400, 403, 404]

let workDir: string
let sentinel: string
let origin: string
let server: { close: () => void }
let sentinelTip: string
let sentinelNext: string
let sentinelPack: Buffer

const git = (args: string[], cwd?: string, input?: string) =>
  execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}), ...(input !== undefined ? { input } : {}) })
const refsOf = (repo: string) => git(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)']).toString()

function pkt(line: string): Buffer {
  const body = Buffer.from(line)
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body])
}
const FLUSH = Buffer.from('0000')

async function send(path: string, method = 'GET', body?: Buffer, contentType?: string) {
  // git-http reads the session token; the API routes the (mocked) session.
  const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`git:tok-${current.user}`).toString('base64')}` }
  if (contentType) headers['Content-Type'] = contentType
  const res = await fetch(`${origin}${path}`, { method, headers, ...(body ? { body } : {}) })
  return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('latin1') }
}

/** Every request whose URL carries `id` where a company id / repository name goes. */
function requestsFor(id: string): Array<[label: string, run: () => ReturnType<typeof send>]> {
  const enc = encodeURIComponent(id)
  const want = () => Buffer.concat([pkt(`want ${sentinelTip}\n`), FLUSH, pkt('done\n')])
  const push = () => Buffer.concat([pkt(`${sentinelTip} ${sentinelNext} refs/heads/main\0report-status\n`), FLUSH, sentinelPack])
  return [
    ['git-http info/refs (fetch)', () => send(`/api/git-http/${enc}.git/info/refs?service=git-upload-pack`)],
    ['git-http info/refs (push)', () => send(`/api/git-http/${enc}.git/info/refs?service=git-receive-pack`)],
    ['git-http HEAD', () => send(`/api/git-http/${enc}.git/HEAD`)],
    ['git-http upload-pack', () => send(`/api/git-http/${enc}.git/git-upload-pack`, 'POST', want(), 'application/x-git-upload-pack-request')],
    ['git-http receive-pack', () => send(`/api/git-http/${enc}.git/git-receive-pack`, 'POST', push(), 'application/x-git-receive-pack-request')],
    ['git-http scope repo, company id', () => send(`/api/git-http/${enc}/scopes/s1.git/info/refs?service=git-upload-pack`)],
    ['git-http scope repo, repo name', () => send(`/api/git-http/${OWN}/scopes/${encodeURIComponent(`../../${id.replace(/^(\.\.\/)+/, '')}`)}.git/info/refs?service=git-upload-pack`)],
    ['/api/git/repos', () => send(`/api/git/repos/${enc}`)],
    ['departments', () => send(`/api/companies/${enc}/departments`)],
    ['files/tree', () => send(`/api/companies/${enc}/files/tree`)],
    ['files/content', () => send(`/api/companies/${enc}/files/content?path=${encodeURIComponent('sentinel-secret/README.md')}`)],
    ['folder-sizes', () => send(`/api/companies/${enc}/folder-sizes?path=sentinel-secret&measure=sentinel-secret`)],
  ]
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-path-traversal-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  const now = new Date().toISOString()

  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const user of ['u-attacker', 'u-dotted']) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(user, `${user}@example.com`, user)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)')
      .run(`s-${user}`, user, `tok-${user}`, new Date(Date.now() + 3600_000).toISOString())
  }
  authDb.close()
  const { ensureCompanyScope } = await import('../../src/lib/permission-store')
  const membership = (user: string, company: string) =>
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}-${company}`, user, company, 'owner', now, now)
  for (const id of [OWN, DOTTED]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `slug-${id}`, 'u-attacker', now, now)
    ensureCompanyScope(db, id)
  }
  membership('u-attacker', OWN)
  membership('u-dotted', OWN)
  membership('u-dotted', DOTTED)

  const { configureBareRepo } = await import('../../src/routes/git')
  const own = join(process.env.REPOS_DIR!, `${OWN}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', own])
  configureBareRepo(own)

  // The sentinel: a repository next to the repositories directory, i.e. at
  // <REPOS_DIR>/../outside.git — where `../outside` would resolve.
  sentinel = join(process.env.REPOS_DIR!, '..', 'outside.git')
  git(['init', '-q', '--bare', '--initial-branch=main', sentinel])
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'test'], seed)
  git(['config', 'user.email', 'test@example.com'], seed)
  mkdirSync(join(seed, 'sentinel-secret'))
  writeFileSync(join(seed, 'sentinel-secret', 'README.md'), `${SECRET}\n`)
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'sentinel'], seed)
  git(['push', '-q', sentinel, 'main'], seed)
  sentinelTip = git(['rev-parse', 'HEAD'], seed).toString().trim()
  writeFileSync(join(seed, 'planted.md'), 'planted\n')
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'planted'], seed)
  sentinelNext = git(['rev-parse', 'HEAD'], seed).toString().trim()
  sentinelPack = git(['pack-objects', '--stdout', '--revs'], seed, `${sentinelNext}\n^${sentinelTip}\n`)

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const { gitRoute } = await import('../../src/routes/git')
  const { departmentsRoute } = await import('../../src/routes/departments')
  const { folderSizesRoute } = await import('../../src/routes/folder-sizes')
  const { companyFilesRoute } = await import('../../src/routes/company-files')
  const app = new Hono()
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  app.route('/api/companies/:companyId/folder-sizes', folderSizesRoute)
  app.route('/api/companies/:companyId/files', companyFilesRoute)
  app.route('/api/git', gitRoute)
  app.route('/api/git-http', gitHttpRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      origin = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('Path traversal through company ids and repository names in the URL', () => {
  it('the sentinel is reachable as a repository (the requests below would read or move it)', () => {
    expect(git(['-C', sentinel, 'show', 'main:sentinel-secret/README.md']).toString()).toContain(SECRET)
  })

  for (const id of ['../outside', '../../repos/../outside', '..']) {
    it(`a member of another company: "${id}" is refused everywhere, the sentinel unread and unchanged`, async () => {
      current.user = 'u-attacker'
      const before = refsOf(sentinel)
      for (const [label, run] of requestsFor(id)) {
        const r = await run()
        expect(REFUSED, `${label}: ${r.status}`).toContain(r.status)
        expect(r.text, label).not.toContain(SECRET)
        expect(r.text, label).not.toContain('sentinel-secret')
      }
      expect(refsOf(sentinel)).toBe(before)
    })
  }

  it('even with a membership row for "../outside", nothing of the sentinel is served or changed', async () => {
    current.user = 'u-dotted'
    const before = refsOf(sentinel)
    for (const [label, run] of requestsFor(DOTTED)) {
      const r = await run()
      expect(r.text, label).not.toContain(SECRET)
      expect(r.text, label).not.toContain('sentinel-secret')
      expect(r.text, label).not.toContain(sentinelTip)
      if (label.startsWith('git-http') || label === '/api/git/repos') expect(REFUSED, `${label}: ${r.status}`).toContain(r.status)
    }
    expect(refsOf(sentinel)).toBe(before)
  })
})

describe('Folder names', () => {
  it('isValidFolderName rejects path traversal and injection characters', () => {
    // Exercise the actual implementation imported from departments.ts,
    // not a regex literal copied into the test. This keeps the test honest
    // if the implementation's validation ever changes.

    // These must be rejected (path traversal, injection, hidden files, etc.)
    const maliciousNames = [
      '../etc',
      '..\\etc',
      '..',
      '.',
      '.hidden',
      '/absolute',
      'path/traversal',
      'back\\slash',
      'name;injection',
      'name`injection`',
      'name$(cmd)',
      'name with space',
      '',
      ' ',
      '-startsWithDash',
      '.startsWithDot',
    ]

    for (const name of maliciousNames) {
      expect(
        isValidFolderName(name),
        `isValidFolderName should reject "${name}"`
      ).toBe(false)
    }

    // These must be accepted. Department folders allow ASCII and Japanese
    // (hiragana / katakana / kanji), per the folder-naming rule in shared/core/names.ts.
    const validNames = [
      'sales',
      'my-dept',
      'dept_name',
      'dept.v2',
      'Department1',
      '営業部',       // kanji
      'えいぎょう',    // hiragana
      'エンジニア',    // katakana
      '開発_dev',     // kanji + ASCII mix
    ]

    for (const name of validNames) {
      expect(
        isValidFolderName(name),
        `isValidFolderName should accept "${name}"`
      ).toBe(true)
    }
  })
})
