/**
 * A record a member cannot read is a record that does not exist for them (records.md "No leaks"):
 * the four small leaks #648 listed, each now answering exactly as when nothing is there.
 *
 * Guards (each fails when its fix is removed):
 * - decisions: a key held by a decision the member cannot read is not 409 KEY_TAKEN — theirs is
 *   made as with a new key (another id), and a later call of theirs finds their own;
 * - minutes: choosing a まとまり whose 相手 the member cannot read answers `counterpartId: null` and
 *   links no 相手 (a reader still gets it);
 * - outbound mail: the やりとり of a sent mail links its まとまり's 相手 only when the sender reads it;
 * - meeting duplicates: the note on a merged duplicate names the kept one only when every reader of
 *   the duplicate reads it too.
 * (Bundle kinds: `bundle-kinds.test.ts`.)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type ActorInput, type RecordEngine, type ServiceRecordWriter } from '../../src/services/record-engine'
import { createDecisionService, type DecisionService } from '../../src/services/decisions'
import { createMinutesService } from '../../src/services/minutes'
import { createOutboundMailService, type OutboundMailService } from '../../src/services/outbound-mail'
import { createFixedPayloads } from '../../src/services/fixed-payloads'
import { createMeetingOutputService, type MeetingOutputService } from '../../src/services/meeting-outputs'
import type { Member } from '../../src/services/access'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const TS = '2026-11-08T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let writer: ServiceRecordWriter
let decisions: DecisionService
let minutes: ReturnType<typeof createMinutesService>
let mail: OutboundMailService
let outputs: MeetingOutputService
let tick = 0

const PEOPLE = ['u-owner', 'u-alice', 'u-mallory']
const roleOf = (_co: string, userId: string) => (userId === 'u-owner' ? 'owner' : PEOPLE.includes(userId) ? 'member' : null)
const m = (userId: string): Member => ({ companyId: 'a', userId, role: roleOf('a', userId) ?? 'member' })
const HUMAN: ActorInput = { kind: 'human' }
const AI: ActorInput = { kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

const EFFORT = '---\nlabel: 取り組み\nversion: 1\nstorage: server\nimplements: [bundle]\nfields:\n  owner: { label: 持ち主, kind: person, source: server }\n  purpose: { label: 目的, kind: text, source: server }\nlinks:\n  counterpart: { label: 相手, interface: counterpart, cardinality: one }\nstates: [active, done]\nfinal: [done]\n---\n'
const CUSTOMER = '---\nlabel: 顧客\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person], source: server }\n  domain: { label: ドメイン, kind: text, source: server }\n  email: { label: メール, kind: text, source: server }\nstates: [active]\n---\n'

function company() {
  const run = (sql: string, ...args: unknown[]) => conn.prepare(sql).run(...args)
  run('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'a', 'a', 'a', 'u-owner', TS, TS)
  for (const u of PEOPLE) run('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `m-${u}`, u, 'a', roleOf('a', u), TS, TS)
  run("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('root', 'a', '', 'company', ?)", TS)
  run("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('root-e', 'root', 'everyone', NULL, 1, 1, ?)", TS)
  // 経理: everyone reads and writes but u-mallory.
  run("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('acc', 'a', '経理', 'folder', ?)", TS)
  run("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('acc-e', 'acc', 'everyone', NULL, 1, 1, ?)", TS)
  run("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('acc-m', 'acc', 'user', 'u-mallory', 0, 0, ?)", TS)
  for (const [i, folder] of ['営業部', '経理'].entries()) {
    run('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `d-${i}`, 'a', folder, folder, i, TS, TS)
  }
  const records = source.forCompany('a').records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
  for (const [name, text] of [['effort', EFFORT], ['customer', CUSTOMER]]) {
    const parsed = parseTypeFile(name, text)
    if (!parsed.ok) throw new Error(parsed.errors.join())
    records.insertTypeVersion({ name, version: 1, definition: canonicalTypeJson(parsed.definition), source: 'file', commitSha: null, createdAt: TS })
  }
}

beforeEach(() => {
  tick = 0
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  const clock = { now: () => `2026-11-08T01:00:${String(tick++ % 60).padStart(2, '0')}.000Z`, nowMs: () => Date.parse(TS) }
  const ids = { newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '') }
  const transactions = sqliteTransactions(conn)
  const isMember = (co: string, u: string) => roleOf(co, u) !== null
  const tokenDigest = { digest: (t: string) => createHash('sha256').update(t).digest('hex') }
  writer = createServiceRecordWriter({ companyData: source, transactions, clock, ids, isMember, roleOf, notify: () => {} })
  engine = createRecordEngine({
    companyData: source, transactions, clock, ids,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [], isMember, roleOf, notify: () => {},
  })
  decisions = createDecisionService({ companyData: source, writer, ids, tokenDigest })
  minutes = createMinutesService({
    companyData: source, writer, clock, tokenDigest,
    // linkBundle reads neither the calendar nor the members.
    meetings: {} as never,
    members: () => [],
  })
  mail = createOutboundMailService({
    companyData: source, transactions, clock, ids, writer,
    payloads: createFixedPayloads({ companyData: source, clock }),
    digest: t => createHash('sha256').update(t).digest('hex'),
    members: () => PEOPLE.map(u => ({ userId: u, email: `${u}@acme.example`, name: u })),
    meetingAttendees: async () => [{ email: 'tanaka@client.example', name: '田中', organizer: false }],
    bundleContacts: async () => ({ ok: true, contacts: [] }),
    mail: {
      senderAccount: async (_co: string, userId: string) => ({ ok: true, account: `${userId}@acme.example` }),
      send: async () => ({ ok: true, status: 200, json: { id: `g${tick}`, threadId: `t${tick}` } }),
    } as never,
    companyIds: () => ['a'],
  })
  outputs = createMeetingOutputService({
    companyData: source, act: (...a) => engine.act(...a),
    members: () => PEOPLE.map(u => ({ userId: u, role: roleOf('a', u)! })),
  })
  company()
})

/** A meeting in 営業部 (everyone reads it) whose assignee is `assignee`. */
function meeting(assignee: string) {
  const r = writer.create('a', {
    type: 'meeting', title: '定例', summary: '先方と', folder: '営業部',
    fields: { assignee, meeting_at: '2026-11-08T10:00' }, actor: { id: 'acb:minutes', kind: 'external', source: 'minutes' }, quiet: true,
  })
  if (!r.ok) throw new Error(r.reason)
  return r.record
}

/** A まとまり in 営業部 whose 相手 sits in 経理 (u-mallory cannot read it). */
function bundleWithHiddenCounterpart() {
  const customer = ok(engine.create(m('u-owner'), HUMAN, { type: 'customer', title: '経理の取引先', folder: '経理', fields: { counterpart_kind: 'company', domain: 'client.example' } })).record
  const bundle = ok(engine.create(m('u-owner'), HUMAN, { type: 'effort', title: '研修の取り組み', folder: '営業部', fields: { owner: 'u-owner' }, links: { counterpart: customer.id } })).record
  return { customer, bundle }
}

const linkTarget = (sourceId: string, name: string) =>
  source.forCompany('a').records.linksFrom([sourceId]).filter(l => l.name === name).map(l => l.targetId)

describe('a decision key held by a decision the member cannot read', () => {
  const decide = (who: string, folder: string, key = 'k1') =>
    decisions.record(m(who), HUMAN, { folder, title: '値引きの判断', why: '今回だけ', source: '会議', key })

  it('is not KEY_TAKEN: theirs is made as with a new key, and found again by them', async () => {
    const hidden = ok(await decide('u-owner', '経理'))
    expect(hidden.created).toBe(true)
    const fresh = await decide('u-mallory', '営業部', 'k-never-used')
    const mine = await decide('u-mallory', '営業部')
    expect(mine.ok).toBe(true)
    const made = ok(mine)
    expect(Object.keys(made).sort()).toEqual(Object.keys(ok(fresh)).sort())
    expect(made.created).toBe(true)
    expect(made.record.id).not.toBe(hidden.record.id)
    expect(JSON.stringify(made)).not.toContain(hidden.record.id)
    // Their own decision with the key is the answer next time (made once for them too).
    expect(ok(await decide('u-mallory', '営業部'))).toMatchObject({ created: false, reused: true, record: { id: made.record.id } })
    // Someone who reads both gets one of them, as before: nothing new is made.
    const both = ok(await decide('u-alice', '営業部'))
    expect(both.created).toBe(false)
    expect([hidden.record.id, made.record.id]).toContain(both.record.id)
  })
})

describe('choosing a meeting\'s まとまり whose 相手 the member cannot read', () => {
  it('answers no 相手 and links none; a reader gets it', async () => {
    const { customer, bundle } = bundleWithHiddenCounterpart()
    const theirs = meeting('u-mallory')
    const linked = ok(await minutes.linkBundle(m('u-mallory'), { kind: 'human', source: null }, theirs.id, { bundleId: bundle.id }))
    expect(linked.counterpartId).toBeNull()
    expect(linkTarget(theirs.id, 'counterpart')).toEqual([])
    expect(linkTarget(theirs.id, 'bundle')).toEqual([bundle.id])

    const readers = meeting('u-alice')
    expect(ok(await minutes.linkBundle(m('u-alice'), { kind: 'human', source: null }, readers.id, { bundleId: bundle.id })).counterpartId).toBe(customer.id)
  })
})

describe('the やりとり of a sent mail', () => {
  async function send(who: string) {
    const { customer, bundle } = bundleWithHiddenCounterpart()
    const mt = meeting(who)
    const to = ok(await mail.recipients(m(who), { meetingId: mt.id, bundleId: bundle.id })).recipients.find(r => r.email === 'tanaka@client.example')!.ref
    const draft = ok(await mail.create(m(who), AI, { meetingId: mt.id, bundleId: bundle.id, toRefs: [to], subject: 'お礼', body: 'ありがとうございました。' })).draft
    expect(ok(await mail.send(m(who), draft.id, { hash: draft.hash }))).toMatchObject({ outcome: 'sent' })
    const [receipt] = source.forCompany('a').records.candidates({ types: ['interaction'] }, 10)
    return { customer, bundle, receipt }
  }

  it('links the まとまり\'s 相手 only when the sender reads it', async () => {
    const hidden = await send('u-mallory')
    expect(linkTarget(hidden.receipt.id, 'bundle')).toEqual([hidden.bundle.id])
    expect(linkTarget(hidden.receipt.id, 'counterpart')).toEqual([])
  })

  it('a sender who reads it gets it linked', async () => {
    const seen = await send('u-alice')
    expect(linkTarget(seen.receipt.id, 'counterpart')).toEqual([seen.customer.id])
  })
})

describe('merging what one meeting made twice', () => {
  /** Two tasks of the same title linked to one meeting; `keptFolder` holds the first (kept). */
  function duplicates(keptFolder: string) {
    const mt = meeting('u-alice')
    const make = (folder: string) => {
      const t = ok(engine.create(m('u-owner'), HUMAN, { type: 'task', title: '見積を送る', folder, fields: { assignee: 'u-alice' } })).record
      conn.prepare("INSERT INTO record_links (company_id, source_id, name, position, target_id, target_path) VALUES ('a', ?, 'meeting', 0, ?, NULL)").run(t.id, mt.id)
      return t
    }
    return { kept: make(keptFolder), dup: make('営業部') }
  }
  const lastNote = (id: string) => source.forCompany('a').records.ledger(id).reduce((x, y) => (y.version > x.version ? y : x)).note ?? ''

  it('names the kept one on the duplicate only when everyone who reads the duplicate reads it', async () => {
    const hidden = duplicates('経理')
    expect(ok(await outputs.merge(m('u-owner'), { keepId: hidden.kept.id, duplicateIds: [hidden.dup.id] })).merged).toEqual([hidden.dup.id])
    const note = lastNote(hidden.dup.id)
    expect(note).toContain('重複して作られた')
    expect(note).not.toContain(hidden.kept.id)
    expect(note).not.toContain('見積を送る')
  })

  it('still names it when they all read it', async () => {
    const open = duplicates('営業部')
    ok(await outputs.merge(m('u-owner'), { keepId: open.kept.id, duplicateIds: [open.dup.id] }))
    expect(lastNote(open.dup.id)).toContain(open.kept.id)
  })
})
