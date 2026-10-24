import type Database from 'better-sqlite3'
import type { MembershipRepository, MembershipRow } from '../../ports/memberships'

export function sqliteMembershipRepository(conn: Database.Database): MembershipRepository {
  return {
    roleOf(companyId, userId) {
      const row = conn.prepare(`
        SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
      `).get(userId, companyId) as { role: string } | undefined
      return row ? row.role : null
    },

    listByCompany(companyId) {
      return conn.prepare(`
        SELECT m.id, m.user_id, m.company_id, m.role, m.created_at
        FROM memberships m
        WHERE m.company_id = ?
        ORDER BY m.created_at ASC
      `).all(companyId) as MembershipRow[]
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
      conn.prepare('UPDATE memberships SET role = ?, updated_at = ? WHERE user_id = ? AND company_id = ?')
        .run(role, updatedAt, userId, companyId)
    },

    delete(companyId, userId) {
      conn.prepare(`
        DELETE FROM memberships WHERE user_id = ? AND company_id = ?
      `).run(userId, companyId)
    },
  }
}
