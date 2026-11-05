/**
 * SQLite storage of business roles (役割, ports/plugin-roles.ts), limited to
 * one company: every statement binds `company_id = ?`. A change and its
 * history line are written in one transaction.
 */
import type Database from 'better-sqlite3'
import type { PluginRoleHistoryRow, PluginRoleRepository } from '../../ports/plugin-roles'

const ids = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function sqlitePluginRoleRepository(conn: Database.Database, companyId: string): PluginRoleRepository {
  const historyLine = (pluginId: string, role: string, bundleId: string | null, action: PluginRoleHistoryRow['action'], userIds: string[], at: string, by: string) =>
    conn.prepare('INSERT INTO plugin_role_history (company_id, plugin_id, role, bundle_id, action, user_ids, at, by_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, pluginId, role, bundleId, action, JSON.stringify(userIds), at, by)

  return {
    assignment(pluginId, role) {
      const r = conn.prepare('SELECT user_ids FROM plugin_role_assignments WHERE company_id = ? AND plugin_id = ? AND role = ?')
        .get(companyId, pluginId, role) as { user_ids: string } | undefined
      return r ? ids(r.user_ids) : null
    },
    assignments(pluginId) {
      const rows = conn.prepare('SELECT role, user_ids FROM plugin_role_assignments WHERE company_id = ? AND plugin_id = ? ORDER BY role')
        .all(companyId, pluginId) as Array<{ role: string; user_ids: string }>
      return Object.fromEntries(rows.map(r => [r.role, ids(r.user_ids)]))
    },
    override(pluginId, role, bundleId) {
      const r = conn.prepare('SELECT user_ids FROM plugin_role_overrides WHERE company_id = ? AND plugin_id = ? AND role = ? AND bundle_id = ?')
        .get(companyId, pluginId, role, bundleId) as { user_ids: string } | undefined
      return r ? ids(r.user_ids) : null
    },
    overrides(pluginId) {
      const rows = conn.prepare('SELECT role, bundle_id, user_ids FROM plugin_role_overrides WHERE company_id = ? AND plugin_id = ? ORDER BY role, bundle_id')
        .all(companyId, pluginId) as Array<{ role: string; bundle_id: string; user_ids: string }>
      return rows.map(r => ({ role: r.role, bundleId: r.bundle_id, userIds: ids(r.user_ids) }))
    },
    assign(pluginId, role, userIds, at, by) {
      conn.transaction(() => {
        conn.prepare(`INSERT INTO plugin_role_assignments (company_id, plugin_id, role, user_ids, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, plugin_id, role) DO UPDATE SET user_ids = excluded.user_ids, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(companyId, pluginId, role, JSON.stringify(userIds), at, by)
        historyLine(pluginId, role, null, 'assign', userIds, at, by)
      })()
    },
    setOverride(pluginId, role, bundleId, userIds, at, by) {
      conn.transaction(() => {
        if (userIds === null) {
          conn.prepare('DELETE FROM plugin_role_overrides WHERE company_id = ? AND plugin_id = ? AND role = ? AND bundle_id = ?').run(companyId, pluginId, role, bundleId)
          historyLine(pluginId, role, bundleId, 'clear-override', [], at, by)
          return
        }
        conn.prepare(`INSERT INTO plugin_role_overrides (company_id, plugin_id, role, bundle_id, user_ids, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, plugin_id, role, bundle_id) DO UPDATE SET user_ids = excluded.user_ids, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(companyId, pluginId, role, bundleId, JSON.stringify(userIds), at, by)
        historyLine(pluginId, role, bundleId, 'override', userIds, at, by)
      })()
    },
    forgetMember(userId, at, by) {
      conn.transaction(() => {
        const assigned = conn.prepare('SELECT plugin_id, role, user_ids FROM plugin_role_assignments WHERE company_id = ?').all(companyId) as Array<{ plugin_id: string; role: string; user_ids: string }>
        for (const r of assigned) {
          const held = ids(r.user_ids)
          if (held.includes(userId)) this.assign(r.plugin_id, r.role, held.filter(u => u !== userId), at, by)
        }
        const overridden = conn.prepare('SELECT plugin_id, role, bundle_id, user_ids FROM plugin_role_overrides WHERE company_id = ?').all(companyId) as Array<{ plugin_id: string; role: string; bundle_id: string; user_ids: string }>
        for (const r of overridden) {
          const held = ids(r.user_ids)
          if (held.includes(userId)) this.setOverride(r.plugin_id, r.role, r.bundle_id, held.filter(u => u !== userId), at, by)
        }
      })()
    },
    history(pluginId, limit) {
      const rows = conn.prepare(`SELECT plugin_id, role, bundle_id, action, user_ids, at, by_user FROM plugin_role_history
          WHERE company_id = ? AND plugin_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(companyId, pluginId, limit) as Array<{ plugin_id: string; role: string; bundle_id: string | null; action: string; user_ids: string; at: string; by_user: string }>
      return rows.map(r => ({
        pluginId: r.plugin_id, role: r.role, bundleId: r.bundle_id, action: r.action as PluginRoleHistoryRow['action'],
        userIds: ids(r.user_ids), at: r.at, by: r.by_user,
      }))
    },
  }
}
