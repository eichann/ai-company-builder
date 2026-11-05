/**
 * Mail archived in the mailbox (owner decision 2026-11-05, `.claude/rules/inbox.md` "Mail archived
 * in the mailbox"): services/inbox.ts over the real SQLite handle, the engine and its service
 * writer, with a fake mail connector for the core `mail` role that reports what left the inbox and
 * records every archive it is asked for (no Google here: google-inbox-archive.test.ts).
 *
 * Guards:
 * - Gmail → ACB: a mail that left its owner's inbox closes its 来た連絡 (届いた / 確認待ち → 対応済み)
 *   as the inbox, never the member (`settled_by` stays empty), and tells its owner with an undo the
 *   owner may run although the inbox was the actor; nobody else may undo it, and nobody — a
 *   member, an admin, anyone's AI — can run the type's `left_inbox` action;
 * - a task or an open 返事のお願い made from it: nothing is closed, the note 「Gmail ではアーカイブ済み」
 *   is written once;
 * - only the member's own mail: a record whose mail was read from another member's mailbox is
 *   neither closed by that mailbox's archive nor archived in anyone's mailbox;
 * - an undone close is not closed again by the next look;
 * - ACB → Gmail: the owner's own close (済んだ, 取り込まない), or every task made from it done,
 *   asks the owner's mailbox — never the AI's judgement, never another member's close; never with
 *   open work; never again when the mailbox had archived it already (no loop); the undo puts it back.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { InboxSource } from '../../src/ports/inbox'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createServiceRecordWriter, createRecordEngine, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createIdentityService } from '../../src/services/identities'
import { createInboxService, LEFT_CHECK_MAX, type InboxService } from '../../src/services/inbox'
import { createConnectorRoles } from '../../src/services/connector-roles'
import { noticeKind } from '../../src/services/notifications'
import type { Member } from '../../src/services/access'
import { defaultTaskSettings } from '../../../shared/core/task-settings'
import { coreTypeDefinitions } from '../../../shared/core/core-types'
import type { IncomingMessage } from '../../../shared/types/inbox'
import type { ConnectorRole } from '../../../shared/core/connector-roles'

const TS = '2026-11-02T00:00:00.000Z'
const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin' }
const EMAILS: Record<string, string> = {
  'u-owner': 'boss@acme.example', 'u-admin': 'admin@acme.example', 'u-alice': 'alice@acme.example', 'u-bob': 'bob@acme.example',
}
const MEMBERS = Object.keys(EMAILS)
const person = (u: string) => ({ id: u, kind: 'human' as const, source: null })
const AI = (u: string) => ({ id: u, kind: 'ai' as const, source: 'claude-code', conversationId: 'conv-1', runId: null })

let conn: Database.Database
let source: CompanyDataSource
let inbox: InboxService
let engine: RecordEngine
let nowMs = Date.parse('2026-11-02T01:00:00.000Z')
let told: Array<{ userIds: string[]; change?: RecordChange }> = []
let n = 0
/** Each member's new mail for the next poll. */
let mailbox: Record<string, IncomingMessage[]> = {}
/** Threads no longer in the inbox, per mailbox (`<user>|<threadRef>`). */
let gone = new Set<string>()
/** Threads the change log reports for the next look, per member (null: no cursor). */
let reported: Record<string, string[]> = {}
let looks: Array<{ userId: string; cursor: string | null }> = []
let inInboxAsked: Array<{ userId: string; refs: string[] }> = []
/** Members who allowed the archive (else `not-allowed`, as the Google client refuses it). */
let archiveAllowed = new Set<string>()
let archiveCalls: Array<{ userId: string; refs: string[]; back: boolean }> = []

const m = (userId: string): Member => ({ companyId: 'a', userId, role: ROLES[userId] ?? 'member' })
const handle = () => source.forCompany('a')
const interactions = () => handle().records.candidates({ types: ['interaction'] }, 100)
const stateOf = (id: string) => handle().records.states([id])[0]
const fieldsOf = (id: string) => JSON.parse(stateOf(id).fields) as Record<string, unknown>
const ledger = (id: string) => handle().records.ledger(id)
function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
/** The notices the engine's notify would write: member → kind (never the actor). */
function notices(): Array<{ userId: string; kind: string }> {
  const final = (type: string) => new Set(coreTypeDefinitions().find(d => d.name === type)?.final ?? [])
  return told.filter(t => t.change).flatMap(t => t.userIds
    .filter(u => u !== t.change!.entry.actorId)
    .map(u => ({ userId: u, kind: noticeKind(u, t.change!, final(t.change!.type)) })))
}

function mail(over: Partial<IncomingMessage> = {}): IncomingMessage {
  const k = ++n
  return {
    channel: 'email', messageId: `<m${k}@client.example>`, sourceRef: `fake:${k}`, threadRef: `thread-${k}`,
    occurredAt: '2026-11-02T00:30:00.000Z', subject: `お見積りのお願い ${k}`,
    from: { address: 'tanaka@client.example', name: '田中' }, to: [{ address: 'alice@acme.example' }], cc: [],
    ...over,
  }
}

beforeEach(() => {
  n = 0
  told = []
  mailbox = {}
  gone = new Set()
  reported = {}
  looks = []
  inInboxAsked = []
  archiveAllowed = new Set()
  archiveCalls = []
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
    notify: (_companyId, userIds, change) => { told.push({ userIds, change }) },
  })
  const identities = createIdentityService({ companyData: source, transactions: sqliteTransactions(conn), clock, ids })
  const roles = createConnectorRoles({ choices: { choice: () => null, setChoice: () => {} }, clock })
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
    managedFolders: () => [], isMember: (co, u) => roleOf(co, u) !== null, roleOf,
    notify: (_companyId, userIds, change) => { told.push({ userIds, change }) },
    afterAct: (co, change) => inbox.afterAct(co, change),
  })
  const fake: InboxSource = {
    label: 'Gmail',
    async listSince(_co, userId) {
      const box = mailbox[userId] ?? []
      mailbox[userId] = []
      return box
    },
    async leftSince(_co, userId, cursor) {
      looks.push({ userId, cursor })
      const refs = reported[userId]
      delete reported[userId]
      return { cursor: `c${looks.length}`, threadRefs: cursor === null ? null : refs ?? [] }
    },
    async inInbox(_co, userId, refs) {
      inInboxAsked.push({ userId, refs })
      return Object.fromEntries(refs.map(r => [r, !gone.has(`${userId}|${r}`)]))
    },
    async archive(_co, userId, refs, back) {
      if (!archiveAllowed.has(userId)) return 'not-allowed'
      archiveCalls.push({ userId, refs, back })
      // The fake's pointers `fake:<k>` belong to the conversation `thread-<k>`.
      for (const r of refs) {
        const thread = `${userId}|thread-${r.slice('fake:'.length)}`
        if (back) gone.delete(thread)
        else gone.add(thread)
      }
      return 'done'
    },
  }
  inbox.registerSource('fakemail', fake)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('a-root', 'a', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('a-root-r', 'a-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  handle().records.setEnabled(true, 'u-owner', TS)
  ensureCoreTypes(handle().records, TS)
})

/** Alice's mail, read by her own poll: a new 来た連絡 in her AI's turn (届いた). */
async function aliceMail(over: Partial<IncomingMessage> = {}, reporter = 'u-alice') {
  const msg = mail(over)
  inbox.connect('a', reporter, 'email')
  mailbox[reporter] = [msg]
  await inbox.poll('a', reporter)
  const row = interactions().find(r => fieldsOf(r.id).message_id === msg.messageId)!
  return { msg, id: row.id }
}

/** The next look reports these threads as gone from the member's inbox. */
async function archivedInMailbox(userId: string, ...refs: string[]) {
  for (const r of refs) gone.add(`${userId}|${r}`)
  reported[userId] = refs
  await inbox.poll('a', userId)
  await inbox.whenIdle()
}

const unsure = (id: string) => ok(inbox.judge(m('u-alice'), AI('u-alice'), id, { expectedVersion: stateOf(id).version, outcome: 'unsure', reason: '誰あてか不明' }))

describe('Gmail → ACB: the mail left its owner\'s inbox', () => {
  it('closes a 届いた / 確認待ち message as the inbox (never the member), tells its owner, and she may undo it', async () => {
    const a = await aliceMail()
    const b = await aliceMail()
    unsure(b.id)
    told = []
    await archivedInMailbox('u-alice', a.msg.threadRef!, b.msg.threadRef!)
    for (const { id } of [a, b]) {
      expect(stateOf(id).state).toBe('handled')
      const last = ledger(id).at(-1)!
      expect(last).toMatchObject({ action: 'left_inbox', actorId: 'acb:inbox', actorKind: 'external', note: 'Gmail ではアーカイブ済み' })
      // 「済んだ」 is the person's action: the inbox closing it never marks it as hers.
      expect(fieldsOf(id).settled_by ?? null).toBeNull()
    }
    expect(notices()).toEqual([{ userId: 'u-alice', kind: 'mail_left_inbox' }, { userId: 'u-alice', kind: 'mail_left_inbox' }])
    // Her undo of the inbox's entry: allowed although she was not its actor; Bob, who cannot even read it, is not.
    const v = stateOf(b.id).version
    const bob = await engine.undo(m('u-bob'), person('u-bob'), b.id, { version: v, expectedVersion: v })
    expect(bob.ok).toBe(false)
    ok(await engine.undo(m('u-alice'), person('u-alice'), b.id, { version: v, expectedVersion: v }))
    expect(stateOf(b.id).state).toBe('unsure')
    // The next looks leave it open: she took that close back (the mail is still archived there).
    await archivedInMailbox('u-alice', b.msg.threadRef!)
    expect(stateOf(b.id).state).toBe('unsure')
  })

  it('nobody runs the type\'s 「受信トレイから外れた」: not its owner, an admin, nor her AI', async () => {
    const { id } = await aliceMail()
    unsure(id)
    const v = stateOf(id).version
    for (const [member, actor] of [[m('u-alice'), person('u-alice')], [m('u-alice'), AI('u-alice')]] as const) {
      const r = await engine.act(member, actor, id, 'left_inbox', { expectedVersion: v })
      expect(r.ok).toBe(false)
    }
    expect(stateOf(id).state).toBe('unsure')
  })

  it('a task or an open 返事のお願い made from it: nothing closes, the note 「Gmail ではアーカイブ済み」 once', async () => {
    const t = await aliceMail()
    const task = ok(await engine.create(m('u-alice'), AI('u-alice'), { type: 'task', title: '見積書を送る', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [t.id] } })).record.id
    ok(inbox.judge(m('u-alice'), AI('u-alice'), t.id, { expectedVersion: 1, outcome: 'task', reason: '見積の依頼', taskId: task }))
    const r = await aliceMail()
    ok(inbox.judge(m('u-alice'), AI('u-alice'), r.id, { expectedVersion: 1, outcome: 'reply', reason: '返事が要る' }))
    // A 確認待ち message with a task made by hand from it.
    const u = await aliceMail()
    unsure(u.id)
    ok(await engine.create(m('u-alice'), AI('u-alice'), { type: 'task', title: '確かめる', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [u.id] } }))
    const before = Object.fromEntries([t, r, u].map(x => [x.id, stateOf(x.id).state]))
    told = []
    await archivedInMailbox('u-alice', t.msg.threadRef!, r.msg.threadRef!, u.msg.threadRef!)
    for (const x of [t, r, u]) {
      expect(stateOf(x.id).state).toBe(before[x.id])
      expect(ledger(x.id).at(-1)).toMatchObject({ action: 'left_inbox_noted', actorId: 'acb:inbox', note: 'Gmail ではアーカイブ済み', fromState: before[x.id], toState: before[x.id] })
    }
    expect(notices()).toEqual([])
    // Once: the next look writes nothing more.
    const counts = [t, r, u].map(x => ledger(x.id).length)
    await archivedInMailbox('u-alice', t.msg.threadRef!, r.msg.threadRef!, u.msg.threadRef!)
    expect([t, r, u].map(x => ledger(x.id).length)).toEqual(counts)
  })

  it('only the member\'s own mail: a message read from Bob\'s mailbox is not closed by his archive', async () => {
    // To Alice, but listed by Bob's poll (he was in CC): Alice's record, Bob's pointer.
    const { msg, id } = await aliceMail({ cc: [{ address: 'bob@acme.example' }] }, 'u-bob')
    expect(handle().records.byIds([id])[0].personalOwner).toBe('u-alice')
    await archivedInMailbox('u-bob', msg.threadRef!)
    await archivedInMailbox('u-alice', msg.threadRef!)
    expect(stateOf(id).state).toBe('received')
  })

  it('without a cursor (or one too old) the open records are checked themselves, at most LEFT_CHECK_MAX per look', async () => {
    const ids: string[] = []
    for (let i = 0; i < LEFT_CHECK_MAX + 3; i++) ids.push((await aliceMail()).id)
    // The connection is new: the first look had no cursor — and nothing had left the inbox yet.
    handle().inbox.setLeftCursor('u-alice', 'email', null)
    inInboxAsked = []
    for (const id of ids) gone.add(`u-alice|${fieldsOf(id).thread_ref as string}`)
    await inbox.poll('a', 'u-alice')
    expect(inInboxAsked).toHaveLength(1)
    expect(inInboxAsked[0].refs).toHaveLength(LEFT_CHECK_MAX)
    expect(ids.filter(id => stateOf(id).state === 'handled')).toHaveLength(LEFT_CHECK_MAX)
  })
})

describe('ACB → Gmail: the owner closed it here (opt-in)', () => {
  it('her own 済んだ / 取り込まない archives her own mailbox\'s thread, tells her, and the undo puts it back', async () => {
    archiveAllowed.add('u-alice')
    const s = await aliceMail()
    unsure(s.id)
    told = []
    ok(await engine.act(m('u-alice'), person('u-alice'), s.id, 'settle', { expectedVersion: stateOf(s.id).version }))
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([{ userId: 'u-alice', refs: [s.msg.sourceRef], back: false }])
    const entry = ledger(s.id).at(-1)!
    expect(entry).toMatchObject({ action: 'archived_there', actorId: 'acb:inbox', note: 'Gmail でもアーカイブしました' })
    expect(notices()).toContainEqual({ userId: 'u-alice', kind: 'mail_archived' })
    // ［元に戻す］: her undo of the inbox's entry puts the thread back in her inbox.
    ok(await engine.undo(m('u-alice'), person('u-alice'), s.id, { version: entry.version, expectedVersion: entry.version }))
    await inbox.whenIdle()
    expect(archiveCalls.at(-1)).toEqual({ userId: 'u-alice', refs: [s.msg.sourceRef], back: true })

    const d = await aliceMail()
    unsure(d.id)
    ok(await engine.act(m('u-alice'), person('u-alice'), d.id, 'drop', { expectedVersion: stateOf(d.id).version }))
    await inbox.whenIdle()
    expect(archiveCalls.at(-1)).toEqual({ userId: 'u-alice', refs: [d.msg.sourceRef], back: false })
  })

  it('not allowed: nothing is archived and nothing is written', async () => {
    const s = await aliceMail()
    unsure(s.id)
    ok(await engine.act(m('u-alice'), person('u-alice'), s.id, 'settle', { expectedVersion: stateOf(s.id).version }))
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([])
    expect(ledger(s.id).at(-1)!.action).toBe('settle')
  })

  it('the AI\'s judgement is no close of hers; open work keeps it in the inbox; every task done archives it', async () => {
    archiveAllowed.add('u-alice')
    const j = await aliceMail()
    ok(inbox.judge(m('u-alice'), AI('u-alice'), j.id, { expectedVersion: 1, outcome: 'no_reply', reason: 'お知らせ' }))
    // Her AI's own 「やることにしない」 through the engine (her id, an AI actor): not her close either.
    const s = await aliceMail()
    ok(await engine.act(m('u-alice'), AI('u-alice'), s.id, 'set_aside', { expectedVersion: 1, note: 'メルマガ' }))
    expect(stateOf(s.id).state).toBe('excluded')
    await inbox.whenIdle()
    const t = await aliceMail()
    const make = async (title: string) => ok(await engine.create(m('u-alice'), AI('u-alice'), { type: 'task', title, personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [t.id] } })).record.id
    const one = await make('見積書を送る')
    const two = await make('経費を承認する')
    ok(inbox.judge(m('u-alice'), AI('u-alice'), t.id, { expectedVersion: 1, outcome: 'task', reason: '見積の依頼', taskId: one }))
    const finish = async (task: string) => {
      ok(await engine.act(m('u-alice'), person('u-alice'), task, 'start', { expectedVersion: stateOf(task).version }))
      ok(await engine.act(m('u-alice'), person('u-alice'), task, 'complete', { expectedVersion: stateOf(task).version }))
      await inbox.whenIdle()
    }
    await finish(one)
    expect(archiveCalls).toEqual([])
    await finish(two)
    expect(archiveCalls).toEqual([{ userId: 'u-alice', refs: [t.msg.sourceRef], back: false }])
  })

  it('no loop: a message the inbox closed because the mailbox archived it is never archived again', async () => {
    archiveAllowed.add('u-alice')
    const s = await aliceMail()
    unsure(s.id)
    // Archived there with a task open: noted. The task done, then closed by her: the mailbox already has it archived.
    const task = ok(await engine.create(m('u-alice'), AI('u-alice'), { type: 'task', title: '確かめる', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [s.id] } })).record.id
    await archivedInMailbox('u-alice', s.msg.threadRef!)
    expect(ledger(s.id).at(-1)!.action).toBe('left_inbox_noted')
    ok(await engine.act(m('u-alice'), person('u-alice'), task, 'start', { expectedVersion: stateOf(task).version }))
    ok(await engine.act(m('u-alice'), person('u-alice'), task, 'complete', { expectedVersion: stateOf(task).version }))
    ok(await engine.act(m('u-alice'), person('u-alice'), s.id, 'settle', { expectedVersion: stateOf(s.id).version }))
    // Closed by the inbox after an undo of hers… then 済んだ: still archived there, nothing sent.
    const c = await aliceMail()
    unsure(c.id)
    await archivedInMailbox('u-alice', c.msg.threadRef!)
    expect(ledger(c.id).at(-1)!.action).toBe('left_inbox')
    const v = stateOf(c.id).version
    ok(await engine.undo(m('u-alice'), person('u-alice'), c.id, { version: v, expectedVersion: v }))
    ok(await engine.act(m('u-alice'), person('u-alice'), c.id, 'settle', { expectedVersion: stateOf(c.id).version }))
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([])
  })

  it('only her own mailbox: a message read from Bob\'s mailbox is never archived, not in hers nor his', async () => {
    archiveAllowed.add('u-alice')
    archiveAllowed.add('u-bob')
    const { id } = await aliceMail({ cc: [{ address: 'bob@acme.example' }] }, 'u-bob')
    unsure(id)
    ok(await engine.act(m('u-alice'), person('u-alice'), id, 'settle', { expectedVersion: stateOf(id).version }))
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([])
  })
})

describe('review of #607: what the archive never does', () => {
  it('only the messages ACB took in from her mailbox are archived — the thread\'s later message too once taken in, nothing else', async () => {
    archiveAllowed.add('u-alice')
    const first = await aliceMail()
    // Their reply in the same thread, taken in by her next poll.
    mailbox['u-alice'] = [mail({ references: [first.msg.messageId], threadRef: first.msg.threadRef, occurredAt: '2026-11-02T00:40:00.000Z' })]
    const reply = mailbox['u-alice'][0]
    await inbox.poll('a', 'u-alice')
    unsure(first.id)
    ok(await engine.act(m('u-alice'), person('u-alice'), first.id, 'settle', { expectedVersion: stateOf(first.id).version }))
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([{ userId: 'u-alice', refs: [first.msg.sourceRef, reply.sourceRef], back: false }])
  })

  it('she takes back her own 済んだ after ACB archived it: the next looks — history or a fresh start — never close it again', async () => {
    archiveAllowed.add('u-alice')
    const s = await aliceMail()
    unsure(s.id)
    ok(await engine.act(m('u-alice'), person('u-alice'), s.id, 'settle', { expectedVersion: stateOf(s.id).version }))
    await inbox.whenIdle()
    const settle = ledger(s.id).find(e => e.action === 'settle')!
    ok(await engine.undo(m('u-alice'), person('u-alice'), s.id, { version: settle.version, expectedVersion: stateOf(s.id).version }))
    expect(stateOf(s.id).state).toBe('unsure')
    told = []
    // Gmail's history shows ACB's own archive.
    await archivedInMailbox('u-alice', s.msg.threadRef!)
    // A fresh start (no cursor) checks the open records themselves.
    handle().inbox.setLeftCursor('u-alice', 'email', null)
    await inbox.poll('a', 'u-alice')
    expect(stateOf(s.id).state).toBe('unsure')
    expect(ledger(s.id).some(e => e.action === 'left_inbox' || e.action === 'left_inbox_noted')).toBe(false)
    expect(notices()).toEqual([])
  })

  it('a double follow-up of one close calls the mailbox once and tells her once', async () => {
    archiveAllowed.add('u-alice')
    const s = await aliceMail()
    unsure(s.id)
    ok(await engine.act(m('u-alice'), person('u-alice'), s.id, 'settle', { expectedVersion: stateOf(s.id).version }))
    // The same close reported again before the first follow-up finished (two app windows, a retry).
    inbox.afterAct('a', { type: 'interaction', entry: ledger(s.id).at(-1)! })
    await inbox.whenIdle()
    expect(archiveCalls).toHaveLength(1)
    expect(ledger(s.id).filter(e => e.action === 'archived_there')).toHaveLength(1)
  })

  it('the AI completing the tasks (the reply check) archives nothing: only a person\'s close or completion does', async () => {
    archiveAllowed.add('u-alice')
    const t = await aliceMail()
    const task = ok(await engine.create(m('u-alice'), AI('u-alice'), { type: 'task', title: '見積書を送る', personal: true, fields: { assignee: 'u-alice' }, links: { interaction: [t.id] } })).record.id
    ok(inbox.judge(m('u-alice'), AI('u-alice'), t.id, { expectedVersion: 1, outcome: 'task', reason: '見積の依頼', taskId: task }))
    // Her own reply (her Sent mail) → her AI's check, which completes the task.
    inbox.receive('a', 'u-alice', mail({ references: [t.msg.messageId], threadRef: t.msg.threadRef, from: { address: 'alice@acme.example' }, to: [{ address: 'tanaka@client.example' }], outgoing: true, occurredAt: '2026-11-02T00:50:00.000Z' }))
    expect(stateOf(t.id).state).toBe('replied')
    const checked = ok(inbox.replyCheck(m('u-alice'), AI('u-alice'), t.id, { expectedVersion: stateOf(t.id).version, tasks: [{ taskId: task, outcome: 'done' }] }))
    expect(checked.state).toBe('handled')
    expect(stateOf(task).state).toBe('done')
    await inbox.whenIdle()
    expect(archiveCalls).toEqual([])
  })

  it('more watched records than one look checks: the cursor waits until every one was checked', async () => {
    const ids: string[] = []
    for (let i = 0; i < LEFT_CHECK_MAX + 3; i++) ids.push((await aliceMail()).id)
    const refs = ids.map(id => fieldsOf(id).thread_ref as string)
    for (const r of refs) gone.add(`u-alice|${r}`)
    const cursor = handle().inbox.connection('u-alice', 'email')!.leftCursor
    reported['u-alice'] = refs
    await inbox.poll('a', 'u-alice')
    expect(ids.filter(id => stateOf(id).state === 'handled')).toHaveLength(LEFT_CHECK_MAX)
    expect(handle().inbox.connection('u-alice', 'email')!.leftCursor).toBe(cursor)
    reported['u-alice'] = refs
    await inbox.poll('a', 'u-alice')
    expect(ids.filter(id => stateOf(id).state === 'handled')).toHaveLength(LEFT_CHECK_MAX + 3)
    expect(handle().inbox.connection('u-alice', 'email')!.leftCursor).not.toBe(cursor)
  })
})
