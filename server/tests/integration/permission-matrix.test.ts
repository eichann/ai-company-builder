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
  r('GET /api/companies/:id', w => ({ path: C(w) }), MEMBERS),
  r('PATCH /api/companies/:id', w => ({ path: C(w), body: {} }), [400, 400, 403, 403, 404, 401]),
  r('GET /api/companies/:id/members', w => ({ path: `${C(w)}/members` }), MEMBERS),
  r('POST /api/companies/:id/members', w => ({ path: `${C(w)}/members`, body: {} }), [400, 400, 403, 403, 403, 401]),
  r('PUT /api/companies/:id/members/:userId/role', w => ({ path: `${C(w)}/members/${USER.member}/role`, body: {} }), [400, 403, 403, 403, 404, 401]),
  r('DELETE /api/companies/:id/members/:userId', w => ({ path: `${C(w)}/members/pm-nobody` }), [200, 200, 403, 403, 403, 401],
    'removing someone who is not a member changes nothing'),
  r('GET /api/companies/:id/client-activity', w => ({ path: `${C(w)}/client-activity` }), [200, 200, 403, 403, 404, 401]),

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
  r('GET /api/companies/:companyId/records/types', w => ({ path: `${C(w)}/records/types` }), MEMBERS),
  r('POST /api/companies/:companyId/records/query', w => ({ path: `${C(w)}/records/query`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId', w => ({ path: `${C(w)}/records/item/deal-nosuch01` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/my-turn', w => ({ path: `${C(w)}/records/my-turn` }), MEMBERS),
  r('POST /api/companies/:companyId/records/item', w => ({ path: `${C(w)}/records/item`, body: 'x' }), [400, 400, 400, 400, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/actions/:action', w => ({ path: `${C(w)}/records/item/deal-nosuch01/actions/start`, body: { expectedVersion: 0 } }), [404, 404, 404, 404, 404, 401]),
  r('POST /api/companies/:companyId/records/item/:recordId/undo', w => ({ path: `${C(w)}/records/item/deal-nosuch01/undo`, body: {} }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId/history', w => ({ path: `${C(w)}/records/item/deal-nosuch01/history` }), [404, 404, 404, 404, 404, 401]),
  r('GET /api/companies/:companyId/records/item/:recordId/versions/:version', w => ({ path: `${C(w)}/records/item/deal-nosuch01/versions/1` }), [404, 404, 404, 404, 404, 401]),

  // Key broker (「API キー」)
  r('GET /api/companies/:companyId/broker', w => ({ path: `${C(w)}/broker` }), [200, 200, 403, 403, 404, 401]),
  r('POST /api/companies/:companyId/broker/keys', w => ({ path: `${C(w)}/broker/keys`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/keys/:keyId/secret', w => ({ path: `${C(w)}/broker/keys/${w.key}/secret`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PATCH /api/companies/:companyId/broker/keys/:keyId', w => ({ path: `${C(w)}/broker/keys/${w.key}`, body: { displayName: 1 } }), [400, 400, 403, 403, 404, 401]),
  r('DELETE /api/companies/:companyId/broker/keys/:keyId', w => ({ path: `${C(w)}/broker/keys/no-such-key` }), [404, 404, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service', w => ({ path: `${C(w)}/broker/services/gemini`, body: {} }), [400, 400, 403, 403, 404, 401]),
  r('PUT /api/companies/:companyId/broker/services/:service/own-keys', w => ({ path: `${C(w)}/broker/services/gemini/own-keys`, body: {} }), [400, 400, 403, 403, 404, 401]),
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

  // Invitations
  r('GET /api/companies/:companyId/invitations', w => ({ path: `${C(w)}/invitations` }), [200, 200, 403, 403, 403, 401]),
  r('POST /api/companies/:companyId/invitations', w => ({ path: `${C(w)}/invitations`, body: { role: 'nobody' } }), [400, 400, 403, 403, 403, 401]),
  r('DELETE /api/companies/:companyId/invitations/:invitationId', w => ({ path: `${C(w)}/invitations/no-such-invitation` }), [404, 404, 403, 403, 403, 401]),
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

  x('PUT /api/companies/:id/members/:userId/role', (w, id) => ({ path: `${C(w)}/members/${id}/role`, body: { role: 'admin' } }), w => w.other.member, 'pm-nobody'),
  x('DELETE /api/companies/:id/members/:userId', (w, id) => ({ path: `${C(w)}/members/${id}` }), w => w.other.member, 'pm-nobody'),
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
  x('GET /api/companies/:companyId/records/item/:recordId/versions/:version', (w, id) => ({ path: `${C(w)}/records/item/${id}/versions/1` }), w => w.other.record, 'deal-nosuch01'),

  x('DELETE /api/companies/:companyId/invitations/:invitationId', (w, id) => ({ path: `${C(w)}/invitations/${id}` }), w => w.other.invitation),
]

/**
 * Routes whose parameters name no object of a company, with the reason. Every
 * other route with a parameter beyond the company must have a CROSS row.
 */
const NOT_OBJECT_IDS: Record<string, string> = {
  'GET /api/invitations/:token': 'an invitation link: the token finds the company (control plane; invitations tests)',
  'POST /api/invitations/:token/accept': 'an invitation link: the token finds the company (control plane; invitations tests)',
  'GET /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'POST /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PUT /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PATCH /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'DELETE /api/broker/:service/*': 'the relay: the company comes from the relay token, never from the URL',
  'PUT /api/companies/:companyId/broker/services/:service': 'a service name: sets this company\'s own settings row for it',
  'PUT /api/companies/:companyId/broker/services/:service/own-keys': 'a service name: sets this company\'s own settings row for it',
  'PUT /api/companies/:companyId/broker/relay-services/:service': 'a service name this company defines for itself (creates its own row)',
  'PUT /api/companies/:companyId/me/broker-keys/:service': 'a service name: the caller\'s own key in this company',
  'DELETE /api/companies/:companyId/me/broker-keys/:service': 'a service name: the caller\'s own key in this company',
}

/** The parameters of a route that name something other than the company in the URL. */
function objectParams(path: string): string[] {
  const params = [...path.matchAll(/:(\w+)/g)].map(m => m[1])
  return params.filter((p, i) =>
    p !== 'companyId' && p !== 'company' &&
    !(i === 0 && p === 'id' && path.startsWith('/api/companies/:id')) &&
    !(i === 0 && p === 'repo' && path.startsWith('/api/git-http/:repo')))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let world: World
let kekDir: string

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

  // The company map, on in both companies (rows written directly: turning it on
  // through the API would start an index run in the background), with a record in the other.
  for (const c of [co, other]) {
    db.prepare('INSERT INTO record_settings (company_id, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)').run(c, expires, USER.owner)
  }
  db.prepare("INSERT INTO records (company_id, id, type, path, title, created_at, updated_at) VALUES (?, 'deal-other001', 'deal', '営業部/商談.md', '他社の商談', ?, ?)")
    .run(other, expires, expires)

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
