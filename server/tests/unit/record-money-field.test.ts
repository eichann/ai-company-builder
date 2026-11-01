/**
 * A money field (`money: true`, plugins.md "Money") in the record engine.
 *
 * Guard: a create cannot fill a money field — money is written only through
 * an approval request (a plugin operation), never directly by the engine; the
 * type's other fields are filled as before.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
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

beforeEach(() => {
  const conn = new Database(':memory:')
  initDatabase(conn)
  const source = sqliteCompanyData(conn)
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => TS, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (_c, userId) => userId === 'u-owner',
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : null),
    notify: () => {},
  })
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
