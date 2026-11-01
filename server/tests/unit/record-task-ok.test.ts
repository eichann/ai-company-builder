/**
 * Completing a task on someone's OK (owner decision 2026-11-01, core task
 * version 4, records.md "Completing on someone's OK"): the assignee may press
 * 完了 themselves when they say whose OK it was — a member who reads the
 * task, or a note for an OK from outside ACB. The requester / reviewer
 * complete as before; the AI never.
 *
 * Guards (each fails when its check in services/record-engine.ts or
 * shared/core/record-types.ts is removed):
 * - the assignee without an OK statement is refused and nothing is written;
 * - the OK cannot be the actor's own;
 * - the OK-giver must read the task; another company's member gets the same
 *   answer as an id nobody has, and no answer names the place;
 * - the AI cannot complete, with or without an OK statement;
 * - the requester's path is unchanged (and carries no OK statement);
 * - the OK-giver is told and may reopen (「取り消す」); the OK is cleared by
 *   the reopen, so it never vouches for a later change;
 * - `ok_from` needs the `ok_by` / `ok_note` fields; v4 is additive over v3.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'
import { CORE_TYPE_FILES } from '../../../shared/core/core-types'
import { compareTypeDefinitions, parseTypeFile, type TypeDefinition } from '../../../shared/core/record-types'
import { TASK_V4_TEXT } from '../helpers/task-v4'

const TS = '2026-11-01T00:00:00.000Z'
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory'],
  b: ['u-owner', 'u-zed'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let notified: Array<[string, string[]]>

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

/** A task requested by alice, assigned to bob, in progress (version 2), in `folder`. */
async function startedTask(folder?: string) {
  const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書を作る', ...(folder ? { folder } : {}), fields: { assignee: 'u-bob' } })).record
  ok(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
  notified = []
  return t
}

const ledger = (id: string) => source.forCompany('a').records.ledger(id)

beforeEach(() => {
  notified = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let n = 0
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => `2026-11-01T01:00:${String(n++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [],
    isMember: (co, userId) => (MEMBERS[co] ?? []).includes(userId),
    roleOf: (co, userId) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null),
    notify: (companyId, userIds) => notified.push([companyId, userIds]),
  })
  company('a')
  company('b')
})

describe('the assignee completes on someone’s OK', () => {
  it('is refused without an OK statement, and nothing is written', async () => {
    const t = await startedTask()
    for (const body of [{ expectedVersion: 2 }, { expectedVersion: 2, ok: {} }, { expectedVersion: 2, ok: { note: '  ' } }]) {
      expect(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', body)).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'OK_REQUIRED' } })
    }
    expect(ledger(t.id)).toHaveLength(2)
    // Someone the task does not name gets no OK path at all.
    expect(await engine.act(m('u-mallory'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } })).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
  })

  it('with a member’s OK: done, a decision naming the OK-giver, who is told', async () => {
    const t = await startedTask()
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol', note: 'Slack で OK' }, note: '仕上げました' }))
    expect(r.record).toMatchObject({ state: 'done', fields: { ok_by: 'u-carol', ok_note: 'Slack で OK' } })
    expect(r.entry).toMatchObject({ action: 'complete', actorId: 'u-bob', actorKind: 'human', isDecision: true, note: '仕上げました' })
    expect(r.entry.changes).toEqual(expect.arrayContaining([
      { field: 'state', before: 'in_progress', after: 'done' },
      { field: 'ok_by', before: null, after: 'u-carol' },
      { field: 'ok_note', before: null, after: 'Slack で OK' },
    ]))
    // The requester and the OK-giver, never the actor.
    expect(notified).toEqual([['a', ['u-alice', 'u-carol']]])
  })

  it('with an OK from outside ACB (a note only)', async () => {
    const t = await startedTask()
    const r = ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { note: '先方からメールで了承' } }))
    expect(r.record).toMatchObject({ state: 'done', fields: { ok_by: null, ok_note: '先方からメールで了承' } })
    expect(notified).toEqual([['a', ['u-alice']]])
  })

  it('the OK cannot be the actor’s own', async () => {
    const t = await startedTask()
    expect(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-bob' } })).toMatchObject({ ok: false, body: { code: 'OK_BY_SELF' } })
    expect(ledger(t.id)).toHaveLength(2)
  })

  it('the OK-giver must read the task; another company’s member is answered like nobody, no place named', async () => {
    // 経理: closed to u-mallory by scope rules.
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-acc', 'a', '経理', 'folder', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-e', 'a-acc', 'everyone', NULL, 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-m', 'a-acc', 'user', 'u-mallory', 0, 0, ?)").run(TS)
    const t = await startedTask('経理')
    const cannotRead = await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-mallory' } })
    expect(cannotRead).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'OK_BY_CANNOT_READ' } })
    expect(JSON.stringify(cannotRead)).not.toMatch(/経理/)
    const otherCompany = await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-zed' } })
    const nobody = await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-nobody' } })
    expect(otherCompany).toEqual(nobody)
    expect(otherCompany).toEqual(cannotRead)
    expect(ledger(t.id)).toHaveLength(2)
    expect(ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } })).record.state).toBe('done')
  })

  it('the AI cannot complete, with or without an OK statement', async () => {
    const t = await startedTask()
    for (const body of [{ expectedVersion: 2 }, { expectedVersion: 2, ok: { by: 'u-carol' } }, { expectedVersion: 2, ok: { note: '了承済み' } }]) {
      expect(await engine.act(m('u-bob'), AI, t.id, 'complete', body)).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
      expect(await engine.act(m('u-alice'), AI, t.id, 'complete', body)).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
    }
    expect(ledger(t.id)).toHaveLength(2)
  })

  it('the requester completes as before, with no OK statement', async () => {
    const t = await startedTask()
    expect(await engine.act(m('u-alice'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } })).toMatchObject({ ok: false, body: { code: 'OK_NOT_EXPECTED' } })
    const r = ok(await engine.act(m('u-alice'), HUMAN, t.id, 'complete', { expectedVersion: 2 }))
    expect(r.record.state).toBe('done')
    expect(r.entry.changes).toEqual([{ field: 'state', before: 'in_progress', after: 'done' }])
  })
})

describe('the OK-giver can take it back (reopen)', () => {
  it('reopens; the OK is cleared, so it does not vouch for a later change', async () => {
    const t = await startedTask()
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 2, ok: { by: 'u-carol' } }))
    // Not someone the task does not name.
    expect(await engine.act(m('u-mallory'), HUMAN, t.id, 'reopen', { expectedVersion: 3 })).toMatchObject({ ok: false, kind: 'forbidden' })
    notified = []
    const r = ok(await engine.act(m('u-carol'), HUMAN, t.id, 'reopen', { expectedVersion: 3, note: 'まだ直すところがあります' }))
    expect(r.record).toMatchObject({ state: 'in_progress', fields: { ok_by: null, next_actor: 'u-bob' } })
    expect(r.entry.changes).toEqual(expect.arrayContaining([{ field: 'ok_by', before: 'u-carol', after: null }]))
    expect(notified).toEqual([['a', ['u-bob']]])
    // Cancelled later by the requester: the earlier OK-giver can no longer reopen it.
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'cancel', { expectedVersion: 4, note: '不要になった' }))
    expect(await engine.act(m('u-carol'), HUMAN, t.id, 'reopen', { expectedVersion: 5 })).toMatchObject({ ok: false, kind: 'forbidden' })
  })
})

describe('the definition', () => {
  const v4 = () => (parseTypeFile('task', TASK_V4_TEXT) as { ok: true; definition: TypeDefinition }).definition

  it('task version 4 only adds to version 3 (existing tasks stay valid)', () => {
    const v3text = TASK_V4_TEXT
      .replace('version: 4', 'version: 3')
      .replace(/^ {2}ok_(by|note): .*\n/gm, '')
      .replace(' ok_from: [assignee], notify: [requested_by, ok_by],', ' notify: requested_by,')
      .replace('who: [requested_by, ok_by, admin]', 'who: [requested_by, admin]')
    const v3 = parseTypeFile('task', v3text)
    if (!v3.ok) throw new Error(v3.errors.join('\n'))
    expect(v3.definition.actions.complete.okFrom).toBeUndefined()
    expect(compareTypeDefinitions(v3.definition, v4())).toMatchObject({ breaking: [], versionProblem: null, changed: true })
    expect(v4().actions.complete.okFrom).toEqual(['assignee'])
    // …and the core definition in force keeps it.
    const current = (parseTypeFile('task', CORE_TYPE_FILES.task) as { ok: true; definition: TypeDefinition }).definition
    expect(current.actions.complete.okFrom).toEqual(['assignee'])
  })

  it('ok_from names person fields and needs the ok_by / ok_note fields', () => {
    const base = (fields: string, okFrom: string) => `---\nlabel: 依頼\nversion: 1\nfields:\n  assignee: { label: 担当, kind: person, source: server }\n${fields}states: [open, done]\nactions:\n  finish: { label: 終える, from: [open], to: done, who: [anyone], ok_from: ${okFrom} }\n---\n`
    const okFields = '  ok_by: { label: OKした人, kind: person, source: server }\n  ok_note: { label: いきさつ, kind: text, source: server }\n'
    expect(parseTypeFile('memo', base(okFields, '[assignee]')).ok).toBe(true)
    expect(parseTypeFile('memo', base('', '[assignee]')).ok).toBe(false)
    expect(parseTypeFile('memo', base(okFields, '[ai]')).ok).toBe(false)
  })
})
