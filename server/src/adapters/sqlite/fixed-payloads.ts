/**
 * SQLite storage of fixed content (ports/fixed-payloads.ts), bound to one
 * company — built only by the company handle (adapters/sqlite/company-data.ts),
 * every statement limited to `companyId`. The trigger of db/index.ts
 * (migrateFixedPayloads) refuses any rewrite except clearing the text.
 */
import type Database from 'better-sqlite3'
import type { FixedPayloadOwnerKind, FixedPayloadRepository, FixedPayloadRow } from '../../ports/fixed-payloads'

type Row = { owner_kind: FixedPayloadOwnerKind; owner_id: string; version: number; canonical: string | null; hash: string; created_at: string; body_deleted_at: string | null }
const toRow = (r: Row): FixedPayloadRow => ({
  ownerKind: r.owner_kind, ownerId: r.owner_id, version: r.version, canonical: r.canonical, hash: r.hash, createdAt: r.created_at, bodyDeletedAt: r.body_deleted_at,
})
const COLUMNS = 'owner_kind, owner_id, version, canonical, hash, created_at, body_deleted_at'

export function sqliteFixedPayloadRepository(conn: Database.Database, companyId: string): FixedPayloadRepository {
  return {
    insert(row) {
      const r = conn.prepare(
        'INSERT OR IGNORE INTO fixed_payloads (company_id, owner_kind, owner_id, version, canonical, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(companyId, row.ownerKind, row.ownerId, row.version, row.canonical, row.hash, row.createdAt)
      return r.changes === 1
    },
    latest(ownerKind, ownerId) {
      const r = conn.prepare(
        `SELECT ${COLUMNS} FROM fixed_payloads WHERE company_id = ? AND owner_kind = ? AND owner_id = ? ORDER BY version DESC LIMIT 1`,
      ).get(companyId, ownerKind, ownerId) as Row | undefined
      return r ? toRow(r) : null
    },
    latestOf(ownerKind, ownerIds) {
      if (ownerIds.length === 0) return []
      const rows = conn.prepare(
        `SELECT ${COLUMNS} FROM fixed_payloads f WHERE company_id = ? AND owner_kind = ? AND owner_id IN (SELECT value FROM json_each(?))
           AND version = (SELECT MAX(version) FROM fixed_payloads g WHERE g.company_id = ? AND g.owner_kind = f.owner_kind AND g.owner_id = f.owner_id)`,
      ).all(companyId, ownerKind, JSON.stringify(ownerIds), companyId) as Row[]
      return rows.map(toRow)
    },
    clearBodies(ownerKind, ownerIds, at) {
      if (ownerIds.length === 0) return 0
      return conn.prepare(
        'UPDATE fixed_payloads SET canonical = NULL, body_deleted_at = ? WHERE company_id = ? AND owner_kind = ? AND owner_id IN (SELECT value FROM json_each(?)) AND canonical IS NOT NULL',
      ).run(at, companyId, ownerKind, JSON.stringify(ownerIds)).changes
    },
  }
}
