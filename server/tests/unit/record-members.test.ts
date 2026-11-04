/**
 * Members-only records (「この人たちだけ」, records.md "Members-only records", owner decision
 * 2026-11-04): `services/record-access.ts` `recordReader` / `recordReaders`, the engine's create
 * (`members`), its inheritance from a members-only meeting (`record-engine/members.ts`), the
 * service writer, 「招待する」 (`invite`), 「部署に出す」 (`share`), 見られる人, the push signal, 探す,
 * the mail draft's place, and the member leaving the company.
 *
 * Guards:
 * - someone not listed — a member of the same department, a department manager, an admin, the
 *   company owner, another company — gets exactly a missing record's answer on every route, and
 *   no query, count, text, link, finishedSince, sort, linkedTo, linkedToFile, 「あなたの番」,
 *   「AI の番」 or 探す includes it;
 * - links to it are refused like a missing id; links from it reach nobody else;
 * - a marked record whose list is empty is read by nobody;
 * - what is made from a members-only meeting (a task, a decision, a mail draft) is members-only
 *   with the meeting's list plus the people it names, never placed in a folder;
 * - only a listed member invites, the ledger keeps it, it is never undone; sharing a
 *   members-only record to a folder works for any listed member;
 * - 見られる人 judges it by its list (not by the shared per-place cache);
 * - the push signal reaches the listed members only;
 * - a member who leaves the company is on no list any more (re-joining starts from nothing);
 * - the table is made once, twice is harmless.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { initDatabase, migrateRecordViewers } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type ActorInput, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createRecordService, type RecordService } from '../../src/services/records'
import { createRecordFind, type RecordFind } from '../../src/services/record-find'
import { createViewersService, type ViewersService } from '../../src/services/viewers'
import { createPushChannel, type PushChannel } from '../../src/services/push-channel'
import { createRecordSignal } from '../../src/services/record-signal'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import { createOutboundMailService, type OutboundMailService } from '../../src/services/outbound-mail'
import { createFixedPayloads } from '../../src/services/fixed-payloads'
import { createCompanyService } from '../../src/services/companies'
import type { Member } from '../../src/services/access'
import type { PushEvent } from '../../../shared/types/agent-stop'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-04T00:00:00.000Z'
const TODAY = '2026-11-04'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ServiceRecordWriter
let service: RecordService
let find: RecordFind
let viewers: ViewersService
let decisions: DecisionService
let mail: OutboundMailService
let push: PushChannel
let tick = 0

const PEOPLE: Record<string, string[]> = {
  a: ['u-owner', 'u-admin', 'u-alice', 'u-bob', 'u-carol', 'u-mallory'],
  b: ['u-owner', 'u-alice'],
}
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const NAMES: Record<string, string> = { 'u-alice': '有田', 'u-bob': '坊野', 'u-carol': '加賀', 'u-owner': '阿部', 'u-admin': '安達', 'u-mallory': '真理' }
const roleOf = (co: string, userId: string) => ((PEOPLE[co] ?? []).includes(userId) ? ROLES[userId] ?? 'member' : null)
const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: roleOf(co, userId) ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }
const MISSING = 'task-0000000000000000'
/** Everyone in company a who is not on the lists below: same department (u-carol), manager (u-mallory), admin, owner. */
const OUTSIDERS = ['u-carol', 'u-mallory', 'u-admin', 'u-owner']

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const DEAL_TYPE = '---\nlabel: 案件\nversion: 1\nstorage: server\nstates: [open]\n---\n'
const EFFORT_TYPE = '---\nlabel: 取り組み\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 持ち主, kind: person, source: server }\n  purpose: { label: 目的, kind: text, source: server }\nstates: [active, done]\nfinal: [done]\n---\n'

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  for (const u of PEOPLE[id]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}-${u}`, u, id, roleOf(id, u), TS, TS)
  }
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '営業部', 'folder', ?)").run(`${id}-sales`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sales-e`, `${id}-sales`, TS)
  conn.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(`${id}-d-sales`, id, '営業部', '営業部', TS, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  const deal = parseTypeFile('deal', DEAL_TYPE)
  if (!deal.ok) throw new Error(deal.errors.join())
  records.insertTypeVersion({ name: 'deal', version: 1, definition: canonicalTypeJson(deal.definition), source: 'plugin', commitSha: null, createdAt: TS })
  const effort = parseTypeFile('effort', EFFORT_TYPE)
  if (!effort.ok) throw new Error(effort.errors.join())
  records.insertTypeVersion({ name: 'effort', version: 1, definition: canonicalTypeJson(effort.definition), source: 'file', commitSha: null, createdAt: TS })
}

/** A meeting only u-alice and u-bob attended (the service writer makes meetings). */
function meeting(members = ['u-alice', 'u-bob'], co = 'a') {
  const r = writer.create(co, {
    type: 'meeting', title: '人事の面談', summary: '評価の話', members,
    fields: { assignee: members[0], meeting_at: '2026-11-04T10:00' }, actor: { id: 'acb:minutes', kind: 'external', source: 'minutes' }, quiet: true,
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}

/** A task only u-alice and u-bob see, started once so it has a later entry. */
async function listedTask(extra: Record<string, unknown> = {}) {
  const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '面談のふりかえり', members: ['u-bob'], fields: { assignee: 'u-bob', due: '2026-11-06' }, ...extra })).record
  return ok(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  push = createPushChannel()
  const clock = { now: () => `2026-11-04T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => Date.parse(TS) }
  const ids = { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') }
  const memberships = sqliteMembershipRepository(conn)
  const transactions = sqliteTransactions(conn)
  const isMember = (co: string, u: string) => roleOf(co, u) !== null
  const recordChanged = createRecordSignal({ companyData: source, memberships, push, ids })
  writer = createServiceRecordWriter({ companyData: source, transactions, clock, ids, isMember, roleOf, notify: () => {}, recordChanged })
  engine = createRecordEngine({
    companyData: source, transactions, clock, ids,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    // u-mallory manages every department: a manager still never sees a list they are not on.
    managedFolders: (_c, userId) => (userId === 'u-mallory' ? ['', '営業部'] : []),
    isMember, roleOf, notify: () => {}, recordChanged,
  })
  service = createRecordService({ companyData: source, clock, indexer: { schedule: async () => {} } })
  find = createRecordFind({ companyData: source })
  viewers = createViewersService({
    companyData: source, memberships,
    accounts: { byIds: (list: string[]) => new Map(list.map(id => [id, { name: NAMES[id] ?? null, email: `${id}@acme.example` }])) } as never,
  })
  const tokenDigest = { digest: (t: string) => createHash('sha256').update(t).digest('hex') }
  decisions = createDecisionService({ companyData: source, writer, ids, tokenDigest } as never)
  mail = createOutboundMailService({
    companyData: source, transactions, clock, ids, writer,
    payloads: createFixedPayloads({ companyData: source, clock }),
    digest: t => createHash('sha256').update(t).digest('hex'),
    members: co => (PEOPLE[co] ?? []).map(u => ({ userId: u, email: `${u}@acme.example`, name: NAMES[u] ?? null })),
    meetingAttendees: async () => [{ email: 'tanaka@client.example', name: '田中', organizer: false }],
    bundleContacts: async () => ({ ok: true, contacts: [] }),
    mail: { senderAccount: async () => ({ ok: false, reason: 'unavailable' }), send: async () => ({ ok: false, kind: 'not-sent', reason: 'x' }) } as never,
    companyIds: () => ['a', 'b'],
  })
  company('a')
  company('b')
})

describe('a members-only record is its members’ alone', () => {
  it('the listed see it, marked membersOnly (no names)', async () => {
    const { record } = await listedTask()
    for (const who of ['u-alice', 'u-bob']) {
      const got = ok(await service.get(m(who), record.id)).record
      expect(got).toMatchObject({ id: record.id, membersOnly: true, title: '面談のふりかえり' })
      expect(got).not.toHaveProperty('members')
      expect(ok(service.query(m(who), { type: 'task' })).total).toBe(1)
    }
    expect(ok(service.myTurn(m('u-bob'))).records.map(r => r.id)).toEqual([record.id])
  })

  it('a member of the same department, a department manager, an admin and the company owner get the answer of a missing record', async () => {
    const { record } = await listedTask()
    const other = record.id.replace(/^task-.{4}/, 'task-zzzz')
    for (const who of OUTSIDERS) {
      const viewer = m(who)
      const same = async (id: string) => [
        await service.get(viewer, id),
        engine.history(viewer, id),
        engine.atVersion(viewer, id, '1'),
        await engine.act(viewer, HUMAN, id, 'reopen', { expectedVersion: 2, note: 'x' }),
        await engine.act(viewer, HUMAN, id, 'assign', { expectedVersion: 2, note: 'x', args: { assignee: who } }),
        await engine.act(viewer, HUMAN, id, 'cancel', { expectedVersion: 2, note: 'x' }),
        engine.undo(viewer, HUMAN, id, { version: 2, expectedVersion: 2 }),
        engine.fileLink(viewer, HUMAN, id, 'link', { path: 'メモ.md', expectedVersion: 2 }),
        engine.share(viewer, HUMAN, id, { folder: '営業部', expectedVersion: 2 }),
        engine.invite(viewer, HUMAN, id, { add: [who], expectedVersion: 2 }),
        service.query(viewer, { linkedTo: { id, hops: 1 } }),
      ]
      const theirs = await same(record.id)
      const missing = await same(other)
      expect(theirs).toEqual(missing.map(r => JSON.parse(JSON.stringify(r).replaceAll(other, record.id))))
      expect(theirs[0]).toMatchObject({ ok: false, kind: 'not-found', body: { code: 'RECORD_NOT_FOUND' } })
    }
    expect(source.forCompany('a').records.ledger(record.id).map(e => e.action)).toEqual(['create', 'start'])
  })

  it('no query, count, text, finished, sorted, file-link, 探す, 「あなたの番」 or 「AI の番」 of anyone else includes it', async () => {
    const { record } = await listedTask({ links: { files: ['営業部/メモ.md'] } })
    ok(await engine.act(m('u-bob'), HUMAN, record.id, 'complete', { expectedVersion: 2 }))
    const preparing = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '面談の準備', members: [], state: 'preparing', fields: { assignee: 'u-alice' } })).record
    const shared = ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '面談室の予約', fields: { assignee: 'u-carol' } })).record
    const queries = [
      { type: 'task' }, { type: 'task', countOnly: true }, { text: '面談' }, { finishedSince: '2026-01-01T00:00:00.000Z' },
      { type: 'task', sort: { field: 'due' }, fields: { due: { gte: '2026-11-01' } } }, { linkedToFile: '営業部/メモ.md' },
    ]
    for (const who of OUTSIDERS) {
      const totals = queries.map(q => ok(service.query(m(who), q)).total)
      expect(totals).toEqual([1, 1, 1, 0, 0, 0])
      expect(ok(find.find(m(who), { text: '面談', today: TODAY })).hits.map(h => h.record.id)).toEqual([shared.id])
      expect(ok(service.aiTurn(m(who))).records.map(r => r.id)).not.toContain(preparing.id)
    }
    expect(ok(service.query(m('u-alice'), { linkedToFile: '営業部/メモ.md' })).total).toBe(1)
    expect(ok(service.query(m('u-bob'), { finishedSince: '2026-01-01T00:00:00.000Z' })).total).toBe(1)
    expect(ok(find.find(m('u-bob'), { text: '面談', today: TODAY })).hits.map(h => h.record.id)).toContain(record.id)
    expect(ok(service.aiTurn(m('u-alice'))).records.map(r => r.id)).toContain(preparing.id)
  })

  it('links: nobody else can link to it, and links from it reach nobody else', async () => {
    const { record } = await listedTask()
    const toIt = engine.create(m('u-carol'), HUMAN, { type: 'task', title: '関係', links: { related: [record.id] } })
    expect(toIt).toMatchObject({ ok: false, body: { code: 'LINK_TARGET_NOT_FOUND' } })
    expect(toIt).toEqual(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '関係', links: { related: [MISSING] } }))
    expect(engine.create(m('u-owner'), HUMAN, { type: 'task', title: '関係', links: { related: [record.id] } })).toEqual(toIt)

    const shared = ok(engine.create(m('u-carol'), HUMAN, { type: 'task', title: '会社のタスク' })).record
    const mine = ok(engine.create(m('u-alice'), AI, { type: 'task', title: '面談メモ', members: ['u-bob'], links: { related: [shared.id] } })).record
    expect(mine).toMatchObject({ membersOnly: true })
    for (const who of OUTSIDERS) {
      expect(ok(await service.get(m(who), shared.id)).links).toEqual([])
      expect(ok(service.query(m(who), { linkedTo: { id: shared.id, hops: 2 } })).total).toBe(0)
    }
    expect(ok(await service.get(m('u-bob'), shared.id)).links.map(l => l.record?.id)).toEqual([mine.id])
  })

  it('nobody else can put a task into a members-only bundle, nor list a bundle’s tasks by it', async () => {
    const bundle = ok(engine.create(m('u-alice'), HUMAN, { type: 'effort', title: '採用の取り組み', members: ['u-bob'] })).record
    const missingBundle = 'effort-0000000000000000'
    for (const who of ['u-carol', 'u-owner']) {
      const t = ok(engine.create(m(who), HUMAN, { type: 'task', title: `${who} のタスク` })).record
      const into = await engine.act(m(who), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: bundle.id } })
      expect(into).toMatchObject({ ok: false, body: { code: 'BAD_LINK' } })
      expect(into).toEqual(await engine.act(m(who), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: missingBundle } }))
      expect(service.query(m(who), { link: { name: 'bundle', id: bundle.id } })).toEqual(service.query(m(who), { link: { name: 'bundle', id: missingBundle } }))
    }
    const t = ok(engine.create(m('u-bob'), HUMAN, { type: 'task', title: '求人票', members: ['u-alice'] })).record
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'set_bundle', { expectedVersion: 1, links: { bundle: bundle.id } }))
    expect(ok(service.query(m('u-alice'), { link: { name: 'bundle', id: bundle.id } })).records.map(r => r.id)).toEqual([t.id])
  })

  it('another company’s member finds nothing (the same user id included)', async () => {
    const { record } = await listedTask()
    expect(await service.get(m('u-alice', 'b'), record.id)).toEqual(await service.get(m('u-alice', 'b'), MISSING))
    expect(ok(service.query(m('u-owner', 'b'), { type: 'task' })).total).toBe(0)
    expect(engine.invite(m('u-alice', 'b'), HUMAN, record.id, { add: ['u-alice'], expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
  })

  it('a marked record with nobody on its list is read by nobody', () => {
    const records = source.forCompany('a').records
    records.upsert({
      id: 'task-empty00000000000', type: 'task', typeVersion: 12, scopeId: null, path: null, folder: null, personalOwner: null, members: [],
      title: '空', summary: '', createdAt: TS, updatedAt: TS, removedAt: null,
    })
    expect(records.find('task-empty00000000000')).toMatchObject({ personalOwner: null, members: [] })
    for (const who of PEOPLE.a) expect(ok(service.query(m(who), { text: '空' })).total).toBe(0)
  })
})

describe('creating one', () => {
  it('the creator is added; not with personal or a folder, not for a business plugin’s type, members only, the people named listed', () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', members: ['u-bob', 'u-bob'] }))
    expect(t.placed).toEqual({ personal: false, folder: null, membersOnly: true })
    expect(source.forCompany('a').records.find(t.record.id)?.members).toEqual(['u-alice', 'u-bob'])
    const refused = (body: Record<string, unknown>) => engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', ...body })
    expect(refused({ members: ['u-bob'], personal: true })).toMatchObject({ ok: false, body: { code: 'MEMBERS_WITH_PLACE' } })
    expect(refused({ members: ['u-bob'], folder: '営業部' })).toMatchObject({ ok: false, body: { code: 'MEMBERS_WITH_PLACE' } })
    expect(refused({ type: 'deal', members: ['u-bob'] })).toMatchObject({ ok: false, body: { code: 'MEMBERS_NOT_FOR_TYPE' } })
    expect(refused({ members: ['u-stranger'] })).toMatchObject({ ok: false, body: { code: 'BAD_MEMBER' } })
    expect(refused({ members: 'u-bob' })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(refused({ members: Array.from({ length: 201 }, (_, i) => `u-${i}`) })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(refused({ members: ['u-bob'], fields: { assignee: 'u-carol' } })).toMatchObject({ ok: false, body: { code: 'ASSIGNEE_CANNOT_READ' } })
    expect(refused({ members: [], fields: { reviewer: 'u-bob' } })).toMatchObject({ ok: false, body: { code: 'REVIEWER_CANNOT_READ' } })
  })

  it('from a members-only meeting: a task gets the meeting’s list and its assignee; a folder is refused', async () => {
    const mt = meeting()
    // u-alice’s AI makes the homework, for u-carol who was not there: she must see her own task.
    const t = ok(engine.createByAi(m('u-alice'), AI, { type: 'task', title: '評価表を直す', links: { meeting: mt.id }, fields: { assignee: 'u-carol' } }))
    expect(t.record).toMatchObject({ membersOnly: true })
    expect(source.forCompany('a').records.find(t.record.id)?.members).toEqual(['u-alice', 'u-bob', 'u-carol'])
    for (const who of ['u-mallory', 'u-admin', 'u-owner']) expect(ok(service.query(m(who), { type: 'task' })).total).toBe(0)
    expect(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'y', folder: '営業部', links: { meeting: mt.id } }))
      .toMatchObject({ ok: false, body: { code: 'MEMBERS_WITH_PLACE' } })
    // u-carol reads her task, not the meeting it came from (nothing widened the meeting).
    expect(ok(await service.get(m('u-carol'), t.record.id)).record.id).toBe(t.record.id)
    expect(await service.get(m('u-carol'), mt.id)).toMatchObject({ ok: false, body: { code: 'RECORD_NOT_FOUND' } })
  })

  it('from a members-only meeting: a decision gets the meeting’s list; a folder is refused', async () => {
    const mt = meeting()
    const d = ok(await decisions.record(m('u-bob'), AI, { title: '評価を上げる', why: '面談で合意', source: '面談', links: { meeting: mt.id } }))
    expect(d.record).toMatchObject({ membersOnly: true })
    expect(source.forCompany('a').records.find(d.record.id)?.members).toEqual(['u-alice', 'u-bob'])
    for (const who of OUTSIDERS) expect(ok(service.query(m(who), { type: 'decision' })).total).toBe(0)
    expect(await decisions.record(m('u-bob'), AI, { folder: '営業部', title: 'もう一つ', why: 'x', source: 'y', links: { meeting: mt.id } }))
      .toMatchObject({ ok: false, body: { code: 'DECISION_PLACE_REFUSED' } })
  })

  it('the service writer: members each a member, not with a folder; a meeting’s output with a folder is refused (fails closed)', () => {
    const actor = { id: 'acb:minutes', kind: 'external' as const, source: 'minutes' }
    expect(writer.check('a', { type: 'meeting', title: 'x', members: ['u-stranger'], actor })).toMatchObject({ reason: 'bad-place' })
    expect(writer.check('a', { type: 'meeting', title: 'x', members: ['u-alice'], folder: '営業部', actor })).toMatchObject({ reason: 'bad-place' })
    expect(writer.check('a', { type: 'meeting', title: 'x', members: ['u-alice'], fields: { assignee: 'u-carol' }, actor })).toMatchObject({ reason: 'assignee-cannot-read' })
    const mt = meeting()
    expect(writer.check('a', { type: 'task', title: 'x', folder: '営業部', links: { meeting: [mt.id] }, fields: { assignee: 'u-alice' }, actor })).toMatchObject({ reason: 'bad-place' })
    const review = writer.create('a', { type: 'task', title: '議事録を確認する', links: { meeting: [mt.id] }, fields: { assignee: 'u-alice' }, actor })
    if (!review.ok) throw new Error(review.reason)
    expect(source.forCompany('a').records.find(review.record.id)?.members).toEqual(['u-alice', 'u-bob'])
  })

  it('a mail draft of a members-only meeting stays its members’ — also when its まとまり sits in a folder', async () => {
    const mt = meeting()
    const bundle = ok(engine.create(m('u-alice'), HUMAN, { type: 'effort', title: '採用', folder: '営業部' })).record
    const refs = ok(await mail.recipients(m('u-alice'), { meetingId: mt.id, bundleId: bundle.id })).recipients
    const to = refs.find(r => r.email === 'tanaka@client.example')!.ref
    const draft = ok(await mail.create(m('u-alice'), AI, { meetingId: mt.id, bundleId: bundle.id, toRefs: [to], subject: '面談のお礼', body: '本日はありがとうございました。' })).draft
    const row = source.forCompany('a').records.byIds([draft.id])[0]
    expect(row).toMatchObject({ folder: null, personalOwner: null, members: ['u-alice', 'u-bob'] })
    for (const who of OUTSIDERS) expect(ok(service.query(m(who), { type: 'outbound_message' })).total).toBe(0)
  })
})

describe('inviting (「招待する」)', () => {
  it('a listed member adds members; the ledger keeps it; the added read it; never undone', async () => {
    const { record } = await listedTask()
    expect(ok(service.query(m('u-carol'), { type: 'task' })).total).toBe(0)
    expect(engine.invite(m('u-bob'), HUMAN, record.id, { add: ['u-stranger'], expectedVersion: 2 })).toMatchObject({ ok: false, body: { code: 'BAD_MEMBER' } })
    expect(engine.invite(m('u-bob'), HUMAN, record.id, { add: [], expectedVersion: 2 })).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(engine.invite(m('u-bob'), HUMAN, record.id, { add: ['u-carol'], expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    const r = ok(engine.invite(m('u-bob'), HUMAN, record.id, { add: ['u-carol', 'u-alice'], expectedVersion: 2, note: '加賀さんにも' }))
    expect(r.added).toEqual(['u-carol'])
    expect(r.entry).toMatchObject({
      action: 'invite', version: 3, actorId: 'u-bob', note: '加賀さんにも', fromState: 'in_progress', toState: 'in_progress',
      changes: [{ field: 'place.members', before: 'u-alice,u-bob', after: 'u-alice,u-bob,u-carol' }],
    })
    expect(ok(await service.get(m('u-carol'), record.id)).record.version).toBe(3)
    for (const who of ['u-mallory', 'u-admin', 'u-owner']) expect(ok(service.query(m(who), { type: 'task' })).total).toBe(0)
    for (const who of ['u-bob', 'u-carol']) {
      expect(engine.undo(m(who), HUMAN, record.id, { version: 3, expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_UNDOABLE' } })
    }
  })

  it('only for a members-only record', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '全員の' })).record
    expect(engine.invite(m('u-alice'), HUMAN, t.id, { add: ['u-bob'], expectedVersion: 1 })).toMatchObject({ ok: false, kind: 'conflict', body: { code: 'NOT_MEMBERS_ONLY' } })
    const own = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '自分用', personal: true })).record
    expect(engine.invite(m('u-alice'), HUMAN, own.id, { add: ['u-bob'], expectedVersion: 1 })).toMatchObject({ ok: false, body: { code: 'NOT_MEMBERS_ONLY' } })
  })
})

describe('sharing it to a folder (「部署に出す」)', () => {
  it('any listed member; then the folder’s readers see it; the ledger keeps the list; never undone', async () => {
    const { record } = await listedTask()
    const r = ok(engine.share(m('u-bob'), HUMAN, record.id, { folder: '営業部', expectedVersion: 2 }))
    expect(r.record.membersOnly).toBeUndefined()
    expect(r.entry).toMatchObject({
      action: 'share', changes: [{ field: 'place.members', before: 'u-alice,u-bob', after: null }, { field: 'place.folder', before: null, after: '営業部' }],
    })
    expect(source.forCompany('a').records.find(record.id)).toMatchObject({ folder: '営業部', personalOwner: null, members: null })
    for (const who of OUTSIDERS) expect(ok(await service.get(m(who), record.id)).record.version).toBe(3)
    expect(engine.undo(m('u-bob'), HUMAN, record.id, { version: 3, expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_UNDOABLE' } })
    expect(engine.share(m('u-bob'), HUMAN, record.id, { folder: '営業部', expectedVersion: 3 })).toMatchObject({ ok: false, body: { code: 'NOT_PERSONAL' } })
  })
})

describe('who sees it, who hears of it, who leaves', () => {
  it('見られる人: by its own list, never by another record’s answer for the same place', async () => {
    const a = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '二人', members: ['u-bob'] })).record
    const b = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '三人', members: ['u-bob', 'u-carol'] })).record
    const c = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '一人', members: [] })).record
    const got = ok(viewers.labels(m('u-alice'), { records: [a.id, b.id, c.id] })).records
    expect(got[a.id]).toEqual({ kind: 'you-and-one', text: 'あなたと坊野さん', count: 2 })
    expect(got[b.id]).toEqual({ kind: 'people', text: '3人が見られます', count: 3 })
    expect(got[c.id]).toEqual({ kind: 'only-you', text: 'あなただけ', count: 1 })
    // Not listed: left out, the owner included.
    expect(ok(viewers.labels(m('u-owner'), { records: [a.id, b.id] })).records).toEqual({})
  })

  it('the push signal reaches the listed members only', async () => {
    const got: Record<string, PushEvent[]> = {}
    for (const u of PEOPLE.a) {
      got[u] = []
      push.open('a', u, { send: e => got[u].push(e) })
    }
    await listedTask()
    expect(Object.entries(got).filter(([, e]) => e.length > 0).map(([u]) => u).sort()).toEqual(['u-alice', 'u-bob'])
  })

  it('a member who leaves the company is on no list any more; joining again starts from nothing', async () => {
    const { record } = await listedTask()
    const companies = createCompanyService({
      companies: null as never, memberships: sqliteMembershipRepository(conn), companyData: source, clientActivity: null as never,
      accounts: null as never, repoStore: null as never, transactions: sqliteTransactions(conn), clock: { now: () => TS, nowMs: () => 0 },
      ids: null as never, creationPolicy: null as never, isOperator: () => false,
    })
    ok(companies.removeMember(m('u-owner'), 'u-bob'))
    expect(source.forCompany('a').records.find(record.id)?.members).toEqual(['u-alice'])
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-a-bob-2', 'u-bob', 'a', 'member', TS, TS)
    expect(ok(service.query(m('u-bob'), { type: 'task' })).total).toBe(0)
  })

  it('the table is made once; twice is harmless; rows are as written', () => {
    migrateRecordViewers(conn)
    migrateRecordViewers(conn)
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: 'x', members: ['u-bob'] })).record
    expect(conn.prepare('SELECT user_id, added_by FROM record_viewers WHERE company_id = ? AND record_id = ? ORDER BY user_id').all('a', t.id))
      .toEqual([{ user_id: 'u-alice', added_by: 'u-alice' }, { user_id: 'u-bob', added_by: 'u-alice' }])
    expect(conn.prepare('SELECT personal_owner FROM records WHERE id = ?').get(t.id)).toEqual({ personal_owner: '@members' })
  })
})
