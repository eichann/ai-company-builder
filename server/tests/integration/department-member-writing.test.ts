/**
 * Integration Test: a department created now lets everyone read and only the
 * people who belong to it (所属) write (owner decision 2026-11-06,
 * shared/core/permissions.ts subject 'department').
 *
 * Real routes (POST /departments, PUT /departments/:id/members,
 * /me/write-access, /permissions/effective, POST /permissions/rules), real
 * git-http push through the real pre-receive hook, real database:
 * - a new department: a member who belongs writes, one who does not is
 *   refused at push ([WRITE_DENIED], wire format unchanged) and by
 *   /me/write-access, everyone reads;
 * - adding or removing someone changes their write access (removing runs the
 *   outdated-app guard like a rule change);
 * - a department that existed before is unchanged (inherits everyone: write);
 * - another company's department or membership never counts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { WRITE_DENIED_RECOVERY_COMMIT_DATE } from '../../src/lib/client-version'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const CO = 'dmw-co'
const OTHER = 'dmw-other'
const BASE = `/api/companies/${CO}`
const USERS = ['owner', 'alice', 'bob', 'manager'] as const
type User = typeof USERS[number]
const ROLE: Record<User, string> = { owner: 'owner', alice: 'member', bob: 'member', manager: 'member' }
const uid = (u: User) => `dmw-${u}`
const V_NEW = `0.0.1+a031b73.${WRITE_DENIED_RECOVERY_COMMIT_DATE}`
const ts = () => new Date().toISOString()

let db: import('better-sqlite3').Database
let app: import('hono').Hono
let workDir: string
let bare: string
let gitUrl: string
let server: { close: () => void }
let salesId: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: User | string, method: string, path: string, body?: unknown) {
  currentUser.id = USERS.includes(user as User) ? uid(user as User) : user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

let cloneCount = 0
function clone(): string {
  const dir = join(workDir, `clone${++cloneCount}`)
  git(['clone', '-q', bare, dir])
  git(['config', 'user.name', 'test'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  return dir
}

/** A member's push over git-http of one new file (async: the server runs in this process). */
async function pushFile(user: User, rel: string): Promise<{ ok: boolean; output: string }> {
  const dir = clone()
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, `${user} ${cloneCount}\n`)
  git(['add', '-A'], dir)
  git(['commit', '-q', '--no-verify', '-m', `${user} writes ${rel}`], dir)
  const url = gitUrl.replace('http://', `http://git:tok-${user}@`)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', ['-c', `http.extraHeader=X-ACB-Client-Version: ${V_NEW}`, 'push', url, 'HEAD:main'], { cwd: dir, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/** May `user` write at `path`, per GET /me/write-access evaluated as the app does. */
async function appSaysWritable(user: User, path: string): Promise<boolean> {
  const { evaluateWrite } = await import('../../shared/core/write-access')
  const r = await call(user, 'GET', `${BASE}/me/write-access`)
  expect(r.status).toBe(200)
  return evaluateWrite(r.json.data, path).write
}

async function effective(path: string): Promise<Map<string, { read: boolean; write: boolean }>> {
  const r = await call('owner', 'GET', `${BASE}/permissions/effective?path=${encodeURIComponent(path)}`)
  expect(r.status).toBe(200)
  return new Map((r.json.data.members as Array<{ userId: string; read: boolean; write: boolean }>).map(m => [m.userId, m]))
}

const setMembers = (by: User, ids: User[], extra: Record<string, unknown> = {}) =>
  call(by, 'PUT', `${BASE}/departments/${salesId}/members`, { userIds: ids.map(uid), ...extra })

/** Their app is new enough to recover from [WRITE_DENIED]: the outdated-app guard lets their loss through. */
function appIsCurrent(user: User) {
  db.prepare(`INSERT OR REPLACE INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(uid(user), CO, V_NEW, ts(), ts())
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-dept-member-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const expires = new Date(Date.now() + 3600_000).toISOString()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, uid('owner'), ts(), ts())
  }
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const u of USERS) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(uid(u), `${u}@example.com`, u)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${u}`, uid(u), `tok-${u}`, expires)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${u}`, uid(u), CO, ROLE[u], ts(), ts())
  }
  authDb.close()
  // Alice is also in another company, where she belongs to a department of the same name.
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('m-alice-other', uid('alice'), OTHER, 'member', ts(), ts())

  const { localRepoStore } = await import('../../src/adapters/git-repo-store')
  const store = localRepoStore()
  bare = await store.createCompanyRepo(CO)
  await store.seedCompanyRepo(CO, bare, ['old'])
  const { syncCompanyScopes, ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  // A department from before this change: its scope has no rules (inherits everyone: read + write).
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at)
    VALUES ('dmw-old', ?, '前からの部署', 'old', 'Folder', '#000000', 0, 1, ?, ?)`).run(CO, ts(), ts())
  syncCompanyScopes(db, CO)
  ensureCompanyScope(db, OTHER)
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at)
    VALUES ('dmw-other-sales', ?, '営業部', '営業部', 'Folder', '#000000', 0, 1, ?, ?)`).run(OTHER, ts(), ts())
  syncCompanyScopes(db, OTHER)

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { departmentsRoute } = await import('../../src/routes/departments')
  const { permissionsRoute } = await import('../../src/routes/permissions')
  const { permissionRulesRoute } = await import('../../src/routes/permission-rules')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  app = new Hono()
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  app.route('/api/companies/:companyId', permissionsRoute)
  app.route('/api/companies/:companyId', permissionRulesRoute)
  const gitApp = new Hono()
  gitApp.route('/api/git-http', gitHttpRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: gitApp.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      gitUrl = `http://127.0.0.1:${info.port}/api/git-http/${CO}.git`
      resolve()
    })
  })

  const created = await call('owner', 'POST', `${BASE}/departments`, { name: '営業部', folder: '営業部' })
  expect(created.status).toBe(201)
  salesId = created.json.data.id
  db.prepare(`INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)`).run(CO, salesId, uid('manager'), ts())
  // In the other company Alice belongs to its 営業部, which lets only its members write.
  db.prepare(`INSERT INTO department_members (company_id, department_id, user_id, created_at, created_by) VALUES (?, 'dmw-other-sales', ?, ?, ?)`)
    .run(OTHER, uid('alice'), ts(), uid('owner'))
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('a new department: everyone reads, the people who belong to it write', () => {
  it('is created with everyone: read and the department: read + write, and nobody belongs yet', () => {
    const rules = db.prepare(`
      SELECT r.subject_type, r.subject_id, r.can_read, r.can_write FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
      WHERE s.company_id = ? AND s.department_id = ? ORDER BY r.subject_type`).all(CO, salesId)
    expect(rules).toEqual([
      { subject_type: 'department', subject_id: salesId, can_read: 1, can_write: 1 },
      { subject_type: 'everyone', subject_id: null, can_read: 1, can_write: 0 },
    ])
  })

  it('before anyone belongs: only owners and admins write; everyone reads', async () => {
    const access = await effective('営業部/a.md')
    expect(access.get(uid('alice'))).toMatchObject({ read: true, write: false })
    expect(access.get(uid('manager'))).toMatchObject({ read: true, write: false })
    expect(access.get(uid('owner'))).toMatchObject({ read: true, write: true })
    expect(await appSaysWritable('alice', '営業部/a.md')).toBe(false)
    const refused = await pushFile('alice', '営業部/a.md')
    expect(refused.ok).toBe(false)
    expect(refused.output).toContain('[WRITE_DENIED] 変更する権限のないファイルが含まれています')
    expect(refused.output).toMatch(/- 営業部\/a\.md/)
    expect((await pushFile('owner', '営業部/by-owner.md')).ok).toBe(true)
  })

  it('a department that existed before is unchanged: every member writes there', async () => {
    expect(await appSaysWritable('alice', 'old/x.md')).toBe(true)
    expect((await pushFile('alice', 'old/x.md')).ok).toBe(true)
  })

  it('adding someone lets them write; someone else still cannot', async () => {
    const added = await setMembers('owner', ['alice'])
    expect(added.status).toBe(200)
    expect(await appSaysWritable('alice', '営業部/b.md')).toBe(true)
    expect((await pushFile('alice', '営業部/b.md')).ok).toBe(true)

    expect(await appSaysWritable('bob', '営業部/b.md')).toBe(false)
    const bob = await pushFile('bob', '営業部/bob.md')
    expect(bob.ok).toBe(false)
    expect(bob.output).toContain('[WRITE_DENIED]')
    expect((await effective('営業部')).get(uid('bob'))).toMatchObject({ read: true, write: false })
  })

  it('removing someone takes their write away, behind the outdated-app guard', async () => {
    // Alice's app is unknown to the server (her pushes above told it; forget that):
    // losing write could leave it retrying forever.
    db.prepare('DELETE FROM client_activity WHERE company_id = ? AND user_id = ?').run(CO, uid('alice'))
    const blocked = await setMembers('owner', [])
    expect(blocked.status).toBe(409)
    expect(blocked.json).toMatchObject({ code: 'OUTDATED_CLIENTS', canForce: true })
    expect(blocked.json.members.map((m: { userId: string }) => m.userId)).toEqual([uid('alice')])
    expect(await appSaysWritable('alice', '営業部/c.md')).toBe(true)

    // A manager may not override; an owner may.
    expect((await setMembers('manager', [], { force: true })).status).toBe(403)
    expect((await setMembers('owner', [], { force: true })).status).toBe(200)
    expect(await appSaysWritable('alice', '営業部/c.md')).toBe(false)
    expect((await pushFile('alice', '営業部/c.md')).ok).toBe(false)

    // With a current app nothing blocks.
    expect((await setMembers('owner', ['alice'])).status).toBe(200)
    appIsCurrent('alice')
    expect((await setMembers('manager', [])).status).toBe(200)
    expect(await appSaysWritable('alice', '営業部/c.md')).toBe(false)
  })
})

describe('another company never counts', () => {
  it('belonging to another company\'s department of the same name grants nothing here', async () => {
    expect(await appSaysWritable('alice', '営業部/d.md')).toBe(false)
    expect((await pushFile('alice', '営業部/d.md')).ok).toBe(false)
  })

  it('a rule cannot name another company\'s department (API and database)', async () => {
    const r = await call('owner', 'POST', `${BASE}/permissions/rules`, { path: 'old', subjectType: 'department', subjectId: 'dmw-other-sales', canWrite: true })
    expect(r.status).toBe(400)
    expect(r.json.error).toBe('Unknown department')
    const scope = db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = 'old'`).get(CO) as { id: string }
    expect(() => db.prepare(`
      INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at)
      VALUES ('dmw-cross', ?, ?, 'department', 'dmw-other-sales', 1, 1, ?)`).run(CO, scope.id, ts())).toThrow(/department of the same company/)
    expect(() => db.prepare(`
      INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at)
      VALUES ('dmw-cross2', ?, 'department', 'dmw-other-sales', 1, 1, ?)`).run(scope.id, ts())).toThrow(/department of the same company/)
  })

  it('a rule naming this company\'s department through the editor reads as the people who belong', async () => {
    const r = await call('owner', 'POST', `${BASE}/permissions/rules`, { path: 'old', subjectType: 'department', subjectId: salesId, canWrite: true })
    expect(r.status).toBe(201)
    const rule = r.json.data.rules.find((x: { subjectType: string }) => x.subjectType === 'department')
    expect(rule).toMatchObject({ subjectId: salesId, subjectLabel: '営業部に所属する人', memberIds: [] })
  })
})

describe('deleting the department removes the rules naming it', () => {
  it('leaves no department rule behind', async () => {
    const del = await call('owner', 'DELETE', `${BASE}/departments/${salesId}`)
    expect(del.status).toBe(200)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_rules WHERE company_id = ? AND subject_type = 'department'`).get(CO)).toEqual({ n: 0 })
  })
})
