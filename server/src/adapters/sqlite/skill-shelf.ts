/**
 * SQLite storage of the Skill shelf (ports/skill-shelf.ts), limited to one company: every
 * statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import type { ShelfKind } from '../../../shared/core/skill-shelf'
import type {
  ShelfHistoryRow, ShelfItemRow, ShelfPut, ShelfRequestRow, ShelfStoredFile, ShelfVersionRow, ShelfWrite, SkillShelfRepository,
} from '../../ports/skill-shelf'
import type { ShelfRequestState } from '../../../shared/core/skill-shelf'

type ItemRow = {
  id: string; kind: ShelfKind; department_id: string | null; name: string; current_version: string | null
  created_at: string; created_by: string; changed_at: string; changed_by: string
  file_count: number | null; total_bytes: number | null
}
type VersionRow = { version: string; file_count: number; total_bytes: number; autorun: number; published_at: string; published_by: string }

type RequestRow = {
  id: string; department_id: string | null; name: string; requested_by: string; requested_at: string; version: string
  file_count: number; total_bytes: number; autorun: number; state: ShelfRequestState
  decided_by: string | null; decided_at: string | null; reason: string | null; published_version: string | null
}
const REQUEST_COLUMNS = `id, department_id, name, requested_by, requested_at, version, file_count, total_bytes, autorun, state,
  decided_by, decided_at, reason, published_version`
const request = (r: RequestRow): ShelfRequestRow => ({
  id: r.id, departmentId: r.department_id, name: r.name, requestedBy: r.requested_by, requestedAt: r.requested_at,
  version: r.version, fileCount: r.file_count, totalBytes: r.total_bytes, autorun: r.autorun === 1, state: r.state,
  decidedBy: r.decided_by, decidedAt: r.decided_at, reason: r.reason, publishedVersion: r.published_version,
})

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
  const makeCurrent = (itemId: string, v: string | null, action: ShelfHistoryRow['action'], at: string, by: string, requestedBy: string | null = null) => {
    conn.prepare('UPDATE shelf_items SET current_version = ?, changed_at = ?, changed_by = ? WHERE company_id = ? AND id = ?')
      .run(v, at, by, companyId, itemId)
    conn.prepare('INSERT INTO shelf_history (company_id, item_id, action, version, at, by_user, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, itemId, action, v, at, by, requestedBy)
  }
  const findRequest = (requestId: string): ShelfRequestRow | null => {
    const r = conn.prepare(`SELECT ${REQUEST_COLUMNS} FROM shelf_requests WHERE company_id = ? AND id = ?`).get(companyId, requestId) as RequestRow | undefined
    return r ? request(r) : null
  }
  /** Puts a version at its place and makes it current; call inside a transaction. */
  const putVersion = (input: ShelfPut): ShelfWrite => {
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
    makeCurrent(itemId, input.version, 'publish', input.at, input.by, input.requestedBy ?? null)
    return { ok: true, itemId, changed: true }
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
      return (conn.prepare(`SELECT action, version, at, by_user, requested_by FROM shelf_history WHERE company_id = ? AND item_id = ? ORDER BY seq DESC`)
        .all(companyId, itemId) as Array<{ action: ShelfHistoryRow['action']; version: string | null; at: string; by_user: string; requested_by: string | null }>)
        .map(r => ({ action: r.action, version: r.version, at: r.at, byUser: r.by_user, requestedBy: r.requested_by }))
    },
    put(input: ShelfPut): ShelfWrite {
      return conn.transaction((): ShelfWrite => {
        const from = input.fromRequest
        // Before anything is written: the request is still the one the approver looked at.
        if (from && !conn.prepare(`SELECT 1 FROM shelf_requests WHERE company_id = ? AND id = ? AND version = ? AND state = 'pending'`).get(companyId, from.id, from.version)) {
          return { ok: false, reason: 'request-changed' }
        }
        const written = putVersion(input)
        if (written.ok && from) {
          conn.prepare(`UPDATE shelf_requests SET state = 'published', decided_by = ?, decided_at = ?, reason = NULL, published_version = ?, files = NULL
              WHERE company_id = ? AND id = ? AND version = ? AND state = 'pending'`)
            .run(input.by, input.at, input.version, companyId, from.id, from.version)
        }
        return written
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
    requests(decidedLimit) {
      const pending = conn.prepare(`SELECT ${REQUEST_COLUMNS} FROM shelf_requests WHERE company_id = ? AND state = 'pending' ORDER BY requested_at DESC, id`)
        .all(companyId) as RequestRow[]
      const decided = conn.prepare(`SELECT ${REQUEST_COLUMNS} FROM shelf_requests WHERE company_id = ? AND state <> 'pending' ORDER BY decided_at DESC, id LIMIT ?`)
        .all(companyId, decidedLimit) as RequestRow[]
      return [...pending, ...decided].map(request)
    },
    requestsBy(userId) {
      return (conn.prepare(`SELECT ${REQUEST_COLUMNS} FROM shelf_requests WHERE company_id = ? AND requested_by = ? ORDER BY requested_at DESC, id`)
        .all(companyId, userId) as RequestRow[]).map(request)
    },
    request: findRequest,
    requestFiles(requestId) {
      const r = conn.prepare(`SELECT files FROM shelf_requests WHERE company_id = ? AND id = ? AND state = 'pending'`)
        .get(companyId, requestId) as { files: string | null } | undefined
      return r?.files ? (JSON.parse(r.files) as ShelfStoredFile[]) : null
    },
    putRequest(input) {
      return conn.transaction(() => {
        const earlier = conn.prepare(`SELECT id FROM shelf_requests WHERE company_id = ? AND requested_by = ? AND IFNULL(department_id, '') = ? AND name = ?`)
          .get(companyId, input.by, input.departmentId ?? '', input.name) as { id: string } | undefined
        const others = (where: string, ...args: unknown[]) => conn.prepare(
          `SELECT COUNT(*) AS n, IFNULL(SUM(total_bytes), 0) AS bytes FROM shelf_requests WHERE company_id = ? AND state = 'pending' AND id <> ?${where}`,
        ).get(companyId, earlier?.id ?? '', ...args) as { n: number; bytes: number }
        if (others(' AND requested_by = ?', input.by).n >= input.limits.pendingPerMember) return { ok: false as const, reason: 'member-limit' as const }
        // Requests of someone who left the company wait for nobody: not counted.
        const company = others(' AND requested_by IN (SELECT user_id FROM memberships WHERE company_id = ?)', companyId)
        if (company.n >= input.limits.pendingPerCompany || company.bytes + input.totalBytes > input.limits.pendingCompanyBytes) return { ok: false as const, reason: 'company-limit' as const }
        // Always a new id: a decision taken on what was looked at can never land on what replaced it.
        const id = input.newId
        if (earlier) conn.prepare('DELETE FROM shelf_requests WHERE company_id = ? AND id = ?').run(companyId, earlier.id)
        conn.prepare(`INSERT INTO shelf_requests (id, company_id, department_id, name, requested_by, requested_at, version, files, file_count, total_bytes, autorun, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(id, companyId, input.departmentId, input.name, input.by, input.at, input.version, JSON.stringify(input.files), input.fileCount, input.totalBytes, input.autorun ? 1 : 0)
        return { ok: true as const, id }
      })()
    },
    declineRequest(requestId, v, decision) {
      return conn.prepare(`UPDATE shelf_requests SET state = 'declined', decided_by = ?, decided_at = ?, reason = ?, published_version = NULL, files = NULL
          WHERE company_id = ? AND id = ? AND version = ? AND state = 'pending'`)
        .run(decision.by, decision.at, decision.reason, companyId, requestId, v).changes === 1
    },
  }
}
