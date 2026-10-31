/**
 * SQLite storage of a company's connector plugins (ports/plugins.ts): its
 * installs, mapping versions and history, bound to one company — built only
 * by the company handle (adapters/sqlite/company-data.ts), every statement
 * limited to `companyId`. The triggers of db/index.ts (migratePluginTables)
 * refuse a mapping under another company's install and a key of another
 * company.
 */
import type Database from 'better-sqlite3'
import type { ExternalLinkRow, PluginPolicyAckRow, PluginHistoryRow, PluginInstallRow, PluginMappingRow, PluginOperationRow, PluginRepository } from '../../ports/plugins'

const OP_COLUMNS = `id, plugin_id, operation, plugin_version, fingerprint, mapping_version, connection_id, account_id, object, external_id, record_id,
  actor_id, actor_kind, actor_source, conversation_id, state, fields, written, previous, reason, undo_of, undone_by, record_version, created_at, updated_at,
  replaced_by, approved_by`
type OpRow = {
  id: string; plugin_id: string; operation: string; plugin_version: string; fingerprint: string; mapping_version: number; connection_id: string
  account_id: string; object: string; external_id: string | null; record_id: string | null; actor_id: string; actor_kind: 'human' | 'ai'; actor_source: string | null
  conversation_id: string | null; state: PluginOperationRow['state']; fields: string; written: string; previous: string; reason: string | null
  undo_of: string | null; undone_by: string | null; record_version: number | null; created_at: string; updated_at: string
  replaced_by: string | null; approved_by: string | null
}
const toOp = (r: OpRow): PluginOperationRow => ({
  id: r.id, pluginId: r.plugin_id, operation: r.operation, pluginVersion: r.plugin_version, fingerprint: r.fingerprint, mappingVersion: r.mapping_version,
  connectionId: r.connection_id, accountId: r.account_id, object: r.object, externalId: r.external_id, recordId: r.record_id, actorId: r.actor_id,
  actorKind: r.actor_kind, actorSource: r.actor_source, conversationId: r.conversation_id, state: r.state, fields: r.fields, written: r.written,
  previous: r.previous, reason: r.reason, undoOf: r.undo_of, undoneBy: r.undone_by, recordVersion: r.record_version, createdAt: r.created_at, updatedAt: r.updated_at,
  replacedBy: r.replaced_by, approvedBy: r.approved_by,
})

type LinkRow = {
  plugin_id: string; connection_id: string; account_id: string; object: string; external_id: string; record_id: string
  external_updated_at: string | null; seen_at: string
}
const toLink = (r: LinkRow): ExternalLinkRow => ({
  pluginId: r.plugin_id, connectionId: r.connection_id, accountId: r.account_id, object: r.object, externalId: r.external_id,
  recordId: r.record_id, externalUpdatedAt: r.external_updated_at, seenAt: r.seen_at,
})
const LINK_COLUMNS = 'plugin_id, connection_id, account_id, object, external_id, record_id, external_updated_at, seen_at'

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
    addHistory(h) { addHistory(h) },
    bindAccount(pluginId, connectionId, accountId, history) {
      return conn.transaction(() => {
        const changed = conn.prepare('UPDATE plugin_installs SET account_id = ? WHERE company_id = ? AND plugin_id = ? AND connection_id = ? AND account_id IS NULL')
          .run(accountId, companyId, pluginId, connectionId).changes
        if (changed === 1) addHistory(history)
        return changed === 1
      })()
    },
    renewConnection(pluginId, connectionId, at, by, history) {
      conn.transaction(() => {
        const old = conn.prepare('SELECT connection_id FROM plugin_installs WHERE company_id = ? AND plugin_id = ?').get(companyId, pluginId) as { connection_id: string } | undefined
        conn.prepare('UPDATE plugin_installs SET connection_id = ?, account_id = NULL, updated_at = ?, updated_by = ? WHERE company_id = ? AND plugin_id = ?')
          .run(connectionId, at, by, companyId, pluginId)
        if (old) {
          conn.prepare(`
            INSERT OR IGNORE INTO plugin_read_scopes (company_id, plugin_id, connection_id, subject_type, subject_id, added_by, added_at)
            SELECT company_id, plugin_id, ?, subject_type, subject_id, ?, ? FROM plugin_read_scopes WHERE company_id = ? AND plugin_id = ? AND connection_id = ?
          `).run(connectionId, by, at, companyId, pluginId, old.connection_id)
        }
        addHistory(history)
      })()
    },
    link(connectionId, accountId, object, externalId) {
      const r = conn.prepare(`SELECT ${LINK_COLUMNS} FROM plugin_external_links WHERE company_id = ? AND connection_id = ? AND account_id = ? AND object = ? AND external_id = ?`)
        .get(companyId, connectionId, accountId, object, externalId) as LinkRow | undefined
      return r ? toLink(r) : null
    },
    linkOfRecord(recordId) {
      const r = conn.prepare(`SELECT ${LINK_COLUMNS} FROM plugin_external_links WHERE company_id = ? AND record_id = ?`).get(companyId, recordId) as LinkRow | undefined
      return r ? toLink(r) : null
    },
    oldConnectionRecordIds() {
      return (conn.prepare(`
        SELECT DISTINCT l.record_id FROM plugin_external_links l WHERE l.company_id = ? AND NOT EXISTS (
          SELECT 1 FROM plugin_external_links c JOIN plugin_installs i ON i.company_id = c.company_id AND i.plugin_id = c.plugin_id AND i.connection_id = c.connection_id
          WHERE c.company_id = ? AND c.record_id = l.record_id)
      `).all(companyId, companyId) as Array<{ record_id: string }>).map(r => r.record_id)
    },
    saveLink(l) {
      conn.prepare(`
        INSERT INTO plugin_external_links (company_id, plugin_id, connection_id, account_id, object, external_id, record_id, external_updated_at, seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, connection_id, account_id, object, external_id) DO UPDATE SET external_updated_at = excluded.external_updated_at, seen_at = excluded.seen_at
      `).run(companyId, l.pluginId, l.connectionId, l.accountId, l.object, l.externalId, l.recordId, l.externalUpdatedAt, l.seenAt)
    },
    readScope(pluginId, connectionId) {
      return (conn.prepare('SELECT subject_type, subject_id FROM plugin_read_scopes WHERE company_id = ? AND plugin_id = ? AND connection_id = ? ORDER BY subject_type, subject_id')
        .all(companyId, pluginId, connectionId) as Array<{ subject_type: 'department' | 'user'; subject_id: string }>)
        .map(r => ({ type: r.subject_type, id: r.subject_id }))
    },
    setReadScope(pluginId, connectionId, entries, at, by, history) {
      conn.transaction(() => {
        conn.prepare('DELETE FROM plugin_read_scopes WHERE company_id = ? AND plugin_id = ? AND connection_id = ?').run(companyId, pluginId, connectionId)
        for (const e of entries) {
          conn.prepare('INSERT INTO plugin_read_scopes (company_id, plugin_id, connection_id, subject_type, subject_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(companyId, pluginId, connectionId, e.type, e.id, by, at)
        }
        addHistory(history)
      })()
    },
    policyAcks(pluginId) {
      return (conn.prepare('SELECT plugin_id, field, property, acknowledged_by, acknowledged_at FROM plugin_policy_acks WHERE company_id = ? AND plugin_id = ? ORDER BY field')
        .all(companyId, pluginId) as Array<{ plugin_id: string; field: string; property: string; acknowledged_by: string; acknowledged_at: string }>)
        .map(r => ({ pluginId: r.plugin_id, field: r.field, property: r.property, acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at }))
    },
    addPolicyAcks(rows: PluginPolicyAckRow[], history) {
      conn.transaction(() => {
        for (const r of rows) {
          conn.prepare(`
            INSERT INTO plugin_policy_acks (company_id, plugin_id, field, property, acknowledged_by, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(company_id, plugin_id, field) DO UPDATE SET property = excluded.property, acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at
          `).run(companyId, r.pluginId, r.field, r.property, r.acknowledgedBy, r.acknowledgedAt)
        }
        addHistory(history)
      })()
    },
    insertOperation(o) {
      conn.prepare(`INSERT INTO plugin_operations (company_id, ${OP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, o.id, o.pluginId, o.operation, o.pluginVersion, o.fingerprint, o.mappingVersion, o.connectionId, o.accountId, o.object, o.externalId,
          o.recordId, o.actorId, o.actorKind, o.actorSource, o.conversationId, o.state, o.fields, o.written, o.previous, o.reason, o.undoOf, o.undoneBy,
          o.recordVersion, o.createdAt, o.updatedAt, o.replacedBy, o.approvedBy)
    },
    updateOperation(id, changes, at) {
      const current = conn.prepare(`SELECT ${OP_COLUMNS} FROM plugin_operations WHERE company_id = ? AND id = ?`).get(companyId, id) as OpRow | undefined
      if (!current) return
      const pick = <K extends keyof typeof changes>(k: K, now: unknown) => (changes[k] !== undefined ? changes[k] : now)
      conn.prepare(`UPDATE plugin_operations SET state = ?, reason = ?, record_version = ?, undone_by = ?, replaced_by = ?, external_id = ?, record_id = ?, updated_at = ?
        WHERE company_id = ? AND id = ?`)
        .run(changes.state ?? current.state, pick('reason', current.reason), pick('recordVersion', current.record_version),
          pick('undoneBy', current.undone_by), pick('replacedBy', current.replaced_by), pick('externalId', current.external_id),
          pick('recordId', current.record_id), at, companyId, id)
    },
    operation(id) {
      const r = conn.prepare(`SELECT ${OP_COLUMNS} FROM plugin_operations WHERE company_id = ? AND id = ?`).get(companyId, id) as OpRow | undefined
      return r ? toOp(r) : null
    },
    history(pluginId, limit) {
      return (conn.prepare('SELECT id, plugin_id, action, at, by_user, change FROM plugin_history WHERE company_id = ? AND plugin_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(companyId, pluginId, limit) as HistoryRow[]).map(toHistory)
    },
  }
}
