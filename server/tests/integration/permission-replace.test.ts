/**
 * Integration Test: PUT /permissions/scopes/by-path — the admin panel's
 * per-folder choice (上の階層と同じ / 全員 / 指定した人だけ), saved as one
 * complete rule set.
 *
 * - Authorization: same as the per-rule endpoints (owner/admin everywhere, a
 *   department manager only inside their department, members never).
 * - Validation: read: false, owner/admin subjects, duplicates, a set without
 *   an everyone rule, an empty company root, unknown folders.
 * - All or nothing: a refused request or a failing write changes nothing.
 * - Nothing is copied from the parent: what is sent is what is stored, and
 *   resolveAccess gives the expected result for the typical choices.
 * - GET /permissions exposes what each scope inherits (inheritedFrom), also
 *   to a manager whose department inherits from the company root.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const currentUser = vi.hoisted(() => ({ id: 'rp-owner' as string | null }))

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

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { permissionsRoute } from '../../src/routes/permissions'
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { replaceDepartmentManagers, replaceScopeRules, sqlitePermissionRepository } from '../../src/adapters/sqlite/permission-store'
import { resolveAccess, type SubjectType } from '../../shared/core/permissions'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const app = new Hono()
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)

const CO = 'rp-co'
const ROLE: Record<string, string> = {
  'rp-owner': 'owner', 'rp-admin': 'admin', 'rp-manager': 'member', 'rp-member': 'member', 'rp-member2': 'member',
}
const ids = { sales: 'rp-d-sales', content: 'rp-d-content' }
const base = `/api/companies/${CO}`
const URL_ = `${base}/permissions/scopes/by-path`

async function as(userId: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = userId
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data?: Loose } }
}
const put = (userId: string | null, body: unknown) => as(userId, 'PUT', URL_, body)

const ts = () => new Date().toISOString()
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

const everyone = (canWrite: boolean) => ({ subjectType: 'everyone', canWrite })
const user = (id: string, canWrite = true) => ({ subjectType: 'user', subjectId: id, canWrite })
const roleMember = (canWrite = true) => ({ subjectType: 'role', subjectId: 'member', canWrite })
/** 指定した人だけ: everyone reads, the chosen subjects edit. */
const onlyThese = (...subjects: Array<Record<string, unknown>>) => [everyone(false), ...subjects]

let tmp: string

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'Co', CO, 'rp-owner', ts(), ts())
  for (const [u, role] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${u}`, u, CO, role, ts(), ts())
    // Everyone runs an app that recovers from [WRITE_DENIED], so the
    // outdated-app guard stays out of these tests (outdated-app-guard.test.ts).
    db.prepare('INSERT INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(u, CO, '0.0.1+a031b73.20261021182826', ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.sales, CO, '営業部', '営業部', 0, ts(), ts())
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.content, CO, 'コンテンツ', 'コンテンツ', 1, ts(), ts())
  initDatabase() // seed scopes
  replaceDepartmentManagers(db, ids.content, ['rp-manager'], 'rp-owner')

  tmp = mkdtempSync(join(tmpdir(), 'rp-'))
  const work = join(tmp, 'work')
  mkdirSync(work)
  git(['init', '-q', '-b', 'main'], work)
  for (const dir of ['営業部/契約書', 'コンテンツ/ブログ', 'コンテンツ/受講生情報']) {
    mkdirSync(join(work, dir), { recursive: true })
    writeFileSync(join(work, dir, '.gitkeep'), '')
  }
  git(['add', '-A'], work)
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], work)
  git(['clone', '-q', '--bare', work, join(process.env.REPOS_DIR!, `${CO}.git`)], tmp)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  currentUser.id = 'rp-owner'
  // Every test starts from the seed: "everyone: read + write" on the root only.
  const root = db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ''`).get(CO) as { id: string }
  db.prepare(`DELETE FROM scope_rules WHERE scope_id IN (SELECT id FROM scopes WHERE company_id = ?)`).run(CO)
  db.prepare(`DELETE FROM scopes WHERE company_id = ? AND kind = 'folder'`).run(CO)
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)`)
    .run(`root-${Math.random()}`, root.id, ts())
})

type Row = { subjectType: SubjectType; subjectId: string | null; canRead: boolean; canWrite: boolean }
function rulesAt(path: string): Row[] | undefined {
  const s = db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ?`).get(CO, path) as { id: string } | undefined
  if (!s) return undefined
  return (db.prepare(`SELECT subject_type, subject_id, can_read, can_write FROM scope_rules WHERE scope_id = ? ORDER BY created_at, rowid`).all(s.id) as Loose[])
    .map(r => ({ subjectType: r.subject_type, subjectId: r.subject_id, canRead: r.can_read === 1, canWrite: r.can_write === 1 }))
}
const allRules = () => db.prepare(`SELECT r.* FROM scope_rules r JOIN scopes s ON s.id = r.scope_id WHERE s.company_id = ? ORDER BY r.id`).all(CO)
const allScopes = () => db.prepare(`SELECT * FROM scopes WHERE company_id = ? ORDER BY id`).all(CO)

const repo = sqlitePermissionRepository(db)
const canEdit = (userId: string, path: string) => resolveAccess(CO, userId, path, repo).write
const canRead = (userId: string, path: string) => resolveAccess(CO, userId, path, repo).read

// ----------------------------------------------------------------------------

describe('authorization', () => {
  const cases: Array<{ name: string; path: string; expect: Record<string, number> }> = [
    { name: 'a folder inside the managed department', path: 'コンテンツ/受講生情報', expect: { 'rp-owner': 200, 'rp-admin': 200, 'rp-manager': 200, 'rp-member': 403, stranger: 404, none: 401 } },
    { name: 'the managed department itself', path: 'コンテンツ', expect: { 'rp-manager': 200 } },
    { name: 'another department', path: '営業部', expect: { 'rp-manager': 403, 'rp-member': 403, 'rp-admin': 200 } },
    { name: 'a folder in another department', path: '営業部/契約書', expect: { 'rp-manager': 403, 'rp-owner': 200 } },
    { name: 'the company root', path: '', expect: { 'rp-manager': 403, 'rp-member': 403, 'rp-admin': 200, 'rp-owner': 200 } },
  ]
  for (const row of cases) {
    it(`replace on ${row.name}`, async () => {
      for (const [who, status] of Object.entries(row.expect)) {
        const userId = who === 'none' ? null : who === 'stranger' ? 'rp-stranger' : who
        const before = allRules()
        const r = await put(userId, { path: row.path, rules: onlyThese(user('rp-member2')) })
        expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(status)
        if (status !== 200) expect(allRules(), `${who} changed nothing`).toEqual(before)
      }
    })
  }
})

describe('validation (and nothing is written when refused)', () => {
  const refused: Array<[string, unknown, RegExp, string?]> = [
    ['read: false', { path: '営業部', rules: [{ ...everyone(false), canRead: false }] }, /read access is not available yet/i, 'READ_RESTRICTION_UNAVAILABLE'],
    ['read: false on a later rule', { path: '営業部', rules: [everyone(false), user('rp-member'), { ...user('rp-member2'), canRead: false }] }, /read access/i, 'READ_RESTRICTION_UNAVAILABLE'],
    ['an owner subject', { path: '営業部', rules: [everyone(false), user('rp-member'), user('rp-owner')] }, /always read and edit/],
    ['the admin role', { path: '営業部', rules: [everyone(false), { subjectType: 'role', subjectId: 'admin', canWrite: true }] }, /always read and edit/],
    ['a stranger', { path: '営業部', rules: [everyone(false), user('rp-stranger')] }, /Not a member/],
    ['an unknown subject type', { path: '営業部', rules: [everyone(false), { subjectType: 'group', canWrite: true }] }, /subjectType/],
    ['a missing canWrite', { path: '営業部', rules: [{ subjectType: 'everyone' }] }, /canWrite/],
    ['a duplicate subject', { path: '営業部', rules: [everyone(false), user('rp-member'), user('rp-member', false)] }, /only once/, 'DUPLICATE_SUBJECT'],
    ['no everyone rule', { path: '営業部', rules: [user('rp-member')] }, /needs a rule for everyone/, 'EVERYONE_RULE_REQUIRED'],
    ['an empty company root', { path: '', rules: [] }, /cannot be removed/, 'COMPANY_RULE_REQUIRED'],
    ['rules not an array', { path: '営業部', rules: { subjectType: 'everyone' } }, /must be an array/],
    ['a non-object rule', { path: '営業部', rules: [everyone(false), 'x'] }, /must be an object/],
    ['too many rules', { path: '営業部', rules: Array.from({ length: 201 }, () => everyone(true)) }, /At most 200/],
    ['an unknown folder', { path: '営業部/ない', rules: onlyThese(user('rp-member')) }, /not found/],
    ['a hidden folder', { path: '営業部/.personal', rules: onlyThese() }, /Hidden folders/],
    ['a traversal', { path: '../営業部', rules: onlyThese() }, /\.\./],
  ]
  for (const [name, body, message, code] of refused) {
    it(`refuses ${name}`, async () => {
      await put('rp-owner', { path: '営業部', rules: onlyThese(user('rp-member2')) })
      const before = { rules: allRules(), scopes: allScopes() }
      const r = await put('rp-owner', body)
      expect(r.status).toBe(400)
      expect(String(r.body.error)).toMatch(message)
      if (code) expect(r.body.code).toBe(code)
      expect({ rules: allRules(), scopes: allScopes() }).toEqual(before)
    })
  }

  it('refuses a body that is not JSON', async () => {
    expect((await put('rp-owner', 'not json')).status).toBe(400)
  })
})

describe('atomic replace', () => {
  it('a write that fails half-way leaves the old rules and no new scope', () => {
    replaceScopeRules(db, CO, '営業部', [{ subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }], 'rp-owner')
    const before = { rules: allRules(), scopes: allScopes() }
    // The CHECK constraint on subject_type fails on the second insert, after
    // the first rule of the set was already updated.
    const bad = [
      { subjectType: 'everyone' as const, subjectId: null, canRead: true, canWrite: true },
      { subjectType: 'nobody' as SubjectType, subjectId: null, canRead: true, canWrite: true },
    ]
    expect(() => replaceScopeRules(db, CO, '営業部', bad, 'rp-owner')).toThrow()
    expect(() => replaceScopeRules(db, CO, '営業部/契約書', bad, 'rp-owner')).toThrow()
    expect({ rules: allRules(), scopes: allScopes() }).toEqual(before)
  })

  it('stores exactly what was sent: nothing is copied from the parent', async () => {
    const r = await put('rp-owner', { path: '営業部/契約書', rules: onlyThese(user('rp-member')) })
    expect(r.status).toBe(200)
    expect(r.body.data.scope).toMatchObject({ path: '営業部/契約書', kind: 'folder', inherited: false })
    expect(rulesAt('営業部/契約書')).toEqual([
      { subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false },
      { subjectType: 'user', subjectId: 'rp-member', canRead: true, canWrite: true },
    ])
  })

  it('keeps the row of a subject that stays, and replaces the rest', async () => {
    await put('rp-owner', { path: '営業部', rules: onlyThese(user('rp-member'), roleMember()) })
    const keptId = (db.prepare(`SELECT r.id FROM scope_rules r JOIN scopes s ON s.id = r.scope_id WHERE s.path = '営業部' AND s.company_id = ? AND r.subject_type = 'everyone'`).get(CO) as { id: string }).id
    await put('rp-owner', { path: '営業部', rules: onlyThese(user('rp-member2')) })
    expect(rulesAt('営業部')!.map(r => [r.subjectType, r.subjectId, r.canWrite])).toEqual([
      ['everyone', null, false],
      ['user', 'rp-member2', true],
    ])
    expect(db.prepare(`SELECT id FROM scope_rules WHERE id = ?`).get(keptId)).toBeTruthy()
  })
})

describe('resulting access', () => {
  it('指定した人だけ under a 全員 root: only the chosen member (and owners/admins) edit, everyone reads', async () => {
    await put('rp-owner', { path: '営業部', rules: onlyThese(user('rp-member')) })
    for (const path of ['営業部', '営業部/契約書']) {
      expect(canEdit('rp-member', path)).toBe(true)
      expect(canEdit('rp-member2', path)).toBe(false)
      expect(canEdit('rp-manager', path)).toBe(false)
      expect(canEdit('rp-owner', path)).toBe(true)
      expect(canEdit('rp-admin', path)).toBe(true)
      expect(canRead('rp-member2', path)).toBe(true)
    }
    // Elsewhere the root still applies.
    expect(canEdit('rp-member2', 'コンテンツ')).toBe(true)
  })

  it('指定した人だけ with the member role: every member edits', async () => {
    await put('rp-owner', { path: '営業部', rules: onlyThese(roleMember()) })
    expect(canEdit('rp-member2', '営業部')).toBe(true)
  })

  it('指定した人だけ with nobody chosen: only owners/admins edit', async () => {
    await put('rp-owner', { path: '営業部', rules: onlyThese() })
    expect(canEdit('rp-member', '営業部')).toBe(false)
    expect(canEdit('rp-admin', '営業部')).toBe(true)
  })

  it('全員 under a restricted parent opens one folder again', async () => {
    await put('rp-owner', { path: '', rules: onlyThese(user('rp-member')) })
    await put('rp-manager', { path: 'コンテンツ/ブログ', rules: [everyone(true)] })
    expect(canEdit('rp-member2', 'コンテンツ')).toBe(false)
    expect(canEdit('rp-member2', 'コンテンツ/ブログ')).toBe(true)
    expect(canEdit('rp-member2', 'コンテンツ/受講生情報')).toBe(false)
  })

  it('上の階層と同じ: [] removes a folder scope, keeps a department scope, and the parent decides again', async () => {
    await put('rp-owner', { path: '営業部', rules: onlyThese() })
    await put('rp-owner', { path: '営業部/契約書', rules: [everyone(true)] })
    expect(canEdit('rp-member', '営業部/契約書')).toBe(true)

    const folder = await put('rp-owner', { path: '営業部/契約書', rules: [] })
    expect(folder.status).toBe(200)
    expect(folder.body.data.scope).toBeNull()
    expect(rulesAt('営業部/契約書')).toBeUndefined()
    expect(canEdit('rp-member', '営業部/契約書')).toBe(false)

    const dept = await put('rp-owner', { path: '営業部', rules: [] })
    expect(dept.body.data.scope).toMatchObject({ path: '営業部', kind: 'department', inherited: true })
    expect(rulesAt('営業部')).toEqual([])
    expect(canEdit('rp-member', '営業部/契約書')).toBe(true)

    // Resetting a folder that never had rules is a no-op.
    const noop = await put('rp-owner', { path: 'コンテンツ/ブログ', rules: [] })
    expect(noop.status).toBe(200)
    expect(noop.body.data.scope).toBeNull()
    expect(rulesAt('コンテンツ/ブログ')).toBeUndefined()
  })

  it('the company root can switch between 全員 and 指定した人だけ', async () => {
    await put('rp-admin', { path: '', rules: onlyThese(user('rp-member2')) })
    expect(canEdit('rp-member', 'コンテンツ')).toBe(false)
    expect(canEdit('rp-member2', 'コンテンツ')).toBe(true)
    await put('rp-admin', { path: '', rules: [everyone(true)] })
    expect(canEdit('rp-member', 'コンテンツ')).toBe(true)
  })
})

describe('GET /permissions: what each scope inherits', () => {
  it('names the governing ancestor and its rules, also for a manager', async () => {
    await put('rp-owner', { path: '', rules: onlyThese(user('rp-member')) })
    await put('rp-owner', { path: 'コンテンツ/ブログ', rules: [everyone(true)] })

    const owner = await as('rp-owner', 'GET', `${base}/permissions`)
    const byPath = Object.fromEntries((owner.body.data.scopes as Loose[]).map(s => [s.path, s]))
    expect(byPath[''].inheritedFrom).toBeNull()
    expect(byPath['コンテンツ/ブログ'].inheritedFrom).toMatchObject({ path: '', summary: 'everyone-r' })
    expect(byPath['コンテンツ/ブログ'].inheritedFrom.rules.map((r: Loose) => [r.subjectType, r.subjectLabel, r.canWrite])).toEqual([
      ['everyone', '全員', false],
      ['user', 'Name rp-member', true],
    ])

    const manager = await as('rp-manager', 'GET', `${base}/permissions`)
    const paths = (manager.body.data.scopes as Loose[]).map(s => s.path)
    expect(paths).not.toContain('')
    const dept = (manager.body.data.scopes as Loose[]).find(s => s.path === 'コンテンツ')
    expect(dept.inheritedFrom).toMatchObject({ path: '', summary: 'everyone-r' })
  })
})
