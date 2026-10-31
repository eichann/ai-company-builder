import type Database from 'better-sqlite3'
import type { InvitationRepository, InvitationTokenLookup, InvitationWithCompany } from '../../ports/invitations'

/**
 * One company's invitations, reached only through its handle
 * (adapters/sqlite/company-data.ts): every statement carries `company_id = ?`.
 */
export function sqliteInvitationRepository(conn: Database.Database, companyId: string): InvitationRepository {
  return {
    list() {
      return conn.prepare(`
        SELECT i.*, c.name as company_name
        FROM invitations i
        JOIN companies c ON i.company_id = c.id
        WHERE i.company_id = ?
        ORDER BY i.created_at DESC
      `).all(companyId) as InvitationWithCompany[]
    },

    exists(invitationId) {
      return !!conn.prepare(`
        SELECT id FROM invitations WHERE id = ? AND company_id = ?
      `).get(invitationId, companyId)
    },

    acceptedBy(userId) {
      return !!conn.prepare(`
        SELECT 1 FROM invitations WHERE company_id = ? AND used_by = ? LIMIT 1
      `).get(companyId, userId)
    },

    insert(inv) {
      conn.prepare(`
        INSERT INTO invitations (id, company_id, token, role, created_by, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(inv.id, companyId, inv.token, inv.role, inv.createdBy, inv.expiresAt, inv.createdAt)
    },

    delete(invitationId) {
      conn.prepare('DELETE FROM invitations WHERE id = ? AND company_id = ?').run(invitationId, companyId)
    },

    // Single-use links (services/invitations.ts): a sign-up claims the link
    // before the account exists; accepting is a compare-and-set that a link
    // claimed by another account's sign-up refuses.
    consume(invitationId, userId) {
      const now = new Date()
      return conn.prepare(`
        UPDATE invitations SET used_by = ?, used_at = ?
        WHERE id = ? AND company_id = ? AND used_by IS NULL AND (signup_user_id IS NULL OR signup_user_id = ?)
      `).run(userId, now.toISOString(), invitationId, companyId, userId).changes === 1
    },

    releaseSignupClaim(invitationId) {
      conn.prepare(`UPDATE invitations SET signup_claimed_at = NULL, signup_user_id = NULL WHERE id = ? AND company_id = ? AND used_by IS NULL`).run(invitationId, companyId)
    },

    recordSignupUser(invitationId, userId) {
      conn.prepare(`UPDATE invitations SET signup_user_id = ? WHERE id = ? AND company_id = ?`).run(userId, invitationId, companyId)
    },
  }
}

/** Invitation links by token: the control plane that finds the company (ports/invitations.ts). */
export function sqliteInvitationTokens(conn: Database.Database): InvitationTokenLookup {
  return {
    findByToken(token) {
      return conn.prepare(`
        SELECT i.*, c.name as company_name
        FROM invitations i
        JOIN companies c ON i.company_id = c.id
        WHERE i.token = ?
      `).get(token) as InvitationWithCompany | undefined
    },

    claimForSignup(token) {
      const now = new Date()
      const row = conn.prepare(`
        UPDATE invitations SET signup_claimed_at = ?
        WHERE token = ? AND used_by IS NULL AND signup_claimed_at IS NULL AND expires_at > ?
        RETURNING id, company_id
      `).get(now.toISOString(), token, now.toISOString()) as { id: string; company_id: string } | undefined
      return row ? { id: row.id, companyId: row.company_id } : null
    },
  }
}
