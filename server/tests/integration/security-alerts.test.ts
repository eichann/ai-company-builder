/**
 * Integration Test: 「気になる動き」 on the real app (app.ts) — wrong passwords sent to Better
 * Auth's sign-in become an alert owners / admins read at GET …/security-alerts and on the home;
 * members get 403; the setting takes only a boolean. Fails when the sign-in hook in app.ts or
 * the route is removed. Rules themselves: tests/unit/security-alerts.test.ts.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

const state = vi.hoisted(() => ({ signInStatus: 401 }))

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join } = await import('path')
  return {
    authDb: new Database(join(process.env.DATA_DIR!, 'auth.sqlite')),
    getUserFromRequest: vi.fn().mockImplementation(async (req: Request) => {
      const id = req.headers.get('x-test-user')
      return id ? { id, email: `${id}@example.com`, name: id, image: null, emailVerified: true } : null
    }),
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }]))),
    auth: {
      handler: vi.fn().mockImplementation(async () => new Response('{}', { status: state.signInStatus })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const CO = 'sa-co'
const BASE = `/api/companies/${CO}`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any

beforeAll(async () => {
  const { initDatabase, db } = await import('../../src/db')
  initDatabase()
  const ts = new Date(Date.now() - 30 * 86_400_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'sa-owner', ts, ts)
  for (const [u, r] of [['sa-owner', 'owner'], ['sa-alice', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts, ts)
  }
  const Database = (await import('better-sqlite3')).default
  const { join } = await import('path')
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run('sa-alice', 'alice@sa.example', 'Alice')
  authDb.close()
  app = (await import('../../src/app')).app
})

const call = (user: string | null, method: string, path: string, body?: unknown) => app.request(`http://acb.test${path}`, {
  method,
  headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}) as Promise<Response>

const signIn = (email: string) => call(null, 'POST', '/api/auth/sign-in/email', { email, password: 'wrong-password' })

describe('「気になる動き」', () => {
  it('10 wrong passwords for a member\'s account show on the list and the home, to the owner only', async () => {
    state.signInStatus = 401
    for (let i = 0; i < 10; i++) expect((await signIn('alice@sa.example')).status).toBe(401)
    const res = await call('sa-owner', 'GET', `${BASE}/security-alerts`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.items).toHaveLength(1)
    expect(json.data.items[0]).toMatchObject({ kind: 'sign_in_failures', userId: 'sa-alice', name: 'Name sa-alice' })
    expect(json.data.items[0].title).toContain('パスワードの間違い')
    expect(JSON.stringify(json)).not.toContain('wrong-password')
    expect(json.data.settings).toEqual({ slackDm: false, updatedAt: null })

    const home = await (await call('sa-owner', 'GET', `${BASE}/home`)).json()
    expect(home.data.attention.securityAlerts.map((a: { kind: string }) => a.kind)).toEqual(['sign_in_failures'])

    expect((await call('sa-alice', 'GET', `${BASE}/security-alerts`)).status).toBe(403)
    expect((await call(null, 'GET', `${BASE}/security-alerts`)).status).toBe(401)
  })

  it('the setting: owner / admin only, a boolean only', async () => {
    expect((await call('sa-alice', 'PUT', `${BASE}/security-alerts/settings`, { slackDm: true })).status).toBe(403)
    expect((await call('sa-owner', 'PUT', `${BASE}/security-alerts/settings`, { slackDm: 'yes' })).status).toBe(400)
    const res = await call('sa-owner', 'PUT', `${BASE}/security-alerts/settings`, { slackDm: true })
    expect(res.status).toBe(200)
    expect((await res.json()).data.slackDm).toBe(true)
  })
})
