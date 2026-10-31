/**
 * Integration Test: memberships, invitations and /api/git after the
 * 2026-10-22 security review.
 *
 * - only owners add owners/admins (an admin adding an owner = takeover);
 *   the account must exist;
 * - removing a member deletes every rule naming them (private folders
 *   included), so re-adding them does not restore their old access; a
 *   promotion to owner/admin drops their (moot) rules too;
 * - /api/git: only GET /repos/:companyId is left, for that company's
 *   members, without any server path;
 * - invitations: expiresInDays is an integer 1..30; a link signs up ONE
 *   account (claimed at sign-up, released if the sign-up fails) and is
 *   accepted once, by that account.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'

const currentUser = vi.hoisted(() => ({ id: 'u-owner' as string | null }))

vi.mock('../../src/lib/auth', async () => {
  const BetterSqlite = (await import('better-sqlite3')).default
  const { join: j } = await import('path')
  return {
    getUserFromRequest: vi.fn().mockImplementation(async () =>
      currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
    // Real lookup against the test auth.sqlite (the POST /members existence check).
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => {
      const conn = new BetterSqlite(j(process.env.DATA_DIR!, 'auth.sqlite'))
      try {
        const rows = ids.length === 0 ? [] : conn.prepare(`SELECT id, email, name FROM user WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; email: string; name: string | null }>
        return new Map(rows.map(r => [r.id, { email: r.email, name: r.name }]))
      } finally {
        conn.close()
      }
    }),
    auth: {
      handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { gitRoute } from '../../src/routes/git'
import { invitationsRoute } from '../../src/routes/invitations'
import { services } from '../../src/composition'
import { ensureCompanyScope, ensureFolderScope, upsertScopeRule } from '../../src/lib/permission-store'

const CO = 'acct-co'
const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/git', gitRoute)
app.route('/api', invitationsRoute)

async function as(user: string | null, method: string, path: string, body?: unknown) {
  currentUser.id = user
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  const text = await res.text()
  let json: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: res.status, body: json, text }
}

const ts = () => new Date().toISOString()
const addUser = (id: string) => {
  const conn = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  conn.prepare('INSERT OR IGNORE INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
  conn.close()
}
const addMember = (id: string, role: string) =>
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}`, id, CO, role, ts(), ts())
const roleOf = (id: string) => (db.prepare('SELECT role FROM memberships WHERE user_id = ? AND company_id = ?').get(id, CO) as { role: string } | undefined)?.role
const userRules = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM scope_rules WHERE subject_type = 'user' AND subject_id = ?`).get(id) as { n: number }).n

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'Acct', 'acct', 'u-owner', ts(), ts())
  for (const [id, role] of [['u-owner', 'owner'], ['u-admin', 'admin'], ['u-member', 'member']]) {
    addUser(id)
    addMember(id, role)
  }
  for (const id of ['u-alt', 'u-new', 'u-promo', 'u-leaver']) addUser(id)
  ensureCompanyScope(db, CO)
  mkdirSync(join(process.env.REPOS_DIR!, `${CO}.git`), { recursive: true })
})

describe('POST /companies/:id/members', () => {
  it('an admin cannot add an owner or an admin (company takeover)', async () => {
    for (const role of ['owner', 'admin']) {
      const r = await as('u-admin', 'POST', `/api/companies/${CO}/members`, { userId: 'u-alt', role })
      expect(r.status).toBe(403)
    }
    expect(roleOf('u-alt')).toBeUndefined()
    // a member is fine
    expect((await as('u-admin', 'POST', `/api/companies/${CO}/members`, { userId: 'u-alt', role: 'member' })).status).toBe(201)
    expect(roleOf('u-alt')).toBe('member')
  })

  it('an owner may add an admin; the account must exist', async () => {
    expect((await as('u-owner', 'POST', `/api/companies/${CO}/members`, { userId: 'u-new', role: 'admin' })).status).toBe(201)
    expect(roleOf('u-new')).toBe('admin')
    const ghost = await as('u-owner', 'POST', `/api/companies/${CO}/members`, { userId: 'u-does-not-exist', role: 'member' })
    expect(ghost.status).toBe(404)
    expect(roleOf('u-does-not-exist')).toBeUndefined()
    expect((await as('u-owner', 'POST', `/api/companies/${CO}/members`, { userId: 42 })).status).toBe(400)
  })
})

describe('removing a member / changing a role leaves no rules behind', () => {
  function seedRules(userId: string) {
    ensureFolderScope(db, CO, 'sales', 'u-owner')
    upsertScopeRule(db, CO, 'sales', { subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }, 'u-owner')
    upsertScopeRule(db, CO, 'sales', { subjectType: 'user', subjectId: userId, canRead: true, canWrite: true }, 'u-owner')
    // a private folder naming them as editor
    const scopeId = `scope-private-${userId}`
    db.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, 'folder', ?, ?)`).run(scopeId, CO, `秘密-${userId}`, `repo-${userId}`, ts())
    db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'everyone', NULL, 0, 0, ?)`).run(`r-e-${userId}`, scopeId, ts())
    db.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, 'user', ?, 1, 1, ?)`).run(`r-u-${userId}`, scopeId, userId, ts())
  }

  it('removal deletes every rule naming them, so re-adding restores nothing', async () => {
    addMember('u-leaver', 'member')
    seedRules('u-leaver')
    expect(userRules('u-leaver')).toBe(2)
    expect((await as('u-admin', 'DELETE', `/api/companies/${CO}/members/u-leaver`)).status).toBe(200)
    expect(userRules('u-leaver')).toBe(0)
    // the everyone rules stay (nothing starts inheriting, the private folder stays closed)
    expect((db.prepare(`SELECT can_read FROM scope_rules WHERE id = 'r-e-u-leaver'`).get() as { can_read: number }).can_read).toBe(0)
    expect((await as('u-owner', 'POST', `/api/companies/${CO}/members`, { userId: 'u-leaver', role: 'member' })).status).toBe(201)
    expect(userRules('u-leaver')).toBe(0)
  })

  it('a promotion to admin drops their rules (they would come back on a demotion)', async () => {
    addMember('u-promo', 'member')
    seedRules('u-promo')
    expect((await as('u-owner', 'PUT', `/api/companies/${CO}/members/u-promo/role`, { role: 'admin' })).status).toBe(200)
    expect(userRules('u-promo')).toBe(0)
    expect((await as('u-owner', 'PUT', `/api/companies/${CO}/members/u-promo/role`, { role: 'member' })).status).toBe(200)
    expect(userRules('u-promo')).toBe(0)
  })
})

describe('/api/git', () => {
  it('repo info: members only (others: 404 as for no repository), no server path', async () => {
    const m = await as('u-member', 'GET', `/api/git/repos/${CO}`)
    expect(m.status).toBe(200)
    expect(Object.keys(m.body.data).sort()).toEqual(['companyId', 'httpsUrl'])
    expect(m.text).not.toContain(process.env.DATA_DIR!)
    expect((await as('u-stranger', 'GET', `/api/git/repos/${CO}`)).status).toBe(404)
    expect((await as('u-stranger', 'GET', `/api/git/repos/no-such-co`)).status).toBe(404)
  })

  it('the administration endpoints are gone, for owners too', async () => {
    expect((await as('u-owner', 'GET', '/api/git/repos')).status).toBe(404)
    expect((await as('u-owner', 'POST', '/api/git/repos', { companyId: 'x' })).status).toBe(404)
    expect((await as('u-owner', 'POST', '/api/git/hooks/install')).status).toBe(404)
    expect((await as('u-owner', 'POST', '/api/git/repos/migrate-http')).status).toBe(404)
    expect((await as('u-owner', 'DELETE', `/api/git/repos/${CO}`)).status).toBe(404)
  })
})

describe('invitations', () => {
  it('expiresInDays must be an integer from 1 to 30', async () => {
    for (const bad of [0, 31, 1.5, -3, '7', 1e9, null]) {
      const r = await as('u-owner', 'POST', `/api/companies/${CO}/invitations`, { role: 'member', expiresInDays: bad })
      expect(r.status, String(bad)).toBe(400)
    }
    const ok = await as('u-owner', 'POST', `/api/companies/${CO}/invitations`, { role: 'member', expiresInDays: 30 })
    expect(ok.status).toBe(201)
    const days = (new Date(ok.body.data.expiresAt).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)
    expect((await as('u-owner', 'POST', `/api/companies/${CO}/invitations`, {})).status).toBe(201) // default 7
    // only owners invite admins
    expect((await as('u-admin', 'POST', `/api/companies/${CO}/invitations`, { role: 'admin' })).status).toBe(403)
  })

  it('a link signs up one account; a failed sign-up releases it; it is accepted once, by that account', async () => {
    const created = await as('u-owner', 'POST', `/api/companies/${CO}/invitations`, { role: 'member', expiresInDays: 1 })
    const token: string = created.body.data.token

    // A failed sign-up (e.g. password too short) does not use the link up.
    const failed = await services.invitations.signUp(token, async () => new Response('{"message":"bad"}', { status: 400 }))
    expect(failed?.status).toBe(400)

    const first = await services.invitations.signUp(token, async () =>
      new Response(JSON.stringify({ token: 's', user: { id: 'u-invitee' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    expect(first?.status).toBe(200)
    // a second sign-up with the same link is refused (null → the gate answers 403)
    let called = false
    expect(await services.invitations.signUp(token, async () => { called = true; return new Response('{}') })).toBeNull()
    expect(called).toBe(false)

    addUser('u-invitee')
    addUser('u-other-account')
    // only the account that signed up with it may accept it
    expect((await as('u-other-account', 'POST', `/api/invitations/${token}/accept`)).status).toBe(410)
    expect(roleOf('u-other-account')).toBeUndefined()
    expect((await as('u-invitee', 'POST', `/api/invitations/${token}/accept`)).status).toBe(200)
    expect(roleOf('u-invitee')).toBe('member')
    expect((await as('u-other-account', 'POST', `/api/invitations/${token}/accept`)).status).toBe(410)
  })

  it('an existing account accepts an unclaimed link once', async () => {
    const created = await as('u-owner', 'POST', `/api/companies/${CO}/invitations`, { role: 'member' })
    const token: string = created.body.data.token
    addUser('u-existing-1')
    addUser('u-existing-2')
    expect((await as('u-existing-1', 'POST', `/api/invitations/${token}/accept`)).status).toBe(200)
    expect((await as('u-existing-2', 'POST', `/api/invitations/${token}/accept`)).status).toBe(410)
    expect(await services.invitations.signUp(token, async () => new Response('{}'))).toBeNull()
  })
})
