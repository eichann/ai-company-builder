/**
 * Integration Test: holding tickets through the real routes (private-folders.md "Access
 * removed: holding tickets"; design memo docs/private-folder-holding-design.md, S1).
 *
 * READER_CHANGES lists every route that can take a private folder away from someone. Each row
 * makes that change through the API and expects exactly the ticket(s) it should leave, with
 * their permission_history entry, in the same request. A route that stops wrapping its change
 * in holdingTickets.track fails its row: the storage step refuses to run outside it (500,
 * nothing changed — lib/reader-change-gate.ts), so a forgotten wrapper never leaves a member
 * without a ticket silently. A new route that can change readers gets a row here.
 *
 * Also: a change that keeps everyone reading (editor → viewer, make public) leaves none, and
 * getting access back cancels the open ticket.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const currentUser = vi.hoisted(() => ({ id: 'u-owner' as string | null }))

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

import { configureBareRepo } from '../../src/routes/git'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const CO = 'htco'
const USERS = ['owner', 'admin', 'admin2', 'v1', 'v2', 'leaver', 'other'] as const
type User = typeof USERS[number]
const ROLE: Record<User, string> = { owner: 'owner', admin: 'admin', admin2: 'admin', v1: 'member', v2: 'member', leaver: 'member', other: 'member' }
const base = `/api/companies/${CO}`

let workDir: string
let db: import('better-sqlite3').Database
let app: Loose

const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

async function as(userId: User, method: string, path: string, body?: unknown) {
  currentUser.id = `u-${userId}`
  const init: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await app.request(path, init)
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: json }
}

interface TicketRow { user_id: string; scope_id: string; folder_path: string; cause: string; state: string; by_user: string; expires_at: string; created_at: string }
const ticketsOf = (scopeId: string) => db.prepare(`SELECT * FROM holding_tickets WHERE company_id = ? AND scope_id = ? ORDER BY user_id`).all(CO, scopeId) as TicketRow[]
const ticketHistory = (scopeId: string) => (db.prepare(`SELECT action, detail, by_user FROM permission_history WHERE company_id = ? AND action LIKE 'holding-ticket%' ORDER BY seq`).all(CO) as Array<{ action: string; detail: string; by_user: string }>)
  .map(h => ({ action: h.action, by: h.by_user, ...JSON.parse(h.detail) }))
  .filter(h => h.scopeId === scopeId)

let folderCount = 0
/** A new private folder under 人事 read by `viewers` (+ owners/admins). */
async function newFolder(viewers: User[], editors: User[] = []): Promise<{ scopeId: string; name: string; path: string }> {
  const name = `f${++folderCount}`
  const r = await as('owner', 'POST', `${base}/private-folders`, {
    parentPath: '人事', name, viewers: viewers.map(v => `u-${v}`), editors: editors.map(v => `u-${v}`), force: true,
  })
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`)
  return { scopeId: r.body.data.scopeId, name, path: `人事/${name}` }
}

const userRuleOf = (scopeId: string, user: User) =>
  db.prepare(`SELECT id FROM scope_rules WHERE company_id = ? AND scope_id = ? AND subject_type = 'user' AND subject_id = ?`).get(CO, scopeId, `u-${user}`) as { id: string } | undefined

function addMember(user: User, role: string) {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${user}-${Date.now()}`, `u-${user}`, CO, role, now, now)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-holding-tickets-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, 'HT', 'ht-co', 'u-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const u of USERS) {
    authDb.prepare('INSERT OR IGNORE INTO user (id, email, name) VALUES (?, ?, ?)').run(`u-${u}`, `${u}@example.com`, u)
    addMember(u, ROLE[u])
  }
  authDb.close()
  const { ensureCompanyScope, ensureDepartmentScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run('d-hr', CO, '人事', '人事', now, now)
  ensureDepartmentScope(db, CO, 'd-hr', '人事')

  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'seed'], seed)
  git(['config', 'user.email', 'seed@example.com'], seed)
  mkdirSync(join(seed, '人事'), { recursive: true })
  writeFileSync(join(seed, '人事/README.md'), 'hr\n')
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], seed)
  git(['push', '-q', bare, 'HEAD:main'], seed)

  const cv = await import('../../src/lib/client-version')
  cv.setPrivateFoldersClientCutoffForTests('20260101000000')

  const { Hono } = await import('hono')
  const { companiesRoute } = await import('../../src/routes/companies')
  const { permissionRulesRoute } = await import('../../src/routes/permission-rules')
  const { privateFoldersRoute } = await import('../../src/routes/private-folders')
  app = new Hono()
  app.route('/api/companies', companiesRoute)
  app.route('/api/companies/:companyId', permissionRulesRoute)
  app.route('/api/companies/:companyId', privateFoldersRoute)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Every route that can take a private folder away from someone. `change` makes the change and
 * returns the folder; `lost` is who must hold an open ticket afterwards, with `cause`.
 */
const READER_CHANGES: Array<{
  route: string
  cause: string
  change: () => Promise<{ scopeId: string; path: string; lost: string[]; by: User }>
}> = [
  {
    route: 'PUT /api/companies/:companyId/private-folders/:scopeId/members',
    cause: 'readers',
    change: async () => {
      const f = await newFolder(['v1', 'v2'])
      const r = await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v2'] })
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-v1'], by: 'owner' }
    },
  },
  {
    route: 'DELETE /api/companies/:companyId/members/:userId',
    cause: 'left-company',
    change: async () => {
      const f = await newFolder(['leaver', 'v2'])
      const r = await as('admin', 'DELETE', `${base}/members/u-leaver`)
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-leaver'], by: 'admin' }
    },
  },
  {
    route: 'DELETE /api/companies/:companyId/private-folders/:scopeId',
    cause: 'folder-deleted',
    change: async () => {
      const f = await newFolder(['v1'])
      const r = await as('owner', 'DELETE', `${base}/private-folders/${f.scopeId}?confirm=${encodeURIComponent(f.name)}`)
      expect(r.status).toBe(200)
      // Everyone who read it: owners / admins too (the folder is gone for all of them).
      const admins = (db.prepare(`SELECT user_id FROM memberships WHERE company_id = ? AND role IN ('owner', 'admin')`).all(CO) as Array<{ user_id: string }>).map(m => m.user_id)
      return { ...f, lost: [...admins, 'u-v1'], by: 'owner' }
    },
  },
  {
    route: 'PUT /api/companies/:companyId/members/:userId/role',
    cause: 'role',
    change: async () => {
      const f = await newFolder(['v1'])
      const r = await as('owner', 'PUT', `${base}/members/u-admin2/role`, { role: 'member' })
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-admin2'], by: 'owner' }
    },
  },
  {
    route: 'PUT /api/companies/:companyId/permissions/scopes/by-path',
    cause: 'rules',
    change: async () => {
      const f = await newFolder(['v1', 'v2'])
      const r = await as('owner', 'PUT', `${base}/permissions/scopes/by-path`, {
        path: f.path,
        rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'u-v2', canRead: true, canWrite: false }],
      })
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-v1'], by: 'owner' }
    },
  },
  {
    route: 'POST /api/companies/:companyId/permissions/rules',
    cause: 'rules',
    change: async () => {
      const f = await newFolder(['v1', 'v2'])
      const r = await as('owner', 'POST', `${base}/permissions/rules`, { path: f.path, subjectType: 'user', subjectId: 'u-v1', canRead: false, canWrite: false })
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-v1'], by: 'owner' }
    },
  },
  {
    route: 'PATCH /api/companies/:companyId/permissions/rules/:ruleId',
    cause: 'rules',
    change: async () => {
      const f = await newFolder(['v1', 'v2'])
      const r = await as('owner', 'PATCH', `${base}/permissions/rules/${userRuleOf(f.scopeId, 'v1')!.id}`, { canRead: false, canWrite: false })
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-v1'], by: 'owner' }
    },
  },
  {
    route: 'DELETE /api/companies/:companyId/permissions/rules/:ruleId',
    cause: 'rules',
    change: async () => {
      const f = await newFolder(['v1', 'v2'])
      const r = await as('owner', 'DELETE', `${base}/permissions/rules/${userRuleOf(f.scopeId, 'v1')!.id}`)
      expect(r.status).toBe(200)
      return { ...f, lost: ['u-v1'], by: 'owner' }
    },
  },
]

describe('every route that can take a private folder away leaves a holding ticket in the same request', () => {
  for (const row of READER_CHANGES) {
    it(`${row.route} → ${row.cause}`, async () => {
      const before = Date.now()
      const { scopeId, path, lost, by } = await row.change()
      const tickets = ticketsOf(scopeId)
      expect(tickets.map(t => t.user_id).sort()).toEqual([...lost].sort())
      for (const t of tickets) {
        expect(t).toMatchObject({ folder_path: path, cause: row.cause, state: 'open', by_user: `u-${by}` })
        // 30 days from now.
        const days = (Date.parse(t.expires_at) - Date.parse(t.created_at)) / 86_400_000
        expect(days).toBe(30)
        expect(Date.parse(t.created_at)).toBeGreaterThanOrEqual(before - 1000)
      }
      expect(ticketHistory(scopeId).map(h => [h.action, h.userId, h.cause, h.path]).sort())
        .toEqual([...lost].sort().map(u => ['holding-ticket', u, row.cause, path]))
    })
  }
})

describe('changes that take nobody\'s reading away leave no ticket', () => {
  it('an editor made a viewer still reads: no ticket', async () => {
    const f = await newFolder(['v1'], ['v1'])
    const r = await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v1'], editors: [] })
    expect(r.status).toBe(200)
    expect(ticketsOf(f.scopeId)).toEqual([])
  })

  it('made public: everyone reads it now — no ticket', async () => {
    const f = await newFolder(['v1'])
    const r = await as('owner', 'POST', `${base}/private-folders/${f.scopeId}/make-public`)
    expect(r.status).toBe(200)
    expect(ticketsOf(f.scopeId)).toEqual([])
  })

  it('a refused change (the last owner cannot be demoted) leaves no ticket', async () => {
    const f = await newFolder([])
    const r = await as('owner', 'PUT', `${base}/members/u-owner/role`, { role: 'member' })
    expect(r.status).toBe(400)
    expect(ticketsOf(f.scopeId)).toEqual([])
  })
})

describe('getting access back', () => {
  it('cancels the open ticket, with permission_history; losing it again opens a new one', async () => {
    const f = await newFolder(['v1', 'v2'])
    await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v2'] })
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-v1', 'open']])
    await as('admin', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v1', 'u-v2'] })
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-v1', 'cancelled']])
    expect(ticketHistory(f.scopeId).at(-1)).toMatchObject({ action: 'holding-ticket-cancel', by: 'u-admin', userId: 'u-v1', path: f.path })
    await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v2'] })
    expect(ticketsOf(f.scopeId).map(t => t.state).sort()).toEqual(['cancelled', 'open'])
  })

  it('a removed member invited back and re-added does not cancel the old ticket by being a member (they read nothing yet)', async () => {
    const f = await newFolder(['other'])
    await as('owner', 'DELETE', `${base}/members/u-other`)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-other', 'open']])
    addMember('other', 'member')
    // Their rules went with the membership: they read nothing until someone adds them again.
    await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: [] })
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-other', 'open']])
  })
})
