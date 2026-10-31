/**
 * SQLite storage of a company's connector plugins (ports/plugins.ts): its
 * installs, mapping versions and history, bound to one company — built only
 * by the company handle (adapters/sqlite/company-data.ts), every statement
 * limited to `companyId`. The triggers of db/index.ts (migratePluginTables)
 * refuse a mapping under another company's install and a key of another
 * company.
 */
import type Database from 'better-sqlite3'
import type { PluginHistoryRow, PluginInstallRow, PluginMappingRow, PluginRepository } from '../../ports/plugins'

type InstallRow = {
  plugin_id: string; version: string; fingerprint: string; service: string; connection_id: string; account_id: string | null
  enabled: number; managed_since: string | null; key_id: string | null
  mapping_version: number; updated_at: string; updated_by: string
}
const toInstall = (r: InstallRow): PluginInstallRow => ({
  pluginId: r.plugin_id, version: r.version, fingerprint: r.fingerprint, service: r.service, connectionId: r.connection_id,
  accountId: r.account_id, enabled: r.enabled === 1, managedSince: r.managed_since, keyId: r.key_id,
  mappingVersion: r.mapping_version, updatedAt: r.updated_at, updatedBy: r.updated_by,
})
const INSTALL_COLUMNS = 'plugin_id, version, fingerprint, service, connection_id, account_id, enabled, managed_since, key_id, mapping_version, updated_at, updated_by'
type HistoryRow = { id: string; plugin_id: string; action: string; at: string; by_user: string; change: string }
const toHistory = (r: HistoryRow): PluginHistoryRow => ({ id: r.id, pluginId: r.plugin_id, action: r.action, at: r.at, by: r.by_user, change: r.change })

export function sqlitePluginRepository(conn: Database.Database, companyId: string): PluginRepository {
  const addHistory = (h: PluginHistoryRow) => conn.prepare(
    'INSERT INTO plugin_history (id, company_id, plugin_id, action, at, by_user, change) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(h.id, companyId, h.pluginId, h.action, h.at, h.by, h.change)

  return {
    install(pluginId) {
      const r = conn.prepare(`SELECT ${INSTALL_COLUMNS} FROM plugin_installs WHERE company_id = ? AND plugin_id = ?`).get(companyId, pluginId) as InstallRow | undefined
      return r ? toInstall(r) : null
    },
    installs() {
      return (conn.prepare(`SELECT ${INSTALL_COLUMNS} FROM plugin_installs WHERE company_id = ? ORDER BY plugin_id`).all(companyId) as InstallRow[]).map(toInstall)
    },
    saveInstall(row, history) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO plugin_installs (company_id, plugin_id, version, fingerprint, service, connection_id, account_id, enabled, managed_since,
            key_id, mapping_version, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, plugin_id) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint,
            service = excluded.service, connection_id = excluded.connection_id, account_id = excluded.account_id,
            enabled = excluded.enabled, managed_since = COALESCE(plugin_installs.managed_since, excluded.managed_since),
            key_id = excluded.key_id, mapping_version = excluded.mapping_version,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, row.pluginId, row.version, row.fingerprint, row.service, row.connectionId, row.accountId, row.enabled ? 1 : 0,
          row.managedSince, row.keyId, row.mappingVersion, row.updatedAt, row.updatedBy)
        addHistory(history)
      })()
    },
    mapping(pluginId, version) {
      const r = conn.prepare('SELECT plugin_id, version, text, created_at, created_by FROM plugin_mappings WHERE company_id = ? AND plugin_id = ? AND version = ?')
        .get(companyId, pluginId, version) as { plugin_id: string; version: number; text: string; created_at: string; created_by: string } | undefined
      return r ? { pluginId: r.plugin_id, version: r.version, text: r.text, createdAt: r.created_at, createdBy: r.created_by } : null
    },
    mappingVersions(pluginId) {
      return (conn.prepare('SELECT plugin_id, version, created_at, created_by FROM plugin_mappings WHERE company_id = ? AND plugin_id = ? ORDER BY version DESC')
        .all(companyId, pluginId) as Array<{ plugin_id: string; version: number; created_at: string; created_by: string }>)
        .map(r => ({ pluginId: r.plugin_id, version: r.version, createdAt: r.created_at, createdBy: r.created_by }))
    },
    addMapping(row: PluginMappingRow, history) {
      conn.transaction(() => {
        conn.prepare('INSERT INTO plugin_mappings (company_id, plugin_id, version, text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(companyId, row.pluginId, row.version, row.text, row.createdAt, row.createdBy)
        const changed = conn.prepare('UPDATE plugin_installs SET mapping_version = ?, updated_at = ?, updated_by = ? WHERE company_id = ? AND plugin_id = ?')
          .run(row.version, row.createdAt, row.createdBy, companyId, row.pluginId).changes
        if (changed !== 1) throw new Error('plugin mapping without its install')
        addHistory(history)
      })()
    },
    history(pluginId, limit) {
      return (conn.prepare('SELECT id, plugin_id, action, at, by_user, change FROM plugin_history WHERE company_id = ? AND plugin_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(companyId, pluginId, limit) as HistoryRow[]).map(toHistory)
    },
  }
}
