import type Database from 'better-sqlite3'
import type { ClientActivityRepository, ClientActivityRow } from '../../ports/client-activity'

/** Table client_activity (services/client-activity.ts decides when to write). */
export function sqliteClientActivityRepository(conn: Database.Database): ClientActivityRepository {
  return {
    forCompany(companyId) {
      const rows = conn.prepare('SELECT * FROM client_activity WHERE company_id = ?').all(companyId) as ClientActivityRow[]
      return new Map(rows.map(r => [r.user_id, r]))
    },

    record({ userId, companyId, kind, version, platform, at }) {
      conn.prepare(`
        INSERT INTO client_activity (
          user_id, company_id, client_version, client_platform,
          last_seen_at, last_fetch_at, last_push_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, company_id) DO UPDATE SET
          client_version = excluded.client_version,
          client_platform = excluded.client_platform,
          last_seen_at = excluded.last_seen_at,
          last_fetch_at = COALESCE(excluded.last_fetch_at, client_activity.last_fetch_at),
          last_push_at = COALESCE(excluded.last_push_at, client_activity.last_push_at),
          updated_at = excluded.updated_at
      `).run(
        userId, companyId, version, platform,
        at,
        kind === 'fetch' ? at : null,
        kind === 'push' ? at : null,
        at,
      )
    },
  }
}
