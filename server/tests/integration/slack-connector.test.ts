/**
 * The Slack connection (stage 3 A2, `.claude/rules/slack-connector.md`) on the
 * real schema, vault and member-oauth, against the fake Slack:
 * - a member's 「Slack で許可」 stores a grant only for their own address in the
 *   company's workspace (anything else stores nothing and revokes the token);
 * - every stop (admin, company switch, operator, 「許可をやめる」, すべての鍵を止める)
 *   works from the next call — calls and events alike;
 * - one company never reaches another's grants, events or Slack accounts;
 * - an event is taken only with the company's own signature (fresh, exact body);
 * - a member whose own 受信を読む is off gets no signal (work-switches.ts);
 * - an @channel / @here / @everyone alone is not taken in; a signal carries the sender's name only;
 * - a thread reads as plain text: mentions by name, links by label, nothing of Slack's markup;
 * - no secret and no message text is ever in a table, an answer or a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { initSlackSchema } from '../../src/db/schema/slack'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteKeyBrokerRepository } from '../../src/adapters/sqlite/key-broker'
import { sqliteSlackData } from '../../src/adapters/sqlite/slack'
import { nodeHmacSigner } from '../../src/adapters/hmac'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'
import { randomIds, sha256TokenDigest, systemClock } from '../../src/adapters/system'
import { createBrokerVault } from '../../src/services/broker-vault'
import { createMemberOAuth, type MemberOAuth } from '../../src/services/member-oauth'
import { createSlackClient, type SlackClient } from '../../src/services/slack-client'
import { createSlackConnector, type SlackConnector } from '../../src/services/slack-connector'
import { createSlackEvents, type SlackSignal } from '../../src/services/slack-events'
import { createSlackNames, SLACK_NAME_TTL_MS, type SlackNames } from '../../src/services/slack-names'
import { createSlackChat, slackPlainText } from '../../src/services/slack-chat'
import { createSlackRoute } from '../../src/routes/slack'
import { createConnectorRoles } from '../../src/services/connector-roles'
import { createFakeSlack, signEvent, type FakeSlack } from '../fakes/slack/fake-slack'
import { fakeUpstream } from '../helpers/fake-upstream'

const TS = '2026-11-01T00:00:00.000Z'
const EMAILS: Record<string, string> = { u1: 'one@div.example', u2: 'two@div.example', u3: 'three@other.example', a1: 'admin@div.example', a3: 'admin@other.example' }
const MEMBERS: Record<string, string[]> = { c1: ['u1', 'u2', 'a1'], c2: ['u3', 'a3'] }
const ROLES: Record<string, string> = { a1: 'admin', a3: 'admin' }
const REDIRECT = 'https://acb.example/api/oauth/slack/callback'

let conn: Database.Database
let fake: FakeSlack
let oauth: MemberOAuth
let client: SlackClient
let connector: SlackConnector
let signals: SlackSignal[]
let operatorStop: boolean
let warnings: string[]
/** `<company>/<user>` whose own 受信を読む is off. */
let readingOff: Set<string>
let route: ReturnType<typeof createSlackRoute>
let names: SlackNames
let clockMs: number

const member = (companyId: string, userId: string) => ({ companyId, userId, role: ROLES[userId] ?? 'member' })

beforeEach(async () => {
  conn = new Database(':memory:')
  initDatabase(conn)
  initSlackSchema(conn)
  for (const id of ['c1', 'c2']) {
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', TS, TS)
  }
  fake = createFakeSlack()
  signals = []
  warnings = []
  readingOff = new Set()
  operatorStop = false
  const companyData = sqliteCompanyData(conn)
  const slackData = sqliteSlackData(conn)
  const brokerVault = createBrokerVault({ brokerKeys: sqliteKeyBrokerRepository(conn), brokerCipher: { enabled: true, cipher: localSecretCipher(randomBytes(32)) } })
  const accounts = {
    byIds: (ids: string[]) => new Map(ids.filter(i => EMAILS[i]).map(i => [i, { id: i, email: EMAILS[i], name: i, image: null }])),
    bySessionToken: () => null,
  }
  const isMember = (companyId: string, userId: string) => (MEMBERS[companyId] ?? []).includes(userId)
  const operatorStopped = async () => operatorStop
  oauth = createMemberOAuth({
    companyData, brokerVault, accounts, clock: systemClock, ids: randomIds, tokenDigest: sha256TokenDigest, isMember,
    redirectUri: p => `https://acb.example/api/oauth/${p}/callback`, log: { warn: m => warnings.push(m) },
  })
  client = createSlackClient({
    companyData, slackData, brokerVault, upstream: fakeUpstream(fake.app), hmac: nodeHmacSigner, clock: systemClock, isMember,
    operatorStopped, record: () => {}, authorizeOrigin: 'https://slack.com',
  })
  connector = createSlackConnector({
    companyData, slackData, brokerVault, slack: client, memberOAuth: oauth, accounts, clock: systemClock, ids: randomIds,
    redirectUri: () => REDIRECT, eventsUrl: c => `https://acb.example/api/slack/events/${c}`, operatorStopped, isMember,
  })
  clockMs = Date.now()
  names = createSlackNames({ slack: client, clock: { nowMs: () => clockMs } })
  const events = createSlackEvents({
    companyData, slackData, slack: client, clock: systemClock, isMember, operatorStopped,
    vaultEnabled: () => brokerVault.status().enabled, readsIncoming: (co, userId) => !readingOff.has(`${co}/${userId}`),
    onSignal: s => signals.push(s), log: { warn: m => warnings.push(m) }, names,
  })
  route = createSlackRoute(events)
  await registerApp('c1', 'a1', 0)
  await registerApp('c2', 'a3', 1)
})

afterEach(() => conn.close())

async function registerApp(companyId: string, admin: string, index: number) {
  const a = fake.seed.apps[index]
  const saved = await connector.saveApp(member(companyId, admin), {
    teamId: a.teamId, clientId: a.clientId, clientSecret: a.clientSecret, signingSecret: a.signingSecret, botToken: a.botToken,
  })
  expect(saved.ok).toBe(true)
}

/** A member's 「Slack で許可」 end to end; `as` is the Slack account that signs in. Returns the callback page. */
async function allow(companyId: string, userId: string, as: string, features: string[] = ['read', 'reply']) {
  const started = await connector.connect(member(companyId, userId), { features })
  if (!started.ok) throw new Error(JSON.stringify(started))
  const url = new URL(started.value.authorizeUrl)
  const code = fake.issueCode({ clientId: url.searchParams.get('client_id')!, userId: as, scopes: url.searchParams.get('user_scope')!.split(','), redirectUri: url.searchParams.get('redirect_uri')! })
  return (await oauth.callback('slack', { state: url.searchParams.get('state')!, code }))!
}

const grantOf = (companyId: string, userId: string) => sqliteCompanyData(conn).forCompany(companyId).connectors.grant('slack', userId)
const read = (companyId: string, userId: string) => client.userCall(companyId, userId, {
  method: 'conversations.replies', params: { channel: 'C0GENERAL', ts: '1.0' }, write: false, scope: 'channels:history', operation: 'conversations.replies',
})

/** Posts an event as Slack would, signed with `secret` (default: the company's own). */
async function postEvent(companyId: string, body: unknown, opts: { secret?: string; timestamp?: number; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body)
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const secret = opts.secret ?? fake.seed.apps[companyId === 'c1' ? 0 : 1].signingSecret
  return route.request(`/events/${companyId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signEvent(secret, ts, raw) },
    body: opts.tamper ? raw.replace('}', ',"x":1}') : raw,
  })
}

let eventSeq = 0
function message(team: string, event: Record<string, unknown>, authorizedUser = 'U0ONE') {
  return {
    type: 'event_callback', team_id: team, api_app_id: 'A0FAKE', event_id: `Ev${++eventSeq}`, event_time: 1,
    authorizations: [{ team_id: team, user_id: authorizedUser, is_bot: false }],
    event: { type: 'message', channel: 'C0GENERAL', ts: `17935.${eventSeq}`, user: 'U0TWO', text: 'hello', ...event },
  }
}

describe('a member\'s 「Slack で許可」', () => {
  it('asks only the user scopes of the features, for the company\'s workspace, and stores the grant of the member\'s own address', async () => {
    const started = await connector.connect(member('c1', 'u1'), { features: ['read'] })
    expect(started.ok).toBe(true)
    const url = new URL(started.ok ? started.value.authorizeUrl : '')
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(url.searchParams.get('team')).toBe('T0DIV')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('scope')).toBeNull()
    expect(url.searchParams.get('user_scope')!.split(',').sort()).toEqual(['channels:history', 'groups:history', 'im:history', 'mpim:history', 'users:read', 'users:read.email'])

    const page = await allow('c1', 'u1', 'U0ONE')
    expect(page.granted).toBe(true)
    expect(grantOf('c1', 'u1')).toMatchObject({ status: 'active', accountEmail: 'one@div.example' })
    expect((await connector.my(member('c1', 'u1')))).toMatchObject({ ok: true, value: { connected: true, features: ['read', 'reply', 'notices'] } })
    expect((await read('c1', 'u1')).ok).toBe(true)
  })

  it('another Slack account than the member\'s own address stores nothing and revokes the token', async () => {
    const page = await allow('c1', 'u1', 'U0OUT')
    expect(page.granted).toBe(false)
    expect(grantOf('c1', 'u1')).toBeNull()
    expect(fake.revokedTokens).toHaveLength(1)
    expect((await read('c1', 'u1'))).toMatchObject({ ok: false, reason: 'no-grant' })
  })

  it('an account of another workspace stores nothing and revokes the token (even with the member\'s own address)', async () => {
    const page = await allow('c1', 'u1', 'U0ONEX')
    expect(page.granted).toBe(false)
    expect(grantOf('c1', 'u1')).toBeNull()
    expect(fake.revokedTokens).toHaveLength(1)
  })

  it('a call needs the scope of its feature', async () => {
    expect((await allow('c1', 'u2', 'U0TWO', ['reply'])).granted).toBe(true)
    expect(await read('c1', 'u2')).toMatchObject({ ok: false, kind: 'not-sent', reason: 'scope-not-granted' })
  })

  it('an app with token rotation on is refused (no expiring token is kept as if it lasted)', async () => {
    fake.seed.apps[0].rotation = true
    const page = await allow('c1', 'u1', 'U0ONE')
    expect(page.granted).toBe(false)
    expect(grantOf('c1', 'u1')).toBeNull()
  })

  it('only owners and admins manage the app; a bot token of another workspace is not saved', async () => {
    expect(await connector.saveApp(member('c1', 'u1'), {})).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await connector.setEnabled(member('c1', 'u1'), { enabled: false })).toMatchObject({ ok: false, kind: 'forbidden' })
    const other = await connector.saveApp(member('c1', 'a1'), { teamId: 'T0DIV', clientId: '1111.2222', botToken: fake.seed.apps[1].botToken })
    expect(other).toMatchObject({ ok: false, body: { code: 'BOT_TOKEN_REJECTED' } })
  })

  it('「仕事の道具をつなぐ」 offers Slack once: seen is the member\'s own, in their company only', async () => {
    expect(await connector.my(member('c1', 'u2'))).toMatchObject({ ok: true, value: { seen: [] } })
    expect(await connector.markSeen(member('c1', 'u2'))).toMatchObject({ ok: true, value: { seen: ['read', 'notices'] } })
    expect(await connector.my(member('c1', 'u1'))).toMatchObject({ ok: true, value: { seen: [] } })
    expect(await connector.my(member('c2', 'u2'))).toMatchObject({ ok: true, value: { seen: [] } })
  })
})

describe('the chat role', () => {
  it('Slack serves 「チャットの連絡を受け取る・返す」 while the company\'s app is on, and not once it is off or stopped', async () => {
    const roles = createConnectorRoles({ choices: { choice: () => null, setChoice: () => {} }, clock: systemClock })
    roles.register(connector.roleConnector())
    expect(await roles.resolve('c1', 'chat', 'reply')).toMatchObject({ ok: true, connectorId: 'slack' })
    await connector.setEnabled(member('c1', 'a1'), { enabled: false })
    expect(await roles.resolve('c1', 'chat')).toEqual({ ok: false, reason: 'none' })
    expect(await roles.resolve('c2', 'chat')).toMatchObject({ ok: true, connectorId: 'slack' })
    operatorStop = true
    expect(await roles.resolve('c2', 'chat')).toEqual({ ok: false, reason: 'none' })
  })
})

describe('every stop works from the next call', () => {
  beforeEach(async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
    expect((await read('c1', 'u1')).ok).toBe(true)
  })

  it('the admin stops one member (revoked at Slack too)', async () => {
    expect((await connector.stopGrant(member('c1', 'a1'), 'u1')).ok).toBe(true)
    expect(await read('c1', 'u1')).toMatchObject({ ok: false, kind: 'not-sent', reason: 'grant-stopped' })
    expect(fake.revokedTokens).toHaveLength(1)
  })

  it('the company switch off', async () => {
    await connector.setEnabled(member('c1', 'a1'), { enabled: false })
    expect(await read('c1', 'u1')).toMatchObject({ ok: false, reason: 'off' })
    expect(await connector.connect(member('c1', 'u2'), { features: ['read'] })).toMatchObject({ ok: false, body: { code: 'SLACK_UNAVAILABLE', reason: 'off' } })
  })

  it('the operator\'s stop', async () => {
    operatorStop = true
    expect(await read('c1', 'u1')).toMatchObject({ ok: false, reason: 'operator-stopped' })
    expect(await connector.sendNoticeDm('c1', 'u1', '承認のお願いがあります')).toMatchObject({ ok: false, reason: 'operator-stopped' })
  })

  it('the member\'s 「許可をやめる」 and 「すべての鍵を止める」', async () => {
    await connector.disconnect(member('c1', 'u1'))
    expect(await read('c1', 'u1')).toMatchObject({ ok: false, reason: 'no-grant' })
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
    expect(await oauth.stopAll('c1', 'a1')).toBe(1)
    expect(await read('c1', 'u1')).toMatchObject({ ok: false, reason: 'grant-stopped' })
  })

  it('a member removed from the company', async () => {
    MEMBERS.c1 = MEMBERS.c1.filter(u => u !== 'u1')
    try {
      expect(await read('c1', 'u1')).toMatchObject({ ok: false, reason: 'not-member' })
    } finally {
      MEMBERS.c1.push('u1')
    }
  })
})

describe('never crossing companies', () => {
  beforeEach(async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
    expect((await allow('c2', 'u3', 'U0THREE')).granted).toBe(true)
  })

  it('a member\'s grant serves only their company; another company\'s admin cannot stop it', async () => {
    expect(await read('c2', 'u1')).toMatchObject({ ok: false, reason: 'not-member' })
    expect(await connector.stopGrant(member('c2', 'a3'), 'u1')).toMatchObject({ ok: false, kind: 'not-found' })
    expect(grantOf('c1', 'u1')?.status).toBe('active')
    const view = await connector.adminView(member('c2', 'a3'))
    expect(view.ok && view.value.grants.map(g => g.userId)).toEqual(['u3'])
  })

  it('an event signed with one company\'s secret is refused at another company\'s URL', async () => {
    const body = message('T0DIV', { channel_type: 'im', channel: 'D0ONE' })
    const res = await postEvent('c2', body, { secret: fake.seed.apps[0].signingSecret })
    expect(res.status).toBe(401)
    expect(signals).toEqual([])
  })

  it('an event of another workspace, even correctly signed, gives no signal', async () => {
    // Signed with c1's own secret, mentioning c1's connected member, but about c2's workspace.
    const res = await postEvent('c1', message('T0OTHER', { text: 'hi <@U0ONE>' }, 'U0THREE'))
    expect(res.status).toBe(200)
    expect(signals).toEqual([])
  })

  it('a Slack user known in one company means nothing in another', async () => {
    // c2's workspace mentions c1's Slack user id: c2 has no account for it.
    const res = await postEvent('c2', message('T0OTHER', { user: 'U0THREE', text: 'hi <@U0ONE>' }, 'U0THREE'))
    expect(res.status).toBe(200)
    expect(signals).toEqual([])
  })

  it('notice DMs go out only by the company\'s own bot, to the member\'s own Slack account', async () => {
    expect(await connector.sendNoticeDm('c1', 'u1', '承認のお願いがあります')).toMatchObject({ ok: true })
    expect(await connector.sendNoticeDm('c2', 'u1', 'x')).toMatchObject({ ok: false, reason: 'not-member' })
    expect(fake.posted).toEqual([{ teamId: 'T0DIV', by: 'U0BOTDIV', channel: 'D0ONE', text: '承認のお願いがあります' }])
  })
})

describe('the event receiver: Slack\'s signature', () => {
  beforeEach(async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
  })

  it('takes a fresh event signed with the company\'s secret over the exact body, once', async () => {
    const body = message('T0DIV', { channel_type: 'im', channel: 'D0ONE', text: 'secret plans for Q4' })
    expect((await postEvent('c1', body)).status).toBe(200)
    expect((await postEvent('c1', body)).status).toBe(200) // Slack's retry
    expect(signals).toEqual([{
      companyId: 'c1', userId: 'u1', kind: 'dm', channelId: 'D0ONE', ts: body.event.ts, threadTs: null, senderSlackUserId: 'U0TWO', senderName: '二宮 二郎', external: false,
    }])
  })

  it('refuses no signature, a wrong secret, an old timestamp, a changed body and an unknown company — all the same 401', async () => {
    const body = message('T0DIV', { channel_type: 'im', channel: 'D0ONE' })
    const unsigned = await route.request('/events/c1', { method: 'POST', body: JSON.stringify(body) })
    const wrong = await postEvent('c1', body, { secret: 'fake-slack-signing-not-this-one' })
    const old = await postEvent('c1', body, { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 })
    const changed = await postEvent('c1', body, { tamper: true })
    const unknown = await postEvent('c9', body, { secret: fake.seed.apps[0].signingSecret })
    for (const res of [unsigned, wrong, old, changed, unknown]) {
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('')
    }
    expect(signals).toEqual([])
  })

  it('answers Slack\'s URL check only when signed', async () => {
    const check = { type: 'url_verification', challenge: 'fake-challenge-123', token: 'x' }
    const ok = await postEvent('c1', check)
    expect(await ok.json()).toEqual({ challenge: 'fake-challenge-123' })
    expect((await postEvent('c1', check, { secret: 'fake-slack-signing-not-this-one' })).status).toBe(401)
  })

  it('a member whose own 受信を読む is off gets no signal; on again, it comes', async () => {
    readingOff.add('c1/u1')
    expect((await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))).status).toBe(200)
    expect(signals).toEqual([])
    readingOff.clear()
    await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))
    expect(signals.map(s => s.userId)).toEqual(['u1'])
  })

  it('drops events while the app is off or the operator stopped Slack (200, nothing handed on)', async () => {
    await connector.setEnabled(member('c1', 'a1'), { enabled: false })
    expect((await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))).status).toBe(200)
    await connector.setEnabled(member('c1', 'a1'), { enabled: true })
    operatorStop = true
    expect((await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))).status).toBe(200)
    expect(signals).toEqual([])
  })
})

describe('the event receiver: what becomes a signal', () => {
  beforeEach(async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
  })

  it('a DM and a mention to the member; @channel / @here / @everyone alone, a plain channel message, the member\'s own and a bot\'s give nothing', async () => {
    await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))
    await postEvent('c1', message('T0DIV', { text: 'see <@U0ONE> here', thread_ts: '17935.1' }))
    // Owner decision 2026-11-04: broadcasts are not taken in (they reached one authorized member at random).
    await postEvent('c1', message('T0DIV', { text: '<!channel> lunch' }))
    await postEvent('c1', message('T0DIV', { text: '<!here|here> standup' }))
    await postEvent('c1', message('T0DIV', { text: '<!everyone> 全社連絡' }))
    await postEvent('c1', message('T0DIV', { text: 'just chatting' }))
    await postEvent('c1', message('T0DIV', { user: 'U0ONE', text: '<!here> me' }))
    await postEvent('c1', message('T0DIV', { bot_id: 'B1', text: '<@U0ONE> build failed' }))
    await postEvent('c1', message('T0DIV', { subtype: 'message_changed', text: '<@U0ONE>' }))
    // A broadcast that also names the member, or one in their DM, still comes (as the mention / the DM).
    await postEvent('c1', message('T0DIV', { text: '<!channel> <@U0ONE> 確認お願いします' }))
    await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE', text: '<!here> 見て' }))
    expect(signals.map(s => [s.kind, s.threadTs])).toEqual([['dm', null], ['mention', '17935.1'], ['mention', null], ['dm', null]])
  })

  it('a signal carries the sender\'s display name (users.info), never the text; an unknown name is null', async () => {
    await postEvent('c1', message('T0DIV', { text: 'NAME-MARK <@U0ONE> 見積お願いします' }))
    await postEvent('c1', message('T0DIV', { user: 'U0OUT', text: '<@U0ONE> NAME-MARK' }))
    expect(signals.map(s => [s.senderSlackUserId, s.senderName])).toEqual([['U0TWO', '二宮 二郎'], ['U0OUT', null]])
    expect(JSON.stringify(signals)).not.toContain('NAME-MARK')
    expect(dumpTables()).not.toContain('NAME-MARK')
  })

  it('the member\'s own message in a DM or a thread is their reply (`own`, B4); in a channel outside a thread, nothing', async () => {
    await postEvent('c1', message('T0DIV', { user: 'U0ONE', channel_type: 'im', channel: 'D0ONE', text: '了解です' }))
    await postEvent('c1', message('T0DIV', { user: 'U0ONE', text: '返しました', thread_ts: '17935.1' }))
    await postEvent('c1', message('T0DIV', { user: 'U0ONE', text: 'just me' }))
    expect(signals.map(s => [s.kind, s.userId, s.channelId, s.threadTs])).toEqual([['own', 'u1', 'D0ONE', null], ['own', 'u1', 'C0GENERAL', '17935.1']])
  })

  it('a Slack Connect channel is an outside message', async () => {
    await postEvent('c1', message('T0DIV', { text: '<@U0ONE> quote?', is_ext_shared_channel: true, user: 'U0EXT', user_team: 'T0EXT' }))
    expect(signals).toMatchObject([{ kind: 'mention', external: true, senderSlackUserId: 'U0EXT' }])
  })

  it('only a member whose active grant reads gets signals', async () => {
    expect((await allow('c1', 'u2', 'U0TWO', ['reply'])).granted).toBe(true)
    await postEvent('c1', message('T0DIV', { user: 'U0ONE', text: '<@U0TWO> ping' }))
    expect(signals).toEqual([])
    await connector.stopGrant(member('c1', 'a1'), 'u1')
    await postEvent('c1', message('T0DIV', { channel_type: 'im', channel: 'D0ONE' }))
    expect(signals).toEqual([])
  })

  it('the text of a message is never stored, logged or handed on', async () => {
    const spy = vi.spyOn(console, 'log')
    const spyWarn = vi.spyOn(console, 'warn')
    try {
      await postEvent('c1', message('T0DIV', { text: 'TOP-SECRET-MERGER <@U0ONE>' }))
      await postEvent('c1', message('T0OTHER', { text: 'TOP-SECRET-MERGER <@U0ONE>' }))
      expect(JSON.stringify(signals)).not.toContain('TOP-SECRET')
      expect([...warnings, ...spy.mock.calls.flat(), ...spyWarn.mock.calls.flat()].join('\n')).not.toContain('TOP-SECRET')
      expect(dumpTables()).not.toContain('TOP-SECRET')
    } finally {
      spy.mockRestore()
      spyWarn.mockRestore()
    }
  })
})

describe('Slack users\' names', () => {
  beforeEach(async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
  })

  it('kept a day per company and Slack user: a renamed user shows the new name after a day, another company asks its own Slack', async () => {
    expect(await names.nameOf('c1', 'U0TWO', 'u1')).toBe('二宮 二郎')
    fake.seed.users.find(u => u.id === 'U0TWO')!.name = '二宮 次郎'
    clockMs += SLACK_NAME_TTL_MS - 1000
    expect(await names.nameOf('c1', 'U0TWO', 'u1')).toBe('二宮 二郎')
    // c2's workspace has no U0TWO: c1's name is never answered there.
    expect(await names.nameOf('c2', 'U0TWO', null)).toBeNull()
    clockMs += 2000
    expect(await names.nameOf('c1', 'U0TWO', 'u1')).toBe('二宮 次郎')
  })
})

describe('a thread as plain text (元のスレッド)', () => {
  it('mentions by name, links by label, @channel / @here; Slack\'s escapes undone into text, never markup', async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
    fake.seed.threads = [{
      teamId: 'T0DIV', channel: 'C0GENERAL', ts: '1793500000.000100',
      messages: [
        { ts: '1793500000.000100', user: 'U0TWO', text: '<@U0ONE> <!channel> *至急* <https://example.com/q?a=1&amp;b=2|見積書> を見てください' },
        { ts: '1793500001.000100', user: 'U0ONE', text: '<!here|here> <#C0GENERAL|general> &lt;script&gt;alert(1)&lt;/script&gt; <@U0NOBODY|someone> <mailto:a@b.example>' },
      ],
    }]
    const chat = createSlackChat({ slack: client, companyData: sqliteCompanyData(conn), slackData: sqliteSlackData(conn), names })
    const r = await chat.thread('c1', 'u1', { channelId: 'C0GENERAL', threadTs: '1793500000.000100' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.messages.map(m => [m.authorName, m.text])).toEqual([
      ['二宮 二郎', '@一ノ瀬 一 @channel *至急* 見積書 を見てください'],
      ['一ノ瀬 一', '@here #general <script>alert(1)</script> @someone a@b.example'],
    ])
  })

  it('slackPlainText: a mention by its looked-up name, else its label, else 「Slack の人」; @everyone; a bare link as itself', () => {
    const known = new Map([['U0TWO', '二宮 二郎']])
    expect(slackPlainText('<@U0TWO|ninomiya> <@U0ZZZ> <!everyone> <https://x.example/a>', known)).toBe('@二宮 二郎 @Slack の人 @everyone https://x.example/a')
    expect(slackPlainText('a &amp;lt; b', known)).toBe('a &lt; b')
  })
})

/** Every row of every table, as text. */
function dumpTables(): string {
  const names = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name)
  return names.map(n => JSON.stringify(conn.prepare(`SELECT * FROM "${n}"`).all())).join('\n')
}

describe('secrets', () => {
  it('no app secret, bot token or member token in any table, answer or log line', async () => {
    expect((await allow('c1', 'u1', 'U0ONE')).granted).toBe(true)
    const view = JSON.stringify([await connector.adminView(member('c1', 'a1')), await connector.my(member('c1', 'u1'))])
    const userTokens = [...fake.tokens.keys()]
    const secrets = [...fake.seed.apps.flatMap(a => [a.clientSecret, a.signingSecret, a.botToken]), ...userTokens]
    expect(userTokens.length).toBeGreaterThan(0)
    const tables = dumpTables()
    for (const s of secrets) {
      expect(tables, 'table').not.toContain(s)
      expect(view, 'answer').not.toContain(s)
      expect(warnings.join('\n'), 'log').not.toContain(s)
    }
  })
})
