/**
 * 大事な知らせを Slack の DM で (stage 3 A3, `.claude/rules/slack-connector.md`
 * "Notice DMs") on the real schema, state engine, notices service, vault,
 * member-oauth and Slack connector, against the fake Slack — wired as in
 * composition.ts (the notices' `outside` hook → services/slack-notices.ts →
 * the company's bot).
 *
 * Guards (each fails when its check is removed):
 * - only a notice whose record now waits for the member (「あなたの番」) becomes
 *   a DM: a result told to the requester, an AI's turn and a final state do not;
 * - the DM carries the title and nothing else of the record (no purpose, note);
 * - the member's own switch (`notices` off) and a member without a grant get none;
 * - the DM goes by the company's own bot to the member's own Slack account.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteKeyBrokerRepository } from '../../src/adapters/sqlite/key-broker'
import { sqliteSlackData } from '../../src/adapters/sqlite/slack'
import { nodeHmacSigner } from '../../src/adapters/hmac'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'
import { randomIds, sha256TokenDigest, systemClock } from '../../src/adapters/system'
import type { CompanyDataSource } from '../../src/ports/company-data'
import { ensureCoreTypes } from '../../src/services/record-index'
import { createRecordEngine, type RecordChange, type RecordEngine } from '../../src/services/record-engine'
import { createNotificationService } from '../../src/services/notifications'
import { createBrokerVault } from '../../src/services/broker-vault'
import { createMemberOAuth, type MemberOAuth } from '../../src/services/member-oauth'
import { createSlackClient } from '../../src/services/slack-client'
import { createSlackConnector, type SlackConnector } from '../../src/services/slack-connector'
import { createSlackNotices, noticeDmText } from '../../src/services/slack-notices'
import type { Member } from '../../src/services/access'
import { createFakeSlack, type FakeSlack } from '../fakes/slack/fake-slack'
import { fakeUpstream } from '../helpers/fake-upstream'

const TS = '2026-11-01T00:00:00.000Z'
// bob signs in to Slack as U0ONE, alice as U0TWO (the fake's seed: one@ / two@div.example).
const EMAILS: Record<string, string> = { 'u-bob': 'one@div.example', 'u-alice': 'two@div.example', 'u-admin': 'admin@div.example' }
const MEMBERS = ['u-alice', 'u-bob', 'u-admin']
const HUMAN = { kind: 'human' as const }

let conn: Database.Database
let source: CompanyDataSource
let engine: RecordEngine
let fake: FakeSlack
let oauth: MemberOAuth
let connector: SlackConnector
let pending: Array<Promise<number>>
let warnings: string[]

const m = (userId: string): Member => ({ companyId: 'c1', userId, role: userId === 'u-admin' ? 'admin' : 'member' })

function ok<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

beforeEach(async () => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('c1', 'c1', 'c1', 'u-admin', TS, TS)
  conn.prepare("INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES ('c1-root', 'c1', '', 'company', ?)").run(TS)
  conn.prepare("INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('c1-root-r', 'c1-root', 'everyone', NULL, 1, 1, ?)").run(TS)
  const records = source.forCompany('c1').records
  records.setEnabled(true, 'u-admin', TS)
  ensureCoreTypes(records, TS)

  fake = createFakeSlack()
  pending = []
  warnings = []
  const slackData = sqliteSlackData(conn)
  const brokerVault = createBrokerVault({ brokerKeys: sqliteKeyBrokerRepository(conn), brokerCipher: { enabled: true, cipher: localSecretCipher(randomBytes(32)) } })
  const accounts = {
    byIds: (ids: string[]) => new Map(ids.filter(i => EMAILS[i]).map(i => [i, { id: i, email: EMAILS[i], name: i, image: null }])),
    bySessionToken: () => null,
  }
  const isMember = (co: string, userId: string) => co === 'c1' && MEMBERS.includes(userId)
  const roleOf = (co: string, userId: string) => (isMember(co, userId) ? (userId === 'u-admin' ? 'admin' : 'member') : null)
  const operatorStopped = async () => false
  oauth = createMemberOAuth({
    companyData: source, brokerVault, accounts, clock: systemClock, ids: randomIds, tokenDigest: sha256TokenDigest, isMember,
    redirectUri: p => `https://acb.example/api/oauth/${p}/callback`, log: { warn: w => warnings.push(w) },
  })
  const client = createSlackClient({
    companyData: source, slackData, brokerVault, upstream: fakeUpstream(fake.app), hmac: nodeHmacSigner, clock: systemClock, isMember,
    operatorStopped, record: () => {}, authorizeOrigin: 'https://slack.com',
  })
  connector = createSlackConnector({
    companyData: source, slackData, brokerVault, slack: client, memberOAuth: oauth, accounts, clock: systemClock, ids: randomIds,
    redirectUri: () => 'https://acb.example/api/oauth/slack/callback', eventsUrl: c => `https://acb.example/api/slack/events/${c}`, operatorStopped, isMember,
  })
  const slackNotices = createSlackNotices({ companyData: source, sendNoticeDm: connector.sendNoticeDm, log: { warn: w => warnings.push(w) } })
  const shared = { companyData: source, transactions: sqliteTransactions(conn), clock: systemClock, ids: randomIds }
  const notices = createNotificationService({
    ...shared, roleOf, accounts, push: () => {},
    // composition.ts: the outside hook (fire and forget there; awaited here).
    outside: (co, rows) => { pending.push(slackNotices.deliver(co, rows)) },
  })
  const notify = (co: string, userIds: string[], change?: RecordChange) => { if (change) notices.recordChange(co, userIds, change) }
  engine = createRecordEngine({ ...shared, files: { appendHistoryLine: async () => true, fileAtCommit: async () => true }, managedFolders: () => [], isMember, roleOf, notify })

  const a = fake.seed.apps[0]
  ok(await connector.saveApp(m('u-admin'), { teamId: a.teamId, clientId: a.clientId, clientSecret: a.clientSecret, signingSecret: a.signingSecret, botToken: a.botToken }))
})

afterEach(() => conn.close())

async function allow(userId: string, as: string, features: string[] = ['read', 'notices']) {
  const started = ok(await connector.connect(m(userId), { features }))
  const url = new URL(started.authorizeUrl)
  const code = fake.issueCode({ clientId: url.searchParams.get('client_id')!, userId: as, scopes: url.searchParams.get('user_scope')!.split(','), redirectUri: url.searchParams.get('redirect_uri')! })
  expect((await oauth.callback('slack', { state: url.searchParams.get('state')!, code }))!.granted).toBe(true)
}

/** DMs the bot sent since the start, after the pending deliveries. */
async function dms() {
  await Promise.all(pending)
  return fake.posted.filter(p => p.by === fake.seed.apps[0].botUserId)
}

describe('notice DMs (あなたの番)', () => {
  beforeEach(async () => {
    await allow('u-bob', 'U0ONE')
    await allow('u-alice', 'U0TWO')
  })

  it('a task handed to the member: one DM by the company bot to their own Slack, with the title only', async () => {
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書を作る', fields: { assignee: 'u-bob', purpose: 'SECRET-PURPOSE 価格交渉の下限' } }))
    const sent = await dms()
    expect(sent).toEqual([{ teamId: 'T0DIV', by: 'U0BOTDIV', channel: 'D0ONE', text: noticeDmText('提案書を作る', false) }])
    expect(sent[0].text).not.toContain('SECRET-PURPOSE')
  })

  it('a result told to the requester is not their turn: no DM (the bell has it)', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    await dms()
    fake.posted.length = 0
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'start', { expectedVersion: 1 }))
    // A due changed (still bob's turn) and the completion are told to alice: neither waits for her.
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'set_due', { expectedVersion: 2, args: { due: '2026-11-20' } }))
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'complete', { expectedVersion: 3 }))
    expect(await dms()).toEqual([])
  })

  it('a final state is nobody\'s turn: cancelling the assignee\'s task sends no DM', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    await dms()
    fake.posted.length = 0
    ok(await engine.act(m('u-alice'), HUMAN, t.id, 'cancel', { expectedVersion: 1, note: '不要になった' }))
    expect(await dms()).toEqual([])
  })

  it('what came back to the requester (受けられない) is their turn: a DM to them', async () => {
    const t = ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '見積書', fields: { assignee: 'u-bob' } })).record
    await dms()
    fake.posted.length = 0
    ok(await engine.act(m('u-bob'), HUMAN, t.id, 'decline', { expectedVersion: 1, note: 'NOTE-TEXT 今週は無理' }))
    const sent = await dms()
    expect(sent.map(s => s.channel)).toEqual(['D0TWO'])
    expect(sent[0].text).not.toContain('NOTE-TEXT')
  })

  it('the AI\'s turn reaches nobody yet', async () => {
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '下調べ', state: 'preparing', fields: { assignee: 'u-bob' } }))
    expect(await dms()).toEqual([])
  })

  it('the member\'s own switch (知らせの DM off) stops it from the next notice; on again sends again', async () => {
    ok(await connector.setFeature(m('u-bob'), { feature: 'notices', on: false }))
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '一つ目', fields: { assignee: 'u-bob' } }))
    expect(await dms()).toEqual([])
    ok(await connector.setFeature(m('u-bob'), { feature: 'notices', on: true }))
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '二つ目', fields: { assignee: 'u-bob' } }))
    expect((await dms()).map(s => s.text)).toEqual([noticeDmText('二つ目', false)])
  })

  it('a member without a Slack permission, or who stopped it, gets none', async () => {
    await connector.disconnect(m('u-bob'))
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } }))
    expect(await dms()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('the company\'s Slack off: none', async () => {
    ok(await connector.setEnabled(m('u-admin'), { enabled: false }))
    ok(engine.create(m('u-alice'), HUMAN, { type: 'task', title: '提案書', fields: { assignee: 'u-bob' } }))
    expect(await dms()).toEqual([])
  })
})
