/**
 * A plugin screen's bridge (plan 4b B6, `.claude/rules/plugin-frame.md`). Part of
 * the one schema run by db/index.ts initDatabase (after every table exists).
 */
import type Database from 'better-sqlite3'

/**
 * record_ledger.via — the plugin screen a change came through (JSON `{ plugin,
 * version }`, shared/core/record-ledger.ts LedgerVia). Nullable and additive: an
 * older build keeps inserting without it.
 */
export function migrateRecordLedgerVia(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(record_ledger)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('via')) conn.exec('ALTER TABLE record_ledger ADD COLUMN via TEXT')
}
