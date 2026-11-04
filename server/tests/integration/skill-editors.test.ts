/**
 * Integration Test: 「Skill を直せる人」 — the list an owner/admin keeps, and
 * that it reaches the people it names: the snapshot's and the app's answer come
 * from it (the push checker itself: skill-files-hook.test.ts).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { services } from '../../src/composition'
import { permissionsRoute } from '../../src/routes/permissions'
import { skillEditorsRoute } from '../../src/routes/skill-editors'

const app = new Hono()
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', skillEditorsRoute)

const CO = 'co-skill'
const OTHER = 'co-other'
const base = `/api/companies/${CO}`
const now = new Date().toISOString()

function call(user: string, method: string, path: string, body?: unknown) {
  currentUser.id = user
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const put = (departmentId: string | null, userIds: string[]) => call('owner', 'PUT', `${base}/skill-editors`, { departmentId, userIds })
const editing = (user: string) => services.permissionViews.skillEditing(CO, user)

beforeAll(() => {
  initDatabase()
  for (const [id, slug] of [[CO, 'co-skill'], [OTHER, 'co-other']]) {
    db.prepare(`INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)`).run(id, id, slug, now, now)
  }
  const member = db.prepare(`INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
  for (const [u, role] of [['owner', 'owner'], ['ann', 'member'], ['ben', 'member'], ['gone', 'member']]) member.run(`m-${u}`, u, CO, role, now, now)
  const dept = db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'Folder', '#000000', 0, 1, ?, ?)`)
  dept.run('d-sales', CO, '営業部', '営業部', now, now)
  dept.run('d-other', OTHER, 'よそ', 'よそ', now, now)
})

describe('「Skill を直せる人」', () => {
  it('a name on a list reaches the snapshot and the app: everywhere, or by department folder', async () => {
    expect(editing('ann')).toEqual({ everywhere: false, folders: [] })
    expect((await put(null, ['ann'])).status).toBe(200)
    expect((await put('d-sales', ['ben'])).status).toBe(200)
    expect(editing('ann')).toEqual({ everywhere: true, folders: [] })
    expect(editing('ben')).toEqual({ everywhere: false, folders: ['営業部'] })

    const caps = await (await call('ben', 'GET', `${base}/me/capabilities`)).json() as { data: { skillEditing: unknown } }
    expect(caps.data.skillEditing).toEqual({ everywhere: false, folders: ['営業部'] })
  })

  it('the answer is the lists; replacing one leaves the other', async () => {
    await put(null, ['ann'])
    await put('d-sales', ['ben', 'ann'])
    await put('d-sales', ['ben'])
    const body = await (await call('owner', 'GET', `${base}/skill-editors`)).json() as { data: { company: Array<{ userId: string }>; departments: Array<{ departmentId: string; editors: Array<{ userId: string }> }> } }
    expect(body.data.company.map(e => e.userId)).toEqual(['ann'])
    expect(body.data.departments.map(d => [d.departmentId, d.editors.map(e => e.userId)])).toEqual([['d-sales', ['ben']]])
  })

  it('refuses someone outside the company, and another company\'s department like one that does not exist', async () => {
    expect((await put(null, ['stranger'])).status).toBe(400)
    const foreign = await put('d-other', ['ann'])
    const missing = await put('d-nowhere', ['ann'])
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual(await missing.json())
    expect(db.prepare(`SELECT COUNT(*) AS n FROM skill_editors WHERE department_id = 'd-other'`).get()).toEqual({ n: 0 })
  })

  it('someone who leaves the company is on no list; coming back starts from nothing', async () => {
    await put(null, ['gone'])
    await put('d-sales', ['gone'])
    const owner = { userId: 'owner', companyId: CO, role: 'owner' as const }
    expect(services.companies.removeMember(owner, 'gone').ok).toBe(true)
    expect(editing('gone')).toEqual({ everywhere: false, folders: [] })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM skill_editors WHERE user_id = 'gone'`).get()).toEqual({ n: 0 })
  })

  it('a department that goes takes its list with it', async () => {
    db.prepare(`INSERT INTO departments (id, company_id, name, folder, icon, color, sort_order, is_active, created_at, updated_at) VALUES ('d-gone', ?, '消える', '消える', 'Folder', '#000000', 0, 1, ?, ?)`).run(CO, now, now)
    await put('d-gone', ['ann'])
    db.prepare(`DELETE FROM departments WHERE id = 'd-gone'`).run()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM skill_editors WHERE department_id = 'd-gone'`).get()).toEqual({ n: 0 })
  })

  it('the database itself refuses a row for another company\'s department', () => {
    expect(() => db.prepare(`INSERT INTO skill_editors (company_id, department_id, user_id, created_at) VALUES (?, 'd-other', 'ann', ?)`).run(CO, now)).toThrow(/skill_editors\.company_id/)
  })

  it('「全員が直せる」: off by default; on, every member is as if named for the company; off again, the lists count as before', async () => {
    await put(null, [])
    await put('d-sales', ['ben'])
    const everyone = (value: unknown, user = 'owner') => call(user, 'PUT', `${base}/skill-editors/everyone`, { everyone: value })
    const answer = async () => (await (await call('owner', 'GET', `${base}/skill-editors`)).json() as { data: { everyone: boolean } }).data.everyone
    expect(await answer()).toBe(false)
    expect(editing('ann')).toEqual({ everywhere: false, folders: [] })

    expect((await everyone(true, 'ann')).status).toBe(403)
    expect(editing('ann')).toEqual({ everywhere: false, folders: [] })

    expect((await everyone(true)).status).toBe(200)
    expect(await answer()).toBe(true)
    expect(editing('ann')).toEqual({ everywhere: true, folders: [] })
    expect(services.permissionViews.skillEditing(OTHER, 'someone')).toEqual({ everywhere: false, folders: [] })

    expect((await everyone(false)).status).toBe(200)
    expect(editing('ann')).toEqual({ everywhere: false, folders: [] })
    expect(editing('ben')).toEqual({ everywhere: false, folders: ['営業部'] })
  })
})
