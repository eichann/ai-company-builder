/**
 * Integration Test: rules left behind when a folder is renamed or removed by
 * a sync push (outside the admin panel).
 *
 * Through a real bare repo, the real pre-receive hook and real git pushes
 * over git-http:
 * - after an accepted push that renames / deletes a ruled folder, the check
 *   runs once the push has completed (the push does not wait for it) and
 *   records the scope; GET /permissions and GET /overview report it;
 * - names match in NFC and with A–Z folded (a Mac's NFD commit and a
 *   different-case folder are not orphans);
 * - "新しい場所に移す" (POST /permissions/scopes/:id/move) and "ルールを削除"
 *   (DELETE /permissions/scopes/:id/rules) make it disappear;
 * - the move endpoint's validation and authorization.
 * Renames are never followed automatically.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: 'os-owner' as string | null }))
// The post-push check waits for this gate, so a test can prove the push
// completes before the check runs.
const gate = vi.hoisted(() => {
  const g = { open: Promise.resolve(), release: () => {}, calls: [] as string[] }
  return g
})

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

import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { db, initDatabase } from '../../src/db'
import { configureBareRepo } from '../../src/routes/git'
import { gitHttpRoute } from '../../src/routes/git-http'
import { permissionsRoute } from '../../src/routes/permissions'
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { replaceDepartmentManagers, replaceScopeRules, sqlitePermissionRepository } from '../../src/adapters/sqlite/permission-store'
import { resolveAccess } from '../../shared/core/permissions'
import { resetOrphanedScopeCache } from '../../src/adapters/orphaned-scopes'
import { services } from '../../src/composition'

// git-http asks for the post-push check through the services; hold it at the gate.
{
  const schedule = services.orphanedScopes.scheduleCheck.bind(services.orphanedScopes)
  vi.spyOn(services.orphanedScopes, 'scheduleCheck').mockImplementation((companyId: string) => {
    gate.calls.push(companyId)
    void gate.open.then(() => schedule(companyId))
  })
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const CO = 'orphanco'
const base = `/api/companies/${CO}`
const V_NEW = '0.0.1+a031b73.20261021182826'
const tokens: Record<string, string> = {}

const app = new Hono()
app.route('/api/companies/:companyId', permissionsRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/git-http', gitHttpRoute)

let workDir: string
let clone: string
let server: { close: () => void }
let gitBase: string

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

// core.precomposeunicode=false: keep the NFD name a Mac app would commit.
const commitCfg = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.precomposeunicode=false']
function commitAll(message: string) {
  git([...commitCfg, 'add', '-A', '.'], clone)
  git([...commitCfg, 'commit', '-q', '--no-verify', '-m', message], clone)
}

// Async: the server runs in this process, a sync spawn would deadlock it.
function pushAs(userId: string): Promise<{ ok: boolean; output: string; ms: number }> {
  const url = gitBase.replace('http://', `http://git:${tokens[userId]}@`)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.ACB_PUSHER_ROLE
  const started = Date.now()
  return new Promise((resolve) => {
    const p = spawn('git', ['-c', `http.extraHeader=X-ACB-Client-Version: ${V_NEW}`, 'push', url, 'HEAD:main'], { cwd: clone, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output, ms: Date.now() - started }))
  })
}

async function pushOk() {
  const r = await pushAs('os-owner')
  expect(r.ok ? 'ok' : r.output).toBe('ok')
}

async function as(userId: string, method: string, path: string, body?: unknown) {
  currentUser.id = userId
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data?: Loose } }
}

const everyone = (canWrite: boolean) => ({ subjectType: 'everyone' as const, subjectId: null, canRead: true, canWrite })
const user = (id: string) => ({ subjectType: 'user' as const, subjectId: id, canRead: true, canWrite: true })
const restricted = [everyone(false), user('os-member')]

const orphanPaths = async (userId = 'os-owner') => {
  const r = await as(userId, 'GET', `${base}/permissions`)
  expect(r.status).toBe(200)
  return (r.body.data.orphanedScopes as Loose[]).map(o => o.path).sort()
}
const recorded = () => (db.prepare(`
  SELECT s.path FROM orphaned_scopes o JOIN scopes s ON s.id = o.scope_id WHERE o.company_id = ? ORDER BY s.path
`).all(CO) as Array<{ path: string }>).map(r => r.path)
const scopeId = (path: string) => (db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ?`).get(CO, path) as { id: string }).id
const repo = sqlitePermissionRepository(db)

async function until(cond: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  initDatabase()
  workDir = mkdtempSync(join(tmpdir(), 'acb-orphans-'))
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(CO, 'Orphans', CO, 'os-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const [id, role] of [['os-owner', 'owner'], ['os-manager', 'member'], ['os-member', 'member']] as const) {
    tokens[id] = `tok-${id}`
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${id}`, id, tokens[id], expires)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${id}`, id, CO, role, now, now)
    db.prepare('INSERT INTO client_activity (user_id, company_id, client_version, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, CO, V_NEW, now, now)
  }
  authDb.close()
  db.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('os-d-sales', CO, '営業部', '営業部', 0, now, now)
  initDatabase() // seed scopes
  replaceDepartmentManagers(db, 'os-d-sales', ['os-manager'], 'os-owner')

  const bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)

  clone = join(workDir, 'clone')
  mkdirSync(clone)
  git(['init', '-q', '-b', 'main'], clone)
  for (const dir of ['営業部/契約書', '営業部/見積', '営業部/archive', 'Sales', 'コンテンツ'.normalize('NFD') + '/ブログ'.normalize('NFD'), '総務']) {
    writeFile(clone, `${dir}/.gitkeep`, '')
  }
  commitAll('init')

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      gitBase = `http://127.0.0.1:${info.port}/api/git-http/${CO}.git`
      resolve()
    })
  })
  const first = await pushAs('os-owner')
  expect(first.output).toBeDefined()
  expect(first.ok).toBe(true)
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetOrphanedScopeCache()
  gate.open = Promise.resolve()
})

describe('orphaned scopes', () => {
  it('matches folder names in NFC and without A–Z case: nothing is reported for existing folders', async () => {
    replaceScopeRules(db, CO, '営業部/契約書', restricted, 'os-owner')
    replaceScopeRules(db, CO, 'sales', restricted, 'os-owner') // repo has "Sales"
    replaceScopeRules(db, CO, 'コンテンツ/ブログ', restricted, 'os-owner') // NFC; repo has NFD
    replaceScopeRules(db, CO, '総務', restricted, 'os-owner')
    expect(await orphanPaths()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('a push that renames / deletes ruled folders reports them after the push, without delaying it', async () => {
    let release!: () => void
    gate.open = new Promise<void>(r => { release = r })
    gate.calls = []

    renameSync(join(clone, '営業部/契約書'), join(clone, '営業部/契約'))
    rmSync(join(clone, '総務'), { recursive: true })
    commitAll('rename 契約書, remove 総務')
    const push = await pushAs('os-owner')
    expect(push.ok).toBe(true)

    // The push has completed and the check was scheduled, but has not run.
    expect(gate.calls).toEqual([CO])
    expect(recorded()).toEqual([])

    release()
    await until(() => recorded().length === 2)
    expect(recorded()).toEqual(['営業部/契約書', '総務'])

    const r = await as('os-owner', 'GET', `${base}/permissions`)
    const orphans = r.body.data.orphanedScopes as Loose[]
    expect(orphans.map(o => o.path).sort()).toEqual(['営業部/契約書', '総務'])
    const contract = orphans.find(o => o.path === '営業部/契約書')
    expect(contract).toMatchObject({ kind: 'folder', summary: 'everyone-r', scopeId: scopeId('営業部/契約書') })
    expect(contract.rules.map((x: Loose) => x.subjectLabel)).toEqual(['全員', 'Name os-member'])
    expect(Number.isNaN(Date.parse(contract.since))).toBe(false)

    const ov = await as('os-owner', 'GET', `${base}/overview`)
    expect((ov.body.data.attention.orphanedScopes as Loose[]).map(o => o.path).sort()).toEqual(['営業部/契約書', '総務'])
    expect(ov.body.data.attention.orphanedScopes[0]).toMatchObject({ ruleCount: 2 })

    // Not followed automatically: the new folder has no rules.
    expect(resolveAccess(CO, 'os-manager', '営業部/契約', repo).write).toBe(true)
  })

  it('since stays the first detection time across checks', async () => {
    const first = db.prepare(`SELECT detected_at FROM orphaned_scopes WHERE scope_id = ?`).get(scopeId('総務')) as { detected_at: string }
    await new Promise(r => setTimeout(r, 20))
    resetOrphanedScopeCache()
    await orphanPaths()
    const again = db.prepare(`SELECT detected_at FROM orphaned_scopes WHERE scope_id = ?`).get(scopeId('総務')) as { detected_at: string }
    expect(again.detected_at).toBe(first.detected_at)
  })

  it('a manager sees only the orphans inside their department', async () => {
    expect(await orphanPaths('os-manager')).toEqual(['営業部/契約書'])
  })

  it('move: validation and authorization', async () => {
    const url = `${base}/permissions/scopes/${scopeId('営業部/契約書')}/move`
    expect((await as('os-owner', 'POST', url, { toPath: '営業部/存在しない' })).status).toBe(400)
    expect((await as('os-owner', 'POST', url, { toPath: '' })).status).toBe(400)
    expect((await as('os-owner', 'POST', url, { toPath: '営業部/契約書/中' })).status).toBe(400)
    expect((await as('os-member', 'POST', url, { toPath: '営業部/契約' })).status).toBe(403)
    // A manager of 営業部 cannot move rules out of their department.
    expect((await as('os-manager', 'POST', url, { toPath: 'Sales' })).status).toBe(403)
    // Destination already has rules.
    replaceScopeRules(db, CO, '営業部/見積', restricted, 'os-owner')
    const taken = await as('os-owner', 'POST', url, { toPath: '営業部/見積' })
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('TARGET_HAS_RULES')
    replaceScopeRules(db, CO, '営業部/見積', [], 'os-owner')
    expect(await orphanPaths()).toEqual(['営業部/契約書', '総務'])
  })

  it('新しい場所に移す: the rules follow to the picked folder and the orphan disappears', async () => {
    const url = `${base}/permissions/scopes/${scopeId('営業部/契約書')}/move`
    const r = await as('os-manager', 'POST', url, { toPath: '営業部/契約' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ moved: 2, toPath: '営業部/契約' })
    expect(resolveAccess(CO, 'os-manager', '営業部/契約', repo).write).toBe(false)
    expect(resolveAccess(CO, 'os-member', '営業部/契約', repo).write).toBe(true)
    expect(db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = ?`).get(CO, '営業部/契約書')).toBeUndefined()
    expect(await orphanPaths()).toEqual(['総務'])
    expect(recorded()).toEqual(['総務'])
  })

  it('ルールを削除: removing the rules makes the orphan disappear', async () => {
    const r = await as('os-owner', 'DELETE', `${base}/permissions/scopes/${scopeId('総務')}/rules`)
    expect(r.status).toBe(200)
    expect(await orphanPaths()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('a case-only rename keeps matching; a real rename of a case-folded scope is reported', async () => {
    // A case-only rename (via a temporary name: the disk may ignore case).
    git(['rm', '-r', '-q', '--cached', 'Sales'], clone)
    renameSync(join(clone, 'Sales'), join(clone, 'SALES-tmp'))
    renameSync(join(clone, 'SALES-tmp'), join(clone, 'SALES'))
    commitAll('case-only rename')
    expect(git(['ls-tree', '--name-only', 'HEAD'], clone).split('\n')).toContain('SALES')
    await pushOk()
    expect(await orphanPaths()).toEqual([])

    renameSync(join(clone, 'SALES'), join(clone, 'Sales2'))
    commitAll('real rename')
    await pushOk()
    await until(() => recorded().includes('sales'))
    expect(await orphanPaths()).toEqual(['sales'])
  })

  it('a moved department-folder rule lands in the existing department scope; a rename of a department folder is reported', async () => {
    replaceScopeRules(db, CO, '営業部', restricted, 'os-owner')
    renameSync(join(clone, '営業部'), join(clone, '営業'))
    commitAll('rename the department folder')
    await pushOk()
    const orphans = await orphanPaths()
    // The department scope and the folder moved earlier are both under 営業部.
    expect(orphans).toEqual(['sales', '営業部', '営業部/契約'])
    const r = await as('os-owner', 'POST', `${base}/permissions/scopes/${scopeId('営業部')}/move`, { toPath: '営業' })
    expect(r.status).toBe(200)
    expect(r.body.data.moved).toBe(4)
    // The department scope stays with its department (still at its old path, without rules).
    expect(db.prepare(`SELECT kind FROM scopes WHERE company_id = ? AND path = '営業部'`).get(CO)).toEqual({ kind: 'department' })
    expect(resolveAccess(CO, 'os-manager', '営業/契約', repo).write).toBe(false)
    expect(resolveAccess(CO, 'os-manager', '営業', repo).write).toBe(false)
    expect(await orphanPaths()).toEqual(['sales'])
  })
})
