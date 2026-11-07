import type Database from 'better-sqlite3'
import { compareScopePaths } from '../../../shared/core/permissions'
import type { GroupRepository, GroupRow, PermissionHistoryEntry, PermissionHistoryRepository } from '../../ports/groups'

/**
 * One company's groups (member_groups, member_group_members; ports/groups.ts).
 * Built only by the company handle (./company-data.ts); every statement names
 * the company.
 */
export function sqliteGroupRepository(conn: Database.Database, companyId: string): GroupRepository {
  const membersOf = (groupIds: string[]): Map<string, string[]> => {
    const byGroup = new Map<string, string[]>(groupIds.map(id => [id, []]))
    if (groupIds.length === 0) return byGroup
    const rows = conn.prepare(`
      SELECT group_id, user_id FROM member_group_members
      WHERE company_id = ? AND group_id IN (SELECT value FROM json_each(?))
      ORDER BY added_at, user_id
    `).all(companyId, JSON.stringify(groupIds)) as Array<{ group_id: string; user_id: string }>
    for (const r of rows) byGroup.get(r.group_id)?.push(r.user_id)
    return byGroup
  }
  const toRows = (rows: Array<{ id: string; name: string; created_at: string }>): GroupRow[] => {
    const members = membersOf(rows.map(r => r.id))
    return rows.map(r => ({ id: r.id, name: r.name, memberIds: members.get(r.id) ?? [], createdAt: r.created_at }))
  }

  return {
    list() {
      const rows = conn.prepare(`
        SELECT id, name, created_at FROM member_groups WHERE company_id = ? ORDER BY name, id
      `).all(companyId) as Array<{ id: string; name: string; created_at: string }>
      return toRows(rows)
    },
    find(groupId) {
      const row = conn.prepare(`
        SELECT id, name, created_at FROM member_groups WHERE company_id = ? AND id = ?
      `).get(companyId, groupId) as { id: string; name: string; created_at: string } | undefined
      return row ? toRows([row])[0] : null
    },
    nameTaken(nameKey, exceptId) {
      return conn.prepare(`
        SELECT 1 FROM member_groups WHERE company_id = ? AND name_key = ? AND id IS NOT ?
      `).get(companyId, nameKey, exceptId ?? null) !== undefined
    },
    create(group) {
      conn.prepare(`
        INSERT INTO member_groups (id, company_id, name, name_key, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
      `).run(group.id, companyId, group.name, group.nameKey, group.createdAt, group.createdBy)
    },
    rename(groupId, name, nameKey) {
      conn.prepare(`UPDATE member_groups SET name = ?, name_key = ? WHERE company_id = ? AND id = ?`).run(name, nameKey, companyId, groupId)
    },
    delete(groupId) {
      conn.transaction(() => {
        conn.prepare(`DELETE FROM member_group_members WHERE company_id = ? AND group_id = ?`).run(companyId, groupId)
        conn.prepare(`DELETE FROM member_groups WHERE company_id = ? AND id = ?`).run(companyId, groupId)
      })()
    },
    replaceMembers(groupId, userIds, addedBy, at) {
      conn.transaction(() => {
        const wanted = new Set(userIds)
        const current = conn.prepare(`
          SELECT user_id FROM member_group_members WHERE company_id = ? AND group_id = ?
        `).all(companyId, groupId) as Array<{ user_id: string }>
        for (const r of current) {
          if (!wanted.has(r.user_id)) {
            conn.prepare(`DELETE FROM member_group_members WHERE company_id = ? AND group_id = ? AND user_id = ?`).run(companyId, groupId, r.user_id)
          }
        }
        const have = new Set(current.map(r => r.user_id))
        for (const id of userIds) {
          if (have.has(id)) continue
          conn.prepare(`
            INSERT INTO member_group_members (company_id, group_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?, ?)
          `).run(companyId, groupId, id, at, addedBy)
        }
      })()
    },
    rulePaths(groupId) {
      const rows = conn.prepare(`
        SELECT DISTINCT s.path AS path FROM scope_rules r JOIN scopes s ON s.id = r.scope_id AND s.company_id = ?
        WHERE r.company_id = ? AND r.subject_type = 'group' AND r.subject_id = ?
      `).all(companyId, companyId, groupId) as Array<{ path: string }>
      return rows.map(r => r.path).sort(compareScopePaths)
    },
    forgetMember(userId) {
      conn.prepare(`DELETE FROM member_group_members WHERE company_id = ? AND user_id = ?`).run(companyId, userId)
    },
  }
}

/** One company's permission_history (append-only by trigger). */
export function sqlitePermissionHistoryRepository(conn: Database.Database, companyId: string): PermissionHistoryRepository {
  return {
    append(entry: PermissionHistoryEntry) {
      conn.prepare(`
        INSERT INTO permission_history (company_id, action, detail, at, by_user) VALUES (?, ?, ?, ?, ?)
      `).run(companyId, entry.action, JSON.stringify(entry.detail), entry.at, entry.byUser)
    },
    recent(limit) {
      const rows = conn.prepare(`
        SELECT seq, action, detail, at, by_user FROM permission_history WHERE company_id = ? ORDER BY seq DESC LIMIT ?
      `).all(companyId, limit) as Array<{ seq: number; action: PermissionHistoryEntry['action']; detail: string; at: string; by_user: string }>
      return rows.map(r => ({ seq: r.seq, action: r.action, detail: JSON.parse(r.detail) as Record<string, unknown>, at: r.at, byUser: r.by_user }))
    },
  }
}
