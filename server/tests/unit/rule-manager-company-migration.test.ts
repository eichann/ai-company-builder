/**
 * company_id on scope_rules and department_managers (db/index.ts
 * migrateRuleAndManagerCompanies) against a database as the previous server
 * left it (tests/fixtures/app-schema-before-rule-companies.sql, frozen):
 * every existing rule and manager keeps its row and gets the company of its
 * scope / department — the per-company counts are the same before and after —
 * rows whose parent is gone are removed, and from then on no row can carry
 * another company or none at all, while an older build that inserts without
 * the column keeps working.
 */
import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateRuleAndManagerCompanies } from '../../src/db'

const OLD_SCHEMA = readFileSync(new URL('../fixtures/app-schema-before-rule-companies.sql', import.meta.url), 'utf8')
const TS = '2026-10-01T00:00:00.000Z'
let conn: Database.Database

const run = (sql: string, ...args: unknown[]) => conn.prepare(sql).run(...args)
const all = (sql: string, ...args: unknown[]) => conn.prepare(sql).all(...args)

/** Rules and managers per company, found through their parent (the only way before the column). */
function countsByParent() {
  return {
    rules: all(`SELECT s.company_id AS co, COUNT(*) AS n FROM scope_rules r JOIN scopes s ON s.id = r.scope_id GROUP BY s.company_id ORDER BY co`),
    managers: all(`SELECT d.company_id AS co, COUNT(*) AS n FROM department_managers m JOIN departments d ON d.id = m.department_id GROUP BY d.company_id ORDER BY co`),
  }
}

beforeEach(() => {
  conn = new Database(':memory:')
  conn.exec(OLD_SCHEMA)
  for (const co of ['co-a', 'co-b']) {
    run('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', co, co, co, 'u', TS, TS)
    run(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)`, `${co}-root`, co, TS)
    run('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `${co}-d`, co, '営業部', '営業部', TS, TS)
    run(`INSERT INTO scopes (id, company_id, path, kind, department_id, created_at) VALUES (?, ?, '営業部', 'department', ?, ?)`, `${co}-ds`, co, `${co}-d`, TS)
    run('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `m-${co}`, `${co}-boss`, co, 'member', TS, TS)
  }
  const rule = (id: string, scope: string, type: string, subject: string | null, r: number, w: number) =>
    run('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, scope, type, subject, r, w, TS)
  rule('a1', 'co-a-root', 'everyone', null, 1, 1)
  rule('a2', 'co-a-ds', 'everyone', null, 1, 0)
  rule('a3', 'co-a-ds', 'user', 'co-a-boss', 1, 1)
  rule('b1', 'co-b-root', 'everyone', null, 1, 1)
  run('INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)', 'co-a-d', 'co-a-boss', TS)
  run('INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)', 'co-b-d', 'co-b-boss', TS)
  // Left behind by an older build with foreign keys off: their parent is gone.
  conn.pragma('foreign_keys = OFF')
  rule('orphan-rule', 'gone-scope', 'everyone', null, 1, 1)
  run('INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)', 'gone-dept', 'someone', TS)
  conn.pragma('foreign_keys = ON')
})

describe('company_id on rules and managers: the backfill', () => {
  it('gives every row the company of its parent; per-company counts are unchanged; other columns untouched', () => {
    const before = countsByParent()
    const rulesBefore = all('SELECT id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by FROM scope_rules WHERE scope_id IN (SELECT id FROM scopes) ORDER BY id')
    const managersBefore = all('SELECT department_id, user_id, created_at, created_by FROM department_managers WHERE department_id IN (SELECT id FROM departments) ORDER BY department_id, user_id')

    initDatabase(conn)

    expect(countsByParent()).toEqual(before)
    expect(all(`SELECT company_id AS co, COUNT(*) AS n FROM scope_rules GROUP BY company_id ORDER BY co`)).toEqual(before.rules)
    expect(all(`SELECT company_id AS co, COUNT(*) AS n FROM department_managers GROUP BY company_id ORDER BY co`)).toEqual(before.managers)
    expect(all(`SELECT r.id FROM scope_rules r JOIN scopes s ON s.id = r.scope_id WHERE r.company_id IS NOT s.company_id`)).toEqual([])
    expect(all(`SELECT m.user_id FROM department_managers m JOIN departments d ON d.id = m.department_id WHERE m.company_id IS NOT d.company_id`)).toEqual([])
    expect(all('SELECT id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by FROM scope_rules ORDER BY id')).toEqual(rulesBefore)
    expect(all('SELECT department_id, user_id, created_at, created_by FROM department_managers ORDER BY department_id, user_id')).toEqual(managersBefore)
  })

  it('removes only the rows whose parent is gone, and is idempotent', () => {
    expect(migrateRuleAndManagerCompanies(conn)).toEqual({ rulesBackfilled: 4, rulesRemoved: 1, managersBackfilled: 2, managersRemoved: 1 })
    expect(all(`SELECT id FROM scope_rules WHERE id = 'orphan-rule'`)).toEqual([])
    expect(all(`SELECT user_id FROM department_managers WHERE department_id = 'gone-dept'`)).toEqual([])
    expect(migrateRuleAndManagerCompanies(conn)).toEqual({ rulesBackfilled: 0, rulesRemoved: 0, managersBackfilled: 0, managersRemoved: 0 })
    initDatabase(conn)
    expect(all('SELECT COUNT(*) AS n FROM scope_rules WHERE company_id IS NULL')).toEqual([{ n: 0 }])
  })
})

describe('company_id on rules and managers: new rows', () => {
  beforeEach(() => { initDatabase(conn) })

  it('a row inserted without the column (an older build) gets its parent’s company', () => {
    run('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'old-build', 'co-b-ds', 'everyone', null, 1, 0, TS)
    run('INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)', 'co-b-d', 'old-build-user', TS)
    expect(all(`SELECT company_id FROM scope_rules WHERE id = 'old-build'`)).toEqual([{ company_id: 'co-b' }])
    expect(all(`SELECT company_id FROM department_managers WHERE user_id = 'old-build-user'`)).toEqual([{ company_id: 'co-b' }])
  })

  it('refuses a row under another company’s scope or department, a cleared company, and a move across companies', () => {
    expect(() => run('INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'x', 'co-a', 'co-b-ds', 'everyone', null, 1, 1, TS)).toThrow(/company of its scope/)
    expect(() => run('INSERT INTO department_managers (department_id, company_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      'co-b-d', 'co-a', 'co-a-boss', TS)).toThrow(/company of its department/)
    expect(() => run(`UPDATE scope_rules SET company_id = NULL WHERE id = 'a1'`)).toThrow(/company of its scope/)
    expect(() => run(`UPDATE scope_rules SET scope_id = 'co-b-ds' WHERE id = 'a2'`)).toThrow(/company of its scope/)
    expect(() => run(`UPDATE department_managers SET company_id = 'co-b' WHERE department_id = 'co-a-d'`)).toThrow(/company of its department/)
    expect(all(`SELECT id FROM scope_rules WHERE id = 'x'`)).toEqual([])
    expect(all(`SELECT company_id, scope_id FROM scope_rules WHERE id IN ('a1', 'a2') ORDER BY id`)).toEqual([
      { company_id: 'co-a', scope_id: 'co-a-root' }, { company_id: 'co-a', scope_id: 'co-a-ds' },
    ])
  })
})
