import type Database from 'better-sqlite3'

/**
 * Rebuild one table whose CHECK must widen (SQLite cannot alter a CHECK), keeping every row and its rowid, when its stored
 * text lacks `marker`. The new table, its indexes and triggers are made from **the same statements a new database runs**
 * (`create`, `after`), so an upgraded database ends exactly like a new one. Its own triggers and indexes are dropped first
 * (`drop`: they go with the old table's name otherwise) — and so is another table's trigger that names it (SQLite would
 * point it at the renamed old table). One transaction; no foreign key points at the table. Foreign keys are off for the copy (`PRAGMA foreign_keys` cannot change inside a transaction): a row whose
 * parent is gone is kept as it was and counted in a log line afterwards (`foreign_key_check`, ids only), so startup never
 * fails on it. Answers whether it rebuilt. Idempotent.
 */
export function rebuildTableFor(conn: Database.Database, o: {
  table: string
  marker: string
  create: string
  after: readonly string[]
  drop: readonly string[]
  columns: readonly string[]
}): boolean {
  const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(o.table) as { sql: string } | undefined
  if (!row || row.sql.includes(o.marker)) return false
  const old = `${o.table}_before_rebuild`
  const cols = ['rowid', ...o.columns].join(', ')
  const keys = conn.pragma('foreign_keys', { simple: true }) === 1
  if (keys) conn.pragma('foreign_keys = OFF')
  try {
    conn.transaction(() => {
      for (const d of o.drop) conn.exec(d)
      conn.exec(`ALTER TABLE ${o.table} RENAME TO ${old}`)
      conn.exec(o.create)
      conn.exec(`INSERT INTO ${o.table} (${cols}) SELECT ${cols} FROM ${old}`)
      conn.exec(`DROP TABLE ${old}`)
      for (const a of o.after) conn.exec(a)
    })()
  } finally {
    if (keys) conn.pragma('foreign_keys = ON')
  }
  const orphans = (conn.pragma(`foreign_key_check(${o.table})`) as unknown[]).length
  console.log(`[db] ${o.table} rebuilt (${o.marker})`)
  if (orphans > 0) console.warn(`[db] ${o.table}: ${orphans} row(s) without their parent kept as they were`)
  return true
}
