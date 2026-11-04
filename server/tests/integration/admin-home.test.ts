/**
 * Integration Test: the admin console's home (routes/admin-home.ts, server.md "Admin home") on
 * the real routes and database — the six 「最初にやること」 judged from the company's own data,
 * 「会社の休みを確かめた」 kept once set, and a department manager seeing only the members of the
 * departments they manage, without any blocked sync's paths.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'ah-owner' as string | null }))

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
import { adminHomeRoute } from '../../src/routes/admin-home'

const app = new Hono()
app.route('/api/companies/:companyId', adminHomeRoute)

const CO = 'ah-co'
const OTHER = 'ah-other'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'ah-owner': 'owner', 'ah-admin': 'admin', 'ah-member': 'member', 'ah-manager': 'member', 'ah-hr': 'member' }
const SALES = 'ah-sales'
const HR = 'ah-hr-dept'
const ts = () => new Date().toISOString()
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function department(companyId: string, id: string, folder: string) {
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Folder', '#000000', 0, 1, ?, ?)`).run(id, companyId, folder, folder, ts(), ts())
}
function belongs(departmentId: string, companyId: string, userId: string) {
  db.prepare('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(companyId, departmentId, userId, ts())
}
function activity(userId: string, lastSeen: string, lastSync: string | null) {
  db.prepare(`INSERT INTO client_activity (user_id, company_id, client_version, client_platform, last_seen_at, last_fetch_at, last_push_at, updated_at)
    VALUES (?, ?, '1.0.0', 'darwin', ?, ?, NULL, ?)`).run(userId, CO, lastSeen, lastSync, ts())
}
const step = (json: Json, id: string) => (json.data.setup.steps as Json[]).find(s => s.id === id)

beforeAll(() => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'ah-owner', ts(), ts())
  }
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  department(CO, SALES, '営業部')
  department(CO, HR, '人事部')
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, SALES, 'ah-manager', ts())
  belongs(SALES, CO, 'ah-member')
  // Both stopped syncing a while ago, in different departments.
  activity('ah-member', daysAgo(1), daysAgo(10))
  activity('ah-hr', daysAgo(1), daysAgo(10))
  db.prepare("INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES ('ah-rej', ?, 'ah-member', '[WRITE_DENIED]', ?, ?)")
    .run(CO, JSON.stringify(['営業部/評価/秘密.xlsx']), ts())
})

describe('the admin home', () => {
  it('judges the steps from the company: departments, members, membership, Google, holidays (no minutes folder since 2026-11-04)', async () => {
    const r = await call('ah-owner', 'GET', `${BASE}/home`)
    expect(r.status).toBe(200)
    expect(r.json.data.view).toBe('admin')
    expect(r.json.data.setup.total).toBe(5)
    expect(step(r.json, 'departments').done).toBe(true)
    expect(step(r.json, 'members').done).toBe(true)
    // 人事部 has nobody yet; 人事部 has no 部署の管理役 (recommended only).
    expect(step(r.json, 'department-members')).toMatchObject({ done: false, departmentsWithoutMembers: 1, departmentsWithoutManager: 1 })
    expect(step(r.json, 'google')).toMatchObject({ done: false, byOperator: true })
    expect(r.json.data.setup.steps.map((s: { id: string }) => s.id)).not.toContain('minutes-folder')
    expect(step(r.json, 'holidays').done).toBe(false)

    belongs(HR, CO, 'ah-hr')
    const after = await call('ah-owner', 'GET', `${BASE}/home`)
    expect(step(after.json, 'department-members').done).toBe(true)
  })

  it('keeps 「会社の休みを確かめた」 once an owner or admin sets it; others cannot', async () => {
    expect((await call('ah-member', 'PUT', `${BASE}/home/holidays-checked`, { checked: true })).status).toBe(403)
    expect((await call('ah-manager', 'PUT', `${BASE}/home/holidays-checked`, { checked: true })).status).toBe(403)
    expect((await call('ah-admin', 'PUT', `${BASE}/home/holidays-checked`, {})).status).toBe(400)
    const r = await call('ah-admin', 'PUT', `${BASE}/home/holidays-checked`, { checked: true })
    expect(r.status).toBe(200)
    expect(step(r.json, 'holidays').done).toBe(true)
    expect(step((await call('ah-owner', 'GET', `${BASE}/home`)).json, 'holidays').done).toBe(true)
    // Another company's home is untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_setup_marks WHERE company_id = ?').get(OTHER)).toEqual({ n: 0 })
  })

  it('shows the whole company\'s attention to an owner, a manager only their departments\' members and no paths', async () => {
    const owner = await call('ah-owner', 'GET', `${BASE}/home`)
    expect(owner.json.data.attention.notSyncedRecently.map((m: Json) => m.userId).sort()).toEqual(['ah-hr', 'ah-member'])
    expect(owner.json.data.attention.recentRejections[0].paths).toEqual(['営業部/評価/秘密.xlsx'])

    const manager = await call('ah-manager', 'GET', `${BASE}/home`)
    expect(manager.status).toBe(200)
    expect(manager.json.data.view).toBe('manager')
    expect(manager.json.data.setup).toBeNull()
    expect(manager.json.data.departments).toEqual([{ id: SALES, name: '営業部' }])
    expect(manager.json.data.attention.notSyncedRecently.map((m: Json) => m.userId)).toEqual(['ah-member'])
    expect(manager.json.data.attention.recentRejections).toEqual([])
    expect(manager.json.data.attention.orphanedScopes).toEqual([])
    expect(JSON.stringify(manager.json)).not.toContain('評価')
  })

  it('refuses a member who manages nothing', async () => {
    expect((await call('ah-member', 'GET', `${BASE}/home`)).status).toBe(403)
  })
})
