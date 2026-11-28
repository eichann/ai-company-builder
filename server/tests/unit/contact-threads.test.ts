/**
 * 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」): services/contact-threads.ts over the real
 * SQLite handle, the real engine (act / undo / actTogether / undoTogether) and the inbox's follow-ups.
 *
 * Guards:
 * - the view is the contact's readers' alone: anyone else (another member, the company owner, an admin, another
 *   company) gets the missing record's answer; inside it, only the 返事のお願い, やること and drafts the member reads;
 * - finish runs the engine's own actions (who / from / version), the 返事のお願い's end and — only in 確認待ち — the
 *   contact's 「済んだ」: both written or neither, whether refused while checking or while writing;
 * - pressed twice (one after the other, or at the same time), the change is written once; a part already written by
 *   this member's same change is `already`; anything changed by someone else is VERSION_CONFLICT with nothing written;
 * - undo takes back both or neither with the generic undo's rules, a second undo is `already`, only a finish's entries.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, createServiceRecordWriter, type RecordEngine, type ServiceActor } from '../../src/services/record-engine'
import { createIdentityService } from '../../src/services/identities'
import { createInboxService, type InboxService } from '../../src/services/inbox'
import { CONTACT_READ_LIMIT, createContactThreads, type ContactThreads } from '../../src/services/contact-threads'
import type { Member } from '../../src/services/access'
import { defaultTaskSettings } from '../../../shared/core/task-settings'
import { AI_ASKED_PER_TURN } from '../../../shared/core/record-types'
import type { IncomingMessage } from '../../../shared/types/inbox'

const TS = '2026-11-02T00:00:00.000Z'
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const EMAILS: Record<string, string> = {
  'u-owner': 'boss@acme.example', 'u-admin': 'admin@acme.example', 'u-alice': 'alice@acme.example', 'u-bob': 'bob@acme.example',
}
const MEMBERS = Object.keys(EMAILS)

let conn: Database.Database
let source: CompanyDataSource
let inbox: InboxService
let engine: RecordEngine
let contacts: ContactThreads
let writer: ReturnType<typeof createServiceRecordWriter>
let inboxOff = new Set<string>()
let askedOn = new Set<string>()
let n = 0

const m = (userId: string, co = 'a'): Member => ({ companyId: co, userId, role: ROLES[userId] ?? 'member' })
const AI = (userId: string): ServiceActor => ({ id: userId, kind: 'ai', source: 'claude-code', conversationId: 'conv-1', runId: null })
const PERSON = { kind: 'human' as const }
const handle = (co = 'a') => source.forCompany(co)
const stateOf = (id: string, co = 'a') => handle(co).records.states([id])[0]
const fieldsOf = (id: string) => JSON.parse(stateOf(id).fields) as Record<string, unknown>
const ledger = (id: string) => handle().records.ledger(id)

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

function mail(): IncomingMessage {
  const k = ++n
  return {
    channel: 'email', messageId: `<m${k}@client.example>`, sourceRef: `fake:${k}`, threadRef: `thread-${k}`,
    occurredAt: '2026-11-02T01:00:00.000Z', subject: `お見積りのお願い ${k}`,
    from: { address: 'tanaka@client.example', name: '田中' }, to: [{ address: 'alice@acme.example' }], cc: [],
  }
}

/** Alice's contact judged 「返事が要る」: the contact 対応済み, its 返事のお願い in 準備中 (the AI's turn). */
function contactWithReply(): { id: string; rr: string } {
  inbox.receive('a', 'u-alice', mail())
  const id = handle().records.candidates({ types: ['interaction'] }, 100).map(r => r.id).at(-1)!
  const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
  return { id, rr }
}

/** The same, then judged again as 確認待ち (the thread went on): 「済んだ」 is hers to press. */
function unsureWithReply(): { id: string; rr: string } {
  const c = contactWithReply()
  for (const to of ['received', 'unsure']) {
    const r = writer.transition('a', { recordId: c.id, action: 'judge', expectedVersion: stateOf(c.id).version, to, actor: AI('u-alice'), quiet: true })
    if (!r.ok) throw new Error(r.reason)
  }
  return c
}

function draft(interactionId: string, owner = 'u-alice'): string {
  const d = writer.create('a', {
    type: 'outbound_message', title: 'Re: お見積り', personalOwner: owner,
    fields: { assignee: owner, requested_by: owner, channel: 'email' }, links: { interaction: [interactionId] },
    actor: { id: owner, kind: 'human', source: null }, note: '', quiet: true,
  })
  if (!d.ok) throw new Error(d.reason)
  return d.record.id
}

function finishBody(c: { id: string; rr: string }, action = 'replied_elsewhere', extra: Record<string, unknown> = {}) {
  return { interaction: { expectedVersion: stateOf(c.id).version }, replyRequest: { id: c.rr, expectedVersion: stateOf(c.rr).version, action, ...extra } }
}

beforeEach(() => {
  n = 0
  inboxOff = new Set()
  askedOn = new Set()
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  let id = 0
  const nowMs = Date.parse('2026-11-02T01:00:00.000Z')
  const clock = { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs }
  const ids = { newId: () => `id-${++id}`, newToken: () => `${String(++id).padStart(16, '0')}ffffffffffffffff` }
  const roleOf = (_co: string, userId: string) => (MEMBERS.includes(userId) ? ROLES[userId] ?? 'member' : null)
  writer = createServiceRecordWriter({
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    isMember: (co, u) => roleOf(co, u) !== null, roleOf, notify: () => {},
  })
  const identities = createIdentityService({ companyData: source, transactions: sqliteTransactions(conn), clock, ids })
  inbox = createInboxService({
    companyData: source, clock, ids, writer,
    resolveAddress: (member, address) => identities.resolveAddress(member, address),
    roleOf,
    memberAddresses: () => MEMBERS.map(u => ({ userId: u, email: EMAILS[u] })),
    taskSettings: () => defaultTaskSettings(),
    enabled: co => !inboxOff.has(co),
  })
  engine = createRecordEngine({
    companyData: source, transactions: sqliteTransactions(conn), clock, ids,
    files: { appendHistoryLine: async () => true, fileAtCommit: async () => true },
    managedFolders: () => [], isMember: (co, u) => roleOf(co, u) !== null, roleOf, notify: () => {},
    afterAct: (co, change) => inbox.afterAct(co, change),
    aiAskedOn: (_co, u) => askedOn.has(u),
    featureOff: (co, type) => inboxOff.has(co) && (type === 'interaction' || type === 'reply_request'),
  })
  contacts = createContactThreads({ companyData: source, engine })
  company('a')
  company('b')
})

describe('the contact as one card (view)', () => {
  it('the 返事のお願い with its 担当・期限・追いかけの日・drafts and what she may press, and the やること from it — hers alone', () => {
    const c = contactWithReply()
    const mine = draft(c.id)
    // A やること from this contact that she cannot read (bob's own): not shown, not counted.
    const hidden = writer.create('a', { type: 'task', title: '秘密の仕事', personalOwner: 'u-bob', fields: { assignee: 'u-bob', requested_by: 'u-bob' }, links: { interaction: [c.id] }, actor: { id: 'u-bob', kind: 'human', source: null }, quiet: true })
    expect(hidden.ok).toBe(true)
    const own = writer.create('a', { type: 'task', title: '経費を承認する', personalOwner: 'u-alice', fields: { assignee: 'u-alice', requested_by: 'u-alice' }, links: { interaction: [c.id] }, actor: { id: 'u-alice', kind: 'human', source: null }, quiet: true })
    if (!own.ok) throw new Error(own.reason)

    // A draft to this contact that is someone else's (bob's own), even one the 返事のお願い names as prepared: not hers to see.
    const bobs = draft(c.id, 'u-bob')
    handle().records.replaceLinks(c.rr, [...handle().records.linksFrom([c.rr]), { sourceId: c.rr, name: 'prepared', position: 9, targetId: bobs, targetPath: null }])
    const v = ok(contacts.view(m('u-alice'), c.id))
    expect(v.interaction).toMatchObject({ id: c.id, state: 'handled', assignee: 'u-alice', maySettle: false })
    expect(v.replyRequests).toHaveLength(1)
    expect(v.replyRequests[0]).toMatchObject({
      id: c.rr, state: 'preparing', assignee: 'u-alice', due: fieldsOf(c.rr).due, guidelineDue: fieldsOf(c.rr).guideline_due, waitUntil: null,
      drafts: [{ id: mine, version: 1 }], may: { replied_elsewhere: true, close: true, drop: true },
    })
    expect(v.tasks).toEqual([{ id: own.record.id, title: '経費を承認する', state: 'todo', version: 1, assignee: 'u-alice' }])
    // Asked by the 返事のお願い's id: the same card.
    expect(ok(contacts.view(m('u-alice'), c.rr))).toEqual(v)
  })

  it('anyone else — another member, the company owner, an admin, another company — gets the missing record\'s answer', () => {
    const c = contactWithReply()
    const missing = contacts.view(m('u-bob'), 'interaction-0000000000000000')
    expect(missing).toMatchObject({ ok: false, kind: 'not-found' })
    for (const u of ['u-bob', 'u-owner', 'u-admin']) {
      expect(contacts.view(m(u), c.id)).toEqual(missing)
      expect(contacts.view(m(u), c.rr)).toEqual(missing)
    }
    expect(contacts.view(m('u-alice', 'b'), c.id)).toEqual(missing)
  })
})

describe('a contact with very many linked records', () => {
  it('says `truncated` rather than look complete', () => {
    const c = contactWithReply()
    expect(ok(contacts.view(m('u-alice'), c.id)).truncated).toBeUndefined()
    for (let i = 0; i < CONTACT_READ_LIMIT + 1; i++) {
      const t = writer.create('a', { type: 'task', title: `仕事 ${i}`, personalOwner: 'u-alice', fields: { assignee: 'u-alice', requested_by: 'u-alice' }, links: { interaction: [c.id] }, actor: { id: 'u-alice', kind: 'human', source: null }, quiet: true })
      if (!t.ok) throw new Error(t.reason)
    }
    const v = ok(contacts.view(m('u-alice'), c.id))
    expect(v.truncated).toBe(true)
    expect(v.tasks).toHaveLength(CONTACT_READ_LIMIT)
  })
})

describe('a members-only contact (「この人たちだけ」)', () => {
  it('its listed members read the card, owners and admins do not; inside, each reads only what is theirs; only its 担当 may finish', async () => {
    const made = writer.create('a', {
      type: 'interaction', title: '共同の連絡', members: ['u-alice', 'u-bob'],
      fields: { occurred_at: TS, channel: 'email', assignee: 'u-alice', next_actor: 'u-alice' },
      actor: { id: 'acb:inbox', kind: 'external', source: null }, state: 'received', quiet: true,
    })
    if (!made.ok) throw new Error(made.reason)
    const id = made.record.id
    const rr = ok(inbox.judge(m('u-alice'), AI('u-alice'), id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' })).replyRequestId!
    const own = writer.create('a', { type: 'task', title: 'アリスだけの仕事', personalOwner: 'u-alice', fields: { assignee: 'u-alice', requested_by: 'u-alice' }, links: { interaction: [id] }, actor: { id: 'u-alice', kind: 'human', source: null }, quiet: true })
    expect(own.ok).toBe(true)
    const missing = contacts.view(m('u-owner'), 'interaction-0000000000000000')
    for (const u of ['u-owner', 'u-admin']) expect(contacts.view(m(u), id)).toEqual(missing)
    const bobs = ok(contacts.view(m('u-bob'), id))
    expect(bobs.replyRequests.map(r => r.id)).toEqual([rr])
    expect(bobs.replyRequests[0].may).toEqual({ replied_elsewhere: false, close: false, drop: false })
    expect(bobs.tasks).toEqual([])
    expect(ok(contacts.view(m('u-alice'), id)).tasks).toHaveLength(1)
    // Bob reads it but is not its 担当: refused by the 返事のお願い's own `who`, nothing written.
    const body = { interaction: { expectedVersion: stateOf(id).version }, replyRequest: { id: rr, expectedVersion: stateOf(rr).version, action: 'replied_elsewhere' } }
    expect(await contacts.finish(m('u-bob'), PERSON, id, body)).toMatchObject({ ok: false, kind: 'forbidden', body: { code: 'NOT_ALLOWED', part: 'replyRequest' } })
    expect(stateOf(rr).state).toBe('preparing')
  })
})

describe('finish: the 返事のお願い and the contact together (both or neither)', () => {
  it('［返した］ on a contact the AI judged: the 返事のお願い is hers 「もう返した」 (drafts dropped); the contact, already 対応済み, stays', async () => {
    const c = contactWithReply()
    const d = draft(c.id)
    const r = ok(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c)))
    expect(r.replyRequest).toMatchObject({ outcome: 'done', state: 'closed', version: 2 })
    expect(r.interaction).toMatchObject({ outcome: 'unchanged', state: 'handled', version: null })
    expect(ledger(c.rr).at(-1)).toMatchObject({ action: 'replied_elsewhere', actorId: 'u-alice', actorKind: 'human' })
    expect(stateOf(d).state).toBe('discarded')
  })

  it('［返した］ on a 確認待ち contact: her 「もう返した」 and her 「済んだ」 (settled_by her), one press', async () => {
    const c = unsureWithReply()
    const r = ok(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c)))
    expect(r.replyRequest).toMatchObject({ outcome: 'done', state: 'closed' })
    expect(r.interaction).toMatchObject({ outcome: 'done', state: 'handled' })
    expect(fieldsOf(c.id).settled_by).toBe('u-alice')
    expect(ledger(c.id).at(-1)).toMatchObject({ action: 'settle', actorId: 'u-alice', actorKind: 'human' })
  })

  it('［済んだ（もう待たない）］ / ［済んだ］ are 「終わりにする」; 「返事をしない」 needs her note — refused, nothing is written', async () => {
    const c = unsureWithReply()
    const drop = await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c, 'drop'))
    expect(drop).toMatchObject({ ok: false, body: { code: 'NOTE_REQUIRED', part: 'replyRequest' } })
    expect(stateOf(c.rr).state).toBe('preparing')
    expect(stateOf(c.id).state).toBe('unsure')
    const r = ok(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c, 'close')))
    expect(ledger(c.rr).at(-1)?.action).toBe('close')
    expect(r.interaction.outcome).toBe('done')
  })

  it('a part refused while checking writes nothing of the other (the engine\'s own rules: here 「済んだ」 naming someone else)', async () => {
    const c = unsureWithReply()
    const r = await engine.actTogether(m('u-alice'), PERSON, [
      { recordId: c.rr, action: 'replied_elsewhere', body: { expectedVersion: stateOf(c.rr).version } },
      { recordId: c.id, action: 'settle', body: { expectedVersion: stateOf(c.id).version, args: { settled_by: 'u-bob' } } },
    ])
    expect(r).toMatchObject({ ok: false, body: { code: 'BAD_VALUE', step: 1 } })
    expect(stateOf(c.rr).state).toBe('preparing')
    expect(ledger(c.rr).some(e => e.action === 'replied_elsewhere')).toBe(false)
  })

  it('a part refused while writing rolls the other back (her AI at her request, the turn\'s last asked change)', async () => {
    const c = unsureWithReply()
    askedOn.add('u-alice')
    handle().records.insertAiToken({ id: 'tok-ask', userId: 'u-alice', tokenHash: 'h-tok', scope: 'act', agent: 'claude-code', conversationId: 'conv-ask', createdAt: TS, expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, memberTurn: true })
    conn.prepare('UPDATE record_ai_tokens SET asked_closes = ? WHERE id = ?').run(AI_ASKED_PER_TURN - 1, 'tok-ask')
    const asked = { kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-ask', askedTurn: { tokenId: 'tok-ask' } }
    const r = await engine.actTogether(m('u-alice'), asked, [
      { recordId: c.rr, action: 'replied_elsewhere', body: { expectedVersion: stateOf(c.rr).version } },
      { recordId: c.id, action: 'settle', body: { expectedVersion: stateOf(c.id).version } },
    ])
    expect(r).toMatchObject({ ok: false, body: { code: 'AI_ASK_LIMIT' } })
    // The first write (and its count) rolled back with the second.
    expect(stateOf(c.rr).state).toBe('preparing')
    expect(stateOf(c.id).state).toBe('unsure')
    expect(conn.prepare('SELECT asked_closes AS n FROM record_ai_tokens WHERE id = ?').get('tok-ask')).toEqual({ n: AI_ASKED_PER_TURN - 1 })
  })

  it('who: only her own — anyone else gets the missing answer; a 返事のお願い of another contact is refused; nothing written', async () => {
    const c = unsureWithReply()
    const other = contactWithReply()
    const missing = await contacts.finish(m('u-bob'), PERSON, 'interaction-0000000000000000', finishBody(c))
    for (const u of ['u-bob', 'u-owner', 'u-admin']) expect(await contacts.finish(m(u), PERSON, c.id, finishBody(c))).toEqual(missing)
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, { ...finishBody(c), replyRequest: finishBody(other).replyRequest }))
      .toMatchObject({ ok: false, body: { code: 'NOT_THIS_CONTACT' } })
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c, 'ai_close'))).toMatchObject({ ok: false, kind: 'bad-request' })
    expect([stateOf(c.rr).state, stateOf(other.rr).state, stateOf(c.id).state]).toEqual(['preparing', 'preparing', 'unsure'])
  })

  it('pressed twice: written once — the second press answers `already` for each part', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    const first = ok(await contacts.finish(m('u-alice'), PERSON, c.id, body))
    const entries = [ledger(c.rr).length, ledger(c.id).length]
    const again = ok(await contacts.finish(m('u-alice'), PERSON, c.id, body))
    expect(again.replyRequest).toMatchObject({ outcome: 'already', version: first.replyRequest.version })
    expect(again.interaction).toMatchObject({ outcome: 'already', version: first.interaction.version })
    expect([ledger(c.rr).length, ledger(c.id).length]).toEqual(entries)
  })

  it('pressed at the same time: one writes both, the other writes nothing (VERSION_CONFLICT); its retry is `already`', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    const [a, b] = await Promise.all([contacts.finish(m('u-alice'), PERSON, c.id, body), contacts.finish(m('u-alice'), PERSON, c.id, body)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect((a.ok ? b : a)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT' } })
    expect(ledger(c.rr).filter(e => e.action === 'replied_elsewhere')).toHaveLength(1)
    expect(ledger(c.id).filter(e => e.action === 'settle')).toHaveLength(1)
    expect(ok(await contacts.finish(m('u-alice'), PERSON, c.id, body)).replyRequest.outcome).toBe('already')
  })

  it('the contact changed while the 返事のお願い was being written (her own 「済んだ」 elsewhere at the same time): the 返事のお願い is rolled back', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    const [together, alone] = await Promise.all([
      contacts.finish(m('u-alice'), PERSON, c.id, body),
      engine.act(m('u-alice'), PERSON, c.id, 'settle', { expectedVersion: body.interaction.expectedVersion }),
    ])
    expect(alone.ok).toBe(true)
    expect(together).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'interaction' } })
    // Its compare-and-set had passed, yet nothing of it stayed: never one closed and the other not by this press.
    expect(stateOf(c.rr).state).toBe('preparing')
    expect(ledger(c.rr).some(e => e.action === 'replied_elsewhere')).toBe(false)
  })

  it('read an old version (the AI changed the 返事のお願い since): VERSION_CONFLICT about that part, the contact left as it was', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    ok(await engine.act(m('u-alice'), { kind: 'ai', source: 'claude-code' }, c.rr, 'set_due', { expectedVersion: stateOf(c.rr).version, args: { due: '2026-11-20' } }))
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, body)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'replyRequest' } })
    expect(stateOf(c.id).state).toBe('unsure')
    expect(stateOf(c.rr).state).toBe('preparing')
  })

  it('her own change taken back since (an undo, a reopen): a retry with the old card is VERSION_CONFLICT, never `already`, and the contact stays', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    const closed = ok(await engine.act(m('u-alice'), PERSON, c.rr, 'replied_elsewhere', { expectedVersion: body.replyRequest.expectedVersion }))
    ok(engine.undo(m('u-alice'), PERSON, c.rr, { version: closed.entry!.version, expectedVersion: stateOf(c.rr).version }))
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, body)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'replyRequest' } })
    expect(stateOf(c.id).state).toBe('unsure')
    expect(stateOf(c.rr).state).toBe('preparing')
  })

  it('the same change by her AI (at her request) is not her press: VERSION_CONFLICT, never `already`', async () => {
    const c = unsureWithReply()
    const body = finishBody(c, 'close')
    askedOn.add('u-alice')
    handle().records.insertAiToken({ id: 'tok-ask', userId: 'u-alice', tokenHash: 'h-tok', scope: 'act', agent: 'claude-code', conversationId: 'conv-ask', createdAt: TS, expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, memberTurn: true })
    ok(await engine.act(m('u-alice'), { kind: 'ai', source: 'claude-code', conversationId: 'conv-ask', askedTurn: { tokenId: 'tok-ask' } }, c.rr, 'close', { expectedVersion: body.replyRequest.expectedVersion }))
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, body)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'replyRequest' } })
    expect(stateOf(c.id).state).toBe('unsure')
  })

  it('one part already done by her own press: the other is done now', async () => {
    const c = unsureWithReply()
    const body = finishBody(c)
    ok(await engine.act(m('u-alice'), PERSON, c.rr, 'replied_elsewhere', { expectedVersion: body.replyRequest.expectedVersion }))
    const r = ok(await contacts.finish(m('u-alice'), PERSON, c.id, body))
    expect(r.replyRequest.outcome).toBe('already')
    expect(r.interaction).toMatchObject({ outcome: 'done', state: 'handled' })
  })

  it('「使う機能」 off: nothing is written; the card is still read, with nothing to press', async () => {
    const c = unsureWithReply()
    inboxOff.add('a')
    expect(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c))).toMatchObject({ ok: false, body: { code: 'FEATURE_OFF' } })
    expect(stateOf(c.rr).state).toBe('preparing')
    const v = ok(contacts.view(m('u-alice'), c.id))
    expect(v.interaction.maySettle).toBe(false)
    expect(v.replyRequests[0].may).toEqual({ replied_elsewhere: false, close: false, drop: false })
  })
})

describe('undo: what one finish wrote, both or neither', () => {
  async function finished() {
    const c = unsureWithReply()
    const d = draft(c.id)
    const r = ok(await contacts.finish(m('u-alice'), PERSON, c.id, finishBody(c)))
    const body = {
      interaction: { version: r.interaction.version!, expectedVersion: r.interaction.recordVersion },
      replyRequest: { id: c.rr, version: r.replyRequest.version!, expectedVersion: r.replyRequest.recordVersion },
    }
    return { ...c, d, body }
  }

  it('both come back; a second undo is `already`', async () => {
    const f = await finished()
    expect(stateOf(f.d).state).toBe('discarded')
    const r = ok(contacts.undo(m('u-alice'), PERSON, f.id, f.body))
    expect(r.replyRequest).toMatchObject({ outcome: 'done', state: 'preparing' })
    expect(r.interaction).toMatchObject({ outcome: 'done', state: 'unsure' })
    expect(fieldsOf(f.id).settled_by ?? null).toBeNull()
    // Which drafts come back is the inbox's `restoreDrafts` on the undo (a draft whose mail body is kept:
    // inbox.test.ts 「［取り消す］ of 「もう返した」…」); this one has no mail body, so it stays put away.
    expect(ledger(f.rr).at(-1)).toMatchObject({ action: 'undo', actorId: 'u-alice' })
    const again = ok(contacts.undo(m('u-alice'), PERSON, f.id, f.body))
    expect([again.replyRequest.outcome, again.interaction?.outcome]).toEqual(['already', 'already'])
  })

  it('one part changed since: neither is taken back (CHANGED_SINCE about that part)', async () => {
    const f = await finished()
    // She reopens the 返事のお願い herself; its 「もう返した」 can no longer be taken back alone.
    ok(await engine.act(m('u-alice'), PERSON, f.rr, 'reopen', { expectedVersion: stateOf(f.rr).version }))
    const r = contacts.undo(m('u-alice'), PERSON, f.id, { ...f.body, replyRequest: { ...f.body.replyRequest, expectedVersion: stateOf(f.rr).version } })
    expect(r).toMatchObject({ ok: false, body: { code: 'CHANGED_SINCE', part: 'replyRequest' } })
    expect(stateOf(f.id).state).toBe('handled')
  })

  it('a change made in between — her AI\'s, or one that came back to the same state — refuses the undo (the card\'s version); nothing is taken back', async () => {
    // Her AI moves the 返事のお願い's due: a field the 「もう返した」 entry never changed, so CHANGED_SINCE alone would pass it.
    const f = await finished()
    askedOn.add('u-alice')
    ok(await engine.act(m('u-alice'), AI('u-alice'), f.rr, 'set_due', { expectedVersion: stateOf(f.rr).version, args: { due: '2026-11-20' } }))
    const byAi = contacts.undo(m('u-alice'), PERSON, f.id, f.body)
    expect(byAi).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'replyRequest' } })
    expect([stateOf(f.rr).state, stateOf(f.id).state, fieldsOf(f.rr).due]).toEqual(['closed', 'handled', '2026-11-20'])
    // Reopened and closed again on the record card: the state is what the entry left (closed), but it is not her finish's.
    const g = await finished()
    ok(await engine.act(m('u-alice'), PERSON, g.rr, 'reopen', { expectedVersion: stateOf(g.rr).version }))
    ok(await engine.act(m('u-alice'), PERSON, g.rr, 'close', { expectedVersion: stateOf(g.rr).version }))
    const aba = contacts.undo(m('u-alice'), PERSON, g.id, g.body)
    expect(aba).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'replyRequest' } })
    expect([stateOf(g.rr).state, stateOf(g.id).state]).toEqual(['closed', 'handled'])
  })

  it('the inbox\'s quiet note written after the answer (「Gmail でもアーカイブしました」) does not refuse it; with any other change since, it is refused', async () => {
    const note = (id: string) => {
      const r = writer.transition('a', { recordId: id, action: 'archived_there', expectedVersion: stateOf(id).version, to: null, actor: { id: 'acb:inbox', kind: 'external', source: 'ACB の受付' }, note: 'Gmail でもアーカイブしました', quiet: true })
      if (!r.ok) throw new Error(r.reason)
    }
    const f = await finished()
    note(f.id)
    expect(ledger(f.id).at(-1)).toMatchObject({ action: 'archived_there', changes: [] })
    const r = ok(contacts.undo(m('u-alice'), PERSON, f.id, f.body))
    expect([r.interaction?.outcome, r.replyRequest.outcome]).toEqual(['done', 'done'])
    expect([stateOf(f.id).state, stateOf(f.rr).state]).toEqual(['unsure', 'preparing'])
    // A note and then the thread going on (the inbox moving it back to 届いた): a real change keeps the card's version.
    const g = await finished()
    note(g.id)
    const went = writer.transition('a', { recordId: g.id, action: 'continued', expectedVersion: stateOf(g.id).version, to: 'received', actor: { id: 'acb:inbox', kind: 'external', source: 'ACB の受付' }, quiet: true })
    if (!went.ok) throw new Error(went.reason)
    expect(contacts.undo(m('u-alice'), PERSON, g.id, g.body)).toMatchObject({ ok: false, body: { code: 'VERSION_CONFLICT', part: 'interaction' } })
    expect([stateOf(g.id).state, stateOf(g.rr).state]).toEqual(['received', 'closed'])
  })

  it('only a finish\'s entries, only her own contact: anyone else gets the missing answer', async () => {
    const f = await finished()
    const missing = contacts.undo(m('u-bob'), PERSON, 'interaction-0000000000000000', f.body)
    for (const u of ['u-bob', 'u-owner', 'u-admin']) expect(contacts.undo(m(u), PERSON, f.id, f.body)).toEqual(missing)
    ok(await engine.act(m('u-alice'), PERSON, f.rr, 'reopen', { expectedVersion: stateOf(f.rr).version }))
    ok(await engine.act(m('u-alice'), PERSON, f.rr, 'set_due', { expectedVersion: stateOf(f.rr).version, args: { due: '2026-11-20' } }))
    const notFinish = contacts.undo(m('u-alice'), PERSON, f.id, { replyRequest: { id: f.rr, version: stateOf(f.rr).version, expectedVersion: stateOf(f.rr).version } })
    expect(notFinish).toMatchObject({ ok: false, body: { code: 'NOT_A_FINISH' } })
    expect(stateOf(f.id).state).toBe('handled')
  })
})
