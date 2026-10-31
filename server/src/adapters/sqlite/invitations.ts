import type Database from 'better-sqlite3'
import type { InvitationRepository, InvitationWithCompany } from '../../ports/invitations'

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

    acceptedBy(companyId, userId) {
      return !!conn.prepare(`
        SELECT 1 FROM invitations WHERE company_id = ? AND used_by = ? LIMIT 1
      `).get(companyId, userId)
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

    // Single-use links (services/invitations.ts): a sign-up claims the link
    // before the account exists; accepting is a compare-and-set that a link
    // claimed by another account's sign-up refuses.
    consume(invitationId, userId) {
      const now = new Date()
      return conn.prepare(`
        UPDATE invitations SET used_by = ?, used_at = ?
        WHERE id = ? AND used_by IS NULL AND (signup_user_id IS NULL OR signup_user_id = ?)
      `).run(userId, now.toISOString(), invitationId, userId).changes === 1
    },

    claimForSignup(token) {
      const now = new Date()
      const row = conn.prepare(`
        UPDATE invitations SET signup_claimed_at = ?
        WHERE token = ? AND used_by IS NULL AND signup_claimed_at IS NULL AND expires_at > ?
        RETURNING id
      `).get(now.toISOString(), token, now.toISOString()) as { id: string } | undefined
      return row?.id ?? null
    },

    releaseSignupClaim(invitationId) {
      conn.prepare(`UPDATE invitations SET signup_claimed_at = NULL, signup_user_id = NULL WHERE id = ? AND used_by IS NULL`).run(invitationId)
    },

    recordSignupUser(invitationId, userId) {
      conn.prepare(`UPDATE invitations SET signup_user_id = ? WHERE id = ?`).run(userId, invitationId)
    },
  }
}
