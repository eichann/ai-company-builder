/**
 * One company's rows, out of and back into the application database: the
 * database half of the per-company export / restore (src/cli/company-archive.ts,
 * `.claude/rules/deployment.md` "One company: export and restore").
 *
 * Export is part of the company handle (`CompanyData.archive`): it reads every
 * table that has a company_id column, `WHERE company_id = ?`, plus the
 * company's own row in the registry. Nothing of another company can be in it.
 *
 * Restore is control plane — the company does not exist yet — and refuses an
 * archive with any row of another company, a table or column this database
 * does not have, or a company id that already exists. All rows go in one
 * transaction (foreign keys checked at the end), parents before children, so
 * the triggers that keep scope_rules / department_managers on their parent's
 * company see the parent first.
 *
 * Table names here are read from the schema, so the statements are built at
 * run time; tests/unit/company-scoped-sql.test.ts lists this module as the one
 * place allowed to do that.
 */
import type Database from 'better-sqlite3'
import type { ArchivedRows, CompanyRowsExport } from '../../ports/company-data'

type Conn = Database.Database

/** Tables with company rows that an archive leaves out, with the reason. */
export const ARCHIVE_EXCLUDED_TABLES: Record<string, string> = {
  broker_tokens: 'short-lived relay tokens (minutes): a restore must not bring any back',
}

/** Columns whose value is a bearer secret: replaced in the archive, with the reason. */
export const ARCHIVE_REDACTED_COLUMNS: Record<string, { column: string; reason: string }> = {
  invitations: { column: 'token', reason: 'an invitation link works for whoever holds it: after a restore, old links do not work (send new ones)' },
}

interface ColumnInfo { name: string; type: string; pk: number }

const columnsOf = (conn: Conn, table: string) => conn.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[]

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unexpected table or column name: ${name}`)
  return `"${name}"`
}

/**
 * The company tables (those with company_id, minus the excluded ones), parents
 * before children by their foreign keys; `companies` itself comes first.
 */
export function companyTables(conn: Conn): string[] {
  const names = (conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map(t => t.name)
    .filter(t => !(t in ARCHIVE_EXCLUDED_TABLES) && columnsOf(conn, t).some(c => c.name === 'company_id'))
  const parents = new Map(names.map(t => [t, new Set(
    (conn.prepare(`PRAGMA foreign_key_list(${quoteIdent(t)})`).all() as Array<{ table: string }>).map(f => f.table).filter(p => p !== t && names.includes(p)),
  )]))
  const ordered: string[] = []
  while (ordered.length < names.length) {
    const next = names.filter(t => !ordered.includes(t) && [...parents.get(t)!].every(p => ordered.includes(p)))
    // A cycle (none today): take the rest in name order; the foreign keys are checked at commit.
    ordered.push(...(next.length > 0 ? next : names.filter(t => !ordered.includes(t))))
  }
  return ['companies', ...ordered]
}

/** Blobs as { $base64 } so the rows survive JSON. */
function encode(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? { $base64: v.toString('base64') } : v]))
}

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && '$base64' in value && typeof (value as { $base64: unknown }).$base64 === 'string') {
    return Buffer.from((value as { $base64: string }).$base64, 'base64')
  }
  return value
}

/** One company's rows (the handle's `archive`, built only by ./company-data.ts). */
export function sqliteCompanyRowsExport(conn: Conn, companyId: string): CompanyRowsExport {
  return {
    exportRows(): ArchivedRows {
      return conn.transaction(() => {
        const out: ArchivedRows = {}
        for (const table of companyTables(conn)) {
          const rows = table === 'companies'
            ? conn.prepare(`SELECT * FROM companies WHERE id = ?`).all(companyId) as Array<Record<string, unknown>>
            : conn.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE company_id = ? ORDER BY rowid`).all(companyId) as Array<Record<string, unknown>>
          const redact = ARCHIVE_REDACTED_COLUMNS[table]
          out[table] = rows.map(row => encode(redact ? { ...row, [redact.column]: `redacted:${String(row.id)}` } : row))
        }
        return out
      })()
    },
  }
}

export type RestoreRefusal = { ok: false; reason: string }

/**
 * Put one company's archived rows into this database (control plane: the
 * company does not exist here yet). Returns the rows written per table, or why
 * nothing was written.
 */
export function restoreCompanyRows(conn: Conn, companyId: string, tables: ArchivedRows): { ok: true; counts: Record<string, number> } | RestoreRefusal {
  const known = new Set(companyTables(conn))
  for (const [table, rows] of Object.entries(tables)) {
    if (!known.has(table)) return { ok: false, reason: `this database has no company table "${table}" (a newer or older schema?)` }
    const columns = new Set(columnsOf(conn, table).map(c => c.name))
    for (const row of rows) {
      const unknown = Object.keys(row).filter(k => !columns.has(k))
      if (unknown.length > 0) return { ok: false, reason: `table "${table}" has no column ${unknown.join(', ')} here` }
      const owner = table === 'companies' ? row.id : row.company_id
      if (owner !== companyId) return { ok: false, reason: `a row of "${table}" belongs to another company` }
    }
  }
  if ((tables.companies ?? []).length !== 1) return { ok: false, reason: 'the archive has no company row' }
  if (conn.prepare(`SELECT 1 FROM companies WHERE id = ?`).get(companyId)) {
    return { ok: false, reason: 'this company already exists in this database' }
  }

  const counts: Record<string, number> = {}
  conn.transaction(() => {
    conn.pragma('defer_foreign_keys = ON')
    for (const table of companyTables(conn)) {
      const rows = tables[table] ?? []
      // An INTEGER PRIMARY KEY (agent_events.seq) is the rowid: let this database number the rows,
      // in the archived order, so they cannot collide with another company's here.
      const info = columnsOf(conn, table)
      const rowidAlias = info.filter(c => c.pk > 0).length === 1 ? info.find(c => c.pk === 1 && c.type.toUpperCase() === 'INTEGER')?.name : undefined
      for (const row of rows) {
        const cols = Object.keys(row).filter(c => c !== rowidAlias)
        conn.prepare(`INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map(c => decode(row[c])))
      }
      counts[table] = rows.length
    }
    const broken = conn.prepare(`PRAGMA foreign_key_check`).all()
    if (broken.length > 0) throw new Error(`restored rows break ${broken.length} foreign key(s); nothing was written`)
  })()
  return { ok: true, counts }
}
