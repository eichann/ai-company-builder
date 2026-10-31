/**
 * The state engine (stage 4-3/4-4/4-5, services/record-engine.ts) on the
 * real schema behind real company handles, with the core `task` type.
 *
 * Guards:
 * - an action runs only from its `from` states, and only for whom its `who`
 *   names; an AI cannot do what the type does not let AI do (the AI cannot
 *   complete a task on its own);
 * - a note is required where the type says so;
 * - state and ledger are written together, with before/after for the state
 *   and every server field changed; a stale `expectedVersion` changes nothing;
 * - an undo is a new entry, refused when something changed since;
 * - any version of a record can be replayed from the ledger;
 * - the engine tells exactly whom the action names (never the actor, never
 *   another company), and writes the milestone line only on milestones;
 * - attached files must exist at the given commit; decision fields only on
 *   decision actions, materials only what the actor may read;
 * - 「あなたの番」 collects every type implementing `request`, not final ones;
 * - one company cannot act on, read or replay another's records.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import type { Member } from '../../src/services/access'
import { replayRecordState } from '../../../shared/core/record-ledger'

const TS = '2026-10-31T00:00:00.000Z'
const COMMIT = 'c'.repeat(40)
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let notified: Array<[string, string[]]>
let lines: Array<{ companyId: string; path: string; line: string }>
let tick = 0
const at = () => `2026-11-01T00:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory']
const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const owner = (co = 'a') => m('u-owner', co, 'owner')
const ai = { kind: 'ai', source: 'claude' }

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

// The route decides the actor from the credential (session → human, record token → ai);
// these tests pass it the way the routes do, from the `actor` written next to each call.
type Body = Record<string, unknown>
const actorOf = (body: unknown) => ((body as Body | null)?.actor as { kind: 'human' | 'ai'; source?: string } | undefined) ?? { kind: 'human' as const }
const act = (member: Member, id: string, action: string, body: Body) => engine.act(member, actorOf(body), id, action, body)
const create = (member: Member, body: Body) => engine.create(member, actorOf(body), body)
const undo = (member: Member, id: string, body: Body) => engine.undo(member, actorOf(body), id, body)

/** A replayed version without its origin (the entry that made it). */
function replayed<T extends { origin: unknown }>(r: { ok: true; value: T } | { ok: false; body: unknown }): Omit<T, 'origin'> {
  const rest: Partial<T> = { ...ok(r) }
  delete rest.origin
  return rest as Omit<T, 'origin'>
}

/** A task requested by alice, assigned to bob. */
function newTask(co = 'a', extra: Record<string, unknown> = {}) {
  return ok(create(m('u-alice', co), { type: 'task', title: '提案書を作る', fields: { assignee: 'u-bob' }, ...extra })).record
}

beforeEach(() => {
  tick = 0
  notified = []
  lines = []
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: at, nowMs: () => 0 }
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock,
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: {
      appendHistoryLine: async (companyId, _repo, path, line) => { lines.push({ companyId, path, line }); return true },
      fileAtCommit: async (_c, _r, _p, commit) => commit === COMMIT,
    },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null),
    notify: (companyId, userIds) => notified.push([companyId, userIds]),
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  company('a')
  company('b')
})

describe('duties 1 and 2: from where, and who', () => {
  it('a task starts in todo with its requester and next actor', () => {
    const t = newTask()
    expect(t).toMatchObject({ state: 'todo', version: 1, fields: { requested_by: 'u-alice', assignee: 'u-bob', next_actor: 'u-bob' } })
  })

  it('an action outside its from states is refused and changes nothing', async () => {
    const t = newTask()
    const r = await act(m('u-bob'), t.id, 'complete', { expectedVersion: 1 })
    expect(r).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'ACTION_NOT_ALLOWED_IN_STATE' } })
    expect(source.forCompany('a').records.ledger(t.id)).toHaveLength(1)
  })

  it('only whom `who` names may act; the AI may only where the type says ai', async () => {
    const t = newTask()
    expect(await act(m('u-mallory'), t.id, 'start', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1, actor: ai }))
    ok(await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' }, actor: ai }))
    // complete: who = requested_by, reviewer — no ai: carol's AI cannot, carol can.
    const byAi = await act(m('u-carol'), t.id, 'complete', { expectedVersion: 3, actor: ai })
    expect(byAi).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED' } })
    // An owner is not in `who` either: roles do not bypass the type.
    expect(await act(owner(), t.id, 'complete', { expectedVersion: 3 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await act(m('u-carol'), t.id, 'complete', { expectedVersion: 3 })).record.state).toBe('done')
  })

  it('a note is required where the type says so', async () => {
    const t = newTask()
    expect(await act(m('u-alice'), t.id, 'cancel', { expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOTE_REQUIRED' } })
    expect(ok(await act(m('u-alice'), t.id, 'cancel', { expectedVersion: 1, note: '方針が変わった' })).record.state).toBe('cancelled')
  })

  it('a person argument must be a member of the company', async () => {
    const t = newTask()
    expect(await act(m('u-bob'), t.id, 'assign', { expectedVersion: 1, args: { assignee: 'u-stranger' }, note: 'x' })).toMatchObject({ ok: false, body: { code: 'BAD_VALUE' } })
  })
})

describe('duty 3: state and ledger together', () => {
  it('each entry holds before/after of the state and every field it changed; the version goes up by one', async () => {
    const t = newTask()
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    const r = ok(await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' }, note: '見てください' }))
    expect(r.record.version).toBe(3)
    expect(r.entry).toMatchObject({ version: 3, action: 'request_review', fromState: 'in_progress', toState: 'review', actorId: 'u-bob', actorKind: 'human', note: '見てください' })
    const byField = (a: { field: string }, b: { field: string }) => (a.field < b.field ? -1 : 1)
    expect([...r.entry.changes].sort(byField)).toEqual([
      { field: 'next_actor', before: 'u-bob', after: 'u-carol' },
      { field: 'reviewer', before: null, after: 'u-carol' },
      { field: 'state', before: 'in_progress', after: 'review' },
    ])
  })

  it('a stale expectedVersion is refused ("someone changed it first") and nothing is written', async () => {
    const t = newTask()
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    const late = await act(m('u-bob'), t.id, 'wait', { expectedVersion: 1, args: { waiting_on: '先方の返事' } })
    expect(late).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'VERSION_CONFLICT', version: 2 } })
    expect(source.forCompany('a').records.ledger(t.id).map(e => e.version)).toEqual([1, 2])
  })

  it('undo appends a reversing entry; it is refused once something changed since', async () => {
    const t = newTask()
    ok(await act(m('u-bob'), t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-08' } }))
    ok(await act(m('u-bob'), t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-15' } }))
    expect(undo(m('u-bob'), t.id, { version: 2, expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'CHANGED_SINCE' } })
    expect(undo(m('u-mallory'), t.id, { version: 3, expectedVersion: 3 })).toMatchObject({ ok: false, kind: 'forbidden' })
    const undone = ok(undo(m('u-bob'), t.id, { version: 3, expectedVersion: 3, note: '日付を間違えた' }))
    expect(undone.entry).toMatchObject({ action: 'undo', version: 4, reversesVersion: 3, changes: [{ field: 'due', before: '2026-11-15', after: '2026-11-08' }] })
    expect(undone.record.fields.due).toBe('2026-11-08')
    expect(source.forCompany('a').records.ledger(t.id)).toHaveLength(4)
  })
})

describe('replaying a record’s past (§13.11)', () => {
  it('every version is the fold of the ledger up to it', async () => {
    const t = newTask()
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    ok(await act(m('u-bob'), t.id, 'assign', { expectedVersion: 2, args: { assignee: 'u-carol' }, note: '担当交代' }))
    ok(await act(m('u-carol'), t.id, 'set_due', { expectedVersion: 3, args: { due: '2026-12-01' } }))
    expect(replayed(engine.atVersion(m('u-mallory'), t.id, '1'))).toEqual({ version: 1, state: 'todo', fields: { requested_by: 'u-alice', assignee: 'u-bob', next_actor: 'u-bob' } })
    expect(replayed(engine.atVersion(m('u-mallory'), t.id, '3'))).toEqual({ version: 3, state: 'in_progress', fields: { requested_by: 'u-alice', assignee: 'u-carol', next_actor: 'u-carol' } })
    const latest = replayed(engine.atVersion(m('u-mallory'), t.id, '4'))
    const stored = source.forCompany('a').records.states([t.id])[0]
    expect(latest).toEqual({ version: stored.version, state: stored.state, fields: JSON.parse(stored.fields) })
    expect(engine.atVersion(m('u-mallory'), t.id, '5')).toMatchObject({ ok: false, body: { code: 'VERSION_NOT_FOUND' } })
  })

  it('a gap in the ledger is an error, never a different version', () => {
    const entries = [{ version: 1, changes: [{ field: 'state', before: null, after: 'todo' }] }, { version: 3, changes: [] }]
    expect(() => replayRecordState(entries as never, 3)).toThrow()
  })
})

describe('duties 4 and 5: whom to tell, the milestone line', () => {
  it('tells whom the action names and whose turn it is, never the actor', async () => {
    const t = newTask()
    expect(notified).toEqual([['a', ['u-bob']]])
    notified = []
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    expect(notified).toEqual([])
    ok(await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' } }))
    expect(notified).toEqual([['a', ['u-carol']]])
  })

  it('writes the history line on milestones of file records only, with ids, not names', async () => {
    const t = newTask()
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    ok(await act(m('u-alice'), t.id, 'complete', { expectedVersion: 2 }))
    expect(lines).toEqual([]) // server-only: no file to write to
    // The task gets its file (0.6): the index adopts it.
    sqliteTransactions(conn).run(() => applyRecordChanges(source.forCompany('a').records, {
      repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: source.forCompany('a').scopes.listWithRules(),
      changes: [{ path: '営業部/タスク/提案書.md', text: `---\nid: ${t.id}\ntype: task\n---\n# 提案書を作る\n` }],
    }))
    ok(await act(m('u-alice'), t.id, 'reopen', { expectedVersion: 3 }))
    expect(lines).toEqual([]) // reopen is not a milestone
    ok(await act(m('u-alice'), t.id, 'cancel', { expectedVersion: 4, note: '不要になった' }))
    expect(lines).toEqual([{ companyId: 'a', path: '営業部/タスク/提案書.md', line: expect.stringMatching(/^2026-11-01 中止する（u-alice）：不要になった$/) }])
  })
})

describe('attachments and decisions', () => {
  it('attached files must be linked and exist at the commit; the version is kept in the entry', async () => {
    const t = newTask('a', { links: { files: ['営業部/提案書.md'] } })
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    const unsynced = await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' }, attachments: [{ link: 'files', path: '営業部/提案書.md', commit: 'd'.repeat(40) }] })
    expect(unsynced).toMatchObject({ ok: false, body: { code: 'ATTACHMENT_NOT_SYNCED' } })
    const unlinked = await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' }, attachments: [{ link: 'files', path: '経理/給与.md', commit: COMMIT }] })
    expect(unlinked).toMatchObject({ ok: false, body: { code: 'BAD_ATTACHMENT' } })
    const r = ok(await act(m('u-bob'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' }, attachments: [{ link: 'files', path: '営業部/提案書.md', commit: COMMIT }] }))
    expect(r.entry.attachments).toEqual([{ link: 'files', path: '営業部/提案書.md', commit: COMMIT }])
  })

  it('decision fields only on decision actions; materials are references the actor may read', async () => {
    const t = newTask()
    const other = newTask()
    ok(await act(m('u-bob'), t.id, 'start', { expectedVersion: 1 }))
    expect(await act(m('u-bob'), t.id, 'wait', { expectedVersion: 2, args: { waiting_on: 'x' }, decision: { materials: [] } })).toMatchObject({ ok: false })
    expect(await act(m('u-alice'), t.id, 'complete', { expectedVersion: 2, decision: { materials: [{ kind: 'record', id: other.id, version: 9 }] } }))
      .toMatchObject({ ok: false, body: { code: 'BAD_MATERIAL' } })
    const r = ok(await act(m('u-alice'), t.id, 'complete', {
      expectedVersion: 2, note: '品質に問題なし',
      decision: { materials: [{ kind: 'record', id: other.id, version: 1 }, { kind: 'file', path: '営業部/提案書.md', commit: COMMIT }], precedents: [`${other.id}@1`], policyVersion: 'review-policy@3' },
    }))
    expect(r.entry).toMatchObject({ isDecision: true, decision: { reason: '品質に問題なし', policyVersion: 'review-policy@3', precedents: [`${other.id}@1`], supersedes: null } })
  })
})

describe('「あなたの番」 across types implementing request', () => {
  it('collects every request type waiting for the member, not final ones, not others’', async () => {
    // A second type implementing request: the list needs no change for it.
    const approval = `---\nlabel: 承認\nversion: 1\nimplements: [request]\nstorage: server\nfields:\n  requested_by: { label: 依頼, kind: person, source: server }\n  assignee: { label: 担当, kind: person, source: server }\n  next_actor: { label: 次, kind: person, source: server }\n  waiting_on: { label: 待ち, kind: text, source: server }\n  due: { label: 期限, kind: date, source: server }\nstates: [asked, approved]\nfinal: [approved]\nactions:\n  approve: { label: 承認する, from: [asked], to: approved, who: [assignee] }\n---\n`
    sqliteTransactions(conn).run(() => applyRecordChanges(source.forCompany('a').records, {
      repoKey: 'company', scopeId: null, prefix: '', full: false, tip: 'a'.repeat(40), at: at(), scopes: [], changes: [{ path: '.acb/types/approval.md', text: approval }],
    }))
    const t1 = newTask()
    const t2 = newTask()
    const ap = ok(create(m('u-alice'), { type: 'approval', title: '値引きの承認', fields: { assignee: 'u-bob' } })).record
    newTask('b') // another company's task for bob: never here
    ok(await act(m('u-bob'), t2.id, 'start', { expectedVersion: 1 }))
    ok(await act(m('u-bob'), t2.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-carol' } }))
    ok(await act(m('u-alice'), t1.id, 'cancel', { expectedVersion: 1, note: 'やめる' }))
    const ids = (r: { records: Array<{ id: string }> }) => r.records.map(x => x.id).sort()
    expect(ids(ok(service.myTurn(m('u-bob'))))).toEqual([ap.id])
    expect(ids(ok(service.myTurn(m('u-carol'))))).toEqual([t2.id])
    ok(await act(m('u-bob'), ap.id, 'approve', { expectedVersion: 1 }))
    expect(ok(service.myTurn(m('u-bob'))).total).toBe(0)
  })
})

describe('an assignee must be able to see the record', () => {
  it('is refused on create and on assign when they cannot read its place, without naming the place', async () => {
    // 営業部/評価: a private folder only u-carol may read; 経理: closed to u-mallory by scope rules.
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('a-priv', 'a', '営業部/評価', 'folder', 'a-repo', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-e', 'a-priv', 'everyone', NULL, 0, 0, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-priv-c', 'a-priv', 'user', 'u-carol', 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-acc', 'a', '経理', 'folder', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-e', 'a-acc', 'everyone', NULL, 1, 1, ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-acc-m', 'a-acc', 'user', 'u-mallory', 0, 0, ?)").run(TS)

    const refused = create(owner(), { type: 'task', title: '経理の締め', folder: '経理', fields: { assignee: 'u-mallory' } })
    expect(refused).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'ASSIGNEE_CANNOT_READ' } })
    expect(ok(create(owner(), { type: 'task', title: '経理の締め', folder: '経理', fields: { assignee: 'u-bob' } })).record.fields.assignee).toBe('u-bob')

    // A task whose file is in the private folder (indexed from its repository).
    const id = 'task-priv0001'
    sqliteTransactions(conn).run(() => applyRecordChanges(source.forCompany('a').records, {
      repoKey: 'scope:a-priv', scopeId: 'a-priv', prefix: '営業部/評価', full: false, tip: 'b'.repeat(40), at: at(),
      scopes: source.forCompany('a').scopes.listWithRules(), changes: [{ path: '評価.md', text: `---\nid: ${id}\ntype: task\n---\n# 評価のまとめ\n` }],
    }))
    const r = await act(owner(), id, 'assign', { expectedVersion: 0, args: { assignee: 'u-bob' }, note: '担当を決める' })
    expect(r).toMatchObject({ ok: false, body: { code: 'ASSIGNEE_CANNOT_READ' } })
    // The answer never names where the record is.
    expect(JSON.stringify(r)).not.toMatch(/評価|営業部/)
    expect(source.forCompany('a').records.ledger(id)).toHaveLength(0)
    expect(ok(await act(owner(), id, 'assign', { expectedVersion: 0, args: { assignee: 'u-carol' }, note: '担当を決める' })).record.fields.assignee).toBe('u-carol')
  })
})

describe('across companies', () => {
  it('one company cannot act on, read the history of, or replay another’s record', async () => {
    const theirs = newTask('b')
    const missing = await act(owner('a'), 'task-zzzzzzzz', 'start', { expectedVersion: 1 })
    expect(await act(m('u-bob', 'a'), theirs.id, 'start', { expectedVersion: 1 })).toEqual(missing)
    expect(engine.history(owner('a'), theirs.id)).toEqual(engine.history(owner('a'), 'task-zzzzzzzz'))
    expect(engine.atVersion(owner('a'), theirs.id, '1')).toEqual(engine.atVersion(owner('a'), 'task-zzzzzzzz', '1'))
    expect(undo(owner('a'), theirs.id, { version: 1, expectedVersion: 1 })).toEqual(undo(owner('a'), 'task-zzzzzzzz', { version: 1, expectedVersion: 1 }))
    expect(source.forCompany('b').records.ledger(theirs.id)).toHaveLength(1)
  })
})
