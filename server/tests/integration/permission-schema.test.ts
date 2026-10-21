/**
 * Integration Test: permission tables — creation, seeding, migration of an
 * existing database, and department scopes kept in sync with the departments
 * API (create / folder rename / delete).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const currentUser = vi.hoisted(() => ({ id: 'ps-owner' as string | null }))

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

import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { seedPermissionScopes, replaceDepartmentManagers } from '../../src/lib/permission-store'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// Department routes commit in a server-side clone; do not depend on host git identity.
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.com'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

const OLD_SCHEMA = readFileSync(new URL('../fixtures/app-schema-before-permissions.sql', import.meta.url), 'utf8')

type ScopeRow = { id: string; company_id: string; path: string; kind: string; department_id: string | null; repo_id: string | null; created_at: string; created_by: string | null }
type RuleRow = { id: string; scope_id: string; subject_type: string; subject_id: string | null; can_read: number; can_write: number }

function scopesOf(conn: Database.Database, companyId: string): ScopeRow[] {
  return conn.prepare('SELECT * FROM scopes WHERE company_id = ? ORDER BY path').all(companyId) as ScopeRow[]
}
function rulesOf(conn: Database.Database, scopeId: string): RuleRow[] {
  return conn.prepare('SELECT * FROM scope_rules WHERE scope_id = ?').all(scopeId) as RuleRow[]
}
function tables(conn: Database.Database): string[] {
  return (conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map(r => r.name)
}
function countAll(conn: Database.Database): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of ['scopes', 'scope_rules', 'department_managers', 'push_rejections']) {
    out[t] = (conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  }
  return out
}

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'acb-perm-schema-'))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('schema on a fresh database', () => {
  it('creates the permission tables and indexes', () => {
    const conn = new Database(join(tmp, 'fresh.sqlite'))
    initDatabase(conn)
    expect(tables(conn)).toEqual(expect.arrayContaining(['scopes', 'scope_rules', 'department_managers', 'push_rejections']))
    const cols = (t: string) => (conn.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)
    expect(cols('scopes')).toEqual(['id', 'company_id', 'path', 'kind', 'department_id', 'repo_id', 'created_at', 'created_by'])
    expect(cols('scope_rules')).toEqual(['id', 'scope_id', 'subject_type', 'subject_id', 'can_read', 'can_write', 'created_at', 'created_by'])
    expect(cols('department_managers')).toEqual(['department_id', 'user_id', 'created_at', 'created_by'])
    expect(cols('push_rejections')).toEqual(['id', 'company_id', 'user_id', 'marker', 'paths', 'created_at'])
    // Nothing to seed without companies.
    expect(countAll(conn)).toEqual({ scopes: 0, scope_rules: 0, department_managers: 0, push_rejections: 0 })
    // (company_id, path) is unique.
    conn.prepare(`INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('c', 'C', 'c', 'u', 't', 't')`).run()
    seedPermissionScopes(conn)
    expect(() => conn.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('x', 'c', '', 'folder', 't')`).run()).toThrow(/UNIQUE/)
    conn.close()
  })
})

describe('migration of a database created by the previous server', () => {
  let conn: Database.Database
  const ts = '2026-01-01T00:00:00.000Z'

  beforeAll(() => {
    conn = new Database(join(tmp, 'old.sqlite'))
    conn.exec(OLD_SCHEMA)
    const ins = (sql: string, ...args: unknown[]) => conn.prepare(sql).run(...args)
    for (const co of ['old-a', 'old-b']) {
      ins('INSERT INTO companies (id, name, slug, owner_id, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)', co, co, co, 'o1', ts, ts)
      ins('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `m-${co}`, 'o1', co, 'owner', ts, ts)
    }
    for (const [id, co, folder] of [['d1', 'old-a', '営業部'], ['d2', 'old-a', 'コンテンツ'], ['d3', 'old-b', 'dev']]) {
      ins('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, co, folder, folder, ts, ts)
    }
    ins('INSERT INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'o1', 'old-a', '0.0.1+abc.20260101000000', ts, ts)
  })
  afterAll(() => conn.close())

  it('adds the tables, seeds scopes and keeps the old rows intact', () => {
    const before = {
      companies: conn.prepare('SELECT * FROM companies ORDER BY id').all(),
      memberships: conn.prepare('SELECT * FROM memberships ORDER BY id').all(),
      departments: conn.prepare('SELECT * FROM departments ORDER BY id').all(),
      client_activity: conn.prepare('SELECT * FROM client_activity').all(),
    }
    initDatabase(conn)
    expect(conn.prepare('SELECT * FROM companies ORDER BY id').all()).toEqual(before.companies)
    expect(conn.prepare('SELECT * FROM memberships ORDER BY id').all()).toEqual(before.memberships)
    expect(conn.prepare('SELECT * FROM departments ORDER BY id').all()).toEqual(before.departments)
    expect(conn.prepare('SELECT * FROM client_activity').all()).toEqual(before.client_activity)

    const a = scopesOf(conn, 'old-a')
    expect(a.map(s => [s.path, s.kind, s.department_id, s.repo_id])).toEqual([
      ['', 'company', null, null],
      ['コンテンツ', 'department', 'd2', null],
      ['営業部', 'department', 'd1', null],
    ])
    const companyScope = a.find(s => s.kind === 'company')!
    expect(rulesOf(conn, companyScope.id).map(r => [r.subject_type, r.subject_id, r.can_read, r.can_write])).toEqual([['everyone', null, 1, 1]])
    for (const s of a.filter(s => s.kind === 'department')) expect(rulesOf(conn, s.id)).toEqual([])
    expect(scopesOf(conn, 'old-b').map(s => s.path)).toEqual(['', 'dev'])
  })

  it('is idempotent and does not re-add a removed default rule', () => {
    const snapshot = { scopes: conn.prepare('SELECT * FROM scopes ORDER BY id').all(), rules: conn.prepare('SELECT * FROM scope_rules ORDER BY id').all() }
    initDatabase(conn)
    seedPermissionScopes(conn)
    expect(conn.prepare('SELECT * FROM scopes ORDER BY id').all()).toEqual(snapshot.scopes)
    expect(conn.prepare('SELECT * FROM scope_rules ORDER BY id').all()).toEqual(snapshot.rules)

    // An admin (Phase 2) replaced the default rule: seeding must not undo it.
    const companyScope = scopesOf(conn, 'old-b').find(s => s.kind === 'company')!
    conn.prepare('DELETE FROM scope_rules WHERE scope_id = ?').run(companyScope.id)
    conn.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('custom', ?, 'everyone', NULL, 1, 0, ?)`).run(companyScope.id, ts)
    seedPermissionScopes(conn)
    expect(rulesOf(conn, companyScope.id).map(r => r.id)).toEqual(['custom'])
  })

  it('keeps working with what an older server build does on the new database', () => {
    // Old code creates a department without a scope, renames a folder and
    // deletes a department with plain SQL — exactly what it does today.
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('d4', 'old-a', '人事部', '人事部', ts, ts)
    conn.prepare(`UPDATE departments SET folder = 'セールス' WHERE id = 'd1'`).run()
    replaceDepartmentManagers(conn, 'd2', ['o1'], 'o1')
    const d2Scope = scopesOf(conn, 'old-a').find(s => s.department_id === 'd2')!
    conn.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('d2rule', ?, 'everyone', NULL, 1, 1, ?)`).run(d2Scope.id, ts)
    conn.prepare(`DELETE FROM departments WHERE id = 'd2'`).run()

    // Foreign keys clean up the deleted department's scope, rules and managers.
    expect(scopesOf(conn, 'old-a').some(s => s.department_id === 'd2')).toBe(false)
    expect(conn.prepare(`SELECT COUNT(*) AS n FROM scope_rules WHERE id = 'd2rule'`).get()).toEqual({ n: 0 })
    expect(conn.prepare(`SELECT COUNT(*) AS n FROM department_managers WHERE department_id = 'd2'`).get()).toEqual({ n: 0 })

    // The next startup repairs the rest.
    initDatabase(conn)
    expect(scopesOf(conn, 'old-a').map(s => [s.path, s.department_id])).toEqual([
      ['', null], ['セールス', 'd1'], ['人事部', 'd4'],
    ])
  })

  it('removes orphans when foreign keys were not enforced', () => {
    conn.pragma('foreign_keys = OFF')
    replaceDepartmentManagers(conn, 'd4', ['o1'], 'o1')
    conn.prepare(`DELETE FROM departments WHERE id = 'd4'`).run()
    expect(scopesOf(conn, 'old-a').some(s => s.department_id === 'd4')).toBe(true)
    conn.pragma('foreign_keys = ON')
    seedPermissionScopes(conn)
    expect(scopesOf(conn, 'old-a').map(s => s.path)).toEqual(['', 'セールス'])
    expect(conn.prepare(`SELECT COUNT(*) AS n FROM department_managers WHERE department_id = 'd4'`).get()).toEqual({ n: 0 })
  })
})

describe('departments API keeps scopes in sync', () => {
  const CO = 'perm-sync-co'
  const app = new Hono()
  app.route('/api/companies', companiesRoute)
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
  const base = `/api/companies/${CO}/departments`

  beforeAll(() => {
    initDatabase()
    const ts = new Date().toISOString()
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'Sync', 'perm-sync', 'ps-owner', ts, ts)
    for (const [id, role] of [['ps-owner', 'owner'], ['ps-member', 'member']]) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}`, id, CO, role, ts, ts)
    }
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', join(process.env.REPOS_DIR!, `${CO}.git`)])
    seedPermissionScopes(db)
  })
  beforeEach(() => { currentUser.id = 'ps-owner' })

  let deptId: string

  it('create adds an inheriting department scope', async () => {
    const res = await json('POST', base, { name: 'コンテンツ', folder: 'コンテンツ' })
    expect(res.status).toBe(201)
    deptId = ((await res.json()) as { data: { id: string } }).data.id
    const s = scopesOf(db, CO).find(x => x.department_id === deptId)!
    expect(s).toMatchObject({ path: 'コンテンツ', kind: 'department', repo_id: null, created_by: 'ps-owner' })
    expect(rulesOf(db, s.id)).toEqual([])
  })

  it('folder rename moves the department scope and the folder scopes under it, rules attached', async () => {
    const dept = scopesOf(db, CO).find(x => x.department_id === deptId)!
    const ts = new Date().toISOString()
    db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('sub', ?, 'コンテンツ/受講生情報', 'folder', ?)`).run(CO, ts)
    db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('subrule', 'sub', 'user', 'ps-member', 1, 0, ?)`).run(ts)
    // A sibling sharing the prefix must not move.
    db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('sib', ?, 'コンテンツ2', 'folder', ?)`).run(CO, ts)

    const res = await json('PUT', `${base}/${deptId}`, { folder: 'マーケ' })
    expect(res.status).toBe(200)
    const after = scopesOf(db, CO)
    expect(after.find(x => x.id === dept.id)!.path).toBe('マーケ')
    expect(after.find(x => x.id === 'sub')!.path).toBe('マーケ/受講生情報')
    expect(after.find(x => x.id === 'sib')!.path).toBe('コンテンツ2')
    expect(rulesOf(db, 'sub').map(r => r.id)).toEqual(['subrule'])
  })

  it('a non-folder update leaves scopes alone', async () => {
    const before = scopesOf(db, CO)
    expect((await json('PUT', `${base}/${deptId}`, { name: 'Marketing' })).status).toBe(200)
    expect(scopesOf(db, CO)).toEqual(before)
  })

  it('delete removes the department scope subtree, its rules and its managers', async () => {
    replaceDepartmentManagers(db, deptId, ['ps-member'], 'ps-owner')
    const res = await json('DELETE', `${base}/${deptId}`)
    expect(res.status).toBe(200)
    const after = scopesOf(db, CO)
    expect(after.map(s => s.path)).toEqual(['', 'コンテンツ2'])
    expect(rulesOf(db, 'sub')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM department_managers WHERE department_id = ?').get(deptId)).toEqual({ n: 0 })
  })

  it('a company created through the API gets the default scopes', async () => {
    const res = await json('POST', '/api/companies', { name: 'Fresh Co' })
    expect(res.status).toBe(201)
    const id = ((await res.json()) as { data: { id: string } }).data.id
    const scopes = scopesOf(db, id)
    const company = scopes.find(s => s.kind === 'company')!
    expect(company.path).toBe('')
    expect(rulesOf(db, company.id).map(r => [r.subject_type, r.can_read, r.can_write])).toEqual([['everyone', 1, 1]])
    const deptCount = (db.prepare('SELECT COUNT(*) AS n FROM departments WHERE company_id = ?').get(id) as { n: number }).n
    expect(deptCount).toBeGreaterThan(0)
    expect(scopes.filter(s => s.kind === 'department')).toHaveLength(deptCount)
  })
})
