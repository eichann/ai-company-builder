/**
 * Integration Test: GET /api/companies/:companyId/me/write-access — the
 * caller's write access as data the desktop app evaluates per path (its AI
 * write guard and the 閲覧のみ badges).
 *
 * Member / department manager / owner / admin, nested scopes (a writable
 * folder inside a read-only department and a read-only folder inside that),
 * the ETag / If-None-Match round trip, and the version changing when a rule
 * changes.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'wa-owner' as string | null }))

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
import { permissionsRoute } from '../../src/routes/permissions'
import { replaceDepartmentManagers } from '../../src/adapters/sqlite/permission-store'

const app = new Hono()
app.route('/api/companies/:companyId', permissionsRoute)

const CO = 'wa-co'
const URL = `/api/companies/${CO}/me/write-access`
const ROLE: Record<string, string> = { 'wa-owner': 'owner', 'wa-admin': 'admin', 'wa-manager': 'member', 'wa-member': 'member', 'wa-writer': 'member' }

const ts = () => new Date().toISOString()
let seq = 0
function addRule(scopeId: string, subjectType: string, subjectId: string | null, canWrite: boolean) {
  db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(`wa-r${++seq}`, scopeId, subjectType, subjectId, canWrite ? 1 : 0, ts())
}
function addScope(id: string, path: string) {
  db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, ?, 'folder', ?)`).run(id, CO, path, ts())
}
function scopeIdOf(path: string): string {
  return (db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ?`).get(CO, path) as { id: string }).id
}

async function get(userId: string | null, headers: Record<string, string> = {}) {
  currentUser.id = userId
  const res = await app.request(URL, { headers })
  const body = res.status === 304 ? null : await res.json() as { success?: boolean; error?: string; data?: { version: string; role: string; all: boolean; scopes: Array<{ path: string; write: boolean }> } }
  return { status: res.status, etag: res.headers.get('ETag'), body }
}

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'wa-owner', ts(), ts())
  for (const [u, r] of Object.entries(ROLE)) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts(), ts())
  }
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('wa-d-sales', CO, '営業部', '営業部', 0, ts(), ts())
  initDatabase() // seed the company + department scopes
  replaceDepartmentManagers(db, CO, 'wa-d-sales', ['wa-manager'], 'wa-owner')
})

beforeEach(() => { currentUser.id = 'wa-owner' })

describe('GET /me/write-access', () => {
  it('requires a session and membership', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await get('wa-stranger')).status).toBe(404)
  })

  it('with the seeded everyone-rw rule a member may write everywhere', async () => {
    const r = await get('wa-member')
    expect(r.status).toBe(200)
    expect(r.body?.data).toMatchObject({ role: 'member', all: true, scopes: [] })
  })

  it('nested scopes: read-only department, writable folder inside, read-only folder inside that', async () => {
    const sales = scopeIdOf('営業部')
    addRule(sales, 'everyone', null, false)
    addRule(sales, 'user', 'wa-writer', true)
    addScope('wa-s-drafts', '営業部/下書き')
    addRule('wa-s-drafts', 'everyone', null, true)
    addScope('wa-s-final', '営業部/下書き/確定')
    addRule('wa-s-final', 'everyone', null, false)
    addScope('wa-s-empty', '営業部/空') // no rules: transparent, not listed

    const member = await get('wa-member')
    expect(member.body?.data).toMatchObject({
      role: 'member',
      all: false,
      scopes: [
        { path: '', write: true },
        { path: '営業部', write: false },
        { path: '営業部/下書き', write: true },
        { path: '営業部/下書き/確定', write: false },
      ],
    })
    // A department manager gets no extra write from managing.
    expect((await get('wa-manager')).body?.data?.scopes).toEqual(member.body?.data?.scopes)
    // A user rule on the department lets that member write there.
    expect((await get('wa-writer')).body?.data?.scopes).toContainEqual({ path: '営業部', write: true })
  })

  it('owner and admin always get all: true', async () => {
    for (const u of ['wa-owner', 'wa-admin']) {
      const r = await get(u)
      expect(r.status).toBe(200)
      expect(r.body?.data).toMatchObject({ role: ROLE[u], all: true, scopes: [] })
    }
  })

  it('ETag = version; If-None-Match answers 304 until a rule changes', async () => {
    const first = await get('wa-member')
    expect(first.etag).toBe(`"${first.body?.data?.version}"`)
    const again = await get('wa-member', { 'If-None-Match': first.etag! })
    expect(again.status).toBe(304)

    addScope('wa-s-new', '営業部/新規')
    addRule('wa-s-new', 'everyone', null, true)
    const changed = await get('wa-member', { 'If-None-Match': first.etag! })
    expect(changed.status).toBe(200)
    expect(changed.body?.data?.version).not.toBe(first.body?.data?.version)
    expect(changed.body?.data?.scopes).toContainEqual({ path: '営業部/新規', write: true })
  })
})
