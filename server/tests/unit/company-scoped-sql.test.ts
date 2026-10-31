/**
 * Cross-company access is impossible by construction (案 A, 2026-10-31,
 * `.claude/rules/server.md` "Company handle"): a statement that reads or writes
 * a company's rows names its company. This test reads every SQL statement in
 * server/src and fails when one touches a company-owned table without a
 * company condition (`company_id = ?` / `company_id IN`; an INSERT names
 * `company_id`), unless it is listed below with its reason.
 *
 * The list has two kinds of entries:
 * - PENDING: statements of areas not yet moved behind the company handle
 *   (ports/company-data.ts). Each migration PR removes its entries; the list
 *   only shrinks.
 * - Reasoned exceptions that stay: the control plane (lookups that come before
 *   a company is known — an invitation or key-broker token — and operator /
 *   retention jobs that walk every company), and statements whose WHERE is
 *   built by a helper that always starts with `company_id = ?`.
 *
 * Tables without a company (the companies registry, memberships, the unused
 * ssh_keys) are the control plane and listed in CONTROL_PLANE_TABLES. Every
 * other table must have a company_id column (TABLES_WITHOUT_COMPANY_ID lists
 * the two still missing it).
 *
 * A table already behind the handle (HANDLE_TABLES) is written only by its
 * handle repository, and that repository is built only by the handle source
 * (adapters/sqlite/company-data.ts).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

const SRC = resolve(__dirname, '../../src')

const CONTROL_PLANE_TABLES: Record<string, string> = {
  companies: 'the registry of companies itself: a row is a company (its id is the company condition)',
  memberships: 'who belongs where: the sign-in check looks a user up across companies before a company is chosen',
  ssh_keys: 'per user, unused since R1 (still created by db/index.ts)',
}

/** Better Auth's tables in auth.sqlite: accounts and sessions, shared by every company by design. */
const AUTH_TABLES = new Set(['user', 'session', 'account', 'verification'])

const TABLES_WITHOUT_COMPANY_ID: Record<string, string> = {
  scope_rules: 'company only through scope_id → scopes; company_id is added in a later PR',
  department_managers: 'company only through department_id → departments; company_id is added in a later PR',
}

/** Tables behind the company handle → the one module that writes them. */
const HANDLE_TABLES: Record<string, string> = {
  departments: 'adapters/sqlite/departments.ts',
}
/** Handle repositories → the handle source, the only module that may build them. */
const HANDLE_MODULES: Record<string, string> = {
  'adapters/sqlite/departments.ts': 'adapters/sqlite/company-data.ts',
}

const PENDING = 'not yet behind the company handle (案 A): moves there in a later PR'
const BUILT_WHERE = 'WHERE built by a helper in this file whose first clause is always `company_id = ?`'
const BY_TOKEN = 'the company is not known before the token: this lookup is what finds it (control plane)'

/** file → statements without a company condition (normalized whitespace; each occurrence listed). */
const UNSCOPED: Record<string, Array<[sql: string, reason: string]>> = {
  'adapters/orphaned-scopes.ts': [
    ['DELETE FROM orphaned_scopes WHERE scope_id = ?', PENDING],
  ],
  'adapters/private-folders.ts': [
    ['INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', PENDING],
    ['INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scope_repos WHERE id = ?', PENDING],
    ['DELETE FROM scope_repos WHERE id = ?', PENDING],
    ['DELETE FROM scope_repos WHERE id = ?', PENDING],
    ['UPDATE scope_rules SET can_read = 1 WHERE scope_id = ?', PENDING],
    ['UPDATE scopes SET repo_id = NULL WHERE id = ?', PENDING],
  ],
  'adapters/sqlite/agent-events.ts': [
    ['SELECT ${COLUMNS} FROM agent_events WHERE ${w.sql}${cursor} ORDER BY at DESC, seq DESC LIMIT ?', BUILT_WHERE],
    ["SELECT strftime('%Y-%m-%d', at, ?) AS day, user_id, category, ${denied} AS denied, COUNT(*) AS n FROM agent_events WHERE ${w.sql} GROUP BY day, user_id, category, denied ORDER BY day ASC, user_id ASC, category ASC", BUILT_WHERE],
    ['SELECT DISTINCT company_id FROM agent_events', 'the retention job lists the companies it then prunes one at a time (ids only)'],
  ],
  'adapters/sqlite/invitations.ts': [
    ['DELETE FROM invitations WHERE id = ?', PENDING],
    ['UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL AND (signup_user_id IS NULL OR signup_user_id = ?)', PENDING],
    ['UPDATE invitations SET signup_claimed_at = ? WHERE token = ? AND used_by IS NULL AND signup_claimed_at IS NULL AND expires_at > ? RETURNING id', BY_TOKEN],
    ['UPDATE invitations SET signup_claimed_at = NULL, signup_user_id = NULL WHERE id = ? AND used_by IS NULL', PENDING],
    ['UPDATE invitations SET signup_user_id = ? WHERE id = ?', PENDING],
  ],
  'adapters/sqlite/key-broker.ts': [
    ['SELECT company_id, id, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id FROM broker_keys ORDER BY rowid', 'operator command: re-wrapping every sealed key under a new KEK (no route reaches it; key-broker.md)'],
    ['DELETE FROM broker_usage WHERE day < ?', 'server-wide cleanup of old daily counters (no row is read); to become per company'],
    ['SELECT * FROM broker_tokens WHERE token_hash = ?', BY_TOKEN],
    ['DELETE FROM broker_tokens WHERE expires_at < ?', 'server-wide cleanup of expired tokens (no row is read); to become per company'],
  ],
  'adapters/sqlite/permission-store.ts': [
    ["INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by) VALUES (?, ?, 'everyone', NULL, 1, 1, ?, ?)", PENDING],
    ['INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', PENDING],
    ['SELECT id, path FROM scopes WHERE department_id = ?', PENDING],
    ['UPDATE scopes SET path = ? WHERE id = ?', PENDING],
    ['UPDATE scopes SET path = ? WHERE id = ?', PENDING],
    ["UPDATE scopes SET kind = 'department', department_id = ? WHERE id = ?", PENDING],
    ['SELECT repo_id FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scopes WHERE id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE scope_id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE id = ?', PENDING],
    ['DELETE FROM scope_rules WHERE id = ?', PENDING],
    ['SELECT * FROM scope_rules WHERE scope_id = ? ORDER BY created_at ASC, rowid ASC', PENDING],
    ['UPDATE scope_rules SET can_read = ?, can_write = ? WHERE id = ?', PENDING],
    ['UPDATE scope_rules SET scope_id = ? WHERE scope_id = ?', PENDING],
    ['DELETE FROM department_managers WHERE department_id NOT IN (SELECT id FROM departments)', PENDING],
    ['DELETE FROM department_managers WHERE department_id = ?', PENDING],
    ['DELETE FROM department_managers WHERE department_id = ? AND user_id = ?', PENDING],
    ['SELECT user_id FROM department_managers WHERE department_id = ?', PENDING],
    ['INSERT INTO department_managers (department_id, user_id, created_at, created_by) VALUES (?, ?, ?, ?)', PENDING],
  ],
  'adapters/sqlite/push-rejections.ts': [
    ["SELECT COUNT(*) AS n FROM push_rejections WHERE ${where.join(' AND ')}", BUILT_WHERE],
    ["SELECT id, user_id, marker, paths, created_at FROM push_rejections WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?", BUILT_WHERE],
  ],
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Every string literal that is a DML statement, whitespace normalized. */
function statements(source: string): string[] {
  const found: string[] = []
  for (const m of withoutComments(source).matchAll(/`([^`]*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const text = (m[1] ?? m[2] ?? m[3]).replace(/\s+/g, ' ').trim()
    if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i.test(text)) found.push(text)
  }
  return found
}

const tablesOf = (sql: string) => [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?!SET\b)([A-Za-z_]+)/gi)].map(m => m[1])
/** The table an INSERT / UPDATE / DELETE writes. */
const writtenTable = (sql: string) => /^(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_]+)/i.exec(sql)?.[1]

function hasCompanyCondition(sql: string): boolean {
  if (/^(INSERT|REPLACE)\b/i.test(sql)) return /\bcompany_id\b/.test(sql)
  return /\bcompany_id\s*(=|IN\b)/i.test(sql)
}

/** The application schema: table → its columns (CREATE TABLE in db/index.ts, plus ALTER TABLE … ADD COLUMN). */
function schema(): Map<string, Set<string>> {
  const source = readFileSync(join(SRC, 'db/index.ts'), 'utf8')
  const tables = new Map<string, Set<string>>()
  for (const m of source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g)) {
    const cols = m[2].split('\n').map(l => /^\s*(\w+)\s+[A-Z]/.exec(l)?.[1]).filter((c): c is string => !!c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK)$/.test(c))
    tables.set(m[1], new Set(cols))
  }
  for (const m of source.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) tables.get(m[1])?.add(m[2])
  return tables
}

const tables = schema()
const companyTables = new Set([...tables.keys()].filter(t => !(t in CONTROL_PLANE_TABLES)))
const allStatements = tsFiles(SRC).map(file => ({ file: relative(SRC, file), sql: statements(readFileSync(file, 'utf8')) }))

describe('company-scoped SQL (案 A)', () => {
  it('reads the schema and finds the statements', () => {
    expect(tables.size).toBeGreaterThan(20)
    expect(allStatements.reduce((n, f) => n + f.sql.length, 0)).toBeGreaterThan(100)
  })

  it('every table but the control plane has a company_id column (except the listed ones, still to come)', () => {
    for (const t of Object.keys(CONTROL_PLANE_TABLES)) expect(tables.has(t), `control-plane table ${t} is not in the schema`).toBe(true)
    const missing = [...companyTables].filter(t => !tables.get(t)!.has('company_id')).sort()
    expect(missing).toEqual(Object.keys(TABLES_WITHOUT_COMPANY_ID).sort())
  })

  it('statements name only known tables', () => {
    for (const { file, sql } of allStatements) {
      for (const s of sql) {
        for (const t of tablesOf(s)) {
          expect(tables.has(t) || AUTH_TABLES.has(t), `${file}: unknown table ${t} in ${s}`).toBe(true)
        }
      }
    }
  })

  it('every statement on a company-owned table has a company condition, or is listed with its reason', () => {
    const found: Record<string, string[]> = {}
    for (const { file, sql } of allStatements) {
      const unscoped = sql.filter(s => tablesOf(s).some(t => companyTables.has(t)) && !hasCompanyCondition(s))
      if (unscoped.length > 0) found[file] = unscoped.sort()
    }
    const allowed = Object.fromEntries(Object.entries(UNSCOPED).map(([file, list]) => [file, list.map(([s]) => s).sort()]))
    // A new statement here: give it its company (or a handle). A statement that left: remove its entry.
    expect(found).toEqual(allowed)
  })

  it('a table behind the company handle is written only by its handle repository', () => {
    for (const { file, sql } of allStatements) {
      for (const s of sql) {
        const t = writtenTable(s)
        if (t && t in HANDLE_TABLES) expect(file, `${file} writes ${t}: go through the company handle`).toBe(HANDLE_TABLES[t])
      }
    }
  })

  it('handle repositories are built only by the handle source', () => {
    const importer = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g
    const testsDir = resolve(__dirname, '..')
    for (const file of [...tsFiles(SRC), ...tsFiles(testsDir)]) {
      for (const m of withoutComments(readFileSync(file, 'utf8')).matchAll(importer)) {
        if (!m[1].startsWith('.')) continue
        const target = relative(SRC, resolve(join(file, '..'), m[1])).replace(/\.ts$/, '') + '.ts'
        if (!(target in HANDLE_MODULES)) continue
        expect(relative(SRC, file), `${relative(SRC, file)} imports ${target}: use the handle (forCompany)`).toBe(HANDLE_MODULES[target])
      }
    }
  })
})
