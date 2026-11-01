/**
 * Schema changes of milestone 3 on a database made by an earlier build
 * (db/index.ts), each a one-time rebuild that keeps every row:
 * - record_types.source gains 'plugin' (a connector plugin's types);
 * - plugin_installs.key_id becomes ON DELETE SET NULL, so deleting the key a
 *   plugin uses is never blocked (better-sqlite3 enforces foreign keys) and
 *   the plugin is left without a key.
 * - plugin_operations (milestone 4 creates): record_id / external_id may be
 *   null until known (set once), plus replaced_by / approved_by.
 * Running them again changes nothing.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migratePluginInstallKeyReference, migratePluginOperationCreates, migratePluginTables, migrateRecordTypeSources } from '../../src/db'

const BEFORE = `
  CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, repo_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE record_types (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('file', 'core')),
    commit_sha TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, name, version)
  );
`
const insert = (conn: Database.Database, company: string, name: string, version: number, source: string) =>
  conn.prepare('INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(company, name, version, '{}', source, '2026-10-31T00:00:00.000Z')

describe('record_types source migration', () => {
  it('keeps every stored version, then accepts plugin types; idempotent', () => {
    const conn = new Database(':memory:')
    conn.exec(BEFORE)
    for (const id of ['a', 'b']) conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'u', 'x', 'x')").run(id, id, id)
    insert(conn, 'a', 'task', 1, 'core')
    insert(conn, 'b', 'deal', 2, 'file')
    expect(() => insert(conn, 'a', 'deal', 1, 'plugin')).toThrow(/CHECK/)
    const before = conn.prepare('SELECT * FROM record_types ORDER BY company_id, name').all()
    migrateRecordTypeSources(conn)
    expect(conn.prepare('SELECT * FROM record_types ORDER BY company_id, name').all()).toEqual(before)
    insert(conn, 'a', 'deal', 1, 'plugin')
    migrateRecordTypeSources(conn)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM record_types').get()).toEqual({ n: 3 })
  })

  it('a fresh database accepts plugin types', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('a', 'a', 'a', 'u', 'x', 'x')").run()
    expect(() => insert(conn, 'a', 'deal', 1, 'plugin')).not.toThrow()
  })
})

describe('plugin_installs key reference migration', () => {
  it('a deleted key leaves the install without one; rows and mappings survive the rebuild', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    // The shape of the first P4 build: key_id without ON DELETE SET NULL.
    conn.transaction(() => {
      conn.pragma('defer_foreign_keys = ON')
      const sql = (conn.prepare("SELECT sql FROM sqlite_master WHERE name = 'plugin_installs'").get() as { sql: string }).sql
      conn.exec('DROP TABLE plugin_installs')
      conn.exec(sql.replace(' ON DELETE SET NULL', ''))
    })()
    migratePluginTables(conn)
    conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('a', 'a', 'a', 'u', 'x', 'x')").run()
    conn.prepare(`INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag,
      wrapped_key, kek_id, destinations, audience, caps, allow_private_content, status, created_at, created_by, updated_at, updated_by, secret_updated_at)
      VALUES ('k', 'a', 'company', NULL, 'hubspot', 'k', 'abcd', 's', x'00', x'00', x'00', x'00', 'local:0', '{}', '{}', '{}', 0, 'active', 'x', 'u', 'x', 'u', 'x')`).run()
    conn.prepare(`INSERT INTO plugin_installs (company_id, plugin_id, version, fingerprint, service, connection_id, enabled, key_id, mapping_version, updated_at, updated_by)
      VALUES ('a', 'p', '0.1.0', 'f', 'hubspot', 'c', 1, 'k', 1, 'x', 'u')`).run()
    conn.prepare("INSERT INTO plugin_mappings (company_id, plugin_id, version, text, created_at, created_by) VALUES ('a', 'p', 1, 'deal: {}', 'x', 'u')").run()
    expect(() => conn.prepare("DELETE FROM broker_keys WHERE id = 'k'").run()).toThrow(/FOREIGN KEY/)

    migratePluginInstallKeyReference(conn)
    migratePluginTables(conn)
    migratePluginInstallKeyReference(conn)
    conn.prepare("DELETE FROM broker_keys WHERE id = 'k'").run()
    expect(conn.prepare('SELECT key_id, mapping_version FROM plugin_installs').get()).toEqual({ key_id: null, mapping_version: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM plugin_mappings').get()).toEqual({ n: 1 })
    // The triggers are back: a key that is not the company's is still refused.
    expect(() => conn.prepare("UPDATE plugin_installs SET key_id = 'nope' WHERE plugin_id = 'p'").run()).toThrow(/same company/)
  })
})

describe('plugin_operations for creates (milestone 4)', () => {
  const COLS = `company_id, id, plugin_id, operation, plugin_version, fingerprint, mapping_version, connection_id, account_id, object, external_id, record_id,
    actor_id, actor_kind, state, fields, written, previous, created_at, updated_at`
  const op = (conn: Database.Database, id: string, record: string | null, externalId: string | null) =>
    conn.prepare(`INSERT INTO plugin_operations (${COLS}) VALUES ('a', ?, 'p', 'log_meeting', '0.1.0', 'f', 1, 'c', '9', 'meeting', ?, ?, 'u', 'human', 'pending', '{}', '{}', '{}', 'x', 'x')`)
      .run(id, externalId, record)

  it('an old table is rebuilt with its rows; a create may name its record and outside object once, never another company\'s record', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    // The shape of milestone 3: record_id and external_id NOT NULL, no replaced_by / approved_by.
    conn.transaction(() => {
      conn.pragma('defer_foreign_keys = ON')
      const sql = (conn.prepare("SELECT sql FROM sqlite_master WHERE name = 'plugin_operations'").get() as { sql: string }).sql
      conn.exec('DROP TABLE plugin_operations')
      conn.exec(sql.replace('external_id TEXT,', 'external_id TEXT NOT NULL,').replace('record_id TEXT,', 'record_id TEXT NOT NULL,')
        .replace(/replaced_by TEXT,\s*approved_by TEXT,/, ''))
    })()
    migratePluginTables(conn)
    for (const id of ['a', 'b']) conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'u', 'x', 'x')").run(id, id, id)
    for (const [co, id] of [['a', 'deal-a'], ['a', 'deal-a2'], ['b', 'deal-b']]) {
      conn.prepare("INSERT INTO records (company_id, id, type, created_at, updated_at) VALUES (?, ?, 'deal', 'x', 'x')").run(co, id)
    }
    op(conn, 'old-1', 'deal-a', '1')
    expect(() => op(conn, 'old-2', null, null)).toThrow(/NOT NULL/)

    migratePluginOperationCreates(conn)
    migratePluginTables(conn)
    migratePluginOperationCreates(conn)
    expect(conn.prepare("SELECT record_id, external_id, replaced_by, approved_by FROM plugin_operations WHERE id = 'old-1'").get())
      .toEqual({ record_id: 'deal-a', external_id: '1', replaced_by: null, approved_by: null })
    // A create of a record: no record, no outside id yet.
    op(conn, 'new-1', null, null)
    expect(() => conn.prepare("UPDATE plugin_operations SET record_id = 'deal-b' WHERE id = 'new-1'").run()).toThrow(/keeps its company/)
    conn.prepare("UPDATE plugin_operations SET record_id = 'deal-a2', external_id = '77' WHERE id = 'new-1'").run()
    expect(() => conn.prepare("UPDATE plugin_operations SET record_id = 'deal-a' WHERE id = 'new-1'").run()).toThrow(/keeps its company/)
    expect(() => conn.prepare("UPDATE plugin_operations SET external_id = '78' WHERE id = 'new-1'").run()).toThrow(/keeps its company/)
    // Another company's record is refused on insert too.
    expect(() => op(conn, 'new-2', 'deal-b', null)).toThrow(/same company/)
  })
})
