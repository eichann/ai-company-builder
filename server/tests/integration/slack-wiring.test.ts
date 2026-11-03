/**
 * The Slack connection wired into the server (stage 3 A3,
 * `.claude/rules/slack-connector.md`) through `createServices` — the real
 * composition — with staging's practice Slack (`ACB_FAKE_SLACK_URL`) pointing
 * at the fake Slack served on this machine:
 *
 * - every slack.com request (the bot token's check, a member's sign-in
 *   exchange, notice DMs) goes to the practice copy, and only practice values
 *   are saved; a real client secret saved before the redirect was on is never
 *   sent to it;
 * - the browser's sign-in URL is the practice copy's;
 * - Slack is a built-in core connector: 「つないでいるサービス」 lists it and
 *   it serves the `chat` role once set up and on;
 * - the events receiver checks the company's own signing secret.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { serve, type ServerType } from '@hono/node-server'
import { createFakeSlack, defaultSlackSeed, signEvent, type FakeSlack } from '../fakes/slack/fake-slack'
import type { UpstreamClient, UpstreamRequest } from '../../src/ports/upstream'

let practiceUpstreamsFrom: typeof import('../../src/lib/config').practiceUpstreamsFrom

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { id, email: `${id}@example.com`, name: id, image: null }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const CO = 'sw-co'
const ts = () => new Date().toISOString()
const admin = { companyId: CO, userId: 'sw-admin', role: 'admin' }
const member = { companyId: CO, userId: 'sw-member', role: 'member' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
let kekDir: string
let fake: FakeSlack
let server: ServerType
let practiceUrl: string
const atPractice: string[] = []
const outbound: UpstreamRequest[] = []
const realWayOut: UpstreamClient = {
  async send(req) {
    outbound.push(req)
    return { ok: true, response: { status: 200, headers: [], body: (async function* () { yield new TextEncoder().encode('{"ok":false,"error":"invalid_auth"}') })(), viaPrivateAddress: false } }
  },
}

const staging = () => ({ ACB_ALLOW_FAKE_UPSTREAMS: '1', NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:13001', ACB_FAKE_SLACK_URL: practiceUrl })

async function servicesFor(env: Record<string, string | undefined>) {
  const { createServices } = await import('../../src/composition')
  return createServices(db, undefined, { upstream: realWayOut, practiceUpstreams: practiceUpstreamsFrom(env) })
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-sw-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  ;({ practiceUpstreamsFrom } = await import('../../src/lib/config'))
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  db.prepare('INSERT OR IGNORE INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'sw-admin', ts(), ts())
  for (const [id, role] of [['sw-admin', 'admin'], ['sw-member', 'member']]) {
    db.prepare('INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}`, id, CO, role, ts(), ts())
  }
  const seed = defaultSlackSeed()
  seed.users.push({ id: 'U0SWMEMBER', email: 'sw-member@example.com', teamId: 'T0DIV' })
  fake = createFakeSlack(seed)
  server = serve({
    fetch: (req: Request) => { atPractice.push(new URL(req.url).pathname); return fake.app.fetch(req) },
    port: 0, hostname: '127.0.0.1',
  })
  await new Promise<void>(r => server.once('listening', () => r()))
  practiceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(r => server.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('the practice Slack (staging only)', () => {
  it('ACB_FAKE_SLACK_URL redirects slack.com only, under the same gates as the others', () => {
    const on = practiceUpstreamsFrom(staging())
    if (on.state !== 'on') throw new Error(JSON.stringify(on))
    expect(on.upstreams.map(u => [u.service, u.host])).toEqual([['slack', 'slack.com']])
    expect(practiceUpstreamsFrom({ ...staging(), NODE_ENV: 'production' }).state).toBe('ignored')
    expect(practiceUpstreamsFrom({ ...staging(), ACB_ALLOW_FAKE_UPSTREAMS: undefined }).state).toBe('ignored')
  })

  it('a real client secret saved before the redirect was on is never sent to the practice copy', async () => {
    // Practice off: a real-looking app without a bot token (nothing is sent to save it).
    const real = await servicesFor({})
    const saved = await real.slackConnector.saveApp(admin, { teamId: 'T0DIV', clientId: '1111.2222', clientSecret: 'real-client-secret-0123456789', signingSecret: 'real-signing-secret-0123456789' })
    expect(saved.ok).toBe(true)
    const services = await servicesFor(staging())
    const started = await services.slackConnector.connect(member, { features: ['read'] })
    if (!started.ok) throw new Error(JSON.stringify(started))
    const state = new URL(started.value.authorizeUrl).searchParams.get('state')!
    const before = atPractice.length
    const page = await services.memberOAuth.callback('slack', { state, code: 'fake-slack-code-1' })
    expect(page?.granted).toBe(false)
    expect(atPractice.slice(before)).not.toContain('/api/oauth.v2.access')
    expect(outbound.filter(r => r.host === 'slack.com')).toEqual([])
  })

  it('only practice values are saved; slack.com goes to the practice copy; the sign-in page is the practice copy\'s', async () => {
    const services = await servicesFor(staging())
    const app = fake.seed.apps[0]
    const refused = await services.slackConnector.saveApp(admin, { teamId: app.teamId, clientId: app.clientId, clientSecret: 'real-client-secret-0123456789', signingSecret: app.signingSecret })
    expect(refused).toMatchObject({ ok: false, body: { code: 'REAL_KEY_ON_PRACTICE' } })

    const before = atPractice.length
    const saved = await services.slackConnector.saveApp(admin, { teamId: app.teamId, clientId: app.clientId, clientSecret: app.clientSecret, signingSecret: app.signingSecret, botToken: app.botToken })
    expect(saved).toMatchObject({ ok: true, value: { practice: true, hasBotToken: true, eventsUrl: expect.stringMatching(new RegExp(`/api/slack/events/${CO}$`)), redirectUri: expect.stringMatching(/\/api\/oauth\/slack\/callback$/) } })
    // The bot token was checked by the practice copy (auth.test), never by the real way out.
    expect(atPractice.slice(before)).toContain('/api/auth.test')
    expect(outbound.filter(r => r.host === 'slack.com')).toEqual([])

    const started = await services.slackConnector.connect(member, { features: ['read', 'notices'] })
    if (!started.ok) throw new Error(JSON.stringify(started))
    const url = new URL(started.value.authorizeUrl)
    expect(url.origin + url.pathname).toBe(`${practiceUrl}/oauth/v2/authorize`)
    const code = fake.issueCode({ clientId: app.clientId, userId: 'U0SWMEMBER', scopes: url.searchParams.get('user_scope')!.split(','), redirectUri: url.searchParams.get('redirect_uri')! })
    expect((await services.memberOAuth.callback('slack', { state: url.searchParams.get('state')!, code }))?.granted).toBe(true)
    expect(await services.slackConnector.my(member)).toMatchObject({ ok: true, value: { connected: true, features: ['read', 'notices'], featuresOff: [], practice: true } })

    // A notice DM by the company's bot reaches the practice copy.
    const dm = await services.slackConnector.sendNoticeDm(CO, member.userId, 'ACB：あなたの番です。「練習」')
    expect(dm.ok).toBe(true)
    expect(fake.posted.at(-1)).toMatchObject({ by: app.botUserId, channel: 'D0SWMEMBER' })
  })
})

describe('Slack as a built-in core connector', () => {
  it('「つないでいるサービス」 lists Slack; once set up and on, it serves the chat role; off, it serves nothing', async () => {
    const services = await servicesFor(staging())
    const view = await services.coreConnectors.view(admin)
    if (!view.ok) throw new Error('refused')
    expect(view.value.connectors.find(c => c.id === 'slack')).toMatchObject({ label: 'Slack', status: 'on', roles: [{ role: 'chat', operations: ['receive', 'reply'] }] })
    expect(view.value.roles.find(r => r.role === 'chat')).toMatchObject({ servedBy: 'slack' })

    expect((await services.coreConnectors.setEnabled(admin, 'slack', { enabled: false })).ok).toBe(true)
    const off = await services.coreConnectors.view(admin)
    if (!off.ok) throw new Error('refused')
    expect(off.value.connectors.find(c => c.id === 'slack')?.status).toBe('off')
    expect(off.value.roles.find(r => r.role === 'chat')?.servedBy).toBeNull()
    expect((await services.coreConnectors.setEnabled(admin, 'slack', { enabled: true })).ok).toBe(true)
  })

  it('the events receiver answers Slack\'s URL check only with the company\'s own signing secret', async () => {
    const services = await servicesFor(staging())
    const body = JSON.stringify({ type: 'url_verification', challenge: 'ch-123' })
    const now = Math.floor(Date.now() / 1000)
    const own = await services.slackEvents.receive(CO, { timestamp: String(now), signature: signEvent(fake.seed.apps[0].signingSecret, now, body) }, body)
    expect(own).toEqual({ status: 200, json: { challenge: 'ch-123' } })
    const other = await services.slackEvents.receive(CO, { timestamp: String(now), signature: signEvent(fake.seed.apps[1].signingSecret, now, body) }, body)
    expect(other).toEqual({ status: 401 })
  })
})
