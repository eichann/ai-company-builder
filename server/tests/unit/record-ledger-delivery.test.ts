/**
 * The ledger's delivery order (records.md "Delivery order", stage 4-0 of event-triggered jobs; owner memo
 * 「出来事で動く定期の仕事」 §3-1, §10-3). Event-triggered jobs (4a) read the ledger "after number N"; a row
 * without a number would be missed for ever, a number given twice would run twice.
 *
 * Guards (each mutation-checked):
 * - no module but adapters/sqlite/record-ledger-write.ts inserts into record_ledger (source scan of server/src);
 * - every write path numbers its row in the insert's transaction, per company, growing: the engine (create, act,
 *   undo), the service writer (a scheduled job's やること), the external writer, the startup migrations;
 * - the origin mark: a migration's rows `migration`, the server's own actors' `system`, a person's / AI's none;
 * - rows written before (or by an older build) stay NULL and are never renumbered; the counter carries on;
 * - a company archive restores the numbers and the counter as they were; the counter ends above every stored
 *   number even when the archive lost it; an archive from before has NULL rows.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateBundleParts, migrateOutsideTimes } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { restoreCompanyRows } from '../../src/adapters/sqlite/company-archive'
import { restoreLedgerSequence } from '../../src/adapters/sqlite/record-ledger-write'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createExternalRecordWriter, createRecordEngine, createServiceRecordWriter, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'
import { MIGRATION_ACTOR } from '../../../shared/core/core-types'
import { JOB_ACTOR } from '../../../shared/core/jobs'
import { ledgerOriginOf } from '../../../shared/core/record-ledger'

const TS = '2026-11-18T00:00:00.000Z'
const PEOPLE = ['u-owner', 'u-alice', 'u-bob']
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine

const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const clock = { now: () => TS, nowMs: () => Date.parse(TS) }
let n = 0
const ids = { newId: () => `id-${n++}`, newToken: () => (n++).toString(16).padStart(16, '0') }
const base = () => ({
  companyData: source, transactions: sqliteTransactions(conn), clock, ids,
  isMember: (_c: string, u: string) => PEOPLE.includes(u),
  roleOf: (_c: string, u: string) => (u === 'u-owner' ? 'owner' : PEOPLE.includes(u) ? 'member' : null),
  notify: () => {},
})

function company(c: Database.Database, id: string) {
  c.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  c.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  c.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
}

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

/** The company's ledger rows in the order they were inserted. */
const rows = (c: Database.Database, co: string) => c.prepare('SELECT record_id, action, actor_id, delivery_seq, origin FROM record_ledger WHERE company_id = ? ORDER BY rowid')
  .all(co) as Array<{ record_id: string; action: string; actor_id: string; delivery_seq: number | null; origin: string | null }>

beforeEach(() => {
  n = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  for (const co of ['a', 'b']) {
    company(conn, co)
    const records = source.forCompany(co).records
    records.setEnabled(true, 'u-owner', TS)
    ensureCoreTypes(records, TS)
  }
  engine = createRecordEngine({
    ...base(),
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => false },
    managedFolders: () => [],
  })
})

describe('one writer of the ledger', () => {
  it('no module but record-ledger-write.ts inserts into record_ledger', () => {
    const src = resolve(__dirname, '../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(src)
    // Any spelling of an insert or a replace into the table itself (not record_ledger_seq).
    const insert = /\b(?:INSERT|REPLACE)\b(?:\s+OR\s+\w+)?\s+INTO\s+["`[]?record_ledger["`\]]?(?![\w])/i
    const writers = files.filter(f => insert.test(readFileSync(f, 'utf8'))).map(f => relative(src, f))
    expect(writers).toEqual(['adapters/sqlite/record-ledger-write.ts'])
  })
})

describe('every write path numbers its row', () => {
  it('the engine, the service writer and the external writer: one growing number per row, per company, in insert order', async () => {
    const t = ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } })).record
    ok(await engine.act(m('u-bob'), { kind: 'human' }, t.id, 'start', { expectedVersion: 1 }))
    ok(await engine.act(m('u-bob'), { kind: 'ai', source: 'claude' }, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-12-01' } }))
    ok(await engine.undo(m('u-bob'), { kind: 'human' }, t.id, { version: 2, expectedVersion: 3 }))
    // Another company's numbers are its own.
    ok(engine.create(m('u-alice', 'b'), { kind: 'human' }, { type: 'task', title: 'B社', fields: { assignee: 'u-bob' } }))
    const writer = createServiceRecordWriter(base())
    const made = writer.create('a', {
      type: 'task', title: '定期のやること', personalOwner: 'u-alice', fields: { assignee: 'u-alice' }, actor: { ...JOB_ACTOR, runId: 'run-1' }, quiet: true,
    })
    expect(made.ok).toBe(true)
    const external = createExternalRecordWriter(base())
    const seen = external.apply('a', {
      recordId: null, type: 'task', folder: null, title: '外から来たやること', fields: {}, links: {}, action: 'hubspot.import', source: 'hubspot',
      receipt: {
        plugin: 'hubspot', pluginVersion: '1.0.0', fingerprint: 'f', mappingVersion: 1, connectionId: 'c', accountId: 'acc', object: 'deal',
        outsideId: '1', outsideModifiedAt: TS, operationId: null, kind: 'observed',
      },
    } as never)
    const a = rows(conn, 'a')
    expect(seen.ok).toBe(true)
    expect(a.length).toBe(6) // create, start, set_due, undo; the job's やること; the import
    expect(a.map(r => r.delivery_seq)).toEqual(a.map((_, i) => i + 1))
    expect(rows(conn, 'b').map(r => r.delivery_seq)).toEqual([1])
    // The marks: a person's and an AI's change none, the job's (an `acb:` actor) system.
    expect(a.filter(r => r.actor_id !== JOB_ACTOR.id).every(r => r.origin === null)).toBe(true)
    expect(a.filter(r => r.actor_id === JOB_ACTOR.id).map(r => r.origin)).toEqual(['system'])
  })

  it('the startup migrations number their rows and mark them `migration`', () => {
    const q = conn.prepare.bind(conn)
    // A meeting of version 1 (meeting_at, no occurred_at) and one left in version 3's bundle part.
    q("INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES ('a', 'meeting-1', 'meeting', 1, 'x', ?, ?)").run(TS, TS)
    q("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', 'meeting-1', 'read', ?, 1, ?)").run(JSON.stringify({ meeting_at: TS }), TS)
    q("INSERT INTO records (company_id, id, type, type_version, title, created_at, updated_at) VALUES ('a', 'meeting-2', 'meeting', 3, 'y', ?, ?)").run(TS, TS)
    q("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES ('a', 'meeting-2', 'bundle_waiting', '{}', 1, ?)").run(TS)
    migrateOutsideTimes(conn)
    migrateBundleParts(conn)
    const a = rows(conn, 'a')
    expect(a.map(r => [r.record_id, r.delivery_seq, r.origin])).toEqual([['meeting-1', 1, 'migration'], ['meeting-2', 2, 'migration']])
    expect(ledgerOriginOf(MIGRATION_ACTOR.id)).toBe('migration')
  })

  it('rows from before (or an older build) stay NULL and are never renumbered; the counter carries on', async () => {
    const t = ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } })).record
    // An older build (rolled back) inserts without the new columns.
    conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, from_state, to_state, actor_id, actor_kind, at)
      VALUES ('a', ?, 2, 'start', 'todo', 'in_progress', 'u-bob', 'human', ?)`).run(t.id, TS)
    conn.prepare('UPDATE record_state SET version = 2, state = ? WHERE company_id = ? AND record_id = ?').run('in_progress', 'a', t.id)
    ok(await engine.act(m('u-bob'), { kind: 'human' }, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-12-01' } }))
    initDatabase(conn) // a restart: the migration again changes nothing
    expect(rows(conn, 'a').map(r => r.delivery_seq)).toEqual([1, null, 2])
  })

  it('a number is never given twice in a company (the unique index refuses it)', () => {
    ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } }))
    expect(() => conn.prepare(`INSERT INTO record_ledger (company_id, record_id, version, action, actor_id, actor_kind, at, delivery_seq)
      VALUES ('a', 'task-x', 1, 'create', 'u-bob', 'human', ?, 1)`).run(TS)).toThrow(/UNIQUE/)
  })
})

describe('a company archive keeps the numbers as they were', () => {
  async function exported(): Promise<Record<string, Array<Record<string, unknown>>>> {
    const t = ok(engine.create(m('u-alice'), { kind: 'human' }, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } })).record
    ok(await engine.act(m('u-bob'), { kind: 'human' }, t.id, 'start', { expectedVersion: 1 }))
    ok(await engine.act(m('u-bob'), { kind: 'human' }, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-12-01' } }))
    return JSON.parse(JSON.stringify(source.forCompany('a').archive.exportRows()))
  }
  function scratch(): Database.Database {
    const c = new Database(':memory:')
    initDatabase(c)
    company(c, 'z') // another company there already took numbers of its own
    c.prepare("INSERT INTO record_ledger_seq (company_id, next_seq) VALUES ('z', 500)").run()
    return c
  }
  const next = (c: Database.Database) => (c.prepare("SELECT next_seq FROM record_ledger_seq WHERE company_id = 'a'").get() as { next_seq: number } | undefined)?.next_seq

  it('restored rows keep their numbers and the counter; the next write takes the next one', async () => {
    const tables = await exported()
    const c = scratch()
    expect(restoreCompanyRows(c, 'a', tables)).toMatchObject({ ok: true })
    expect(rows(c, 'a').map(r => r.delivery_seq)).toEqual([1, 2, 3])
    expect(next(c)).toBe(4)
  })

  it('an archive that lost its counter row still ends above every stored number', async () => {
    const tables = await exported()
    delete tables.record_ledger_seq
    const c = scratch()
    expect(restoreCompanyRows(c, 'a', tables)).toMatchObject({ ok: true })
    expect(next(c)).toBe(4)
  })

  it('a counter archived higher than the rows is never lowered', async () => {
    const tables = await exported()
    tables.record_ledger_seq = [{ company_id: 'a', next_seq: 40 }]
    const c = scratch()
    expect(restoreCompanyRows(c, 'a', tables)).toMatchObject({ ok: true })
    expect(next(c)).toBe(40)
  })

  it('an archive from before delivery numbers restores its rows with none (never events)', async () => {
    const tables = await exported()
    delete tables.record_ledger_seq
    tables.record_ledger = tables.record_ledger.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'delivery_seq' && k !== 'origin')))
    const c = scratch()
    expect(restoreCompanyRows(c, 'a', tables)).toMatchObject({ ok: true })
    expect(rows(c, 'a').map(r => r.delivery_seq)).toEqual([null, null, null])
    expect(next(c)).toBeUndefined() // the first write there takes 1
    restoreLedgerSequence(c, 'a')
    expect(next(c)).toBeUndefined()
  })
})
