/**
 * A money field (`money: true`, plugins.md "Money") in the record engine.
 *
 * Guards:
 * - a create cannot fill a money field — money is written only through an
 *   approval request (a plugin operation), never directly by the engine; the
 *   type's other fields are filled as before;
 * - the external writer is NOT blocked: amounts mirrored from the outside
 *   system (HubSpot is the source of truth for money) are created and updated
 *   freely. Extending the money block to it would stop imports.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createExternalRecordWriter, createRecordEngine, type ExternalRecordWriter, type RecordEngine } from '../../src/services/record-engine'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'
import type { Member } from '../../src/services/access'

const TS = '2026-11-01T00:00:00.000Z'
const owner: Member = { companyId: 'a', userId: 'u-owner', role: 'owner' }
const DEAL = `---
label: 案件
version: 1
storage: server
fields:
  next_step: { label: 次のアクション, kind: text, source: server }
  amount:    { label: 金額, kind: number, source: server, money: true }
states: [open]
---
`
let engine: RecordEngine
let external: ExternalRecordWriter

beforeEach(() => {
  const conn = new Database(':memory:')
  initDatabase(conn)
  const source = sqliteCompanyData(conn)
  const deps = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => TS, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    isMember: (_c: string, userId: string) => userId === 'u-owner',
    notify: () => {},
  }
  engine = createRecordEngine({
    ...deps,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : null),
  })
  external = createExternalRecordWriter(deps)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const def = parseTypeFile('deal', DEAL)
  if (!def.ok) throw new Error(def.errors.join('\n'))
  records.insertTypeVersion({ name: 'deal', version: 1, definition: canonicalTypeJson(def.definition), source: 'file', commitSha: null, createdAt: TS })
})

describe('a money field in the record engine', () => {
  it('a create cannot fill it; the other fields are filled as before', () => {
    const withAmount = engine.create(owner, { kind: 'human' }, { type: 'deal', title: '案件A', fields: { next_step: '見積', amount: 1000000 } })
    expect(withAmount).toMatchObject({ ok: false, body: { code: 'MONEY_NEEDS_APPROVAL' } })
    const without = engine.create(owner, { kind: 'human' }, { type: 'deal', title: '案件A', fields: { next_step: '見積' } })
    expect(without.ok, JSON.stringify(without)).toBe(true)
  })
})

describe('a money field mirrored from the outside system', () => {
  const receipt = {
    plugin: 'sample-sales', pluginVersion: '0.1.0', fingerprint: 'f', mappingVersion: 1, connectionId: 'c', accountId: '1',
    object: 'deal', externalId: '1000000001', externalUpdatedAt: null, operationId: null, kind: 'observed' as const,
  }
  const mirror = (recordId: string | null, amount: number) => external.apply('a', {
    recordId, type: 'deal', folder: null, title: '案件A', fields: { amount }, links: {}, action: 'sample-sales.import', source: 'sample-sales', receipt,
  })

  it('creates and updates the amount without an approval (the outside system is the source of truth)', () => {
    const created = mirror(null, 1000000)
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, created: true, problems: [] })
    if (!created.ok) return
    expect(created.entry?.changes).toContainEqual({ field: 'amount', before: null, after: 1000000 })
    const updated = mirror(created.recordId, 1200000)
    expect(updated).toMatchObject({ ok: true, changed: true, problems: [] })
    if (updated.ok) expect(updated.entry?.changes).toEqual([{ field: 'amount', before: 1000000, after: 1200000 }])
  })
})
