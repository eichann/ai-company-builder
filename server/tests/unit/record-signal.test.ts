/**
 * The `records` push signal reaches every member who reads the changed record
 * now (services/record-signal.ts; notifications.md "The push signal"), on the
 * real schema, the real engine and the real push channel, wired as in
 * composition.ts.
 *
 * Guards (each fails when its part is removed):
 * - a reader who is not named on the record hears of its change (the widening:
 *   owner 2026-11-04, 「見られるだけの人にも」), also when the actor is the only
 *   person named;
 * - a member who cannot read it hears nothing: closed out of its folder, not a
 *   reader of its private folder, someone else's owner-only record (owners
 *   included), another company;
 * - the signal is `{ kind: 'records', version }` only — no record id, no content.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createPushChannel, type PushChannel } from '../../src/services/push-channel'
import { createRecordSignal, type RecordSignal } from '../../src/services/record-signal'
import type { Member } from '../../src/services/access'
import type { PushEvent } from '../../../shared/types/agent-stop'

const TS = '2026-11-01T00:00:00.000Z'
const MEMBERS: Record<string, string[]> = {
  a: ['u-owner', 'u-alice', 'u-bob', 'u-carol', 'u-mallory'],
  b: ['u-owner', 'u-alice', 'u-zed'],
}
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let push: PushChannel
let signal: RecordSignal

const roleOf = (co: string, userId: string) => ((MEMBERS[co] ?? []).includes(userId) ? (userId === 'u-owner' ? 'owner' : 'member') : null)
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: roleOf(co, userId) ?? 'member' })
const HUMAN = { kind: 'human' as const }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  for (const u of MEMBERS[id]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}-${u}`, u, id, roleOf(id, u), TS, TS)
  }
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 経理: everyone reads, until a rule closes it to someone.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '経理', 'folder', ?)").run(`${id}-acc`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-acc-e`, `${id}-acc`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

function closeAccounting(userId: string, co = 'a') {
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', ?, 0, 0, ?)").run(`${co}-acc-${userId}`, `${co}-acc`, userId, TS)
}

/** A private folder of company a read by these members only (owners and admins read every one). */
function privateFolder(id: string, path: string, readers: string[]) {
  conn.prepare('INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES (?, ?, ?, ?)').run(`r-${id}`, 'a', id, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, 'folder', ?, ?)").run(id, 'a', path, `r-${id}`, TS)
  conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'everyone', NULL, 0, 0, ?)").run('a', `${id}-all`, id, TS)
  for (const u of readers) {
    conn.prepare("INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, 'user', ?, 1, 1, ?)").run('a', `${id}-${u}`, id, u, TS)
  }
}

/** The events one open connection (one PC) of this member receives. */
function subscribe(co: string, userId: string): PushEvent[] {
  const got: PushEvent[] = []
  const r = push.open(co, userId, { send: e => got.push(e) })
  if (!r.ok) throw new Error(r.reason)
  return got
}

/** Alice's own task (she asked it of herself: the only person named), in `folder` or her own only. */
function ownTask(opts: { folder?: string; personal?: boolean } = {}) {
  return ok(engine.create(m('u-alice'), HUMAN, {
    type: 'task', title: '提案書を作る', ...(opts.folder ? { folder: opts.folder } : {}), ...(opts.personal ? { personal: true } : {}),
    fields: { assignee: 'u-alice' },
  })).record
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  push = createPushChannel()
  const shared = {
    companyData: source,
    transactions: sqliteTransactions(conn),
    clock: { now: () => TS, nowMs: () => Date.parse(TS) },
    ids: { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') },
  }
  signal = createRecordSignal({ ...shared, memberships: sqliteMembershipRepository(conn), push })
  engine = createRecordEngine({
    ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [],
    isMember: (co, u) => roleOf(co, u) !== null, roleOf, notify: () => {}, recordChanged: signal,
  })
  company('a')
  company('b')
})

describe('the records signal reaches every reader', () => {
  it('a reader not named on the task hears that its due changed, even when the actor is the only person named', async () => {
    const t = ownTask({ folder: '経理' })
    const carol = subscribe('a', 'u-carol')
    const owner = subscribe('a', 'u-owner')
    const aliceOtherPc = subscribe('a', 'u-alice')
    const zed = subscribe('b', 'u-zed')
    const aliceInB = subscribe('b', 'u-alice')

    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-20' } }))

    for (const got of [carol, owner, aliceOtherPc]) {
      expect(got).toHaveLength(1)
      // Content-free: the kind and a fresh version, nothing that says which record or what changed.
      expect(Object.keys(got[0]).sort()).toEqual(['kind', 'version'])
      expect(got[0]).toEqual({ kind: 'records', version: expect.stringMatching(/^[0-9a-f]{32}$/) })
    }
    // Another company hears nothing, the same person there included.
    expect(zed).toEqual([])
    expect(aliceInB).toEqual([])
  })

  it('a member closed out of the record’s folder hears nothing', async () => {
    closeAccounting('u-mallory')
    const t = ownTask({ folder: '経理' })
    const mallory = subscribe('a', 'u-mallory')
    const bob = subscribe('a', 'u-bob')
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-20' } }))
    expect(mallory).toEqual([])
    expect(bob).toHaveLength(1)
  })

  it('a new task reaches its folder’s readers too', () => {
    const bob = subscribe('a', 'u-bob')
    ownTask({ folder: '経理' })
    expect(bob).toHaveLength(1)
  })

  it('an owner-only task reaches its owner alone — not the company owner, nor anyone else', async () => {
    const t = ownTask({ personal: true })
    const others = ['u-owner', 'u-bob', 'u-carol'].map(u => subscribe('a', u))
    const alice = subscribe('a', 'u-alice')
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'set_due', { expectedVersion: 1, args: { due: '2026-11-20' } }))
    expect(alice).toHaveLength(1)
    for (const got of others) expect(got).toEqual([])
  })

  it('a private folder’s record reaches only that folder’s readers (and the company owner)', () => {
    privateFolder('s-customer', '営業部/顧客A', ['u-bob'])
    conn.prepare('INSERT INTO records (company_id, id, type, scope_id, path, folder, personal_owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a', 'task-customer', 'task', 's-customer', '営業部/顧客A/見積.md', null, null, '見積', TS, TS)
    const bob = subscribe('a', 'u-bob')
    const owner = subscribe('a', 'u-owner')
    const carol = subscribe('a', 'u-carol')
    const zed = subscribe('b', 'u-zed')
    signal('a', 'task-customer')
    expect(bob).toHaveLength(1)
    expect(owner).toHaveLength(1)
    expect(carol).toEqual([])
    expect(zed).toEqual([])
    // Asked through another company, the record does not exist there: nobody hears.
    signal('b', 'task-customer')
    expect(zed).toEqual([])
  })
})
