/**
 * Integration Test: staging's practice HubSpot (milestone 3, lib/config.ts
 * `practiceUpstreamsFrom`, adapters/upstream-practice.ts).
 *
 * - **It cannot switch on in production**: NODE_ENV=production, a missing
 *   staging marker, a public (non-local) PUBLIC_URL or a target that is not
 *   on this machine each leave HubSpot's requests going to the real way out,
 *   whatever ACB_FAKE_HUBSPOT_URL says.
 * - When it is on, the key check and the relay for `hubspot` connect to the
 *   practice server (the request still names api.hubapi.com); other services
 *   are untouched; the admin view says so (`practice`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { UpstreamClient, UpstreamRequest } from '../../src/ports/upstream'

// lib/config reads BROKER_KEK_FILE when first imported: loaded in beforeAll, after it is set.
let practiceUpstreamsFrom: typeof import('../../src/lib/config').practiceUpstreamsFrom

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const FAKE_HUBSPOT = 'pat-fake-test-key-NOT-REAL-practice-0123456789'
const FAKE_OPENAI = 'fake-test-key-NOT-REAL-practice-openai-98765'
const CO = 'pu-co'
const ts = () => new Date().toISOString()
const owner = { companyId: CO, userId: 'pu-owner', role: 'owner' }
const everyone = { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
let kekDir: string
let practice: Server
let practiceUrl: string
const atPractice: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = []
/** The real way out in these tests: records what would have left for the internet. */
const outbound: UpstreamRequest[] = []
const realWayOut: UpstreamClient = {
  async send(req) {
    outbound.push(req)
    return { ok: true, response: { status: 200, headers: [], body: (async function* () { yield new TextEncoder().encode('{}') })(), viaPrivateAddress: false } }
  },
}

const staging = () => ({ ACB_ALLOW_FAKE_UPSTREAMS: '1', NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:13001', ACB_FAKE_HUBSPOT_URL: practiceUrl })

async function servicesFor(env: Record<string, string | undefined>) {
  const { createServices } = await import('../../src/composition')
  return createServices(db, undefined, { upstream: realWayOut, keyCheck: true, practiceUpstreams: practiceUpstreamsFrom(env) })
}

/** Registers a HubSpot key (its check is the one request) and says where that request went. */
async function checkGoesTo(env: Record<string, string | undefined>): Promise<'practice' | 'real'> {
  const services = await servicesFor(env)
  const [p, o] = [atPractice.length, outbound.length]
  const r = await services.keyBroker.create(owner, { service: 'hubspot', displayName: `H-${randomBytes(3).toString('hex')}`, secret: FAKE_HUBSPOT, audience: everyone })
  expect(r).toMatchObject({ ok: true })
  const went = [atPractice.length - p, outbound.length - o]
  expect(went.reduce((a, b) => a + b)).toBe(1)
  return went[0] === 1 ? 'practice' : 'real'
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-pu-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  ;({ practiceUpstreamsFrom } = await import('../../src/lib/config'))
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'pu-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-pu-owner', 'pu-owner', CO, 'owner', ts(), ts())
  practice = createServer((req, res) => {
    atPractice.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    req.resume()
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"results":[]}') })
  })
  await new Promise<void>(r => practice.listen(0, '127.0.0.1', r))
  practiceUrl = `http://127.0.0.1:${(practice.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(r => practice.close(r))
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('the practice HubSpot (staging only)', () => {
  it('cannot switch on in production, without the staging marker, behind a public URL, or towards a host off this machine', async () => {
    const refused: Array<[string, Record<string, string | undefined>]> = [
      ['production', { ...staging(), NODE_ENV: 'production' }],
      ['production (any case)', { ...staging(), NODE_ENV: ' Production ' }],
      ['no marker', { ...staging(), ACB_ALLOW_FAKE_UPSTREAMS: undefined }],
      ['marker not 1', { ...staging(), ACB_ALLOW_FAKE_UPSTREAMS: 'true' }],
      ['public URL', { ...staging(), PUBLIC_URL: 'https://acb.example.com' }],
      ['target off this machine', { ...staging(), ACB_FAKE_HUBSPOT_URL: 'http://fake-hubspot.example.com:4010' }],
      ['target with a path', { ...staging(), ACB_FAKE_HUBSPOT_URL: `${practiceUrl}/crm` }],
      ['target with a user', { ...staging(), ACB_FAKE_HUBSPOT_URL: practiceUrl.replace('http://', 'http://u:p@') }],
    ]
    for (const [why, env] of refused) {
      expect([why, practiceUpstreamsFrom(env).state]).toEqual([why, 'ignored'])
      expect([why, await checkGoesTo(env)]).toEqual([why, 'real'])
    }
    expect(practiceUpstreamsFrom({ NODE_ENV: 'development' }).state).toBe('off')
  })

  it('on staging, HubSpot (check and relay) connects to the practice server, other services do not, and the admin view says so', async () => {
    expect(await checkGoesTo(staging())).toBe('practice')
    const seen = atPractice.at(-1)!
    expect([seen.method, seen.url, seen.headers.authorization]).toEqual(['GET', '/crm/objects/2026-03/deals', `Bearer ${FAKE_HUBSPOT}`])

    const services = await servicesFor(staging())
    const before = outbound.length
    expect((await services.keyBroker.create(owner, { service: 'openai', displayName: 'O', secret: FAKE_OPENAI, audience: everyone })).ok).toBe(true)
    expect(outbound.slice(before).map(r => r.host)).toEqual(['api.openai.com'])

    const view = services.keyBroker.get(owner)
    if (!view.ok) throw new Error('view refused')
    expect(view.value.services.filter(s => s.practice).map(s => s.service)).toEqual(['hubspot'])
    const real = (await servicesFor({ ...staging(), NODE_ENV: 'production' })).keyBroker.get(owner)
    if (!real.ok) throw new Error('view refused')
    expect(real.value.services.filter(s => s.practice)).toEqual([])

    const member = { companyId: CO, userId: 'pu-owner', role: 'owner' }
    const token = services.brokerTokens.issue(member, { conversationId: 'c-pu', services: ['hubspot'] }).value!.token as string
    const { Hono } = await import('hono')
    const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
    const app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))
    const res = await app.request('http://acb.test/api/broker/hubspot/crm/v3/objects/deals/search', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"limit":1}',
    })
    expect(res.status).toBe(200)
    expect(atPractice.at(-1)!.url).toBe('/crm/v3/objects/deals/search')
  })
})
