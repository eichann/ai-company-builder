/**
 * Integration Test: permission read APIs and push-rejection recording.
 *
 * - GET /overview, GET /permissions, GET|PUT /departments/:id/managers,
 *   GET /me/capabilities: authorization for owner, admin, department manager,
 *   member, non-member and no session; response shapes.
 * - PUT managers validation.
 * - Overview "attention" lists from client_activity.
 * - Push rejections recorded from the real pre-receive hook through the real
 *   git-http route; an accepted push records nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: 'pa-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { permissionsRoute } from '../../src/routes/permissions'
import { configureBareRepo } from '../../src/routes/git'
import { gitHttpRoute } from '../../src/routes/git-http'
import { resetClientActivityThrottle } from '../../src/lib/client-activity'
import { replaceDepartmentManagers } from '../../src/lib/permission-store'
import { parseHookRejections, sidebandMessages } from '../../src/lib/push-rejections'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/git-http', gitHttpRoute)

const CO = 'pa-co'
const OTHER = 'pa-other'
const ACTORS = ['pa-owner', 'pa-admin', 'pa-manager', 'pa-member'] as const
const ROLE: Record<string, string> = { 'pa-owner': 'owner', 'pa-admin': 'admin', 'pa-manager': 'member', 'pa-member': 'member' }

const ids = { sales: 'pa-d-sales', content: 'pa-d-content', otherDept: 'pa-d-other' }

function req(method: string, path: string, body?: unknown, raw?: string) {
  const init: RequestInit = { method }
  if (body !== undefined || raw !== undefined) {
    init.body = raw ?? JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  return app.request(path, init)
}

async function as(userId: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = userId
  const res = await req(method, path, body)
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data?: unknown } }
}

const ts = () => new Date().toISOString()
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

function addCompany(id: string, owner: string) {
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, owner, ts(), ts())
}
function addMember(companyId: string, userId: string, role: string) {
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`m-${companyId}-${userId}`, userId, companyId, role, ts(), ts())
}
function addDept(companyId: string, id: string, folder: string, sort: number) {
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, folder, folder, sort, ts(), ts())
}

beforeAll(() => {
  initDatabase()
  addCompany(CO, 'pa-owner')
  for (const a of ACTORS) addMember(CO, a, ROLE[a])
  addDept(CO, ids.sales, '営業部', 0)
  addDept(CO, ids.content, 'コンテンツ', 1)
  addCompany(OTHER, 'pa-other-owner')
  addMember(OTHER, 'pa-other-owner', 'owner')
  addDept(OTHER, ids.otherDept, 'other', 0)
  initDatabase() // seed scopes for the companies above
  replaceDepartmentManagers(db, ids.content, ['pa-manager'], 'pa-owner')

  // A private folder inside コンテンツ, and a rule-carrying scope elsewhere.
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('pa-s-students', ?, 'コンテンツ/受講生情報', 'folder', ?)`).run(CO, ts())
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('pa-r1', 'pa-s-students', 'user', 'pa-member', 1, 1, ?)`).run(ts())
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('pa-r2', 'pa-s-students', 'role', 'admin', 1, 0, ?)`).run(ts())
})

beforeEach(() => { currentUser.id = 'pa-owner' })

// ----------------------------------------------------------------------------
// Authorization matrix
// ----------------------------------------------------------------------------

describe('authorization', () => {
  const managersPath = `/api/companies/${CO}/departments/${ids.content}/managers`
  const matrix: Array<{ name: string; method: string; path: string; body?: unknown; expect: Record<string, number> }> = [
    {
      name: 'GET /overview', method: 'GET', path: `/api/companies/${CO}/overview`,
      expect: { 'pa-owner': 200, 'pa-admin': 200, 'pa-manager': 403, 'pa-member': 403, stranger: 404, none: 401 },
    },
    {
      name: 'GET /permissions', method: 'GET', path: `/api/companies/${CO}/permissions`,
      expect: { 'pa-owner': 200, 'pa-admin': 200, 'pa-manager': 200, 'pa-member': 403, stranger: 404, none: 401 },
    },
    {
      name: 'GET managers', method: 'GET', path: managersPath,
      expect: { 'pa-owner': 200, 'pa-admin': 200, 'pa-manager': 200, 'pa-member': 200, stranger: 404, none: 401 },
    },
    {
      name: 'PUT managers', method: 'PUT', path: managersPath, body: { userIds: ['pa-manager'] },
      expect: { 'pa-owner': 200, 'pa-admin': 200, 'pa-manager': 403, 'pa-member': 403, stranger: 404, none: 401 },
    },
    {
      name: 'GET /me/capabilities', method: 'GET', path: `/api/companies/${CO}/me/capabilities`,
      expect: { 'pa-owner': 200, 'pa-admin': 200, 'pa-manager': 200, 'pa-member': 200, stranger: 404, none: 401 },
    },
  ]
  for (const row of matrix) {
    for (const [who, status] of Object.entries(row.expect)) {
      it(`${row.name} as ${who} → ${status}`, async () => {
        const user = who === 'none' ? null : who === 'stranger' ? 'pa-stranger' : who
        const r = await as(user, row.method, row.path, row.body)
        expect(r.status, JSON.stringify(r.body)).toBe(status)
        if (status >= 400) expect(r.body.error).toBeTruthy()
        else expect(r.body.success).toBe(true)
      })
    }
  }

  it('a manager of a department in another company gets nothing here', async () => {
    replaceDepartmentManagers(db, ids.otherDept, ['pa-other-owner'], 'pa-other-owner')
    expect((await as('pa-other-owner', 'GET', `/api/companies/${CO}/permissions`)).status).toBe(404)
  })
})

// ----------------------------------------------------------------------------
// Shapes
// ----------------------------------------------------------------------------

type ScopeOut = {
  id: string; path: string; kind: string; departmentId: string | null; repoId: string | null; inherited: boolean
  rules: Array<{ id: string; subjectType: string; subjectId: string | null; subjectLabel: string; canRead: boolean; canWrite: boolean }>
  effectiveSummary: string
}

describe('GET /permissions', () => {
  it('returns every scope as a tree with rules, labels and summaries for owner/admin', async () => {
    const r = await as('pa-admin', 'GET', `/api/companies/${CO}/permissions`)
    const scopes = (r.body.data as { scopes: ScopeOut[] }).scopes
    expect(scopes.map(s => s.path)).toEqual(['', 'コンテンツ', 'コンテンツ/受講生情報', '営業部'])
    const [company, content, students, sales] = scopes
    expect(company).toMatchObject({ kind: 'company', departmentId: null, repoId: null, inherited: false, effectiveSummary: 'everyone-rw' })
    expect(company.rules).toEqual([
      { id: expect.any(String), subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: true, canWrite: true },
    ])
    expect(content).toMatchObject({ kind: 'department', departmentId: ids.content, inherited: true, rules: [], effectiveSummary: 'everyone-rw' })
    expect(sales).toMatchObject({ kind: 'department', departmentId: ids.sales, inherited: true, effectiveSummary: 'everyone-rw' })
    expect(students).toMatchObject({ kind: 'folder', departmentId: null, inherited: false, effectiveSummary: 'restricted' })
    expect(students.rules).toEqual([
      { id: 'pa-r1', subjectType: 'user', subjectId: 'pa-member', subjectLabel: 'Name pa-member', canRead: true, canWrite: true },
      { id: 'pa-r2', subjectType: 'role', subjectId: 'admin', subjectLabel: '管理者', canRead: true, canWrite: false },
    ])
  })

  it('gives a department manager only the subtrees of their departments', async () => {
    const r = await as('pa-manager', 'GET', `/api/companies/${CO}/permissions`)
    const scopes = (r.body.data as { scopes: ScopeOut[] }).scopes
    expect(scopes.map(s => s.path)).toEqual(['コンテンツ', 'コンテンツ/受講生情報'])
    // Inherited summary still reflects the company rule above the subtree.
    expect(scopes[0].effectiveSummary).toBe('everyone-rw')
  })
})

describe('GET /me/capabilities', () => {
  it('reports role and managed departments', async () => {
    expect((await as('pa-manager', 'GET', `/api/companies/${CO}/me/capabilities`)).body.data)
      .toEqual({ role: 'member', managedDepartmentIds: [ids.content] })
    expect((await as('pa-owner', 'GET', `/api/companies/${CO}/me/capabilities`)).body.data)
      .toEqual({ role: 'owner', managedDepartmentIds: [] })
  })
})

describe('department managers', () => {
  const path = (dept: string, co = CO) => `/api/companies/${co}/departments/${dept}/managers`

  it('GET lists managers with name and email', async () => {
    const r = await as('pa-member', 'GET', path(ids.content))
    expect(r.body.data).toEqual({ managers: [{ userId: 'pa-manager', name: 'Name pa-manager', email: 'pa-manager@example.com' }] })
  })

  it('PUT replaces the set, de-duplicates, and an empty list clears it', async () => {
    let r = await as('pa-owner', 'PUT', path(ids.sales), { userIds: ['pa-member', 'pa-admin', 'pa-member'] })
    expect(r.status).toBe(200)
    expect((r.body.data as { managers: Array<{ userId: string }> }).managers.map(m => m.userId).sort()).toEqual(['pa-admin', 'pa-member'])
    r = await as('pa-admin', 'PUT', path(ids.sales), { userIds: ['pa-member'] })
    expect((r.body.data as { managers: Array<{ userId: string }> }).managers.map(m => m.userId)).toEqual(['pa-member'])
    expect((await as('pa-member', 'GET', `/api/companies/${CO}/me/capabilities`)).body.data)
      .toEqual({ role: 'member', managedDepartmentIds: [ids.sales] })
    r = await as('pa-owner', 'PUT', path(ids.sales), { userIds: [] })
    expect(r.body.data).toEqual({ managers: [] })
  })

  it('PUT rejects malformed bodies and non-members', async () => {
    for (const body of [{}, { userIds: 'pa-member' }, { userIds: [1] }, { userIds: [''] }, null]) {
      const r = await as('pa-owner', 'PUT', path(ids.sales), body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    currentUser.id = 'pa-owner'
    expect((await req('PUT', path(ids.sales), undefined, '{not json')).status).toBe(400)
    const r = await as('pa-owner', 'PUT', path(ids.sales), { userIds: ['pa-member', 'pa-other-owner', 'nobody'] })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('pa-other-owner')
    expect((await as('pa-owner', 'GET', path(ids.sales))).body.data).toEqual({ managers: [] })
  })

  it('a department of another company or an unknown id is 404', async () => {
    expect((await as('pa-owner', 'GET', path(ids.otherDept))).status).toBe(404)
    expect((await as('pa-owner', 'PUT', path(ids.otherDept), { userIds: [] })).status).toBe(404)
    expect((await as('pa-owner', 'GET', path('nope'))).status).toBe(404)
  })

  it('removing a member from the company drops their manager assignments', async () => {
    addMember(CO, 'pa-leaver', 'member')
    await as('pa-owner', 'PUT', path(ids.sales), { userIds: ['pa-leaver'] })
    expect((await as('pa-owner', 'DELETE', `/api/companies/${CO}/members/pa-leaver`)).status).toBe(200)
    expect((await as('pa-owner', 'GET', path(ids.sales))).body.data).toEqual({ managers: [] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM department_managers WHERE user_id = ?').get('pa-leaver')).toEqual({ n: 0 })
  })
})

// ----------------------------------------------------------------------------
// Overview
// ----------------------------------------------------------------------------

describe('GET /overview', () => {
  const OV = 'pa-overview'
  const V_NEWEST_STALE = '0.0.2+ccccccc.20261101000000'
  const V_NEW = '0.0.1+95346af.20261021031200'
  const V_OLD = '0.0.1+810fdd6.20261001090000'

  beforeAll(() => {
    addCompany(OV, 'ov-owner')
    const activity: Array<[string, string | null, string | null, string | null, string | null]> = [
      // user, version, seen, fetch, push
      ['ov-owner', null, null, null, null], // admin panel only: never seen by the app
      ['ov-new', V_NEW, daysAgo(1), daysAgo(1), null],
      ['ov-old', V_OLD, daysAgo(2), null, daysAgo(2)],
      ['ov-unknown', 'garbage', daysAgo(3), daysAgo(3), null],
      ['ov-nosync', V_NEW, daysAgo(1), daysAgo(10), daysAgo(9)],
      ['ov-neversync', V_NEW, daysAgo(1), null, null],
      ['ov-gone', V_NEWEST_STALE, daysAgo(40), daysAgo(40), null], // not recent: ignored entirely
    ]
    for (const [u, v, seen, fetch, push] of activity) {
      addMember(OV, u, u === 'ov-owner' ? 'owner' : 'member')
      if (seen) {
        db.prepare(`INSERT INTO client_activity (user_id, company_id, client_version, client_platform, last_seen_at, last_fetch_at, last_push_at, updated_at)
          VALUES (?, ?, ?, 'darwin/arm64', ?, ?, ?, ?)`).run(u, OV, v, seen, fetch, push, seen)
      }
    }
    addDept(OV, 'ov-d1', 'a', 0)
    addDept(OV, 'ov-d2', 'b', 1)
    db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES ('ov-rj-old', ?, 'ov-old', 'SECRET_DETECTED', '["a.txt"]', ?)`).run(OV, daysAgo(2))
    db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES ('ov-rj-new', ?, 'ov-new', 'PERSONAL_PATH', '["x/.personal/m.md","y"]', ?)`).run(OV, daysAgo(1))
    db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES ('ov-rj-bad', ?, 'ov-new', 'WINPATH_DETECTED', 'not json', ?)`).run(OV, daysAgo(3))
    for (let i = 0; i < 25; i++) {
      db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, ?, 'ov-old', 'PROTECTED_CONFIG', '[]', ?)`).run(`ov-rj-${i}`, OV, daysAgo(10 + i))
    }
  })

  it('computes counts and attention lists', async () => {
    const r = await as('ov-owner', 'GET', `/api/companies/${OV}/overview`)
    expect(r.status).toBe(200)
    const data = r.body.data as {
      memberCount: number; departmentCount: number
      attention: Record<string, Array<Record<string, unknown>>>
    }
    expect(data.memberCount).toBe(7)
    expect(data.departmentCount).toBe(2)
    const userIds = (k: string) => data.attention[k].map(m => m.userId)
    // Newest build among members seen in 30 days is V_NEW (ov-gone's newer build is stale).
    expect(userIds('outdatedClients')).toEqual(['ov-old'])
    expect(userIds('unknownClients')).toEqual(['ov-unknown'])
    expect(userIds('notSyncedRecently').sort()).toEqual(['ov-neversync', 'ov-nosync'])
    expect(data.attention.outdatedClients[0]).toEqual({
      userId: 'ov-old', name: 'Name ov-old', email: 'ov-old@example.com', role: 'member',
      clientVersion: V_OLD, lastSeenAt: expect.any(String), lastFetchAt: null, lastPushAt: expect.any(String),
    })
    const rj = data.attention.recentRejections
    expect(rj).toHaveLength(20)
    expect(rj.slice(0, 3).map(x => x.id)).toEqual(['ov-rj-new', 'ov-rj-old', 'ov-rj-bad'])
    expect(rj[0]).toEqual({ id: 'ov-rj-new', userId: 'ov-new', name: 'Name ov-new', marker: 'PERSONAL_PATH', paths: ['x/.personal/m.md', 'y'], createdAt: expect.any(String) })
    expect(rj[2].paths).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// Push rejection recording through git-http + the real hook
// ----------------------------------------------------------------------------

describe('push rejection parsing', () => {
  const pkt = (b: Buffer) => Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b])
  const band = (n: number, s: string) => pkt(Buffer.concat([Buffer.from([n]), Buffer.from(s)]))

  it('reads side-band 2 split across packets and parses every section', () => {
    const text = [
      '', '========================================',
      '[PERSONAL_PATH] 個人用フォルダ', '========================================', '',
      '以下は個人用フォルダ(.personal)の中のファイルです。', '  - 営業部/.personal/memo.md', '',
      '========================================', '',
      '========================================', '[SECRET_DETECTED] シークレット', '========================================',
      '  - leak.txt (AWS Access Key ID)', '  - leak.txt (Private Key)', '  - odd (name).txt (Slack Token)',
      '========================================', '',
      '[FUTURE_CHECK] 新しいチェック', '========================================', '  - a', '========================================',
    ].join('\n')
    const body = Buffer.concat([band(1, 'irrelevant'), band(2, text.slice(0, 50)), band(2, text.slice(50)), Buffer.from('0000')])
    expect(parseHookRejections(sidebandMessages(body))).toEqual([
      { marker: 'PERSONAL_PATH', paths: ['営業部/.personal/memo.md'] },
      { marker: 'SECRET_DETECTED', paths: ['leak.txt', 'odd (name).txt'] },
      { marker: 'FUTURE_CHECK', paths: ['a'] },
    ])
  })

  it('caps the number and length of paths', () => {
    const lines = ['[WINPATH_DETECTED] x', '====', ...Array.from({ length: 80 }, (_, i) => `  - ${i}${'p'.repeat(600)}`), '====']
    const [r] = parseHookRejections(lines.join('\n'))
    expect(r.paths).toHaveLength(50)
    expect(r.paths[0]).toHaveLength(512)
  })
})

describe('git-http records rejected pushes', () => {
  const RC = 'pa-rejco'
  const tokens: Record<string, string> = {}
  let workDir: string
  let server: { close: () => void }
  let gitBase: string
  let clone: string

  const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
  const writeFile = (rel: string, content: string) => {
    const full = join(clone, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  const commitAll = (message: string) => {
    git(['add', '-A', '-f', '.'], clone)
    git(['commit', '-q', '--no-verify', '-m', message], clone)
  }
  const pushAs = (userId: string): Promise<{ ok: boolean; output: string }> => {
    const url = gitBase.replace('http://', `http://git:${tokens[userId]}@`)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    delete env.ACB_PUSHER_ROLE
    return new Promise((resolve) => {
      const p = spawn('git', ['push', url, 'HEAD:main'], { cwd: clone, env })
      let output = ''
      p.stdout.on('data', (d: Buffer) => { output += d.toString() })
      p.stderr.on('data', (d: Buffer) => { output += d.toString() })
      p.on('close', (code) => resolve({ ok: code === 0, output }))
    })
  }
  const rows = () => db.prepare('SELECT user_id, marker, paths FROM push_rejections WHERE company_id = ? ORDER BY created_at, marker').all(RC) as Array<{ user_id: string; marker: string; paths: string }>
  const waitForRows = async (n: number) => {
    for (let i = 0; i < 100 && rows().length < n; i++) await new Promise(r => setTimeout(r, 20))
    return rows()
  }

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'acb-push-rejections-'))
    addCompany(RC, 'rj-owner')
    const expires = new Date(Date.now() + 3600_000).toISOString()
    const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
    for (const [id, role] of [['rj-owner', 'owner'], ['rj-member', 'member']]) {
      tokens[id] = `tok-${id}`
      authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
      authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${id}`, id, tokens[id], expires)
      addMember(RC, id, role)
    }
    authDb.close()
    const bare = join(process.env.REPOS_DIR!, `${RC}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)

    clone = join(workDir, 'clone')
    mkdirSync(clone)
    git(['init', '-q', '-b', 'main'], clone)
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)

    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
        gitBase = `http://127.0.0.1:${info.port}/api/git-http/${RC}.git`
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  beforeEach(() => resetClientActivityThrottle())

  it('records nothing for an accepted push', async () => {
    writeFile('README.md', 'hi\n')
    commitAll('first')
    const r = await pushAs('rj-member')
    expect(r.ok, r.output).toBe(true)
    await new Promise(res => setTimeout(res, 200))
    expect(rows()).toEqual([])
  })

  it('records one row per hook section with the paths it listed', async () => {
    writeFile('営業部/.personal/memo.md', 'private\n')
    writeFile('leak.txt', `key=AKIA${'A'.repeat(16)}\n`)
    commitAll('personal + secret')
    const r = await pushAs('rj-member')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('PERSONAL_PATH')
    const got = await waitForRows(2)
    expect(got.map(x => ({ ...x, paths: JSON.parse(x.paths) }))).toEqual([
      { user_id: 'rj-member', marker: 'PERSONAL_PATH', paths: ['営業部/.personal/memo.md'] },
      { user_id: 'rj-member', marker: 'SECRET_DETECTED', paths: ['leak.txt'] },
    ])
    git(['reset', '-q', '--hard', 'HEAD~1'], clone)
  })

  it('records a protected-config rejection and shows it in the overview', async () => {
    writeFile('.claude/settings.json', '{"hooks":{}}\n')
    commitAll('settings')
    const r = await pushAs('rj-member')
    expect(r.ok).toBe(false)
    const got = await waitForRows(3)
    expect(got[2]).toEqual({ user_id: 'rj-member', marker: 'PROTECTED_CONFIG', paths: '[".claude/settings.json"]' })
    git(['reset', '-q', '--hard', 'HEAD~1'], clone)

    const ov = await as('rj-owner', 'GET', `/api/companies/${RC}/overview`)
    const rj = (ov.body.data as { attention: { recentRejections: Array<{ marker: string; name: string | null }> } }).attention.recentRejections
    expect(rj.map(x => x.marker).sort()).toEqual(['PERSONAL_PATH', 'PROTECTED_CONFIG', 'SECRET_DETECTED'])
    expect(rj[0].name).toBe('Name rj-member')
  })
})
