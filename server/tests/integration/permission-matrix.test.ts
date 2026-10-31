/**
 * Integration Test: the permission matrix — every API route × every kind of caller.
 *
 * Callers: the company's owner, an admin, a plain member, a department manager
 * (a member who manages 営業部), an outsider (signed in, owner of another
 * company) and a signed-out request. For each route the matrix states the
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
}

interface Req { path: string; body?: unknown; query?: string }
/** Expected status for [owner, admin, member, manager, outsider, signedOut]. */
type Expect = [number, number, number, number, number, number]
interface Row { route: string; why?: string; req: (w: World) => Req; expect: Expect }

const r = (route: string, req: (w: World) => Req, expect: Expect, why?: string): Row => ({ route, req, expect, why })
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
  r('POST /api/companies', () => ({ path: '/api/companies', body: {} }), [400, 400, 400, 400, 400, 401]),
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
    const added = services.companies.addMember(owner, user, role)
    if (!added.ok) throw new Error(`addMember ${user}: ${JSON.stringify(added)}`)
  }
  const dept = (folder: string) => (db.prepare('SELECT id FROM departments WHERE company_id = ? AND folder = ?').get(co, folder) as { id: string }).id
  const sales = dept('営業部')
  const accounting = dept('経理部')
  db.prepare('INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)').run(sales, USER.manager, new Date().toISOString())

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

  return {
    co, sales, accounting,
    privateScope: pf.scopeId, companyScope,
    salesScope: salesRules.scope, salesRule: salesRules.rule, salesEveryoneRule: salesRules.everyone,
    accountingScope: accountingRules.scope, accountingRule: accountingRules.rule, accountingEveryoneRule: accountingRules.everyone,
    key: (db.prepare('SELECT id FROM broker_keys WHERE company_id = ?').get(co) as { id: string }).id,
    memberToken: token.tokenId,
    invitationToken: inv.token,
  }
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

  it('each caller gets the expected status on every route', async () => {
    const wrong: string[] = []
    for (const row of MATRIX) {
      const method = row.route.split(' ')[0]
      const req = row.req(world)
      for (const [i, role] of ROLES.entries()) {
        const status = await send(role, method, req)
        if (status !== row.expect[i]) {
          wrong.push(`${row.route}${row.why ? ` (${row.why})` : ''} as ${role}: ${status}, expected ${row.expect[i]}`)
        }
      }
    }
    expect(wrong, `Callers got a different answer than the matrix says:\n${wrong.join('\n')}`).toEqual([])
  })
})
