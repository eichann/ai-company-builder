/**
 * The key broker's vault on a real SQLite schema (services/broker-vault.ts +
 * adapters/sqlite/key-broker.ts): the database never holds a key in plain
 * text, a row copied to another company does not open, the listing the admin
 * API is built from carries no sealed secret, moving to a new KEK keeps every
 * key readable, and without a KEK the broker refuses instead of storing.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteKeyBrokerRepository } from '../../src/adapters/sqlite/key-broker'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'
import { BrokerDisabledError, createBrokerVault } from '../../src/services/broker-vault'
import type { BrokerKeyRow } from '../../src/ports/key-broker'

const FAKE_KEY = 'fake-test-key-NOT-REAL-vault-0123456789'

function world(kek = randomBytes(32)) {
  const conn = new Database(':memory:')
  initDatabase(conn)
  const at = new Date().toISOString()
  for (const id of ['c1', 'c2']) {
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', at, at)
  }
  const brokerKeys = sqliteKeyBrokerRepository(conn)
  const vault = createBrokerVault({ brokerKeys, brokerCipher: { enabled: true, cipher: localSecretCipher(kek) } })
  return { conn, brokerKeys, vault, kek, at }
}

function row(companyId: string, id: string, at: string, kekId: string): BrokerKeyRow {
  return {
    id, companyId, scope: 'company', ownerUserId: null, service: 'gemini', displayName: 'Gemini', last4: FAKE_KEY.slice(-4),
    destinations: '{"hosts":["generativelanguage.googleapis.com"],"pathPrefixes":[],"models":[]}',
    audience: '{"everyone":true,"departmentIds":[],"addUserIds":[],"removeUserIds":[]}', caps: '{}',
    allowPrivateContent: false, status: 'active', kekId, createdAt: at, createdBy: 'u', updatedAt: at, updatedBy: 'u', secretUpdatedAt: at,
  }
}

async function store(w: ReturnType<typeof world>, companyId: string, keyId: string) {
  const sealed = await w.vault.seal(companyId, keyId, FAKE_KEY)
  w.brokerKeys.insert(row(companyId, keyId, w.at, sealed.kekId), sealed, { id: `h-${keyId}`, changedAt: w.at, changedBy: 'u', keyId, action: 'create', change: '{}' })
}

describe('the broker vault', () => {
  it('stores keys sealed: no table holds the value, the listing has no secret, the relay can reveal it', async () => {
    const w = world()
    await store(w, 'c1', 'k1')
    const dump = (w.conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(t => JSON.stringify(w.conn.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n')
    expect(dump).not.toContain('NOT-REAL')
    const listed = JSON.stringify(w.brokerKeys.list('c1'))
    expect(listed).not.toMatch(/ciphertext|wrapped|nonce/)
    expect(await w.vault.reveal('c1', 'k1')).toBe(FAKE_KEY)
    expect(await w.vault.reveal('c1', 'missing')).toBeNull()
  })

  it('a sealed row copied into another company does not open there', async () => {
    const w = world()
    await store(w, 'c1', 'k1')
    const sealed = w.brokerKeys.sealed('c1', 'k1')!
    w.brokerKeys.insert(row('c2', 'k1-copy', w.at, sealed.kekId), sealed, { id: 'h-copy', changedAt: w.at, changedBy: 'u', keyId: 'k1-copy', action: 'create', change: '{}' })
    await expect(w.vault.reveal('c2', 'k1-copy')).rejects.toThrow()
  })

  it('a new KEK: rewrapAll keeps every key readable without the old KEK, ciphertext unchanged', async () => {
    const w = world()
    await store(w, 'c1', 'k1')
    await store(w, 'c2', 'k2')
    const before = w.brokerKeys.sealed('c1', 'k1')!
    const newKek = randomBytes(32)
    const rotating = createBrokerVault({ brokerKeys: w.brokerKeys, brokerCipher: { enabled: true, cipher: localSecretCipher(newKek, [w.kek]) } })
    expect(await rotating.rewrapAll()).toEqual({ rewrapped: 2, current: 0, failed: 0 })
    expect(await rotating.rewrapAll()).toEqual({ rewrapped: 0, current: 2, failed: 0 })
    const after = w.brokerKeys.sealed('c1', 'k1')!
    expect(after.ciphertext).toBe(before.ciphertext)
    expect(w.brokerKeys.find('c1', 'k1')!.kekId).toBe(after.kekId)
    const onlyNew = createBrokerVault({ brokerKeys: w.brokerKeys, brokerCipher: { enabled: true, cipher: localSecretCipher(newKek) } })
    expect(await onlyNew.reveal('c1', 'k1')).toBe(FAKE_KEY)
    expect(await onlyNew.reveal('c2', 'k2')).toBe(FAKE_KEY)
  })

  it('without a KEK the broker is off and says why; nothing is sealed or revealed', async () => {
    const w = world()
    const off = createBrokerVault({ brokerKeys: w.brokerKeys, brokerCipher: { enabled: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is not set' } })
    expect(off.status()).toEqual({ enabled: false, reason: 'not-configured', detail: 'BROKER_KEK_FILE is not set' })
    await expect(off.seal('c1', 'k', FAKE_KEY)).rejects.toBeInstanceOf(BrokerDisabledError)
    await expect(off.reveal('c1', 'k')).resolves.toBeNull()
  })
})
