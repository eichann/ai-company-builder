/**
 * Integration Test: a company-wide stop of the whole AI (the emergency stop,
 * M2; .claude/rules/agent-stop.md) also stops the key broker's relay —
 * server-side, so an old or modified app cannot get around it. The refusal is
 * plain Japanese, nothing is forwarded, it is recorded as `stopped`, and a
 * release restores the relay. A narrower stop (one member, one tool kind)
 * leaves the relay alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { UpstreamClient } from '../../src/ports/upstream'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

const FAKE = 'fake-test-key-NOT-REAL-brokerstop-0123456789'
const CO = 'bs-co'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let kekDir: string
let forwarded = 0
const owner = { companyId: CO, userId: 'bs-owner', role: 'owner' }
const member = { companyId: CO, userId: 'bs-member', role: 'member' }

const fakeUpstream: UpstreamClient = {
  async send(req) {
    forwarded++
    if (req.body) for await (const chunk of req.body) void chunk
    return { ok: true, response: { status: 200, headers: [['content-type', 'application/json']], body: (async function* () { yield new TextEncoder().encode('{}') })(), viaPrivateAddress: false } }
  },
}

async function call() {
  const token = services.brokerTokens.issue(member, { conversationId: 'conv-bs', services: ['gemini'], department: null }).value.token as string
  const res = await app.request('http://acb.test/api/broker/gemini/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [] }),
  })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json }
}
const lastEvent = () => db.prepare('SELECT * FROM agent_events WHERE company_id = ? ORDER BY seq DESC LIMIT 1').get(CO)

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-bs-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'bs-owner', ts(), ts())
  for (const [u, r] of [['bs-owner', 'owner'], ['bs-member', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { upstream: fakeUpstream })
  const { Hono } = await import('hono')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))
  await services.keyBroker.create(owner, {
    service: 'gemini', displayName: 'Gemini', secret: FAKE,
    destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: [] },
    audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
    caps: {},
  })
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('a company-wide stop stops the key broker too', () => {
  it('refuses every relay call in plain Japanese, records it as stopped, and a release restores it', async () => {
    expect((await call()).status).toBe(200)
    expect(forwarded).toBe(1)

    // Narrower stops leave the relay alone.
    const narrow = [
      services.agentStops.stop(owner, { userId: 'bs-member' }).value,
      services.agentStops.stop(owner, { tool: 'web' }).value,
    ]
    expect((await call()).status).toBe(200)
    expect(forwarded).toBe(2)
    for (const id of narrow[1].active.map((s: Json) => s.id)) services.agentStops.release(owner, id)

    const stopped = services.agentStops.stop(owner, { reason: '調査' }).value
    const refused = await call()
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe('ACB_STOPPED')
    expect(refused.json.error.message).toBe('管理者が AI の利用を一時停止しています。再開されるまで使えません。')
    expect(forwarded).toBe(2)
    expect(lastEvent()).toMatchObject({ decision: 'stopped', tool: 'broker:gemini', user_id: 'bs-member' })

    for (const s of stopped.active) services.agentStops.release(owner, s.id)
    expect((await call()).status).toBe(200)
    expect(forwarded).toBe(3)
  })
})
