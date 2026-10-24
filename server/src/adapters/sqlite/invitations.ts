import type Database from 'better-sqlite3'
import type { InvitationRepository, InvitationWithCompany } from '../../ports/invitations'
import { consumeInvitation } from '../../lib/invitation-signup'

export function sqliteInvitationRepository(conn: Database.Database): InvitationRepository {
  return {
    listByCompany(companyId) {
      return conn.prepare(`
        SELECT i.*, c.name as company_name
        FROM invitations i
        JOIN companies c ON i.company_id = c.id
        WHERE i.company_id = ?
        ORDER BY i.created_at DESC
      `).all(companyId) as InvitationWithCompany[]
    },

    findByToken(token) {
      return conn.prepare(`
        SELECT i.*, c.name as company_name
        FROM invitations i
        JOIN companies c ON i.company_id = c.id
        WHERE i.token = ?
      `).get(token) as InvitationWithCompany | undefined
    },

    existsInCompany(invitationId, companyId) {
      return !!conn.prepare(`
        SELECT id FROM invitations WHERE id = ? AND company_id = ?
      `).get(invitationId, companyId)
    },

    insert(inv) {
      conn.prepare(`
        INSERT INTO invitations (id, company_id, token, role, created_by, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(inv.id, inv.companyId, inv.token, inv.role, inv.createdBy, inv.expiresAt, inv.createdAt)
    },

    delete(invitationId) {
      conn.prepare('DELETE FROM invitations WHERE id = ?').run(invitationId)
    },

    // The sign-up side of single-use links lives in lib/invitation-signup.ts
    // (it runs before an account exists, from src/index.ts); the
    // compare-and-set is shared with it.
    consume(invitationId, userId) {
      return consumeInvitation(conn, invitationId, userId)
    },
  }
}
