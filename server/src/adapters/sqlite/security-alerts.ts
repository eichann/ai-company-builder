/**
 * SQLite storage of 「気になる動き」 (ports/security-alerts.ts), limited to one company: every
 * statement binds `company_id = ?`. Tables: db/schema/security-alerts.ts. The rules' reads of
 * other areas' tables are read-only and use those tables' company indexes.
 */
import type Database from 'better-sqlite3'
import type { SecurityAlertRepository, StoredSecurityAlert } from '../../ports/security-alerts'

type AlertRow = { id: string; kind: string; user_id: string | null; facts: string; created_at: string }
const toAlert = (r: AlertRow): StoredSecurityAlert => ({ id: r.id, kind: r.kind, userId: r.user_id, facts: r.facts, createdAt: r.created_at })

function stringArray(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function sqliteSecurityAlertRepository(conn: Database.Database, companyId: string): SecurityAlertRepository {
  return {
    insert(a) {
      const r = conn.prepare(`
        INSERT INTO security_alerts (id, company_id, kind, user_id, facts, dedupe_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, dedupe_key) DO NOTHING
      `).run(a.id, companyId, a.kind, a.userId, a.facts, a.dedupeKey, a.createdAt)
      return r.changes > 0
    },
    recent(since, limit) {
      return (conn.prepare(`
        SELECT id, kind, user_id, facts, created_at FROM security_alerts
        WHERE company_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?
      `).all(companyId, since, limit) as AlertRow[]).map(toAlert)
    },
    undelivered(limit) {
      return (conn.prepare(`
        SELECT id, kind, user_id, facts, created_at FROM security_alerts
        WHERE company_id = ? AND delivered_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT ?
      `).all(companyId, limit) as AlertRow[]).map(toAlert)
    },
    markDelivered(ids, at) {
      const stmt = conn.prepare('UPDATE security_alerts SET delivered_at = ? WHERE company_id = ? AND id = ?')
      conn.transaction(() => { for (const id of ids) stmt.run(at, companyId, id) })()
    },
    prune(before, beforeHour) {
      conn.prepare('DELETE FROM security_alerts WHERE company_id = ? AND created_at < ?').run(companyId, before)
      conn.prepare('DELETE FROM member_download_hours WHERE company_id = ? AND hour < ?').run(companyId, beforeHour)
    },

    settings() {
      const r = conn.prepare('SELECT slack_dm, updated_at FROM security_alert_settings WHERE company_id = ?')
        .get(companyId) as { slack_dm: number; updated_at: string } | undefined
      return r ? { slackDm: r.slack_dm === 1, updatedAt: r.updated_at } : null
    },
    saveSettings(slackDm, at, by) {
      conn.prepare(`
        INSERT INTO security_alert_settings (company_id, slack_dm, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET slack_dm = excluded.slack_dm, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, slackDm ? 1 : 0, at, by)
    },

    addDownload(userId, hour, bytes) {
      conn.prepare(`
        INSERT INTO member_download_hours (company_id, user_id, hour, bytes) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id, user_id, hour) DO UPDATE SET bytes = bytes + excluded.bytes
      `).run(companyId, userId, hour, bytes)
    },
    downloadsSince(fromHour) {
      return (conn.prepare(`
        SELECT user_id, SUM(bytes) AS bytes FROM member_download_hours
        WHERE company_id = ? AND hour >= ? GROUP BY user_id
      `).all(companyId, fromHour) as Array<{ user_id: string; bytes: number }>).map(r => ({ userId: r.user_id, bytes: r.bytes }))
    },
    downloadHours(userId, fromHour, toHour) {
      return conn.prepare(`
        SELECT hour, bytes FROM member_download_hours
        WHERE company_id = ? AND user_id = ? AND hour >= ? AND hour < ? ORDER BY hour
      `).all(companyId, userId, fromHour, toHour) as Array<{ hour: string; bytes: number }>
    },
    firstDownloadHour(userId) {
      const r = conn.prepare('SELECT MIN(hour) AS hour FROM member_download_hours WHERE company_id = ? AND user_id = ?')
        .get(companyId, userId) as { hour: string | null }
      return r.hour
    },

    pushRejectionsSince(since, perMember) {
      const counts = conn.prepare(`
        SELECT user_id, COUNT(*) AS n FROM push_rejections WHERE company_id = ? AND created_at >= ? GROUP BY user_id
      `).all(companyId, since) as Array<{ user_id: string; n: number }>
      const pathsOf = conn.prepare(`
        SELECT paths FROM push_rejections WHERE company_id = ? AND user_id = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT ?
      `)
      return counts.map(c => ({
        userId: c.user_id,
        count: c.n,
        paths: (pathsOf.all(companyId, c.user_id, since, perMember) as Array<{ paths: string }>).flatMap(r => stringArray(r.paths)),
      }))
    },
    pluginReads(from, to) {
      return (conn.prepare(`
        SELECT user_id, COUNT(*) AS n FROM plugin_access_log WHERE company_id = ? AND at >= ? AND at < ? GROUP BY user_id
      `).all(companyId, from, to) as Array<{ user_id: string; n: number }>).map(r => ({ userId: r.user_id, count: r.n }))
    },
    pluginReadsOf(userId, from, to) {
      return (conn.prepare(`
        SELECT COUNT(*) AS n FROM plugin_access_log WHERE company_id = ? AND user_id = ? AND at >= ? AND at < ?
      `).get(companyId, userId, from, to) as { n: number }).n
    },
    pluginPacedSince(fromHour) {
      return (conn.prepare(`
        SELECT user_id, SUM(count) AS n FROM plugin_call_paced WHERE company_id = ? AND hour >= ? GROUP BY user_id
      `).all(companyId, fromHour) as Array<{ user_id: string; n: number }>).map(r => ({ userId: r.user_id, count: r.n }))
    },
    keyRequests(fromDay, toDay) {
      return (conn.prepare(`
        SELECT user_id, day, SUM(requests) AS requests FROM broker_usage
        WHERE company_id = ? AND day >= ? AND day <= ? AND key_id NOT LIKE '%:refused'
        GROUP BY user_id, day
      `).all(companyId, fromDay, toDay) as Array<{ user_id: string; day: string; requests: number }>)
        .map(r => ({ userId: r.user_id, day: r.day, requests: r.requests }))
    },
    raisedRoles(since) {
      // A role change sets updated_at; a membership created as owner / admin (an invitation, a
      // member added back) has updated_at = created_at. The founding owner joined with the company.
      return (conn.prepare(`
        SELECT m.user_id, m.role, m.updated_at AS at FROM memberships m JOIN companies c ON c.id = m.company_id
        WHERE m.company_id = ? AND m.role IN ('owner', 'admin') AND m.updated_at >= ?
          AND NOT (m.user_id = c.owner_id AND m.updated_at = m.created_at AND m.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at, '+1 minute'))
      `).all(companyId, since) as Array<{ user_id: string; role: string; at: string }>).map(r => ({ userId: r.user_id, role: r.role, at: r.at }))
    },
    companyKeysSince(since) {
      return (conn.prepare(`
        SELECT id, service, created_at AS at, created_by AS by FROM broker_keys
        WHERE company_id = ? AND scope = 'company' AND created_at >= ?
      `).all(companyId, since) as Array<{ id: string; service: string; at: string; by: string }>)
    },
    skillEditingOpenedSince(since) {
      const r = conn.prepare(`
        SELECT updated_at AS at, updated_by AS by FROM skill_editing_settings WHERE company_id = ? AND everyone = 1 AND updated_at >= ?
      `).get(companyId, since) as { at: string; by: string | null } | undefined
      return r ?? null
    },
    internalHostsAddedSince(since) {
      const rows = conn.prepare(`
        SELECT id, changed_at, changed_by, change FROM broker_history
        WHERE company_id = ? AND action = 'settings' AND changed_at >= ?
      `).all(companyId, since) as Array<{ id: string; changed_at: string; changed_by: string; change: string }>
      const out: Array<{ id: string; at: string; by: string; added: number }> = []
      for (const r of rows) {
        let change: { before?: { internalHosts?: unknown }; after?: { internalHosts?: unknown } }
        try { change = JSON.parse(r.change) } catch { continue }
        const after = Array.isArray(change.after?.internalHosts) ? change.after.internalHosts : null
        if (!after) continue
        const before = new Set(Array.isArray(change.before?.internalHosts) ? change.before.internalHosts : [])
        const added = after.filter(h => !before.has(h)).length
        if (added > 0) out.push({ id: r.id, at: r.changed_at, by: r.changed_by, added })
      }
      return out
    },
  }
}
