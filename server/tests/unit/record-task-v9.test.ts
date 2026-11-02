/**
 * Task version 9 (owner decision 2026-11-02 「着手しないで完了にできる」, records.md "Task version 9").
 *
 * Guards (each fails when its part of the definition, the engine or the migration is removed):
 * - 完了 from 未着手 by the assignee, nothing made up in between (no start entry), the requester
 *   told and able to reopen (やり直す) — 知らせるだけ, also when the field is empty;
 * - never from 準備中 (the AI's turn): 「自分で進める」 first;
 * - 確かめてから (`who_unless`): the assignee cannot complete without stating an OK, hands it over
 *   with 「終わったので見てもらう」 from 未着手, and the checker's OK completes it;
 * - 完了 from 引き受け待ち by the assignee records 「引き受けた」 in the same entry; anyone else's
 *   完了 does not;
 * - only the requester (or an admin) decides 終わったら — never the assignee, never the AI;
 * - `who_unless` is parsed strictly (an entry of `who`, a server choice field, one of its options);
 * - startup moves every task to version 9 (the core definition stored first), once, without a
 *   ledger entry, and leaves other types and other companies' rows alone.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, migrateTaskVersion } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes, currentTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'
import { TASK_VERSION } from '../../../shared/core/core-types'
import { actionWho, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-02T00:00:00.000Z'
const MEMBERS: Record<string, string[]> = { a: ['u-owner', 'u-alice', 'u-bob', 'u-carol'], b: ['u-owner', 'u-zed'] }
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let notified: Array<[string, string[]]>
let autoAccept = true

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: userId === 'u-owner' ? 'owner' : 'member' })
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

/** A task alice asks bob for (未着手), with these fields. */
function asked(fields: Record<string, unknown> = {}, state?: string) {
  return ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書を作る', ...(state ? { state } : {}), fields: { assignee: 'u-bob', ...fields } })).record
}

const ledger = (id: string, co = 'a') => source.forCompany(co).records.ledger(id)

beforeEach(() => {
  notified = []
  autoAccept = true
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let n = 0
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => `2026-11-02T01:00:${String(n++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (co, userId) => (MEMBERS[co] ?? []).includes(userId),
    roleOf: (co, userId) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null),
    notify: (companyId, userIds) => notified.push([companyId, userIds]),
    autoAccepts: () => autoAccept,
  })
  company('a')
  company('b')
})

describe('知らせるだけ: the assignee completes from any state', () => {
  it('from 未着手, with no start made up; the requester is told and may reopen', async () => {
    for (const fields of [{}, { when_done: 'notify' }]) {
      const t = asked(fields)
      notified = []
      const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 1 }))
      expect(r.record.state).toBe('done')
      expect(ledger(t.id).map(e => [e.action, e.fromState, e.toState])).toEqual([['create', null, 'todo'], ['complete', 'todo', 'done']])
      expect(notified).toEqual([['a', ['u-alice']]])
      // An OK statement is not asked here (it would claim an OK that decided nothing).
      const reopened = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'reopen', { expectedVersion: 2, note: 'もう少し直してください' }))
      expect(reopened.record).toMatchObject({ state: 'in_progress', fields: { next_actor: 'u-bob' } })
    }
  })

  it('from 返事待ち too, but never from 準備中 (the AI’s turn): 「自分で進める」 first', async () => {
    const w = asked()
    ok(await engine.act(m('u-bob'), HUMAN, w.id, 'wait', { expectedVersion: 1, args: { waiting_on: '先方の返事' } }))
    expect(ok(await engine.act(m('u-bob'), HUMAN, w.id, 'complete', { expectedVersion: 2 })).record.state).toBe('done')

    const p = asked({}, 'preparing')
    expect(await engine.act(m('u-bob'), HUMAN, p.id, 'complete', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'ACTION_NOT_ALLOWED_IN_STATE' } })
    expect(ledger(p.id)).toHaveLength(1)
    ok(await engine.act(m('u-bob'), HUMAN, p.id, 'take_over', { expectedVersion: 1 }))
    expect(ok(await engine.act(m('u-bob'), HUMAN, p.id, 'complete', { expectedVersion: 2 })).record.state).toBe('done')
  })

  it('the AI never completes', async () => {
    const t = asked()
    expect(await engine.act(m('u-bob'), AI, t.id, 'complete', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
  })
})

describe('確かめてから: the checker’s OK completes it', () => {
  it('the assignee hands it over from 未着手 and the checker completes', async () => {
    const t = asked({ when_done: 'check', reviewer: 'u-carol' })
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'OK_REQUIRED' } })
    expect(ledger(t.id)).toHaveLength(1)
    notified = []
    const handed = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'request_review', { expectedVersion: 1, args: { reviewer: 'u-carol' } }))
    expect(handed.record).toMatchObject({ state: 'review', fields: { next_actor: 'u-carol' } })
    expect(notified).toEqual([['a', ['u-carol']]])
    notified = []
    const done = ok(await engine.act(m('u-carol'), HUMAN, t.id, 'complete', { expectedVersion: 2 }))
    expect(done.entry).toMatchObject({ action: 'complete', actorId: 'u-carol', fromState: 'review', toState: 'done' })
    expect(notified).toEqual([['a', ['u-alice']]])
  })

  it('switching to 知らせるだけ gives the assignee 完了 back; only the requester decides it', async () => {
    const t = asked({ when_done: 'check' })
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'set_when_done', { expectedVersion: 1, args: { when_done: 'notify' } })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await engine.act(m('u-alice'), AI, t.id, 'set_when_done', { expectedVersion: 1, args: { when_done: 'notify' } })).toMatchObject({ ok: false, kind: 'forbidden' })
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_when_done', { expectedVersion: 1, args: { when_done: 'notify' } }))
    expect(ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2 })).record.state).toBe('done')
  })
})

describe('完了 from 引き受け待ち', () => {
  it('by the assignee records 「引き受けた」 in the same entry', async () => {
    autoAccept = false
    const t = asked()
    expect(t.state).toBe('awaiting_acceptance')
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 1 }))
    expect(r.record).toMatchObject({ state: 'done', fields: { accepted_by: 'u-bob' } })
    expect(r.entry.changes).toEqual(expect.arrayContaining([{ field: 'state', before: 'awaiting_acceptance', after: 'done' }, { field: 'accepted_by', before: null, after: 'u-bob' }]))
    expect(ledger(t.id).map(e => e.action)).toEqual(['create', 'complete'])
  })

  it('by the requester does not say the assignee accepted', async () => {
    autoAccept = false
    const t = asked()
    const r = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'complete', { expectedVersion: 1 }))
    expect(r.record.state).toBe('done')
    expect(r.record.fields.accepted_by ?? null).toBeNull()
  })
})

describe('who_unless in a definition', () => {
  const def = (whoUnless: string) => `---\nlabel: 依頼\nversion: 1\nfields:\n  assignee: { label: 担当, kind: person, source: server }\n  mode: { label: 型, kind: choice, options: [a, b], source: server }\n  memo: { label: メモ, kind: text, source: server }\nstates: [open, done]\nactions:\n  finish: { label: 終える, from: [open], to: done, who: [assignee, admin], who_unless: ${whoUnless} }\n---\n`

  it('names an entry of who, a server choice field and one of its options', () => {
    const good = parseTypeFile('memo_type', def('{ assignee: { mode: b } }'))
    if (!good.ok) throw new Error(good.errors.join('\n'))
    const finish = good.definition.actions.finish
    expect(actionWho(finish, { mode: 'b' })).toEqual(['admin'])
    expect(actionWho(finish, { mode: 'a' })).toEqual(['assignee', 'admin'])
    expect(actionWho(finish, {})).toEqual(['assignee', 'admin'])
    for (const bad of ['{ ai: { mode: b } }', '{ assignee: { memo: b } }', '{ assignee: { mode: c } }', '{ assignee: {} }', '[assignee]']) {
      expect(parseTypeFile('memo_type', def(bad)).ok, bad).toBe(false)
    }
  })
})

describe('startup moves every task to version 9', () => {
  /** Company `co` as it was before: task stored at version 8 only, its tasks indexed under 8. */
  function asBefore(co: string) {
    const json = (conn.prepare("SELECT definition FROM record_types WHERE company_id = ? AND name = 'task' AND version = ?").get(co, TASK_VERSION) as { definition: string }).definition
    conn.prepare("DELETE FROM record_types WHERE company_id = ? AND name = 'task' AND version >= 9").run(co)
    conn.prepare("INSERT INTO record_types (company_id, name, version, definition, source, commit_sha, created_at) VALUES (?, 'task', 8, ?, 'core', NULL, ?)")
      .run(co, JSON.stringify({ ...JSON.parse(json), version: 8 }), TS)
    conn.prepare("UPDATE records SET type_version = 8 WHERE company_id = ? AND type = 'task'").run(co)
  }
  const versionOf = (co: string, id: string) => (conn.prepare('SELECT type_version AS v FROM records WHERE company_id = ? AND id = ?').get(co, id) as { v: number }).v

  it('stores the core definition first, moves the tasks once, with no ledger entry', () => {
    const t = asked()
    const other = ok(engine.create(m('u-zed', 'b'), HUMAN, { type: 'task', title: 'B社の', fields: { assignee: 'u-zed' } })).record
    asBefore('a')
    asBefore('b')
    conn.prepare("UPDATE records SET type_version = 9 WHERE company_id = 'b'").run()
    expect(currentTypes(source.forCompany('a').records).get('task')?.definition.version).toBe(8)

    migrateTaskVersion(conn)
    expect(versionOf('a', t.id)).toBe(TASK_VERSION)
    expect(currentTypes(source.forCompany('a').records).get('task')?.definition.version).toBe(TASK_VERSION)
    expect(ledger(t.id)).toHaveLength(1)
    expect(versionOf('b', other.id)).toBe(TASK_VERSION)
    const stored = () => (conn.prepare("SELECT COUNT(*) AS n FROM record_types WHERE name = 'task' AND version = ?").get(TASK_VERSION) as { n: number }).n
    expect(stored()).toBe(2)
    migrateTaskVersion(conn) // a second start changes nothing
    expect(stored()).toBe(2)
  })

  it('leaves a company without the task type as it is', () => {
    conn.prepare("DELETE FROM record_types WHERE company_id = 'b'").run()
    migrateTaskVersion(conn)
    expect((conn.prepare("SELECT COUNT(*) AS n FROM record_types WHERE company_id = 'b'").get() as { n: number }).n).toBe(0)
  })
})
