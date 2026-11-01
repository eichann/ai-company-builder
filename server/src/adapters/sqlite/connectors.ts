/**
 * SQLite storage of the Google connection (ports/connectors.ts), limited to
 * one company: every statement binds `company_id = ?` with the handle's id.
 * Sealed secrets are stored as their JSON envelope only.
 */
import type Database from 'better-sqlite3'
import type { ConnectorChangeRow, ConnectorGrantRow, ConnectorProvider, ConnectorRepository, OAuthClientRow, OAuthPendingRow } from '../../ports/connectors'
import type { SealedSecret } from '../../ports/secret-cipher'

type ClientRow = {
  client_id: string; secret_last4: string; domain: string; enabled: number
  created_at: string; created_by: string; updated_at: string; updated_by: string
}
type GrantRow = {
  user_id: string; provider: string; grant_id: string; account_email: string; scopes: string; status: string
  status_reason: string | null; created_at: string; updated_at: string; last_used_at: string | null
}
type PendingRow = {
  state_hash: string; provider: string; user_id: string; scopes: string; verifier_sealed: string; created_at: string; expires_at: string
}
type HistoryRow = { id: string; provider: string; action: string; user_id: string | null; at: string; by_user: string; change: string }

const GRANT_COLUMNS = 'user_id, provider, grant_id, account_email, scopes, status, status_reason, created_at, updated_at, last_used_at'

const toClient = (r: ClientRow): OAuthClientRow => ({
  clientId: r.client_id, secretLast4: r.secret_last4, domain: r.domain, enabled: r.enabled === 1,
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
})
const scopesOf = (text: string): string[] => {
  try {
    const v = JSON.parse(text) as unknown
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}
const toGrant = (r: GrantRow): ConnectorGrantRow => ({
  userId: r.user_id, provider: r.provider as ConnectorProvider, grantId: r.grant_id, accountEmail: r.account_email,
  scopes: scopesOf(r.scopes), status: r.status as ConnectorGrantRow['status'], statusReason: r.status_reason,
  createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at,
})
const sealedOf = (text: string): SealedSecret => JSON.parse(text) as SealedSecret
const toPending = (r: PendingRow): OAuthPendingRow => ({
  stateHash: r.state_hash, provider: r.provider as ConnectorProvider, userId: r.user_id, scopes: scopesOf(r.scopes),
  verifier: sealedOf(r.verifier_sealed), createdAt: r.created_at, expiresAt: r.expires_at,
})

export function sqliteConnectorRepository(conn: Database.Database, companyId: string): ConnectorRepository {
  const addHistory = (c: ConnectorChangeRow | null) => {
    if (!c) return
    conn.prepare('INSERT INTO connector_history (id, company_id, provider, action, user_id, at, by_user, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, companyId, c.provider, c.action, c.userId, c.at, c.by, c.change)
  }

  return {
    client() {
      const r = conn.prepare(`SELECT client_id, secret_last4, domain, enabled, created_at, created_by, updated_at, updated_by
        FROM google_oauth_clients WHERE company_id = ?`).get(companyId) as ClientRow | undefined
      return r ? toClient(r) : null
    },
    clientSecret() {
      const r = conn.prepare('SELECT client_secret_sealed FROM google_oauth_clients WHERE company_id = ?').get(companyId) as { client_secret_sealed: string } | undefined
      return r ? sealedOf(r.client_secret_sealed) : null
    },
    saveClient(row, secret, change) {
      conn.transaction(() => {
        const exists = conn.prepare('SELECT 1 FROM google_oauth_clients WHERE company_id = ?').get(companyId)
        if (exists) {
          if (secret) {
            conn.prepare(`UPDATE google_oauth_clients SET client_id = ?, domain = ?, secret_last4 = ?, client_secret_sealed = ?, updated_at = ?, updated_by = ?
              WHERE company_id = ?`).run(row.clientId, row.domain, secret.last4, JSON.stringify(secret.sealed), row.at, row.by, companyId)
          } else {
            conn.prepare('UPDATE google_oauth_clients SET client_id = ?, domain = ?, updated_at = ?, updated_by = ? WHERE company_id = ?')
              .run(row.clientId, row.domain, row.at, row.by, companyId)
          }
        } else {
          if (!secret) throw new Error('A new OAuth client needs its secret')
          conn.prepare(`INSERT INTO google_oauth_clients (company_id, client_id, secret_last4, client_secret_sealed, domain, enabled, created_at, created_by, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(companyId, row.clientId, secret.last4, JSON.stringify(secret.sealed), row.domain, row.at, row.by, row.at, row.by)
        }
        addHistory(change)
      })()
    },
    setClientEnabled(enabled, at, by, change) {
      conn.transaction(() => {
        conn.prepare('UPDATE google_oauth_clients SET enabled = ?, updated_at = ?, updated_by = ? WHERE company_id = ?').run(enabled ? 1 : 0, at, by, companyId)
        addHistory(change)
      })()
    },

    grants(provider) {
      return (conn.prepare(`SELECT ${GRANT_COLUMNS} FROM connector_grants WHERE company_id = ? AND provider = ? ORDER BY created_at, rowid`)
        .all(companyId, provider) as GrantRow[]).map(toGrant)
    },
    grant(provider, userId) {
      const r = conn.prepare(`SELECT ${GRANT_COLUMNS} FROM connector_grants WHERE company_id = ? AND provider = ? AND user_id = ?`)
        .get(companyId, provider, userId) as GrantRow | undefined
      return r ? toGrant(r) : null
    },
    refreshToken(provider, userId) {
      const r = conn.prepare(`SELECT grant_id, refresh_token_sealed FROM connector_grants
        WHERE company_id = ? AND provider = ? AND user_id = ? AND status = 'active' AND refresh_token_sealed IS NOT NULL`)
        .get(companyId, provider, userId) as { grant_id: string; refresh_token_sealed: string } | undefined
      return r ? { grantId: r.grant_id, sealed: sealedOf(r.refresh_token_sealed) } : null
    },
    putGrant(row, sealed, change) {
      conn.transaction(() => {
        conn.prepare(`INSERT INTO connector_grants (company_id, user_id, provider, grant_id, account_email, scopes, refresh_token_sealed, status, status_reason, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)
          ON CONFLICT (company_id, user_id, provider) DO UPDATE SET grant_id = excluded.grant_id, account_email = excluded.account_email,
            scopes = excluded.scopes, refresh_token_sealed = excluded.refresh_token_sealed, status = 'active', status_reason = NULL,
            created_at = excluded.created_at, updated_at = excluded.updated_at, last_used_at = NULL`)
          .run(companyId, row.userId, row.provider, row.grantId, row.accountEmail, JSON.stringify(row.scopes), JSON.stringify(sealed), row.createdAt, row.updatedAt)
        addHistory(change)
      })()
    },
    setGrantScopes(provider, userId, scopes, at, change) {
      conn.transaction(() => {
        conn.prepare('UPDATE connector_grants SET scopes = ?, updated_at = ? WHERE company_id = ? AND provider = ? AND user_id = ?')
          .run(JSON.stringify(scopes), at, companyId, provider, userId)
        addHistory(change)
      })()
    },
    endGrant(provider, userId, status, reason, at, change, grantId) {
      return conn.transaction(() => {
        const r = grantId === undefined
          ? conn.prepare(`UPDATE connector_grants SET status = ?, status_reason = ?, refresh_token_sealed = NULL, updated_at = ?
              WHERE company_id = ? AND provider = ? AND user_id = ? AND status = 'active'`).run(status, reason, at, companyId, provider, userId)
          : conn.prepare(`UPDATE connector_grants SET status = ?, status_reason = ?, refresh_token_sealed = NULL, updated_at = ?
              WHERE company_id = ? AND provider = ? AND user_id = ? AND status = 'active' AND grant_id = ?`).run(status, reason, at, companyId, provider, userId, grantId)
        if (r.changes > 0) addHistory(change)
        return r.changes > 0
      })()
    },
    deleteGrant(provider, userId, change) {
      conn.transaction(() => {
        conn.prepare('DELETE FROM connector_grants WHERE company_id = ? AND provider = ? AND user_id = ?').run(companyId, provider, userId)
        addHistory(change)
      })()
    },
    touchGrant(provider, userId, at) {
      conn.prepare('UPDATE connector_grants SET last_used_at = ? WHERE company_id = ? AND provider = ? AND user_id = ?').run(at, companyId, provider, userId)
    },

    putPending(row) {
      conn.prepare(`INSERT INTO oauth_pending (company_id, state_hash, provider, user_id, scopes, verifier_sealed, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.stateHash, row.provider, row.userId, JSON.stringify(row.scopes), JSON.stringify(row.verifier), row.createdAt, row.expiresAt)
    },
    takePending(stateHash, now) {
      const r = conn.prepare('DELETE FROM oauth_pending WHERE company_id = ? AND state_hash = ? RETURNING state_hash, provider, user_id, scopes, verifier_sealed, created_at, expires_at')
        .get(companyId, stateHash) as PendingRow | undefined
      if (!r || r.expires_at <= now) return null
      return toPending(r)
    },
    prunePending(now, userId) {
      conn.prepare('DELETE FROM oauth_pending WHERE company_id = ? AND expires_at <= ?').run(companyId, now)
      if (userId !== undefined) conn.prepare('DELETE FROM oauth_pending WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    },

    history(provider, limit) {
      return (conn.prepare('SELECT id, provider, action, user_id, at, by_user, change FROM connector_history WHERE company_id = ? AND provider = ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(companyId, provider, limit) as HistoryRow[])
        .map(r => ({ id: r.id, provider: r.provider as ConnectorProvider, action: r.action, userId: r.user_id, at: r.at, by: r.by_user, change: r.change }))
    },
  }
}
