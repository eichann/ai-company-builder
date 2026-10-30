/** SQLite storage of the AI sandbox setting, member overrides and history (ports/agent-sandbox.ts). */
import type Database from 'better-sqlite3'
import type { AgentSandboxChangeRow, AgentSandboxRepository, StoredAgentSandboxOverride } from '../../ports/agent-sandbox'

type OverrideRow = { user_id: string; mode: string; updated_at: string; updated_by: string }
const toOverride = (r: OverrideRow): StoredAgentSandboxOverride => ({ userId: r.user_id, mode: r.mode, updatedAt: r.updated_at, updatedBy: r.updated_by })

export function sqliteAgentSandboxRepository(conn: Database.Database): AgentSandboxRepository {
  const addHistory = (companyId: string, change: AgentSandboxChangeRow) =>
    conn.prepare('INSERT INTO agent_sandbox_history (id, company_id, changed_at, changed_by, change) VALUES (?, ?, ?, ?, ?)')
      .run(change.id, companyId, change.changedAt, change.changedBy, change.change)
  return {
    get(companyId) {
      const r = conn.prepare('SELECT settings, updated_at, updated_by FROM agent_sandbox_settings WHERE company_id = ?')
        .get(companyId) as { settings: string; updated_at: string; updated_by: string | null } | undefined
      return r ? { settings: r.settings, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    save(companyId, stored, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO agent_sandbox_settings (company_id, settings, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, stored.settings, stored.updatedAt, stored.updatedBy)
        addHistory(companyId, change)
      })()
    },
    overrides(companyId) {
      return (conn.prepare('SELECT user_id, mode, updated_at, updated_by FROM agent_sandbox_overrides WHERE company_id = ? ORDER BY updated_at, user_id')
        .all(companyId) as OverrideRow[]).map(toOverride)
    },
    override(companyId, userId) {
      const r = conn.prepare('SELECT user_id, mode, updated_at, updated_by FROM agent_sandbox_overrides WHERE company_id = ? AND user_id = ?')
        .get(companyId, userId) as OverrideRow | undefined
      return r ? toOverride(r) : null
    },
    saveOverride(companyId, userId, value, change) {
      conn.transaction(() => {
        if (value) {
          conn.prepare(`
            INSERT INTO agent_sandbox_overrides (company_id, user_id, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company_id, user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          `).run(companyId, userId, value.mode, value.updatedAt, value.updatedBy)
        } else {
          conn.prepare('DELETE FROM agent_sandbox_overrides WHERE company_id = ? AND user_id = ?').run(companyId, userId)
        }
        addHistory(companyId, change)
      })()
    },
    history(companyId, limit) {
      return (conn.prepare(`
        SELECT id, changed_at, changed_by, change FROM agent_sandbox_history
        WHERE company_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT ?
      `).all(companyId, limit) as Array<{ id: string; changed_at: string; changed_by: string; change: string }>)
        .map(r => ({ id: r.id, changedAt: r.changed_at, changedBy: r.changed_by, change: r.change }))
    },
  }
}
