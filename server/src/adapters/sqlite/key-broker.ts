/** SQLite storage of the key broker's vault, service rules, setting and history (ports/key-broker.ts). */
import type Database from 'better-sqlite3'
import type { BrokerChangeRow, BrokerKeyRepository, BrokerKeyRow, StoredBrokerService } from '../../ports/key-broker'
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
      return (conn.prepare('SELECT service, category, rule, own_key_hosts, updated_at, updated_by FROM broker_services WHERE company_id = ? ORDER BY service')
        .all(companyId) as Array<{ service: string; category: string; rule: string; own_key_hosts: string; updated_at: string; updated_by: string }>)
        .map((r): StoredBrokerService => ({ service: r.service, category: r.category, rule: r.rule, ownKeyHosts: r.own_key_hosts, updatedAt: r.updated_at, updatedBy: r.updated_by }))
    },
    saveService(companyId, s, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO broker_services (company_id, service, category, rule, own_key_hosts, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(company_id, service) DO UPDATE SET category = excluded.category, rule = excluded.rule,
            own_key_hosts = excluded.own_key_hosts, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, s.service, s.category, s.rule, s.ownKeyHosts, s.updatedAt, s.updatedBy)
        addHistory(companyId, change)
      })()
    },
    settings(companyId) {
      const r = conn.prepare('SELECT member_keys_allowed, updated_at, updated_by FROM broker_settings WHERE company_id = ?')
        .get(companyId) as { member_keys_allowed: number; updated_at: string; updated_by: string } | undefined
      return r ? { memberKeysAllowed: r.member_keys_allowed === 1, updatedAt: r.updated_at, updatedBy: r.updated_by } : null
    },
    saveSettings(companyId, s, change) {
      conn.transaction(() => {
        conn.prepare(`
          INSERT INTO broker_settings (company_id, member_keys_allowed, updated_at, updated_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(company_id) DO UPDATE SET member_keys_allowed = excluded.member_keys_allowed,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
        `).run(companyId, s.memberKeysAllowed ? 1 : 0, s.updatedAt, s.updatedBy)
        addHistory(companyId, change)
      })()
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
