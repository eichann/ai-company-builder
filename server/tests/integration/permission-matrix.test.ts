/**
 * Integration Test: the permission matrix — every API route × every kind of caller.
 *
 * Callers: the company's owner, an admin, a plain member, a department manager
 * (a member who manages 営業部), an outsider (signed in, owner of another
 * company) and a signed-out request. Server operators (OPERATOR_USER_IDS, who
 * may create companies) are nobody, except on rows that name them. For each route the matrix states the
 * status code each of them gets; a guard that is removed or loosened changes
 * a 401 / 403 / 404 into something else and fails the row.
 *
 * Routes are read from the real application (src/app.ts, the one index.ts
 * serves): a route that is not in the matrix fails the test, so a new
 * endpoint is placed in the matrix the day it is added.
 *
 * Requests are chosen so an allowed caller passes the guard without changing
 * anything another row depends on: an invalid body (400: the check order is
 * who → body → rules), a missing target (404 after the role check), or a
 * target the endpoint refuses for its own reason (a department that holds a
 * private folder cannot be deleted). Where the guard depends on the target
 * (a manager inside / outside their department) the route has a row per case.
 *
 * What each refusal means is the route's rule, not this file's: 401 no
 * session, 403 wrong role, 404 not a member (a non-member learns nothing about
 * the company) or a private folder the caller cannot read (private-folders.md:
 * its name never leaks). Git over HTTP is checked here on the advertisement and
 * HEAD; who may push what is git-http-access.test.ts and the push checker's
 * tests. The key broker's relay takes a token, never a session.
 *
 * Cross-company axis (multi-tenant foundation 案 A, `.claude/rules/server.md`
 * "Company handle"): every route that takes an object id is also called by
 * the owner of this company with an object of ANOTHER company (department,
 * rule, scope, private folder, member, sandbox override, emergency stop, key,
 * relay service, token, invitation) in this company's URL. The answer must be
 * exactly the answer for an id that does not exist (status and body), and
 * nothing of the other company may change. A new route with an object id that
 * has no cross-company row fails the test (or is listed in NOT_OBJECT_IDS
 * with its reason).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

const USER_HEADER = 'x-matrix-user'

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join: joinPath } = await import('path')
  return {
    authDb: new Database(joinPath(process.env.DATA_DIR!, 'auth.sqlite')),
    getUserFromRequest: vi.fn().mockImplementation(async (req: Request) => {
      const id = req.headers.get('x-matrix-user')
      return id ? { id, email: `${id}@example.com`, name: id, image: null, emailVerified: true } : null
    }),
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
      new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
    auth: {
      handler: vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const ROLES = ['owner', 'admin', 'member', 'manager', 'outsider', 'signedOut'] as const
type Role = typeof ROLES[number]
const USER: Record<Exclude<Role, 'signedOut'>, string> = {
  owner: 'pm-owner', admin: 'pm-admin', member: 'pm-member', manager: 'pm-manager', outsider: 'pm-outsider',
}

/** Ids made while seeding, used to build the URLs. */
interface World {
  co: string
  sales: string // 営業部, managed by the manager; holds the private folder
  accounting: string // 経理部, no manager
  privateScope: string // 営業部/評価 (owner, admin, manager can read; the member cannot)
  salesScope: string
  salesRule: string
  salesEveryoneRule: string
  accountingScope: string
  accountingRule: string
  accountingEveryoneRule: string
  companyScope: string
  key: string
  memberToken: string
  invitationToken: string
  /** Objects of ANOTHER company (the outsider's), for the cross-company axis. */
  other: {
    co: string
    department: string
    scope: string
    rule: string
    privateScope: string
    privateName: string
    member: string
    stop: string
    key: string
    relayService: string
    token: string
    invitation: string
    record: string
    recordToken: string
    /** A plugin package available only to the other company, installed there. */
    plugin: string
    /** An operation record (操作の控え) of the other company. */
    operation: string
    googleGrant: string
    sharedDrive: string
    /** An approval request of the other company. */
    approval: string
    /** A mail draft of the other company's member (outbound-mail.md). */
    outboundMail: string
    /** An absence of the other company's member (代わりの人). */
    absence: string
    /** A group (見える人のまとまり) of the other company, with its member in it. */
    group: string
    /** An execution run of the other company's member, with an operation of unknown result (records.md "Execution runs"). */
    aiRun: string
    /** A Skill on the other company's shelf (plugins.md "The Skill shelf"). */
    shelfItem: string
    shelfRequest: string
    /** A scheduled job of the other company, approved, its member responsible (jobs.md). */
    job: string
    /** A Google Picker pick ticket of the other company's member (google-drive.md). */
    pickTicket: string
  }
}

interface Req { path: string; body?: unknown; query?: string }
/** Expected status for [owner, admin, member, manager, outsider, signedOut]. */
type Expect = [number, number, number, number, number, number]
interface Row {
  route: string; why?: string; req: (w: World) => Req; expect: Expect
  /** Callers listed in OPERATOR_USER_IDS (server operators) while this row runs; nobody otherwise. */
  operators?: Array<Exclude<Role, 'signedOut'>>
}

const r = (route: string, req: (w: World) => Req, expect: Expect, why?: string, operators?: Row['operators']): Row => ({ route, req, expect, why, operators })
const C = (w: World) => `/api/companies/${w.co}`

const ALL_SIGNED_IN: Expect = [200, 200, 200, 200, 200, 401]
const MEMBERS: Expect = [200, 200, 200, 200, 404, 401]

const NO_SUCH_JOB = `job.${'0'.repeat(32)}`
const OTHER_JOB = `job.${'e'.repeat(32)}`
const NO_SUCH_OCC = `occ.${'0'.repeat(32)}`
const OTHER_OCC = `occ.${'b'.repeat(32)}`

const MATRIX: Row[] = [
  // Public
  r('GET /', () => ({ path: '/' }), [200, 200, 200, 200, 200, 200]),
  r('GET /api/config', () => ({ path: '/api/config' }), [200, 200, 200, 200, 200, 200]),
  r('GET /api/auth/**', () => ({ path: '/api/auth/get-session' }), [200, 200, 200, 200, 200, 200]),
  r('POST /api/auth/**', () => ({ path: '/api/auth/sign-up/email', body: {} }), [403, 403, 403, 403, 403, 403],
    'sign-up after the first account needs an invitation'),
  r('GET /api/invitations/:token', w => ({ path: `/api/invitations/${w.invitationToken}` }), [200, 200, 200, 200, 200, 200],
    'the sign-up page checks a link before an account exists'),

  // Signed in, any company
  r('GET /api/me', () => ({ path: '/api/me' }), ALL_SIGNED_IN),
  r('GET /api/companies', () => ({ path: '/api/companies' }), ALL_SIGNED_IN),
  r('POST /api/companies', () => ({ path: '/api/companies', body: {} }), [403, 403, 403, 403, 403, 401],
    'only server operators create companies, owners of one included'),
  r('POST /api/companies', () => ({ path: '/api/companies', body: {} }), [403, 403, 403, 403, 400, 401],
    'the outsider is a server operator', ['outsider']),
  r('POST /api/invitations/:token/accept', () => ({ path: '/api/invitations/no-such-token/accept', body: {} }), [404, 404, 404, 404, 404, 401]),

  // Companies
  r('GET /api/companies/:companyId', w => ({ path: C(w) }), MEMBERS),
  r('PATCH /api/companies/:companyId', w => ({ path: C(w), body: {} }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/members', w => ({ path: `${C(w)}/members` }), MEMBERS),
  r('POST /api/companies/:companyId/members', w => ({ path: `${C(w)}/members`, body: {} }), [400, 400, 403, 403, 403, 401]),
  r('PUT /api/companies/:companyId/members/:userId/role', w => ({ path: `${C(w)}/members/${USER.member}/role`, body: {} }), [400, 403, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/members/:userId', w => ({ path: `${C(w)}/members/pm-nobody` }), [200, 200, 403, 403, 403, 401],
    'removing someone who is not a member changes nothing'),
  r('GET /api/companies/:companyId/client-activity', w => ({ path: `${C(w)}/client-activity` }), [200, 200, 403, 403, 404, 401]),

  // Departments
  r('GET /api/companies/:companyId/departments', w => ({ path: `${C(w)}/departments` }), MEMBERS),
  r('GET /api/companies/:companyId/departments/:id', w => ({ path: `${C(w)}/departments/${w.sales}` }), MEMBERS),
  r('POST /api/companies/:companyId/departments', w => ({ path: `${C(w)}/departments`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/departments/:id', w => ({ path: `${C(w)}/departments/${w.sales}`, body: { folder: 'a/b' } }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/departments/:id', w => ({ path: `${C(w)}/departments/${w.sales}` }), [409, 409, 403, 403, 404, 401],
    '営業部 holds a private folder, so an allowed caller is refused for that'),
  r('GET /api/companies/:companyId/departments/:id/stats', w => ({ path: `${C(w)}/departments/${w.sales}/stats` }), MEMBERS),
  r('POST /api/companies/:companyId/departments/reorder', w => ({ path: `${C(w)}/departments/reorder`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/departments/sync', w => ({ path: `${C(w)}/departments/sync` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/departments/:id/managers', w => ({ path: `${C(w)}/departments/${w.sales}/managers` }), MEMBERS),
  r('PUT /api/companies/:companyId/departments/:id/managers', w => ({ path: `${C(w)}/departments/${w.sales}/managers`, body: {} }), [400, 400, 403, 403, 404, 401]),
  // 「Skill を直せる人」: owner/admin only, a department's manager included in the refusal
  r('GET /api/companies/:companyId/skill-editors', w => ({ path: `${C(w)}/skill-editors` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/skill-editors', w => ({ path: `${C(w)}/skill-editors`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/skill-editors/everyone', w => ({ path: `${C(w)}/skill-editors/everyone`, body: {} }), [400, 400, 403, 403, 404, 401]),
  // 見える人のまとまり (server.md "Groups"): owners and admins only, a manager too gets 403.
  r('GET /api/companies/:companyId/groups', w => ({ path: `${C(w)}/groups` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/groups', w => ({ path: `${C(w)}/groups`, body: {} }), [400, 400, 403, 403, 404, 401], 'no name'),
  r('PATCH /api/companies/:companyId/groups/:groupId', w => ({ path: `${C(w)}/groups/no-such-group`, body: { name: 'x' } }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/groups/:groupId/members', w => ({ path: `${C(w)}/groups/no-such-group/members`, body: { userIds: [] } }), [404, 404, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/groups/:groupId', w => ({ path: `${C(w)}/groups/no-such-group` }), [404, 404, 403, 403, 404, 401]),
  // 定期の仕事 (jobs.md): owner/admin manage; a member lists the jobs they are responsible for (none here), and
  // anyone else's job answers like a missing one; accept is the responsible person's only.
  r('GET /api/companies/:companyId/jobs', w => ({ path: `${C(w)}/jobs` }), MEMBERS),
  r('GET /api/companies/:companyId/jobs/:jobId', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/jobs/:jobId/occurrences', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/occurrences` }), [404, 404, 404, 404, 404, 401]),
  // 「もう一度」 (B PR 5b): owner / admin only — a member and a manager are refused before anything is read.
  r('POST /api/companies/:companyId/jobs/:jobId/occurrences/:occurrenceId/retry', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/occurrences/${NO_SUCH_OCC}/retry` }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/occurrences/${NO_SUCH_OCC}/operations/k1/reconcile`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/jobs', w => ({ path: `${C(w)}/jobs`, body: {} }), [400, 400, 403, 403, 404, 401], 'no definition'),
  r('PUT /api/companies/:companyId/jobs/:jobId', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/jobs/:jobId/approve', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/approve`, body: { version: 1 } }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/jobs/:jobId/pause', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/pause` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/jobs/:jobId/resume', w => ({ path: `${C(w)}/jobs/${NO_SUCH_JOB}/resume` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/jobs/:jobId/accept', w => ({ path: `${C(w)}/me/jobs/${NO_SUCH_JOB}/accept`, body: { version: 1 } }), [404, 404, 404, 404, 404, 401]),
  r('PUT /api/companies/:companyId/jobs-stop', w => ({ path: `${C(w)}/jobs-stop`, body: {} }), [400, 400, 403, 403, 404, 401], 'no stopped'),
  // A PC job's claim (B PR 5a): any member lists their own turns (none here) and may claim (body first: 400).
  r('GET /api/companies/:companyId/me/job-turns', w => ({ path: `${C(w)}/me/job-turns` }), MEMBERS),
  r('POST /api/companies/:companyId/job-run-claims', w => ({ path: `${C(w)}/job-run-claims`, body: {} }), [400, 400, 400, 400, 404, 401], 'no occurrence'),
  // Department membership (所属する部署): any member reads; owner/admin and the department's own managers change it
  r('GET /api/companies/:companyId/departments/:id/members', w => ({ path: `${C(w)}/departments/${w.sales}/members` }), MEMBERS),
  r('PUT /api/companies/:companyId/departments/:id/members', w => ({ path: `${C(w)}/departments/${w.sales}/members`, body: {} }), [400, 400, 403, 400, 404, 401], 'the manager\'s department'),
  r('PUT /api/companies/:companyId/departments/:id/members', w => ({ path: `${C(w)}/departments/${w.accounting}/members`, body: {} }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('PUT /api/companies/:companyId/departments/:id/members', w => ({ path: `${C(w)}/departments/${w.sales}/members`, body: { userIds: [], force: true } }), [200, 200, 403, 403, 404, 401],
    'saving despite outdated apps (who belongs decides who writes in a new department): owners and admins only; nobody belongs, so nothing changes'),

  // Files (read-only views)
  r('GET /api/companies/:companyId/folder-sizes', w => ({ path: `${C(w)}/folder-sizes`, query: `path=${encodeURIComponent('営業部')}` }), MEMBERS),
  r('GET /api/companies/:companyId/files/tree', w => ({ path: `${C(w)}/files/tree` }), MEMBERS),
  r('GET /api/companies/:companyId/files/content', w => ({ path: `${C(w)}/files/content`, query: `path=${encodeURIComponent('営業部/.gitkeep')}` }), MEMBERS),
  r('GET /api/companies/:companyId/files/search', w => ({ path: `${C(w)}/files/search`, query: 'q=matrix' }), MEMBERS),

  // Permissions (views)
  r('GET /api/companies/:companyId/overview', w => ({ path: `${C(w)}/overview` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/capabilities', w => ({ path: `${C(w)}/me/capabilities` }), MEMBERS),
  r('GET /api/companies/:companyId/me/write-access', w => ({ path: `${C(w)}/me/write-access` }), MEMBERS),
  r('GET /api/companies/:companyId/push-rejections', w => ({ path: `${C(w)}/push-rejections` }), [200, 200, 403, 403, 404, 401]),

  // Permissions (editing): owners, admins, and a manager inside their own department
  r('GET /api/companies/:companyId/permissions', w => ({ path: `${C(w)}/permissions` }), [200, 200, 403, 200, 404, 401]),
  r('GET /api/companies/:companyId/permissions/effective', w => ({ path: `${C(w)}/permissions/effective`, query: `path=${encodeURIComponent('営業部')}` }), [200, 200, 403, 200, 404, 401]),
  r('GET /api/companies/:companyId/permissions/folders', w => ({ path: `${C(w)}/permissions/folders` }), [200, 200, 403, 403, 404, 401], 'the company root is no manager\'s'),
  r('GET /api/companies/:companyId/permissions/effective', w => ({ path: `${C(w)}/permissions/effective`, query: `path=${encodeURIComponent('経理部')}` }), [200, 200, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('GET /api/companies/:companyId/permissions/folders', w => ({ path: `${C(w)}/permissions/folders`, query: `path=${encodeURIComponent('営業部')}` }), [200, 200, 403, 200, 404, 401], 'the manager\'s department'),
  r('PUT /api/companies/:companyId/permissions/scopes/by-path', w => ({ path: `${C(w)}/permissions/scopes/by-path`, body: { path: '営業部' } }), [400, 400, 403, 400, 404, 401]),
  r('PUT /api/companies/:companyId/permissions/scopes/by-path', w => ({ path: `${C(w)}/permissions/scopes/by-path`, body: { path: '経理部' } }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('POST /api/companies/:companyId/permissions/rules', w => ({ path: `${C(w)}/permissions/rules`, body: { path: '営業部' } }), [400, 400, 403, 400, 404, 401]),
  r('POST /api/companies/:companyId/permissions/rules', w => ({ path: `${C(w)}/permissions/rules`, body: { path: '経理部' } }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('PATCH /api/companies/:companyId/permissions/rules/:ruleId', w => ({ path: `${C(w)}/permissions/rules/${w.salesRule}`, body: {} }), [400, 400, 403, 400, 404, 401]),
  r('PATCH /api/companies/:companyId/permissions/rules/:ruleId', w => ({ path: `${C(w)}/permissions/rules/${w.accountingRule}`, body: {} }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('DELETE /api/companies/:companyId/permissions/rules/:ruleId', w => ({ path: `${C(w)}/permissions/rules/${w.salesEveryoneRule}` }), [400, 400, 403, 400, 404, 401],
    'the everyone rule cannot go while other rules exist'),
  r('DELETE /api/companies/:companyId/permissions/rules/:ruleId', w => ({ path: `${C(w)}/permissions/rules/${w.accountingEveryoneRule}` }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('DELETE /api/companies/:companyId/permissions/scopes/:scopeId/rules', w => ({ path: `${C(w)}/permissions/scopes/${w.privateScope}/rules` }), [400, 400, 403, 400, 404, 401],
    'a private folder keeps its rules'),
  r('DELETE /api/companies/:companyId/permissions/scopes/:scopeId/rules', w => ({ path: `${C(w)}/permissions/scopes/${w.companyScope}/rules` }), [400, 400, 403, 403, 404, 401],
    'the company-wide rule stays; the company root is no manager\'s'),
  r('POST /api/companies/:companyId/permissions/scopes/:scopeId/move', w => ({ path: `${C(w)}/permissions/scopes/${w.salesScope}/move`, body: {} }), [400, 400, 403, 400, 404, 401]),
  r('POST /api/companies/:companyId/permissions/scopes/:scopeId/move', w => ({ path: `${C(w)}/permissions/scopes/${w.accountingScope}/move`, body: {} }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),

  // Private folders (営業部/評価: the owner, admins and the 営業部 manager read it; the member does not)
  r('POST /api/companies/:companyId/private-folders', w => ({ path: `${C(w)}/private-folders`, body: { parentPath: '営業部', name: '評価' } }), [409, 409, 403, 409, 404, 401], 'the name is taken'),
  r('POST /api/companies/:companyId/private-folders', w => ({ path: `${C(w)}/private-folders`, body: { parentPath: '経理部', name: '評価', viewers: 'x' } }), [400, 400, 403, 403, 404, 401], 'outside the manager\'s department'),
  r('GET /api/companies/:companyId/private-folders', w => ({ path: `${C(w)}/private-folders` }), [200, 200, 403, 200, 404, 401]),
  r('GET /api/companies/:companyId/private-folders/:scopeId', w => ({ path: `${C(w)}/private-folders/${w.privateScope}` }), [200, 200, 404, 200, 404, 401]),
  r('PUT /api/companies/:companyId/private-folders/:scopeId/members', w => ({ path: `${C(w)}/private-folders/${w.privateScope}/members`, body: {} }), [400, 400, 404, 400, 404, 401]),
  r('POST /api/companies/:companyId/private-folders/:scopeId/make-public', w => ({ path: `${C(w)}/private-folders/no-such-scope/make-public` }), [404, 404, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/private-folders/:scopeId', w => ({ path: `${C(w)}/private-folders/${w.privateScope}` }), [400, 400, 403, 403, 404, 401], 'no typed confirmation'),
  r('GET /api/companies/:companyId/me/private-folders', w => ({ path: `${C(w)}/me/private-folders` }), MEMBERS),
  r('GET /api/companies/:companyId/me/scopes', w => ({ path: `${C(w)}/me/scopes` }), MEMBERS),
  r('POST /api/companies/:companyId/paths/check', w => ({ path: `${C(w)}/paths/check`, body: {} }), [400, 400, 400, 400, 404, 401]),

  // AI action log, sandbox, emergency stop
  r('POST /api/companies/:companyId/agent-events', w => ({ path: `${C(w)}/agent-events`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/agent-events', w => ({ path: `${C(w)}/agent-events` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-events/summary', w => ({ path: `${C(w)}/agent-events/summary` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-events/sandbox', w => ({ path: `${C(w)}/agent-events/sandbox` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-events/settings', w => ({ path: `${C(w)}/agent-events/settings` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/agent-events/settings', w => ({ path: `${C(w)}/agent-events/settings`, body: { retentionDays: -1 } }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-events/settings/retention-preview', w => ({ path: `${C(w)}/agent-events/settings/retention-preview` }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-events/viewers', w => ({ path: `${C(w)}/agent-events/viewers` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/agent-sandbox', w => ({ path: `${C(w)}/agent-sandbox` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/agent-sandbox', w => ({ path: `${C(w)}/agent-sandbox`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/agent-sandbox/overrides/:userId', w => ({ path: `${C(w)}/agent-sandbox/overrides/${USER.member}`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  // 「もう一方の AI に聞く」 (chat-and-agents.md "Asking the other AI"): owner/admin, like the other AI settings.
  r('GET /api/companies/:companyId/second-opinion', w => ({ path: `${C(w)}/second-opinion` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/second-opinion', w => ({ path: `${C(w)}/second-opinion`, body: 'x' }), [400, 400, 403, 403, 404, 401]),

  // Task settings (tasks.md): every member reads, owner/admin change
  // The admin console's home: owner/admin; a department manager sees their departments' attention only
  r('GET /api/companies/:companyId/home', w => ({ path: `${C(w)}/home` }), [200, 200, 403, 200, 404, 401]),
  r('PUT /api/companies/:companyId/home/holidays-checked', w => ({ path: `${C(w)}/home/holidays-checked`, body: {} }), [400, 400, 403, 403, 404, 401]),
  // 「気になる動き」 (security-alerts.md): owners and admins only.
  r('GET /api/companies/:companyId/security-alerts', w => ({ path: `${C(w)}/security-alerts` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/security-alerts/settings', w => ({ path: `${C(w)}/security-alerts/settings`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/task-settings', w => ({ path: `${C(w)}/task-settings` }), MEMBERS),
  r('PUT /api/companies/:companyId/task-settings', w => ({ path: `${C(w)}/task-settings`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/features', w => ({ path: `${C(w)}/features` }), MEMBERS),
  r('PUT /api/companies/:companyId/features', w => ({ path: `${C(w)}/features`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  // 自分の設定 (受信を読む, AI が自動で進める; tasks.md): any member, their own only.
  r('GET /api/companies/:companyId/me/work-switches', w => ({ path: `${C(w)}/me/work-switches` }), MEMBERS),
  r('PUT /api/companies/:companyId/me/work-switches', w => ({ path: `${C(w)}/me/work-switches`, body: {} }), [400, 400, 400, 400, 404, 401]),
  // 見られる人 (records.md "Who can see it"): any member, only what they read is answered.
  r('POST /api/companies/:companyId/viewers', w => ({ path: `${C(w)}/viewers`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  // Absence and the delegate (代わりの人): the member, owner/admin, managers of a department the member belongs to.
  r('GET /api/companies/:companyId/absences', w => ({ path: `${C(w)}/absences` }), MEMBERS, 'the caller\'s own'),
  r('GET /api/companies/:companyId/absences', w => ({ path: `${C(w)}/absences`, query: `userId=${USER.member}` }), [200, 200, 200, 403, 404, 401],
    'the member\'s: the manager is not a manager of a department the member belongs to'),
  r('POST /api/companies/:companyId/absences', w => ({ path: `${C(w)}/absences`, body: {} }), [400, 400, 400, 400, 404, 401], 'the caller\'s own'),
  r('POST /api/companies/:companyId/absences', w => ({ path: `${C(w)}/absences`, body: { userId: USER.member } }), [400, 400, 400, 403, 404, 401],
    'the member\'s: the manager is not a manager of a department the member belongs to'),
  r('DELETE /api/companies/:companyId/absences/:absenceId', w => ({ path: `${C(w)}/absences/no-such-absence` }), [404, 404, 404, 404, 404, 401]),
  // Execution runs of 「AI の番」 (records.md "Execution runs"): every member, their own runs only
  r('GET /api/companies/:companyId/ai-runs', w => ({ path: `${C(w)}/ai-runs` }), MEMBERS),
  r('POST /api/companies/:companyId/ai-run-claims', w => ({ path: `${C(w)}/ai-run-claims`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/ai-runs/:runId', w => ({ path: `${C(w)}/ai-runs/no-such-run` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/ai-runs/:runId/renew', w => ({ path: `${C(w)}/ai-runs/no-such-run/renew`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/ai-runs/:runId/finish', w => ({ path: `${C(w)}/ai-runs/no-such-run/finish`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/ai-runs/:runId/retry', w => ({ path: `${C(w)}/ai-runs/no-such-run/retry` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/ai-runs/:runId/operations/:key/reconcile', w => ({ path: `${C(w)}/ai-runs/no-such-run/operations/k1/reconcile`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/me/agent-policy', w => ({ path: `${C(w)}/me/agent-policy` }), MEMBERS),
  r('GET /api/companies/:companyId/agent-stops', w => ({ path: `${C(w)}/agent-stops` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/agent-stops', w => ({ path: `${C(w)}/agent-stops`, body: { tool: 'no-such-tool' } }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/agent-stops/:stopId', w => ({ path: `${C(w)}/agent-stops/no-such-stop` }), [404, 404, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/events', w => ({ path: `${C(w)}/me/events` }), MEMBERS),

  // The company map (light ontology 4-2; records.md). On for this company (seed).
  r('GET /api/companies/:companyId/records/settings', w => ({ path: `${C(w)}/records/settings` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/records/settings', w => ({ path: `${C(w)}/records/settings`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/records/problems', w => ({ path: `${C(w)}/records/problems` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/records/reindex', w => ({ path: `${C(w)}/records/reindex`, body: {} }), [400, 400, 403, 403, 404, 401]),
  // What one meeting made twice (minutes.md "Outputs made once"): owner/admin list and merge.
  r('GET /api/companies/:companyId/records/meeting-duplicates', w => ({ path: `${C(w)}/records/meeting-duplicates` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/records/meeting-duplicates/merge', w => ({ path: `${C(w)}/records/meeting-duplicates/merge`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/records/types', w => ({ path: `${C(w)}/records/types` }), MEMBERS),
  r('GET /api/companies/:companyId/records/bundle-kinds', w => ({ path: `${C(w)}/records/bundle-kinds` }), MEMBERS),
  r('POST /api/companies/:companyId/records/query', w => ({ path: `${C(w)}/records/query`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('POST /api/companies/:companyId/records/find', w => ({ path: `${C(w)}/records/find`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('POST /api/companies/:companyId/records/find-home', w => ({ path: `${C(w)}/records/find-home`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId', w => ({ path: `${C(w)}/records/item/deal-nosuch01` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/my-turn', w => ({ path: `${C(w)}/records/my-turn` }), MEMBERS),
  r('POST /api/companies/:companyId/records/item', w => ({ path: `${C(w)}/records/item`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  // 「AI の番」 and decisions (milestone 4): any member; no object id in the URL (a linked record id
  // in the body is looked up behind the company handle: tests/unit/record-service-types.test.ts).
  r('GET /api/companies/:companyId/records/ai-turn', w => ({ path: `${C(w)}/records/ai-turn` }), MEMBERS),
  r('POST /api/companies/:companyId/records/decisions', w => ({ path: `${C(w)}/records/decisions`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/records-ai/ai-turn', () => ({ path: '/api/records-ai/ai-turn' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/decisions', () => ({ path: '/api/records-ai/decisions', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/companies/:companyId/records/item/:recordId/actions/:action', w => ({ path: `${C(w)}/records/item/deal-nosuch01/actions/start`, body: { expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/undo', w => ({ path: `${C(w)}/records/item/deal-nosuch01/undo`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId/history', w => ({ path: `${C(w)}/records/item/deal-nosuch01/history` }), [404, 404, 404, 404, 404, 401]),
  // Linking a file later: any member who reads the record and the file (a missing record → 404 for all).
  r('POST /api/companies/:companyId/records/item/:recordId/file-links', w => ({ path: `${C(w)}/records/item/deal-nosuch01/file-links`, body: { path: '営業部/a.md', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/file-links/remove', w => ({ path: `${C(w)}/records/item/deal-nosuch01/file-links/remove`, body: { path: '営業部/a.md', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/record-links', w => ({ path: `${C(w)}/records/item/deal-nosuch01/record-links`, body: { link: 'bundle', target: 'deal-nosuch02', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/record-links/remove', w => ({ path: `${C(w)}/records/item/deal-nosuch01/record-links/remove`, body: { link: 'bundle', target: 'deal-nosuch02', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  // The app opened a record (the turn-holder's first opening is kept): any member who reads it.
  r('POST /api/companies/:companyId/records/item/:recordId/opened', w => ({ path: `${C(w)}/records/item/deal-nosuch01/opened`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/share', w => ({ path: `${C(w)}/records/item/deal-nosuch01/share`, body: { folder: '営業部', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/members', w => ({ path: `${C(w)}/records/item/deal-nosuch01/members`, body: { add: [], expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/members/remove', w => ({ path: `${C(w)}/records/item/deal-nosuch01/members/remove`, body: { remove: [], expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId/members/choices', w => ({ path: `${C(w)}/records/item/deal-nosuch01/members/choices` }), [404, 404, 404, 404, 404, 401]),
  // 「非公開にする」 (records.md "Making a 案件・プロジェクト private"): a missing record → 404 for every member.
  r('GET /api/companies/:companyId/records/item/:recordId/make-private', w => ({ path: `${C(w)}/records/item/deal-nosuch01/make-private` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/make-private', w => ({ path: `${C(w)}/records/item/deal-nosuch01/make-private`, body: { folder: '営業部/x', expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/records-ai/item/:recordId/file-links', () => ({ path: '/api/records-ai/item/deal-nosuch01/file-links', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/item/:recordId/file-links/remove', () => ({ path: '/api/records-ai/item/deal-nosuch01/file-links/remove', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/companies/:companyId/me/record-tokens', w => ({ path: `${C(w)}/me/record-tokens`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('DELETE /api/companies/:companyId/me/record-tokens/:tokenId', w => ({ path: `${C(w)}/me/record-tokens/no-such-token` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/skill-uses', w => ({ path: `${C(w)}/me/skill-uses`, body: {} }), [400, 400, 400, 400, 404, 401]),
  // The Skill shelf is only for a company without the shared folder; this one has it (409
  // SKILL_SHELF_NOT_HERE). Who may do what in a company without it: tests/integration/skill-shelf.test.ts.
  r('GET /api/companies/:companyId/skill-shelf', w => ({ path: `${C(w)}/skill-shelf` }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf', w => ({ path: `${C(w)}/skill-shelf`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('GET /api/companies/:companyId/skill-shelf/:itemId/versions', w => ({ path: `${C(w)}/skill-shelf/no-such-item/versions` }), [409, 409, 409, 409, 404, 401]),
  r('GET /api/companies/:companyId/skill-shelf/:itemId/versions/:version', w => ({ path: `${C(w)}/skill-shelf/no-such-item/versions/${'0'.repeat(64)}` }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf/:itemId/restore', w => ({ path: `${C(w)}/skill-shelf/no-such-item/restore`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf/:itemId/unpublish', w => ({ path: `${C(w)}/skill-shelf/no-such-item/unpublish`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('DELETE /api/companies/:companyId/skill-shelf/:itemId/versions/:version', w => ({ path: `${C(w)}/skill-shelf/no-such-item/versions/${'0'.repeat(64)}` }), [409, 409, 409, 409, 404, 401]),
  r('DELETE /api/companies/:companyId/skill-shelf/:itemId', w => ({ path: `${C(w)}/skill-shelf/no-such-item` }), [409, 409, 409, 409, 404, 401]),
  r('GET /api/companies/:companyId/skill-shelf-requests', w => ({ path: `${C(w)}/skill-shelf-requests` }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf-requests', w => ({ path: `${C(w)}/skill-shelf-requests`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('GET /api/companies/:companyId/skill-shelf-requests/:requestId/files', w => ({ path: `${C(w)}/skill-shelf-requests/no-such-request/files` }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf-requests/:requestId/publish', w => ({ path: `${C(w)}/skill-shelf-requests/no-such-request/publish`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('POST /api/companies/:companyId/skill-shelf-requests/:requestId/decline', w => ({ path: `${C(w)}/skill-shelf-requests/no-such-request/decline`, body: {} }), [409, 409, 409, 409, 404, 401]),
  r('GET /api/companies/:companyId/me/skill-shelf',w => ({ path: `${C(w)}/me/skill-shelf` }), [409, 409, 409, 409, 404, 401]),
  // The AI's routes take a record token (Bearer), never a session: every caller here has only a session.
  r('GET /api/records-ai/types', () => ({ path: '/api/records-ai/types' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/my-turn', () => ({ path: '/api/records-ai/my-turn' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/query', () => ({ path: '/api/records-ai/query', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/item/:recordId', () => ({ path: '/api/records-ai/item/deal-nosuch01' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/item/:recordId/history', () => ({ path: '/api/records-ai/item/deal-nosuch01/history' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/item', () => ({ path: '/api/records-ai/item', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/item/:recordId/actions/:action', () => ({ path: '/api/records-ai/item/deal-nosuch01/actions/start', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/companies/:companyId/records/item/:recordId/versions/:version', w => ({ path: `${C(w)}/records/item/deal-nosuch01/versions/1` }), [404, 404, 404, 404, 404, 401]),

  // Key broker (「API キー」)
  r('GET /api/companies/:companyId/broker', w => ({ path: `${C(w)}/broker` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/broker/keys', w => ({ path: `${C(w)}/broker/keys`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/keys/:keyId/secret', w => ({ path: `${C(w)}/broker/keys/${w.key}/secret`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PATCH /api/companies/:companyId/broker/keys/:keyId', w => ({ path: `${C(w)}/broker/keys/${w.key}`, body: { displayName: 1 } }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/broker/keys/:keyId', w => ({ path: `${C(w)}/broker/keys/no-such-key` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service', w => ({ path: `${C(w)}/broker/services/gemini`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service/own-keys', w => ({ path: `${C(w)}/broker/services/gemini/own-keys`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service/read-only', w => ({ path: `${C(w)}/broker/services/hubspot/read-only`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service/default-key', w => ({ path: `${C(w)}/broker/services/gemini/default-key`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/relay-services/:service', w => ({ path: `${C(w)}/broker/relay-services/matrix-svc`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/broker/relay-services/:service', w => ({ path: `${C(w)}/broker/relay-services/no-such-service` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/settings', w => ({ path: `${C(w)}/broker/settings`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/broker/stop-all', w => ({ path: `${C(w)}/broker/stop-all`, body: 'x' }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/me/broker-tokens', w => ({ path: `${C(w)}/me/broker-tokens`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('DELETE /api/companies/:companyId/me/broker-tokens/:tokenId', w => ({ path: `${C(w)}/me/broker-tokens/${w.memberToken}` }), [404, 404, 200, 404, 404, 401],
    'the member\'s token: only its holder ends it'),
  r('GET /api/companies/:companyId/me/broker-keys', w => ({ path: `${C(w)}/me/broker-keys` }), MEMBERS),
  r('PUT /api/companies/:companyId/me/broker-keys/:service', w => ({ path: `${C(w)}/me/broker-keys/gemini`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('DELETE /api/companies/:companyId/me/broker-keys/:service', w => ({ path: `${C(w)}/me/broker-keys/no-such-service` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/broker/:service/*', () => ({ path: '/api/broker/gemini/v1beta/models' }), [401, 401, 401, 401, 401, 401], 'a session is not a relay token'),
  r('POST /api/broker/:service/*', () => ({ path: '/api/broker/gemini/v1beta/models', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a relay token'),
  r('PUT /api/broker/:service/*', () => ({ path: '/api/broker/gemini/v1beta/models', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a relay token'),
  r('PATCH /api/broker/:service/*', () => ({ path: '/api/broker/gemini/v1beta/models', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a relay token'),
  r('DELETE /api/broker/:service/*', () => ({ path: '/api/broker/gemini/v1beta/models' }), [401, 401, 401, 401, 401, 401], 'a session is not a relay token'),

  // Git. A POST here carries no git body: 415 means the caller got past sign-in and access.
  // In the company repository what a member may push is the push checker's (path rules).
  r('GET /api/git/repos/:companyId', w => ({ path: `/api/git/repos/${w.co}` }), MEMBERS),
  r('GET /api/git-http/:repo/info/refs', w => ({ path: `/api/git-http/${w.co}.git/info/refs`, query: 'service=git-upload-pack' }), [200, 200, 200, 200, 403, 401]),
  r('POST /api/git-http/:repo/git-upload-pack', w => ({ path: `/api/git-http/${w.co}.git/git-upload-pack` }), [415, 415, 415, 415, 403, 401]),
  r('POST /api/git-http/:repo/git-receive-pack', w => ({ path: `/api/git-http/${w.co}.git/git-receive-pack` }), [415, 415, 415, 415, 403, 401]),
  r('GET /api/git-http/:repo/HEAD', w => ({ path: `/api/git-http/${w.co}.git/HEAD` }), [200, 200, 200, 200, 403, 401]),
  r('GET /api/git-http/:company/scopes/:repo/info/refs', w => ({ path: `/api/git-http/${w.co}/scopes/${w.privateScope}.git/info/refs`, query: 'service=git-upload-pack' }), [200, 200, 404, 200, 404, 401]),
  r('GET /api/git-http/:company/scopes/:repo/info/refs', w => ({ path: `/api/git-http/${w.co}/scopes/${w.privateScope}.git/info/refs`, query: 'service=git-receive-pack' }), [200, 200, 404, 403, 404, 401],
    'the manager reads the private folder but may not write in it'),
  r('POST /api/git-http/:company/scopes/:repo/git-upload-pack', w => ({ path: `/api/git-http/${w.co}/scopes/${w.privateScope}.git/git-upload-pack` }), [415, 415, 404, 415, 404, 401]),
  r('POST /api/git-http/:company/scopes/:repo/git-receive-pack', w => ({ path: `/api/git-http/${w.co}/scopes/${w.privateScope}.git/git-receive-pack` }), [415, 415, 404, 403, 404, 401]),
  r('GET /api/git-http/:company/scopes/:repo/HEAD', w => ({ path: `/api/git-http/${w.co}/scopes/${w.privateScope}.git/HEAD` }), [200, 200, 404, 200, 404, 401]),

  // Connector plugins (plugins.md): owners and admins; an unknown plugin is 404 after the role check.
  r('GET /api/companies/:companyId/plugins', w => ({ path: `${C(w)}/plugins` }), [200, 200, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/plugins/:pluginId', w => ({ path: `${C(w)}/plugins/no-such-plugin` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId', w => ({ path: `${C(w)}/plugins/no-such-plugin`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/enabled', w => ({ path: `${C(w)}/plugins/no-such-plugin/enabled`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/mapping', w => ({ path: `${C(w)}/plugins/no-such-plugin/mapping`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/read-scope', w => ({ path: `${C(w)}/plugins/no-such-plugin/read-scope`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/mapping/restore', w => ({ path: `${C(w)}/plugins/no-such-plugin/mapping/restore`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/mapping/check', w => ({ path: `${C(w)}/plugins/no-such-plugin/mapping/check`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/import', w => ({ path: `${C(w)}/plugins/no-such-plugin/import`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/records/:recordId/operations/:operation', w => ({ path: `${C(w)}/plugins/no-such-plugin/records/deal-nosuch01/operations/update_deal`, body: {} }), [404, 404, 404, 404, 404, 401],
    'any member: the record (it does not exist), the operation\'s who and the field policies decide'),
  r('GET /api/companies/:companyId/plugins/:pluginId/operations/:operationId', w => ({ path: `${C(w)}/plugins/no-such-plugin/operations/no-such-op` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/undo', w => ({ path: `${C(w)}/plugins/no-such-plugin/operations/no-such-op/undo`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/reconcile', w => ({ path: `${C(w)}/plugins/no-such-plugin/operations/no-such-op/reconcile`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/records-ai/plugins', () => ({ path: '/api/records-ai/plugins' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  // Approval requests (approvals.md): any member reads what concerns them; approving is a session's, never the AI's.
  r('GET /api/companies/:companyId/approvals', w => ({ path: `${C(w)}/approvals`, query: 'scope=everyone' }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/approvals/:approvalId', w => ({ path: `${C(w)}/approvals/approval-nosuch001` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/approvals/:approvalId/approve', w => ({ path: `${C(w)}/approvals/approval-nosuch001/approve`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/approvals/:approvalId/send-back', w => ({ path: `${C(w)}/approvals/approval-nosuch001/send-back`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/approvals/:approvalId/withdraw', w => ({ path: `${C(w)}/approvals/approval-nosuch001/withdraw`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/approvals/:approvalId/same-as', w => ({ path: `${C(w)}/approvals/approval-nosuch001/same-as`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/records-ai/approvals', () => ({ path: '/api/records-ai/approvals' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/approvals/:approvalId', () => ({ path: '/api/records-ai/approvals/approval-nosuch001' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/companies/:companyId/plugins/:pluginId/create/:operation', w => ({ path: `${C(w)}/plugins/no-such-plugin/create/create_deal`, body: {} }), [409, 409, 409, 409, 404, 401],
    'any member: the plugin (not running here), the operation\'s who and its policy decide; never auto (milestone 4)'),
  r('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/recreate', w => ({ path: `${C(w)}/plugins/no-such-plugin/operations/no-such-op/recreate`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/plugins/:pluginId/calls/:call', w => ({ path: `${C(w)}/plugins/no-such-plugin/calls/diagnose`, body: {} }), [409, 409, 409, 409, 404, 401],
    'any member: the plugin (not running here) and the call\'s who decide'),
  r('GET /api/companies/:companyId/plugins/:pluginId/access-log', w => ({ path: `${C(w)}/plugins/no-such-plugin/access-log` }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/records-ai/plugins/:pluginId/calls/:call', () => ({ path: '/api/records-ai/plugins/no-such-plugin/calls/diagnose', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/plugins/:pluginId/create/:operation', () => ({ path: '/api/records-ai/plugins/no-such-plugin/create/create_deal', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/plugins/:pluginId/records/:recordId/operations/:operation', () => ({ path: '/api/records-ai/plugins/no-such-plugin/records/deal-nosuch01/operations/update_deal', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/plugins/:pluginId/operations/:operationId', () => ({ path: '/api/records-ai/plugins/no-such-plugin/operations/no-such-op' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/companies/:companyId/plugins/:pluginId/connection/renew', w => ({ path: `${C(w)}/plugins/no-such-plugin/connection/renew`, body: {} }), [404, 404, 403, 403, 404, 401]),

  // Outbound mail (outbound-mail.md): any member drafts; a draft is its author's only (404 for
  // everyone else, like a missing one). Sending, typed addresses, resolve and discard: the
  // session routes only — the AI's routes have none of them.
  r('POST /api/companies/:companyId/outbound-recipients', w => ({ path: `${C(w)}/outbound-recipients`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('POST /api/companies/:companyId/outbound', w => ({ path: `${C(w)}/outbound`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/outbound/:messageId', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001` }), [404, 404, 404, 404, 404, 401]),
  r('PUT /api/companies/:companyId/outbound/:messageId', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/outbound/:messageId/recipients', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/recipients` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/outbound/:messageId/recipients', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/recipients`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/outbound/:messageId/send', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/send`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/outbound/:messageId/resolve', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/resolve`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/outbound/:messageId/discard', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/discard`, body: {} }), [404, 404, 404, 404, 404, 401]),
  // PDF attachments (outbound-mail.md "Attachments"): the draft's author only, like every draft route.
  r('POST /api/companies/:companyId/outbound/:messageId/attachments', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/attachments`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('DELETE /api/companies/:companyId/outbound/:messageId/attachments/:sha256', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/attachments/0000000000000000000000000000000000000000000000000000000000000000?expectedVersion=1` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/outbound/:messageId/attachments/:sha256', w => ({ path: `${C(w)}/outbound/outbound_message-nosuch0000000001/attachments/0000000000000000000000000000000000000000000000000000000000000000` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/records-ai/outbound-recipients', () => ({ path: '/api/records-ai/outbound-recipients', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/outbound', () => ({ path: '/api/records-ai/outbound', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/outbound/:messageId', () => ({ path: '/api/records-ai/outbound/outbound_message-nosuch0000000001' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('PUT /api/records-ai/outbound/:messageId', () => ({ path: '/api/records-ai/outbound/outbound_message-nosuch0000000001', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/outbound/:messageId/attachments', () => ({ path: '/api/records-ai/outbound/outbound_message-nosuch0000000001/attachments', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('DELETE /api/records-ai/outbound/:messageId/attachments/:sha256', () => ({ path: '/api/records-ai/outbound/outbound_message-nosuch0000000001/attachments/0000000000000000000000000000000000000000000000000000000000000000' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),

  // The Google connection (google-connector.md): the client and members' grants are owner/admin;
  // a member's own permission is any member's; Google's return to the server is public.
  r('GET /api/companies/:companyId/google', w => ({ path: `${C(w)}/google` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/client', w => ({ path: `${C(w)}/google/client`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/enabled', w => ({ path: `${C(w)}/google/enabled`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/picker', w => ({ path: `${C(w)}/google/picker`, body: {} }), [404, 404, 403, 403, 404, 401], 'Google is not set up here: the owner / admin pass the role check and find no client'),
  r('DELETE /api/companies/:companyId/google/grants/:userId', w => ({ path: `${C(w)}/google/grants/pm-nobody` }), [404, 404, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/google', w => ({ path: `${C(w)}/me/google` }), MEMBERS),
  r('POST /api/companies/:companyId/me/google/connect', w => ({ path: `${C(w)}/me/google/connect`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('DELETE /api/companies/:companyId/me/google', w => ({ path: `${C(w)}/me/google` }), MEMBERS, 'nothing to stop: answers the member\'s own (empty) state'),
  // The minutes intake (minutes.md): the folder setting is owner/admin; a member checks their own calendar
  // (Google is not set up here: refused, nothing is read) and reads minutes they are the assignee or an attendee of.
  r('GET /api/companies/:companyId/google/minutes-folder', w => ({ path: `${C(w)}/google/minutes-folder` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/minutes-folder', w => ({ path: `${C(w)}/google/minutes-folder`, body: 'x' }), [400, 400, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/me/minutes/check', w => ({ path: `${C(w)}/me/minutes/check`, body: {} }), [403, 403, 403, 403, 404, 401], 'Google is not set up in this company: GOOGLE_STOPPED, nothing is read (no folder is needed since 2026-11-04)'),
  r('GET /api/companies/:companyId/me/minutes/item/:recordId/text', w => ({ path: `${C(w)}/me/minutes/item/minutes-nosuch01/text` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/minutes/item/:recordId/bundle', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/bundle`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/minutes/item/:recordId/no-bundle', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/no-bundle`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/me/minutes/item/:recordId/bundle-question', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/bundle-question` }), [404, 404, 404, 404, 404, 401]),
  // Meetings for their attendees (minutes.md): any member sees their own 「届きました」; the buttons
  // answer one of a meeting's people only (anyone else: the meeting does not exist — 404).
  r('GET /api/companies/:companyId/me/minutes/arrivals', w => ({ path: `${C(w)}/me/minutes/arrivals` }), MEMBERS, 'only meetings the member is on the list of'),
  r('POST /api/companies/:companyId/me/minutes/item/:recordId/read-request', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/read-request`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/minutes/item/:recordId/skip', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/skip`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('PUT /api/companies/:companyId/me/minutes/item/:recordId/auto-series', w => ({ path: `${C(w)}/me/minutes/item/meeting-nosuch01/auto-series`, body: { auto: true } }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/me/minutes/bundle-questions', w => ({ path: `${C(w)}/me/minutes/bundle-questions` }), MEMBERS, 'only the member\'s own meetings are answered'),
  r('GET /api/records-ai/minutes/:recordId/text', () => ({ path: '/api/records-ai/minutes/minutes-nosuch01/text' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/minutes/:recordId/bundle', () => ({ path: '/api/records-ai/minutes/meeting-nosuch01/bundle', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  // The member's own notices (notifications.md): any member, their own only (no user id in the path).
  r('GET /api/companies/:companyId/me/notifications', w => ({ path: `${C(w)}/me/notifications` }), MEMBERS),
  r('POST /api/companies/:companyId/me/notifications/read', w => ({ path: `${C(w)}/me/notifications/read`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/me/notifications/settings', w => ({ path: `${C(w)}/me/notifications/settings` }), MEMBERS),
  r('PUT /api/companies/:companyId/me/notifications/settings', w => ({ path: `${C(w)}/me/notifications/settings`, body: {} }), [400, 400, 400, 400, 404, 401]),
  // Google Drive (google-drive.md): the member's own pick tickets and picks (any member); the AI's routes need a record token.
  r('POST /api/companies/:companyId/me/google/drive/picker', w => ({ path: `${C(w)}/me/google/drive/picker`, body: {} }), [400, 400, 400, 400, 404, 401], 'released apps\' Picker window: fails closed for everyone with a body'),
  r('POST /api/companies/:companyId/me/google/drive/pick-tickets', w => ({ path: `${C(w)}/me/google/drive/pick-tickets`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/me/google/drive/pick-tickets/:ticketId', w => ({ path: `${C(w)}/me/google/drive/pick-tickets/ticket-nosuch` }), [404, 404, 404, 404, 404, 401], 'the member\'s own ticket only'),
  r('DELETE /api/companies/:companyId/me/google/drive/pick-tickets/:ticketId', w => ({ path: `${C(w)}/me/google/drive/pick-tickets/ticket-nosuch` }), [404, 404, 404, 404, 404, 401], 'the member\'s own ticket only'),
  r('POST /api/companies/:companyId/me/google/drive/picks', w => ({ path: `${C(w)}/me/google/drive/picks`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/me/google/drive/files', w => ({ path: `${C(w)}/me/google/drive/files` }), MEMBERS, 'only the caller\'s own picks and puts (google-drive.test.ts)'),
  r('GET /api/records-ai/google/drive/status', () => ({ path: '/api/records-ai/google/drive/status' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/google/drive/read', () => ({ path: '/api/records-ai/google/drive/read', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/google/drive/put', () => ({ path: '/api/records-ai/google/drive/put', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/google/drive/puts/:putId', () => ({ path: '/api/records-ai/google/drive/puts/drive-put-nosuch' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/google-picker', () => ({ path: '/api/google-picker' }), [200, 200, 200, 200, 200, 200], 'public: the static Picker page; it holds no secret (the pick ticket is in the URL fragment)'),
  r('POST /api/google-picker/config', () => ({ path: '/api/google-picker/config', body: {} }), [410, 410, 410, 410, 410, 410], 'public: the one-time pick ticket is the proof; no ticket, nothing'),
  r('POST /api/google-picker/result', () => ({ path: '/api/google-picker/result', body: {} }), [410, 410, 410, 410, 410, 410], 'public: the one-time pick ticket is the proof; no ticket, nothing'),
  r('GET /api/oauth/:provider/callback', () => ({ path: '/api/oauth/google/callback' }), [400, 400, 400, 400, 400, 400], 'public: Google sends the browser back without a session; no state finds nothing'),
  // 「今日の予定」 (calendar.md): any member, their own calendar only (nothing in the request names
  // another person); Google is not set up here, so the answer is an empty list with a reason.
  r('GET /api/companies/:companyId/me/calendar/today', w => ({ path: `${C(w)}/me/calendar/today` }), MEMBERS, 'Google not set up: an empty list and `stopped`, nothing read'),

  // Invitations
  r('GET /api/companies/:companyId/invitations', w => ({ path: `${C(w)}/invitations` }), [200, 200, 403, 403, 403, 401]),
  r('POST /api/companies/:companyId/invitations', w => ({ path: `${C(w)}/invitations`, body: { role: 'nobody' } }), [400, 400, 403, 403, 403, 401]),
  r('DELETE /api/companies/:companyId/invitations/:invitationId', w => ({ path: `${C(w)}/invitations/no-such-invitation` }), [404, 404, 403, 403, 403, 401]),

  // Lanes (server.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // 「仕事の道具をつなぐ」 (google-connector.md): the admin's company-level feature switch; a member's 「あとで」.
  r('PUT /api/companies/:companyId/google/features', w => ({ path: `${C(w)}/google/features`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/me/google/seen', w => ({ path: `${C(w)}/me/google/seen` }), MEMBERS, 'the member\'s own seen list (nothing offered while Google is not set up)'),
  r('PUT /api/companies/:companyId/me/slack/seen', w => ({ path: `${C(w)}/me/slack/seen` }), MEMBERS, 'the member\'s own seen list (nothing offered while Slack is not set up)'),
  // 「つないでいるサービス」 (connector-roles.md): owners / admins; a role or connector name is not an object.
  r('GET /api/companies/:companyId/connectors', w => ({ path: `${C(w)}/connectors` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/connector-roles/:role', w => ({ path: `${C(w)}/connector-roles/calendar`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/connectors/:connectorId/enabled', w => ({ path: `${C(w)}/connectors/google/enabled`, body: {} }), [400, 400, 403, 403, 404, 401]),
  // 受信を読む … off / on (google-connector.md): any member, their own grant only.
  r('PUT /api/companies/:companyId/me/google/features', w => ({ path: `${C(w)}/me/google/features`, body: {} }), [400, 400, 400, 400, 404, 401]),
  // 「本人の許可で中継する」 (google-connector.md "The relay"): the settings are owners / admins; a member reads their own.
  r('GET /api/companies/:companyId/google/relay', w => ({ path: `${C(w)}/google/relay` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/relay', w => ({ path: `${C(w)}/google/relay`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/google/relay/members/:userId', w => ({ path: `${C(w)}/google/relay/members/pm-nobody`, body: { stopped: true } }), [404, 404, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/google/relay/shared-drives', w => ({ path: `${C(w)}/google/relay/shared-drives`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/google/relay/shared-drives/:driveId', w => ({ path: `${C(w)}/google/relay/shared-drives/0AnoSuchDrive000000` }), [404, 404, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/google/relay', w => ({ path: `${C(w)}/me/google/relay` }), MEMBERS, 'the member\'s own relay view and records'),
  // The Slack connection (slack-connector.md): the company's app and members' grants are owner/admin;
  // a member's own permission is theirs. Slack's events are public: an unsigned request is an empty 401 for everyone.
  r('GET /api/companies/:companyId/slack', w => ({ path: `${C(w)}/slack` }), [200, 200, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/slack/app', w => ({ path: `${C(w)}/slack/app`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/slack/enabled', w => ({ path: `${C(w)}/slack/enabled`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/slack/grants/:userId', w => ({ path: `${C(w)}/slack/grants/pm-nobody` }), [404, 404, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/slack', w => ({ path: `${C(w)}/me/slack` }), MEMBERS),
  r('POST /api/companies/:companyId/me/slack/connect', w => ({ path: `${C(w)}/me/slack/connect`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('PUT /api/companies/:companyId/me/slack/features', w => ({ path: `${C(w)}/me/slack/features`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('DELETE /api/companies/:companyId/me/slack', w => ({ path: `${C(w)}/me/slack` }), MEMBERS, 'nothing to stop: answers the member\'s own (empty) state'),
  r('POST /api/slack/events/:companyId', w => ({ path: `/api/slack/events/${w.co}`, body: {} }), [401, 401, 401, 401, 401, 401], 'public: Slack signs with the company\'s own signing secret; unsigned → 401'),
  // The card's 元のスレッド (outbound-mail.md "Replies"): any member, only a record they read; a missing one is 404.
  r('GET /api/companies/:companyId/threads/:recordId', w => ({ path: `${C(w)}/threads/interaction-nosuch01` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/records-ai/threads/:recordId', () => ({ path: '/api/records-ai/threads/interaction-nosuch01' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  // lane A ▲
  // lane B ▼
  // Matching people and companies (名寄せ, identity.md): any member, only records they can read;
  // an unreadable or missing 相手 / proposal is one answer (404).
  r('GET /api/companies/:companyId/identities/records/:recordId', w => ({ path: `${C(w)}/identities/records/customer-nosuch01` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/identities/records/:recordId/split', w => ({ path: `${C(w)}/identities/records/customer-nosuch01/split` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/identities/proposals', w => ({ path: `${C(w)}/identities/proposals` }), MEMBERS),
  r('POST /api/companies/:companyId/identities/proposals', w => ({ path: `${C(w)}/identities/proposals`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('POST /api/companies/:companyId/identities/proposals/:proposalId/approve', w => ({ path: `${C(w)}/identities/proposals/no-such-proposal/approve` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/identities/proposals/:proposalId/reject', w => ({ path: `${C(w)}/identities/proposals/no-such-proposal/reject` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/records-ai/identities/proposals', () => ({ path: '/api/records-ai/identities/proposals', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('GET /api/records-ai/identities/records/:recordId', () => ({ path: '/api/records-ai/identities/records/customer-nosuch01' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  // Messages that came in (来た連絡, inbox.md): settings read by any member, changed by owners/admins;
  // everything else is the caller's own (status, set-aside list) or what they can read (department, claim).
  r('GET /api/companies/:companyId/inbox-settings', w => ({ path: `${C(w)}/inbox-settings` }), MEMBERS),
  r('PUT /api/companies/:companyId/inbox-settings', w => ({ path: `${C(w)}/inbox-settings`, body: { multipleTo: 'nobody' } }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/inbox/status', w => ({ path: `${C(w)}/inbox/status` }), MEMBERS),
  r('POST /api/companies/:companyId/inbox/backfill', w => ({ path: `${C(w)}/inbox/backfill`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/inbox/set-aside', w => ({ path: `${C(w)}/inbox/set-aside` }), MEMBERS),
  r('GET /api/companies/:companyId/inbox/department', w => ({ path: `${C(w)}/inbox/department` }), MEMBERS),
  r('POST /api/companies/:companyId/inbox/items/:recordId/claim', w => ({ path: `${C(w)}/inbox/items/interaction-nosuch01/claim`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/records-ai/inbox/items/:recordId', () => ({ path: '/api/records-ai/inbox/items/interaction-nosuch01' }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/inbox/items/:recordId/judgement', () => ({ path: '/api/records-ai/inbox/items/interaction-nosuch01/judgement', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  r('POST /api/records-ai/inbox/items/:recordId/reply-check', () => ({ path: '/api/records-ai/inbox/items/interaction-nosuch01/reply-check', body: {} }), [401, 401, 401, 401, 401, 401], 'a session is not a record token'),
  // A plugin screen's bridge (plugin-frame.md): any member's session; a plugin nobody granted is the bridge's one 403.
  r('POST /api/companies/:companyId/plugin-bridge', w => ({ path: `${C(w)}/plugin-bridge`, body: { pluginId: 'no-such-plugin', version: '0.1.0', op: 'records.query', args: { type: 'deal' } } }), [403, 403, 403, 403, 404, 401]),
  // lane B ▲
  // lane C ▼
  // Plugin packages for the members' apps (plan C2): any member, only a version their policy lists (none here: 404).
  r('GET /api/companies/:companyId/plugins/:pluginId/package/:version', w => ({ path: `${C(w)}/plugins/no-such-plugin/package/0.1.0` }), [404, 404, 404, 404, 404, 401]),
  // Business roles (plan C3, plugin-roles.md): the company's assignment is owner/admin; a まとまり's override
  // also its department's manager (the plugin and the まとまり are looked up first: 404 for everyone here).
  r('GET /api/companies/:companyId/plugins/:pluginId/roles', w => ({ path: `${C(w)}/plugins/no-such-plugin/roles` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/roles/:role', w => ({ path: `${C(w)}/plugins/no-such-plugin/roles/approver`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/roles/:role/bundles/:recordId', w => ({ path: `${C(w)}/plugins/no-such-plugin/roles/approver/bundles/deal-nosuch01`, body: {} }), [404, 404, 404, 404, 404, 401]),
  // A business plugin's steps (plan C5, plugin-steps.md): the company's Skill per step is owner/admin; a member's
  // 「AI の番」 of steps, the steps on a record and a person's start are any member's (the record decides: 404 here).
  r('GET /api/companies/:companyId/plugins/:pluginId/step-skills', w => ({ path: `${C(w)}/plugins/no-such-plugin/step-skills` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/step-skills/:step', w => ({ path: `${C(w)}/plugins/no-such-plugin/step-skills/work`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/plugins/:pluginId/step-settings/:step', w => ({ path: `${C(w)}/plugins/no-such-plugin/step-settings/work`, body: {} }), [404, 404, 403, 403, 404, 401]),
  r('GET /api/companies/:companyId/me/plugin-step-turns', w => ({ path: `${C(w)}/me/plugin-step-turns` }), MEMBERS),
  r('GET /api/companies/:companyId/me/plugin-steps/records/:recordId', w => ({ path: `${C(w)}/me/plugin-steps/records/deal-nosuch01` }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/me/plugin-steps/consultations', w => ({ path: `${C(w)}/me/plugin-steps/consultations`, body: {} }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/me/plugin-steps/consultations/:conversationId', w => ({ path: `${C(w)}/me/plugin-steps/consultations/conv-none` }), MEMBERS),
  r('POST /api/companies/:companyId/me/plugin-steps/records/:recordId/:pluginId/:step/start', w => ({ path: `${C(w)}/me/plugin-steps/records/deal-nosuch01/no-such-plugin/work/start`, body: {} }), [404, 404, 404, 404, 404, 401]),
  // lane C ▲
]

/**
 * The cross-company axis: `req(w, id)` is sent once with the other company's
 * object (`other(w)`) and once with an id that exists nowhere (`missing`);
 * both answers must be the same.
 */
interface CrossRow { route: string; req: (w: World, id: string) => Req; other: (w: World) => string; missing?: string }
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000c0de'
const x = (route: string, req: CrossRow['req'], other: CrossRow['other'], missing?: string): CrossRow => ({ route, req, other, missing })
const D = (w: World, id: string) => `${C(w)}/departments/${id}`
const GIT_SCOPE = (w: World, id: string) => `/api/git-http/${w.co}/scopes/${id}.git`

const CROSS: CrossRow[] = [
  x('GET /api/companies/:companyId/departments/:id', (w, id) => ({ path: D(w, id) }), w => w.other.department),
  x('PUT /api/companies/:companyId/departments/:id', (w, id) => ({ path: D(w, id), body: { name: '乗っ取り' } }), w => w.other.department),
  x('DELETE /api/companies/:companyId/departments/:id', (w, id) => ({ path: D(w, id) }), w => w.other.department),
  x('GET /api/companies/:companyId/departments/:id/stats', (w, id) => ({ path: `${D(w, id)}/stats` }), w => w.other.department),
  x('GET /api/companies/:companyId/departments/:id/managers', (w, id) => ({ path: `${D(w, id)}/managers` }), w => w.other.department),
  x('PUT /api/companies/:companyId/departments/:id/managers', (w, id) => ({ path: `${D(w, id)}/managers`, body: { userIds: [] } }), w => w.other.department),
  x('GET /api/companies/:companyId/departments/:id/members', (w, id) => ({ path: `${D(w, id)}/members` }), w => w.other.department),
  x('PUT /api/companies/:companyId/departments/:id/members', (w, id) => ({ path: `${D(w, id)}/members`, body: { userIds: [] } }), w => w.other.department),

  x('PATCH /api/companies/:companyId/permissions/rules/:ruleId', (w, id) => ({ path: `${C(w)}/permissions/rules/${id}`, body: { canRead: true, canWrite: false, force: true } }), w => w.other.rule),
  x('DELETE /api/companies/:companyId/permissions/rules/:ruleId', (w, id) => ({ path: `${C(w)}/permissions/rules/${id}`, query: 'force=true' }), w => w.other.rule),
  x('DELETE /api/companies/:companyId/permissions/scopes/:scopeId/rules', (w, id) => ({ path: `${C(w)}/permissions/scopes/${id}/rules`, query: 'force=true' }), w => w.other.scope),
  x('POST /api/companies/:companyId/permissions/scopes/:scopeId/move', (w, id) => ({ path: `${C(w)}/permissions/scopes/${id}/move`, body: { toPath: '経理部', force: true } }), w => w.other.scope),

  x('GET /api/companies/:companyId/private-folders/:scopeId', (w, id) => ({ path: `${C(w)}/private-folders/${id}` }), w => w.other.privateScope),
  x('PUT /api/companies/:companyId/private-folders/:scopeId/members', (w, id) => ({ path: `${C(w)}/private-folders/${id}/members`, body: { viewers: [], editors: [] } }), w => w.other.privateScope),
  x('POST /api/companies/:companyId/private-folders/:scopeId/make-public', (w, id) => ({ path: `${C(w)}/private-folders/${id}/make-public` }), w => w.other.privateScope),
  x('DELETE /api/companies/:companyId/private-folders/:scopeId', (w, id) => ({ path: `${C(w)}/private-folders/${id}`, query: `confirm=${encodeURIComponent(w.other.privateName)}` }), w => w.other.privateScope),
  x('GET /api/git-http/:company/scopes/:repo/info/refs', (w, id) => ({ path: `${GIT_SCOPE(w, id)}/info/refs`, query: 'service=git-receive-pack' }), w => w.other.privateScope),
  x('POST /api/git-http/:company/scopes/:repo/git-upload-pack', (w, id) => ({ path: `${GIT_SCOPE(w, id)}/git-upload-pack` }), w => w.other.privateScope),
  x('POST /api/git-http/:company/scopes/:repo/git-receive-pack', (w, id) => ({ path: `${GIT_SCOPE(w, id)}/git-receive-pack` }), w => w.other.privateScope),
  x('GET /api/git-http/:company/scopes/:repo/HEAD', (w, id) => ({ path: `${GIT_SCOPE(w, id)}/HEAD` }), w => w.other.privateScope),

  x('PUT /api/companies/:companyId/members/:userId/role', (w, id) => ({ path: `${C(w)}/members/${id}/role`, body: { role: 'admin' } }), w => w.other.member, 'pm-nobody'),
  x('DELETE /api/companies/:companyId/members/:userId', (w, id) => ({ path: `${C(w)}/members/${id}` }), w => w.other.member, 'pm-nobody'),
  x('PUT /api/companies/:companyId/agent-sandbox/overrides/:userId', (w, id) => ({ path: `${C(w)}/agent-sandbox/overrides/${id}`, body: { mode: 'off' } }), w => w.other.member, 'pm-nobody'),
  x('DELETE /api/companies/:companyId/agent-stops/:stopId', (w, id) => ({ path: `${C(w)}/agent-stops/${id}` }), w => w.other.stop),

  x('PUT /api/companies/:companyId/broker/keys/:keyId/secret', (w, id) => ({ path: `${C(w)}/broker/keys/${id}/secret`, body: { secret: 'fake-test-key-NOT-REAL-cross-0123456789' } }), w => w.other.key),
  x('PATCH /api/companies/:companyId/broker/keys/:keyId', (w, id) => ({ path: `${C(w)}/broker/keys/${id}`, body: { displayName: '乗っ取り' } }), w => w.other.key),
  x('DELETE /api/companies/:companyId/broker/keys/:keyId', (w, id) => ({ path: `${C(w)}/broker/keys/${id}` }), w => w.other.key),
  x('DELETE /api/companies/:companyId/broker/relay-services/:service', (w, id) => ({ path: `${C(w)}/broker/relay-services/${id}` }), w => w.other.relayService, 'nosuchservice'),
  x('DELETE /api/companies/:companyId/me/broker-tokens/:tokenId', (w, id) => ({ path: `${C(w)}/me/broker-tokens/${id}` }), w => w.other.token),

  x('GET /api/companies/:companyId/records/item/:recordId', (w, id) => ({ path: `${C(w)}/records/item/${id}` }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/actions/:action', (w, id) => ({ path: `${C(w)}/records/item/${id}/actions/start`, body: { expectedVersion: 0 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/undo', (w, id) => ({ path: `${C(w)}/records/item/${id}/undo`, body: { version: 1, expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/records/item/:recordId/history', (w, id) => ({ path: `${C(w)}/records/item/${id}/history` }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/file-links', (w, id) => ({ path: `${C(w)}/records/item/${id}/file-links`, body: { path: '営業部/a.md', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/file-links/remove', (w, id) => ({ path: `${C(w)}/records/item/${id}/file-links/remove`, body: { path: '営業部/a.md', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/record-links', (w, id) => ({ path: `${C(w)}/records/item/${id}/record-links`, body: { link: 'related', target: 'task-nosuch02', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/record-links/remove', (w, id) => ({ path: `${C(w)}/records/item/${id}/record-links/remove`, body: { link: 'related', target: 'task-nosuch02', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/opened', (w, id) => ({ path: `${C(w)}/records/item/${id}/opened`, body: {} }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/share', (w, id) => ({ path: `${C(w)}/records/item/${id}/share`, body: { folder: '営業部', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/members', (w, id) => ({ path: `${C(w)}/records/item/${id}/members`, body: { add: [], expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/members/remove', (w, id) => ({ path: `${C(w)}/records/item/${id}/members/remove`, body: { remove: [], expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/records/item/:recordId/members/choices', (w, id) => ({ path: `${C(w)}/records/item/${id}/members/choices` }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/records/item/:recordId/make-private', (w, id) => ({ path: `${C(w)}/records/item/${id}/make-private` }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/records/item/:recordId/make-private', (w, id) => ({ path: `${C(w)}/records/item/${id}/make-private`, body: { folder: '営業部/x', expectedVersion: 1 } }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/records/item/:recordId/versions/:version', (w, id) => ({ path: `${C(w)}/records/item/${id}/versions/1` }), w => w.other.record, 'deal-nosuch01'),

  x('GET /api/companies/:companyId/ai-runs/:runId', (w, id) => ({ path: `${C(w)}/ai-runs/${id}` }), w => w.other.aiRun),
  x('POST /api/companies/:companyId/ai-runs/:runId/renew', (w, id) => ({ path: `${C(w)}/ai-runs/${id}/renew`, body: { generation: 1 } }), w => w.other.aiRun),
  x('POST /api/companies/:companyId/ai-runs/:runId/finish', (w, id) => ({ path: `${C(w)}/ai-runs/${id}/finish`, body: { generation: 1, outcome: 'done' } }), w => w.other.aiRun),
  x('POST /api/companies/:companyId/ai-runs/:runId/retry', (w, id) => ({ path: `${C(w)}/ai-runs/${id}/retry` }), w => w.other.aiRun),
  x('POST /api/companies/:companyId/ai-runs/:runId/operations/:key/reconcile', (w, id) => ({ path: `${C(w)}/ai-runs/${id}/operations/k1/reconcile`, body: { done: true } }), w => w.other.aiRun),

  x('DELETE /api/companies/:companyId/me/record-tokens/:tokenId', (w, id) => ({ path: `${C(w)}/me/record-tokens/${id}` }), w => w.other.recordToken),

  // A package listed only for the other company (available_to) is a plugin that does not exist here.
  x('GET /api/companies/:companyId/plugins/:pluginId', (w, id) => ({ path: `${C(w)}/plugins/${id}` }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId', (w, id) => ({ path: `${C(w)}/plugins/${id}`, body: { version: '0.1.0', keyId: null } }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/enabled', (w, id) => ({ path: `${C(w)}/plugins/${id}/enabled`, body: { enabled: true } }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/mapping', (w, id) => ({ path: `${C(w)}/plugins/${id}/mapping`, body: { text: 'deal: {}' } }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/read-scope', (w, id) => ({ path: `${C(w)}/plugins/${id}/read-scope`, body: { userIds: [] } }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/import', (w, id) => ({ path: `${C(w)}/plugins/${id}/import`, body: {} }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/records/:recordId/operations/:operation', (w, id) => ({ path: `${C(w)}/plugins/other-sales/records/${id}/operations/update_deal`, body: { expectedVersion: 1, fields: { next_step: '乗っ取り' } } }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/plugins/:pluginId/operations/:operationId', (w, id) => ({ path: `${C(w)}/plugins/other-sales/operations/${id}` }), w => w.other.operation, 'no-such-op'),
  x('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/undo', (w, id) => ({ path: `${C(w)}/plugins/other-sales/operations/${id}/undo`, body: {} }), w => w.other.operation, 'no-such-op'),
  x('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/reconcile', (w, id) => ({ path: `${C(w)}/plugins/other-sales/operations/${id}/reconcile`, body: {} }), w => w.other.operation, 'no-such-op'),
  x('POST /api/companies/:companyId/plugins/:pluginId/calls/:call', (w, id) => ({ path: `${C(w)}/plugins/${id}/calls/diagnose`, body: {} }), w => w.other.plugin, 'no-such-plugin'),
  x('GET /api/companies/:companyId/plugins/:pluginId/access-log', (w, id) => ({ path: `${C(w)}/plugins/${id}/access-log` }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/create/:operation', (w, id) => ({ path: `${C(w)}/plugins/${id}/create/create_deal`, body: { title: '乗っ取り', fields: {} } }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/operations/:operationId/recreate', (w, id) => ({ path: `${C(w)}/plugins/other-sales/operations/${id}/recreate`, body: { confirm: true } }), w => w.other.operation, 'no-such-op'),
  x('GET /api/companies/:companyId/me/minutes/item/:recordId/text', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/text` }), w => w.other.record, 'minutes-nosuch01'),
  x('POST /api/companies/:companyId/me/minutes/item/:recordId/bundle', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/bundle`, body: { bundleId: id } }), w => w.other.record, 'meeting-nosuch01'),
  x('POST /api/companies/:companyId/me/minutes/item/:recordId/no-bundle', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/no-bundle`, body: {} }), w => w.other.record, 'meeting-nosuch01'),
  x('POST /api/companies/:companyId/me/minutes/item/:recordId/read-request', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/read-request`, body: {} }), w => w.other.record, 'meeting-nosuch01'),
  x('POST /api/companies/:companyId/me/minutes/item/:recordId/skip', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/skip`, body: {} }), w => w.other.record, 'meeting-nosuch01'),
  x('PUT /api/companies/:companyId/me/minutes/item/:recordId/auto-series', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/auto-series`, body: { auto: true } }), w => w.other.record, 'meeting-nosuch01'),
  x('GET /api/companies/:companyId/me/minutes/item/:recordId/bundle-question', (w, id) => ({ path: `${C(w)}/me/minutes/item/${id}/bundle-question` }), w => w.other.record, 'meeting-nosuch01'),
  x('DELETE /api/companies/:companyId/google/grants/:userId', (w, id) => ({ path: `${C(w)}/google/grants/${id}` }), w => w.other.googleGrant, 'pm-nobody'),
  x('PUT /api/companies/:companyId/google/relay/members/:userId', (w, id) => ({ path: `${C(w)}/google/relay/members/${id}`, body: { stopped: true } }), w => w.other.googleGrant, 'pm-nobody'),
  x('DELETE /api/companies/:companyId/google/relay/shared-drives/:driveId', (w, id) => ({ path: `${C(w)}/google/relay/shared-drives/${id}` }), w => w.other.sharedDrive, '0AnoSuchDrive000000'),
  x('POST /api/companies/:companyId/plugins/:pluginId/connection/renew', (w, id) => ({ path: `${C(w)}/plugins/${id}/connection/renew`, body: {} }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/mapping/restore', (w, id) => ({ path: `${C(w)}/plugins/${id}/mapping/restore`, body: { version: 1 } }), w => w.other.plugin, 'no-such-plugin'),
  x('POST /api/companies/:companyId/plugins/:pluginId/mapping/check', (w, id) => ({ path: `${C(w)}/plugins/${id}/mapping/check`, body: {} }), w => w.other.plugin, 'no-such-plugin'),

  x('GET /api/companies/:companyId/approvals/:approvalId', (w, id) => ({ path: `${C(w)}/approvals/${id}` }), w => w.other.approval, 'approval-nosuch001'),
  x('POST /api/companies/:companyId/approvals/:approvalId/approve', (w, id) => ({ path: `${C(w)}/approvals/${id}/approve`, body: { hash: `sha256:${'0'.repeat(64)}`, reason: '乗っ取り' } }), w => w.other.approval, 'approval-nosuch001'),
  x('POST /api/companies/:companyId/approvals/:approvalId/send-back', (w, id) => ({ path: `${C(w)}/approvals/${id}/send-back`, body: { reason: '乗っ取り' } }), w => w.other.approval, 'approval-nosuch001'),
  x('POST /api/companies/:companyId/approvals/:approvalId/withdraw', (w, id) => ({ path: `${C(w)}/approvals/${id}/withdraw`, body: {} }), w => w.other.approval, 'approval-nosuch001'),
  x('POST /api/companies/:companyId/approvals/:approvalId/same-as', (w, id) => ({ path: `${C(w)}/approvals/${id}/same-as`, body: { recordId: id } }), w => w.other.approval, 'approval-nosuch001'),
  x('GET /api/companies/:companyId/outbound/:messageId', (w, id) => ({ path: `${C(w)}/outbound/${id}` }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('PUT /api/companies/:companyId/outbound/:messageId', (w, id) => ({ path: `${C(w)}/outbound/${id}`, body: { expectedVersion: 1, body: '乗っ取り' } }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('GET /api/companies/:companyId/outbound/:messageId/recipients', (w, id) => ({ path: `${C(w)}/outbound/${id}/recipients` }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('POST /api/companies/:companyId/outbound/:messageId/recipients', (w, id) => ({ path: `${C(w)}/outbound/${id}/recipients`, body: { email: 'spy@attacker.example' } }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('POST /api/companies/:companyId/outbound/:messageId/send', (w, id) => ({ path: `${C(w)}/outbound/${id}/send`, body: { hash: `sha256:${'0'.repeat(64)}` } }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('POST /api/companies/:companyId/outbound/:messageId/resolve', (w, id) => ({ path: `${C(w)}/outbound/${id}/resolve`, body: { sent: true } }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('POST /api/companies/:companyId/outbound/:messageId/discard', (w, id) => ({ path: `${C(w)}/outbound/${id}/discard`, body: {} }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('POST /api/companies/:companyId/outbound/:messageId/attachments', (w, id) => ({ path: `${C(w)}/outbound/${id}/attachments`, body: { expectedVersion: 1, name: '乗っ取り.pdf', contentBase64: Buffer.from('%PDF-1.7 x').toString('base64') } }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('DELETE /api/companies/:companyId/outbound/:messageId/attachments/:sha256', (w, id) => ({ path: `${C(w)}/outbound/${id}/attachments/0000000000000000000000000000000000000000000000000000000000000000?expectedVersion=1` }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),
  x('GET /api/companies/:companyId/outbound/:messageId/attachments/:sha256', (w, id) => ({ path: `${C(w)}/outbound/${id}/attachments/0000000000000000000000000000000000000000000000000000000000000000` }), w => w.other.outboundMail, 'outbound_message-nosuch0000000001'),

  x('DELETE /api/companies/:companyId/invitations/:invitationId', (w, id) => ({ path: `${C(w)}/invitations/${id}` }), w => w.other.invitation),
  x('DELETE /api/companies/:companyId/absences/:absenceId', (w, id) => ({ path: `${C(w)}/absences/${id}` }), w => w.other.absence),
  x('GET /api/companies/:companyId/me/google/drive/pick-tickets/:ticketId', (w, id) => ({ path: `${C(w)}/me/google/drive/pick-tickets/${id}` }), w => w.other.pickTicket),
  x('DELETE /api/companies/:companyId/me/google/drive/pick-tickets/:ticketId', (w, id) => ({ path: `${C(w)}/me/google/drive/pick-tickets/${id}` }), w => w.other.pickTicket),
  x('PATCH /api/companies/:companyId/groups/:groupId', (w, id) => ({ path: `${C(w)}/groups/${id}`, body: { name: '乗っ取り' } }), w => w.other.group),
  x('PUT /api/companies/:companyId/groups/:groupId/members', (w, id) => ({ path: `${C(w)}/groups/${id}/members`, body: { userIds: [] } }), w => w.other.group),
  x('DELETE /api/companies/:companyId/groups/:groupId', (w, id) => ({ path: `${C(w)}/groups/${id}` }), w => w.other.group),
  x('GET /api/companies/:companyId/jobs/:jobId', (w, id) => ({ path: `${C(w)}/jobs/${id}` }), w => w.other.job, NO_SUCH_JOB),
  x('GET /api/companies/:companyId/jobs/:jobId/occurrences', (w, id) => ({ path: `${C(w)}/jobs/${id}/occurrences` }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/jobs/:jobId/occurrences/:occurrenceId/retry', (w, id) => ({ path: `${C(w)}/jobs/${id}/occurrences/${OTHER_OCC}/retry` }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile', (w, id) => ({ path: `${C(w)}/jobs/${id}/occurrences/${OTHER_OCC}/operations/k1/reconcile`, body: { done: true } }), w => w.other.job, NO_SUCH_JOB),
  x('PUT /api/companies/:companyId/jobs/:jobId', (w, id) => ({ path: `${C(w)}/jobs/${id}`, body: { definition: { schema: 1 } } }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/jobs/:jobId/approve', (w, id) => ({ path: `${C(w)}/jobs/${id}/approve`, body: { version: 1 } }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/jobs/:jobId/pause', (w, id) => ({ path: `${C(w)}/jobs/${id}/pause` }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/jobs/:jobId/resume', (w, id) => ({ path: `${C(w)}/jobs/${id}/resume` }), w => w.other.job, NO_SUCH_JOB),
  x('POST /api/companies/:companyId/me/jobs/:jobId/accept', (w, id) => ({ path: `${C(w)}/me/jobs/${id}/accept`, body: { version: 1 } }), w => w.other.job, NO_SUCH_JOB),
  x('GET /api/companies/:companyId/skill-shelf/:itemId/versions', (w, id) => ({ path: `${C(w)}/skill-shelf/${id}/versions` }), w => w.other.shelfItem),
  x('GET /api/companies/:companyId/skill-shelf/:itemId/versions/:version', (w, id) => ({ path: `${C(w)}/skill-shelf/${id}/versions/${'a'.repeat(64)}` }), w => w.other.shelfItem),
  x('POST /api/companies/:companyId/skill-shelf/:itemId/restore', (w, id) => ({ path: `${C(w)}/skill-shelf/${id}/restore`, body: { version: 'a'.repeat(64), expectedVersion: null } }), w => w.other.shelfItem),
  x('DELETE /api/companies/:companyId/skill-shelf/:itemId/versions/:version', (w, id) => ({ path: `${C(w)}/skill-shelf/${id}/versions/${'a'.repeat(64)}` }), w => w.other.shelfItem),
  x('DELETE /api/companies/:companyId/skill-shelf/:itemId', (w, id) => ({ path: `${C(w)}/skill-shelf/${id}` }), w => w.other.shelfItem),
  x('GET /api/companies/:companyId/skill-shelf-requests/:requestId/files', (w, id) => ({ path: `${C(w)}/skill-shelf-requests/${id}/files` }), w => w.other.shelfRequest),
  x('POST /api/companies/:companyId/skill-shelf-requests/:requestId/publish', (w, id) => ({ path: `${C(w)}/skill-shelf-requests/${id}/publish`, body: { expectedVersion: null } }), w => w.other.shelfRequest),
  x('POST /api/companies/:companyId/skill-shelf-requests/:requestId/decline', (w, id) => ({ path: `${C(w)}/skill-shelf-requests/${id}/decline`, body: {} }), w => w.other.shelfRequest),
  x('POST /api/companies/:companyId/skill-shelf/:itemId/unpublish',(w, id) => ({ path: `${C(w)}/skill-shelf/${id}/unpublish`, body: { expectedVersion: 'a'.repeat(64) } }), w => w.other.shelfItem),

  // Lanes (server.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  // Another company's member (with a grant there) is missing here, like nobody.
  x('DELETE /api/companies/:companyId/slack/grants/:userId', (w, id) => ({ path: `${C(w)}/slack/grants/${id}` }), w => w.other.googleGrant, 'pm-nobody'),
  // Another company's record is missing here (an unreadable / owner-only one: tests/integration/threads.test.ts).
  x('GET /api/companies/:companyId/threads/:recordId', (w, id) => ({ path: `${C(w)}/threads/${id}` }), w => w.other.record, 'interaction-nosuch01'),
  // lane A ▲
  // lane B ▼
  x('GET /api/companies/:companyId/identities/records/:recordId', (w, id) => ({ path: `${C(w)}/identities/records/${id}` }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/identities/records/:recordId/split', (w, id) => ({ path: `${C(w)}/identities/records/${id}/split` }), w => w.other.record, 'deal-nosuch01'),
  // The world seeds no proposal of the other company (its seed is outside the lane markers): another
  // company's real proposal, decided by this company's owner, is missing there: tests/unit/identities.test.ts.
  x('POST /api/companies/:companyId/identities/proposals/:proposalId/approve', (w, id) => ({ path: `${C(w)}/identities/proposals/${id}/approve` }), () => 'identity-proposal-other'),
  x('POST /api/companies/:companyId/identities/proposals/:proposalId/reject', (w, id) => ({ path: `${C(w)}/identities/proposals/${id}/reject` }), () => 'identity-proposal-other'),
  // Another company's record is missing here (its own interactions: tests/unit/inbox.test.ts "companies apart").
  x('POST /api/companies/:companyId/inbox/items/:recordId/claim', (w, id) => ({ path: `${C(w)}/inbox/items/${id}/claim`, body: { expectedVersion: 1 } }), w => w.other.record, 'interaction-nosuch01'),
  // lane B ▲
  // lane C ▼
  x('GET /api/companies/:companyId/plugins/:pluginId/package/:version', (w, id) => ({ path: `${C(w)}/plugins/${id}/package/0.1.0` }), w => w.other.plugin, 'no-such-plugin'),
  x('GET /api/companies/:companyId/plugins/:pluginId/roles', (w, id) => ({ path: `${C(w)}/plugins/${id}/roles` }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/roles/:role', (w, id) => ({ path: `${C(w)}/plugins/${id}/roles/approver`, body: { userIds: [] } }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/roles/:role/bundles/:recordId', (w, id) => ({ path: `${C(w)}/plugins/other-sales/roles/approver/bundles/${id}`, body: { userIds: [] } }), w => w.other.record, 'deal-nosuch01'),
  x('GET /api/companies/:companyId/plugins/:pluginId/step-skills', (w, id) => ({ path: `${C(w)}/plugins/${id}/step-skills` }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/step-skills/:step', (w, id) => ({ path: `${C(w)}/plugins/${id}/step-skills/work`, body: { skill: null } }), w => w.other.plugin, 'no-such-plugin'),
  x('PUT /api/companies/:companyId/plugins/:pluginId/step-settings/:step', (w, id) => ({ path: `${C(w)}/plugins/${id}/step-settings/work`, body: { autoStart: false } }), w => w.other.plugin, 'no-such-plugin'),
  x('GET /api/companies/:companyId/me/plugin-steps/records/:recordId', (w, id) => ({ path: `${C(w)}/me/plugin-steps/records/${id}` }), w => w.other.record, 'deal-nosuch01'),
  x('POST /api/companies/:companyId/me/plugin-steps/records/:recordId/:pluginId/:step/start', (w, id) => ({ path: `${C(w)}/me/plugin-steps/records/${id}/other-sales/work/start`, body: {} }), w => w.other.record, 'deal-nosuch01'),
  // lane C ▲
]

/**
 * Routes whose parameters name no object of a company, with the reason. Every
 * other route with a parameter beyond the company must have a CROSS row.
 */
const NOT_OBJECT_IDS: Record<string, string> = {
  'GET /api/companies/:companyId/me/plugin-steps/consultations/:conversationId': "the caller's own consultation id, looked up only among their own bindings in this company; anyone else's is null (plugin-steps.test.ts)",
  'GET /api/oauth/:provider/callback': 'a provider name, not an object: the company comes from the state, found only inside it (member-oauth.test.ts)',
  'GET /api/invitations/:token': 'an invitation link: the token finds the company (control plane; invitations tests)',
  'POST /api/invitations/:token/accept': 'an invitation link: the token finds the company (control plane; invitations tests)',
  'GET /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'POST /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PUT /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PATCH /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'DELETE /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PUT /api/companies/:companyId/broker/services/:service': 'a service name: sets this company\'s own settings row for it',
  'PUT /api/companies/:companyId/broker/services/:service/own-keys': 'a service name: sets this company\'s own settings row for it',
  'PUT /api/companies/:companyId/broker/services/:service/read-only': 'a service name: sets this company\'s own settings row for it',
  'PUT /api/companies/:companyId/broker/services/:service/default-key': 'a service name: sets this company\'s own settings row for it; the key must be this company\'s (404 otherwise, broker-key-choice.test.ts)',
  'PUT /api/companies/:companyId/broker/relay-services/:service': 'a service name this company defines for itself (creates its own row)',
  'PUT /api/companies/:companyId/me/broker-keys/:service': 'a service name: the caller\'s own key in this company',
  'DELETE /api/companies/:companyId/me/broker-keys/:service': 'a service name: the caller\'s own key in this company',
  'GET /api/records-ai/outbound/:messageId': 'the AI\'s routes: the company comes from the record token, never from the URL (outbound-mail.test.ts)',
  'PUT /api/records-ai/outbound/:messageId': 'the AI\'s routes: the company comes from the record token, never from the URL (outbound-mail.test.ts)',
  'POST /api/records-ai/outbound/:messageId/attachments': 'the AI\'s routes: the company comes from the record token, never from the URL (outbound-mail.test.ts)',
  'DELETE /api/records-ai/outbound/:messageId/attachments/:sha256': 'the AI\'s routes: the company comes from the record token, never from the URL (outbound-mail.test.ts)',
  'GET /api/records-ai/item/:recordId': 'the AI\'s routes: the company comes from the record token, never from the URL (another company\'s record: tests/integration/record-tokens.test.ts)',
  'GET /api/records-ai/item/:recordId/history': 'the AI\'s routes: the company comes from the record token, never from the URL',
  'POST /api/records-ai/item/:recordId/actions/:action': 'the AI\'s routes: the company comes from the record token, never from the URL (record-tokens.test.ts)',
  'POST /api/records-ai/item/:recordId/file-links': 'the AI\'s routes: the company comes from the record token, never from the URL (another company\'s record: record-tokens.test.ts)',
  'POST /api/records-ai/item/:recordId/file-links/remove': 'the AI\'s routes: the company comes from the record token, never from the URL',
  'POST /api/records-ai/plugins/:pluginId/records/:recordId/operations/:operation': 'the AI\'s routes: the company comes from the record token, never from the URL (plugin-operations.test.ts)',
  'POST /api/records-ai/plugins/:pluginId/calls/:call': 'the AI\'s routes: the company comes from the record token, never from the URL (plugin-calls.test.ts)',
  'POST /api/records-ai/plugins/:pluginId/create/:operation': 'the AI\'s routes: the company comes from the record token, never from the URL (plugin-operations.test.ts)',
  'GET /api/records-ai/plugins/:pluginId/operations/:operationId': 'the AI\'s routes: the company comes from the record token, never from the URL',
  'GET /api/records-ai/approvals/:approvalId': 'the AI\'s routes: the company comes from the record token, never from the URL (approvals.test.ts)',
  'GET /api/records-ai/google/drive/puts/:putId': 'the AI\'s routes: the company comes from the record token, never from the URL (another member\'s put: tests/integration/google-drive.test.ts)',
  'GET /api/records-ai/minutes/:recordId/text': 'the AI\'s routes: the company comes from the record token, never from the URL (another company\'s minutes: tests/integration/minutes.test.ts)',
  'POST /api/records-ai/minutes/:recordId/bundle': 'the AI\'s routes: the company comes from the record token, never from the URL',

  // Lanes (server.md "Lane markers"): add only right under your lane's ▼.
  // lane A ▼
  'PUT /api/companies/:companyId/connector-roles/:role': 'a role name (connector-roles.ts): sets this company\'s own choice for it',
  'PUT /api/companies/:companyId/connectors/:connectorId/enabled': 'a built-in connector name (builtin-connectors.ts): switches this company\'s own connection',
  'GET /api/records-ai/threads/:recordId': 'the AI\'s routes: the company comes from the record token, never from the URL (tests/integration/threads.test.ts)',
  // lane A ▲
  // lane B ▼
  'GET /api/records-ai/identities/records/:recordId': 'the AI\'s routes: the company comes from the record token, never from the URL (tests/unit/identities.test.ts)',
  'GET /api/records-ai/inbox/items/:recordId': 'the AI\'s routes: the company comes from the record token, never from the URL (tests/unit/inbox.test.ts)',
  'POST /api/records-ai/inbox/items/:recordId/judgement': 'the AI\'s routes: the company comes from the record token, never from the URL (tests/unit/inbox.test.ts)',
  'POST /api/records-ai/inbox/items/:recordId/reply-check': 'the AI\'s routes: the company comes from the record token, never from the URL (tests/unit/inbox.test.ts)',
  // lane B ▲
  // lane C ▼
  // lane C ▲
}

/** The parameters of a route that name something other than the company in the URL. */
function objectParams(path: string): string[] {
  const params = [...path.matchAll(/:(\w+)/g)].map(m => m[1])
  return params.filter((p, i) =>
    p !== 'companyId' && p !== 'company' &&
    !(i === 0 && p === 'repo' && path.startsWith('/api/git-http/:repo')))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let world: World
let kekDir: string
// The plugin shelf, read when the composition is first imported (in seed()).
const shelfDir = mkdtempSync(join(tmpdir(), 'acb-matrix-shelf-'))
process.env.PLUGINS_DIR = shelfDir

function headersFor(role: Role): Record<string, string> {
  if (role === 'signedOut') return {}
  const id = USER[role]
  return {
    [USER_HEADER]: id,
    // git over HTTP signs in with the session token as the Basic password
    Authorization: `Basic ${Buffer.from(`git:tok-${id}`).toString('base64')}`,
  }
}

async function send(role: Role, method: string, req: Req): Promise<number> {
  const headers: Record<string, string> = headersFor(role)
  const init: RequestInit = { method, headers }
  if (req.body !== undefined) {
    init.body = JSON.stringify(req.body)
    headers['Content-Type'] = 'application/json'
  }
  // /me/events is a stream that never ends by itself: hang up as the app would.
  const hangUp = new AbortController()
  init.signal = hangUp.signal
  const res: Response = await app.request(`http://acb.test${req.path}${req.query ? `?${req.query}` : ''}`, init)
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) hangUp.abort()
  else await res.arrayBuffer()
  return res.status
}

async function seed(): Promise<World> {
  const { db, initDatabase } = await import('../../src/db')
  initDatabase()
  const { services } = await import('../../src/composition')
  const { authDb } = await import('../../src/lib/auth')
  const expires = new Date(Date.now() + 3600_000).toISOString()
  for (const id of Object.values(USER)) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${id}`, id, `tok-${id}`, expires)
  }

  const company = await services.companies.create(USER.owner, 'Matrix', 'matrix')
  await services.companies.create(USER.outsider, 'Elsewhere', 'elsewhere')
  const co = company.id
  const owner = { companyId: co, userId: USER.owner, role: 'owner' }
  for (const [user, role] of [[USER.admin, 'admin'], [USER.member, 'member'], [USER.manager, 'member']] as const) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${user}`, user, co, role, expires, expires)
  }
  const dept = (folder: string) => (db.prepare('SELECT id FROM departments WHERE company_id = ? AND folder = ?').get(co, folder) as { id: string }).id
  const sales = dept('営業部')
  const accounting = dept('経理部')
  db.prepare(`INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES ('${co}', ?, ?, ?)`).run(sales, USER.manager, new Date().toISOString())

  const call = async (role: Role, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { ...headersFor(role), 'Content-Type': 'application/json' }
    const res: Response = await app.request(`http://acb.test${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const json = await res.json().catch(() => null)
    if (res.status >= 300) throw new Error(`seed ${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
    return json.data
  }

  const { setPrivateFoldersClientCutoffForTests } = await import('../../src/lib/client-version')
  setPrivateFoldersClientCutoffForTests('20260101000000')
  const pf = await call('owner', 'POST', `/api/companies/${co}/private-folders`, {
    parentPath: '営業部', name: '評価', viewers: [USER.manager], editors: [], force: true,
  })

  const ruleOn = async (folder: string) => {
    const made = await call('owner', 'POST', `/api/companies/${co}/permissions/rules`, {
      path: folder, subjectType: 'user', subjectId: USER.member, canWrite: true, force: true,
    })
    const rules = made.rules as Array<{ id: string; subjectType: string; subjectId: string | null }>
    return {
      scope: made.scope.id as string,
      rule: rules.find(x => x.subjectId === USER.member)!.id,
      everyone: rules.find(x => x.subjectType === 'everyone')!.id,
    }
  }
  const salesRules = await ruleOn('営業部')
  const accountingRules = await ruleOn('経理部')
  const companyScope = (db.prepare("SELECT id FROM scopes WHERE company_id = ? AND path = ''").get(co) as { id: string }).id

  const key = await services.keyBroker.create(owner, {
    service: 'gemini', displayName: 'Matrix Gemini', secret: 'fake-test-key-NOT-REAL-matrix-0123456789',
    audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
  })
  if (!key.ok) throw new Error(`key: ${JSON.stringify(key)}`)
  const token = await call('member', 'POST', `/api/companies/${co}/me/broker-tokens`, { conversationId: 'conv-matrix', department: '営業部' })
  const inv = await call('owner', 'POST', `/api/companies/${co}/invitations`, { role: 'member' })

  // Another company (the outsider owns it) and one object of each kind there.
  const other = (db.prepare('SELECT company_id FROM memberships WHERE user_id = ?').get(USER.outsider) as { company_id: string }).company_id
  const O = `/api/companies/${other}`
  const otherMember = 'pm-other-member'
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('m-other-member', otherMember, other, 'member', expires, expires)
  const otherDept = (db.prepare('SELECT id FROM departments WHERE company_id = ? AND folder = ?').get(other, '営業部') as { id: string }).id
  // Someone belongs to it (所属する部署): a cross-company PUT …/members must not empty it.
  await call('outsider', 'PUT', `${O}/departments/${otherDept}/members`, { userIds: [otherMember] })
  const otherRule = await call('outsider', 'POST', `${O}/permissions/rules`, {
    path: '営業部', subjectType: 'user', subjectId: otherMember, canWrite: true, force: true,
  })
  const otherPf = await call('outsider', 'POST', `${O}/private-folders`, {
    parentPath: '経理部', name: '機密', viewers: [otherMember], editors: [], force: true,
  })
  const otherStop = await call('outsider', 'POST', `${O}/agent-stops`, { userId: otherMember, tool: 'web' })
  const otherKey = await services.keyBroker.create({ companyId: other, userId: USER.outsider, role: 'owner' }, {
    service: 'gemini', displayName: 'Other Gemini', secret: 'fake-test-key-NOT-REAL-other-0123456789',
    audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] },
  })
  if (!otherKey.ok) throw new Error(`other key: ${JSON.stringify(otherKey)}`)
  await call('outsider', 'PUT', `${O}/broker/relay-services/crm`, { label: '顧客管理', baseUrl: 'https://api.crm.example.com/v2/', header: 'Authorization', format: 'Token token={key}' })
  const otherToken = await call('outsider', 'POST', `${O}/me/broker-tokens`, { conversationId: 'conv-other', department: '営業部' })
  const otherInv = await call('outsider', 'POST', `${O}/invitations`, { role: 'member' })
  // The other company's Google with a shared drive registered for relay writes (rows written directly).
  db.prepare(`INSERT INTO google_oauth_clients (company_id, client_id, secret_last4, client_secret_sealed, domain, enabled, created_at, created_by, updated_at, updated_by, relay)
    VALUES (?, 'other-client.apps.googleusercontent.com', 'abcd', 'sealed', 'other.example', 1, ?, ?, ?, ?, ?)`)
    .run(other, expires, USER.outsider, expires, USER.outsider, JSON.stringify({ sharedDrives: [{ driveId: '0AotherDrive0000001', name: '他社', addedAt: expires, addedBy: USER.outsider }] }))

  // The company map, on in both companies (rows written directly: turning it on
  // through the API would start an index run in the background), with a record in the other.
  // A company made through the API already starts with it on (管理画面の見直し 2-4).
  for (const c of [co, other]) {
    db.prepare(`INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET enabled = 1`).run(c, expires, USER.owner)
  }
  db.prepare("INSERT INTO records (company_id, id, type, path, title, created_at, updated_at) VALUES (?, 'deal-other001', 'deal', '営業部/商談.md', '他社の商談', ?, ?)")
    .run(other, expires, expires)
  db.prepare("INSERT INTO record_ai_tokens (id, company_id, user_id, token_hash, scope, agent, conversation_id, created_at, expires_at) VALUES ('rt-other-1', ?, ?, 'hash-other', 'act', 'claude', 'conv', ?, ?)")
    .run(other, otherMember, expires, expires)

  // The shelf: a connector and the business plugin using it, both only for the other company, installed there
  // (the business plugin with its recommended mapping; owner decision 2026-11-01).
  const { cpSync, readFileSync: readText } = await import('fs')
  cpSync(join(__dirname, '../fixtures/plugins/sample-crm'), join(shelfDir, 'other-crm@0.1.0'), { recursive: true })
  const manifest = join(shelfDir, 'other-crm@0.1.0/plugin.yaml')
  writeFileSync(manifest, readText(manifest, 'utf8').replace('id: sample-crm', 'id: other-crm') + `\navailable_to: [${other}]\n`)
  cpSync(join(__dirname, '../fixtures/plugins/sample-crm-sales'), join(shelfDir, 'other-sales@0.1.0'), { recursive: true })
  const business = join(shelfDir, 'other-sales@0.1.0/plugin.yaml')
  writeFileSync(business, readText(business, 'utf8').replace('id: sample-crm-sales', 'id: other-sales').replace('connector: sample-crm >=', 'connector: other-crm >=') + `available_to: [${other}]\n`)
  await services.pluginShelf.load()
  const otherOwner = { companyId: other, userId: USER.outsider, role: 'owner' }
  if (!(await services.plugins.install(otherOwner, 'other-crm', { version: '0.1.0', keyId: null })).ok) throw new Error('connector')
  const installed = await services.plugins.install(otherOwner, 'other-sales', { version: '0.1.0', keyId: null })
  if (!installed.ok) throw new Error(`plugin: ${JSON.stringify(installed)}`)
  db.prepare(`INSERT INTO plugin_operations (company_id, id, plugin_id, operation, plugin_version, fingerprint, mapping_version, connection_id, account_id, object,
    external_id, record_id, actor_id, actor_kind, state, fields, written, previous, created_at, updated_at)
    VALUES (?, 'op-other-1', 'other-sales', 'update_deal', '0.1.0', 'f', 1, 'c', '1', 'deal', '1', 'deal-other001', ?, 'human', 'applied', '{}', '{}', '{}', ?, ?)`)
    .run(other, USER.outsider, expires, expires)
  // An approval request of the other company, waiting for its owner.
  db.prepare("INSERT INTO records (company_id, id, type, title, created_at, updated_at) VALUES (?, 'approval-other001', 'approval', '金額の変更', ?, ?)").run(other, expires, expires)
  db.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, 'approval-other001', 'pending', ?, 1, ?)")
    .run(other, JSON.stringify({ requested_by: USER.outsider, assignee: USER.outsider, next_actor: USER.outsider, approver_rule: 'self' }), expires)

  // A Google permission of the other company's member (a row as the callback writes it, token cleared).
  db.prepare(`INSERT INTO connector_grants (company_id, user_id, provider, grant_id, account_email, scopes, refresh_token_sealed, status, status_reason, created_at, updated_at)
    VALUES (?, ?, 'google', 'g-other-1', 'other@example.com', '[]', NULL, 'stopped', 'admin', ?, ?)`).run(other, otherMember, expires, expires)

  // A mail draft of the other company's member (rows as services/outbound-mail.ts writes them).
  db.prepare("INSERT INTO records (company_id, id, type, path, title, created_at, updated_at) VALUES (?, 'outbound_message-other00000001', 'outbound_message', NULL, '他社のメール', ?, ?)")
    .run(other, expires, expires)
  db.prepare("INSERT INTO record_state (company_id, record_id, state, fields, version, updated_at) VALUES (?, 'outbound_message-other00000001', 'draft', ?, 1, ?)")
    .run(other, JSON.stringify({ requested_by: otherMember, assignee: otherMember, payload_version: 1, payload_hash: `sha256:${'0'.repeat(64)}` }), expires)
  db.prepare("INSERT INTO outbound_mails (company_id, message_id, author_id, from_email, minutes_id, deal_id, created_at) VALUES (?, 'outbound_message-other00000001', ?, 'other@example.com', NULL, 'deal-other001', ?)")
    .run(other, otherMember, expires)

  // A Google Picker pick ticket of the other company's member, open until far ahead.
  db.prepare("INSERT INTO google_drive_pick_tickets (id, company_id, user_id, ticket_hash, mode, max_items, file_ids, state, created_at, expires_at) VALUES ('pick-ticket-other-1', ?, ?, ?, 'folder', 1, '[]', 'open', ?, '2100-01-01T00:00:00.000Z')")
    .run(other, otherMember, 'f'.repeat(64), expires)
  // An absence of the other company's member, current until far ahead.
  db.prepare("INSERT INTO member_absences (company_id, id, user_id, from_day, until_day, delegate_id, set_by, set_at) VALUES (?, 'absence-other-1', ?, '2000-01-01', '2100-12-31', ?, ?, ?)")
    .run(other, otherMember, USER.outsider, USER.outsider, expires)
  // A group of the other company with its member in it (server.md "Groups").
  db.prepare("INSERT INTO member_groups (id, company_id, name, name_key, created_at, created_by) VALUES ('group-other-1', ?, '他社のまとまり', '他社のまとまり', ?, ?)")
    .run(other, expires, USER.outsider)
  db.prepare("INSERT INTO member_group_members (company_id, group_id, user_id, added_at, added_by) VALUES (?, 'group-other-1', ?, ?, ?)")
    .run(other, otherMember, expires, USER.outsider)
  // An execution run of the other company's member, waiting for reconciliation (rows as services/ai-runs.ts writes them).
  db.prepare(`INSERT INTO ai_runs (company_id, id, record_id, step, user_id, state, generation, created_at, updated_at)
    VALUES (?, 'run-other-1', 'deal-other001', 'task-prep', ?, 'waiting_reconcile', 1, ?, ?)`).run(other, otherMember, expires, expires)
  db.prepare(`INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, created_at, updated_at)
    VALUES (?, 'run-other-1', 'k1', 'f', 'plugin-operation', 'unknown', 1, ?, ?)`).run(other, expires, expires)
  // A Skill on the other company's shelf, published (rows as adapters/sqlite/skill-shelf.ts writes them).
  db.prepare(`INSERT INTO shelf_items (id, company_id, kind, department_id, name, current_version, created_at, created_by, changed_at, changed_by)
    VALUES ('shelf-other-1', ?, 'skill', NULL, 'other-skill', ?, ?, ?, ?, ?)`).run(other, 'a'.repeat(64), expires, otherMember, expires, otherMember)
  db.prepare(`INSERT INTO shelf_versions (company_id, item_id, version, files, file_count, total_bytes, autorun, published_at, published_by)
    VALUES (?, 'shelf-other-1', ?, '[]', 0, 0, 0, ?, ?)`).run(other, 'a'.repeat(64), expires, otherMember)
  // A scheduled job of the other company, approved and accepted, its member responsible (rows as adapters/sqlite/jobs.ts writes them).
  db.prepare(`INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent,
    created_by, created_at, updated_at) VALUES (?, ?, '他社の定期の仕事', 'active', ?, 1, 1, 'sha256:f', 1, 'sha256:c', ?, ?, ?)`).run(other, OTHER_JOB, otherMember, USER.outsider, expires, expires)
  db.prepare(`INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at, approved_by, approved_at)
    VALUES (?, ?, 1, 1, '{}', 'sha256:f', 'sha256:c', ?, ?, ?, ?, ?)`).run(other, OTHER_JOB, otherMember, USER.outsider, expires, USER.outsider, expires)
  // One of its occurrences (rows as adapters/sqlite/jobs.ts writes them, B PR 3b).
  db.prepare(`INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, run_id, outcome_code, created_at, updated_at)
    VALUES (?, ?, ?, 1, '2026-11-16T09:00', 'Asia/Tokyo', ?, ?, 'held', NULL, 'JOB_PAUSED', ?, ?)`).run(other, OTHER_OCC, OTHER_JOB, expires, expires, expires, expires)
  // A pending request to publish a Skill on the other company's shelf (rows as adapters/sqlite/skill-shelf.ts writes them).
  db.prepare(`INSERT INTO shelf_requests (id, company_id, department_id, name, requested_by, requested_at, version, files, file_count, total_bytes, autorun, state)
    VALUES ('shelf-request-other-1', ?, NULL, 'other-request', ?, ?, ?, '[]', 0, 0, 0, 'pending')`).run(other, otherMember, expires, 'a'.repeat(64))

  return {
    co, sales, accounting,
    privateScope: pf.scopeId, companyScope,
    salesScope: salesRules.scope, salesRule: salesRules.rule, salesEveryoneRule: salesRules.everyone,
    accountingScope: accountingRules.scope, accountingRule: accountingRules.rule, accountingEveryoneRule: accountingRules.everyone,
    key: (db.prepare('SELECT id FROM broker_keys WHERE company_id = ?').get(co) as { id: string }).id,
    memberToken: token.tokenId,
    invitationToken: inv.token,
    other: {
      co: other,
      department: otherDept,
      scope: otherRule.scope.id,
      rule: (otherRule.rules as Array<{ id: string; subjectId: string | null }>).find(x => x.subjectId === otherMember)!.id,
      privateScope: otherPf.scopeId,
      privateName: '機密',
      member: otherMember,
      stop: (otherStop.active as Array<{ id: string }>)[0].id,
      key: (db.prepare('SELECT id FROM broker_keys WHERE company_id = ?').get(other) as { id: string }).id,
      relayService: 'crm',
      token: otherToken.tokenId,
      invitation: otherInv.id,
      record: 'deal-other001',
      recordToken: 'rt-other-1',
      plugin: 'other-sales',
      operation: 'op-other-1',
      googleGrant: otherMember,
      sharedDrive: '0AotherDrive0000001',
      approval: 'approval-other001',
      outboundMail: 'outbound_message-other00000001',
      absence: 'absence-other-1',
      group: 'group-other-1',
      aiRun: 'run-other-1',
      shelfItem: 'shelf-other-1',
      shelfRequest: 'shelf-request-other-1',
      job: OTHER_JOB,
      pickTicket: 'pick-ticket-other-1',

    },
  }
}

/** Every row of the other company, table by table (tables with company_id), plus its private folder's repository. */
async function otherCompanyState(w: World): Promise<unknown> {
  const { db } = await import('../../src/db')
  const { existsSync } = await import('fs')
  const { privateRepoPath } = await import('../../src/lib/private-folders')
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map(t => t.name)
    .filter(t => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).some(c => c.name === 'company_id'))
  const rows = Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t} WHERE company_id = ? ORDER BY rowid`).all(w.other.co)]))
  const folder = (db.prepare('SELECT repo_id FROM scopes WHERE id = ?').get(w.other.privateScope) as { repo_id: string | null } | undefined)?.repo_id
  return { rows, repo: folder ? existsSync(privateRepoPath(w.other.co, folder)) : 'gone' }
}

async function answer(method: string, req: Req, hide: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = headersFor('owner')
  const init: RequestInit = { method, headers }
  if (req.body !== undefined) {
    init.body = JSON.stringify(req.body)
    headers['Content-Type'] = 'application/json'
  }
  const res: Response = await app.request(`http://acb.test${req.path}${req.query ? `?${req.query}` : ''}`, init)
  const body = (await res.text()).split(hide).join('<id>')
  return { status: res.status, body }
}

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'acb-matrix-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'))
  chmodSync(join(kekDir, 'kek'), 0o600)
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  app = (await import('../../src/app')).app
  world = await seed()
})

afterAll(() => {
  rmSync(kekDir, { recursive: true, force: true })
  rmSync(shelfDir, { recursive: true, force: true })
  delete process.env.BROKER_KEK_FILE
})

describe('permission matrix', () => {
  it('has a row for every route of the application', () => {
    const routes = new Set<string>()
    for (const route of app.routes as Array<{ method: string; path: string }>) {
      if (route.method !== 'ALL') routes.add(`${route.method} ${route.path}`)
    }
    expect(routes.size).toBeGreaterThan(90)
    const inMatrix = new Set(MATRIX.map(row => row.route))
    expect([...routes].filter(k => !inMatrix.has(k)), 'routes missing from the permission matrix').toEqual([])
    expect([...inMatrix].filter(k => !routes.has(k)), 'matrix rows for routes that no longer exist').toEqual([])
  })

  it('every route that takes an object id has a cross-company row (or a reason it names none)', () => {
    const withIds = new Set<string>()
    for (const route of app.routes as Array<{ method: string; path: string }>) {
      if (route.method !== 'ALL' && objectParams(route.path).length > 0) withIds.add(`${route.method} ${route.path}`)
    }
    const covered = new Set([...CROSS.map(row => row.route), ...Object.keys(NOT_OBJECT_IDS)])
    expect([...withIds].filter(k => !covered.has(k)), 'routes with an object id but no cross-company row').toEqual([])
    expect([...covered].filter(k => !withIds.has(k)), 'cross-company rows for routes that no longer take an id').toEqual([])
  })

  it('another company\'s object in this company\'s URL is answered like one that does not exist, and stays unchanged', async () => {
    const before = await otherCompanyState(world)
    const wrong: string[] = []
    for (const row of CROSS) {
      const method = row.route.split(' ')[0]
      const id = row.other(world)
      expect(id, `${row.route}: the other company's object was not seeded`).toBeTruthy()
      const missing = row.missing ?? NO_SUCH_ID
      const theirs = await answer(method, row.req(world, id), id)
      const none = await answer(method, row.req(world, missing), missing)
      if (theirs.status !== none.status || theirs.body !== none.body) {
        wrong.push(`${row.route}: another company's object → ${theirs.status} ${theirs.body}; a missing one → ${none.status} ${none.body}`)
      }
    }
    expect(wrong, `Cross-company answers differ from not-found:\n${wrong.join('\n')}`).toEqual([])
    expect(await otherCompanyState(world), 'the other company changed').toEqual(before)
  })

  it('each caller gets the expected status on every route', async () => {
    const wrong: string[] = []
    for (const row of MATRIX) {
      const method = row.route.split(' ')[0]
      const req = row.req(world)
      process.env.OPERATOR_USER_IDS = (row.operators ?? []).map(role => USER[role]).join(',')
      for (const [i, role] of ROLES.entries()) {
        const status = await send(role, method, req)
        if (status !== row.expect[i]) {
          wrong.push(`${row.route}${row.why ? ` (${row.why})` : ''} as ${role}: ${status}, expected ${row.expect[i]}`)
        }
      }
      delete process.env.OPERATOR_USER_IDS
    }
    expect(wrong, `Callers got a different answer than the matrix says:\n${wrong.join('\n')}`).toEqual([])
  })
})
