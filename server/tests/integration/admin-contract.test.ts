/**
 * Integration Test: the admin console's hand-written API types
 * (admin/src/lib/api.ts) against what the server really answers.
 *
 * The admin's Docker build context is admin/ only, so it cannot import the
 * server's types and declares ~37 of them by hand; its own tests run against
 * hand-written fixtures (admin/tests/fixtures.ts) that follow those types.
 * Nothing tied either to the server. Here every endpoint the admin calls is
 * called on the real routes (real SQLite, a real bare repository) and its
 * `data` is checked against the admin's declared type with the TypeScript
 * compiler's view of it (tests/helpers/type-shape.ts):
 *
 * - errors: a field the admin reads is missing or has another type → fails;
 * - extra:  the server sends fields the admin type does not declare → logged
 *   (harmless, but shows where the admin's copy lags behind).
 *
 * Known mismatches (reported, not fixed here) are listed in KNOWN_MISMATCHES
 * and must keep occurring, so a fix asks for its entry to be removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { loadTypeShapes, type TypeShapes } from '../helpers/type-shape'

const currentUser = vi.hoisted(() => ({ id: 'ac-owner' as string | null }))

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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.com'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

const ADMIN_API = resolve(__dirname, '../../../admin/src/lib/api.ts')

/** Response `data` type per admin call, written as admin/src/lib/api.ts declares it. */
const TYPES: Record<string, string> = {
  User: 'User',
  Companies: 'Company[]',
  Company: 'Company',
  Members: 'Member[]',
  MemberRole: '{ userId: string; companyId: string; role: Role }',
  Capabilities: 'Capabilities',
  Overview: 'Overview',
  ClientActivity: 'ClientActivity[]',
  Permissions: '{ scopes: PermissionScope[]; orphanedScopes?: OrphanedScope[] }',
  ScopeRulesResult: 'ScopeRulesResult',
  ResetScope: '{ removed: number }',
  MoveScope: '{ moved: number; toPath: string; scopeId: string | null }',
  Effective: 'EffectiveAccess',
  Folders: '{ path: string; folders: RepoFolder[] }',
  PrivateFolders: 'PrivateFolderSummary[]',
  PrivateFolder: 'PrivateFolderDetail',
  PushRejections: 'PushRejectionPage',
  Invitations: 'Invitation[]',
  Invitation: 'Invitation',
  InvitationValidate: '{ companyName: string; role: Role; expiresAt: string }',
  InvitationAccept: '{ companyId: string; companyName: string; role: Role }',
  Departments: 'Department[]',
  Department: 'Department',
  DepartmentStats: '{ files: number; folders: number; exists: boolean }',
  Managers: '{ managers: DepartmentManager[] }',
  Success: '{ success: boolean }',
  DepartmentDelete: '{ success: boolean; deletedFiles?: number; deletedFolders?: number }',
  DepartmentSync: '{ success: boolean; added: number; removed: number }',
  MakePublic: '{ path: string; commit: string }',
  PrivateFolderDelete: 'DeletePrivateFolderResult',
  OutdatedClientsBody: '{ error: string; code: "OUTDATED_CLIENTS"; members: OutdatedMember[]; canForce: boolean }',
}

/** Known, reported differences: `<call>: <field path>` of a ShapeReport error. */
const KNOWN_MISMATCHES: Array<{ id: string; describe: string; error: RegExp }> = [
  {
    id: 'invitation-create-partial',
    describe: 'POST /companies/:id/invitations answers only { id, token, companyId, companyName, role, expiresAt, '
      + 'createdAt }, but invitationsApi.create is typed as a full Invitation (createdBy, usedBy…, isExpired, isUsed). '
      + 'The members page only reads token / expiresAt of it today, so nothing breaks yet.',
    error: /^POST …\/invitations → Invitation: Invitation\.(createdBy|createdByName|createdByEmail|usedBy|usedByName|usedByEmail|usedAt|isExpired|isUsed): missing/,
  },
]

const CO = 'acco'
const base = `/api/companies/${CO}`
const USERS = { owner: 'ac-owner', admin: 'ac-admin', member: 'ac-member', newbie: 'ac-newbie' } as const

let shapes: TypeShapes
let workDir: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const errorsSeen: Array<{ call: string; error: string }> = []
const extrasSeen = new Map<string, string[]>()
const knownSeen = new Set<string>()

async function call(user: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: Loose }> {
  currentUser.id = user
  const init: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await app.request(path, init)
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* empty */ }
  return { status: res.status, json }
}

/** Call as `user`, expect a 2xx envelope, and check `data` against the admin's type. */
async function expectShape(name: keyof typeof TYPES, user: string, method: string, path: string, body?: unknown, envelope = true): Promise<Loose> {
  const r = await call(user, method, path, body)
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300)
  const data = envelope ? r.json?.data : r.json
  record(`${method} ${path.replace(base, '…')} → ${TYPES[name]}`, shapes.check(name, data))
  return data
}

function record(callName: string, report: { errors: string[]; extra: string[] }) {
  for (const error of report.errors) {
    const known = KNOWN_MISMATCHES.find(k => k.error.test(`${callName}: ${error}`))
    if (known) knownSeen.add(known.id)
    else errorsSeen.push({ call: callName, error })
  }
  if (report.extra.length > 0) extrasSeen.set(callName, report.extra)
}

const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

beforeAll(async () => {
  shapes = loadTypeShapes(
    `import type * as A from ${JSON.stringify(ADMIN_API.replace(/\.ts$/, ''))}\n`
    + `type Role = A.Role\n`
    + Object.entries(TYPES).map(([name, t]) => `export type T_${name} = ${t.replace(/\b([A-Z][A-Za-z]+)\b(?!["'])/g, (m) => (m === 'OUTDATED_CLIENTS' ? m : `A.${m}`))}`).join('\n'),
  )
  workDir = mkdtempSync(join(tmpdir(), 'acb-admin-contract-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(CO, '契約テスト', 'admin-contract', USERS.owner, now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const [role, id] of Object.entries(USERS)) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
    if (role === 'newbie') continue
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${id}`, id, CO, role, now, now)
  }
  authDb.close()
  const { ensureCompanyScope } = await import('../../src/lib/permission-store')
  ensureCompanyScope(db, CO)

  // Company repository with two departments' folders.
  const { configureBareRepo } = await import('../../src/routes/git')
  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  for (const [rel, content] of [['営業部/契約書/a.md', 'a\n'], ['development/README.md', 'dev\n'], ['人事/README.md', 'hr\n']]) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true })
    writeFileSync(join(seed, rel), content)
  }
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], seed)
  git(['push', '-q', bare, 'HEAD:main'], seed)
  db.prepare('UPDATE companies SET repo_path = ? WHERE id = ?').run(bare, CO)

  const { Hono } = await import('hono')
  const { meRoute } = await import('../../src/routes/me')
  const { companiesRoute } = await import('../../src/routes/companies')
  const { departmentsRoute } = await import('../../src/routes/departments')
  const { permissionsRoute } = await import('../../src/routes/permissions')
  const { permissionRulesRoute } = await import('../../src/routes/permission-rules')
  const { privateFoldersRoute } = await import('../../src/routes/private-folders')
  const { invitationsRoute } = await import('../../src/routes/invitations')
  // The same mounts as src/index.ts.
  app = new Hono()
  app.route('/api/me', meRoute)
  app.route('/api/companies', companiesRoute)
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  app.route('/api/companies/:companyId', permissionsRoute)
  app.route('/api/companies/:companyId', permissionRulesRoute)
  app.route('/api/companies/:companyId', privateFoldersRoute)
  app.route('/api', invitationsRoute)

  // A push rejection for the overview / history.
  db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('rej-1', CO, USERS.member, 'PROTECTED_CONFIG', JSON.stringify(['.mcp.json']), now)
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('admin API types (admin/src/lib/api.ts) match the server', () => {
  it('auth / companies / members', async () => {
    await expectShape('User', USERS.owner, 'GET', '/api/me')
    await expectShape('Companies', USERS.owner, 'GET', '/api/companies')
    await expectShape('Company', USERS.owner, 'GET', base)
    await expectShape('Company', USERS.owner, 'PATCH', base, { name: '契約テスト株式会社' })
    await expectShape('Members', USERS.owner, 'GET', `${base}/members`)
    await expectShape('MemberRole', USERS.owner, 'PUT', `${base}/members/${USERS.member}/role`, { role: 'member' })
    await expectShape('ClientActivity', USERS.owner, 'GET', `${base}/client-activity`)
  })

  it('capabilities / overview / push rejections', async () => {
    await expectShape('Capabilities', USERS.member, 'GET', `${base}/me/capabilities`)
    await expectShape('Overview', USERS.owner, 'GET', `${base}/overview`)
    await expectShape('PushRejections', USERS.owner, 'GET', `${base}/push-rejections?limit=10`)
  })

  it('departments and their managers', async () => {
    const created = await expectShape('Department', USERS.owner, 'POST', `${base}/departments`, { name: '経理部', folder: '経理部', icon: 'Calculator', color: '#3b82f6' })
    await expectShape('Departments', USERS.owner, 'GET', `${base}/departments?flat=true`)
    await expectShape('Department', USERS.owner, 'PUT', `${base}/departments/${created.id}`, { description: '説明' })
    await expectShape('DepartmentStats', USERS.owner, 'GET', `${base}/departments/${created.id}/stats`)
    await expectShape('Managers', USERS.owner, 'PUT', `${base}/departments/${created.id}/managers`, { userIds: [USERS.member] })
    await expectShape('Managers', USERS.owner, 'GET', `${base}/departments/${created.id}/managers`)
    await expectShape('Success', USERS.owner, 'POST', `${base}/departments/reorder`, { items: [{ id: created.id, sortOrder: 0 }] }, false)
    await expectShape('DepartmentSync', USERS.owner, 'POST', `${base}/departments/sync`, undefined, false)
    await expectShape('DepartmentDelete', USERS.owner, 'DELETE', `${base}/departments/${created.id}`, undefined, false)
  })

  it('permissions: read, edit, effective access, folders, the outdated-apps refusal', async () => {
    const set = await expectShape('ScopeRulesResult', USERS.owner, 'POST', `${base}/permissions/rules`,
      { path: '営業部', subjectType: 'user', subjectId: USERS.member, canWrite: true })
    const ruleId = set.rules.find((r: Loose) => r.subjectType === 'user').id
    await expectShape('ScopeRulesResult', USERS.owner, 'PATCH', `${base}/permissions/rules/${ruleId}`, { canWrite: true })
    // Taking writing away from members whose app version is unknown: 409 with details.
    const refused = await call(USERS.owner, 'PUT', `${base}/permissions/scopes/by-path`,
      { path: '営業部/契約書', rules: [{ subjectType: 'everyone', subjectId: null, canWrite: false }] })
    expect(refused.status).toBe(409)
    record('PUT …/permissions/scopes/by-path (409) → OutdatedClients body', shapes.check('OutdatedClientsBody', refused.json))
    const replaced = await expectShape('ScopeRulesResult', USERS.owner, 'PUT', `${base}/permissions/scopes/by-path`,
      { path: '営業部/契約書', rules: [{ subjectType: 'everyone', subjectId: null, canWrite: false }], force: true })
    await expectShape('Permissions', USERS.owner, 'GET', `${base}/permissions`)
    await expectShape('Effective', USERS.owner, 'GET', `${base}/permissions/effective?path=${encodeURIComponent('営業部/契約書')}`)
    await expectShape('Folders', USERS.owner, 'GET', `${base}/permissions/folders?path=`)
    await expectShape('MoveScope', USERS.owner, 'POST', `${base}/permissions/scopes/${replaced.scope.id}/move`, { toPath: 'development', force: true })
    await expectShape('ScopeRulesResult', USERS.owner, 'DELETE', `${base}/permissions/rules/${ruleId}`)
    const permissions = await call(USERS.owner, 'GET', `${base}/permissions`)
    const moved = permissions.json.data.scopes.find((s: Loose) => s.path === 'development')
    await expectShape('ResetScope', USERS.owner, 'DELETE', `${base}/permissions/scopes/${moved.id}/rules?force=true`)
  })

  it('private folders', async () => {
    const cv = await import('../../src/lib/client-version')
    cv.setPrivateFoldersClientCutoffForTests('20260101000000')
    const created = await expectShape('PrivateFolder', USERS.owner, 'POST', `${base}/private-folders`,
      { parentPath: '人事', name: '評価', viewers: [USERS.member], force: true })
    await expectShape('PrivateFolders', USERS.owner, 'GET', `${base}/private-folders`)
    await expectShape('PrivateFolder', USERS.owner, 'GET', `${base}/private-folders/${created.scopeId}`)
    await expectShape('PrivateFolder', USERS.owner, 'PUT', `${base}/private-folders/${created.scopeId}/members`, { viewers: [USERS.member, USERS.admin] })
    await expectShape('MakePublic', USERS.owner, 'POST', `${base}/private-folders/${created.scopeId}/make-public`, {})
    const second = await expectShape('PrivateFolder', USERS.owner, 'POST', `${base}/private-folders`, { parentPath: '人事', name: '給与', force: true })
    await expectShape('PrivateFolderDelete', USERS.owner, 'DELETE', `${base}/private-folders/${second.scopeId}?confirm=${encodeURIComponent('給与')}`)
  })

  it('invitations', async () => {
    const inv = await expectShape('Invitation', USERS.owner, 'POST', `${base}/invitations`, { role: 'member', expiresInDays: 7 })
    await expectShape('Invitations', USERS.owner, 'GET', `${base}/invitations`)
    await expectShape('InvitationValidate', USERS.newbie, 'GET', `/api/invitations/${inv.token}`)
    await expectShape('InvitationAccept', USERS.newbie, 'POST', `/api/invitations/${inv.token}/accept`)
    const other = await expectShape('Invitation', USERS.owner, 'POST', `${base}/invitations`, { role: 'member', expiresInDays: 1 })
    await expectShape('Success', USERS.owner, 'DELETE', `${base}/invitations/${other.id}`, undefined, false)
    await expectShape('Success', USERS.owner, 'DELETE', `${base}/members/${USERS.newbie}`, undefined, false)
  })

  it('no field the admin reads is missing or of another type', () => {
    for (const [callName, extra] of extrasSeen) console.log(`[admin-contract] extra fields (not in the admin type) ${callName}: ${extra.join(', ')}`)
    for (const k of KNOWN_MISMATCHES) {
      expect(knownSeen.has(k.id), `known mismatch "${k.id}" no longer occurs — remove it: ${k.describe}`).toBe(true)
    }
    expect(errorsSeen.map(e => `${e.call}: ${e.error}`)).toEqual([])
  })
})
