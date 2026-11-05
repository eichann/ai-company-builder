/**
 * The relay's read-only default (audit B-M6, `.claude/rules/key-broker.md` "HubSpot and the
 * read-only relay"): a service nobody chose for reads only — except an AI model's API — and the
 * migration keeps what companies had chosen before.
 *
 * Guards:
 * - `brokerRelayReadOnlyByDefault`: HubSpot and any registered service read only; Gemini, OpenAI
 *   and Anthropic (their POSTs are the model calls) do not;
 * - `migrateBrokerSettings` on rows from before: a registered (generic) service keeps writing as
 *   it did, a service that was read-only stays so, a service with a key already registered keeps
 *   writing (today's use is not broken), a built-in one nobody chose and nobody uses takes the default;
 * - the adapter answers `readOnly: null` for "never chosen" and keeps a choice once made.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { migrateBrokerSettings } from '../../src/db/schema/broker'
import { sqliteKeyBrokerRepository } from '../../src/adapters/sqlite/key-broker'
import { brokerRelayReadOnlyByDefault } from '../../../shared/core/key-broker'

const TS = '2026-11-05T00:00:00.000Z'
const change = (n: number) => ({ id: `h${n}`, changedAt: TS, changedBy: 'u', keyId: null, action: 'read-only', change: '{}' })

describe('the read-only default (audit B-M6)', () => {
  it('every service reads only unless it is an AI model\'s API', () => {
    for (const s of ['hubspot', 'crm', 'notion']) expect(brokerRelayReadOnlyByDefault(s)).toBe(true)
    for (const s of ['gemini', 'openai', 'anthropic']) expect(brokerRelayReadOnlyByDefault(s)).toBe(false)
  })

  it('rows from before the default: a registered service keeps writing, a read-only one stays, the rest take the default', () => {
    const conn = new Database(':memory:')
    initDatabase(conn)
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u', TS, TS)
    conn.exec('ALTER TABLE broker_services DROP COLUMN read_only_set')
    const row = conn.prepare(`INSERT INTO broker_services (company_id, service, category, rule, own_key_hosts, relay, read_only, updated_at, updated_by)
      VALUES ('a', ?, 'tool', 'company-first', '[]', ?, ?, ?, 'u')`)
    row.run('crm', JSON.stringify({ label: 'CRM', host: 'api.crm.example.com', basePath: '', header: 'authorization', format: 'Bearer {key}' }), 0, TS)
    row.run('hubspot', null, 0, TS)
    row.run('gemini', null, 0, TS)
    row.run('notion', JSON.stringify({ label: 'N', host: 'api.notion.example.com', basePath: '', header: 'authorization', format: 'Bearer {key}' }), 1, TS)
    // Company b already uses HubSpot (a key, no row: its settings were the defaults) — e.g. a skill
    // that writes deals through the relay before the plugin is on: it keeps working.
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('b', 'b', 'b', 'u', TS, TS)
    const key = conn.prepare(`INSERT INTO broker_keys (id, company_id, scope, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id,
      destinations, audience, caps, created_at, created_by, updated_at, updated_by, secret_updated_at) VALUES (?, ?, 'company', ?, 'k', '1234', 's', 'c', 'n', 't', 'w', 'kek', '{}', '{}', '{}', ?, 'u', ?, 'u', ?)`)
    key.run('k1', 'b', 'hubspot', TS, TS, TS)
    key.run('k2', 'b', 'openai', TS, TS, TS)
    migrateBrokerSettings(conn)
    migrateBrokerSettings(conn)
    const repo = sqliteKeyBrokerRepository(conn)
    const got = Object.fromEntries(repo.services('a').map(s => [s.service, s.readOnly]))
    expect(got).toEqual({ crm: false, hubspot: null, gemini: null, notion: true })
    expect(repo.services('b').map(s => [s.service, s.readOnly, s.category, s.rule])).toEqual([['hubspot', false, 'system', 'company-only']])

    // A choice made now is kept as a choice.
    const hub = repo.services('a').find(s => s.service === 'hubspot')!
    repo.saveService('a', { ...hub, readOnly: false }, change(1))
    expect(repo.services('a').find(s => s.service === 'hubspot')!.readOnly).toBe(false)
    repo.saveService('a', { ...hub, readOnly: null }, change(2))
    expect(repo.services('a').find(s => s.service === 'hubspot')!.readOnly).toBeNull()
  })
})
