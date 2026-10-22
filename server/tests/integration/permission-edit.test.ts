/**
 * Integration Test: the permission editor's write APIs (routes/permission-rules.ts)
 * and the company rename / member role endpoints (routes/companies.ts).
 *
 * - Authorization: owner/admin edit everything; a department manager edits
 *   only the department folder and what is inside it; members, strangers and
 *   anonymous requests are refused.
 * - Validation: path shape, folder existence in the bare repo (NFD names
 *   included), subjects, `read: false` refused while read restriction is not
 *   available.
 * - Semantics: the first rule on an inheriting folder copies the inherited
 *   rules in; the everyone rule stays while other rules exist; the company
 *   rule cannot be removed; effective access explains which rule decided.
 * - Push rejection history filters; rename; role changes keep an owner.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const currentUser = vi.hoisted(() => ({ id: 'pe-owner' as string | null }))

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
import { companiesRoute } from '../../src/routes/companies'
import { permissionsRoute } from '../../src/routes/permissions'
import { permissionRulesRoute, parseScopePath } from '../../src/routes/permission-rules'
import { replaceDepartmentManagers } from '../../src/lib/permission-store'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// Response bodies are inspected loosely; their shapes are what the assertions check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)

const CO = 'pe-co'
const ROLE: Record<string, string> = {
  'pe-owner': 'owner', 'pe-admin': 'admin', 'pe-manager': 'member', 'pe-member': 'member', 'pe-member2': 'member',
}
const ids = { sales: 'pe-d-sales', content: 'pe-d-content' }
const STUDENTS_NFC = 'コンテンツ/受講生情報'
const base = `/api/companies/${CO}`

async function as(userId: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = userId
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data?: Loose } }
}

const ts = () => new Date().toISOString()
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

let tmp: string

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'Old name', CO, 'pe-owner', ts(), ts())
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
  replaceDepartmentManagers(db, ids.content, ['pe-manager'], 'pe-owner')

  // The company repository: department folders with sub-folders, one stored
  // with an NFD name (what a Mac commits), and a hidden folder.
  tmp = mkdtempSync(join(tmpdir(), 'pe-'))
  const work = join(tmp, 'work')
  mkdirSync(work)
  git(['init', '-q', '-b', 'main'], work)
  for (const dir of ['営業部/契約書', '営業部/2026 提案', STUDENTS_NFC.normalize('NFD'), 'コンテンツ/ブログ', '.claude']) {
    mkdirSync(join(work, dir), { recursive: true })
    writeFileSync(join(work, dir, '.gitkeep'), '')
  }
  git(['-c', 'core.precomposeunicode=false', 'add', '-A'], work)
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], work)
  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['clone', '-q', '--bare', work, bare], tmp)
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  currentUser.id = 'pe-owner'
})

function scopes(): Array<{ id: string; path: string; kind: string; inherited: boolean; rules: Array<{ id: string; subjectType: string; subjectId: string | null; canRead: boolean; canWrite: boolean }> }> {
  return db.prepare(`SELECT id, path, kind FROM scopes WHERE company_id = ?`).all(CO).map((s: Loose) => {
    const rules = db.prepare(`SELECT id, subject_type, subject_id, can_read, can_write FROM scope_rules WHERE scope_id = ? ORDER BY created_at, rowid`).all(s.id) as Loose[]
    return {
      ...s,
      inherited: rules.length === 0,
      rules: rules.map(r => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, canRead: r.can_read === 1, canWrite: r.can_write === 1 })),
    }
  })
}
const scopeAt = (path: string) => scopes().find(s => s.path === path)

/** Remove every rule below the company root, so each test starts from "everyone: read + write". */
function resetRules() {
  const root = scopeAt('')!
  db.prepare(`DELETE FROM scope_rules WHERE scope_id IN (SELECT id FROM scopes WHERE company_id = ? AND path <> '')`).run(CO)
  db.prepare(`DELETE FROM scopes WHERE company_id = ? AND kind = 'folder'`).run(CO)
  db.prepare(`DELETE FROM scope_rules WHERE scope_id = ?`).run(root.id)
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)`)
    .run(`root-${Math.random()}`, root.id, ts())
}

// ----------------------------------------------------------------------------

describe('authorization', () => {
  beforeEach(resetRules)

  const cases: Array<{ name: string; path: string; expect: Record<string, number> }> = [
    { name: 'a folder inside the managed department', path: STUDENTS_NFC, expect: { 'pe-owner': 201, 'pe-admin': 200, 'pe-manager': 200, 'pe-member': 403, stranger: 404, none: 401 } },
    { name: 'the managed department itself', path: 'コンテンツ', expect: { 'pe-manager': 201 } },
    { name: 'another department', path: '営業部/契約書', expect: { 'pe-manager': 403, 'pe-admin': 201 } },
    { name: 'the company root', path: '', expect: { 'pe-manager': 403, 'pe-member': 403, 'pe-owner': 201 } },
  ]
  for (const row of cases) {
    it(`POST rule on ${row.name}`, async () => {
      for (const [who, status] of Object.entries(row.expect)) {
        const user = who === 'none' ? null : who === 'stranger' ? 'pe-stranger' : who
        const r = await as(user, 'POST', `${base}/permissions/rules`, { path: row.path, subjectType: 'user', subjectId: 'pe-member2', canWrite: false })
        expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(status)
      }
    })
  }

  it('PATCH / DELETE a rule follow the rule’s folder, not the request', async () => {
    const created = await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'user', subjectId: 'pe-member2', canWrite: false })
    const ruleId = created.body.data.rules.find((r: Loose) => r.subjectType === 'user').id
    expect((await as('pe-manager', 'PATCH', `${base}/permissions/rules/${ruleId}`, { canWrite: true })).status).toBe(403)
    expect((await as('pe-manager', 'DELETE', `${base}/permissions/rules/${ruleId}`)).status).toBe(403)
    expect((await as('pe-member', 'DELETE', `${base}/permissions/rules/${ruleId}`)).status).toBe(403)
    expect((await as('pe-manager', 'DELETE', `${base}/permissions/scopes/${created.body.data.scope.id}/rules`)).status).toBe(403)
    expect((await as('pe-admin', 'PATCH', `${base}/permissions/rules/${ruleId}`, { canWrite: true })).status).toBe(200)
  })

  it('a rule id from another company is not found', async () => {
    expect((await as('pe-owner', 'PATCH', `${base}/permissions/rules/does-not-exist`, { canWrite: true })).status).toBe(404)
  })

  it('effective access and folder listing: editors only, managers within their department', async () => {
    expect((await as('pe-manager', 'GET', `${base}/permissions/effective?path=${encodeURIComponent(STUDENTS_NFC)}`)).status).toBe(200)
    expect((await as('pe-manager', 'GET', `${base}/permissions/effective?path=${encodeURIComponent('営業部')}`)).status).toBe(403)
    expect((await as('pe-member', 'GET', `${base}/permissions/effective?path=`)).status).toBe(403)
    expect((await as('pe-manager', 'GET', `${base}/permissions/folders?path=${encodeURIComponent('コンテンツ')}`)).status).toBe(200)
    expect((await as('pe-manager', 'GET', `${base}/permissions/folders?path=`)).status).toBe(403)
  })

  it('push rejection history is owner/admin only', async () => {
    expect((await as('pe-owner', 'GET', `${base}/push-rejections`)).status).toBe(200)
    expect((await as('pe-admin', 'GET', `${base}/push-rejections`)).status).toBe(200)
    expect((await as('pe-manager', 'GET', `${base}/push-rejections`)).status).toBe(403)
    expect((await as('pe-member', 'GET', `${base}/push-rejections`)).status).toBe(403)
    expect((await as(null, 'GET', `${base}/push-rejections`)).status).toBe(401)
  })
})

describe('validation', () => {
  beforeEach(resetRules)

  const post = (body: Record<string, unknown>) =>
    as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'everyone', canWrite: false, ...body })

  it('refuses read: false with an explanation (read restriction comes later)', async () => {
    const r = await post({ canRead: false })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('READ_RESTRICTION_UNAVAILABLE')
    expect(String(r.body.error)).toMatch(/read access is not available yet/i)
    const ruleId = (await post({})).body.data.rules[0].id
    const p = await as('pe-owner', 'PATCH', `${base}/permissions/rules/${ruleId}`, { canWrite: true, canRead: false })
    expect(p.status).toBe(400)
    expect(p.body.code).toBe('READ_RESTRICTION_UNAVAILABLE')
  })

  it('stores read = true for every rule it writes', async () => {
    const r = await post({ canRead: true })
    expect(r.status).toBe(201)
    expect(scopeAt('営業部/契約書')!.rules.every(x => x.canRead)).toBe(true)
  })

  it.each([
    ['../営業部', /\.\./],
    ['/営業部', /leading or trailing/],
    ['営業部/', /leading or trailing/],
    ['営業部//契約書', /empty segments/],
    ['.claude', /Hidden folders/],
    ['営業部/.personal', /Hidden folders/],
    ['営業部\\契約書', /invalid characters/],
    ['営業部/存在しない', /not found/],
    ['存在しない部署', /not found/],
    ['bad name!', /Invalid folder name/],
  ])('rejects path %s', async (path, message) => {
    const r = await post({ path })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toMatch(message)
  })

  it('rejects malformed bodies and subjects', async () => {
    expect((await post({ path: 42 })).status).toBe(400)
    expect((await post({ canWrite: 'yes' })).status).toBe(400)
    expect((await post({ subjectType: 'group' })).status).toBe(400)
    expect((await post({ subjectType: 'everyone', subjectId: 'x' })).status).toBe(400)
    expect((await post({ subjectType: 'role', subjectId: 'guest' })).status).toBe(400)
    expect((await post({ subjectType: 'user', subjectId: 'pe-stranger' })).body.error).toMatch(/Not a member/)
    // Owners and admins bypass rules: a rule for them would only mislead.
    expect((await post({ subjectType: 'role', subjectId: 'admin' })).body.error).toMatch(/always read and edit/)
    expect((await post({ subjectType: 'user', subjectId: 'pe-admin' })).body.error).toMatch(/always read and edit/)
    currentUser.id = 'pe-owner'
    const res = await app.request(`${base}/permissions/rules`, { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    expect(res.status).toBe(400)
  })

  it('parseScopePath normalises to NFC and accepts the root as "" or "/"', () => {
    expect(parseScopePath('')).toEqual({ path: '' })
    expect(parseScopePath('/')).toEqual({ path: '' })
    expect(parseScopePath(STUDENTS_NFC.normalize('NFD'))).toEqual({ path: STUDENTS_NFC })
  })
})

describe('rule semantics', () => {
  beforeEach(resetRules)

  it('the first rule on a folder copies the inherited rules, so nobody else changes', async () => {
    const r = await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'user', subjectId: 'pe-member2', canWrite: false })
    expect(r.status).toBe(201)
    expect(r.body.data.scope).toMatchObject({ path: '営業部/契約書', kind: 'folder', inherited: false })
    expect(r.body.data.rules.map((x: Loose) => [x.subjectType, x.subjectId, x.canRead, x.canWrite])).toEqual([
      ['everyone', null, true, true],
      ['user', 'pe-member2', true, false],
    ])

    const eff = await as('pe-owner', 'GET', `${base}/permissions/effective?path=${encodeURIComponent('営業部/契約書')}`)
    const byUser = Object.fromEntries((eff.body.data.members as Loose[]).map(m => [m.userId, m]))
    expect(eff.body.data.governingScope).toMatchObject({ path: '営業部/契約書', inherited: false })
    expect(byUser['pe-member']).toMatchObject({ read: true, write: true, reason: 'rule', decidedBy: { subjectType: 'everyone', subjectLabel: '全員' } })
    expect(byUser['pe-member2']).toMatchObject({ read: true, write: false, decidedBy: { subjectType: 'user', subjectLabel: 'Name pe-member2' } })
    expect(byUser['pe-admin']).toMatchObject({ read: true, write: true, reason: 'role', decidedBy: null })
  })

  it('"can read but not edit" (Q5): everyone read-only, one member may edit', async () => {
    const first = await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'everyone', canWrite: false })
    expect(first.status).toBe(201)
    await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'user', subjectId: 'pe-member', canWrite: true })
    const eff = await as('pe-owner', 'GET', `${base}/permissions/effective?path=${encodeURIComponent('営業部/契約書')}`)
    const byUser = Object.fromEntries((eff.body.data.members as Loose[]).map(m => [m.userId, m]))
    expect(eff.body.data.governingScope).toMatchObject({ path: '営業部', inherited: true })
    expect(byUser['pe-member']).toMatchObject({ read: true, write: true })
    expect(byUser['pe-member2']).toMatchObject({ read: true, write: false })
    expect(byUser['pe-manager']).toMatchObject({ read: true, write: false })
  })

  it('setting a subject twice updates its rule instead of adding a second one', async () => {
    await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'role', subjectId: 'member', canWrite: false })
    const again = await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'role', subjectId: 'member', canWrite: true })
    expect(again.status).toBe(200)
    expect(scopeAt('営業部')!.rules.filter(r => r.subjectType === 'role')).toEqual([
      expect.objectContaining({ subjectId: 'member', canWrite: true }),
    ])
  })

  it('keeps the everyone rule while other rules exist; removing the last rule makes the folder inherit', async () => {
    const r = await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'user', subjectId: 'pe-member2', canWrite: false })
    const everyone = r.body.data.rules.find((x: Loose) => x.subjectType === 'everyone').id
    const user = r.body.data.rules.find((x: Loose) => x.subjectType === 'user').id
    const blocked = await as('pe-owner', 'DELETE', `${base}/permissions/rules/${everyone}`)
    expect(blocked.status).toBe(400)
    expect(String(blocked.body.error)).toMatch(/everyone cannot be removed/)
    expect((await as('pe-owner', 'DELETE', `${base}/permissions/rules/${user}`)).status).toBe(200)
    const last = await as('pe-owner', 'DELETE', `${base}/permissions/rules/${everyone}`)
    expect(last.status).toBe(200)
    expect(last.body.data.scope).toBeNull() // folder scope without rules is removed
    expect(scopeAt('営業部/契約書')).toBeUndefined()
  })

  it('resetting a department to inherit keeps its scope; the company rule cannot be removed', async () => {
    await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'everyone', canWrite: false })
    const dept = scopeAt('営業部')!
    const reset = await as('pe-owner', 'DELETE', `${base}/permissions/scopes/${dept.id}/rules`)
    expect(reset.status).toBe(200)
    expect(reset.body.data.removed).toBe(1)
    expect(scopeAt('営業部')).toMatchObject({ kind: 'department', inherited: true })

    const root = scopeAt('')!
    expect((await as('pe-owner', 'DELETE', `${base}/permissions/scopes/${root.id}/rules`)).status).toBe(400)
    const only = await as('pe-owner', 'DELETE', `${base}/permissions/rules/${root.rules[0].id}`)
    expect(only.status).toBe(400)
    expect(String(only.body.error)).toMatch(/company-wide rule cannot be removed/)
    // Changing it is fine: owners and admins keep write regardless.
    expect((await as('pe-owner', 'PATCH', `${base}/permissions/rules/${root.rules[0].id}`, { canWrite: false })).status).toBe(200)
    const eff = await as('pe-owner', 'GET', `${base}/permissions/effective?path=`)
    const byUser = Object.fromEntries((eff.body.data.members as Loose[]).map(m => [m.userId, m]))
    expect(byUser['pe-owner'].write).toBe(true)
    expect(byUser['pe-member'].write).toBe(false)
  })

  it('finds a folder the repository stores under an NFD name', async () => {
    const r = await as('pe-manager', 'POST', `${base}/permissions/rules`, { path: STUDENTS_NFC, subjectType: 'everyone', canWrite: false })
    expect(r.status).toBe(201)
    expect(r.body.data.scope.path).toBe(STUDENTS_NFC)
  })

  it('lists sub-folders (hidden ones excluded) with whether they have rules', async () => {
    await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'everyone', canWrite: false })
    const r = await as('pe-owner', 'GET', `${base}/permissions/folders?path=${encodeURIComponent('営業部')}`)
    expect(r.body.data.folders).toEqual([
      { name: '2026 提案', path: '営業部/2026 提案', scopeId: null, hasRules: false, private: false },
      { name: '契約書', path: '営業部/契約書', scopeId: expect.any(String), hasRules: true, private: false },
    ])
    const root = await as('pe-owner', 'GET', `${base}/permissions/folders?path=`)
    expect(root.body.data.folders.map((f: Loose) => f.name).sort()).toEqual(['コンテンツ', '営業部'].sort())
    const nested = await as('pe-owner', 'GET', `${base}/permissions/folders?path=${encodeURIComponent('コンテンツ')}`)
    expect(nested.body.data.folders.map((f: Loose) => f.name).sort()).toEqual(['ブログ', '受講生情報'].sort())
    expect((await as('pe-owner', 'GET', `${base}/permissions/folders?path=${encodeURIComponent('営業部/ない')}`)).status).toBe(404)
  })

  it('GET /permissions shows the edited rules', async () => {
    await as('pe-owner', 'POST', `${base}/permissions/rules`, { path: '営業部/契約書', subjectType: 'user', subjectId: 'pe-member2', canWrite: false })
    const r = await as('pe-owner', 'GET', `${base}/permissions`)
    const s = (r.body.data.scopes as Loose[]).find(x => x.path === '営業部/契約書')
    expect(s).toMatchObject({ kind: 'folder', inherited: false, effectiveSummary: 'everyone-r' })
  })
})

describe('push rejection history', () => {
  beforeAll(() => {
    const insert = db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    insert.run('pr1', CO, 'pe-member', 'PROTECTED_CONFIG', '[".mcp.json"]', '2026-10-01T00:00:00.000Z')
    insert.run('pr2', CO, 'pe-member', 'SECRET_DETECTED', '["a.env"]', '2026-10-02T00:00:00.000Z')
    insert.run('pr3', CO, 'pe-member2', 'PROTECTED_CONFIG', '["b"]', '2026-10-03T00:00:00.000Z')
    insert.run('pr4', CO, 'pe-member2', 'PERSONAL_PATH', 'not json', '2026-10-04T00:00:00.000Z')
  })

  it('lists newest first with names, markers and totals', async () => {
    const r = await as('pe-admin', 'GET', `${base}/push-rejections`)
    expect(r.body.data.total).toBe(4)
    expect(r.body.data.markers).toEqual(['PERSONAL_PATH', 'PROTECTED_CONFIG', 'SECRET_DETECTED'])
    expect(r.body.data.rejections.map((x: Loose) => x.id)).toEqual(['pr4', 'pr3', 'pr2', 'pr1'])
    expect(r.body.data.rejections[0]).toMatchObject({ userId: 'pe-member2', name: 'Name pe-member2', paths: [] })
  })

  it('filters by member and type, and pages', async () => {
    const byUser = await as('pe-owner', 'GET', `${base}/push-rejections?userId=pe-member`)
    expect(byUser.body.data.rejections.map((x: Loose) => x.id)).toEqual(['pr2', 'pr1'])
    const byMarker = await as('pe-owner', 'GET', `${base}/push-rejections?marker=PROTECTED_CONFIG`)
    expect(byMarker.body.data.rejections.map((x: Loose) => x.id)).toEqual(['pr3', 'pr1'])
    const page = await as('pe-owner', 'GET', `${base}/push-rejections?limit=1&offset=1`)
    expect(page.body.data).toMatchObject({ total: 4 })
    expect(page.body.data.rejections.map((x: Loose) => x.id)).toEqual(['pr3'])
    expect((await as('pe-owner', 'GET', `${base}/push-rejections?limit=0`)).status).toBe(400)
    expect((await as('pe-owner', 'GET', `${base}/push-rejections?marker=bad;`)).status).toBe(400)
  })
})

describe('company rename', () => {
  it('owner and admin may rename; others may not; the name is validated', async () => {
    expect((await as('pe-member', 'PATCH', `/api/companies/${CO}`, { name: 'X' })).status).toBe(403)
    expect((await as('pe-manager', 'PATCH', `/api/companies/${CO}`, { name: 'X' })).status).toBe(403)
    expect((await as('pe-stranger', 'PATCH', `/api/companies/${CO}`, { name: 'X' })).status).toBe(404)
    expect((await as(null, 'PATCH', `/api/companies/${CO}`, { name: 'X' })).status).toBe(401)
    expect((await as('pe-owner', 'PATCH', `/api/companies/${CO}`, { name: '   ' })).status).toBe(400)
    expect((await as('pe-owner', 'PATCH', `/api/companies/${CO}`, { name: 'x'.repeat(101) })).status).toBe(400)
    expect((await as('pe-owner', 'PATCH', `/api/companies/${CO}`, { name: 'a\nb' })).status).toBe(400)
    const r = await as('pe-admin', 'PATCH', `/api/companies/${CO}`, { name: '  株式会社 新しい名前 ' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ id: CO, name: '株式会社 新しい名前', slug: CO, role: 'admin' })
  })
})

describe('member role change', () => {
  const put = (actor: string, target: string, role: unknown) => as(actor, 'PUT', `/api/companies/${CO}/members/${target}/role`, { role })
  const roleOf = (u: string) => (db.prepare('SELECT role FROM memberships WHERE user_id = ? AND company_id = ?').get(u, CO) as { role: string }).role

  it('only owners change roles', async () => {
    expect((await put('pe-admin', 'pe-member', 'admin')).status).toBe(403)
    expect((await put('pe-admin', 'pe-admin', 'member')).status).toBe(403)
    expect((await put('pe-member', 'pe-member', 'admin')).status).toBe(403)
    expect((await put('pe-stranger', 'pe-member', 'admin')).status).toBe(404)
  })

  it('validates role and target', async () => {
    expect((await put('pe-owner', 'pe-member', 'superuser')).status).toBe(400)
    expect((await put('pe-owner', 'pe-stranger', 'admin')).status).toBe(404)
  })

  it('grants and revokes admin', async () => {
    expect((await put('pe-owner', 'pe-member2', 'admin')).status).toBe(200)
    expect(roleOf('pe-member2')).toBe('admin')
    expect((await put('pe-owner', 'pe-member2', 'member')).status).toBe(200)
    expect(roleOf('pe-member2')).toBe('member')
  })

  it('never demotes the last owner, including themselves', async () => {
    const self = await put('pe-owner', 'pe-owner', 'admin')
    expect(self.status).toBe(400)
    expect(String(self.body.error)).toMatch(/last owner/)
    expect(roleOf('pe-owner')).toBe('owner')
    // With a second owner, either may step down; then the remaining one is protected again.
    expect((await put('pe-owner', 'pe-admin', 'owner')).status).toBe(200)
    expect((await put('pe-owner', 'pe-owner', 'admin')).status).toBe(200)
    expect(roleOf('pe-owner')).toBe('admin')
    expect((await put('pe-admin', 'pe-admin', 'member')).status).toBe(400)
    // Restore for other tests.
    expect((await put('pe-admin', 'pe-owner', 'owner')).status).toBe(200)
    expect((await put('pe-owner', 'pe-admin', 'admin')).status).toBe(200)
  })
})
