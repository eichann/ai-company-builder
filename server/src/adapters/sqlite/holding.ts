import type Database from 'better-sqlite3'
import type { HoldingTicket, HoldingTicketRepository } from '../../ports/holding'

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
  }
}
