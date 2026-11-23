import type Database from 'better-sqlite3'
import type { MembershipRepository, MembershipRow } from '../../ports/memberships'
import type { ReaderChangeGate } from '../../ports/holding'

/**
 * `gate` (the composition root's, lib/reader-change-gate.ts): a role change and a removal can
 * take private folders away, so they run only inside holdingTickets.track. Absent (operator
 * commands, unit tests building the adapter alone): not asked.
 */
export function sqliteMembershipRepository(conn: Database.Database, gate?: ReaderChangeGate): MembershipRepository {
  return {
    roleOf(companyId, userId) {
      const row = conn.prepare(`
        SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
      `).get(userId, companyId) as { role: string } | undefined
      return row ? row.role : null
    },

    joinedAt(companyId, userId) {
      const row = conn.prepare(`
        SELECT created_at FROM memberships WHERE user_id = ? AND company_id = ?
      `).get(userId, companyId) as { created_at: string } | undefined
      return row ? row.created_at : null
    },

    listByCompany(companyId) {
      return conn.prepare(`
        SELECT m.id, m.user_id, m.company_id, m.role, m.created_at
        FROM memberships m
        WHERE m.company_id = ?
        ORDER BY m.created_at ASC
      `).all(companyId) as MembershipRow[]
    },

    companyIdsOf(userId) {
      return (conn.prepare('SELECT company_id FROM memberships WHERE user_id = ?').all(userId) as Array<{ company_id: string }>).map(r => r.company_id)
    },

    countOwners(companyId) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'owner'`)
        .get(companyId) as { n: number }).n
    },

    insert(m) {
      conn.prepare(`
        INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(m.id, m.userId, m.companyId, m.role, m.createdAt, m.createdAt)
    },

    updateRole(companyId, userId, role, updatedAt) {
      gate?.assertWithin(companyId, 'memberships.updateRole')
      conn.prepare('UPDATE memberships SET role = ?, updated_at = ? WHERE user_id = ? AND company_id = ?')
        .run(role, updatedAt, userId, companyId)
    },

    delete(companyId, userId) {
      gate?.assertWithin(companyId, 'memberships.delete')
      conn.prepare(`
        DELETE FROM memberships WHERE user_id = ? AND company_id = ?
      `).run(userId, companyId)
    },
  }
}
