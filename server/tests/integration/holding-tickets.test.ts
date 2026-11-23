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

// The composed storage (composition.ts), caught as it is built: the wiring of the gate is checked on it.
const composed = vi.hoisted(() => ({ sources: [] as unknown[], memberships: [] as unknown[] }))
vi.mock('../../src/adapters/sqlite/company-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/adapters/sqlite/company-data')>()
  return { ...original, sqliteCompanyData: (...a: Parameters<typeof original.sqliteCompanyData>) => {
    const source = original.sqliteCompanyData(...a)
    composed.sources.push(source)
    return source
  } }
})
vi.mock('../../src/adapters/sqlite/memberships', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/adapters/sqlite/memberships')>()
  return { ...original, sqliteMembershipRepository: (...a: Parameters<typeof original.sqliteMembershipRepository>) => {
    const repo = original.sqliteMembershipRepository(...a)
    composed.memberships.push(repo)
    return repo
  } }
})

import { configureBareRepo } from '../../src/routes/git'
import { UntrackedReaderChangeError } from '../../src/lib/reader-change-gate'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { MembershipRepository } from '../../src/ports/memberships'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const CO = 'htco'
const USERS = ['owner', 'admin', 'admin2', 'v1', 'v2', 'leaver', 'other', 'back1', 'back2', 'back3'] as const
type User = typeof USERS[number]
const ROLE: Record<User, string> = {
  owner: 'owner', admin: 'admin', admin2: 'admin', v1: 'member', v2: 'member', leaver: 'member', other: 'member', back1: 'member', back2: 'member', back3: 'admin',
}
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
  const { invitationsRoute } = await import('../../src/routes/invitations')
  const { permissionRulesRoute } = await import('../../src/routes/permission-rules')
  const { privateFoldersRoute } = await import('../../src/routes/private-folders')
  app = new Hono()
  app.route('/api/companies', companiesRoute)
  app.route('/api', invitationsRoute)
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

  it('made public: the open tickets of everyone who reads it now are cancelled; someone who left the company keeps theirs', async () => {
    const f = await newFolder(['v1', 'v2', 'other'])
    await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-v2', 'u-other'] })
    await as('owner', 'DELETE', `${base}/members/u-other`)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-other', 'open'], ['u-v1', 'open']])
    const r = await as('owner', 'POST', `${base}/private-folders/${f.scopeId}/make-public`)
    expect(r.status).toBe(200)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-other', 'open'], ['u-v1', 'cancelled']])
    expect(ticketHistory(f.scopeId).at(-1)).toMatchObject({ action: 'holding-ticket-cancel', userId: 'u-v1', by: 'u-owner' })
  })

  /** An invitation `user` once accepted (what POST /members asks for), or a fresh one to accept. */
  function invitation(token: string, role: string, usedBy: string | null) {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO invitations (id, company_id, token, role, created_by, used_by, used_at, expires_at, created_at) VALUES (?, ?, ?, ?, 'u-owner', ?, ?, ?, ?)`)
      .run(`inv-${token}`, CO, token, role, usedBy, usedBy ? now : null, new Date(Date.now() + 86_400_000).toISOString(), now)
  }

  it('removed, then added back as an admin (POST /members): the ticket is cancelled in that request (an admin reads every private folder)', async () => {
    const f = await newFolder(['back1'])
    await as('owner', 'DELETE', `${base}/members/u-back1`)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back1', 'open']])
    invitation('t-back1', 'member', 'u-back1')
    const r = await as('owner', 'POST', `${base}/members`, { userId: 'u-back1', role: 'admin' })
    expect(r.status).toBe(201)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back1', 'cancelled']])
  })

  it('removed, then back through an invitation as an admin: the ticket is cancelled when they accept', async () => {
    const f = await newFolder([])
    await as('owner', 'DELETE', `${base}/members/u-back3`)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back3', 'open']])
    invitation('t-back3', 'admin', null)
    const r = await as('back3', 'POST', '/api/invitations/t-back3/accept')
    expect(r.status).toBe(200)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back3', 'cancelled']])
  })

  it('back as a plain member, they read nothing yet (their rules went with them): the ticket stays open', async () => {
    const f = await newFolder(['back2'])
    await as('owner', 'DELETE', `${base}/members/u-back2`)
    invitation('t-back2', 'member', 'u-back2')
    expect((await as('owner', 'POST', `${base}/members`, { userId: 'u-back2', role: 'member' })).status).toBe(201)
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back2', 'open']])
    // Added to the folder again: now cancelled.
    await as('owner', 'PUT', `${base}/private-folders/${f.scopeId}/members`, { viewers: ['u-back2'] })
    expect(ticketsOf(f.scopeId).map(t => [t.user_id, t.state])).toEqual([['u-back2', 'cancelled']])
  })
})

describe('the composed storage refuses a change of who reads outside track (composition.ts passes the gate)', () => {
  const source = () => composed.sources[0] as CompanyDataSource
  const memberships = () => composed.memberships[0] as MembershipRepository
  const viewersOf = (scopeId: string) => (db.prepare(`SELECT subject_id FROM scope_rules WHERE company_id = ? AND scope_id = ? AND subject_type = 'user'`).all(CO, scopeId) as Array<{ subject_id: string }>).map(r => r.subject_id)

  it('scopes.deleteUserRules and memberships.delete / insert throw, nothing changes', async () => {
    const f = await newFolder(['v2'])
    expect(composed.sources).toHaveLength(1)
    expect(composed.memberships).toHaveLength(1)
    expect(() => source().forCompany(CO).scopes.deleteUserRules('u-v2')).toThrow(UntrackedReaderChangeError)
    expect(() => memberships().delete(CO, 'u-v2')).toThrow(UntrackedReaderChangeError)
    expect(() => memberships().insert({ id: 'm-x', userId: 'u-x', companyId: CO, role: 'admin', createdAt: 'x' })).toThrow(UntrackedReaderChangeError)
    expect(viewersOf(f.scopeId)).toEqual(['u-v2'])
    expect(memberships().roleOf(CO, 'u-v2')).toBe('member')
    expect(memberships().roleOf(CO, 'u-x')).toBeNull()
  })

  it('a folder\'s rows are not removed by a delete whose trackRows does not track (the folder and its readers stay)', async () => {
    const f = await newFolder(['v2'])
    const folder = source().forCompany(CO).privateFolders.get(f.scopeId)!
    await expect(source().forCompany(CO).privateFolders.delete(folder, 'u-owner', removeRows => removeRows())).rejects.toThrow(UntrackedReaderChangeError)
    expect(source().forCompany(CO).privateFolders.get(f.scopeId)).not.toBeNull()
    expect(viewersOf(f.scopeId)).toEqual(['u-v2'])
    expect(ticketsOf(f.scopeId)).toEqual([])
  })

  it('…nor turned public by a make-public whose trackRows does not track', async () => {
    const f = await newFolder(['v2'])
    const folder = source().forCompany(CO).privateFolders.get(f.scopeId)!
    await expect(source().forCompany(CO).privateFolders.makePublic(folder, 'u-owner', changeRows => changeRows())).rejects.toThrow(UntrackedReaderChangeError)
    expect(source().forCompany(CO).privateFolders.get(f.scopeId)).not.toBeNull()
  })
})
