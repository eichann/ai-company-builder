/**
 * SQLite storage of the PCs used for 「ブラウザ操作」 (ports/browser-devices.ts), bound to one company — built only by the
 * company handle (adapters/sqlite/company-data.ts), every statement limited to `companyId`. State changes are
 * compare-and-set on the current state (`changes === 1`).
 */
import type Database from 'better-sqlite3'
import type { BrowserDeviceHistoryRow, BrowserDeviceRepository, BrowserDeviceRow, BrowserPlanPath } from '../../ports/browser-devices'

const COLUMNS = 'id, user_id, key_hash, label, state, revoke_reason, requested_at, enabled_at, enabled_by, revoked_at, revoked_by, last_used_at'
type DbRow = {
  id: string; user_id: string; key_hash: string; label: string; state: BrowserDeviceRow['state']; revoke_reason: BrowserDeviceRow['revokeReason']
  requested_at: string; enabled_at: string | null; enabled_by: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null
}
const toRow = (r: DbRow): BrowserDeviceRow => ({
  id: r.id, userId: r.user_id, keyHash: r.key_hash, label: r.label, state: r.state, revokeReason: r.revoke_reason, requestedAt: r.requested_at,
  enabledAt: r.enabled_at, enabledBy: r.enabled_by, revokedAt: r.revoked_at, revokedBy: r.revoked_by, lastUsedAt: r.last_used_at,
})
type HistoryDbRow = { id: string; device_id: string; user_id: string; actor_id: string; action: BrowserDeviceHistoryRow['action']; reason: BrowserDeviceHistoryRow['reason']; at: string }

export function sqliteBrowserDeviceRepository(conn: Database.Database, companyId: string): BrowserDeviceRepository {
  return {
    insert(row) {
      conn.prepare(`INSERT INTO browser_devices (company_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        companyId, row.id, row.userId, row.keyHash, row.label, row.state, row.revokeReason, row.requestedAt, row.enabledAt, row.enabledBy,
        row.revokedAt, row.revokedBy, row.lastUsedAt,
      )
    },
    byId(id) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_devices WHERE company_id = ? AND id = ?`).get(companyId, id) as DbRow | undefined
      return r ? toRow(r) : null
    },
    forKey(userId, keyHash) {
      const r = conn.prepare(`SELECT ${COLUMNS} FROM browser_devices WHERE company_id = ? AND user_id = ? AND key_hash = ?
        ORDER BY (state <> 'revoked') DESC, requested_at DESC, rowid DESC LIMIT 1`).get(companyId, userId, keyHash) as DbRow | undefined
      return r ? toRow(r) : null
    },
    liveCountOf(userId) {
      return (conn.prepare("SELECT COUNT(*) AS n FROM browser_devices WHERE company_id = ? AND user_id = ? AND state <> 'revoked'").get(companyId, userId) as { n: number }).n
    },
    list(limit) {
      return (conn.prepare(`SELECT ${COLUMNS} FROM browser_devices WHERE company_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?`).all(companyId, limit) as DbRow[]).map(toRow)
    },
    enable(id, by, at) {
      return conn.prepare("UPDATE browser_devices SET state = 'enabled', enabled_at = ?, enabled_by = ? WHERE company_id = ? AND id = ? AND state = 'pending'")
        .run(at, by, companyId, id).changes === 1
    },
    revoke(id, from, reason, by, at) {
      return conn.prepare("UPDATE browser_devices SET state = 'revoked', revoke_reason = ?, revoked_at = ?, revoked_by = ? WHERE company_id = ? AND id = ? AND state = ?")
        .run(reason, at, by, companyId, id, from).changes === 1
    },
    revokeAllOf(userId, reason, by, at) {
      const ids = (conn.prepare("SELECT id FROM browser_devices WHERE company_id = ? AND user_id = ? AND state <> 'revoked' ORDER BY rowid").all(companyId, userId) as Array<{ id: string }>).map(r => r.id)
      conn.prepare("UPDATE browser_devices SET state = 'revoked', revoke_reason = ?, revoked_at = ?, revoked_by = ? WHERE company_id = ? AND user_id = ? AND state <> 'revoked'")
        .run(reason, at, by, companyId, userId)
      return ids
    },
    touch(id, at, staleBefore) {
      conn.prepare("UPDATE browser_devices SET last_used_at = ? WHERE company_id = ? AND id = ? AND state = 'enabled' AND (last_used_at IS NULL OR last_used_at < ?)")
        .run(at, companyId, id, staleBefore)
    },
    appendHistory(row) {
      conn.prepare('INSERT INTO browser_device_history (company_id, id, device_id, user_id, actor_id, action, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(companyId, row.id, row.deviceId, row.userId, row.actorId, row.action, row.reason, row.at)
    },
    history(limit) {
      return (conn.prepare('SELECT id, device_id, user_id, actor_id, action, reason, at FROM browser_device_history WHERE company_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(companyId, limit) as HistoryDbRow[]).map(r => ({ id: r.id, deviceId: r.device_id, userId: r.user_id, actorId: r.actor_id, action: r.action, reason: r.reason, at: r.at }))
    },
    bindPlan(path: BrowserPlanPath, planId, deviceId, at) {
      conn.prepare('INSERT INTO browser_plan_devices (company_id, path, plan_id, device_id, created_at) VALUES (?, ?, ?, ?, ?)').run(companyId, path, planId, deviceId, at)
    },
    planDevice(path, planId) {
      const r = conn.prepare('SELECT device_id FROM browser_plan_devices WHERE company_id = ? AND path = ? AND plan_id = ?').get(companyId, path, planId) as { device_id: string } | undefined
      return r ? r.device_id : null
    },
  }
}
