/**
 * SQLite storage of 「もう一方の AI に聞く」 (ports/second-opinion.ts), limited to one company:
 * every statement binds `company_id = ?`. The table is made by db/schema/agents.ts
 * `migrateSecondOpinionSetting`.
 */
import type Database from 'better-sqlite3'
import type { SecondOpinionSettingRepository } from '../../ports/second-opinion'

export function sqliteSecondOpinionSettingRepository(conn: Database.Database, companyId: string): SecondOpinionSettingRepository {
  return {
    get() {
      const r = conn.prepare('SELECT allowed, updated_at, updated_by FROM second_opinion_settings WHERE company_id = ?')
        .get(companyId) as { allowed: number; updated_at: string; updated_by: string | null } | undefined
      return r ? { allowed: r.allowed === 1, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    save(stored) {
      conn.prepare(`
        INSERT INTO second_opinion_settings (company_id, allowed, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).run(companyId, stored.allowed ? 1 : 0, stored.updatedAt, stored.updatedBy)
    },
  }
}
