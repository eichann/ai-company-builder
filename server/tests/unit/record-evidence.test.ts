/**
 * Evidence on a record — a decision's materials, precedents / supersedes and an action's attached
 * versions — and private folders (records.md "Evidence", services/record-engine/evidence.ts;
 * code review RECORDS-1). 経緯 hands evidence to every reader of the record, so:
 *
 * Guards:
 * - on write, a file inside a private folder is refused as material of a record outside it, even
 *   for a member who reads the folder — the same answer as a file they cannot read, naming no place,
 *   nothing written; a record inside a private folder likewise; an attached version of a link into
 *   a private folder (a link stored before the rule) likewise;
 * - on read, each entry shows only the evidence the reader reads now: a private folder's file is
 *   left out for anyone outside the folder (also when the folder was made private after the entry)
 *   and kept for its readers and for owners / admins; a record material / precedent / supersedes the
 *   reader cannot read (another member's owner-only record) is left out; someone else's `.personal/`
 *   path is left out; nothing stands in for what was left out; the stored ledger is unchanged;
 * - owner-only and members-only records keep their own reading rule (owners / admins not listed get
 *   the missing record's answer, history included).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { applyRecordChanges, ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import type { Member } from '../../src/services/access'

const TS = '2026-10-31T00:00:00.000Z'
const COMMIT = 'c'.repeat(40)
const PRIVATE = '営業部/評価'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let tick = 0
const at = () => `2026-11-01T00:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`

const PEOPLE = ['u-owner', 'u-admin', 'u-alice', 'u-bob', 'u-carol', 'u-mallory']
const m = (userId: string, role = 'member'): Member => ({ companyId: 'a', userId, role })
const owner = () => m('u-owner', 'owner')
const admin = () => m('u-admin', 'admin')

type Body = Record<string, unknown>
const act = (member: Member, id: string, action: string, body: Body) => engine.act(member, { kind: 'human' }, id, action, body)
const create = (member: Member, body: Body) => engine.create(member, { kind: 'human' }, body)

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const rule = (id: string, scope: string, subject: string, userId: string | null, read: number) =>
  conn.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, subject, userId, read, read, TS)

/** 営業部/評価 becomes a private folder only u-carol reads (owners / admins read every one). */
function makePrivate() {
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('a-priv', 'a', ?, 'folder', 'a-repo', ?)").run(PRIVATE, TS)
  rule('a-priv-e', 'a-priv', 'everyone', null, 0)
  rule('a-priv-c', 'a-priv', 'user', 'u-carol', 1)
}

const MEMO_TYPE = `---
label: メモ
version: 1
storage: file
fields:
  assignee: { label: 担当, kind: person, source: server }
states: [open, closed]
initial: open
actions:
  close: { label: 閉じる, from: [open], to: closed, who: [anyone] }
---
`

function index(changes: Record<string, string>, scope?: { id: string; prefix: string }) {
  sqliteTransactions(conn).run(() => applyRecordChanges(source.forCompany('a').records, {
    repoKey: scope ? `scope:${scope.id}` : 'company', scopeId: scope?.id ?? null, prefix: scope?.prefix ?? '', full: false, tip: 'a'.repeat(40), at: at(),
    scopes: source.forCompany('a').scopes.listWithRules(), changes: Object.entries(changes).map(([path, text]) => ({ path, text })),
  }))
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  engine = createRecordEngine({
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: at, nowMs: () => 0 },
    ids: { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') },
    files: { appendHistoryLine: async () => true, fileAtCommit: async (_c, _r, _p, commit) => commit === COMMIT },
    managedFolders: () => [],
    isMember: (_c, userId) => PEOPLE.includes(userId),
    roleOf: (_c, userId) => (userId === 'u-owner' ? 'owner' : userId === 'u-admin' ? 'admin' : PEOPLE.includes(userId) ? 'member' : null),
    notify: () => {},
  })
  conn.prepare("INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES ('a', 'a', 'a', 'u-owner', ?, ?)").run(TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  rule('a-root-r', 'a-root', 'everyone', null, 1)
  // 経理: closed to u-carol by scope rules (an ordinary unreadable place, not a private folder).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-acc', 'a', '経理', 'folder', ?)").run(TS)
  rule('a-acc-e', 'a-acc', 'everyone', null, 1)
  rule('a-acc-c', 'a-acc', 'user', 'u-carol', 0)
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
})

/** A company-wide task alice asked u-carol (who reads the private folder) to do. */
const sharedTask = (extra: Body = {}) => ok(create(m('u-alice'), { type: 'task', title: '評価を反映する', fields: { assignee: 'u-carol' }, ...extra })).record
const historyOf = (member: Member, id: string) => engine.history(member, id)
const ledgerOf = (id: string) => source.forCompany('a').records.ledger(id)
const fileMaterial = (path: string) => ({ decision: { materials: [{ kind: 'file', path, commit: COMMIT }] } })

describe('writing evidence', () => {
  it('a private folder’s file is never material of a record outside it — one answer with an unreadable file, nothing written', async () => {
    makePrivate()
    const t = sharedTask()
    const inPrivate = await act(m('u-carol'), t.id, 'complete', { expectedVersion: 1, ...fileMaterial(`${PRIVATE}/査定.md`) })
    const unreadable = await act(m('u-carol'), t.id, 'complete', { expectedVersion: 1, ...fileMaterial('経理/給与.md') })
    expect(inPrivate).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'BAD_MATERIAL' } })
    expect(inPrivate).toEqual(unreadable)
    expect(JSON.stringify(inPrivate)).not.toMatch(/評価|営業部|査定/)
    expect(ledgerOf(t.id)).toHaveLength(1)
    // An owner reads every private folder, and is refused the same way.
    const t2 = ok(create(owner(), { type: 'task', title: '評価を反映する', fields: { assignee: 'u-carol' } })).record
    expect(await act(owner(), t2.id, 'complete', { expectedVersion: 1, ...fileMaterial(`${PRIVATE}/査定.md`) })).toEqual(inPrivate)
    // A file outside it is still taken.
    ok(await act(m('u-carol'), t.id, 'complete', { expectedVersion: 1, ...fileMaterial('営業部/提案書.md') }))
  })

  it('a record inside a private folder is never material of a record outside it, even for its reader', async () => {
    makePrivate()
    index({ '.acb/types/memo.md': MEMO_TYPE })
    index({ '評価.md': '---\nid: memo-priv0001\ntype: memo\n---\n# 評価のまとめ\n' }, { id: 'a-priv', prefix: PRIVATE })
    // u-carol reads it, and it has a version 1 (a material names a version the record has had).
    ok(await act(m('u-carol'), 'memo-priv0001', 'close', { expectedVersion: 0 }))
    const t = sharedTask()
    const r = await act(m('u-carol'), t.id, 'complete', { expectedVersion: 1, decision: { materials: [{ kind: 'record', id: 'memo-priv0001', version: 1 }] } })
    expect(r).toMatchObject({ ok: false, body: { code: 'BAD_MATERIAL' } })
    expect(r).toEqual(await act(m('u-carol'), t.id, 'complete', { expectedVersion: 1, decision: { materials: [{ kind: 'record', id: 'memo-nothere01', version: 1 }] } }))
    expect(ledgerOf(t.id)).toHaveLength(1)
  })

  it('an attached version of a link into a private folder (stored before the rule) is refused like a file not linked', async () => {
    // Linked while 営業部/評価 was an ordinary folder; it became private afterwards.
    const t = sharedTask({ links: { files: [`${PRIVATE}/査定.md`] } })
    makePrivate()
    ok(await act(m('u-carol'), t.id, 'start', { expectedVersion: 1 }))
    const attach = (path: string) => act(m('u-carol'), t.id, 'request_review', { expectedVersion: 2, args: { reviewer: 'u-alice' }, attachments: [{ link: 'files', path, commit: COMMIT }] })
    const r = await attach(`${PRIVATE}/査定.md`)
    expect(r).toMatchObject({ ok: false, body: { code: 'BAD_ATTACHMENT' } })
    expect(r).toEqual(await attach('営業部/ない.md'))
    expect(JSON.stringify(r)).not.toMatch(/評価|査定/)
    expect(ledgerOf(t.id)).toHaveLength(2)
  })
})

describe('reading evidence (経緯)', () => {
  /** Evidence written while 営業部/評価 was an ordinary folder; then it is made private. */
  async function writtenThenPrivate() {
    const t = sharedTask({ links: { files: [`${PRIVATE}/査定.md`, '営業部/提案書.md'] } })
    const mine = ok(create(m('u-alice'), { type: 'task', title: '自分のメモ', personal: true })).record
    ok(await act(m('u-carol'), t.id, 'start', { expectedVersion: 1 }))
    ok(await act(m('u-carol'), t.id, 'request_review', {
      expectedVersion: 2, args: { reviewer: 'u-alice' },
      attachments: [{ link: 'files', path: `${PRIVATE}/査定.md`, commit: COMMIT }, { link: 'files', path: '営業部/提案書.md', commit: COMMIT }],
    }))
    ok(await act(m('u-alice'), t.id, 'complete', {
      expectedVersion: 3, note: '評価どおり',
      decision: {
        materials: [
          { kind: 'file', path: `${PRIVATE}/査定.md`, commit: COMMIT }, { kind: 'file', path: '営業部/提案書.md', commit: COMMIT },
          { kind: 'file', path: '営業部/.personal/alice-メモ.md', commit: COMMIT }, { kind: 'record', id: mine.id, version: 1 },
        ],
        precedents: [`${mine.id}@1`], supersedes: `${mine.id}@1`,
      },
    }))
    makePrivate()
    return { t, mine }
  }
  const evidenceOf = (member: Member, id: string) => ok(historyOf(member, id)).entries.filter(e => e.attachments.length > 0 || e.decision !== null)
    .map(e => ({ action: e.action, attachments: e.attachments, decision: e.decision && { materials: e.decision.materials, precedents: e.decision.precedents, supersedes: e.decision.supersedes } }))
  const paths = (member: Member, id: string) => evidenceOf(member, id).flatMap(e => [
    ...e.attachments.map(a => ('path' in a ? a.path : a.kind)),
    ...(e.decision?.materials ?? []).map(x => (x.kind === 'file' ? x.path : x.kind)),
  ])

  it('a reader outside the private folder gets no trace of its file; its readers, owners and admins keep the whole trail', async () => {
    const { t, mine } = await writtenThenPrivate()
    const stored = JSON.stringify(ledgerOf(t.id))
    expect(evidenceOf(m('u-bob'), t.id)).toEqual([
      { action: 'request_review', attachments: [{ link: 'files', path: '営業部/提案書.md', commit: COMMIT }], decision: null },
      { action: 'complete', attachments: [], decision: { materials: [{ kind: 'file', path: '営業部/提案書.md', commit: COMMIT }], precedents: [], supersedes: null } },
    ])
    expect(JSON.stringify(historyOf(m('u-bob'), t.id))).not.toMatch(/評価\/|査定|alice-メモ/)
    // Every entry is still there (only the evidence is narrowed), and nothing stands in for what was left out.
    expect(ok(historyOf(m('u-bob'), t.id)).entries.map(e => e.version)).toEqual([1, 2, 3, 4])

    // u-carol reads the folder, and owners / admins read every one: its file stays (alice's .personal/ file and owner-only record do not).
    const whole = [`${PRIVATE}/査定.md`, '営業部/提案書.md', `${PRIVATE}/査定.md`, '営業部/提案書.md']
    for (const who of [m('u-carol'), owner(), admin()]) expect(paths(who, t.id)).toEqual(whole)
    // alice wrote the entry: her own .personal/ file and her owner-only record (and its references) are hers to see.
    expect(evidenceOf(m('u-alice'), t.id)[1].decision).toEqual({
      materials: [
        { kind: 'file', path: '営業部/提案書.md', commit: COMMIT }, { kind: 'file', path: '営業部/.personal/alice-メモ.md', commit: COMMIT },
        { kind: 'record', id: mine.id, version: 1 },
      ],
      precedents: [`${mine.id}@1`], supersedes: `${mine.id}@1`,
    })
    // Nobody else ever sees the owner-only record's id — not owners or admins either.
    for (const who of [m('u-bob'), m('u-carol'), owner(), admin()]) expect(JSON.stringify(historyOf(who, t.id))).not.toContain(mine.id)
    // What is stored is unchanged.
    expect(JSON.stringify(ledgerOf(t.id))).toBe(stored)
  })

  it('follows the reader’s current access: added to the folder later sees its file, taken off no longer does', async () => {
    const { t } = await writtenThenPrivate()
    rule('a-priv-b', 'a-priv', 'user', 'u-bob', 1)
    expect(paths(m('u-bob'), t.id)).toContain(`${PRIVATE}/査定.md`)
    conn.prepare("DELETE FROM scope_rules WHERE id = 'a-priv-c'").run()
    expect(JSON.stringify(historyOf(m('u-carol'), t.id))).not.toMatch(/評価\/|査定/)
  })

  it('owner-only and members-only records keep their own reading rule, history included', async () => {
    const listed = ok(create(m('u-carol'), { type: 'task', title: '面談の準備', members: ['u-alice'], fields: { assignee: 'u-carol' } })).record
    ok(await act(m('u-carol'), listed.id, 'complete', { expectedVersion: 1, ...fileMaterial('営業部/提案書.md') }))
    const missing = historyOf(owner(), 'task-zzzzzzzzzzzzzzzz')
    for (const who of [owner(), admin(), m('u-bob')]) expect(historyOf(who, listed.id)).toEqual(missing)
    expect(paths(m('u-alice'), listed.id)).toEqual(['営業部/提案書.md'])
    const mine = ok(create(m('u-carol'), { type: 'task', title: '自分だけ', personal: true })).record
    ok(await act(m('u-carol'), mine.id, 'complete', { expectedVersion: 1, ...fileMaterial('営業部/提案書.md') }))
    for (const who of [owner(), admin(), m('u-alice')]) expect(historyOf(who, mine.id)).toEqual(missing)
    expect(paths(m('u-carol'), mine.id)).toEqual(['営業部/提案書.md'])
  })
})
