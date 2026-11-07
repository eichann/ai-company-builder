/**
 * Integration Test: the company's task settings (routes/task-settings.ts) and
 * department membership (GET|PUT /departments/:id/members) on the real routes
 * and database — every member reads, only owners and admins change the
 * settings, a department manager changes membership of their own department
 * only, nothing reaches another company, and a member who leaves belongs to
 * no department any more.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'ts-owner' as string | null }))

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
import { taskSettingsRoute } from '../../src/routes/task-settings'
import { departmentsRoute } from '../../src/routes/departments'
import { companiesRoute } from '../../src/routes/companies'
import { defaultTaskSettings } from '../../shared/core/task-settings'

const app = new Hono()
app.route('/api/companies/:companyId', taskSettingsRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies', companiesRoute)

const CO = 'ts-co'
const OTHER = 'ts-other'
const BASE = `/api/companies/${CO}`
const ROLE: Record<string, string> = { 'ts-owner': 'owner', 'ts-admin': 'admin', 'ts-member': 'member', 'ts-manager': 'member', 'ts-leaver': 'member' }
const SALES = 'ts-sales'
const HR = 'ts-hr'
const OTHER_DEPT = 'ts-other-sales'
const ts = () => new Date().toISOString()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
async function call(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const json: Json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function department(companyId: string, id: string, folder: string) {
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Folder', '#000000', 0, 1, ?, ?)`).run(id, companyId, folder, folder, ts(), ts())
}

const otherMembers = () => db.prepare('SELECT * FROM department_members WHERE company_id = ? ORDER BY user_id').all(OTHER)

beforeAll(() => {
  initDatabase()
  for (const co of [CO, OTHER]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'ts-owner', ts(), ts())
  }
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-ts-stranger', 'ts-stranger', OTHER, 'owner', ts(), ts())
  department(CO, SALES, '営業部')
  department(CO, HR, '人事部')
  department(OTHER, OTHER_DEPT, '営業部')
  db.prepare('INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, SALES, 'ts-manager', ts())
  db.prepare('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(OTHER, OTHER_DEPT, 'ts-stranger', ts())
})

const sameDay = { ...defaultTaskSettings(), reply: { rule: 'same-day', sameDayCutoff: '16:30' }, taskListDepartmentIds: [SALES] }

describe('task settings', () => {
  it('every member reads them (the defaults until changed); strangers learn nothing', async () => {
    expect((await call(null, 'GET', `${BASE}/task-settings`)).status).toBe(401)
    expect((await call('ts-stranger', 'GET', `${BASE}/task-settings`)).status).toBe(404)
    const r = await call('ts-member', 'GET', `${BASE}/task-settings`)
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ settings: defaultTaskSettings(), canEdit: false, updatedAt: null })
    expect((await call('ts-admin', 'GET', `${BASE}/task-settings`)).json.data.canEdit).toBe(true)
  })

  it('only owners and admins change them — not members, not department managers', async () => {
    expect((await call('ts-member', 'PUT', `${BASE}/task-settings`, sameDay)).status).toBe(403)
    expect((await call('ts-manager', 'PUT', `${BASE}/task-settings`, sameDay)).status).toBe(403)
    expect((await call('ts-member', 'GET', `${BASE}/task-settings`)).json.data.settings).toEqual(defaultTaskSettings())
    const r = await call('ts-admin', 'PUT', `${BASE}/task-settings`, sameDay)
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ settings: sameDay, updatedBy: 'ts-admin', updatedByName: 'Name ts-admin' })
    expect((await call('ts-member', 'GET', `${BASE}/task-settings`)).json.data.settings).toEqual(sameDay)
  })

  it('refuses an invalid document and keeps the saved one', async () => {
    for (const bad of [
      'not json',
      { ...sameDay, reply: { rule: 'same-day', sameDayCutoff: '25:00' } },
      { ...sameDay, autoRun: { enabled: true, dailyLimit: 0, stopAfterFailures: 3 } },
      { ...sameDay, companyHolidays: [{ date: '2026-02-30', name: '' }] },
    ]) {
      expect((await call('ts-owner', 'PUT', `${BASE}/task-settings`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await call('ts-owner', 'GET', `${BASE}/task-settings`)).json.data.settings).toEqual(sameDay)
  })

  it('another company’s department cannot be named for the task list (as if it did not exist)', async () => {
    const theirs = await call('ts-owner', 'PUT', `${BASE}/task-settings`, { ...sameDay, taskListDepartmentIds: [OTHER_DEPT] })
    const none = await call('ts-owner', 'PUT', `${BASE}/task-settings`, { ...sameDay, taskListDepartmentIds: ['ts-no-such'] })
    expect(theirs.status).toBe(400)
    expect(theirs.json).toEqual(none.json)
    expect((await call('ts-owner', 'GET', `${BASE}/task-settings`)).json.data.settings.taskListDepartmentIds).toEqual([SALES])
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_settings WHERE company_id = ?').get(OTHER)).toEqual({ n: 0 })
  })
})

describe('department membership (所属する部署)', () => {
  const members = (dept: string) => `${BASE}/departments/${dept}/members`

  it('every member sees who belongs; strangers learn nothing', async () => {
    expect((await call(null, 'GET', members(SALES))).status).toBe(401)
    expect((await call('ts-stranger', 'GET', members(SALES))).status).toBe(404)
    const r = await call('ts-member', 'GET', members(SALES))
    expect(r.status).toBe(200)
    expect(r.json.data).toEqual({ members: [], canEdit: false })
  })

  it('a manager changes their own department’s membership, not another department’s', async () => {
    expect((await call('ts-manager', 'GET', members(SALES))).json.data.canEdit).toBe(true)
    expect((await call('ts-manager', 'GET', members(HR))).json.data.canEdit).toBe(false)
    const r = await call('ts-manager', 'PUT', members(SALES), { userIds: ['ts-member', 'ts-manager'] })
    expect(r.status).toBe(200)
    expect(r.json.data.members.map((m: Json) => m.userId).sort()).toEqual(['ts-manager', 'ts-member'])
    expect((await call('ts-manager', 'PUT', members(HR), { userIds: ['ts-member'] })).status).toBe(403)
    expect((await call('ts-member', 'GET', members(HR))).json.data.members).toEqual([])
  })

  it('a plain member cannot change membership, not even their own', async () => {
    expect((await call('ts-member', 'PUT', members(HR), { userIds: ['ts-member'] })).status).toBe(403)
    expect((await call('ts-member', 'PUT', members(SALES), { userIds: [] })).status).toBe(403)
    expect((await call('ts-member', 'GET', members(SALES))).json.data.members).toHaveLength(2)
  })

  it('owners and admins change any department; only members of the company can belong', async () => {
    expect((await call('ts-admin', 'PUT', members(HR), { userIds: ['ts-leaver', 'ts-member'] })).status).toBe(200)
    const outsider = await call('ts-owner', 'PUT', members(HR), { userIds: ['ts-stranger'] })
    expect(outsider.status).toBe(400)
    expect((await call('ts-owner', 'PUT', members(HR), { userIds: 'ts-member' })).status).toBe(400)
    expect((await call('ts-owner', 'GET', members(HR))).json.data.members.map((m: Json) => m.userId).sort()).toEqual(['ts-leaver', 'ts-member'])
  })

  it('another company’s department is answered like one that does not exist, and its members stay', async () => {
    const before = otherMembers()
    for (const user of ['ts-owner', 'ts-manager']) {
      for (const [method, body] of [['GET', undefined], ['PUT', { userIds: ['ts-member'] }]] as const) {
        const theirs = await call(user, method, members(OTHER_DEPT), body)
        const none = await call(user, method, members('ts-no-such'), body)
        expect({ status: theirs.status, json: theirs.json }, `${user} ${method}`).toEqual({ status: none.status, json: none.json })
      }
    }
    expect((await call('ts-owner', 'GET', members(OTHER_DEPT))).status).toBe(404)
    expect(otherMembers()).toEqual(before)
  })

  it('a member who leaves the company belongs to no department of it any more', async () => {
    expect((await call('ts-owner', 'DELETE', `/api/companies/${CO}/members/ts-leaver`)).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS n FROM department_members WHERE company_id = ? AND user_id = ?').get(CO, 'ts-leaver')).toEqual({ n: 0 })
    expect((await call('ts-owner', 'GET', members(HR))).json.data.members.map((m: Json) => m.userId)).toEqual(['ts-member'])
  })

  it('a deleted department takes its membership with it', async () => {
    db.prepare('DELETE FROM departments WHERE id = ? AND company_id = ?').run(HR, CO)
    expect(db.prepare('SELECT COUNT(*) AS n FROM department_members WHERE department_id = ?').get(HR)).toEqual({ n: 0 })
  })

  it('a row can never name a department of another company (database trigger)', () => {
    expect(() => db.prepare('INSERT INTO department_members (company_id, department_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(CO, OTHER_DEPT, 'ts-member', ts())).toThrow(/must be the company of its department/)
  })
})

// 「使う機能」 (records.md "Features on and off"): who changes them on the real routes, and 受信を読む
// following the inbox feature without the company's own choice being changed.
describe('the company\'s features (使う機能)', () => {
  it('every member reads them (all on); only owners and admins change one; 受信を読む is off for everyone while the inbox is, and back after', async () => {
    const read = await call('ts-member', 'GET', `${BASE}/features`)
    expect(read.status).toBe(200)
    expect(read.json.data.features).toEqual({ taskList: true, meetings: true, inbox: true, decisions: true, projects: true })
    expect(read.json.data.canEdit).toBe(false)
    expect((await call('ts-member', 'PUT', `${BASE}/features`, { feature: 'inbox', on: false })).status).toBe(403)
    expect((await call('ts-manager', 'PUT', `${BASE}/features`, { feature: 'inbox', on: false })).status).toBe(403)
    expect((await call('ts-admin', 'PUT', `${BASE}/features`, { feature: 'inbox' })).status).toBe(400)
    expect((await call('ts-stranger', 'GET', `${BASE}/features`)).status).toBe(404)

    expect((await call('ts-member', 'GET', `${BASE}/me/work-switches`)).json.data.readIncoming.allowed).toBe(true)
    const off = await call('ts-admin', 'PUT', `${BASE}/features`, { feature: 'inbox', on: false })
    expect(off.status).toBe(200)
    expect(off.json.data.features.inbox).toBe(false)
    expect((await call('ts-member', 'GET', `${BASE}/me/work-switches`)).json.data.readIncoming.allowed).toBe(false)
    // The company's own choice is untouched; another company's inbox stays on.
    expect((await call('ts-member', 'GET', `${BASE}/task-settings`)).json.data.settings.readIncoming.allowed).toBe(true)
    expect((await call('ts-stranger', 'GET', `/api/companies/${OTHER}/features`)).json.data.features.inbox).toBe(true)

    await call('ts-owner', 'PUT', `${BASE}/features`, { feature: 'inbox', on: true })
    expect((await call('ts-member', 'GET', `${BASE}/me/work-switches`)).json.data.readIncoming.allowed).toBe(true)
  })
})
