/** SQLite storage of the browser-operation setting, member overrides and history (ports/agent-browser.ts). */
import type Database from 'better-sqlite3'
import type { AgentBrowserChangeRow, AgentBrowserRepository, StoredAgentBrowserOverride } from '../../ports/agent-browser'

type OverrideRow = { user_id: string; mode: string; updated_at: string; updated_by: string }
const toOverride = (r: OverrideRow): StoredAgentBrowserOverride => ({ userId: r.user_id, mode: r.mode, updatedAt: r.updated_at, updatedBy: r.updated_by })

export function sqliteAgentBrowserRepository(conn: Database.Database): AgentBrowserRepository {
  const addHistory = (companyId: string, change: AgentBrowserChangeRow) =>
    conn.prepare('INSERT INTO agent_browser_history (id, company_id, changed_at, changed_by, change) VALUES (?, ?, ?, ?, ?)')
      .run(change.id, companyId, change.changedAt, change.changedBy, change.change)
  return {
    get(companyId) {
      const r = conn.prepare('SELECT settings, updated_at, updated_by FROM agent_browser_settings WHERE company_id = ?')
        .get(companyId) as { settings: string; updated_at: string; updated_by: string | null } | undefined
      return r ? { settings: r.settings, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    save(companyId, stored, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO agent_browser_settings (company_id, settings, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, stored.settings, stored.updatedAt, stored.updatedBy)
        addHistory(companyId, change)
      })()
    },
    overrides(companyId) {
      return (conn.prepare('SELECT user_id, mode, updated_at, updated_by FROM agent_browser_overrides WHERE company_id = ? ORDER BY updated_at, user_id')
        .all(companyId) as OverrideRow[]).map(toOverride)
    },
    override(companyId, userId) {
      const r = conn.prepare('SELECT user_id, mode, updated_at, updated_by FROM agent_browser_overrides WHERE company_id = ? AND user_id = ?')
        .get(companyId, userId) as OverrideRow | undefined
      return r ? toOverride(r) : null
    },
    saveOverride(companyId, userId, value, change) {
      conn.transaction(() => {
        if (value) {
          conn.prepare(`
            INSERT INTO agent_browser_overrides (company_id, user_id, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          `).run(companyId, userId, value.mode, value.updatedAt, value.updatedBy)
        } else {
          conn.prepare('DELETE FROM agent_browser_overrides WHERE company_id = ? AND user_id = ?').run(companyId, userId)
        }
        if (change) addHistory(companyId, change)
      })()
    },
    siteParts(companyId) {
      return (conn.prepare('SELECT host, parts, updated_at, updated_by FROM agent_browser_site_parts WHERE company_id = ? ORDER BY host')
        .all(companyId) as Array<{ host: string; parts: string; updated_at: string; updated_by: string }>)
        .map(r => ({ host: r.host, parts: r.parts, updatedAt: r.updated_at, updatedBy: r.updated_by }))
    },
    saveSiteParts(companyId, host, value, change) {
      conn.transaction(() => {
        if (value) {
          conn.prepare(`
            INSERT INTO agent_browser_site_parts (company_id, host, parts, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company_id, host) DO UPDATE SET parts = excluded.parts, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          `).run(companyId, host, value.parts, value.updatedAt, value.updatedBy)
        } else {
          conn.prepare('DELETE FROM agent_browser_site_parts WHERE company_id = ? AND host = ?').run(companyId, host)
        }
        addHistory(companyId, change)
      })()
    },
    history(companyId, limit) {
      return (conn.prepare(`
        SELECT id, changed_at, changed_by, change FROM agent_browser_history
        WHERE company_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT ?
      `).all(companyId, limit) as Array<{ id: string; changed_at: string; changed_by: string; change: string }>)
        .map(r => ({ id: r.id, changedAt: r.changed_at, changedBy: r.changed_by, change: r.change }))
    },
  }
}
