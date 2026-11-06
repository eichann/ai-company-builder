/**
 * The rule subject 'department' on a database the previous server left
 * (db/schema/permissions.ts migrateDepartmentRuleSubject, on the frozen
 * tests/fixtures/app-schema-before-rule-companies.sql whose scope_rules
 * CHECK knows only everyone / role / user): the table is rebuilt once with
 * every rule kept (ids, values, order, company), the company triggers come
 * back, and a department rule can name only a department of its own company.
 */
import { readFileSync } from 'fs'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateDepartmentRuleSubject } from '../../src/db'
import { listScopesWithRules } from '../../src/adapters/sqlite/permission-store'

const OLD_SCHEMA = readFileSync(new URL('../fixtures/app-schema-before-rule-companies.sql', import.meta.url), 'utf8')
const TS = '2026-10-01T00:00:00.000Z'
let conn: Database.Database

const run = (sql: string, ...args: unknown[]) => conn.prepare(sql).run(...args)
const all = (sql: string, ...args: unknown[]) => conn.prepare(sql).all(...args)
const departmentRule = (id: string, scope: string, department: string, company?: string) =>
  company
    ? run(`INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'department', ?, 1, 1, ?)`, id, company, scope, department, TS)
    : run(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'department', ?, 1, 1, ?)`, id, scope, department, TS)

beforeEach(() => {
  conn = new Database(':memory:')
  conn.exec(OLD_SCHEMA)
  for (const co of ['co-a', 'co-b']) {
    run('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', co, co, co, 'u', TS, TS)
    run(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)`, `${co}-root`, co, TS)
    run('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `${co}-d`, co, '営業部', '営業部', TS, TS)
    run(`INSERT INTO scopes (id, company_id, path, kind, department_id, created_at) VALUES (?, ?, '営業部', 'department', ?, ?)`, `${co}-ds`, co, `${co}-d`, TS)
  }
  const rule = (id: string, scope: string, type: string, subject: string | null, r: number, w: number) =>
    run('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, scope, type, subject, r, w, TS)
  rule('a1', 'co-a-root', 'everyone', null, 1, 1)
  rule('a3', 'co-a-ds', 'user', 'co-a-boss', 1, 1)
  rule('a2', 'co-a-ds', 'everyone', null, 1, 0)
  rule('b1', 'co-b-root', 'everyone', null, 1, 1)
})

describe('scope_rules learns the department subject', () => {
  it('the old table refuses it; after startup every rule is kept, in order, and it is accepted', () => {
    expect(() => departmentRule('x', 'co-a-ds', 'co-a-d')).toThrow(/CHECK/)
    const before = all('SELECT rowid, id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by FROM scope_rules ORDER BY rowid')

    initDatabase(conn)

    expect(all('SELECT rowid, id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by FROM scope_rules ORDER BY rowid')).toEqual(before)
    expect(all('SELECT id, company_id FROM scope_rules ORDER BY id')).toEqual([
      { id: 'a1', company_id: 'co-a' }, { id: 'a2', company_id: 'co-a' }, { id: 'a3', company_id: 'co-a' }, { id: 'b1', company_id: 'co-b' },
    ])
    // Rules stay oldest first for the model (same created_at: rowid decides).
    expect(listScopesWithRules(conn, 'co-a').find(s => s.id === 'co-a-ds')!.rules.map(r => r.id)).toEqual(['a3', 'a2'])
    departmentRule('d1', 'co-a-ds', 'co-a-d')
    expect(all(`SELECT company_id FROM scope_rules WHERE id = 'd1'`)).toEqual([{ company_id: 'co-a' }])
  })

  it('rebuilds once: a second start changes nothing', () => {
    initDatabase(conn)
    expect(migrateDepartmentRuleSubject(conn)).toEqual({ rebuilt: false })
    initDatabase(conn)
    expect(all('SELECT COUNT(*) AS n FROM scope_rules')).toEqual([{ n: 4 }])
  })

  it('the company triggers come back with the rebuilt table', () => {
    initDatabase(conn)
    expect(() => run(`INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at)
      VALUES ('x', 'co-b', 'co-a-ds', 'everyone', NULL, 1, 1, ?)`, TS)).toThrow(/company of its scope/)
    expect(() => run(`UPDATE scope_rules SET company_id = NULL WHERE id = 'a1'`)).toThrow(/company of its scope/)
  })

  it('a department rule names a department of its own company, given or not, and keeps doing so', () => {
    initDatabase(conn)
    expect(() => departmentRule('x1', 'co-a-ds', 'co-b-d', 'co-a')).toThrow(/department of the same company/)
    expect(() => departmentRule('x2', 'co-a-ds', 'co-b-d')).toThrow(/department of the same company/)
    expect(() => departmentRule('x3', 'co-a-ds', 'nowhere')).toThrow(/department of the same company/)
    expect(() => run(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('x4', 'co-a-ds', 'department', NULL, 1, 1, ?)`, TS))
      .toThrow(/department of the same company/)
    departmentRule('ok', 'co-a-ds', 'co-a-d')
    expect(() => run(`UPDATE scope_rules SET subject_id = 'co-b-d' WHERE id = 'ok'`)).toThrow(/department of the same company/)
    expect(() => run(`UPDATE scope_rules SET subject_type = 'department', subject_id = 'co-b-d' WHERE id = 'a2'`)).toThrow(/department of the same company/)
  })

  it('who belongs is read with the rules, from the rule\'s own company only', () => {
    initDatabase(conn)
    departmentRule('d1', 'co-a-ds', 'co-a-d')
    run(`INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES ('co-a', 'co-a-d', 'alice', ?)`, TS)
    run(`INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES ('co-b', 'co-b-d', 'bob', ?)`, TS)
    const rule = listScopesWithRules(conn, 'co-a').find(s => s.id === 'co-a-ds')!.rules.find(r => r.id === 'd1')!
    expect(rule).toMatchObject({ subjectType: 'department', subjectId: 'co-a-d', memberIds: ['alice'] })
    expect(listScopesWithRules(conn, 'co-a').flatMap(s => s.rules).filter(r => r.subjectType !== 'department').every(r => r.memberIds === undefined)).toBe(true)
  })
})
