/** SQLite storage of the key broker's vault, service rules, setting and history (ports/key-broker.ts). */
import type Database from 'better-sqlite3'
import type { BrokerChangeRow, BrokerKeyRepository, BrokerKeyRow, BrokerTokenRepository, StoredBrokerService } from '../../ports/key-broker'
import type { SealedSecret } from '../../ports/secret-cipher'

const KEY_COLUMNS = `id, company_id, scope, owner_user_id, service, display_name, last4, kek_id, destinations, audience, caps,
  allow_private_content, status, created_at, created_by, updated_at, updated_by, secret_updated_at`

type KeyRow = {
  id: string; company_id: string; scope: string; owner_user_id: string | null; service: string; display_name: string
  last4: string; kek_id: string; destinations: string; audience: string; caps: string; allow_private_content: number
  status: string; created_at: string; created_by: string; updated_at: string; updated_by: string; secret_updated_at: string
}

const toKey = (r: KeyRow): BrokerKeyRow => ({
  id: r.id,
  companyId: r.company_id,
  scope: r.scope,
  ownerUserId: r.owner_user_id,
  service: r.service,
  displayName: r.display_name,
  last4: r.last4,
  kekId: r.kek_id,
  destinations: r.destinations,
  audience: r.audience,
  caps: r.caps,
  allowPrivateContent: r.allow_private_content === 1,
  status: r.status,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
  secretUpdatedAt: r.secret_updated_at,
})

type SealedRow = { cipher_scheme: string; ciphertext: string; nonce: string; tag: string; wrapped_key: string; kek_id: string }
const toSealed = (r: SealedRow): SealedSecret => ({
  scheme: r.cipher_scheme, ciphertext: r.ciphertext, nonce: r.nonce, tag: r.tag, wrappedKey: r.wrapped_key, kekId: r.kek_id,
})

const CHANGE_COLUMNS: Record<string, string> = {
  displayName: 'display_name',
  destinations: 'destinations',
  audience: 'audience',
  caps: 'caps',
  allowPrivateContent: 'allow_private_content',
  status: 'status',
}

export function sqliteKeyBrokerRepository(conn: Database.Database): BrokerKeyRepository {
  const addHistory = (companyId: string, c: BrokerChangeRow) =>
    conn.prepare('INSERT INTO broker_history (id, company_id, key_id, action, changed_at, changed_by, change) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, companyId, c.keyId, c.action, c.changedAt, c.changedBy, c.change)

  return {
    list(companyId) {
      return (conn.prepare(`SELECT ${KEY_COLUMNS} FROM broker_keys WHERE company_id = ? ORDER BY created_at, rowid`).all(companyId) as KeyRow[]).map(toKey)
    },
    find(companyId, keyId) {
      const r = conn.prepare(`SELECT ${KEY_COLUMNS} FROM broker_keys WHERE company_id = ? AND id = ?`).get(companyId, keyId) as KeyRow | undefined
      return r ? toKey(r) : null
    },
    sealed(companyId, keyId) {
      const r = conn.prepare('SELECT cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id FROM broker_keys WHERE company_id = ? AND id = ?')
        .get(companyId, keyId) as SealedRow | undefined
      return r ? toSealed(r) : null
    },
    allSealed() {
      return (conn.prepare('SELECT company_id, id, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id FROM broker_keys ORDER BY rowid')
        .all() as Array<SealedRow & { company_id: string; id: string }>)
        .map(r => ({ companyId: r.company_id, keyId: r.id, sealed: toSealed(r) }))
    },
    insert(row, sealed, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4,
            cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id, destinations, audience, caps,
            allow_private_content, status, created_at, created_by, updated_at, updated_by, secret_updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(row.id, row.companyId, row.scope, row.ownerUserId, row.service, row.displayName, row.last4,
          sealed.scheme, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.wrappedKey, sealed.kekId,
          row.destinations, row.audience, row.caps, row.allowPrivateContent ? 1 : 0, row.status,
          row.createdAt, row.createdBy, row.updatedAt, row.updatedBy, row.secretUpdatedAt)
        addHistory(row.companyId, change)
      })()
    },
    update(companyId, keyId, changes, at, by, change) {
      const sets: string[] = []
      const values: unknown[] = []
      for (const [field, column] of Object.entries(CHANGE_COLUMNS)) {
        const v = (changes as Record<string, unknown>)[field]
        if (v === undefined) continue
        sets.push(`${column} = ?`)
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
      }
      conn.transaction(() => {
        conn.prepare(`UPDATE broker_keys SET ${[...sets, 'updated_at = ?', 'updated_by = ?'].join(', ')} WHERE company_id = ? AND id = ?`)
          .run(...values, at, by, companyId, keyId)
        addHistory(companyId, change)
      })()
    },
    replaceSecret(companyId, keyId, sealed, last4, at, by, change) {
      conn.transaction(() => {
        conn.prepare(`
          UPDATE broker_keys SET cipher_scheme = ?, ciphertext = ?, nonce = ?, tag = ?, wrapped_key = ?, kek_id = ?,
            last4 = ?, secret_updated_at = ?, updated_at = ?, updated_by = ?
          WHERE company_id = ? AND id = ?
        `).run(sealed.scheme, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.wrappedKey, sealed.kekId, last4, at, at, by, companyId, keyId)
        addHistory(companyId, change)
      })()
    },
    rewrap(companyId, keyId, wrappedKey, kekId) {
      conn.prepare('UPDATE broker_keys SET wrapped_key = ?, kek_id = ? WHERE company_id = ? AND id = ?').run(wrappedKey, kekId, companyId, keyId)
    },
    delete(companyId, keyId, change) {
      conn.transaction(() => {
        conn.prepare('DELETE FROM broker_keys WHERE company_id = ? AND id = ?').run(companyId, keyId)
        addHistory(companyId, change)
      })()
    },

    services(companyId) {
      return (conn.prepare('SELECT service, category, rule, own_key_hosts, relay, read_only, updated_at, updated_by FROM broker_services WHERE company_id = ? ORDER BY service')
        .all(companyId) as Array<{ service: string; category: string; rule: string; own_key_hosts: string; relay: string | null; read_only: number; updated_at: string; updated_by: string }>)
        .map((r): StoredBrokerService => ({ service: r.service, category: r.category, rule: r.rule, ownKeyHosts: r.own_key_hosts, relay: r.relay, readOnly: r.read_only === 1, updatedAt: r.updated_at, updatedBy: r.updated_by }))
    },
    saveService(companyId, s, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO broker_services (company_id, service, category, rule, own_key_hosts, relay, read_only, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, service) DO UPDATE SET category = excluded.category, rule = excluded.rule,
            own_key_hosts = excluded.own_key_hosts, relay = excluded.relay, read_only = excluded.read_only,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, s.service, s.category, s.rule, s.ownKeyHosts, s.relay, s.readOnly ? 1 : 0, s.updatedAt, s.updatedBy)
        addHistory(companyId, change)
      })()
    },
    deleteService(companyId, service, change) {
      conn.transaction(() => {
        conn.prepare('DELETE FROM broker_services WHERE company_id = ? AND service = ?').run(companyId, service)
        addHistory(companyId, change)
      })()
    },
    settings(companyId) {
      const r = conn.prepare('SELECT member_keys_allowed, internal_hosts, updated_at, updated_by FROM broker_settings WHERE company_id = ?')
        .get(companyId) as { member_keys_allowed: number; internal_hosts: string; updated_at: string; updated_by: string } | undefined
      return r ? { memberKeysAllowed: r.member_keys_allowed === 1, internalHosts: r.internal_hosts, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    saveSettings(companyId, s, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO broker_settings (company_id, member_keys_allowed, internal_hosts, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET member_keys_allowed = excluded.member_keys_allowed,
            internal_hosts = excluded.internal_hosts, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, s.memberKeysAllowed ? 1 : 0, s.internalHosts, s.updatedAt, s.updatedBy)
        addHistory(companyId, change)
      })()
    },
    usage(companyId, keyId, userId, day) {
      const r = conn.prepare(`
        SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens,
          COALESCE(SUM(CASE WHEN user_id = ? THEN requests ELSE 0 END), 0) AS member_requests,
          COALESCE(SUM(CASE WHEN user_id = ? THEN tokens ELSE 0 END), 0) AS member_tokens
        FROM broker_usage WHERE company_id = ? AND key_id = ? AND day = ?
      `).get(userId, userId, companyId, keyId, day) as { requests: number; tokens: number; member_requests: number; member_tokens: number }
      return { requests: r.requests, tokens: r.tokens, memberRequests: r.member_requests, memberTokens: r.member_tokens }
    },
    usageByKey(companyId, day) {
      const rows = conn.prepare('SELECT key_id, SUM(requests) AS requests, SUM(tokens) AS tokens FROM broker_usage WHERE company_id = ? AND day = ? GROUP BY key_id')
        .all(companyId, day) as Array<{ key_id: string; requests: number; tokens: number }>
      return new Map(rows.map(r => [r.key_id, { requests: r.requests, tokens: r.tokens }]))
    },
    addUsage(companyId, keyId, userId, day, requests, tokens) {
      conn.prepare(`
        INSERT INTO broker_usage (company_id, key_id, user_id, day, requests, tokens) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(company_id, key_id, user_id, day) DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens
      `).run(companyId, keyId, userId, day, requests, tokens)
    },
    pruneUsage(beforeDay) {
      return conn.prepare('DELETE FROM broker_usage WHERE day < ?').run(beforeDay).changes
    },
    history(companyId, limit) {
      return (conn.prepare(`
        SELECT id, key_id, action, changed_at, changed_by, change FROM broker_history
        WHERE company_id = ? ORDER BY changed_at DESC, rowid DESC LIMIT ?
      `).all(companyId, limit) as Array<{ id: string; key_id: string | null; action: string; changed_at: string; changed_by: string; change: string }>)
        .map(r => ({ id: r.id, keyId: r.key_id, action: r.action, changedAt: r.changed_at, changedBy: r.changed_by, change: r.change }))
    },
  }
}

type TokenRow = {
  id: string; company_id: string; user_id: string; token_hash: string; services: string; department: string | null
  conversation_id: string; created_at: string; expires_at: string; revoked_at: string | null
}

/** SQLite storage of the broker's short-lived tokens (only their sha256 is stored). */
export function sqliteBrokerTokenRepository(conn: Database.Database): BrokerTokenRepository {
  return {
    insert(row) {
      conn.prepare(`
        INSERT INTO broker_tokens (id, company_id, user_id, token_hash, services, department, conversation_id, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.companyId, row.userId, row.tokenHash, row.services, row.department, row.conversationId, row.createdAt, row.expiresAt, row.revokedAt)
    },
    findByHash(tokenHash) {
      const r = conn.prepare('SELECT * FROM broker_tokens WHERE token_hash = ?').get(tokenHash) as TokenRow | undefined
      return r ? {
        id: r.id, companyId: r.company_id, userId: r.user_id, tokenHash: r.token_hash, services: r.services, department: r.department,
        conversationId: r.conversation_id, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
      } : null
    },
    revoke(companyId, userId, tokenId, at) {
      return conn.prepare('UPDATE broker_tokens SET revoked_at = ? WHERE company_id = ? AND user_id = ? AND id = ? AND revoked_at IS NULL')
        .run(at, companyId, userId, tokenId).changes > 0
    },
    revokeAll(companyId, userId, at) {
      return userId === null
        ? conn.prepare('UPDATE broker_tokens SET revoked_at = ? WHERE company_id = ? AND revoked_at IS NULL AND expires_at > ?').run(at, companyId, at).changes
        : conn.prepare('UPDATE broker_tokens SET revoked_at = ? WHERE company_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?').run(at, companyId, userId, at).changes
    },
    countLive(companyId, userId, now) {
      return (conn.prepare('SELECT COUNT(*) AS n FROM broker_tokens WHERE company_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?')
        .get(companyId, userId, now) as { n: number }).n
    },
    pruneExpired(before) {
      return conn.prepare('DELETE FROM broker_tokens WHERE expires_at < ?').run(before).changes
    },
  }
}
