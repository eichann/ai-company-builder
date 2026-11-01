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
 * - another company's settings and messages change nothing.
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
import { createConnectorRoles } from '../../src/services/connector-roles'
import { noticeKind } from '../../src/services/notifications'
import { recordReader } from '../../src/services/record-access'
import { slackSignalMessage } from '../../src/composition/inbox'
import type { Member } from '../../src/services/access'
import { defaultTaskSettings } from '../../../shared/core/task-settings'
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
let listedSince: string[] = []

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
  told = []
  mailbox = {}
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
  const fake: InboxSource = {
    async listSince(_co, userId, since) {
      listedSince.push(since)
      const box = mailbox[userId] ?? []
      return box === 'not-connected' ? box : box.filter(x => x.occurredAt >= since)
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
    expect(listedSince.at(-1)).toBe('2026-11-02T02:00:00.000Z')
    expect(inbox.status(m('u-alice')).gaps).toEqual([])

    // Broken for 10 days: 7 days are read, the 3 before are a gap.
    nowMs = Date.parse('2026-11-15T02:00:00.000Z')
    await inbox.poll('a', 'u-alice')
    expect(listedSince.at(-1)).toBe('2026-11-08T02:00:00.000Z')
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

  it('no connector serving the mail role: nothing is read and the window stays', async () => {
    const lone = createInboxService({
      companyData: source, clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }, ids: { newId: () => 'x', newToken: () => 'x' },
      writer: { create: () => { throw new Error('no') }, transition: () => { throw new Error('no') } },
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
    const sig = { companyId: 'a', userId: 'u-alice', kind: 'dm' as const, channelId: 'D1', ts: '1793581200.000100', threadTs: null, senderSlackUserId: 'U-BOB', external: false }
    expect(inbox.receive('a', 'u-alice', slackSignalMessage(sig))).toBe('created')
    const [row] = interactions()
    expect(row.personalOwner).toBe('u-alice')
    expect(fieldsOf(row.id)).toMatchObject({ channel: 'chat', source_ref: 'slack:D1:1793581200.000100', occurred_at: '2026-11-02T01:00:00.000Z' })
    expect(inbox.receive('a', 'u-alice', slackSignalMessage({ ...sig, ts: '1793581260.000200', threadTs: sig.ts }))).toBe('continued')
    expect(inbox.receive('a', 'u-alice', slackSignalMessage(sig))).toBe('duplicate')
    expect(interactions()).toHaveLength(1)
  })
})
