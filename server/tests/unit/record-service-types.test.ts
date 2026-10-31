/**
 * Milestone 4's record foundation (records.md "Service-owned types",
 * "Service writer", 「AI の番」, "Decisions") on the real schema behind real
 * company handles.
 *
 * Guards:
 * - the generic create refuses the service-owned types (minutes, approval,
 *   outbound_message, decision) for a person and for their AI;
 * - an approval / outbound message changes state through its service only:
 *   no generic action (even one a company's own definition adds) and no undo;
 * - the service writer moves state only along SERVICE_TRANSITIONS, with a
 *   compare-and-set on the version, the actor it is given in the ledger, and
 *   a person it names able to read the record;
 * - 「AI の番」 lists only the member's own records, only readable ones, only
 *   in a state with an AI-only action, never another company's;
 * - a decision: no member's name or linked deal / customer title in it, never
 *   in a private folder (and the refusal never names the place), the same key
 *   writes one file, links only to readable records of this company.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import type { Member } from '../../src/services/access'
import { coreTypeDefinitions, SERVICE_OWNED_TYPES, SERVICE_TRANSITIONS } from '../../../shared/core/core-types'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-01T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let service: RecordService
let writer: ServiceRecordWriter
let decisions: DecisionService
let files: Map<string, string>
let fileWrites: number
let notified: Array<[string, string[]]>

const PEOPLE = ['u-owner', 'u-alice', 'u-bob', 'u-mallory']
/** Display names (fictional): what a decision must not contain. */
const NAMES: Record<string, string> = { 'u-alice': '試験 花子', 'u-bob': '見本 次郎' }
const m = (userId: string, co = 'a', role = 'member'): Member => ({ companyId: co, userId, role })
const owner = (co = 'a') => m('u-owner', co, 'owner')
const HUMAN = { kind: 'human' as const }
const AI = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-1' }

const DEAL_TYPE = '---\nlabel: 案件\nversion: 1\nstorage: server\nlinks:\n  customer: { label: 顧客, target: customer, cardinality: one }\nstates: [open]\n---\n'
const CUSTOMER_TYPE = '---\nlabel: 顧客\nversion: 1\nstorage: server\nstates: []\n---\n'

function addType(co: string, name: string, text: string, version: number, src: 'file' | 'plugin' = 'plugin') {
  const r = parseTypeFile(name, text)
  if (!r.ok) throw new Error(r.errors.join())
  source.forCompany(co).records.insertTypeVersion({ name, version, definition: canonicalTypeJson(r.definition), source: src, commitSha: null, createdAt: TS })
}

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  for (const folder of ['営業部', '経理部']) {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${folder}`, id, folder, folder, TS, TS)
  }
  // 経理部/意思決定: a private folder only u-alice (and owners/admins) may read.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '経理部/意思決定', 'folder', ?, ?)").run(`${id}-priv`, id, `${id}-repo`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 0, 0, ?)").run(`${id}-priv-e`, `${id}-priv`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-alice', 1, 1, ?)").run(`${id}-priv-a`, `${id}-priv`, TS)
  // 秘書室: a folder u-mallory cannot read (scope rules, not private).
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '秘書室', 'folder', ?)").run(`${id}-sec`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sec-e`, `${id}-sec`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-mallory', 0, 0, ?)").run(`${id}-sec-m`, `${id}-sec`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  addType(id, 'deal', DEAL_TYPE, 1)
  addType(id, 'customer', CUSTOMER_TYPE, 1)
}

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

let tick = 0
beforeEach(() => {
  tick = 0
  notified = []
  files = new Map()
  fileWrites = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => `2026-11-01T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => 0 }
  const ids = { newId: () => 'x', newToken: () => Math.random().toString(16).slice(2).padEnd(16, '0') }
  const roleOf = (_c: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null)
  const base = {
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (_c: string, userId: string) => PEOPLE.includes(userId), roleOf,
    notify: (companyId: string, userIds: string[]) => { notified.push([companyId, userIds]) },
  }
  engine = createRecordEngine({
    ...base,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => false },
    managedFolders: () => [],
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  writer = createServiceRecordWriter(base)
  decisions = createDecisionService({
    companyData: source, writer, ids,
    files: {
      createFile: async (companyId, path, text) => {
        const k = `${companyId}:${path}`
        if (files.has(k)) return false
        files.set(k, text)
        fileWrites++
        return true
      },
    },
    memberNames: () => Object.values(NAMES),
    tokenDigest: { digest: (t: string) => createHash('sha256').update(t).digest('hex') },
  })
  company('a')
  company('b')
})

/** An approval for u-bob to approve, made by the service writer (as G6 will). */
function newApproval(co = 'a') {
  const r = writer.create(co, {
    type: 'approval', title: '金額の変更', fields: { assignee: 'u-bob', operation: 'hubspot.update_deal', payload_hash: 'sha256:aa', payload_version: 1 },
    actor: { id: 'u-alice', kind: 'ai', source: 'claude-code' },
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}

/** Minutes assigned to `assignee` (as the minutes intake will make them). */
function newMinutes(assignee: string, folder: string | null = null, co = 'a') {
  const r = writer.create(co, { type: 'minutes', title: '定例', folder, fields: { assignee, external_count: 2 }, actor: { id: assignee, kind: 'human', source: null } })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}

describe('service-owned types', () => {
  it('the core definitions parse and every service transition names states of its type', () => {
    const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
    for (const t of SERVICE_OWNED_TYPES) expect(defs.has(t)).toBe(true)
    for (const [type, rows] of Object.entries(SERVICE_TRANSITIONS)) {
      for (const r of rows) for (const s of [...r.from, r.to]) expect(defs.get(type)!.states).toContain(s)
    }
    expect(Object.keys(defs.get('approval')!.actions)).toEqual([])
    expect(Object.keys(defs.get('outbound_message')!.actions)).toEqual([])
  })

  it('the generic create refuses them, for a person and for their AI', () => {
    for (const type of SERVICE_OWNED_TYPES) {
      for (const actor of [HUMAN, AI]) {
        const r = engine.create(m('u-alice'), actor, { type, title: '作れない', fields: {} })
        expect(r).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'TYPE_CREATED_BY_SERVICE' } })
      }
    }
    expect(service.query(owner(), { type: 'approval' })).toMatchObject({ ok: true, value: { total: 0 } })
    // Other server types still can be.
    expect(ok(engine.create(m('u-alice'), AI, { type: 'task', title: 'できる' })).record.type).toBe('task')
  })

  it('an approval has no generic action — not even one a company definition adds — and no undo', async () => {
    const a = newApproval()
    // A company's own approval.md (higher version, additive) that adds an action anyone, or the AI, could run.
    const core = coreTypeDefinitions().find(d => d.name === 'approval')!
    source.forCompany('a').records.insertTypeVersion({
      name: 'approval', version: 2, source: 'file', commitSha: null, createdAt: TS,
      definition: canonicalTypeJson({ ...core, version: 2, actions: { approve: { label: '承認', from: ['pending'], to: 'approved', who: ['anyone', 'ai'], notify: [], attach: [], note: 'none', historyLine: false, decision: false, approval: 'none', args: {}, handTo: null } } }),
    })
    for (const actor of [HUMAN, AI]) {
      const r = await engine.act(m('u-bob'), actor, a.id, 'approve', { expectedVersion: 1 })
      expect(r).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'STATE_CHANGED_BY_SERVICE' } })
    }
    // Approved by the service: a person's undo cannot reopen it.
    const approved = writer.transition('a', { recordId: a.id, action: 'approve', expectedVersion: 1, to: 'approved', actor: { id: 'u-bob', kind: 'human', source: null }, decisionReason: '妥当な金額' })
    expect(approved.ok).toBe(true)
    const u = engine.undo(m('u-bob'), HUMAN, a.id, { version: 2, expectedVersion: 2 })
    expect(u).toMatchObject({ ok: false, body: { code: 'STATE_CHANGED_BY_SERVICE' } })
    expect(source.forCompany('a').records.states([a.id])[0].state).toBe('approved')
  })
})

describe('the service writer', () => {
  it('moves state only along the table, compare-and-set on the version, with the actor it is given', () => {
    const a = newApproval()
    expect(a).toMatchObject({ state: 'pending', fields: { requested_by: 'u-alice', assignee: 'u-bob', next_actor: 'u-bob' } })
    expect(notified).toContainEqual(['a', ['u-bob']])
    const bob = { id: 'u-bob', kind: 'human' as const, source: null }
    expect(writer.transition('a', { recordId: a.id, action: 'x', expectedVersion: 1, to: 'draft', actor: bob })).toEqual({ ok: false, reason: 'transition-not-allowed' })
    expect(writer.transition('a', { recordId: a.id, action: 'approve', expectedVersion: 0, to: 'approved', actor: bob })).toEqual({ ok: false, reason: 'stale' })
    const r = writer.transition('a', { recordId: a.id, action: 'approve', expectedVersion: 1, to: 'approved', actor: bob, decisionReason: '妥当', fields: { reason: '妥当' } })
    if (!r.ok) throw new Error(r.reason)
    expect(r.entry).toMatchObject({ version: 2, action: 'approve', fromState: 'pending', toState: 'approved', actorId: 'u-bob', actorKind: 'human', isDecision: true, decision: { reason: '妥当' } })
    // Final: nothing moves it back to pending.
    expect(writer.transition('a', { recordId: a.id, action: 'x', expectedVersion: 2, to: 'pending', actor: bob })).toEqual({ ok: false, reason: 'transition-not-allowed' })
    // Only service-owned records.
    const task = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 't' })).record
    expect(writer.transition('a', { recordId: task.id, action: 'x', expectedVersion: 1, to: 'done', actor: bob })).toEqual({ ok: false, reason: 'not-service-owned' })
  })

  it('a person it names must be able to read the record', () => {
    const r = writer.create('a', { type: 'approval', title: 'x', folder: '秘書室', fields: { assignee: 'u-mallory' }, actor: { id: 'u-alice', kind: 'human', source: null } })
    expect(r).toMatchObject({ ok: false, reason: 'assignee-cannot-read' })
    expect(JSON.stringify(r)).not.toContain('秘書室')
  })
})

describe('「AI の番」', () => {
  it('only the member’s own, only readable, only in a state with an AI-only action, never another company’s', async () => {
    const mine = newMinutes('u-mallory')
    newMinutes('u-bob') // someone else's
    newMinutes('u-mallory', '広報') // hers, but a rule made later closes the place to her
    conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-pr', 'a', '広報', 'folder', ?)").run(TS)
    conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-pr-m', 'a-pr', 'user', 'u-mallory', 0, 0, ?)").run(TS)
    newMinutes('u-mallory', null, 'b') // the same member id in another company
    newApproval() // nobody's AI turn: no AI-only action
    const ids = (r: ReturnType<RecordService['aiTurn']>) => ok(r).records.map(x => x.id)
    expect(ids(service.aiTurn(m('u-mallory')))).toEqual([mine.id])
    // Read and finished: no longer the AI's turn.
    ok(await engine.act(m('u-mallory'), AI, mine.id, 'start_reading', { expectedVersion: 1 }))
    expect(ids(service.aiTurn(m('u-mallory')))).toEqual([mine.id]) // reading → finish_reading is AI-only too
    ok(await engine.act(m('u-mallory'), AI, mine.id, 'finish_reading', { expectedVersion: 2, args: { summary_text: '要約' } }))
    expect(ids(service.aiTurn(m('u-mallory')))).toEqual([])
    // A person cannot do the AI's part, and the AI cannot skip for them.
    const other = newMinutes('u-mallory')
    expect(await engine.act(m('u-mallory'), HUMAN, other.id, 'start_reading', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await engine.act(m('u-mallory'), AI, other.id, 'skip', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
  })
})

describe('decisions', () => {
  function deal(co = 'a') {
    const customer = ok(engine.create(owner(co), HUMAN, { type: 'customer', title: '株式会社サンプル物産' })).record
    return ok(engine.create(owner(co), HUMAN, { type: 'deal', title: 'サンプル物産 導入案件', links: { customer: customer.id } })).record
  }
  const body = (extra: Record<string, unknown> = {}) => ({ folder: '営業部', title: '対象の窓口を3つにする', why: 'チャット窓口も最初から入れたいとの要望', source: '議事録 2026-11-05', ...extra })

  it('writes the file with id / type / links only and an unconfirmed record; the AI’s is recorded as ai', async () => {
    const d = deal()
    const minutes = newMinutes('u-bob')
    const r = ok(await decisions.record(m('u-alice'), AI, body({ links: { deal: d.id, minutes: minutes.id } })))
    expect(r.created).toBe(true)
    expect(r.record).toMatchObject({ type: 'decision', state: 'unconfirmed', title: '対象の窓口を3つにする', fields: { recorded_by: 'ai', decided_by: null, owner: 'u-bob', important: false } })
    expect(r.record.path).toBe(`営業部/意思決定/${r.record.id}.md`)
    const text = files.get(`a:${r.record.path}`)!
    expect(text).toContain(`id: ${r.record.id}\ntype: decision\nlinks:\n  deal: ${d.id}\n  minutes: ${minutes.id}\n---\n# 対象の窓口を3つにする`)
    expect(text).not.toMatch(/state|unconfirmed|未確認/)
    expect(source.forCompany('a').records.ledger(r.record.id)[0]).toMatchObject({ actorId: 'u-alice', actorKind: 'ai', conversationId: 'conv-1' })
    // The minutes' assignee (owner) confirms; the AI cannot.
    expect(await engine.act(m('u-bob'), AI, r.record.id, 'confirm', { expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(ok(await engine.act(m('u-bob'), HUMAN, r.record.id, 'confirm', { expectedVersion: 1 })).record.state).toBe('confirmed')
  })

  it('refuses a member’s name or the linked deal’s / customer’s title, in the title or the text', async () => {
    const d = deal()
    for (const extra of [
      { title: '試験さんに見積を送る' },
      { why: '見本 次郎が了承した' },
      { title: 'サンプル物産へ窓口を3つ提案', links: { deal: d.id } },
      { source: 'サンプル物産 導入案件の議事録', links: { deal: d.id } },
    ]) {
      const r = await decisions.record(m('u-alice'), AI, body(extra))
      expect(r).toMatchObject({ ok: false, body: { code: 'NAME_IN_DECISION' } })
    }
    expect(fileWrites).toBe(0)
  })

  it('is never placed in a private folder, and the refusal never names the place', async () => {
    // 経理部/意思決定 is private: even the owner (who may read and write it) is refused.
    const r = await decisions.record(owner(), HUMAN, body({ folder: '経理部' }))
    expect(r).toMatchObject({ ok: false, kind: 'bad-request', body: { code: 'DECISION_PLACE_REFUSED' } })
    expect(JSON.stringify(r)).not.toMatch(/経理|意思決定/)
    // The same words for a folder that is not a department.
    const none = await decisions.record(owner(), HUMAN, body({ folder: '存在しない部' }))
    expect(none).toEqual(r)
    expect(fileWrites).toBe(0)
  })

  it('the same key twice writes one file and one record', async () => {
    const first = ok(await decisions.record(m('u-alice'), AI, body({ key: 'minutes-abc123:decision:2' })))
    const again = ok(await decisions.record(m('u-alice'), AI, body({ key: 'minutes-abc123:decision:2', title: '言い換えた件名' })))
    expect(again).toEqual({ record: first.record, created: false })
    // At the same moment, too.
    const both = await Promise.all([1, 2].map(() => decisions.record(m('u-alice'), AI, body({ key: 'k-same-time' }))))
    expect(both.map(x => ok(x).record.id)[0]).toBe(ok(both[1]).record.id)
    expect(fileWrites).toBe(2)
    expect(ok(service.query(owner(), { type: 'decision' })).total).toBe(2)
  })

  it('links only to readable records of this company, of the type the link names', async () => {
    const theirs = deal('b')
    const missing = await decisions.record(owner(), HUMAN, body({ links: { deal: 'deal-zzzzzzzz' } }))
    expect(await decisions.record(owner(), HUMAN, body({ links: { deal: theirs.id } }))).toEqual(missing)
    expect(missing).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    const minutes = newMinutes('u-bob')
    expect(await decisions.record(owner(), HUMAN, body({ links: { deal: minutes.id } }))).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
    expect(fileWrites).toBe(0)
    expect(source.forCompany('b').records.linksTo([theirs.id])).toHaveLength(0)
  })
})
