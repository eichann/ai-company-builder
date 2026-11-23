/**
 * Integration Test: 全社 is a choice (records.md "全社 is a choice", owner decision 2026-11-23) — the
 * transition gate through the real routes and the composition's `placeRequired`.
 *
 * Guards (each mutation-checked):
 * - while no released app names 全社 explicitly (the cutoff unset), a person's create with nothing given
 *   is read as the whole company, as released apps mean it — whoever is active;
 * - with the cutoff set, the same create stays accepted while an active member's app is older (or of an
 *   unknown build), and is refused (400 `PLACE_REQUIRED`, nothing written, no place named) once every
 *   active member's app is at or after it; an inactive member does not hold it back;
 * - `place: 'company'` is the whole company in every case; the AI of a released app on its 全社 tab (no
 *   screen said) follows the same gate.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'pg-owner' as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@pg.example`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@pg.example`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { services } from '../../src/composition'
import { setExplicitPlaceClientCutoffForTests } from '../../src/lib/client-version'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

let co: string
const CUTOFF = '20261123000000'
const OLD = '0.0.1+abc1234.20261120000000'
const NEW = '0.0.1+def5678.20261124000000'

async function call(user: string | null, method: string, path: string, body?: unknown, token?: string) {
  currentUser.id = user
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const person = (user: string, method: string, path: string, body?: unknown) => call(user, method, `/api/companies/${co}${path}`, body)
const ai = (token: string, method: string, path: string, body?: unknown) => call(null, method, `/api/records-ai${path}`, body, token)

/** The member's app was last heard from now, on this build. */
function using(user: string, version: string) {
  services.clientActivity.resetThrottleForTests()
  services.clientActivity.record({ userId: user, companyId: co, kind: 'seen', version, platform: null })
}

const countTasks = () => (db.prepare("SELECT COUNT(*) AS n FROM records WHERE company_id = ? AND type = 'task'").get(co) as { n: number }).n

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'pg-owner'
  const created = await call('pg-owner', 'POST', '/api/companies', { name: 'Place Gate Co', folderKind: 'none' })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  co = created.body.data.id
  const now = new Date().toISOString()
  for (const u of ['pg-alice', 'pg-bob']) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${u}`, u, co, 'member', now, now)
  }
})

afterAll(() => setExplicitPlaceClientCutoffForTests(undefined))

const nothing = { type: 'task', title: '全員で棚卸し', fields: { assignee: 'pg-bob' } }

describe('a person’s create with nothing given', () => {
  it('no released app says 全社 yet (cutoff unset): the whole company, whoever is active', async () => {
    setExplicitPlaceClientCutoffForTests(null)
    // Nobody heard from yet (no active member to hold anything back), then everyone on a new build.
    expect((await person('pg-alice', 'POST', '/records/item', nothing)).status).toBe(201)
    using('pg-alice', NEW)
    using('pg-bob', NEW)
    using('pg-owner', NEW)
    const r = await person('pg-alice', 'POST', '/records/item', nothing)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.placed).toEqual({ personal: false, folder: null })
    expect((await person('pg-bob', 'GET', `/records/item/${r.body.data.record.id}`)).status).toBe(200)
  })

  it('with the cutoff set: accepted while one active member’s app is older or unknown, refused once all are newer', async () => {
    setExplicitPlaceClientCutoffForTests(CUTOFF)
    using('pg-alice', NEW)
    using('pg-owner', NEW)
    using('pg-bob', OLD)
    expect((await person('pg-alice', 'POST', '/records/item', nothing)).status).toBe(201)
    using('pg-bob', 'not-a-build')
    expect((await person('pg-alice', 'POST', '/records/item', nothing)).status).toBe(201)
    using('pg-bob', NEW)
    const before = countTasks()
    const refused = await person('pg-alice', 'POST', '/records/item', { ...nothing, title: '秘密の題' })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ code: 'PLACE_REQUIRED' })
    expect(JSON.stringify(refused.body)).not.toContain('秘密の題')
    expect(countTasks()).toBe(before)
    // 全社 said on purpose is the whole company.
    const said = await person('pg-alice', 'POST', '/records/item', { ...nothing, place: 'company' })
    expect(said.status, JSON.stringify(said.body)).toBe(201)
    expect(said.body.data.placed).toEqual({ personal: false, folder: null })
  })

  it('a member not heard from within the window does not hold the gate', async () => {
    setExplicitPlaceClientCutoffForTests(CUTOFF)
    using('pg-alice', NEW)
    using('pg-owner', NEW)
    using('pg-bob', NEW)
    const long = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE client_activity SET client_version = ?, last_seen_at = ?, last_fetch_at = NULL, last_push_at = NULL WHERE company_id = ? AND user_id = ?').run(OLD, long, co, 'pg-bob')
    expect((await person('pg-alice', 'POST', '/records/item', nothing)).status).toBe(400)
  })
})

describe('the AI of a released app on its 全社 tab (no screen said)', () => {
  it('someone else named: the whole company until the gate, then refused; 全社 said still works', async () => {
    setExplicitPlaceClientCutoffForTests(null)
    const token = (await person('pg-alice', 'POST', '/me/record-tokens', { conversationId: 'conv-pg', agent: 'claude-code', scope: 'act' })).body.data.token
    const open = await ai(token, 'POST', '/item', nothing)
    expect(open.status, JSON.stringify(open.body)).toBe(201)
    expect(open.body.data.placed).toEqual({ personal: false, folder: null })
    setExplicitPlaceClientCutoffForTests(CUTOFF)
    using('pg-alice', NEW)
    using('pg-owner', NEW)
    using('pg-bob', NEW)
    const shut = await ai(token, 'POST', '/item', nothing)
    expect(shut.status).toBe(400)
    expect(shut.body).toMatchObject({ code: 'PLACE_REQUIRED' })
    expect((await ai(token, 'POST', '/item', { ...nothing, defaultPlace: 'company' })).status).toBe(201)
  })
})
