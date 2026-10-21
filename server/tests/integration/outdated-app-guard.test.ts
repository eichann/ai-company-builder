/**
 * Integration Test: a write restriction must not reach a member whose desktop
 * app cannot recover from [WRITE_DENIED] (apps older than #114 retry the
 * rejected push forever and never sync again).
 *
 * - supportsWriteDeniedRecovery: build commit date >= a031b73's, dev builds by
 *   their commit, unknown / unparsable / dateless = unsupported.
 * - Every rule-changing endpoint (PUT by-path, POST/PATCH/DELETE rule, DELETE
 *   scope rules, POST move) answers 409 OUTDATED_CLIENTS listing the members
 *   who would LOSE write there and are on an old or unknown app, and changes
 *   nothing. Members who keep (or gain) write, and owners/admins, never block.
 * - force: true lets an owner/admin save anyway; a manager is refused (403).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const currentUser = vi.hoisted(() => ({ id: 'og-owner' as string | null }))

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
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { replaceDepartmentManagers, replaceScopeRules, sqlitePermissionRepository } from '../../src/lib/permission-store'
import { resolveAccess } from '../../src/lib/permissions'
import { supportsWriteDeniedRecovery, WRITE_DENIED_RECOVERY_COMMIT_DATE } from '../../src/lib/client-version'
import { membersLosingWrite } from '../../src/lib/write-loss'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const app = new Hono()
app.route('/api/companies/:companyId', permissionRulesRoute)

const CO = 'og-co'
const V_NEW = `0.0.1+a031b73.${WRITE_DENIED_RECOVERY_COMMIT_DATE}`
const V_OLD = '0.0.1+256457b.20261021120000'
// role, recorded client version (undefined = never connected)
const USERS: Record<string, [string, string | null | undefined]> = {
  'og-owner': ['owner', V_OLD], // owners never lose write: an old app does not matter
  'og-admin': ['admin', undefined],
  'og-manager': ['member', V_NEW],
  'og-new': ['member', V_NEW],
  'og-old': ['member', V_OLD],
  'og-unknown': ['member', undefined],
  'og-noheader': ['member', null], // connected, but the app sent no version
}
const ids = { sales: 'og-d-sales', content: 'og-d-content' }
const base = `/api/companies/${CO}`
const PUT_URL = `${base}/permissions/scopes/by-path`

async function as(userId: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = userId
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data?: Loose; members?: Loose[] } }
}

const ts = () => new Date().toISOString()
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

const everyone = (canWrite: boolean) => ({ subjectType: 'everyone' as const, subjectId: null, canRead: true, canWrite })
const user = (id: string, canWrite = true) => ({ subjectType: 'user' as const, subjectId: id, canRead: true, canWrite })
const onlyThese = (...userIds: string[]) => [everyone(false), ...userIds.map(id => user(id))]
const blockedIds = (r: { body: { members?: Loose[] } }) => (r.body.members ?? []).map((m: Loose) => m.userId).sort()

const repo = sqlitePermissionRepository(db)
const canEdit = (userId: string, path: string) => resolveAccess(CO, userId, path, repo).write
const snapshot = () => JSON.stringify(db.prepare(`
  SELECT s.path, r.subject_type, r.subject_id, r.can_write FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
  WHERE s.company_id = ? ORDER BY s.path, r.subject_type, r.subject_id
`).all(CO))
const ruleId = (path: string, subjectType: string, subjectId: string | null) =>
  (db.prepare(`SELECT r.id FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
    WHERE s.company_id = ? AND s.path = ? AND r.subject_type = ? AND r.subject_id IS ?`)
    .get(CO, path, subjectType, subjectId) as { id: string }).id
const scopeId = (path: string) => (db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ?`).get(CO, path) as { id: string }).id

let tmp: string

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'Co', CO, 'og-owner', ts(), ts())
  for (const [u, [role, version]] of Object.entries(USERS)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${u}`, u, CO, role, ts(), ts())
    if (version !== undefined) {
      db.prepare('INSERT INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(u, CO, version, '2026-10-20T01:00:00.000Z', ts())
    }
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.sales, CO, '営業部', '営業部', 0, ts(), ts())
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.content, CO, 'コンテンツ', 'コンテンツ', 1, ts(), ts())
  initDatabase() // seed scopes
  replaceDepartmentManagers(db, ids.content, ['og-manager'], 'og-owner')

  tmp = mkdtempSync(join(tmpdir(), 'og-'))
  const work = join(tmp, 'work')
  mkdirSync(work)
  git(['init', '-q', '-b', 'main'], work)
  for (const dir of ['営業部/契約書', '営業部/新規', 'コンテンツ/ブログ']) {
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
  currentUser.id = 'og-owner'
  db.prepare(`DELETE FROM scope_rules WHERE scope_id IN (SELECT id FROM scopes WHERE company_id = ?)`).run(CO)
  db.prepare(`DELETE FROM scopes WHERE company_id = ? AND kind = 'folder'`).run(CO)
  replaceScopeRules(db, CO, '', [everyone(true)], 'og-owner')
})

describe('supportsWriteDeniedRecovery', () => {
  it('compares the build commit date with a031b73', () => {
    expect(WRITE_DENIED_RECOVERY_COMMIT_DATE).toMatch(/^\d{14}$/)
    expect(supportsWriteDeniedRecovery(V_NEW)).toBe(true)
    expect(supportsWriteDeniedRecovery('0.0.1+1234567.20261101000000')).toBe(true)
    expect(supportsWriteDeniedRecovery(V_OLD)).toBe(false)
    expect(supportsWriteDeniedRecovery('0.0.1+1234567.20261021182825')).toBe(false)
  })

  it('counts a dev build by its commit; unknown, unparsable or dateless builds are unsupported', () => {
    expect(supportsWriteDeniedRecovery('0.0.1-dev+1234567.20261022000000')).toBe(true)
    expect(supportsWriteDeniedRecovery('0.0.1-dev+1234567.20261001000000')).toBe(false)
    expect(supportsWriteDeniedRecovery('0.0.1+nogit.00000000000000')).toBe(false)
    expect(supportsWriteDeniedRecovery('0.0.1')).toBe(false)
    expect(supportsWriteDeniedRecovery('garbage')).toBe(false)
    expect(supportsWriteDeniedRecovery('')).toBe(false)
    expect(supportsWriteDeniedRecovery(null)).toBe(false)
    expect(supportsWriteDeniedRecovery(undefined)).toBe(false)
  })
})

describe('membersLosingWrite', () => {
  it('compares at the root and at every scope inside it; owners/admins never lose', () => {
    const members = [{ userId: 'a', role: 'member' }, { userId: 'b', role: 'member' }, { userId: 'o', role: 'owner' }]
    const root = { id: 'root', path: '', kind: 'company' as const, departmentId: null, repoId: null, rules: [{ id: '1', ...everyone(true) }] }
    const deep = { id: 'deep', path: 'x/y', kind: 'folder' as const, departmentId: null, repoId: null, rules: [{ id: '2', ...everyone(false) }, { id: '3', ...user('b') }] }
    const before = [root, deep]
    // Restricting x: a and b lose write at x; at x/y nothing changes.
    const restrictX = [...before, { id: 'x', path: 'x', kind: 'folder' as const, departmentId: null, repoId: null, rules: [{ id: '4', ...everyone(false) }, { id: '5', ...user('a') }] }]
    expect(membersLosingWrite(CO, members, before, restrictX, ['x'])).toEqual(['b'])
    // Removing x/y's rules: a gains write there, b keeps it.
    expect(membersLosingWrite(CO, members, before, [root], ['x/y'])).toEqual([])
    // A change outside the roots is not looked at.
    expect(membersLosingWrite(CO, members, before, restrictX, ['z'])).toEqual([])
  })
})

describe('PUT /permissions/scopes/by-path', () => {
  it('blocks when someone losing write is on an old or unknown app, listing only them, and changes nothing', async () => {
    const before = snapshot()
    const r = await as('og-owner', 'PUT', PUT_URL, { path: '営業部', rules: onlyThese('og-new', 'og-manager') })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('OUTDATED_CLIENTS')
    expect(r.body.canForce).toBe(true)
    expect(blockedIds(r)).toEqual(['og-noheader', 'og-old', 'og-unknown'])
    const byId = new Map(r.body.members!.map((m: Loose) => [m.userId, m]))
    expect(byId.get('og-old')).toEqual({
      userId: 'og-old', name: 'Name og-old', email: 'og-old@example.com', role: 'member',
      clientVersion: V_OLD, version: V_OLD, lastSeenAt: '2026-10-20T01:00:00.000Z',
    })
    expect(byId.get('og-unknown')).toMatchObject({ clientVersion: null, version: '不明', lastSeenAt: null })
    expect(byId.get('og-noheader')).toMatchObject({ clientVersion: null, version: '不明', lastSeenAt: '2026-10-20T01:00:00.000Z' })
    expect(snapshot()).toBe(before)
    expect(canEdit('og-old', '営業部')).toBe(true)
  })

  it('passes when everyone who loses write is on a supported app (the old apps keep write)', async () => {
    const r = await as('og-owner', 'PUT', PUT_URL, { path: '営業部', rules: onlyThese('og-old', 'og-unknown', 'og-noheader') })
    expect(r.status).toBe(200)
    expect(canEdit('og-new', '営業部')).toBe(false)
    expect(canEdit('og-old', '営業部')).toBe(true)
  })

  it('never blocks a change that only gives write', async () => {
    replaceScopeRules(db, CO, '営業部', [everyone(false)], 'og-owner')
    const r = await as('og-owner', 'PUT', PUT_URL, { path: '営業部', rules: [] })
    expect(r.status).toBe(200)
    expect(canEdit('og-old', '営業部')).toBe(true)
  })

  it('looks at the whole subtree: re-opening a parent does not hide a sub-folder that loses write', async () => {
    // 営業部 read-only, 営業部/契約書 open to everyone. Making 契約書 inherit
    // takes write away there.
    replaceScopeRules(db, CO, '営業部', [everyone(false)], 'og-owner')
    replaceScopeRules(db, CO, '営業部/契約書', [everyone(true)], 'og-owner')
    const r = await as('og-owner', 'PUT', PUT_URL, { path: '営業部/契約書', rules: [] })
    expect(r.status).toBe(409)
    expect(blockedIds(r)).toEqual(['og-noheader', 'og-old', 'og-unknown'])
  })

  it('force: true lets an owner save anyway', async () => {
    const r = await as('og-owner', 'PUT', PUT_URL, { path: '営業部', rules: onlyThese('og-new'), force: true })
    expect(r.status).toBe(200)
    expect(canEdit('og-old', '営業部')).toBe(false)
  })

  it('force: true by an admin works too', async () => {
    const r = await as('og-admin', 'PUT', PUT_URL, { path: '営業部', rules: onlyThese('og-new'), force: true })
    expect(r.status).toBe(200)
  })

  it('a manager is blocked without the override, and refused with it', async () => {
    const blocked = await as('og-manager', 'PUT', PUT_URL, { path: 'コンテンツ', rules: onlyThese('og-manager') })
    expect(blocked.status).toBe(409)
    expect(blocked.body.canForce).toBe(false)
    const forced = await as('og-manager', 'PUT', PUT_URL, { path: 'コンテンツ', rules: onlyThese('og-manager'), force: true })
    expect(forced.status).toBe(403)
    expect(forced.body.code).toBe('FORCE_NOT_ALLOWED')
    expect(canEdit('og-old', 'コンテンツ')).toBe(true)
  })
})

describe('per-rule endpoints', () => {
  it('POST /permissions/rules blocks taking write from an old app, force by owner works, by manager refused', async () => {
    const body = { path: '営業部', subjectType: 'user', subjectId: 'og-old', canWrite: false }
    const r = await as('og-owner', 'POST', `${base}/permissions/rules`, body)
    expect(r.status).toBe(409)
    expect(blockedIds(r)).toEqual(['og-old'])
    expect(canEdit('og-old', '営業部')).toBe(true)
    expect((await as('og-manager', 'POST', `${base}/permissions/rules`, { ...body, path: 'コンテンツ', force: true })).status).toBe(403)
    expect((await as('og-owner', 'POST', `${base}/permissions/rules`, { ...body, force: true })).status).toBe(201)
    expect(canEdit('og-old', '営業部')).toBe(false)
  })

  it('POST for a supported member passes', async () => {
    const r = await as('og-owner', 'POST', `${base}/permissions/rules`, { path: '営業部', subjectType: 'user', subjectId: 'og-new', canWrite: false })
    expect(r.status).toBe(201)
  })

  it('PATCH /permissions/rules/:id blocks, then passes with force', async () => {
    replaceScopeRules(db, CO, '営業部', [everyone(true)], 'og-owner')
    const id = ruleId('営業部', 'everyone', null)
    const r = await as('og-owner', 'PATCH', `${base}/permissions/rules/${id}`, { canWrite: false })
    expect(r.status).toBe(409)
    expect(blockedIds(r)).toEqual(['og-noheader', 'og-old', 'og-unknown'])
    expect((await as('og-owner', 'PATCH', `${base}/permissions/rules/${id}`, { canWrite: false, force: true })).status).toBe(200)
    expect(canEdit('og-old', '営業部')).toBe(false)
  })

  it('DELETE /permissions/rules/:id blocks removing an old app\'s edit rule; ?force=true by owner works', async () => {
    replaceScopeRules(db, CO, '営業部', [everyone(false), user('og-old'), user('og-new')], 'og-owner')
    const id = ruleId('営業部', 'user', 'og-old')
    const r = await as('og-owner', 'DELETE', `${base}/permissions/rules/${id}`)
    expect(r.status).toBe(409)
    expect(blockedIds(r)).toEqual(['og-old'])
    // Removing the supported member's rule is fine.
    expect((await as('og-owner', 'DELETE', `${base}/permissions/rules/${ruleId('営業部', 'user', 'og-new')}`)).status).toBe(200)
    expect((await as('og-owner', 'DELETE', `${base}/permissions/rules/${id}?force=true`)).status).toBe(200)
    expect(canEdit('og-old', '営業部')).toBe(false)
  })

  it('DELETE /permissions/scopes/:id/rules blocks when inheriting takes write away; a manager cannot force', async () => {
    replaceScopeRules(db, CO, 'コンテンツ', [everyone(false)], 'og-owner')
    replaceScopeRules(db, CO, 'コンテンツ/ブログ', [everyone(true)], 'og-owner')
    const url = `${base}/permissions/scopes/${scopeId('コンテンツ/ブログ')}/rules`
    const r = await as('og-manager', 'DELETE', url)
    expect(r.status).toBe(409)
    expect((await as('og-manager', 'DELETE', `${url}?force=true`)).status).toBe(403)
    expect(canEdit('og-old', 'コンテンツ/ブログ')).toBe(true)
    expect((await as('og-owner', 'DELETE', url, { force: true })).status).toBe(200)
    expect(canEdit('og-old', 'コンテンツ/ブログ')).toBe(false)
  })

  it('POST /permissions/scopes/:id/move is guarded at the destination', async () => {
    replaceScopeRules(db, CO, '営業部/契約書', [everyone(false), user('og-new')], 'og-owner')
    const url = `${base}/permissions/scopes/${scopeId('営業部/契約書')}/move`
    const r = await as('og-owner', 'POST', url, { toPath: '営業部/新規' })
    expect(r.status).toBe(409)
    expect(blockedIds(r)).toEqual(['og-noheader', 'og-old', 'og-unknown'])
    expect(canEdit('og-old', '営業部/新規')).toBe(true)
    const forced = await as('og-owner', 'POST', url, { toPath: '営業部/新規', force: true })
    expect(forced.status).toBe(200)
    expect(canEdit('og-old', '営業部/新規')).toBe(false)
    expect(canEdit('og-old', '営業部/契約書')).toBe(true)
  })
})
