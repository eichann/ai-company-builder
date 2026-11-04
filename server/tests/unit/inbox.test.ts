/**
 * The inbox (来た連絡, `.claude/rules/inbox.md`): services/inbox.ts over the
 * real SQLite handle and the engine's service writer, with a fake mail
 * connector registered for the core `mail` role (no Google, no Slack).
 *
 * Guards:
 * - the To person's own record (持ち主だけ): nobody else — CC, other members,
 *   the company owner, admins — can read it, list it or be told of it;
 * - CC is told nothing (setting: 確認待ち for the CC reporter instead);
 *   several To: the first (setting: 確認待ち, told with `intake_unsure`);
 * - a shared address is the department's turn; only its readers see and take it;
 * - internal mail and spam are not taken in; newsletters and automatic mail
 *   go to 「やることにしなかった一覧」 (the owner's only); a person's
 *   「やることにする」 wins over the AI;
 * - one interaction per thread, a message id once; no body is stored;
 * - their reply moves a 返事待ち to the AI's check and tells the assignee
 *   (`reply_arrived`), an automatic reply does not; a reply that reached
 *   another member only is not the owner's; a reply of the company ends it
 *   or has the AI check it (setting);
 * - the AI's judgement makes a 返事のお願い: owner-only like its message, due
 *   = the message's deadline or the company's 目安 (翌営業日, holidays);
 * - polling through the role: reconnecting reads back at most 7 days, a
 *   longer break is an unchecked gap shown to its member only;
 * - another company's settings and messages change nothing;
 * - B4: what the AI judges by is its owner's alone (a 返事のお願い answers
 *   its message and why it is the AI's turn); a task the AI made counts only
 *   when it names the message, and a second run sees what the first one made;
 * - the member's own reply (Gmail, Slack — a Slack DM is seldom threaded: their
 *   next plain message in that DM within 3 days) ends what it answered: a
 *   draft made for it is discarded, an unjudged message is handled, the AI
 *   makes no 返事のお願い for an answered thread; a reply ACB cannot see is
 *   the person's 「もう返した」, which drops every reply draft to that 連絡 too;
 * - B5 追いかけ: past 返事の見込み (never before) the server clock puts a 返事待ち
 *   into the AI's turn to draft a nudge (自動で進める on; else the assignee's);
 *   their reply then sends it to the AI's check and drops the nudge's draft;
 *   the AI is told why it is its turn (draft / follow_up / check_reply).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { InboxSource } from '../../src/ports/inbox'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createServiceRecordWriter, type RecordChange, type ServiceActor } from '../../src/services/record-engine'
import { createIdentityService } from '../../src/services/identities'
import { createInboxService, type InboxService } from '../../src/services/inbox'
import { createRecordEngine, type RecordEngine } from '../../src/services/record-engine'
import { createServerClock } from '../../src/services/server-clock'
import { canonicalTypeJson, parseTypeFile } from '../../../shared/core/record-types'

const CUSTOMER_TYPE = '---\nlabel: 顧客\nversion: 1\nstorage: server\nimplements: [counterpart]\nfields:\n  counterpart_kind: { label: 会社か人か, kind: choice, options: [company, person], source: server }\n  domain: { label: ドメイン, kind: text, source: server }\n  email: { label: メール, kind: text, source: server }\nstates: [active]\n---\n'
import { createConnectorRoles } from '../../src/services/connector-roles'
import { noticeKind } from '../../src/services/notifications'
import { recordReader } from '../../src/services/record-access'
import { slackSignalMessage } from '../../src/composition/inbox'
import type { Member } from '../../src/services/access'
import { defaultTaskSettings, replyTarget } from '../../../shared/core/task-settings'
import { coreTypeDefinitions } from '../../../shared/core/core-types'
import type { IncomingMessage } from '../../../shared/types/inbox'
import type { ConnectorRole } from '../../../shared/core/connector-roles'

const TS = '2026-11-02T00:00:00.000Z'
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const EMAILS: Record<string, string> = {
  'u-owner': 'boss@acme.example', 'u-admin': 'admin@acme.example', 'u-alice': 'alice@acme.example',
  'u-bob': 'bob@acme.example', 'u-carol': 'carol@acme.example', 'u-mallory': 'mallory@gmail.com',
}
const MEMBERS = Object.keys(EMAILS)

let conn: Database.Database
let source: CompanyDataSource
let inbox: InboxService
let nowMs = Date.parse('2026-11-02T01:00:00.000Z')
let told: Array<{ companyId: string; userIds: string[]; change?: RecordChange }> = []
let n = 0
let mailbox: Record<string, IncomingMessage[] | 'not-connected'> = {}
let ready = new Set<string>()
/** The fake source stops at its limit: only messages from this time on are listed. */
let cutAt: string | null = null
let listedSince: string[] = []
let engine: RecordEngine
let serviceWriter: ReturnType<typeof createServiceRecordWriter>
/** The company's own days off (task settings), for the reply 目安. */
let companyHolidays: string[] = []

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: ROLES[userId] ?? 'member' })
const AI = (userId: string): ServiceActor => ({ id: userId, kind: 'ai', source: 'claude-code', conversationId: 'conv-1', runId: null })

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '', 'company', ?)").run(`${id}-root`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-root-r`, `${id}-root`, TS)
  // 営業部: u-carol cannot read it.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, '営業部', 'folder', ?)").run(`${id}-sales`, id, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 1, 1, ?)").run(`${id}-sales-e`, `${id}-sales`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', 'u-carol', 0, 0, ?)").run(`${id}-sales-c`, `${id}-sales`, TS)
  // 経理部: a private folder.
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, '経理部', 'folder', ?, ?)").run(`${id}-priv`, id, `${id}-repo`, TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 0, 0, ?)").run(`${id}-priv-e`, `${id}-priv`, TS)
  const records = source.forCompany(id).records
  records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(records, TS)
}

function mail(over: Partial<IncomingMessage> & { to?: IncomingMessage['to'] } = {}): IncomingMessage {
  const k = ++n
  return {
    channel: 'email', messageId: `<m${k}@client.example>`, sourceRef: `fake:${k}`, threadRef: `thread-${k}`,
    occurredAt: '2026-11-02T01:00:00.000Z', subject: `お見積りのお願い ${k}`,
    from: { address: 'tanaka@client.example', name: '田中' }, to: [{ address: 'alice@acme.example' }], cc: [],
    ...over,
  }
}

const handle = (co = 'a') => source.forCompany(co)
const interactions = (co = 'a') => handle(co).records.candidates({ types: ['interaction'] }, 100)
const stateOf = (id: string, co = 'a') => handle(co).records.states([id])[0]
const fieldsOf = (id: string, co = 'a') => JSON.parse(stateOf(id, co).fields) as Record<string, unknown>
const canRead = (userId: string, id: string, co = 'a') => {
  const row = handle(co).records.byIds([id])[0]
  return recordReader(m(userId, co), handle(co).scopes.listWithRules()).record(row)
}
/** The notices the engine's notify would write: member → kind (never the actor). */
function notices(): Array<{ userId: string; kind: string }> {
  const final = (type: string) => new Set(coreTypeDefinitions().find(d => d.name === type)?.final ?? [])
  return told.filter(t => t.change).flatMap(t => t.userIds
    .filter(u => u !== t.change!.entry.actorId && canRead(u, t.change!.entry.recordId, t.companyId))
    .map(u => ({ userId: u, kind: noticeKind(u, t.change!, final(t.change!.type)) })))
}
function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
function settings(body: Record<string, unknown>, co = 'a') {
  ok(inbox.update(m('u-admin', co), body))
}

beforeEach(() => {
  n = 0
  companyHolidays = []
  told = []
  mailbox = {}
  ready = new Set()
  cutAt = null
  listedSince = []
  nowMs = Date.parse('2026-11-02T01:00:00.000Z')
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let id = 0
  const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
  const ids = { newId: () => `id-${++id}`, newToken: () => `${String(++id).padStart(16, '0')}ffffffffffffffff` }
  const roleOf = (_co: string, userId: string) => (MEMBERS.includes(userId) ? ROLES[userId] ?? 'member' : null)
  const writer = createServiceRecordWriter({
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (co, u) => roleOf(co, u) !== null, roleOf,
    notify: (companyId, userIds, change) => { told.push({ companyId, userIds, change }) },
  })
  serviceWriter = writer
  const identities = createIdentityService({ companyData: source, transactions: sqliteTransactions(conn), clock, ids })
  const choices = new Map<string, string | null>()
  const roles = createConnectorRoles({
    choices: { choice: (co, role) => choices.get(`${co}:${role}`) ?? null, setChoice: (co, role, c) => { choices.set(`${co}:${role}`, c) } },
    clock,
  })
  roles.register({ id: 'fakemail', servings: [{ role: 'mail', operations: ['read', 'send'], capabilities: [] }], usable: async () => true })
  inbox = createInboxService({
    companyData: source, clock, ids, writer,
    resolveAddress: (member, address) => identities.resolveAddress(member, address),
    roleOf,
    memberAddresses: () => MEMBERS.map(u => ({ userId: u, email: EMAILS[u] })),
    taskSettings: () => defaultTaskSettings(),
    roles: { resolve: (co, role: ConnectorRole, op) => roles.resolve(co, role, op ?? null) },
  })
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [], isMember: (co, u) => roleOf(co, u) !== null, roleOf, notify: () => {},
    afterAct: (co, change) => inbox.afterAct(co, change),
    // As composition.ts: the company's reply 目安 with its own holidays.
    replyGuideline: (_co, at) => replyTarget(at, defaultTaskSettings().reply, companyHolidays).date,
  })
  const fake: InboxSource = {
    async listSince(_co, userId, since) {
      listedSince.push(since)
      const box = mailbox[userId] ?? []
      if (box === 'not-connected') return box
      const listed = box.filter(x => x.occurredAt >= since)
      return cutAt ? { messages: listed.filter(x => x.occurredAt >= cutAt!), readFrom: cutAt } : listed
    },
    async ready(_co, userId) {
      if (userId === 'u-carol') throw new Error('provider down')
      return ready.has(userId)
    },
  }
  inbox.registerSource('fakemail', fake)
  company('a')
  company('b')
})

describe('who a message belongs to', () => {
  it('the To person\'s own record: in their AI\'s turn, nobody else reads or hears of it', () => {
    expect(inbox.receive('a', 'u-bob', mail({ cc: [{ address: 'bob@acme.example' }, { address: 'carol@acme.example' }] }))).toBe('created')
    const [row] = interactions()
    expect(row.personalOwner).toBe('u-alice')
    expect(stateOf(row.id).state).toBe('received')
    expect(fieldsOf(row.id)).toMatchObject({ assignee: 'u-alice', channel: 'email', intake_reason: 'to', from_address: 'tanaka@client.example' })
    for (const u of ['u-bob', 'u-carol', 'u-owner', 'u-admin']) expect(canRead(u, row.id)).toBe(false)
    expect(canRead('u-alice', row.id)).toBe(true)
    // The AI's turn is not a person's: nobody gets a notice.
    expect(notices()).toEqual([])
    // Naming it: the same answer as a missing record, for the CC reporter and the company owner alike.
    const missing = inbox.item(m('u-bob'), 'interaction-0000000000000000')
    for (const u of ['u-bob', 'u-owner']) expect(inbox.item(m(u), row.id)).toEqual(missing)
    expect(ok(inbox.item(m('u-alice'), row.id)).messages).toHaveLength(1)
  })

  it('CC only: nothing; with the setting, 確認待ち for the CC reporter alone', () => {
    const cc = () => mail({ to: [{ address: 'someone@partner.example' }], cc: [{ address: 'bob@acme.example' }, { address: 'carol@acme.example' }] })
    expect(inbox.receive('a', 'u-bob', cc())).toBe('skipped')
    expect(interactions()).toEqual([])
    settings({ ccOnly: 'unsure' })
    expect(inbox.receive('a', 'u-bob', cc())).toBe('created')
    const [row] = interactions()
    expect(row.personalOwner).toBe('u-bob')
    expect(stateOf(row.id).state).toBe('unsure')
    expect(notices()).toEqual([{ userId: 'u-bob', kind: 'intake_unsure' }])
  })

  it('several in To: the first; with the setting, 確認待ち told to that one only', () => {
    const two = () => mail({ to: [{ address: 'Bob@ACME.example' }, { address: 'alice@acme.example' }] })
    inbox.receive('a', 'u-alice', two())
    expect(interactions()[0].personalOwner).toBe('u-bob')
    expect(fieldsOf(interactions()[0].id).intake_reason).toBe('multiple_to')
    settings({ multipleTo: 'unsure' })
    told = []
    inbox.receive('a', 'u-alice', two())
    const unsure = interactions().find(r => stateOf(r.id).state === 'unsure')!
    expect(unsure.personalOwner).toBe('u-bob')
    expect(notices()).toEqual([{ userId: 'u-bob', kind: 'intake_unsure' }])
  })

  it('a shared address is the department\'s turn: its readers see it, one of them takes it', () => {
    settings({ sharedAddresses: [{ address: 'info@acme.example', folder: '営業部' }] })
    inbox.receive('a', 'u-alice', mail({ to: [{ address: 'info@acme.example' }] }))
    const [row] = interactions()
    expect(row.personalOwner).toBeNull()
    expect(row.folder).toBe('営業部')
    expect(stateOf(row.id).state).toBe('unclaimed')
    expect(ok(inbox.department(m('u-bob'))).records.map(r => r.id)).toEqual([row.id])
    expect(ok(inbox.department(m('u-carol'))).records).toEqual([])
    // Someone who cannot read the folder gets the missing answer, not "already taken".
    const missing = inbox.claim(m('u-carol'), 'interaction-0000000000000000', { expectedVersion: 1 })
    expect(inbox.claim(m('u-carol'), row.id, { expectedVersion: 1 })).toEqual(missing)
    const taken = ok(inbox.claim(m('u-bob'), row.id, { expectedVersion: 1 }))
    expect(taken.record.state).toBe('received')
    expect(fieldsOf(row.id)).toMatchObject({ assignee: 'u-bob', next_actor: 'u-bob' })
    const again = inbox.claim(m('u-alice'), row.id, { expectedVersion: 2 })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.body.code).toBe('NOT_UNCLAIMED')
  })

  it('a shared address may not name a private folder; only owners and admins change the settings', () => {
    const r = inbox.update(m('u-admin'), { sharedAddresses: [{ address: 'info@acme.example', folder: '経理部' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.body.error).not.toContain('経理部')
    const member = inbox.update(m('u-alice'), {})
    expect(member.ok).toBe(false)
    if (!member.ok) expect(member.kind).toBe('forbidden')
  })

  it('internal mail and spam are not taken in; free mail never makes a domain internal', () => {
    expect(inbox.receive('a', 'u-alice', mail({ from: { address: 'carol@acme.example' } }))).toBe('skipped')
    expect(inbox.receive('a', 'u-alice', mail({ from: { address: 'someone@acme.example' } }))).toBe('skipped')
    expect(inbox.receive('a', 'u-alice', mail({ spam: true }))).toBe('skipped')
    settings({ internalDomains: ['group-co.example'] })
    expect(inbox.receive('a', 'u-alice', mail({ from: { address: 'x@group-co.example' } }))).toBe('skipped')
    expect(interactions()).toEqual([])
    // u-mallory uses gmail.com: a Gmail customer is still outside.
    expect(inbox.receive('a', 'u-alice', mail({ from: { address: 'customer@gmail.com' } }))).toBe('created')
    // With the setting off, internal mail is taken in.
    settings({ excludeInternal: false })
    expect(inbox.receive('a', 'u-alice', mail({ from: { address: 'someone@acme.example' } }))).toBe('created')
  })

  it('newsletters and automatic mail: the owner\'s 「やることにしなかった一覧」 only', () => {
    inbox.receive('a', 'u-alice', mail({ bulk: true, subject: 'セミナーのご案内' }))
    inbox.receive('a', 'u-alice', mail({ automated: true, subject: '自動送信' }))
    const list = ok(inbox.setAside(m('u-alice'))).items
    expect(list.map(i => [i.title, i.reason, i.by])).toEqual(expect.arrayContaining([['セミナーのご案内', 'bulk', 'intake'], ['自動送信', 'automated', 'intake']]))
    for (const u of ['u-bob', 'u-owner', 'u-admin']) expect(ok(inbox.setAside(m(u))).items).toEqual([])
    expect(notices()).toEqual([])
  })
})

describe('one interaction per thread, no body', () => {
  it('a message id is taken once, also from another reporter; nothing of a body is stored', () => {
    const msg = { ...mail(), body: '本文：至急ご連絡ください 090-0000-0000' } as IncomingMessage
    expect(inbox.receive('a', 'u-alice', msg)).toBe('created')
    expect(inbox.receive('a', 'u-bob', msg)).toBe('duplicate')
    expect(interactions()).toHaveLength(1)
    const dump = JSON.stringify([
      conn.prepare('SELECT * FROM inbox_messages').all(), conn.prepare('SELECT * FROM record_state').all(),
      conn.prepare('SELECT * FROM record_ledger').all(), conn.prepare('SELECT * FROM records').all(),
    ])
    expect(dump).not.toContain('090-0000-0000')
  })

  it('their reply: a 返事待ち goes to the AI\'s check and the assignee hears of it; an automatic reply does not count', () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    const [row] = interactions()
    const judged = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '見積の依頼', endCondition: '見積を送れば' }))
    const rr = judged.replyRequestId!
    // The person turns it into 返事待ち (generic action in the app; here the stored state is set as the engine would).
    handle().records.writeState({ recordId: rr, state: 'waiting_reply', fields: JSON.stringify(fieldsOf(rr)), version: 2, updatedAt: TS }, 1)
    told = []
    expect(inbox.receive('a', 'u-alice', mail({ references: [first.messageId], automated: true }))).toBe('continued')
    expect(stateOf(rr).state).toBe('waiting_reply')
    expect(inbox.receive('a', 'u-alice', mail({ references: [first.messageId] }))).toBe('continued')
    expect(stateOf(rr).state).toBe('checking')
    expect(fieldsOf(rr).trigger_kind).toBe('their_reply')
    expect(notices()).toEqual([{ userId: 'u-alice', kind: 'reply_arrived' }])
    expect(interactions()).toHaveLength(1)
  })

  it('a reply that reached another member only is not the owner\'s: it is that member\'s own', () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    expect(inbox.receive('a', 'u-bob', mail({ references: [first.messageId], to: [{ address: 'bob@acme.example' }] }))).toBe('created')
    const bobs = interactions().filter(r => r.personalOwner === 'u-bob')
    expect(bobs).toHaveLength(1)
    expect(handle().inbox.messagesOf(interactions().find(r => r.personalOwner === 'u-alice')!.id)).toHaveLength(1)
  })

  it('a reply of the company: the AI checks it (default), or it is over (setting) with who replied', () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    const row = interactions()[0]
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    expect(inbox.receive('a', 'u-bob', mail({ references: [first.messageId], from: { address: 'bob@acme.example' }, to: [{ address: 'tanaka@client.example' }] }))).toBe('continued')
    expect(stateOf(rr).state).toBe('checking')
    expect(fieldsOf(rr).trigger_kind).toBe('our_reply')
    // u-bob cannot read u-alice's own record: never named on it.
    expect(fieldsOf(rr).replied_by).toBeUndefined()

    const second = mail()
    inbox.receive('a', 'u-alice', second)
    const row2 = interactions().find(r => r.id !== row.id)!
    const rr2 = ok(inbox.judge(m('u-alice'), AI('u-alice'), row2.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    settings({ memberReply: 'close' })
    inbox.receive('a', 'u-alice', mail({ references: [second.messageId], outgoing: true, from: { address: 'alice@acme.example' } }))
    expect(stateOf(rr2).state).toBe('closed')
    expect(fieldsOf(rr2).replied_by).toBe('u-alice')
  })
})

describe('the AI\'s judgement', () => {
  it('a 返事のお願い: owner-only like its message, due = the 目安 (翌営業日 past 文化の日) unless the message says one', () => {
    inbox.receive('a', 'u-alice', mail({ occurredAt: '2026-11-02T01:00:00.000Z' }))
    const row = interactions()[0]
    told = []
    const r = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '見積の依頼', endCondition: '見積を送れば' }))
    expect(r.state).toBe('handled')
    const rr = handle().records.byIds([r.replyRequestId!])[0]
    expect(rr.personalOwner).toBe('u-alice')
    expect(stateOf(rr.id).state).toBe('preparing')
    expect(fieldsOf(rr.id)).toMatchObject({ assignee: 'u-alice', due: '2026-11-04', guideline_due: '2026-11-04', end_condition: '見積を送れば' })
    expect(handle().records.linksFrom([rr.id]).find(l => l.name === 'interaction')?.targetId).toBe(row.id)
    for (const u of ['u-owner', 'u-admin', 'u-bob']) expect(canRead(u, rr.id)).toBe(false)
    expect(notices()).toEqual([])

    inbox.receive('a', 'u-alice', mail())
    const row2 = interactions().find(x => x.id !== row.id)!
    const r2 = ok(inbox.judge(m('u-alice'), AI('u-alice'), row2.id, { expectedVersion: 1, outcome: 'reply', reason: '締切あり', deadline: '2026-11-06T17:00', deadlineNote: '6日17時までに' }))
    expect(fieldsOf(r2.replyRequestId!)).toMatchObject({ due: '2026-11-06T17:00', guideline_due: '2026-11-04', due_note: '6日17時までに' })
  })

  it('only the owner\'s AI in its turn; anyone else gets the missing answer', () => {
    inbox.receive('a', 'u-alice', mail())
    const row = interactions()[0]
    const body = { expectedVersion: 1, outcome: 'no_reply', reason: 'お礼だけ' }
    const missing = inbox.judge(m('u-bob'), AI('u-bob'), 'interaction-0000000000000000', body)
    expect(inbox.judge(m('u-bob'), AI('u-bob'), row.id, body)).toEqual(missing)
    expect(inbox.judge(m('u-owner'), AI('u-owner'), row.id, body)).toEqual(missing)
    expect(ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, body)).state).toBe('handled')
    const again = inbox.judge(m('u-alice'), AI('u-alice'), row.id, { ...body, expectedVersion: 2 })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.body.code).toBe('NOT_AI_TURN')
  })

  it('a person\'s 「やることにする」 wins: the AI cannot set it aside again', () => {
    inbox.receive('a', 'u-alice', mail({ bulk: true }))
    const row = interactions()[0]
    // 「やることにする」 (take_up) by the person, as the engine writes it.
    const records = handle().records
    records.writeState({ recordId: row.id, state: 'received', fields: stateOf(row.id).fields, version: 2, updatedAt: TS }, 1)
    records.appendLedger({
      recordId: row.id, version: 2, action: 'take_up', fromState: 'excluded', toState: 'received', actorId: 'u-alice', actorKind: 'human', actorSource: null,
      at: TS, note: '', changes: [{ field: 'state', before: 'excluded', after: 'received' }], attachments: [], decision: null, isDecision: false,
      typeVersion: 5, reversesVersion: null, proposedBy: null, conversationId: null, runId: null,
    })
    const r = inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 2, outcome: 'set_aside', reason: 'メルマガ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.body.code).toBe('PERSON_DECIDED')
    expect(ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 2, outcome: 'unsure', reason: '誰あてか不明' })).state).toBe('unsure')
  })
})

describe('polling through the role, reconnecting', () => {
  it('a first connection starts now; a reconnection reads back at most 7 days, a longer break is a gap its member sees', async () => {
    inbox.connect('a', 'u-alice', 'email')
    mailbox['u-alice'] = [mail({ occurredAt: '2026-11-01T00:00:00.000Z' }), mail({ occurredAt: '2026-11-02T01:30:00.000Z' })]
    nowMs = Date.parse('2026-11-02T02:00:00.000Z')
    expect(await inbox.poll('a', 'u-alice')).toEqual({ read: 1, outcome: 'done' })
    expect(listedSince[0]).toBe('2026-11-02T01:00:00.000Z')

    // Broken for 3 days: read back from where it stopped.
    mailbox['u-alice'] = 'not-connected'
    nowMs = Date.parse('2026-11-03T02:00:00.000Z')
    expect((await inbox.poll('a', 'u-alice')).outcome).toBe('not-connected')
    mailbox['u-alice'] = []
    nowMs = Date.parse('2026-11-05T02:00:00.000Z')
    await inbox.poll('a', 'u-alice')
    // From where it stopped, and 10 minutes before it (never before the connection).
    expect(listedSince.at(-1)).toBe('2026-11-02T01:50:00.000Z')
    expect(inbox.status(m('u-alice')).gaps).toEqual([])

    // Broken for 10 days: 7 days are read, the 3 before are a gap.
    nowMs = Date.parse('2026-11-15T02:00:00.000Z')
    await inbox.poll('a', 'u-alice')
    expect(listedSince.at(-1)).toBe('2026-11-08T01:50:00.000Z')
    expect(inbox.status(m('u-alice')).gaps).toEqual([{ channel: 'email', from: '2026-11-05T02:00:00.000Z', to: '2026-11-08T02:00:00.000Z' }])
    for (const u of ['u-bob', 'u-admin', 'u-owner']) expect(inbox.status(m(u))).toEqual({ connections: [], gaps: [] })
    expect(inbox.status(m('u-alice', 'b'))).toEqual({ connections: [], gaps: [] })
  })

  it('「過去7日を見直す」 moves only the member\'s own window back; messages seen are not taken twice', async () => {
    const msg = mail({ occurredAt: '2026-11-01T00:00:00.000Z' })
    inbox.receive('a', 'u-alice', msg)
    inbox.connect('a', 'u-alice', 'email')
    const r = inbox.backfill(m('u-bob'), { channel: 'email' })
    expect(r.ok).toBe(false)
    ok(inbox.backfill(m('u-alice'), { channel: 'email' }))
    mailbox['u-alice'] = [msg]
    await inbox.poll('a', 'u-alice')
    expect(listedSince.at(-1)).toBe('2026-10-26T01:00:00.000Z')
    expect(interactions()).toHaveLength(1)
  })

  it('the clock connects a member once the source can read them, from that run on, once', async () => {
    nowMs = Date.parse('2026-11-04T03:00:00.000Z')
    mailbox['u-alice'] = [mail({ occurredAt: '2026-11-04T02:00:00.000Z' })]
    expect(await inbox.pollCompany('a')).toBe(0)
    expect(inbox.status(m('u-alice')).connections).toEqual([])

    // Alice granted and turned 受信を読む on: connected now; mail from before is not read back.
    // Carol's check throws (the provider is down): she is not connected, nobody else is held up.
    ready.add('u-alice')
    expect(await inbox.pollCompany('a')).toBe(0)
    const connected = [{ channel: 'email', connectedAt: '2026-11-04T03:00:00.000Z', checkedUntil: '2026-11-04T03:00:00.000Z' }]
    expect(inbox.status(m('u-alice')).connections).toEqual(connected)
    expect(inbox.status(m('u-carol')).connections).toEqual([])

    mailbox['u-alice'] = [mail({ occurredAt: '2026-11-04T03:02:00.000Z' })]
    nowMs = Date.parse('2026-11-04T03:05:00.000Z')
    expect(await inbox.pollCompany('a')).toBe(1)
    expect(interactions()).toHaveLength(1)
    // Already connected: the connection is not made again (its time stays).
    expect(inbox.status(m('u-alice')).connections[0].connectedAt).toBe('2026-11-04T03:00:00.000Z')
  })

  it('a mail listed late keeps its earlier time and is still read; one seen before is not taken twice', async () => {
    nowMs = Date.parse('2026-11-04T03:00:00.000Z')
    inbox.connect('a', 'u-alice', 'email')
    const early = mail({ occurredAt: '2026-11-04T03:01:00.000Z' })
    mailbox['u-alice'] = [early]
    nowMs = Date.parse('2026-11-04T03:05:00.000Z')
    await inbox.poll('a', 'u-alice')
    // Received at 03:04 but listed only after the 03:05 poll.
    const late = mail({ occurredAt: '2026-11-04T03:04:00.000Z' })
    mailbox['u-alice'] = [early, late]
    nowMs = Date.parse('2026-11-04T03:10:00.000Z')
    await inbox.poll('a', 'u-alice')
    expect(interactions()).toHaveLength(2)
  })

  it('the source stopped at its limit: the span it did not reach is an unchecked gap', async () => {
    nowMs = Date.parse('2026-11-01T00:00:00.000Z')
    inbox.connect('a', 'u-alice', 'email')
    mailbox['u-alice'] = [mail({ occurredAt: '2026-11-03T00:00:00.000Z' }), mail({ occurredAt: '2026-11-05T00:00:00.000Z' })]
    cutAt = '2026-11-04T00:00:00.000Z'
    nowMs = Date.parse('2026-11-06T00:00:00.000Z')
    expect(await inbox.poll('a', 'u-alice')).toEqual({ read: 1, outcome: 'done' })
    expect(inbox.status(m('u-alice')).gaps).toEqual([{ channel: 'email', from: '2026-11-01T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' }])
  })

  it('no connector serving the mail role: nothing is read and the window stays', async () => {
    const lone = createInboxService({
      companyData: source, clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }, ids: { newId: () => 'x', newToken: () => 'x' },
      writer: { create: () => { throw new Error('no') }, transition: () => { throw new Error('no') }, retitle: () => { throw new Error('no') } },
      resolveAddress: () => ({ ok: true, value: { person: [], company: [] } }), roleOf: () => 'member', memberAddresses: () => [], taskSettings: () => defaultTaskSettings(),
    })
    lone.connect('a', 'u-alice', 'email')
    expect(await lone.poll('a', 'u-alice')).toEqual({ read: 0, outcome: 'no-source' })
  })
})

describe('companies apart', () => {
  it('another company\'s settings and messages change nothing here', () => {
    settings({ excludeBulk: false }, 'b')
    const msg = mail({ bulk: true })
    inbox.receive('b', 'u-alice', msg)
    expect(inbox.receive('a', 'u-alice', msg)).toBe('created')
    const [row] = interactions('a')
    expect(row.personalOwner).toBe('u-alice')
    expect(stateOf(row.id).state).toBe('excluded')
    expect(interactions('b')).toHaveLength(1)
    expect(stateOf(interactions('b')[0].id, 'b').state).toBe('received')
  })
})

describe('Slack signals (A3 → the inbox)', () => {
  it('a colleague\'s DM is the member\'s own chat message (chat is not 社内どうし); a thread reply joins it', () => {
    const sig = { companyId: 'a', userId: 'u-alice', kind: 'dm' as const, channelId: 'D1', ts: '1793581200.000100', threadTs: null, senderSlackUserId: 'U0BOB', senderName: '二宮 二郎', external: false }
    expect(inbox.receive('a', 'u-alice', slackSignalMessage(sig))).toBe('created')
    const [row] = interactions()
    expect(row.personalOwner).toBe('u-alice')
    // The sender by name only (the card's 「二宮 二郎 から」), like a mail sender's name; never the Slack id.
    expect(fieldsOf(row.id)).toMatchObject({ channel: 'chat', source_ref: 'slack:D1:1793581200.000100', occurred_at: '2026-11-02T01:00:00.000Z', counterpart_text: '二宮 二郎' })
    expect(inbox.receive('a', 'u-alice', slackSignalMessage({ ...sig, ts: '1793581260.000200', threadTs: sig.ts }))).toBe('continued')
    expect(inbox.receive('a', 'u-alice', slackSignalMessage(sig))).toBe('duplicate')
    expect(interactions()).toHaveLength(1)
  })

  it('a sender whose name Slack did not give shows no 「slack:U… から」', () => {
    const sig = { companyId: 'a', userId: 'u-alice', kind: 'mention' as const, channelId: 'C1', ts: '1793581200.000100', threadTs: null, senderSlackUserId: 'U630QNGDB', senderName: null, external: false }
    expect(inbox.receive('a', 'u-alice', slackSignalMessage(sig))).toBe('created')
    expect(fieldsOf(interactions()[0].id).counterpart_text ?? null).toBeNull()
  })
})

// Owner FB 2026-11-04: a Slack mention's card read 「（件名なし）」.
describe('the AI names a message without a subject', () => {
  const dm = (ts: string) => slackSignalMessage({ companyId: 'a', userId: 'u-alice', kind: 'dm', channelId: 'D1', ts, threadTs: null, senderSlackUserId: 'U0BOB', senderName: '二宮', external: false })
  const titleOf = (id: string) => handle().records.byIds([id])[0].title

  it('its owner\'s AI sets a short title (≤ 60) on a chat message or a mail with no subject', () => {
    inbox.receive('a', 'u-alice', dm('1793581200.000100'))
    const chat = interactions()[0]
    ok(inbox.judge(m('u-alice'), AI('u-alice'), chat.id, { expectedVersion: 1, outcome: 'no_reply', reason: '連絡だけ', title: `明日の打ち合わせの時間変更\n${'あ'.repeat(80)}` }))
    expect(titleOf(chat.id)).toBe(`明日の打ち合わせの時間変更 ${'あ'.repeat(46)}`)
    expect(titleOf(chat.id)).toHaveLength(60)

    inbox.receive('a', 'u-alice', mail({ subject: '' }))
    const noSubject = interactions().find(r => r.id !== chat.id)!
    expect(titleOf(noSubject.id)).toBe('（件名なし）')
    const r = ok(inbox.judge(m('u-alice'), AI('u-alice'), noSubject.id, { expectedVersion: 1, outcome: 'reply', reason: '依頼', title: '請求書の再送のお願い' }))
    expect(titleOf(noSubject.id)).toBe('請求書の再送のお願い')
    expect(titleOf(r.replyRequestId!)).toBe('請求書の再送のお願い')
  })

  it('never over a mail\'s subject, nor a title the AI already gave, nor someone\'s department message', () => {
    inbox.receive('a', 'u-alice', mail({ subject: '見積のお願い' }))
    const withSubject = interactions()[0]
    const r = ok(inbox.judge(m('u-alice'), AI('u-alice'), withSubject.id, { expectedVersion: 1, outcome: 'reply', reason: '依頼', title: '見積' }))
    expect(titleOf(withSubject.id)).toBe('見積のお願い')
    expect(titleOf(r.replyRequestId!)).toBe('見積')

    // The thread went on: judged again, the first title stays.
    inbox.receive('a', 'u-alice', dm('1793581300.000100'))
    const chat = interactions().find(x => x.id !== withSubject.id)!
    ok(inbox.judge(m('u-alice'), AI('u-alice'), chat.id, { expectedVersion: 1, outcome: 'no_reply', reason: '連絡だけ', title: '最初の名前' }))
    expect(titleOf(chat.id)).toBe('最初の名前')
    expect(inbox.receive('a', 'u-alice', slackSignalMessage({
      companyId: 'a', userId: 'u-alice', kind: 'dm', channelId: 'D1', ts: '1793581360.000100', threadTs: '1793581300.000100', senderSlackUserId: 'U0BOB', senderName: '二宮', external: false,
    }))).toBe('continued')
    expect(stateOf(chat.id).state).toBe('received')
    ok(inbox.judge(m('u-alice'), AI('u-alice'), chat.id, { expectedVersion: stateOf(chat.id).version, outcome: 'no_reply', reason: '続き', title: '二つ目の名前' }))
    expect(titleOf(chat.id)).toBe('最初の名前')

    // A shared address's message (the department's, not owner-only) keeps its title even when taken.
    settings({ sharedAddresses: [{ address: 'info@acme.example', folder: '営業部' }] })
    inbox.receive('a', 'u-alice', mail({ to: [{ address: 'info@acme.example' }], subject: '' }))
    const shared = interactions().find(x => x.personalOwner === null)!
    ok(inbox.claim(m('u-bob'), shared.id, { expectedVersion: 1 }))
    ok(inbox.judge(m('u-bob'), AI('u-bob'), shared.id, { expectedVersion: 2, outcome: 'no_reply', reason: '連絡だけ', title: '部署の名前' }))
    expect(titleOf(shared.id)).toBe('（件名なし）')
  })

  it('only the AI judging it in its turn: anyone else\'s judgement is refused and changes nothing', () => {
    inbox.receive('a', 'u-alice', dm('1793581400.000100'))
    const chat = interactions()[0]
    for (const u of ['u-bob', 'u-owner']) {
      expect(inbox.judge(m(u), AI(u), chat.id, { expectedVersion: 1, outcome: 'no_reply', reason: 'x', title: '乗っ取り' }).ok).toBe(false)
    }
    expect(titleOf(chat.id)).toBe('（件名なし）')
  })
})


describe('B4: what the AI judges by', () => {
  it('the owner\'s own: state, version and pointers, never a body; a 返事のお願い answers its message and why it is the AI\'s turn', () => {
    inbox.receive('a', 'u-alice', mail())
    const [row] = interactions()
    expect(ok(inbox.item(m('u-alice'), row.id))).toMatchObject({ recordId: row.id, state: 'received', version: 1, tasks: [], replyRequests: [] })
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    const view = ok(inbox.item(m('u-alice'), rr))
    expect(view.recordId).toBe(row.id)
    expect(view.replyRequests).toEqual([{ id: rr, state: 'preparing' }])
    expect(view.request).toMatchObject({ id: rr, purpose: 'draft' })
    expect(ok(inbox.item(m('u-alice'), row.id)).request).toBeUndefined()
    // Anyone else: the missing record's answer.
    for (const u of ['u-bob', 'u-owner', 'u-admin']) {
      expect(inbox.item(m(u), rr)).toEqual(inbox.item(m(u), 'reply_request-0000000000000000'))
    }
  })
})

describe('B4: a task as the outcome', () => {
  it('counts only a task that names this message; the interaction is handled and a second run sees the task', async () => {
    inbox.receive('a', 'u-alice', mail())
    inbox.receive('a', 'u-alice', mail())
    const [row, other] = interactions()
    const make = (link: string) => engine.create(m('u-alice'), { id: 'u-alice', kind: 'ai', source: 'claude-code', conversationId: 'conv-1' },
      { type: 'task', title: '見積を作る', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [link] } })
    const elsewhere = make(other.id)
    const mine = make(row.id)
    if (!elsewhere.ok || !mine.ok) throw new Error('task not made')
    const judge = (taskId: unknown) => inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'task', reason: '見積の依頼', taskId })
    for (const bad of [undefined, 'task-0000000000000000', elsewhere.value.record.id]) {
      const r = judge(bad)
      expect(r.ok).toBe(false)
      expect(stateOf(row.id).state).toBe('received')
    }
    expect(ok(judge(mine.value.record.id))).toMatchObject({ state: 'handled', taskId: mine.value.record.id, replyRequestId: null })
    expect(fieldsOf(row.id).needs_reply).toBe(false)
    expect(ok(inbox.item(m('u-alice'), row.id)).tasks).toEqual([{ id: mine.value.record.id, title: '見積を作る' }])
  })

  it('a task the AI makes from a message always has a due: the stated deadline, else the 目安 past holidays (owner FB #13)', () => {
    inbox.receive('a', 'u-alice', mail())
    const [row] = interactions()
    const AI_ACTOR = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-1' }
    const byAi = (fields: Record<string, unknown>) => ok(engine.createByAi(m('u-alice'), AI_ACTOR,
      { type: 'task', title: '経費精算を承認する', personal: true, fields: { assignee: 'u-alice', ...fields }, links: { interaction: [row.id] } })).record.id
    // None sent (or null): received Monday 11/2, 翌営業日 past 文化の日 (11/3) → 11/4.
    expect(fieldsOf(byAi({})).due).toBe('2026-11-04')
    expect(fieldsOf(byAi({ due: null })).due).toBe('2026-11-04')
    // The deadline the AI read in the message is kept.
    expect(fieldsOf(byAi({ due: '2026-11-10T12:00' })).due).toBe('2026-11-10T12:00')
    // The company's own day off is skipped too.
    companyHolidays = ['2026-11-04']
    expect(fieldsOf(byAi({})).due).toBe('2026-11-05')
    // Not from a message, or a person's own create: no due is made up.
    expect(fieldsOf(ok(engine.createByAi(m('u-alice'), AI_ACTOR, { type: 'task', title: 'メモ', fields: { assignee: 'u-alice' } })).record.id).due).toBeUndefined()
    expect(fieldsOf(ok(engine.create(m('u-alice'), AI_ACTOR, { type: 'task', title: '手で', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [row.id] } })).record.id).due).toBeUndefined()
  })

  it('a 返事のお願い links the 相手 found now (名寄せ), when the message had none', () => {
    inbox.receive('a', 'u-alice', mail())
    const [row] = interactions()
    expect(handle().records.linksFrom([row.id]).filter(l => l.name === 'counterpart')).toEqual([])
    // A 相手 made after the message came (a company by the sender's domain).
    const t = parseTypeFile('customer', CUSTOMER_TYPE)
    if (!t.ok) throw new Error(t.errors.join())
    handle().records.insertTypeVersion({ name: 'customer', version: 1, definition: canonicalTypeJson(t.definition), source: 'file', commitSha: null, createdAt: TS })
    handle().records.upsert({
      id: 'customer-00000001', type: 'customer', typeVersion: 1, scopeId: null, path: null, folder: null, personalOwner: null,
      title: '取引先', summary: '', createdAt: TS, updatedAt: TS, removedAt: null,
    })
    handle().records.writeState({ recordId: 'customer-00000001', state: 'active', fields: JSON.stringify({ counterpart_kind: 'company', domain: 'client.example' }), version: 1, updatedAt: TS }, 0)
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    expect(handle().records.linksFrom([rr]).filter(l => l.name === 'counterpart').map(l => l.targetId)).toEqual(['customer-00000001'])
  })
})


describe('B4: the member already replied (Gmail, Slack, or somewhere ACB cannot see)', () => {
  const dm = (over: Partial<Parameters<typeof slackSignalMessage>[0]>) => slackSignalMessage({
    companyId: 'a', userId: 'u-alice', kind: 'dm', channelId: 'D0AB', ts: '1793581200.000100', threadTs: null, senderSlackUserId: 'U0TANAKA', external: true, ...over,
  } as Parameters<typeof slackSignalMessage>[0])

  it('a draft prepared for the 返事のお願い is discarded when the member replies in the thread, never offered to send', () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    const [row] = interactions()
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    const draft = serviceWriter.create('a', {
      type: 'outbound_message', title: 'Re: お見積り', personalOwner: 'u-alice', fields: { assignee: 'u-alice', requested_by: 'u-alice', channel: 'email' },
      actor: { id: 'u-alice', kind: 'ai', source: 'claude-code', conversationId: 'conv-1', runId: null }, note: '', quiet: true,
    })
    if (!draft.ok) throw new Error(draft.reason)
    handle().records.replaceLinks(rr, [
      ...handle().records.linksFrom([rr]),
      { sourceId: rr, name: 'prepared', position: 9, targetId: draft.record.id, targetPath: null },
    ])
    inbox.receive('a', 'u-alice', mail({ references: [first.messageId], from: { address: 'alice@acme.example' }, to: [{ address: 'tanaka@client.example' }] }))
    expect(stateOf(rr).state).toBe('checking')
    expect(stateOf(draft.record.id).state).toBe('discarded')
    expect(handle().records.ledger(draft.record.id).at(-1)?.note).toBe('メールで返信済み')
  })

  it('replied before the AI judged it: the message is handled, and the AI makes no 返事のお願い for an answered thread', () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    inbox.receive('a', 'u-alice', mail({ references: [first.messageId], from: { address: 'alice@acme.example' }, to: [{ address: 'tanaka@client.example' }] }))
    const [row] = interactions()
    expect(stateOf(row.id).state).toBe('handled')
    expect(fieldsOf(row.id).needs_reply).toBe(false)

    // Judged while the answered thread is still 届いた (the reply came in between the read and the judgement).
    const second = mail()
    inbox.receive('a', 'u-alice', second)
    const row2 = interactions().find(r => r.id !== row.id)!
    handle().inbox.insertMessage({ channel: 'email', messageId: '<late@acme.example>', interactionId: row2.id, direction: 'out', occurredAt: '2026-11-02T02:00:00.000Z', seenAt: TS, sourceRef: 'fake:late' })
    const r = ok(inbox.judge(m('u-alice'), AI('u-alice'), row2.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' }))
    expect(r).toMatchObject({ state: 'handled', replyRequestId: null, alreadyReplied: true })
    expect(handle().records.candidates({ types: ['reply_request'] }, 10)).toEqual([])
  })

  it('Slack: the member\'s plain message in the DM answers the last message there (within 3 days); later or elsewhere it does not', () => {
    inbox.receive('a', 'u-alice', dm({}))
    const [row] = interactions()
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    // Another DM channel: not this one.
    expect(inbox.receive('a', 'u-alice', dm({ kind: 'own', channelId: 'D0ZZ', ts: '1793581300.000100', senderSlackUserId: 'U0ALICE' }))).toBe('skipped')
    // Four days later: too late to be sure it answers it.
    expect(inbox.receive('a', 'u-alice', dm({ kind: 'own', ts: '1793926900.000100', senderSlackUserId: 'U0ALICE' }))).toBe('skipped')
    expect(stateOf(rr).state).toBe('preparing')
    // An hour later in the same DM, unthreaded: her reply.
    expect(inbox.receive('a', 'u-alice', dm({ kind: 'own', ts: '1793584800.000100', senderSlackUserId: 'U0ALICE' }))).toBe('continued')
    expect(stateOf(rr).state).toBe('checking')
    expect(fieldsOf(rr).trigger_kind).toBe('our_reply')
    expect(handle().records.ledger(rr).at(-1)?.note).toBe('チャット（Slack）で返信済み')
  })

  it('a reply ACB cannot see (the phone, another channel): the person\'s 「もう返した」 ends it, never the AI\'s', async () => {
    inbox.receive('a', 'u-alice', mail())
    const [row] = interactions()
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    const ai = await engine.act(m('u-alice'), { id: 'u-alice', kind: 'ai', source: 'claude-code', conversationId: 'conv-1' }, rr, 'replied_elsewhere', { expectedVersion: 1 })
    expect(ai.ok).toBe(false)
    const person = await engine.act(m('u-alice'), { id: 'u-alice', kind: 'human', source: null }, rr, 'replied_elsewhere', { expectedVersion: 1, note: '電話で返した' })
    expect(person.ok).toBe(true)
    expect(stateOf(rr).state).toBe('closed')
  })

  it('「もう返した」 drops the prepared draft and the card\'s own reply drafts to that 連絡, so no second reply can be sent; other 連絡\' drafts stay', async () => {
    inbox.receive('a', 'u-alice', mail())
    inbox.receive('a', 'u-alice', mail())
    const [row, other] = interactions()
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    const draft = (interactionId: string, kind: 'ai' | 'human') => {
      const d = serviceWriter.create('a', {
        type: 'outbound_message', title: 'Re: お見積り', personalOwner: 'u-alice',
        fields: { assignee: 'u-alice', requested_by: 'u-alice', channel: 'email' }, links: { interaction: [interactionId] },
        actor: kind === 'ai' ? { id: 'u-alice', kind: 'ai', source: 'claude-code', conversationId: 'conv-1', runId: null } : { id: 'u-alice', kind: 'human', source: null },
        note: '', quiet: true,
      })
      if (!d.ok) throw new Error(d.reason)
      return d.record.id
    }
    const prepared = draft(row.id, 'ai')
    const fromCard = draft(row.id, 'human')
    const elsewhere = draft(other.id, 'human')
    handle().records.replaceLinks(rr, [...handle().records.linksFrom([rr]), { sourceId: rr, name: 'prepared', position: 9, targetId: prepared, targetPath: null }])
    const person = await engine.act(m('u-alice'), { id: 'u-alice', kind: 'human', source: null }, rr, 'replied_elsewhere', { expectedVersion: 1 })
    expect(person.ok).toBe(true)
    expect(stateOf(prepared).state).toBe('discarded')
    expect(stateOf(fromCard).state).toBe('discarded')
    expect(handle().records.ledger(fromCard).at(-1)?.note).toBe('ほかの経路で返信済み（もう返した）')
    expect(stateOf(elsewhere).state).toBe('draft')
  })
})


describe('B5: 追いかけ (following up)', () => {
  /** A 返事のお願い in 返事待ち until `waitUntil` (the person's 「相手の返事待ちにする」, stored as the engine would). */
  function waiting(waitUntil: string) {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    const row = interactions().find(r => !handle().records.candidates({ types: ['reply_request'], link: { name: 'interaction', id: r.id } }, 5).length)!
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    handle().records.writeState({ recordId: rr, state: 'waiting_reply', fields: JSON.stringify({ ...fieldsOf(rr), wait_until: waitUntil }), version: 2, updatedAt: TS }, 1)
    return { first, rr }
  }
  function clockWith(autoRun: boolean) {
    const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
    return createServerClock({
      companyIds: () => ['a'], companyData: source, clock, writer: serviceWriter,
      notifications: { sweep: () => 0 },
      autoRunFor: () => autoRun,
      timeZoneOf: () => 'Asia/Tokyo', yieldNow: async () => {}, log: () => {},
    })
  }

  it('never before the promised time; after it the AI\'s turn (自動で進める on), else the assignee\'s', async () => {
    // 2026-11-02T01:00Z = 10:00 in Tokyo.
    const { rr } = waiting('2026-11-02T11:00')
    await clockWith(true).runOnce()
    expect(stateOf(rr).state).toBe('waiting_reply')
    nowMs = Date.parse('2026-11-02T02:30:00.000Z') // 11:30
    await clockWith(true).runOnce()
    expect(stateOf(rr).state).toBe('preparing')
    expect(handle().records.ledger(rr).at(-1)).toMatchObject({ action: 'wait_over', actorKind: 'external' })
    expect(ok(inbox.item(m('u-alice'), rr)).request).toMatchObject({ id: rr, purpose: 'follow_up', waitUntil: '2026-11-02T11:00' })

    const other = waiting('2026-11-01')
    await clockWith(false).runOnce()
    expect(stateOf(other.rr).state).toBe('open')
  })

  it('their reply after the time passed: the AI checks it (the reply\'s content decides) and the nudge\'s draft is dropped', async () => {
    const { first, rr } = waiting('2026-11-01')
    await clockWith(true).runOnce()
    expect(stateOf(rr).state).toBe('preparing')
    const nudge = serviceWriter.create('a', {
      type: 'outbound_message', title: '催促', personalOwner: 'u-alice', fields: { assignee: 'u-alice', requested_by: 'u-alice', channel: 'email' },
      actor: { id: 'u-alice', kind: 'ai', source: 'claude-code', conversationId: 'conv-1', runId: null }, note: '', quiet: true,
    })
    if (!nudge.ok) throw new Error(nudge.reason)
    handle().records.replaceLinks(rr, [...handle().records.linksFrom([rr]), { sourceId: rr, name: 'prepared', position: 9, targetId: nudge.record.id, targetPath: null }])
    // An automatic reply is no reply.
    inbox.receive('a', 'u-alice', mail({ references: [first.messageId], automated: true }))
    expect(stateOf(rr).state).toBe('preparing')
    inbox.receive('a', 'u-alice', mail({ references: [first.messageId] }))
    expect(stateOf(rr).state).toBe('checking')
    expect(stateOf(nudge.record.id).state).toBe('discarded')
    expect(ok(inbox.item(m('u-alice'), rr)).request?.purpose).toBe('check_reply')
  })

  it('a first draft (not a follow-up) is not ended by another message of theirs', async () => {
    const first = mail()
    inbox.receive('a', 'u-alice', first)
    const [row] = interactions()
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), row.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    inbox.receive('a', 'u-alice', mail({ references: [first.messageId] }))
    expect(stateOf(rr).state).toBe('preparing')
    expect(ok(inbox.item(m('u-alice'), rr)).request?.purpose).toBe('draft')
  })
})

describe('we sent first: 返事を待つ (outbound-mail.md "Waiting for their answer")', () => {
  const OURS = '<acb.send-1@acme.example>'
  /** A task in 営業部 (u-carol cannot read it), assigned to `assignee`. */
  function task(assignee: string, folder = '営業部') {
    const t = serviceWriter.create('a', {
      type: 'task', title: '見積を出す', folder, fields: { assignee, requested_by: assignee },
      actor: { id: assignee, kind: 'human', source: null }, quiet: true,
    })
    if (!t.ok) throw new Error(t.reason)
    return t.record.id
  }
  /** What the mail service does after a send with the box ticked: the receipt (handled, our Message-ID), then the inbox waits. */
  function sentWaiting(taskId: string | null, waitUntil = '2026-11-05T09:00') {
    const made = serviceWriter.create('a', {
      type: 'interaction', title: 'お見積りのご送付', folder: '営業部',
      fields: { occurred_at: TS, channel: 'email', message_id: OURS, source_ref: 'gmail:s1', assignee: 'u-alice', needs_reply: false },
      actor: { id: 'u-alice', kind: 'human', source: null }, state: 'handled', quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    told = []
    const rr = inbox.awaitOwnMessage({
      companyId: 'a', userId: 'u-alice', interactionId: made.record.id, channel: 'email', messageId: OURS, sourceRef: 'gmail:s1',
      occurredAt: TS, waitUntil, title: 'お見積りのご送付', waitingOn: '田中さんからの返事', to: 'tanaka@client.example', taskId,
    })
    if (!rr) throw new Error('no reply request')
    return { interactionId: made.record.id, rr }
  }
  const linkOf = (id: string, name: string) => handle().records.linksFrom([id]).find(l => l.name === name)?.targetId ?? null

  it('a 返事のお願い in 返事待ち until the picked morning, the sender\'s, linked to the mail\'s やりとり and its task; nobody told', () => {
    const t = task('u-bob')
    const { interactionId, rr } = sentWaiting(t)
    expect(stateOf(rr).state).toBe('waiting_reply')
    expect(fieldsOf(rr)).toMatchObject({ assignee: 'u-alice', requested_by: 'u-alice', wait_until: '2026-11-05T09:00', waiting_on: '田中さんからの返事' })
    expect(linkOf(rr, 'interaction')).toBe(interactionId)
    expect(linkOf(rr, 'task')).toBe(t)
    // Placed like the mail (営業部): u-carol does not see it.
    expect(canRead('u-alice', rr)).toBe(true)
    expect(canRead('u-carol', rr)).toBe(false)
    expect(notices()).toEqual([])
    // Our message is the thread's: told twice, it is taken once.
    expect(inbox.awaitOwnMessage({
      companyId: 'a', userId: 'u-alice', interactionId, channel: 'email', messageId: OURS, sourceRef: 'gmail:s1',
      occurredAt: TS, waitUntil: '2026-11-05T09:00', title: 'x', waitingOn: 'x', to: null, taskId: null,
    })).toBeNull()
  })

  it('a task the sender cannot read is not linked', () => {
    // u-carol's own task (持ち主だけ): u-alice cannot read it.
    const t = serviceWriter.create('a', {
      type: 'task', title: '私用', personalOwner: 'u-carol', fields: { assignee: 'u-carol' }, actor: { id: 'u-carol', kind: 'human', source: null }, quiet: true,
    })
    if (!t.ok) throw new Error(t.reason)
    const { rr } = sentWaiting(t.record.id)
    expect(linkOf(rr, 'task')).toBeNull()
  })

  it('a members-only やりとり takes a message of its thread only when it reached someone on its list', () => {
    const made = serviceWriter.create('a', {
      type: 'interaction', title: '面談のお礼', members: ['u-alice', 'u-bob'],
      fields: { occurred_at: TS, channel: 'email', message_id: OURS, source_ref: 'gmail:s1', assignee: 'u-alice', needs_reply: false },
      actor: { id: 'u-alice', kind: 'human', source: null }, state: 'handled', quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    handle().inbox.insertMessage({ channel: 'email', messageId: OURS, interactionId: made.record.id, direction: 'out', occurredAt: TS, seenAt: TS, sourceRef: 'gmail:s1' })
    // Their answer reached u-carol alone: not this thread's record (a record of her own instead).
    expect(inbox.receive('a', 'u-carol', mail({ references: [OURS], to: [{ address: 'carol@acme.example' }] }))).not.toBe('continued')
    expect(handle().inbox.messagesOf(made.record.id).map(x => x.direction)).toEqual(['out'])
    // It reached u-bob, who is on the list: it joins.
    expect(inbox.receive('a', 'u-bob', mail({ references: [OURS], to: [{ address: 'bob@acme.example' }] }))).toBe('continued')
  })

  it('a member\'s plain Slack DM answers a members-only やりとり only when the member is on its list', () => {
    const made = serviceWriter.create('a', {
      type: 'interaction', title: 'DM', members: ['u-alice', 'u-bob'],
      fields: { occurred_at: TS, channel: 'chat', source_ref: 'slack:D0AB:1793581200.000100', assignee: 'u-alice', needs_reply: false },
      actor: { id: 'u-alice', kind: 'human', source: null }, state: 'received', quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    handle().inbox.insertMessage({ channel: 'chat', messageId: 'D0AB:1793581200.000100', interactionId: made.record.id, direction: 'in', occurredAt: '2026-11-02T01:00:00.000Z', seenAt: TS, sourceRef: 'slack:D0AB:1793581200.000100' })
    const own = (userId: string, slackId: string) => slackSignalMessage({
      companyId: 'a', userId, kind: 'own', channelId: 'D0AB', ts: '1793584800.000100', threadTs: null, senderSlackUserId: slackId, external: true,
    } as Parameters<typeof slackSignalMessage>[0])
    expect(inbox.receive('a', 'u-carol', own('u-carol', 'U0CAROL'))).toBe('skipped')
    expect(inbox.receive('a', 'u-bob', own('u-bob', 'U0BOB'))).toBe('continued')
  })

  it('a members-only やりとり\'s 返事のお願い stays its members\' (records.md "Members-only records": placed like its 連絡, never company-wide)', () => {
    const made = serviceWriter.create('a', {
      type: 'interaction', title: '面談のお礼', members: ['u-alice', 'u-bob'],
      fields: { occurred_at: TS, channel: 'email', message_id: OURS, source_ref: 'gmail:s1', assignee: 'u-alice', needs_reply: false },
      actor: { id: 'u-alice', kind: 'human', source: null }, state: 'handled', quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    const rr = inbox.awaitOwnMessage({
      companyId: 'a', userId: 'u-alice', interactionId: made.record.id, channel: 'email', messageId: OURS, sourceRef: 'gmail:s1',
      occurredAt: TS, waitUntil: '2026-11-05T09:00', title: '面談のお礼', waitingOn: '田中さんからの返事', to: 'tanaka@client.example', taskId: null,
    })
    if (!rr) throw new Error('no reply request')
    expect(handle().records.find(rr)).toMatchObject({ folder: null, personalOwner: null, members: ['u-alice', 'u-bob'] })
    for (const who of ['u-carol', 'u-admin', 'u-owner']) expect(canRead(who, rr)).toBe(false)
    expect(canRead('u-bob', rr)).toBe(true)
  })

  it('their reply in the thread: the AI checks it, the sender and the task\'s assignee hear 「返事が来た」; an automatic reply is no reply', () => {
    const { rr } = sentWaiting(task('u-bob'))
    expect(inbox.receive('a', 'u-alice', mail({ references: [OURS], automated: true }))).toBe('continued')
    expect(stateOf(rr).state).toBe('waiting_reply')
    expect(inbox.receive('a', 'u-alice', mail({ references: [OURS] }))).toBe('continued')
    expect(stateOf(rr).state).toBe('checking')
    expect(fieldsOf(rr)).toMatchObject({ trigger_kind: 'their_reply' })
    expect(notices().sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: 'u-alice', kind: 'reply_arrived' }, { userId: 'u-bob', kind: 'reply_arrived' },
    ])
    expect(ok(inbox.item(m('u-alice'), rr)).request?.purpose).toBe('check_reply')
  })

  it('a task assignee who cannot read the 返事のお願い is not told', () => {
    const { rr } = sentWaiting(task('u-carol', ''))
    inbox.receive('a', 'u-alice', mail({ references: [OURS] }))
    expect(stateOf(rr).state).toBe('checking')
    expect(notices()).toEqual([{ userId: 'u-alice', kind: 'reply_arrived' }])
  })

  it('silence: never before the picked morning; after it the clock hands the nudge to the AI (follow_up)', async () => {
    const { rr } = sentWaiting(null, '2026-11-05T09:00')
    const clock = (autoRun: boolean) => createServerClock({
      companyIds: () => ['a'], companyData: source, clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }, writer: serviceWriter,
      notifications: { sweep: () => 0 }, autoRunFor: () => autoRun, timeZoneOf: () => 'Asia/Tokyo', yieldNow: async () => {}, log: () => {},
    })
    nowMs = Date.parse('2026-11-04T23:59:00.000Z') // 2026-11-05 08:59 in Tokyo
    await clock(true).runOnce()
    expect(stateOf(rr).state).toBe('waiting_reply')
    nowMs = Date.parse('2026-11-05T00:01:00.000Z') // 09:01
    await clock(true).runOnce()
    expect(stateOf(rr).state).toBe('preparing')
    expect(ok(inbox.item(m('u-alice'), rr)).request).toMatchObject({ purpose: 'follow_up', waitUntil: '2026-11-05T09:00' })
  })
})
