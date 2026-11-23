import type Database from 'better-sqlite3'
import type {
  HoldingFile, HoldingFileKind, HoldingItem, HoldingItemRepository, HoldingItemState, HoldingTicket, HoldingTicketLookup,
  HoldingTicketRepository,
} from '../../ports/holding'

type Row = {
  id: string; user_id: string; scope_id: string; repo_id: string | null; folder_path: string
  cause: HoldingTicket['cause']; state: HoldingTicket['state']; created_at: string; updated_at: string
  expires_at: string; by_user: string; closed_at: string | null
}

const toTicket = (r: Row): HoldingTicket => ({
  id: r.id, userId: r.user_id, scopeId: r.scope_id, repoId: r.repo_id, folderPath: r.folder_path,
  cause: r.cause, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at,
  expiresAt: r.expires_at, byUser: r.by_user, closedAt: r.closed_at,
})

/** Holding tickets of one company (ports/holding.ts); built only by its handle (company-data.ts). */
export function sqliteHoldingTicketRepository(conn: Database.Database, companyId: string): HoldingTicketRepository {
  return {
    open(t) {
      return conn.transaction(() => {
        const existing = conn.prepare(
          `SELECT id FROM holding_tickets WHERE company_id = ? AND user_id = ? AND scope_id = ? AND state = 'open'`,
        ).get(companyId, t.userId, t.scopeId) as { id: string } | undefined
        if (existing) {
          conn.prepare(`
            UPDATE holding_tickets SET cause = ?, folder_path = ?, repo_id = ?, expires_at = ?, updated_at = ?, by_user = ?
            WHERE company_id = ? AND id = ?
          `).run(t.cause, t.folderPath, t.repoId, t.expiresAt, t.at, t.byUser, companyId, existing.id)
          return { ticketId: existing.id, extended: true }
        }
        conn.prepare(`
          INSERT INTO holding_tickets (id, company_id, user_id, scope_id, repo_id, folder_path, cause, state, created_at, updated_at, expires_at, by_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
        `).run(t.id, companyId, t.userId, t.scopeId, t.repoId, t.folderPath, t.cause, t.at, t.at, t.expiresAt, t.byUser)
        return { ticketId: t.id, extended: false }
      })()
    },

    cancelOpen(userId, scopeId, at) {
      return conn.prepare(`
        UPDATE holding_tickets SET state = 'cancelled', closed_at = ?, updated_at = ?
        WHERE company_id = ? AND user_id = ? AND scope_id = ? AND state = 'open'
      `).run(at, at, companyId, userId, scopeId).changes
    },

    expireDue(now) {
      return conn.prepare(`
        UPDATE holding_tickets SET state = 'expired', closed_at = ?, updated_at = ?
        WHERE company_id = ? AND state = 'open' AND expires_at <= ?
      `).run(now, now, companyId, now).changes
    },

    list() {
      return (conn.prepare(`SELECT * FROM holding_tickets WHERE company_id = ? ORDER BY created_at DESC, id`)
        .all(companyId) as Row[]).map(toTicket)
    },

    get(ticketId) {
      const r = conn.prepare(`SELECT * FROM holding_tickets WHERE company_id = ? AND id = ?`).get(companyId, ticketId) as Row | undefined
      return r ? toTicket(r) : null
    },

    ofUser(userId) {
      return (conn.prepare(`SELECT * FROM holding_tickets WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC, id`)
        .all(companyId, userId) as Row[]).map(toTicket)
    },
  }
}

/**
 * The control plane's lookup (ports/holding.ts `HoldingTicketLookup`): a member's tickets in
 * every company, by their own user id — the only thing that finds the company for a person who
 * may have left it. Everything after goes through that company's handle.
 */
export function sqliteHoldingTicketLookup(conn: Database.Database): HoldingTicketLookup {
  return {
    ofUser(userId) {
      return (conn.prepare(`SELECT id, company_id FROM holding_tickets WHERE user_id = ? ORDER BY created_at DESC, id`)
        .all(userId) as Array<{ id: string; company_id: string }>).map(r => ({ ticketId: r.id, companyId: r.company_id }))
    },
  }
}

type ItemRow = {
  id: string; ticket_id: string; user_id: string; device_key: string; scope_id: string; folder_path: string
  base_commit: string | null; state: HoldingItemState; total_bytes: number; created_at: string
  finished_at: string | null; blobs_deleted_at: string | null
}
type FileRow = {
  idx: number; path: string; kind: HoldingFileKind; size: number; sha256: string | null; label: string | null
  stored: number; dropped: HoldingFile['dropped']
}

const toItem = (r: ItemRow): HoldingItem => ({
  id: r.id, ticketId: r.ticket_id, userId: r.user_id, deviceKey: r.device_key, scopeId: r.scope_id,
  folderPath: r.folder_path, baseCommit: r.base_commit, state: r.state, totalBytes: r.total_bytes,
  createdAt: r.created_at, finishedAt: r.finished_at, blobsDeletedAt: r.blobs_deleted_at,
})
const toFile = (r: FileRow): HoldingFile => ({
  idx: r.idx, path: r.path, kind: r.kind, size: r.size, sha256: r.sha256, label: r.label, stored: r.stored === 1, dropped: r.dropped,
})

/** Holding items and their files of one company (ports/holding.ts); built only by its handle (company-data.ts). */
export function sqliteHoldingItemRepository(conn: Database.Database, companyId: string): HoldingItemRepository {
  const insertFiles = (itemId: string, files: HoldingFile[]) => {
    const insert = conn.prepare(`
      INSERT INTO holding_files (company_id, item_id, idx, path, kind, size, sha256, label, stored, dropped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const f of files) insert.run(companyId, itemId, f.idx, f.path, f.kind, f.size, f.sha256, f.label, f.stored ? 1 : 0, f.dropped)
  }
  const ids = (sql: string, ...args: unknown[]) => (conn.prepare(sql).all(...args) as Array<{ id: string }>).map(r => r.id)

  return {
    get(itemId) {
      const r = conn.prepare(`SELECT * FROM holding_items WHERE company_id = ? AND id = ?`).get(companyId, itemId) as ItemRow | undefined
      return r ? toItem(r) : null
    },

    forDevice(ticketId, deviceKey) {
      const r = conn.prepare(`SELECT * FROM holding_items WHERE company_id = ? AND ticket_id = ? AND device_key = ?`)
        .get(companyId, ticketId, deviceKey) as ItemRow | undefined
      return r ? toItem(r) : null
    },

    countForTicket(ticketId) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM holding_items WHERE company_id = ? AND ticket_id = ?`).get(companyId, ticketId) as { n: number }).n
    },

    heldBytes(exceptItemId) {
      return (conn.prepare(`
        SELECT COALESCE(SUM(total_bytes), 0) AS n FROM holding_items
        WHERE company_id = ? AND state IN ('receiving', 'waiting', 'taking') AND id != ?
      `).get(companyId, exceptItemId ?? '') as { n: number }).n
    },

    create(item, files) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO holding_items (id, company_id, ticket_id, user_id, device_key, scope_id, folder_path, base_commit, state, total_bytes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?, ?, ?)
        `).run(item.id, companyId, item.ticketId, item.userId, item.deviceKey, item.scopeId, item.folderPath, item.baseCommit, item.totalBytes, item.at, item.at)
        insertFiles(item.id, files)
      })()
    },

    replaceFiles(itemId, files, totalBytes, at) {
      return conn.transaction(() => {
        const changed = conn.prepare(`UPDATE holding_items SET total_bytes = ?, updated_at = ? WHERE company_id = ? AND id = ? AND state = 'receiving'`)
          .run(totalBytes, at, companyId, itemId).changes
        if (changed === 0) return false
        conn.prepare(`DELETE FROM holding_files WHERE company_id = ? AND item_id = ?`).run(companyId, itemId)
        insertFiles(itemId, files)
        return true
      })()
    },

    files(itemId) {
      return (conn.prepare(`SELECT * FROM holding_files WHERE company_id = ? AND item_id = ? ORDER BY idx`).all(companyId, itemId) as FileRow[]).map(toFile)
    },

    markStored(itemId, sha256, at) {
      return conn.transaction(() => {
        const changed = conn.prepare(`UPDATE holding_items SET updated_at = ? WHERE company_id = ? AND id = ? AND state = 'receiving'`).run(at, companyId, itemId).changes
        if (changed === 0) return false
        conn.prepare(`
          UPDATE holding_files SET stored = 1
          WHERE company_id = ? AND item_id = ? AND sha256 = ? AND kind IN ('changed', 'backup', 'personal')
        `).run(companyId, itemId, sha256)
        return true
      })()
    },

    dropContent(itemId, sha256, totalBytes, at) {
      conn.transaction(() => {
        conn.prepare(`
          UPDATE holding_files SET kind = 'names-only', dropped = 'secret', stored = 0
          WHERE company_id = ? AND item_id = ? AND sha256 = ?
        `).run(companyId, itemId, sha256)
        conn.prepare(`UPDATE holding_items SET total_bytes = ?, updated_at = ? WHERE company_id = ? AND id = ?`).run(totalBytes, at, companyId, itemId)
      })()
    },

    finish(itemId, at) {
      return conn.prepare(`
        UPDATE holding_items SET state = 'waiting', finished_at = ?, updated_at = ?
        WHERE company_id = ? AND id = ? AND state = 'receiving'
      `).run(at, at, companyId, itemId).changes > 0
    },

    expireWaiting(before, at) {
      return conn.transaction(() => {
        const due = ids(`SELECT id FROM holding_items WHERE company_id = ? AND state = 'waiting' AND finished_at <= ? ORDER BY finished_at, id`, companyId, before)
        const expire = conn.prepare(`UPDATE holding_items SET state = 'expired', decided_at = ?, updated_at = ? WHERE company_id = ? AND id = ? AND state = 'waiting'`)
        return due.filter(id => expire.run(at, at, companyId, id).changes > 0)
      })()
    },

    removeAbandoned(before) {
      return conn.transaction(() => {
        const due = ids(`SELECT id FROM holding_items WHERE company_id = ? AND state = 'receiving' AND created_at <= ? ORDER BY created_at, id`, companyId, before)
        for (const id of due) {
          conn.prepare(`DELETE FROM holding_files WHERE company_id = ? AND item_id = ?`).run(companyId, id)
          conn.prepare(`DELETE FROM holding_items WHERE company_id = ? AND id = ? AND state = 'receiving'`).run(companyId, id)
        }
        return due
      })()
    },

    holdingContents() {
      return ids(`SELECT id FROM holding_items WHERE company_id = ? AND state IN ('receiving', 'waiting', 'taking')`, companyId)
    },

    blobsToDelete() {
      return ids(`SELECT id FROM holding_items WHERE company_id = ? AND state IN ('taken', 'discarded', 'expired') AND blobs_deleted_at IS NULL`, companyId)
    },

    markBlobsDeleted(itemId, at) {
      conn.prepare(`UPDATE holding_items SET blobs_deleted_at = ?, updated_at = ? WHERE company_id = ? AND id = ?`).run(at, at, companyId, itemId)
    },

    erase(itemId, at) {
      return conn.transaction(() => {
        const changed = conn.prepare(`
          UPDATE holding_items SET state = CASE WHEN state IN ('receiving', 'waiting', 'taking') THEN 'discarded' ELSE state END,
            decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, 'operator'), total_bytes = 0, updated_at = ?
          WHERE company_id = ? AND id = ?
        `).run(at, at, companyId, itemId).changes
        if (changed === 0) return false
        conn.prepare(`DELETE FROM holding_files WHERE company_id = ? AND item_id = ?`).run(companyId, itemId)
        return true
      })()
    },
  }
}
