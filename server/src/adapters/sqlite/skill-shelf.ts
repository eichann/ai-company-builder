/**
 * SQLite storage of the Skill shelf (ports/skill-shelf.ts), limited to one company: every
 * statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import type { ShelfKind } from '../../../shared/core/skill-shelf'
import type {
  ShelfHistoryRow, ShelfItemRow, ShelfPut, ShelfStoredFile, ShelfVersionRow, ShelfWrite, SkillShelfRepository,
} from '../../ports/skill-shelf'

type ItemRow = {
  id: string; kind: ShelfKind; department_id: string | null; name: string; current_version: string | null
  created_at: string; created_by: string; changed_at: string; changed_by: string
  file_count: number | null; total_bytes: number | null
}
type VersionRow = { version: string; file_count: number; total_bytes: number; autorun: number; published_at: string; published_by: string }

const ITEM_COLUMNS = `i.id, i.kind, i.department_id, i.name, i.current_version, i.created_at, i.created_by, i.changed_at, i.changed_by,
  v.file_count, v.total_bytes`

const item = (r: ItemRow): ShelfItemRow => ({
  id: r.id, kind: r.kind, departmentId: r.department_id, name: r.name, currentVersion: r.current_version,
  createdAt: r.created_at, createdBy: r.created_by, changedAt: r.changed_at, changedBy: r.changed_by,
  fileCount: r.file_count ?? 0, totalBytes: r.total_bytes ?? 0,
})
const version = (r: VersionRow): ShelfVersionRow => ({
  version: r.version, fileCount: r.file_count, totalBytes: r.total_bytes, autorun: r.autorun === 1,
  publishedAt: r.published_at, publishedBy: r.published_by,
})

export function sqliteSkillShelfRepository(conn: Database.Database, companyId: string): SkillShelfRepository {
  const findItem = (itemId: string): ShelfItemRow | null => {
    const r = conn.prepare(`SELECT ${ITEM_COLUMNS} FROM shelf_items i LEFT JOIN shelf_versions v ON v.company_id = i.company_id AND v.item_id = i.id AND v.version = i.current_version WHERE i.company_id = ? AND i.id = ?`).get(companyId, itemId) as ItemRow | undefined
    return r ? item(r) : null
  }
  const findAt = (kind: ShelfKind, departmentId: string | null, name: string): ShelfItemRow | null => {
    const r = conn.prepare(`SELECT ${ITEM_COLUMNS} FROM shelf_items i LEFT JOIN shelf_versions v ON v.company_id = i.company_id AND v.item_id = i.id AND v.version = i.current_version
        WHERE i.company_id = ? AND i.kind = ? AND IFNULL(i.department_id, '') = ? AND i.name = ?`)
      .get(companyId, kind, departmentId ?? '', name) as ItemRow | undefined
    return r ? item(r) : null
  }
  const hasVersion = (itemId: string, v: string) =>
    !!conn.prepare('SELECT 1 FROM shelf_versions WHERE company_id = ? AND item_id = ? AND version = ?').get(companyId, itemId, v)
  const makeCurrent = (itemId: string, v: string | null, action: ShelfHistoryRow['action'], at: string, by: string) => {
    conn.prepare('UPDATE shelf_items SET current_version = ?, changed_at = ?, changed_by = ? WHERE company_id = ? AND id = ?')
      .run(v, at, by, companyId, itemId)
    conn.prepare('INSERT INTO shelf_history (company_id, item_id, action, version, at, by_user) VALUES (?, ?, ?, ?, ?, ?)')
      .run(companyId, itemId, action, v, at, by)
  }

  return {
    items() {
      return (conn.prepare(`SELECT ${ITEM_COLUMNS} FROM shelf_items i LEFT JOIN shelf_versions v ON v.company_id = i.company_id AND v.item_id = i.id AND v.version = i.current_version WHERE i.company_id = ? ORDER BY i.kind, i.name, i.created_at, i.id`)
        .all(companyId) as ItemRow[]).map(item)
    },
    item: findItem,
    itemAt: findAt,
    versions(itemId) {
      return (conn.prepare(`SELECT version, file_count, total_bytes, autorun, published_at, published_by FROM shelf_versions
          WHERE company_id = ? AND item_id = ? ORDER BY published_at DESC, rowid DESC`).all(companyId, itemId) as VersionRow[]).map(version)
    },
    version(itemId, v) {
      const r = conn.prepare(`SELECT version, file_count, total_bytes, autorun, published_at, published_by FROM shelf_versions
          WHERE company_id = ? AND item_id = ? AND version = ?`).get(companyId, itemId, v) as VersionRow | undefined
      return r ? version(r) : null
    },
    versionFiles(itemId, v) {
      const r = conn.prepare('SELECT files FROM shelf_versions WHERE company_id = ? AND item_id = ? AND version = ?')
        .get(companyId, itemId, v) as { files: string } | undefined
      return r ? (JSON.parse(r.files) as ShelfStoredFile[]) : null
    },
    history(itemId) {
      return (conn.prepare(`SELECT action, version, at, by_user FROM shelf_history WHERE company_id = ? AND item_id = ? ORDER BY seq DESC`)
        .all(companyId, itemId) as Array<{ action: ShelfHistoryRow['action']; version: string | null; at: string; by_user: string }>)
        .map(r => ({ action: r.action, version: r.version, at: r.at, byUser: r.by_user }))
    },
    put(input: ShelfPut): ShelfWrite {
      return conn.transaction((): ShelfWrite => {
        const existing = findAt(input.kind, input.departmentId, input.name)
        const current = existing?.currentVersion ?? null
        if (current !== input.expected) return { ok: false, reason: 'conflict', currentVersion: current }
        if (existing && current === input.version) return { ok: true, itemId: existing.id, changed: false }
        const stored = existing ? hasVersion(existing.id, input.version) : false
        // In the same transaction as the write: two publishes at once cannot both pass the limit.
        if (!stored) {
          const { n } = conn.prepare('SELECT IFNULL(SUM(total_bytes), 0) AS n FROM shelf_versions WHERE company_id = ?').get(companyId) as { n: number }
          if (n + input.totalBytes > input.companyLimitBytes) return { ok: false, reason: 'full' }
        }
        let itemId = existing?.id
        if (!itemId) {
          itemId = input.newItemId
          conn.prepare(`INSERT INTO shelf_items (id, company_id, kind, department_id, name, current_version, created_at, created_by, changed_at, changed_by)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
            .run(itemId, companyId, input.kind, input.departmentId, input.name, input.at, input.by, input.at, input.by)
        }
        if (!stored) {
          conn.prepare(`INSERT INTO shelf_versions (company_id, item_id, version, files, file_count, total_bytes, autorun, published_at, published_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(companyId, itemId, input.version, JSON.stringify(input.files), input.fileCount, input.totalBytes, input.autorun ? 1 : 0, input.at, input.by)
        }
        makeCurrent(itemId, input.version, 'publish', input.at, input.by)
        return { ok: true, itemId, changed: true }
      })()
    },
    setCurrent(itemId, expected, v, at, by): ShelfWrite {
      return conn.transaction((): ShelfWrite => {
        const existing = findItem(itemId)
        if (!existing) return { ok: false, reason: 'not-found' }
        if (existing.currentVersion !== expected) return { ok: false, reason: 'conflict', currentVersion: existing.currentVersion }
        if (existing.currentVersion === v) return { ok: true, itemId, changed: false }
        makeCurrent(itemId, v, v === null ? 'unpublish' : 'restore', at, by)
        return { ok: true, itemId, changed: true }
      })()
    },
    countInDepartment(departmentId) {
      return (conn.prepare('SELECT COUNT(*) AS n FROM shelf_items WHERE company_id = ? AND department_id = ?').get(companyId, departmentId) as { n: number }).n
    },
    removeVersion(itemId, v, at, by) {
      return conn.transaction((): 'removed' | 'not-found' | 'current' => {
        const existing = findItem(itemId)
        if (!existing || !hasVersion(itemId, v)) return 'not-found'
        if (existing.currentVersion === v) return 'current'
        conn.prepare('DELETE FROM shelf_versions WHERE company_id = ? AND item_id = ? AND version = ?').run(companyId, itemId, v)
        conn.prepare('INSERT INTO shelf_history (company_id, item_id, action, version, at, by_user) VALUES (?, ?, ?, ?, ?, ?)')
          .run(companyId, itemId, 'remove-version', v, at, by)
        return 'removed'
      })()
    },
    removeItem(itemId) {
      return conn.transaction((): 'removed' | 'not-found' | 'published' => {
        const existing = findItem(itemId)
        if (!existing) return 'not-found'
        if (existing.currentVersion !== null) return 'published'
        conn.prepare('DELETE FROM shelf_history WHERE company_id = ? AND item_id = ?').run(companyId, itemId)
        conn.prepare('DELETE FROM shelf_versions WHERE company_id = ? AND item_id = ?').run(companyId, itemId)
        conn.prepare('DELETE FROM shelf_items WHERE company_id = ? AND id = ?').run(companyId, itemId)
        return 'removed'
      })()
    },
  }
}
