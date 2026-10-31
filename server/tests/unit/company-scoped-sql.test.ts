/**
 * Cross-company access is impossible by construction (案 A, 2026-10-31,
 * `.claude/rules/server.md` "Company handle"): a statement that reads or writes
 * a company's rows names its company. This test reads every SQL statement in
 * server/src and fails when one touches a company-owned table without a
 * company condition (`company_id = ?` / `company_id IN (…)`, possibly in a
 * subquery; an INSERT names `company_id`), unless it is listed below with its
 * reason.
 *
 * Every listed exception has a reason that stays: the control plane (lookups
 * that come before a company is known — an invitation or key-broker token —
 * and operator / retention / startup jobs that walk every company), and
 * statements whose WHERE is built by a helper that always starts with
 * `company_id = ?`. The list only shrinks: a new statement gets its company.
 *
 * Tables without a company (the companies registry, memberships, the unused
 * ssh_keys) are the control plane and listed in CONTROL_PLANE_TABLES. Every
 * other table must have a company_id column.
 *
 * A table behind the handle (HANDLE_TABLES) is written only by its handle
 * modules, and the handle repositories are built only by the handle source
 * (adapters/sqlite/company-data.ts), in src and in tests.
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
/**
 * SQLite's own catalog (table names, not company rows), and json_each: the
 * table-valued function a bound JSON array of ids is read through
 * (`id IN (SELECT value FROM json_each(?))`, adapters/sqlite/records.ts) — it
 * holds only the values bound to that statement.
 */
const SQLITE_CATALOG = new Set(['sqlite_master', 'json_each'])

/**
 * Modules allowed to build SQL with a table name chosen at run time (which this
 * test cannot read), with the reason. Each such statement must still bind the
 * company — reviewed by hand, covered by that module's own tests.
 */
const DYNAMIC_TABLE_SQL: Record<string, string> = {
  'adapters/sqlite/company-archive.ts': 'the per-company export / restore walks every company table from the schema: export binds company_id = ?, restore refuses rows of another company (tests/integration/company-archive.test.ts)',
}


/** Tables behind the company handle → the modules that write them (each statement limited to its company). */
const HANDLE_TABLES: Record<string, string[]> = {
  departments: ['adapters/sqlite/departments.ts'],
  invitations: ['adapters/sqlite/invitations.ts'],
  scopes: ['adapters/sqlite/permission-store.ts', 'adapters/private-folders.ts'],
  // db/index.ts: the company_id backfill of rows from before the column (MIGRATION below).
  scope_rules: ['adapters/sqlite/permission-store.ts', 'adapters/private-folders.ts', 'db/index.ts'],
  department_managers: ['adapters/sqlite/permission-store.ts', 'db/index.ts'],
  scope_repos: ['adapters/private-folders.ts'],
  private_folder_archives: ['adapters/private-folders.ts'],
  orphaned_scopes: ['adapters/orphaned-scopes.ts'],
  // The company map (records.md).
  record_settings: ['adapters/sqlite/records.ts'],
  record_types: ['adapters/sqlite/records.ts'],
  records: ['adapters/sqlite/records.ts'],
  record_links: ['adapters/sqlite/records.ts'],
  record_state: ['adapters/sqlite/records.ts'],
  record_index_heads: ['adapters/sqlite/records.ts'],
  record_index_problems: ['adapters/sqlite/records.ts'],
  record_ledger: ['adapters/sqlite/records.ts'],
  record_ai_tokens: ['adapters/sqlite/records.ts'],
  // Connector plugins (plugins.md).
  plugin_installs: ['adapters/sqlite/plugins.ts'],
  plugin_mappings: ['adapters/sqlite/plugins.ts'],
  plugin_history: ['adapters/sqlite/plugins.ts'],
  plugin_external_links: ['adapters/sqlite/plugins.ts'],
  plugin_policy_acks: ['adapters/sqlite/plugins.ts'],
  plugin_read_scopes: ['adapters/sqlite/plugins.ts'],
  plugin_operations: ['adapters/sqlite/plugins.ts'],
  // The Google connection (google-connector.md).
  google_oauth_clients: ['adapters/sqlite/connectors.ts'],
  connector_grants: ['adapters/sqlite/connectors.ts'],
  oauth_pending: ['adapters/sqlite/connectors.ts'],
  connector_history: ['adapters/sqlite/connectors.ts'],
  // Fixed content of approvals and outbound mail (approvals.md).
  fixed_payloads: ['adapters/sqlite/fixed-payloads.ts'],
}
/** Handle repository factories (each bound to one company): only the handle source builds them. */
const HANDLE_FACTORIES = ['sqliteDepartmentRepository', 'sqliteInvitationRepository', 'sqliteScopeRepository', 'sqlitePrivateFolderRepository', 'gitOrphanedScopeReader', 'sqliteRecordRepository', 'sqlitePluginRepository', 'sqliteConnectorRepository', 'sqliteFixedPayloadRepository']
const HANDLE_SOURCE = 'adapters/sqlite/company-data.ts'

const BUILT_WHERE = 'WHERE built by a helper in this file whose first clause is always `company_id = ?`'
const MIGRATION = 'startup migration (migrateRuleAndManagerCompanies): only rows without company_id, i.e. from before the column — gives each the company of its parent, or removes it when the parent is gone (it belongs to no company)'
const BY_TOKEN = 'the company is not known before the token: this lookup is what finds it (control plane)'

/** file → statements without a company condition (normalized whitespace; each occurrence listed). */
const UNSCOPED: Record<string, Array<[sql: string, reason: string]>> = {
  'adapters/sqlite/agent-events.ts': [
    ['SELECT ${COLUMNS} FROM agent_events WHERE ${w.sql}${cursor} ORDER BY at DESC, seq DESC LIMIT ?', BUILT_WHERE],
    ["SELECT strftime('%Y-%m-%d', at, ?) AS day, user_id, category, ${denied} AS denied, COUNT(*) AS n FROM agent_events WHERE ${w.sql} GROUP BY day, user_id, category, denied ORDER BY day ASC, user_id ASC, category ASC", BUILT_WHERE],
    ['SELECT DISTINCT company_id FROM agent_events', 'the retention job lists the companies it then prunes one at a time (ids only)'],
  ],
  'adapters/sqlite/invitations.ts': [
    ['SELECT i.*, c.name as company_name FROM invitations i JOIN companies c ON i.company_id = c.id WHERE i.token = ?', BY_TOKEN],
    ['UPDATE invitations SET signup_claimed_at = ? WHERE token = ? AND used_by IS NULL AND signup_claimed_at IS NULL AND expires_at > ? RETURNING id, company_id', BY_TOKEN],
  ],
  'adapters/sqlite/key-broker.ts': [
    ['SELECT company_id, id, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id FROM broker_keys ORDER BY rowid', 'operator command: re-wrapping every sealed key under a new KEK (no route reaches it; key-broker.md)'],
    ['DELETE FROM broker_usage WHERE day < ?', 'server-wide cleanup of old daily counters (no row is read); to become per company'],
    ['SELECT * FROM broker_tokens WHERE token_hash = ?', BY_TOKEN],
    ['DELETE FROM broker_tokens WHERE expires_at < ?', 'server-wide cleanup of expired tokens (no row is read); to become per company'],
  ],
  'db/index.ts': [
    ['DELETE FROM scope_rules WHERE company_id IS NULL AND scope_id NOT IN (SELECT id FROM scopes)', MIGRATION],
    ['UPDATE scope_rules SET company_id = (SELECT s.company_id FROM scopes s WHERE s.id = scope_rules.scope_id) WHERE company_id IS NULL', MIGRATION],
    ['DELETE FROM department_managers WHERE company_id IS NULL AND department_id NOT IN (SELECT id FROM departments)', MIGRATION],
    ['UPDATE department_managers SET company_id = (SELECT d.company_id FROM departments d WHERE d.id = department_managers.department_id) WHERE company_id IS NULL', MIGRATION],
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

/**
 * A bound company: `company_id = ?` or `company_id IN (…)`, also inside a
 * subquery (`scope_id = (SELECT id FROM scopes WHERE id = ? AND company_id = ?)`).
 * A join condition such as `i.company_id = c.id` binds nothing and does not count.
 * An INSERT names company_id (as a column, or in the SELECT it inserts from).
 */
function hasCompanyCondition(sql: string): boolean {
  if (/^(INSERT|REPLACE)\b/i.test(sql)) return /\bcompany_id\b/.test(sql)
  return /\bcompany_id\s*=\s*\?|\bcompany_id\s+IN\s*\(/i.test(sql)
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

  it('every table but the control plane has a company_id column', () => {
    for (const t of Object.keys(CONTROL_PLANE_TABLES)) expect(tables.has(t), `control-plane table ${t} is not in the schema`).toBe(true)
    const missing = [...companyTables].filter(t => !tables.get(t)!.has('company_id')).sort()
    expect(missing).toEqual([])
  })

  it('statements name only known tables', () => {
    for (const { file, sql } of allStatements) {
      for (const s of sql) {
        for (const t of tablesOf(s)) {
          expect(tables.has(t) || AUTH_TABLES.has(t) || SQLITE_CATALOG.has(t), `${file}: unknown table ${t} in ${s}`).toBe(true)
        }
      }
    }
  })

  it('table names chosen at run time only in the listed modules', () => {
    const found = allStatements.filter(f => f.sql.some(s => /\b(?:FROM|JOIN|INTO|UPDATE)\s+\$\{/i.test(s))).map(f => f.file).sort()
    expect(found).toEqual(Object.keys(DYNAMIC_TABLE_SQL).sort())
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

  it('a table behind the company handle is written only by its handle modules', () => {
    for (const { file, sql } of allStatements) {
      for (const s of sql) {
        const t = writtenTable(s)
        if (t && t in HANDLE_TABLES) expect(HANDLE_TABLES[t], `${file} writes ${t}: go through the company handle`).toContain(file)
      }
    }
  })

  it('handle repositories are built only by the handle source', () => {
    const testsDir = resolve(__dirname, '..')
    for (const file of [...tsFiles(SRC), ...tsFiles(testsDir)]) {
      const rel = relative(SRC, file)
      if (rel === HANDLE_SOURCE || file === __filename) continue
      const source = withoutComments(readFileSync(file, 'utf8'))
      for (const factory of HANDLE_FACTORIES) {
        const defines = new RegExp(`export function ${factory}\\b`).test(source)
        const uses = source.split(factory).length - 1
        expect(uses - (defines ? 1 : 0), `${rel} uses ${factory}: open a handle (forCompany) instead`).toBe(0)
      }
    }
  })
})
