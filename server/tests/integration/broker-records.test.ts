/**
 * Integration Test: the key broker's record, stop and caps (K5) on the real
 * relay, tokens and AI action log, with a fake upstream.
 *
 * - Every relayed call becomes one agent_events row (category 'broker', tool
 *   broker:<service>, the person and the consultation's department, host /
 *   path / model / status / sizes / tokens) — never a body, a key or a token.
 * - Refusals are recorded with who decided (no key, destination, stopped,
 *   over the cap); an app cannot send such a record itself.
 * - The emergency stop's 「鍵」 unit acts on the next call (server-side).
 * - Daily caps (per member, total, tokens) are enforced, with the plain-Japanese answer.
 * - Token counts are read from streamed answers, also when a field is split across chunks.
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

const FAKE = 'fake-test-key-NOT-REAL-records-0123456789'
const CO = 'rc-co'
const ts = () => new Date().toISOString()
const SECRET_PROMPT = 'TOP-SECRET-PROMPT-TEXT'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any, db: any, services: any
let kekDir: string
let keyId: string
const owner = { companyId: CO, userId: 'rc-owner', role: 'owner' }
const member = { companyId: CO, userId: 'rc-member', role: 'member' }
let answerChunks: string[] = []

const fakeUpstream: UpstreamClient = {
  async send(req) {
    if (req.body) for await (const chunk of req.body) void chunk
    return {
      ok: true,
      response: {
        status: 200,
        headers: [['content-type', 'text/event-stream']],
        body: (async function* () { for (const c of answerChunks) yield new TextEncoder().encode(c) })(),
        viaPrivateAddress: false,
      },
    }
  },
}

const tokenFor = (department: string | null = '営業部') =>
  services.brokerTokens.issue(member, { conversationId: 'conv-rec', services: ['gemini'], department }).value.token as string

async function call(token: string, model = 'gemini-2.5-flash') {
  const res = await app.request(`http://acb.test/api/broker/gemini/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': token, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: SECRET_PROMPT }] }] }),
  })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { /* stream */ }
  return { status: res.status, json, text }
}

const lastEvent = () => {
  const row = db.prepare("SELECT * FROM agent_events WHERE company_id = ? ORDER BY seq DESC LIMIT 1").get(CO)
  return { ...row, target: JSON.parse(row.target) }
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-rc-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'rc-owner', ts(), ts())
  for (const [u, r] of [['rc-owner', 'owner'], ['rc-member', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('rc-d-sales', CO, '営業部', '営業部', ts(), ts())
  const { createServices } = await import('../../src/composition')
  services = createServices(db, undefined, { upstream: fakeUpstream })
  const { Hono } = await import('hono')
  const { brokerRelayRoutes } = await import('../../src/routes/broker-relay')
  app = new Hono().route('/api/broker', brokerRelayRoutes(services.brokerRelay))
  const created = await services.keyBroker.create(owner, {
    service: 'gemini', displayName: '営業 Gemini', secret: FAKE,
    destinations: { hosts: ['generativelanguage.googleapis.com'], pathPrefixes: [], models: ['gemini-2.5-flash'] },
    audience: { allDepartments: false, departmentIds: ['rc-d-sales'], everyone: true, addUserIds: [], removeUserIds: [] },
    caps: { requestsPerMemberPerDay: 3 },
  })
  keyId = created.value.keys[0].id
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('relay records, stop and caps', () => {
  it('one record per call: who, department, host, path, model, status, sizes, tokens — no body, key or token', async () => {
    // A streamed answer whose usage field is split across chunks.
    answerChunks = ['data: {"candidates":[],"usageMetadata":{"promptTok', 'enCount": 12, "candidatesTokenCount": 30', ', "thoughtsTokenCount": 5}}\n\n']
    const token = tokenFor()
    const r = await call(token)
    expect(r.status).toBe(200)
    const e = lastEvent()
    expect(e).toMatchObject({
      user_id: 'rc-member', agent: 'script', tool: 'broker:gemini', category: 'broker', decision: 'auto-allowed', outcome: 'ok',
      conversation_id: 'conv-rec', department: '営業部', model: 'gemini-2.5-flash',
    })
    expect(e.target).toMatchObject({
      kind: 'broker', service: 'gemini', host: 'generativelanguage.googleapis.com', path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      model: 'gemini-2.5-flash', status: 200, tokensIn: 12, tokensOut: 35, source: 'company', bytesOut: answerChunks.join('').length,
    })
    expect(e.target.bytesIn).toBeGreaterThan(10)
    const row = JSON.stringify(db.prepare('SELECT * FROM agent_events WHERE company_id = ?').all(CO))
    for (const secret of [SECRET_PROMPT, FAKE, token, 'alt=sse']) expect(row).not.toContain(secret)
    // The admin reads it through the log like any event, and sees today's use on the key.
    const page = services.agentEvents.list(owner, {})
    expect(page.value.events[0]).toMatchObject({ category: 'broker', agent: 'script', target: { kind: 'broker', tokensOut: 35 } })
    expect(services.keyBroker.get(owner).value.keys[0].usageToday).toEqual({ requests: 1, tokens: 47 })
  })

  it('refusals are recorded with who decided', async () => {
    answerChunks = ['{}']
    const token = tokenFor()
    expect((await call(token, 'gemini-2.5-pro')).status).toBe(403)
    expect(lastEvent()).toMatchObject({ decision: 'guard-denied', guard_reason: 'destination-not-allowed', outcome: 'error' })
    // A consultation outside 営業部: no key for this work.
    const elsewhere = services.brokerTokens.issue(owner, { conversationId: 'c-out', services: ['gemini'], department: '営業部' }).value.token
    db.prepare('UPDATE broker_tokens SET department = ? WHERE company_id = ? AND user_id = ?').run('開発', CO, 'rc-owner')
    expect((await call(elsewhere)).json.error.code).toBe('ACB_NO_KEY')
    expect(lastEvent()).toMatchObject({ user_id: 'rc-owner', decision: 'guard-denied', guard_reason: 'key-not-available', department: '開発' })
  })

  it('the emergency stop (every key) acts on the next call; resuming a key brings it back', async () => {
    const token = tokenFor()
    expect(services.keyBroker.stopAll(member)).toMatchObject({ ok: false, kind: 'forbidden' })
    const stopped = services.keyBroker.stopAll(owner)
    expect(stopped.value.keys.every((k: Json) => k.status === 'disabled')).toBe(true)
    const r = await call(token)
    expect([r.status, r.json.error.code]).toEqual([403, 'ACB_STOPPED'])
    expect(r.json.error.message).toContain('管理者が Google Gemini の鍵を止めています')
    expect(lastEvent()).toMatchObject({ decision: 'stopped', user_id: 'rc-member' })
    services.keyBroker.update(owner, keyId, { status: 'active' })
    answerChunks = ['{}']
    expect((await call(token)).status).toBe(200)
  })

  it('daily caps: the member\'s calls stop at the cap, with the plain-Japanese answer and a record', async () => {
    answerChunks = ['{}']
    const token = tokenFor()
    // Calls so far that reached the provider: 1 (first test) + 1 (after resuming) → one more is allowed.
    expect((await call(token)).status).toBe(200)
    const over = await call(token)
    expect([over.status, over.json.error.code]).toEqual([429, 'ACB_OVER_CAP'])
    expect(over.json.error.message).toContain('今日の上限に達しました')
    expect(lastEvent()).toMatchObject({ decision: 'guard-denied', guard_reason: 'over-cap' })
    // The owner is not this member: the per-member cap still lets them through (in 営業部).
    const ownerToken = services.brokerTokens.issue(owner, { conversationId: 'c-o', services: ['gemini'], department: '営業部' }).value.token
    expect((await call(ownerToken)).status).toBe(200)
    // A total token cap already used up stops everyone.
    services.keyBroker.update(owner, keyId, { caps: { requestsPerMemberPerDay: null, tokensPerDay: 40 } })
    expect((await call(ownerToken)).json.error.code).toBe('ACB_OVER_CAP')
  })

  it('an app cannot send a relay record of its own', async () => {
    const { parseAgentToolEvent } = await import('../../shared/types/agent-events')
    const base = { version: 1, id: 'x1', callId: 'c', at: ts(), agent: 'claude-code', tool: 'broker:gemini', decision: 'auto-allowed' }
    expect(parseAgentToolEvent({ ...base, category: 'broker', target: { kind: 'none' } })).toBeNull()
    expect(parseAgentToolEvent({ ...base, category: 'web', target: { kind: 'broker', service: 'gemini' } })).toBeNull()
    expect(parseAgentToolEvent({ ...base, agent: 'script', category: 'web', target: { kind: 'none' } })).toBeNull()
    expect(parseAgentToolEvent({ ...base, category: 'web', target: { kind: 'web', host: 'example.com' } })).not.toBeNull()
  })
})
