/**
 * Integration Test: the emergency stop (routes/agent-stops.ts) and the push
 * channel (`GET /me/events`) on the real routes and database.
 *
 * Guards: only owner/admin stop or release; each stop reaches exactly the
 * members it names (policy + ETag); history keeps who / when / why; a push
 * event carries only kind + version (no reason, no name); an announcement
 * never reaches another company; a member's connections are capped; the
 * heartbeat flows; a removed member's stream ends; the session never reaches
 * the log; apps that do not follow the stop are counted.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'st-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { agentStopsRoute, setPushTimingsForTests } from '../../src/routes/agent-stops'
import { agentSandboxRoute } from '../../src/routes/agent-sandbox'
import { services } from '../../src/composition'
import { parsePushEvent } from '../../shared/types/agent-stop'

const app = new Hono()
app.route('/api/companies/:companyId', agentSandboxRoute)
app.route('/api/companies/:companyId', agentStopsRoute)

const CO = 'st-co'
const OTHER = 'st-other'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'st-owner': 'owner', 'st-admin': 'admin', 'st-member': 'member', 'st-member2': 'member', 'st-cap': 'member', 'st-leaver': 'member' }
const ts = () => new Date().toISOString()
const SECRET_REASON = '経理/給与_極秘 フォルダを見たため'
const COOKIE_SECRET = 'better-auth.session_token=very-secret-session-value.sig'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json, headers: res.headers }
}

const policyOf = async (user: string, company = CO) => (await call(user, 'GET', `/api/companies/${company}/me/agent-policy`)).json.data

/** An open /me/events stream and everything it has sent so far. */
interface Stream { status: number; text: () => string; close: () => Promise<void>; ended: Promise<void> }
const open: Stream[] = []
async function events(user: string, company = CO, headers: Record<string, string> = {}): Promise<Stream> {
  currentUser.id = user
  const abort = new AbortController()
  const res = await app.request(`/api/companies/${company}/me/events`, { headers, signal: abort.signal })
  let received = ''
  let endedResolve!: () => void
  const ended = new Promise<void>(resolve => { endedResolve = resolve })
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += decoder.decode(value, { stream: true })
        }
      } catch { /* aborted */ }
      endedResolve()
    })()
  } else endedResolve()
  const stream: Stream = {
    status: res.status,
    text: () => received,
    close: async () => { abort.abort(); await res.body?.cancel().catch(() => {}) },
    ended,
  }
  open.push(stream)
  return stream
}
const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const dataLines = (text: string) => text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())

beforeAll(() => {
  initDatabase()
  for (const id of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'st-owner', ts(), ts())
  }
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-st-stranger', 'st-stranger', OTHER, 'owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
})

afterEach(async () => {
  for (const s of open.splice(0)) await s.close()
  setPushTimingsForTests()
})

afterAll(() => setPushTimingsForTests())

describe('the emergency stop', () => {
  it('only owners and admins list, stop or release; strangers learn nothing', async () => {
    expect((await call('st-stranger', 'GET', `${BASE}/agent-stops`)).status).toBe(404)
    expect((await call('st-member', 'GET', `${BASE}/agent-stops`)).status).toBe(403)
    expect((await call('st-member', 'POST', `${BASE}/agent-stops`, {})).status).toBe(403)
    const made = await call('st-admin', 'POST', `${BASE}/agent-stops`, { userId: 'st-member2', tool: 'web' })
    expect(made.status).toBe(200)
    const id = made.json.data.active[0].id
    expect((await call('st-member', 'DELETE', `${BASE}/agent-stops/${id}`)).status).toBe(403)
    expect((await call('st-stranger', 'DELETE', `${BASE}/agent-stops/${id}`)).status).toBe(404)
    expect((await call('st-owner', 'DELETE', `${BASE}/agent-stops/${id}`)).status).toBe(200)
    expect((await policyOf('st-member2')).stop).toEqual({ all: false, tools: [] })
  })

  it('a whole-company stop reaches every member; a release lifts it; the ETag moves with it', async () => {
    const before = await call('st-member', 'GET', `${BASE}/me/agent-policy`)
    expect(before.json.data.stop).toEqual({ all: false, tools: [] })
    const made = await call('st-owner', 'POST', `${BASE}/agent-stops`, { reason: '調査中' })
    const stop = made.json.data.active.find((s: Json) => s.userId === null && s.tool === null)
    expect(stop).toMatchObject({ reason: '調査中', stoppedBy: 'st-owner', stoppedByName: 'Name st-owner', releasedAt: null })
    for (const user of ['st-member', 'st-member2', 'st-admin', 'st-owner']) expect((await policyOf(user)).stop.all).toBe(true)
    // The app's cached version no longer matches: a full answer, not 304.
    const etag = before.headers.get('ETag')!
    expect((await call('st-member', 'GET', `${BASE}/me/agent-policy`, undefined, { 'If-None-Match': etag })).status).toBe(200)
    // The same scope again adds nothing.
    const again = await call('st-owner', 'POST', `${BASE}/agent-stops`, { reason: 'もう一度' })
    expect(again.json.data.active.filter((s: Json) => s.userId === null && s.tool === null)).toHaveLength(1)

    const released = await call('st-admin', 'DELETE', `${BASE}/agent-stops/${stop.id}`)
    expect(released.json.data.active.some((s: Json) => s.id === stop.id)).toBe(false)
    expect(released.json.data.history.find((s: Json) => s.id === stop.id)).toMatchObject({ reason: '調査中', releasedBy: 'st-admin', releasedByName: 'Name st-admin' })
    expect((await policyOf('st-member')).stop).toEqual({ all: false, tools: [] })
    expect((await call('st-member', 'GET', `${BASE}/me/agent-policy`, undefined, { 'If-None-Match': etag })).status).toBe(304)
  })

  it('a member stop and tool stops reach only the members they name', async () => {
    const a = await call('st-owner', 'POST', `${BASE}/agent-stops`, { userId: 'st-member' })
    const b = await call('st-owner', 'POST', `${BASE}/agent-stops`, { tool: 'command' })
    const c = await call('st-owner', 'POST', `${BASE}/agent-stops`, { userId: 'st-member2', tool: 'mcp-external' })
    expect((await policyOf('st-member')).stop).toEqual({ all: true, tools: ['command'] })
    expect((await policyOf('st-member2')).stop).toEqual({ all: false, tools: ['command', 'mcp-external'] })
    expect((await policyOf('st-admin')).stop).toEqual({ all: false, tools: ['command'] })
    expect((await policyOf('st-stranger', OTHER)).stop).toEqual({ all: false, tools: [] })
    for (const made of [a, b, c]) {
      const ids = made.json.data.active.map((s: Json) => s.id)
      for (const id of ids) await call('st-owner', 'DELETE', `${BASE}/agent-stops/${id}`)
    }
    expect((await policyOf('st-member2')).stop).toEqual({ all: false, tools: [] })
  })

  it('refuses an unknown tool kind, a non-member and an over-long reason', async () => {
    expect((await call('st-owner', 'POST', `${BASE}/agent-stops`, { tool: 'read' })).status).toBe(400)
    expect((await call('st-owner', 'POST', `${BASE}/agent-stops`, { userId: 'st-stranger' })).status).toBe(404)
    expect((await call('st-owner', 'POST', `${BASE}/agent-stops`, { reason: 'x'.repeat(501) })).status).toBe(400)
    expect((await call('st-owner', 'POST', `${BASE}/agent-stops`, 'nope')).status).toBe(400)
    expect((await call('st-owner', 'DELETE', `${BASE}/agent-stops/unknown`)).status).toBe(404)
  })

  it('counts the members whose app does not follow the stop', async () => {
    db.prepare('INSERT OR REPLACE INTO client_activity (user_id, company_id, client_version, updated_at) VALUES (?, ?, ?, ?)').run('st-member', CO, '0.0.1+old.20261020000000', ts())
    db.prepare('INSERT OR REPLACE INTO client_activity (user_id, company_id, client_version, updated_at) VALUES (?, ?, ?, ?)').run('st-member2', CO, '0.0.1+new.20261101000000', ts())
    const listed = async () => (await call('st-owner', 'GET', `${BASE}/agent-stops`)).json.data.unsupported.map((m: Json) => m.userId).sort()
    expect(await listed()).toEqual(['st-member', 'st-member2'])
    // The new app says so on its policy fetch, with the build it reports everywhere.
    await call('st-member2', 'GET', `${BASE}/me/agent-policy`, undefined, { 'X-ACB-Agent-Stop': '1', 'X-ACB-Client-Version': '0.0.1+new.20261101000000' })
    expect(await listed()).toEqual(['st-member'])
    // Back on an old build: counted again.
    db.prepare('UPDATE client_activity SET client_version = ? WHERE user_id = ? AND company_id = ?').run('0.0.1+old.20261020000000', 'st-member2', CO)
    expect(await listed()).toEqual(['st-member', 'st-member2'])
  })
})

describe('the push channel (GET /me/events)', () => {
  it('sends only kind + version, never the reason or a name, and announces each stop', async () => {
    const stream = await events('st-member')
    expect(stream.status).toBe(200)
    await until(() => dataLines(stream.text()).length >= 1)
    const made = await call('st-owner', 'POST', `${BASE}/agent-stops`, { userId: 'st-member', reason: SECRET_REASON })
    await until(() => dataLines(stream.text()).length >= 2)
    const version = (await policyOf('st-member')).version
    const lines = dataLines(stream.text())
    for (const line of lines) expect(parsePushEvent(line)).not.toBeNull()
    expect(parsePushEvent(lines[lines.length - 1])).toEqual({ kind: 'policy', version })
    expect(stream.text()).not.toContain('給与')
    expect(stream.text()).not.toContain('st-member')
    await call('st-owner', 'DELETE', `${BASE}/agent-stops/${made.json.data.active[0].id}`)
    await until(() => dataLines(stream.text()).length >= 3)
  })

  it('an announcement for one company never reaches another company\'s member', async () => {
    const other = await events('st-stranger', OTHER)
    const mine = await events('st-member2')
    await until(() => dataLines(other.text()).length >= 1 && dataLines(mine.text()).length >= 1)
    const made = await call('st-owner', 'POST', `${BASE}/agent-stops`, {})
    await until(() => dataLines(mine.text()).length >= 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(dataLines(other.text())).toHaveLength(1)
    await call('st-owner', 'DELETE', `${BASE}/agent-stops/${made.json.data.active[0].id}`)
  })

  it('a sandbox change is announced too', async () => {
    const stream = await events('st-member')
    await until(() => dataLines(stream.text()).length >= 1)
    const view = (await call('st-owner', 'GET', `${BASE}/agent-sandbox`)).json.data
    await call('st-owner', 'PUT', `${BASE}/agent-sandbox`, { ...view.settings, mode: 'observe' })
    await until(() => dataLines(stream.text()).length >= 2)
    await call('st-owner', 'PUT', `${BASE}/agent-sandbox`, view.settings)
  })

  it('caps one member\'s open connections and frees a slot when one closes', async () => {
    const streams = [await events('st-cap'), await events('st-cap'), await events('st-cap')]
    expect(streams.map(s => s.status)).toEqual([200, 200, 200])
    const refused = await events('st-cap')
    expect(refused.status).toBe(429)
    // Another member is not affected.
    expect((await events('st-member2')).status).toBe(200)
    await streams[0].close()
    await until(() => services.push.count() < 4)
    expect((await events('st-cap')).status).toBe(200)
  })

  it('sends heartbeats, ends a removed member\'s stream, and ends after its lifetime', async () => {
    setPushTimingsForTests({ heartbeatMs: 20, lifetimeMs: 60_000 })
    const stream = await events('st-leaver')
    await until(() => stream.text().includes(':\n\n'))
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND company_id = ?').run('st-leaver', CO)
    await stream.ended
    setPushTimingsForTests({ heartbeatMs: 60_000, lifetimeMs: 30 })
    const short = await events('st-member')
    await short.ended
    expect(dataLines(short.text())).toHaveLength(1)
  })

  it('never writes the session to the log', async () => {
    const lines: string[] = []
    const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) }))
    try {
      const streams = [await events('st-cap', CO, { Cookie: COOKIE_SECRET, 'X-ACB-Agent-Stop': '1' })]
      for (let i = 0; i < 4; i++) streams.push(await events('st-cap', CO, { Cookie: COOKIE_SECRET }))
      const made = await call('st-owner', 'POST', `${BASE}/agent-stops`, { userId: 'st-cap' }, { Cookie: COOKIE_SECRET })
      await call('st-owner', 'DELETE', `${BASE}/agent-stops/${made.json.data.active[0].id}`, undefined, { Cookie: COOKIE_SECRET })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain('very-secret-session-value')
  })
})
