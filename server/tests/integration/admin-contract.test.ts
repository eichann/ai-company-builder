/**
 * Integration Test: the admin console's hand-written API types
 * (admin/src/lib/api.ts) against what the server really answers.
 *
 * The admin declares ~37 of the server's response types by hand (since R2 it
 * imports the shared rules from shared/core, but not the API types); its own tests run against
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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
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
  AgentEvents: 'AgentEventPage',
  AgentEventSummary: 'AgentEventSummary',
  AgentEventSettings: 'AgentEventSettings',
  AgentEventRetentionPreview: 'AgentEventRetentionPreview',
  AgentEventViewers: 'AgentEventViewers',
  AgentSandbox: 'AgentSandboxView',
  AgentStops: 'AgentStopView',
  SandboxImpact: 'SandboxImpact',
  Broker: 'BrokerView',
  Plugins: '{ plugins: PluginListItem[] }',
  Plugin: 'PluginDetail',
  Invitations: 'Invitation[]',
  CreatedInvitation: 'CreatedInvitation',
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
// None: the last one (invitation-create-partial) was fixed by typing the
// POST …/invitations answer as CreatedInvitation.
const KNOWN_MISMATCHES: Array<{ id: string; describe: string; error: RegExp }> = []

const CO = 'acco'
/** A mapping for the sample-hub fixture: one field written automatically. */
const CONTRACT_MAPPING = `
deal:
  visible_to_folder: 営業部
  fields:
    title:     { from: dealname, write: false }
    next_step: { from: hs_next_step, write: true }
    amount:    { from: amount, write: true }
policy:
  next_step: auto
`
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
  // The key broker on, with a throwaway KEK outside DATA_DIR (before the composition root loads).
  const kekDir = mkdtempSync(join(tmpdir(), 'acb-admin-contract-kek-'))
  writeFileSync(join(kekDir, 'kek'), randomBytes(32).toString('base64'), { mode: 0o600 })
  process.env.BROKER_KEK_FILE = join(kekDir, 'kek')
  // The plugin shelf (「つなぎ先」): one HubSpot-shaped package, also before the composition root loads.
  const shelfDir = mkdtempSync(join(tmpdir(), 'acb-admin-contract-shelf-'))
  cpSync(join(__dirname, '../fixtures/plugins/sample-hub'), join(shelfDir, 'sample-hub@0.1.0'), { recursive: true })
  process.env.PLUGINS_DIR = shelfDir
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
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
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
  const { agentEventsRoute } = await import('../../src/routes/agent-events')
  const { agentSandboxRoute } = await import('../../src/routes/agent-sandbox')
  const { agentStopsRoute } = await import('../../src/routes/agent-stops')
  const { keyBrokerRoute } = await import('../../src/routes/key-broker')
  const { pluginsRoute } = await import('../../src/routes/plugins')
  await (await import('../../src/composition')).services.pluginShelf.load()
  // The same mounts as src/app.ts.
  app = new Hono()
  app.route('/api/me', meRoute)
  app.route('/api/companies', companiesRoute)
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  app.route('/api/companies/:companyId', permissionsRoute)
  app.route('/api/companies/:companyId', permissionRulesRoute)
  app.route('/api/companies/:companyId', privateFoldersRoute)
  app.route('/api/companies/:companyId', agentEventsRoute)
  app.route('/api/companies/:companyId', agentSandboxRoute)
  app.route('/api/companies/:companyId', agentStopsRoute)
  app.route('/api/companies/:companyId', keyBrokerRoute)
  app.route('/api/companies/:companyId', pluginsRoute)
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

  it('the AI action log', async () => {
    // Events of every target kind, sent the way the app does.
    const at = new Date().toISOString()
    const targets = [
      { kind: 'file', path: '営業部/契約書/a.md' }, { kind: 'outside', sensitive: 'ssh' },
      { kind: 'files', files: [{ kind: 'file', path: '人事/README.md' }], more: 2 },
      { kind: 'command', programs: ['git push'], redirect: true }, { kind: 'web', host: 'example.com' },
      { kind: 'mcp', server: 'github', tool: 'create_issue' }, { kind: 'subagent', subagentType: 'Explore' }, { kind: 'none' },
    ]
    const events = targets.map((target, i) => ({
      version: 1, id: `ac-ev-${i}`, callId: `toolu_${i}`, at, durationMs: 5, conversationId: 'conv', turnId: 'turn', department: '営業部',
      agent: 'claude-code', model: 'm', tool: 'Read', category: 'read', target, decision: i % 2 ? 'auto-allowed' : 'guard-denied',
      ...(i % 2 ? { outcome: 'ok' } : { guardReason: 'read-only-folder' }),
    }))
    const sent = await call(USERS.member, 'POST', `${base}/agent-events`, { events })
    expect(sent.json?.data).toEqual({ accepted: targets.length, duplicates: 0, rejected: 0 })

    await expectShape('AgentEvents', USERS.owner, 'GET', `${base}/agent-events?limit=50`)
    await expectShape('AgentEventSummary', USERS.owner, 'GET', `${base}/agent-events/summary?tzOffsetMinutes=540`)
    await expectShape('AgentEventSettings', USERS.owner, 'GET', `${base}/agent-events/settings`)
    await expectShape('AgentEventSettings', USERS.owner, 'PUT', `${base}/agent-events/settings`, { retentionDays: 90, viewers: 'admins-and-managers' })
    await expectShape('AgentEventRetentionPreview', USERS.owner, 'GET', `${base}/agent-events/settings/retention-preview?days=30`)
    await expectShape('AgentEventViewers', USERS.owner, 'GET', `${base}/agent-events/viewers?mode=admins-and-managers`)
    await expectShape('SandboxImpact', USERS.owner, 'GET', `${base}/agent-events/sandbox`)
  })

  it('AI sandbox (「AI の囲い」)', async () => {
    await expectShape('AgentSandbox', USERS.owner, 'GET', `${base}/agent-sandbox`)
    await expectShape('AgentSandbox', USERS.owner, 'PUT', `${base}/agent-sandbox`, { mode: 'observe', allowedDomains: ['api.github.com'], deniedReadPaths: ['~/x'], onUnavailable: 'record-only' })
    await expectShape('AgentSandbox', USERS.owner, 'PUT', `${base}/agent-sandbox/overrides/${USERS.member}`, { mode: 'enforce' })
  })

  it('emergency stop (「AI の緊急停止」)', async () => {
    await expectShape('AgentStops', USERS.owner, 'GET', `${base}/agent-stops`)
    const made = await expectShape('AgentStops', USERS.owner, 'POST', `${base}/agent-stops`, { userId: USERS.member, tool: 'command', reason: '契約テスト' })
    await expectShape('AgentStops', USERS.owner, 'DELETE', `${base}/agent-stops/${made.active[0].id}`)
  })

  it('API keys (「API キー」)', async () => {
    await expectShape('Broker', USERS.owner, 'GET', `${base}/broker`)
    const created = await expectShape('Broker', USERS.owner, 'POST', `${base}/broker/keys`, {
      service: 'gemini', displayName: '契約テスト', secret: 'fake-test-key-NOT-REAL-contract-0000',
      audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [USERS.member] }, caps: { requestsPerDay: 10 },
    })
    const id = created.keys[0].id
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/keys/${id}/secret`, { secret: 'fake-test-key-NOT-REAL-contract-1111' })
    await expectShape('Broker', USERS.owner, 'PATCH', `${base}/broker/keys/${id}`, { status: 'disabled', allowPrivateContent: true })
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/services/gmail`, { category: 'person', rule: 'user-only', ownKeyHosts: ['gmail.googleapis.com'] })
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/services/gemini/own-keys`, { allowed: true })
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/relay-services/crm`, { label: '顧客管理', baseUrl: 'https://api.crm.example.com/v2', header: 'x-api-key', format: '{key}', checkPath: '/me' })
    await expectShape('Broker', USERS.owner, 'DELETE', `${base}/broker/relay-services/crm`)
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/settings`, { memberKeysAllowed: false })
    await expectShape('Broker', USERS.owner, 'PUT', `${base}/broker/settings`, { internalHosts: ['crm.example.com'] })
    await expectShape('Broker', USERS.owner, 'POST', `${base}/broker/stop-all`)
    await expectShape('Broker', USERS.owner, 'DELETE', `${base}/broker/keys/${id}`)
  })

  it('つなぎ先 (connector plugins)', async () => {
    await expectShape('Plugins', USERS.owner, 'GET', `${base}/plugins`)
    await expectShape('Plugin', USERS.owner, 'PUT', `${base}/plugins/sample-hub`, { version: '0.1.0', keyId: null })
    await expectShape('Plugin', USERS.owner, 'GET', `${base}/plugins/sample-hub`)
    await expectShape('Plugin', USERS.owner, 'PUT', `${base}/plugins/sample-hub/mapping`, { text: CONTRACT_MAPPING, acknowledgeAuto: ['next_step'] })
    await expectShape('Plugin', USERS.owner, 'POST', `${base}/plugins/sample-hub/mapping/restore`, { version: 1 })
    await expectShape('Plugin', USERS.owner, 'PUT', `${base}/plugins/sample-hub/enabled`, { enabled: false })
    await expectShape('Plugin', USERS.owner, 'PUT', `${base}/plugins/sample-hub/read-scope`, { departmentIds: [], userIds: [USERS.owner] })
  })

  it('invitations', async () => {
    const inv = await expectShape('CreatedInvitation', USERS.owner, 'POST', `${base}/invitations`, { role: 'member', expiresInDays: 7 })
    await expectShape('Invitations', USERS.owner, 'GET', `${base}/invitations`)
    await expectShape('InvitationValidate', USERS.newbie, 'GET', `/api/invitations/${inv.token}`)
    await expectShape('InvitationAccept', USERS.newbie, 'POST', `/api/invitations/${inv.token}/accept`)
    const other = await expectShape('CreatedInvitation', USERS.owner, 'POST', `${base}/invitations`, { role: 'member', expiresInDays: 1 })
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

/**
 * The other direction: the admin's own request builders (admin/src/lib/api.ts:
 * method, URL, query and body) are run against the real routes, and the
 * server's state is read back. A request the server refuses throws ApiError;
 * one it accepts but misreads (a renamed body field, a query parameter it does
 * not know) leaves the database unchanged — either fails here.
 */
describe('the admin console\'s requests do what the admin means on the server', () => {
  let A: typeof import('../../../admin/src/lib/api')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  const row = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Loose
  const rules = (path: string) => db.prepare(`SELECT r.subject_type, r.subject_id, r.can_read, r.can_write FROM scope_rules r
    JOIN scopes s ON s.id = r.scope_id WHERE s.company_id = ? AND s.path = ? ORDER BY r.subject_type, r.subject_id`).all(CO, path)

  beforeAll(async () => {
    A = await import('../../../admin/src/lib/api')
    db = (await import('../../src/db')).db
    currentUser.id = USERS.owner
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init))
    // The member runs an app that recovers from a refused push, so taking
    // writing away from them needs no "save anyway" (outdated-app guard).
    const { WRITE_DENIED_RECOVERY_COMMIT_DATE } = await import('../../src/lib/client-version')
    db.prepare(`INSERT OR REPLACE INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(USERS.member, CO, `0.0.1+a031b73.${WRITE_DENIED_RECOVERY_COMMIT_DATE}`, new Date().toISOString(), new Date().toISOString())
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('company rename and member role change', async () => {
    await A.companiesApi.rename(CO, '改名テスト')
    expect(row('SELECT name FROM companies WHERE id = ?', CO).name).toBe('改名テスト')
    await A.companiesApi.setMemberRole(CO, USERS.member, 'admin')
    expect(row('SELECT role FROM memberships WHERE company_id = ? AND user_id = ?', CO, USERS.member).role).toBe('admin')
    await A.companiesApi.setMemberRole(CO, USERS.member, 'member')
    expect(row('SELECT role FROM memberships WHERE company_id = ? AND user_id = ?', CO, USERS.member).role).toBe('member')
  })

  it('department order and managers', async () => {
    const dept = await A.departmentsApi.create(CO, { name: '総務部', folder: '総務部', icon: 'Folder', color: '#3b82f6' })
    await A.departmentsApi.reorder(CO, [{ id: dept.id, sortOrder: 7 }])
    expect(row('SELECT sort_order FROM departments WHERE id = ?', dept.id).sort_order).toBe(7)
    await A.departmentsApi.setManagers(CO, dept.id, [USERS.member])
    expect(db.prepare('SELECT user_id FROM department_managers WHERE department_id = ?').all(dept.id)).toEqual([{ user_id: USERS.member }])
    expect((await A.departmentsApi.getManagers(CO, dept.id)).managers.map(m => m.userId)).toEqual([USERS.member])
  })

  it('permission edits: writing changes as asked, reading is never taken away', async () => {
    const set = await A.permissionsApi.setRule(CO, '営業部', { subjectType: 'user', subjectId: USERS.member }, true)
    expect(rules('営業部')).toContainEqual({ subject_type: 'user', subject_id: USERS.member, can_read: 1, can_write: 1 })
    const ruleId = set.rules.find(r => r.subjectId === USERS.member)!.id

    await A.permissionsApi.updateRule(CO, ruleId, false)
    expect(rules('営業部')).toContainEqual({ subject_type: 'user', subject_id: USERS.member, can_read: 1, can_write: 0 })
    const effective = await A.permissionsApi.effective(CO, '営業部')
    expect(effective.members.find(m => m.userId === USERS.member)).toMatchObject({ read: true, write: false })

    await A.permissionsApi.replaceScope(CO, '営業部', [
      { subjectType: 'everyone', subjectId: null, canWrite: false },
      { subjectType: 'user', subjectId: USERS.member, canWrite: true },
    ])
    expect(rules('営業部')).toEqual([
      { subject_type: 'everyone', subject_id: null, can_read: 1, can_write: 0 },
      { subject_type: 'user', subject_id: USERS.member, can_read: 1, can_write: 1 },
    ])
    const folders = await A.permissionsApi.folders(CO, '')
    expect(folders.folders.find(f => f.path === '営業部')).toMatchObject({ hasRules: true })

    const memberRule = row(`SELECT r.id FROM scope_rules r JOIN scopes s ON s.id = r.scope_id
      WHERE s.company_id = ? AND s.path = ? AND r.subject_id = ?`, CO, '営業部', USERS.member).id
    await A.permissionsApi.deleteRule(CO, memberRule)
    expect(rules('営業部')).toEqual([{ subject_type: 'everyone', subject_id: null, can_read: 1, can_write: 0 }])

    const scopeId = row('SELECT id FROM scopes WHERE company_id = ? AND path = ?', CO, '営業部').id
    expect((await A.permissionsApi.resetScope(CO, scopeId)).removed).toBe(1)
    expect(rules('営業部')).toEqual([])
  })

  it('push rejection filters and paging reach the query', async () => {
    const now = new Date().toISOString()
    const add = db.prepare(`INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, ?, ?, ?, '[]', ?)`)
    add.run('rej-2', CO, USERS.admin, 'SECRET_DETECTED', now)
    add.run('rej-3', CO, USERS.member, 'SECRET_DETECTED', now)
    const filtered = await A.pushRejectionsApi.list(CO, { userId: USERS.member, marker: 'SECRET_DETECTED' })
    expect(filtered.rejections.map(r => r.id)).toEqual(['rej-3'])
    expect(filtered.total).toBe(1)
    const first = await A.pushRejectionsApi.list(CO, { limit: 1 })
    const second = await A.pushRejectionsApi.list(CO, { limit: 1, offset: 1 })
    expect(first.total).toBe(3)
    expect(first.rejections).toHaveLength(1)
    expect(second.rejections).toHaveLength(1)
    expect(second.rejections[0].id).not.toBe(first.rejections[0].id)
  })

  it('API keys: the admin\'s key, who-may-use, service rule and switch reach the database as chosen', async () => {
    const created = await A.keyBrokerApi.create(CO, {
      service: 'openai', displayName: '翻訳用', secret: 'fake-test-key-NOT-REAL-builder-2222',
      destinations: { hosts: ['api.openai.com'], pathPrefixes: ['/v1/chat/'], models: ['gpt-5-mini'] },
      audience: { allDepartments: false, departmentIds: [row('SELECT id FROM departments WHERE company_id = ? ORDER BY rowid LIMIT 1', CO).id], everyone: false, addUserIds: [USERS.member], removeUserIds: [] },
      caps: { requestsPerMemberPerDay: 50 }, allowPrivateContent: false,
    })
    const id = created.keys.find(k => k.displayName === '翻訳用')!.id
    const stored = row('SELECT service, last4, destinations, audience, caps FROM broker_keys WHERE id = ?', id)
    expect(stored.last4).toBe('2222')
    expect(JSON.parse(stored.destinations)).toEqual({ hosts: ['api.openai.com'], pathPrefixes: ['/v1/chat/'], models: ['gpt-5-mini'] })
    expect(JSON.parse(stored.audience)).toMatchObject({ allDepartments: false, everyone: false, addUserIds: [USERS.member] })
    expect(JSON.parse(stored.caps).requestsPerMemberPerDay).toBe(50)
    await A.keyBrokerApi.update(CO, id, { status: 'disabled' })
    expect(row('SELECT status FROM broker_keys WHERE id = ?', id).status).toBe('disabled')
    await A.keyBrokerApi.replaceSecret(CO, id, 'fake-test-key-NOT-REAL-builder-3333')
    expect(row('SELECT last4 FROM broker_keys WHERE id = ?', id).last4).toBe('3333')
    await A.keyBrokerApi.setService(CO, 'openai', { category: 'tool', rule: 'company-first', ownKeyHosts: ['api.openai.com'] })
    expect(row('SELECT rule FROM broker_services WHERE company_id = ? AND service = ?', CO, 'openai').rule).toBe('company-first')
    // The one switch: the server fills the built-in host and 会社優先.
    await A.keyBrokerApi.setOwnKeys(CO, 'anthropic', true)
    expect(row('SELECT rule, own_key_hosts FROM broker_services WHERE company_id = ? AND service = ?', CO, 'anthropic'))
      .toEqual({ rule: 'company-first', own_key_hosts: '["api.anthropic.com"]' })
    await A.keyBrokerApi.saveRelayService(CO, 'crm', { label: '顧客管理', baseUrl: 'https://API.crm.example.com/v2/', header: 'X-Api-Key', format: 'Bearer {key}', checkPath: '/me' })
    expect(JSON.parse(row('SELECT relay FROM broker_services WHERE company_id = ? AND service = ?', CO, 'crm').relay))
      .toEqual({ label: '顧客管理', host: 'api.crm.example.com', basePath: '/v2', header: 'x-api-key', format: 'Bearer {key}', checkPath: '/me' })
    await A.keyBrokerApi.removeRelayService(CO, 'crm')
    expect(row('SELECT service FROM broker_services WHERE company_id = ? AND service = ?', CO, 'crm')).toBeUndefined()
    await A.keyBrokerApi.setMemberKeysAllowed(CO, true)
    expect(row('SELECT member_keys_allowed FROM broker_settings WHERE company_id = ?', CO).member_keys_allowed).toBe(1)
    await A.keyBrokerApi.remove(CO, id)
    expect(row('SELECT id FROM broker_keys WHERE id = ?', id)).toBeUndefined()
  })

  it('つなぎ先: version, key, mapping with its auto acknowledgement, restore and the switch reach the server as chosen', async () => {
    await A.pluginsApi.install(CO, 'sample-hub', '0.1.0', null)
    expect(row('SELECT version, key_id FROM plugin_installs WHERE company_id = ? AND plugin_id = ?', CO, 'sample-hub')).toEqual({ version: '0.1.0', key_id: null })
    const text = CONTRACT_MAPPING.replace('amount:    { from: amount, write: true }', 'amount:    { from: amount, write: false }')
    const saved = await A.pluginsApi.saveMapping(CO, 'sample-hub', text, ['next_step'])
    expect(row('SELECT text FROM plugin_mappings WHERE company_id = ? AND plugin_id = ? AND version = ?', CO, 'sample-hub', saved.mapping!.version).text).toBe(text)
    expect(row('SELECT acknowledged_by FROM plugin_policy_acks WHERE company_id = ? AND plugin_id = ? AND field = ?', CO, 'sample-hub', 'next_step').acknowledged_by).toBe(USERS.owner)
    const restored = await A.pluginsApi.restoreMapping(CO, 'sample-hub', saved.mapping!.version - 1)
    expect(restored.mapping!.version).toBe(saved.mapping!.version + 1)
    // 「HubSpot に聞いて確かめる」 and the import reach their routes (no key chosen: refused before anything is sent).
    await expect(A.pluginsApi.checkMapping(CO, 'sample-hub', text)).rejects.toMatchObject({ status: 409, code: 'PLUGIN_NOT_READY', body: { problem: 'no-key' } })
    await expect(A.pluginsApi.import(CO, 'sample-hub')).rejects.toMatchObject({ status: 409, code: 'PLUGIN_NOT_ACTIVE' })
    await expect(A.pluginsApi.setEnabled(CO, 'sample-hub', true)).rejects.toMatchObject({ status: 409, code: 'PLUGIN_NOT_READY' })
    expect((await A.pluginsApi.setReadScope(CO, 'sample-hub', { departmentIds: [], userIds: [USERS.owner] })).readScope).toEqual({ departmentIds: [], userIds: [USERS.owner] })
    expect(row('SELECT enabled FROM plugin_installs WHERE company_id = ? AND plugin_id = ?', CO, 'sample-hub').enabled).toBe(0)
  })

  it('an invitation gets the role and expiry the admin chose', async () => {
    const inv = await A.invitationsApi.create(CO, 'admin', 30)
    const stored = row('SELECT role, expires_at FROM invitations WHERE id = ?', inv.id)
    expect(stored.role).toBe('admin')
    expect((new Date(stored.expires_at).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(29.9)
    expect((await A.invitationsApi.list(CO)).map(i => i.id)).toContain(inv.id)
  })
})
