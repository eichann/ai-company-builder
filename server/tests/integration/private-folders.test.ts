/**
 * Integration Test: private folders (permission plan stage 3a — server).
 *
 * Real HTTP for git (git-http served on a loopback port, real hook, real
 * push checker, real git); the JSON APIs through app.request with a mocked
 * session.
 *
 * - creation: owner/admin anywhere, a manager only inside their department,
 *   members never; the company's first private folder waits for every app
 *   (409 OUTDATED_CLIENTS, force for owner/admin only);
 * - taken names answer the same for a public folder and a private one, and
 *   an unreadable private parent answers like a missing one;
 * - scope repositories: clone/fetch need READ, push needs WRITE; every push
 *   rule runs there (secrets, protected config, write permission by path);
 * - the company repository refuses anything under a private folder's path
 *   ([RESERVED_PATH]) for everyone — case and NFC variants, renames, nesting;
 * - make-public moves the contents back and removes the scope repository;
 * - no API hands a private folder's name to a member who cannot read it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

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

const CO = 'pfco'
const USERS = ['owner', 'admin', 'hrmgr', 'salesmgr', 'viewer', 'editor', 'other'] as const
type User = typeof USERS[number]
const ROLE: Record<User, string> = { owner: 'owner', admin: 'admin', hrmgr: 'member', salesmgr: 'member', viewer: 'member', editor: 'member', other: 'member' }
const base = `/api/companies/${CO}`

let workDir: string
let bare: string
let gitBase: string
let server: { close: () => void }
let db: import('better-sqlite3').Database
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any

const git = (args: string[], cwd?: string) => execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string, message: string) {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

function authUrl(url: string, user: User) {
  return url.replace('http://', `http://git:tok-${user}@`)
}

function run(args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

const companyUrl = () => `${gitBase}/${CO}.git`
const scopeUrl = (scopeId: string) => `${gitBase}/${CO}/scopes/${scopeId}.git`

let cloneCount = 0
async function cloneAs(url: string, user: User): Promise<{ ok: boolean; output: string; dir: string }> {
  const dir = join(workDir, `clone${++cloneCount}`)
  const r = await run(['clone', '-q', authUrl(url, user), dir])
  if (r.ok) {
    git(['config', 'user.name', 'test'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
  }
  return { ...r, dir }
}

const pushAs = (dir: string, url: string, user: User) => run(['push', authUrl(url, user), 'HEAD:main'], dir)

/** "- " lines of a section (the client's parsing). */
function sectionPaths(output: string, marker: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s?/, '').trim())
  const start = lines.findIndex(l => l.startsWith(`[${marker}]`))
  if (start === -1) return []
  const paths: string[] = []
  let separators = 0
  for (const line of lines.slice(start + 1)) {
    if (/^=+$/.test(line)) {
      if (++separators === 2) break
      continue
    }
    if (line.startsWith('- ')) paths.push(line.slice(2))
  }
  return paths
}

async function as(userId: User | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  currentUser.id = userId ? `u-${userId}` : null
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await app.request(path, init)
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { /* 304 etc. */ }
  return { status: res.status, body: json, text, headers: res.headers }
}

const create = (user: User, input: Record<string, unknown>) => as(user, 'POST', `${base}/private-folders`, input)

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-private-folders-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(CO, 'PF', 'pf-co', 'u-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const u of USERS) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(`u-${u}`, `${u}@example.com`, u)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${u}`, `u-${u}`, `tok-${u}`, expires)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${u}`, `u-${u}`, CO, ROLE[u], now, now)
  }
  authDb.close()
  const { ensureCompanyScope, ensureDepartmentScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)
  for (const [id, name, folder] of [['d-hr', '人事', '人事'], ['d-sales', '営業', 'sales']]) {
    db.prepare(`INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, CO, name, folder, now, now)
    ensureDepartmentScope(db, CO, id, folder)
  }
  db.prepare(`INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)`).run('d-hr', 'u-hrmgr', now)
  db.prepare(`INSERT INTO department_managers (department_id, user_id, created_at) VALUES (?, ?, ?)`).run('d-sales', 'u-salesmgr', now)

  bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const { departmentsRoute } = await import('../../src/routes/departments')
  const { folderSizesRoute } = await import('../../src/routes/folder-sizes')
  const { permissionsRoute } = await import('../../src/routes/permissions')
  const { permissionRulesRoute } = await import('../../src/routes/permission-rules')
  const { privateFoldersRoute } = await import('../../src/routes/private-folders')
  app = new Hono()
  app.route('/api/git-http', gitHttpRoute)
  app.route('/api/companies/:companyId/departments', departmentsRoute)
  app.route('/api/companies/:companyId/folder-sizes', folderSizesRoute)
  app.route('/api/companies/:companyId', permissionsRoute)
  app.route('/api/companies/:companyId', permissionRulesRoute)
  app.route('/api/companies/:companyId', privateFoldersRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      gitBase = `http://127.0.0.1:${info.port}/api/git-http`
      resolve()
    })
  })

  // Seed the company repository as the owner.
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'seed'], seed)
  git(['config', 'user.email', 'seed@example.com'], seed)
  writeFile(seed, '人事/README.md', 'hr\n')
  writeFile(seed, 'sales/a.md', 'a\n')
  writeFile(seed, 'sales/Docs/x.md', 'x\n')
  commitAll(seed, 'seed')
  const r = await pushAs(seed, companyUrl(), 'owner')
  if (!r.ok) throw new Error(`seed failed: ${r.output}`)
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

let evalId: string
let secretId: string

describe('creating private folders', () => {
  it('is closed (even with force) while no released app syncs private folders', async () => {
    const cv = await import('../../src/lib/client-version')
    // Stage 3b merged as b8c5a8e (#137): its committer date (UTC).
    expect(cv.PRIVATE_FOLDERS_CLIENT_COMMIT_DATE).toBe('20261022085300')
    // As before 3b shipped: no cutoff.
    cv.setPrivateFoldersClientCutoffForTests(null)
    for (const force of [false, true]) {
      const r = await create('owner', { parentPath: '人事', name: '評価', force })
      expect(r.status).toBe(409)
      expect(r.body).toEqual({ error: '非公開フォルダは、全員のアプリが対応版になってから作成できます', code: 'PRIVATE_FOLDERS_UNAVAILABLE' })
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_repos`).get()).toEqual({ n: 0 })
    // From here on: as if stage 3b had shipped (nobody here runs that app yet).
    cv.setPrivateFoldersClientCutoffForTests('20260101000000')
  })

  it('the first one waits for every member\'s app (409 OUTDATED_CLIENTS); a manager cannot force', async () => {
    const r = await create('owner', { parentPath: '人事', name: '評価', viewers: ['u-viewer', 'u-editor'], editors: ['u-editor'] })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('OUTDATED_CLIENTS')
    expect(r.body.canForce).toBe(true)
    expect(r.body.members.map((m: Loose) => m.userId)).toContain('u-other')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_repos`).get()).toEqual({ n: 0 })

    const m = await create('hrmgr', { parentPath: '人事', name: '評価', force: true })
    expect(m.status).toBe(403)
    expect(m.body.code).toBe('FORCE_NOT_ALLOWED')
  })

  it('an owner creates one with force: repository, scope, rules', async () => {
    const r = await create('owner', { parentPath: '人事', name: '評価', viewers: ['u-viewer', 'u-editor', 'u-admin'], editors: ['u-editor'], force: true })
    expect(r.status).toBe(201)
    const d = r.body.data
    evalId = d.scopeId
    expect(d.path).toBe('人事/評価')
    expect(d.departmentId).toBe('d-hr')
    // owner + admin (always) + viewer + editor
    expect(d.viewerCount).toBe(4)
    expect(d.editorCount).toBe(3)
    expect(d.members.find((x: Loose) => x.userId === 'u-viewer')).toMatchObject({ canWrite: false, via: 'rule' })
    expect(d.members.find((x: Loose) => x.userId === 'u-admin')).toMatchObject({ canWrite: true, via: 'role' })
    expect(d.members.some((x: Loose) => x.userId === 'u-other')).toBe(false)
    const row = db.prepare(`SELECT repo_id FROM scopes WHERE id = ?`).get(evalId) as { repo_id: string }
    expect(existsSync(join(process.env.REPOS_DIR!, `${CO}.scopes`, `${row.repo_id}.git`))).toBe(true)
    const cfg = git(['-C', join(process.env.REPOS_DIR!, `${CO}.scopes`, `${row.repo_id}.git`), 'config', 'receive.denyNonFastForwards']).trim()
    expect(cfg).toBe('true')
  })

  it('a department manager creates one inside their department without force (not the first); defaults to creator + managers', async () => {
    const r = await create('hrmgr', { parentPath: '人事', name: '面談' })
    expect(r.status).toBe(201)
    expect(r.body.data.members.map((x: Loose) => x.userId).sort()).toEqual(['u-admin', 'u-hrmgr', 'u-owner'])
  })

  it('a manager cannot create outside their department or at the root; members cannot create', async () => {
    expect((await create('salesmgr', { parentPath: '人事', name: 'x' })).status).toBe(403)
    expect((await create('hrmgr', { parentPath: '', name: 'x' })).status).toBe(403)
    expect((await create('other', { parentPath: 'sales', name: 'x' })).status).toBe(403)
  })

  it('an editor must be a viewer; viewers must be members', async () => {
    expect((await create('owner', { parentPath: 'sales', name: 'y', viewers: ['u-viewer'], editors: ['u-other'] })).body.code).toBe('INVALID_MEMBERS')
    expect((await create('owner', { parentPath: 'sales', name: 'y', viewers: ['u-nobody'] })).body.code).toBe('INVALID_MEMBERS')
  })

  it('a taken name answers the same for a public folder (any case) and a private one', async () => {
    const pub = await create('owner', { parentPath: 'sales', name: 'docs' })
    const priv = await create('owner', { parentPath: '人事', name: '評価' })
    expect(pub.status).toBe(409)
    expect(priv.status).toBe(409)
    expect(pub.body).toEqual({ error: '『sales/docs』というフォルダ名は使えません。別の名前にしてください。', code: 'FOLDER_NAME_UNAVAILABLE' })
    expect(priv.body).toEqual({ error: '『人事/評価』というフォルダ名は使えません。別の名前にしてください。', code: 'FOLDER_NAME_UNAVAILABLE' })
    // NFD spelling of the private one
    const nfd = await create('owner', { parentPath: '人事', name: '評価'.normalize('NFD') })
    expect(nfd.body.code).toBe('FOLDER_NAME_UNAVAILABLE')
  })

  it('inside an unreadable private folder answers like a missing parent; a reader is told it is private already', async () => {
    // hrmgr manages 人事 but is not a viewer of 人事/評価
    const hidden = await create('hrmgr', { parentPath: '人事/評価', name: '2026' })
    const missing = await create('hrmgr', { parentPath: '人事/存在しない', name: '2026' })
    expect(hidden.status).toBe(400)
    expect(hidden.body).toEqual(missing.body)
    expect((await create('owner', { parentPath: '人事/評価', name: '2026' })).body.code).toBe('ALREADY_PRIVATE')
  })

  it('an ASCII-named one for the case tests', async () => {
    const r = await create('owner', { parentPath: 'sales', name: 'Secret', viewers: ['u-editor'] })
    expect(r.status).toBe(201)
    secretId = r.body.data.scopeId
  })
})

describe('GET /me/scopes', () => {
  it('a reader gets the path and clone URL; nobody gets anything about the others (no hashes, no salt)', async () => {
    const v = await as('viewer', 'GET', `${base}/me/scopes`)
    expect(v.status).toBe(200)
    expect(v.body.data.scopes).toEqual([{
      scopeId: evalId,
      path: '人事/評価',
      cloneUrl: expect.stringMatching(new RegExp(`/api/git-http/${CO}/scopes/${evalId}\\.git$`)),
      clonePath: `/api/git-http/${CO}/scopes/${evalId}.git`,
      canWrite: false,
    }])
    const o = await as('other', 'GET', `${base}/me/scopes`)
    expect(o.body.data.scopes).toEqual([])
    expect(o.text).not.toContain('評価')
    expect(o.text).not.toContain('面談')
    expect(o.text).not.toContain('Secret')
    expect(Object.keys(o.body.data).sort()).toEqual(['scopes', 'version'])
    expect(Object.keys(v.body.data).sort()).toEqual(['scopes', 'version'])
    // The version (ETag) does not move when someone else's private folder appears.
    expect(o.body.data.version).toBe((await as('salesmgr', 'GET', `${base}/me/scopes`)).body.data.version)
    const again = await as('other', 'GET', `${base}/me/scopes`, undefined, { 'If-None-Match': o.headers.get('ETag') })
    expect(again.status).toBe(304)
  })
})

describe('GET /me/private-folders', () => {
  it('lists only readable folders, with how many (and who) can read them', async () => {
    const v = await as('viewer', 'GET', `${base}/me/private-folders`)
    expect(v.status).toBe(200)
    expect(v.body.data).toHaveLength(1)
    const [folder] = v.body.data
    expect(folder).toMatchObject({ scopeId: evalId, path: '人事/評価', canWrite: false })
    expect(folder.viewerCount).toBe(folder.viewers.length)
    expect(folder.viewers.map((u: Loose) => u.userId)).toContain('u-viewer')
    // Named viewers come before owners/admins.
    expect(folder.viewers.findIndex((u: Loose) => u.role === 'owner')).toBeGreaterThan(folder.viewers.findIndex((u: Loose) => u.userId === 'u-viewer'))
    const o = await as('other', 'GET', `${base}/me/private-folders`)
    expect(o.body.data).toEqual([])
    expect(o.text).not.toContain('評価')
    expect((await as('owner', 'GET', `${base}/me/private-folders`)).body.data.length).toBeGreaterThanOrEqual(3)
  })
})

describe('scope repositories over git-http', () => {
  let editorClone: string

  it('a viewer clones; a non-viewer gets 404 (as for a repository that does not exist)', async () => {
    const v = await cloneAs(scopeUrl(evalId), 'viewer')
    expect(v.ok).toBe(true)
    expect(existsSync(join(v.dir, '.gitignore'))).toBe(true)
    const o = await cloneAs(scopeUrl(evalId), 'other')
    expect(o.ok).toBe(false)
    const none = await cloneAs(scopeUrl('00000000-0000-0000-0000-000000000000'), 'other')
    expect(o.output.replace(/clone\d+/g, '')).toContain('not found')
    expect(none.ok).toBe(false)
    const res = await fetch(`${scopeUrl(evalId)}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${Buffer.from('git:tok-other').toString('base64')}` } })
    expect(res.status).toBe(404)
  })

  it('an editor pushes; a read-only viewer is refused', async () => {
    const e = await cloneAs(scopeUrl(evalId), 'editor')
    editorClone = e.dir
    writeFile(editorClone, '2026/山田.md', 'A\n')
    writeFile(editorClone, '閲覧のみ/規程.md', 'r\n')
    commitAll(editorClone, 'eval')
    expect((await pushAs(editorClone, scopeUrl(evalId), 'editor')).ok).toBe(true)

    const v = await cloneAs(scopeUrl(evalId), 'viewer')
    writeFile(v.dir, 'x.md', 'x\n')
    commitAll(v.dir, 'viewer')
    const r = await pushAs(v.dir, scopeUrl(evalId), 'viewer')
    expect(r.ok).toBe(false)
  })

  it('every push rule runs in a scope repository: secrets, protected config', async () => {
    const c = await cloneAs(scopeUrl(evalId), 'editor')
    writeFile(c.dir, 'key.txt', 'AKIAIOSFODNN7EXAMPLE\n')
    writeFile(c.dir, '.mcp.json', '{}\n')
    commitAll(c.dir, 'bad')
    const r = await pushAs(c.dir, scopeUrl(evalId), 'editor')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
    expect(r.output).toContain('[SECRET_DETECTED]')
  })

  it('write permission is checked by the path inside the company tree', async () => {
    const put = await as('owner', 'PUT', `${base}/permissions/scopes/by-path`, {
      path: '人事/評価/閲覧のみ',
      rules: [{ subjectType: 'everyone', canWrite: false }],
    })
    expect(put.status).toBe(200)
    const c = await cloneAs(scopeUrl(evalId), 'editor')
    writeFile(c.dir, '閲覧のみ/規程.md', 'changed\n')
    writeFile(c.dir, '2026/佐藤.md', 'B\n')
    commitAll(c.dir, 'mixed')
    const r = await pushAs(c.dir, scopeUrl(evalId), 'editor')
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'WRITE_DENIED')).toEqual(['閲覧のみ/規程.md'])
  })

  it('a read restriction is accepted on a private folder only', async () => {
    const onPrivate = await as('hrmgr', 'PUT', `${base}/permissions/scopes/by-path`, {
      path: '人事/評価',
      rules: [
        { subjectType: 'everyone', canRead: false, canWrite: false },
        { subjectType: 'user', subjectId: 'u-viewer', canRead: true, canWrite: false },
        { subjectType: 'user', subjectId: 'u-editor', canRead: true, canWrite: true },
        { subjectType: 'user', subjectId: 'u-hrmgr', canRead: true, canWrite: false },
      ],
    })
    expect(onPrivate.status).toBe(200)
    const inside = await as('owner', 'PUT', `${base}/permissions/scopes/by-path`, {
      path: '人事/評価/2026', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }],
    })
    expect(inside.body.code).toBe('READ_RESTRICTION_UNAVAILABLE')
    const publicFolder = await as('owner', 'PUT', `${base}/permissions/scopes/by-path`, {
      path: 'sales', rules: [{ subjectType: 'everyone', canRead: false, canWrite: false }],
    })
    expect(publicFolder.body.code).toBe('READ_RESTRICTION_UNAVAILABLE')
    const cleared = await as('owner', 'PUT', `${base}/permissions/scopes/by-path`, { path: '人事/評価', rules: [] })
    expect(cleared.body.code).toBe('PRIVATE_RULES_REQUIRED')
    expect((await as('owner', 'DELETE', `${base}/permissions/scopes/${evalId}/rules`)).body.code).toBe('PRIVATE_RULES_REQUIRED')
    // the manager now reads it
    expect((await as('hrmgr', 'GET', `${base}/me/scopes`)).body.data.scopes.map((s: Loose) => s.path)).toContain('人事/評価')
  })
})

describe('[RESERVED_PATH] in the company repository', () => {
  async function pushFiles(user: User, files: Record<string, string>) {
    const c = await cloneAs(companyUrl(), user)
    for (const [rel, content] of Object.entries(files)) writeFile(c.dir, rel, content)
    commitAll(c.dir, 'try')
    return pushAs(c.dir, companyUrl(), user)
  }

  it('refuses a new file under a private folder\'s path, for members and the owner, naming only the folder they typed', async () => {
    for (const user of ['other', 'owner'] as const) {
      const r = await pushFiles(user, { '人事/評価/メモ.md': 'm\n', '人事/ok.md': 'ok\n' })
      expect(r.ok).toBe(false)
      expect(sectionPaths(r.output, 'RESERVED_PATH')).toEqual(['人事/評価/メモ.md'])
      expect(r.output).toContain('『人事/評価』というフォルダ名は使えません。別の名前にしてください。')
      expect(r.output).not.toMatch(/非公開|private|見られる/i)
      expect(r.output).not.toContain('WRITE_DENIED')
    }
  })

  it('case and NFC variants, deep nesting, a file at the path itself', async () => {
    const lower = await pushFiles('other', { 'sales/secret/a.md': 'a\n' })
    expect(sectionPaths(lower.output, 'RESERVED_PATH')).toEqual(['sales/secret/a.md'])
    expect(lower.output).toContain('『sales/secret』')
    const nfd = '人事/評価'.normalize('NFD')
    const n = await pushFiles('other', { [`${nfd}/a/b/c.md`]: 'c\n' })
    expect(n.ok).toBe(false)
    expect(sectionPaths(n.output, 'RESERVED_PATH')).toHaveLength(1)
    const file = await pushFiles('other', { 'sales/SECRET': 'file\n' })
    expect(sectionPaths(file.output, 'RESERVED_PATH')).toEqual(['sales/SECRET'])
  })

  it('a rename into the path is refused; neighbouring names are fine', async () => {
    const c = await cloneAs(companyUrl(), 'other')
    writeFile(c.dir, 'tmp/a.md', 'a\n')
    commitAll(c.dir, 'tmp')
    expect((await pushAs(c.dir, companyUrl(), 'other')).ok).toBe(true)
    git(['mv', 'tmp', '人事/評価'], c.dir)
    commitAll(c.dir, 'rename')
    const r = await pushAs(c.dir, companyUrl(), 'other')
    expect(sectionPaths(r.output, 'RESERVED_PATH')).toEqual(['人事/評価/a.md'])

    const ok = await pushFiles('other', { '人事/評定/a.md': 'a\n', 'sales/Secrets/a.md': 'b\n' })
    expect(ok.output).not.toContain('RESERVED_PATH')
    expect(ok.ok).toBe(true)
  })

  it('is recorded like other rejections', async () => {
    const rows = db.prepare(`SELECT marker, paths FROM push_rejections WHERE company_id = ? AND marker = 'RESERVED_PATH'`).all(CO) as Array<{ paths: string }>
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('no API reveals a private folder\'s name to a member who cannot read it', () => {
  const NAMES = ['評価', '面談', 'Secret"', 'Secret/', 'secret"', 'secret/']
  const clean = (text: string) => NAMES.every(n => !text.includes(n))

  it('a plain member', async () => {
    const urls = [
      `${base}/departments`,
      `${base}/departments/d-hr`,
      `${base}/departments/d-hr/stats`,
      `${base}/folder-sizes?path=人事`,
      `${base}/me/write-access`,
      `${base}/me/capabilities`,
      `${base}/me/scopes`,
      `${base}/permissions`,
      `${base}/permissions/folders?path=人事`,
      `${base}/permissions/effective?path=人事`,
      `${base}/overview`,
      `${base}/push-rejections`,
      `${base}/private-folders`,
      `${base}/private-folders/${evalId}`,
    ]
    for (const url of urls) {
      const r = await as('other', 'GET', url)
      expect(clean(r.text), `${url}: ${r.text}`).toBe(true)
    }
    // a private folder's path measures exactly like one that never existed
    const sizes = await as('other', 'GET', `${base}/folder-sizes?path=sales&measure=sales/Secret&measure=sales/nothing`)
    expect(sizes.body.data.measured['sales/Secret']).toBe(sizes.body.data.measured['sales/nothing'])
    // stats of a department holding private folders count only the company repository
    expect((await as('other', 'GET', `${base}/departments/d-hr/stats`)).body.data).toMatchObject({ files: 2, folders: 1 }) // README.md + 評定/a.md
  })

  it('a manager of another department (who may use the permission screens)', async () => {
    for (const url of [
      `${base}/permissions`,
      `${base}/permissions/folders?path=`,
      `${base}/permissions/folders?path=sales`,
      `${base}/private-folders`,
      `${base}/me/write-access`,
    ]) {
      const r = await as('salesmgr', 'GET', url)
      expect(['評価', '面談'].every(n => !r.text.includes(n)), `${url}: ${r.text}`).toBe(true)
    }
    expect((await as('salesmgr', 'GET', `${base}/private-folders/${evalId}`)).status).toBe(404)
    expect((await as('salesmgr', 'GET', `${base}/permissions/folders?path=人事`)).status).toBe(403)
  })

  it('the department\'s manager and owners see them in the permission browser and overview list', async () => {
    const folders = await as('hrmgr', 'GET', `${base}/permissions/folders?path=人事`)
    expect(folders.body.data.folders.filter((f: Loose) => f.private).map((f: Loose) => f.name).sort()).toEqual(['評価', '面談'])
    const inside = await as('owner', 'GET', `${base}/permissions/folders?path=人事/評価`)
    expect(inside.body.data.folders.map((f: Loose) => f.name).sort()).toEqual(['2026', '閲覧のみ'])
    const list = await as('owner', 'GET', `${base}/private-folders`)
    expect(list.body.data.map((p: Loose) => p.path)).toEqual(['sales/Secret', '人事/評価', '人事/面談'])
  })

  it('orphan warnings never list private folders or rules inside them', async () => {
    const o = await as('owner', 'GET', `${base}/overview`)
    expect(o.body.data.attention.orphanedScopes).toEqual([])
    const p = await as('owner', 'GET', `${base}/permissions`)
    expect(p.body.data.orphanedScopes).toEqual([])
  })
})

describe('departments containing private folders', () => {
  it('cannot be deleted or renamed; a department cannot take a private folder\'s name', async () => {
    expect((await as('owner', 'DELETE', `${base}/departments/d-hr`)).body.code).toBe('PRIVATE_FOLDERS_INSIDE')
    expect((await as('owner', 'PUT', `${base}/departments/d-hr`, { folder: '人事部' })).body.code).toBe('PRIVATE_FOLDERS_INSIDE')
  })
})

describe('make-public (公開に戻す)', () => {
  it('owner/admin only', async () => {
    expect((await as('hrmgr', 'POST', `${base}/private-folders/${secretId}/make-public`)).status).toBe(403)
    expect((await as('other', 'POST', `${base}/private-folders/${secretId}/make-public`)).status).toBe(403)
  })

  it('moves the contents into the company repository at the same path and removes the scope repository', async () => {
    const c = await cloneAs(scopeUrl(secretId), 'editor')
    writeFile(c.dir, 'plan.md', 'plan\n')
    commitAll(c.dir, 'plan')
    writeFile(c.dir, 'plan.md', 'plan v2\n')
    commitAll(c.dir, 'plan v2')
    expect((await pushAs(c.dir, scopeUrl(secretId), 'editor')).ok).toBe(true)
    const repoId = (db.prepare(`SELECT repo_id FROM scopes WHERE id = ?`).get(secretId) as { repo_id: string }).repo_id

    const r = await as('owner', 'POST', `${base}/private-folders/${secretId}/make-public`)
    expect(r.status).toBe(200)
    expect(r.body.data.path).toBe('sales/Secret')
    expect(git(['-C', bare, 'show', 'main:sales/Secret/plan.md'])).toBe('plan v2\n')
    // one commit, none of the scope's history
    expect(git(['-C', bare, 'log', '--format=%s', '-1', 'main']).trim()).toBe('Make private folder public: sales/Secret')
    expect(git(['-C', bare, 'log', '--format=%s', 'main']).includes('plan v2')).toBe(false)
    expect(existsSync(join(process.env.REPOS_DIR!, `${CO}.scopes`, `${repoId}.git`))).toBe(false)
    expect(db.prepare(`SELECT repo_id FROM scopes WHERE id = ?`).get(secretId)).toEqual({ repo_id: null })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_repos WHERE id = ?`).get(repoId)).toEqual({ n: 0 })

    // everyone reads it now; editing stays with its editors
    const rules = db.prepare(`SELECT subject_type, can_read, can_write FROM scope_rules WHERE scope_id = ? ORDER BY subject_type`).all(secretId)
    expect(rules).toEqual([
      { subject_type: 'everyone', can_read: 1, can_write: 0 },
      { subject_type: 'user', can_read: 1, can_write: 1 },
    ])
    expect((await as('other', 'POST', `${base}/paths/check`, { paths: ['sales/Secret/x.md', '人事/評価'] })).body.data.results)
      .toEqual([{ path: 'sales/Secret/x.md', usable: true }, { path: '人事/評価', usable: false }])
    // archived first (git bundle with the whole history, 0600 in a 0700 directory)
    const archive = db.prepare(`SELECT action, file, created_by FROM private_folder_archives WHERE scope_id = ?`).get(secretId) as Loose
    expect(archive).toMatchObject({ action: 'make-public', created_by: 'u-owner' })
    const bundle = join(process.env.DATA_DIR!, 'backups', 'private-folders', CO, archive.file)
    expect(statSync(bundle).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(bundle)).mode & 0o777).toBe(0o700)
    expect(git(['bundle', 'list-heads', bundle])).toContain('refs/heads/main')

    // no longer reserved: the editor may push there through the company repository
    const p = await cloneAs(companyUrl(), 'editor')
    writeFile(p.dir, 'sales/Secret/next.md', 'n\n')
    commitAll(p.dir, 'next')
    expect((await pushAs(p.dir, companyUrl(), 'editor')).ok).toBe(true)
    expect((await as('owner', 'POST', `${base}/private-folders/${secretId}/make-public`)).status).toBe(404)
  })
})

describe('the permission editor cannot open a private folder to everyone', () => {
  it('on the folder itself, everyone / role rules must deny read and write; only user rules grant', async () => {
    const put = (rules: Loose[]) => as('hrmgr', 'PUT', `${base}/permissions/scopes/by-path`, { path: '人事/評価', rules })
    const viewers = [
      { subjectType: 'user', subjectId: 'u-viewer', canRead: true, canWrite: false },
      { subjectType: 'user', subjectId: 'u-editor', canRead: true, canWrite: true },
    ]
    for (const everyone of [{ canRead: true, canWrite: false }, { canWrite: false }, { canRead: false, canWrite: true }]) {
      const r = await put([{ subjectType: 'everyone', ...everyone }, ...viewers])
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('PRIVATE_FOLDER_RULE')
    }
    const role = await put([{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'role', subjectId: 'member', canRead: true, canWrite: false }, ...viewers])
    expect(role.body.code).toBe('PRIVATE_FOLDER_RULE')
    const writeOnly = await put([{ subjectType: 'everyone', canRead: false, canWrite: false }, { subjectType: 'user', subjectId: 'u-viewer', canRead: false, canWrite: true }])
    expect(writeOnly.body.code).toBe('PRIVATE_FOLDER_RULE')

    // POST / PATCH of a single rule
    const post = await as('hrmgr', 'POST', `${base}/permissions/rules`, { path: '人事/評価', subjectType: 'role', subjectId: 'member', canRead: true, canWrite: false })
    expect(post.body.code).toBe('PRIVATE_FOLDER_RULE')
    const everyoneRule = db.prepare(`SELECT id FROM scope_rules WHERE scope_id = ? AND subject_type = 'everyone'`).get(evalId) as { id: string }
    const patch = await as('hrmgr', 'PATCH', `${base}/permissions/rules/${everyoneRule.id}`, { canRead: true, canWrite: false })
    expect(patch.status).toBe(400)
    expect(patch.body.code).toBe('PRIVATE_FOLDER_RULE')

    // nothing changed: other still cannot read it
    const o = await as('other', 'GET', `${base}/me/scopes`)
    expect(o.body.data.scopes).toEqual([])
    expect(db.prepare(`SELECT can_read, can_write FROM scope_rules WHERE id = ?`).get(everyoneRule.id)).toEqual({ can_read: 0, can_write: 0 })
  })
})

describe('POST /paths/check', () => {
  const check = (user: User, paths: unknown) => as(user, 'POST', `${base}/paths/check`, { paths })

  it('answers usable: false at or under a private folder the member cannot read — any case / NFC — and nothing more', async () => {
    const { resetPathCheckBudgetForTests } = await import('../../src/routes/private-folders')
    resetPathCheckBudgetForTests()
    const paths = ['人事/評価', `人事/${'評価'.normalize('NFD')}/a.md`, '人事/面談/x', '人事/存在しない/x', '人事', 'sales/a.md', 'SALES/新規']
    const o = await check('other', paths)
    expect(o.status).toBe(200)
    expect(o.body.data.results).toEqual([
      { path: '人事/評価', usable: false },
      { path: `人事/${'評価'.normalize('NFD')}/a.md`, usable: false },
      { path: '人事/面談/x', usable: false },
      { path: '人事/存在しない/x', usable: true },
      { path: '人事', usable: true },
      { path: 'sales/a.md', usable: true },
      { path: 'SALES/新規', usable: true },
    ])
    // The answer for a private path has exactly the shape of any other.
    expect(Object.keys(o.body.data.results[0]).sort()).toEqual(Object.keys(o.body.data.results[3]).sort())
    expect(o.text).not.toMatch(/private|非公開|scope/i)
    // A reader may put things inside (they go to its own repository); the owner everywhere.
    expect((await check('viewer', ['人事/評価/new.md', '人事/面談/x'])).body.data.results.map((r: Loose) => r.usable)).toEqual([true, false])
    expect((await check('owner', ['人事/評価/new.md', '人事/面談/x'])).body.data.results.map((r: Loose) => r.usable)).toEqual([true, true])
  })

  it('a path listed in `files` is also unusable above a private folder — for everyone, as [RESERVED_PATH] refuses a file there', async () => {
    const { resetPathCheckBudgetForTests } = await import('../../src/routes/private-folders')
    resetPathCheckBudgetForTests()
    for (const user of ['other', 'viewer', 'owner'] as const) {
      const r = await as(user, 'POST', `${base}/paths/check`, { paths: ['人事', '新規部署', '人事/評価/a.md'], files: ['人事', '新規部署', '人事/評価/a.md'] })
      expect(r.status).toBe(200)
      expect(r.body.data.results.map((x: Loose) => x.usable)).toEqual([false, true, user !== 'other'])
    }
    // Only the listed ones; without `files` (older apps): folder semantics, as before.
    expect((await as('other', 'POST', `${base}/paths/check`, { paths: ['人事', '新規部署'], files: ['新規部署'] })).body.data.results
      .map((x: Loose) => x.usable)).toEqual([true, true])
    expect((await check('other', ['人事', '人事/評価', '新規部署'])).body.data.results.map((x: Loose) => x.usable)).toEqual([true, false, true])
    expect((await as('other', 'POST', `${base}/paths/check`, { paths: ['a'], files: 'a' })).status).toBe(400)
    expect((await as('other', 'POST', `${base}/paths/check`, { paths: ['a'], files: [1] })).status).toBe(400)
  })

  it('validates the request', async () => {
    expect((await check('other', [])).status).toBe(400)
    expect((await check('other', 'x')).status).toBe(400)
    expect((await check('other', Array.from({ length: 51 }, (_, i) => `a${i}`))).status).toBe(400)
    expect((await check('other', ['../x'])).status).toBe(400)
    expect((await check('other', ['a\u0000b'])).status).toBe(400)
    expect((await as(null, 'POST', `${base}/paths/check`, { paths: ['a'] })).status).toBe(401)
  })

  it('limits each member to 60 paths a minute (enumeration stays slow)', async () => {
    const { resetPathCheckBudgetForTests } = await import('../../src/routes/private-folders')
    resetPathCheckBudgetForTests()
    const batch = Array.from({ length: 50 }, (_, i) => `guess${i}`)
    expect((await check('salesmgr', batch)).status).toBe(200)
    const over = await check('salesmgr', batch.slice(0, 11))
    expect(over.status).toBe(429)
    expect(over.body.code).toBe('RATE_LIMITED')
    expect(over.headers.get('Retry-After')).toBe('60')
    expect((await check('salesmgr', batch.slice(0, 10))).status).toBe(200)
    // per member: someone else is not affected
    expect((await check('editor', batch)).status).toBe(200)
  })
})

describe('deleting a private folder (owner/admin, type the name, archived first)', () => {
  let tempId: string
  let repoId: string

  it('setup: a private folder with some history', async () => {
    const r = await create('owner', { parentPath: 'sales', name: '一時', viewers: ['u-editor'] })
    expect(r.status).toBe(201)
    tempId = r.body.data.scopeId
    repoId = (db.prepare(`SELECT repo_id FROM scopes WHERE id = ?`).get(tempId) as { repo_id: string }).repo_id
    const c = await cloneAs(scopeUrl(tempId), 'editor')
    writeFile(c.dir, 'memo.md', 'secret memo\n')
    commitAll(c.dir, 'memo')
    expect((await pushAs(c.dir, scopeUrl(tempId), 'editor')).ok).toBe(true)
  })

  it('managers and members cannot; the name must be typed', async () => {
    expect((await as('salesmgr', 'DELETE', `${base}/private-folders/${tempId}?confirm=一時`)).status).toBe(403)
    expect((await as('editor', 'DELETE', `${base}/private-folders/${tempId}?confirm=一時`)).status).toBe(403)
    const none = await as('owner', 'DELETE', `${base}/private-folders/${tempId}`)
    expect(none.status).toBe(400)
    expect(none.body.code).toBe('CONFIRMATION_REQUIRED')
    expect((await as('owner', 'DELETE', `${base}/private-folders/${tempId}?confirm=${encodeURIComponent('sales/一時')}`)).body.code).toBe('CONFIRMATION_REQUIRED')
    expect(existsSync(join(process.env.REPOS_DIR!, `${CO}.scopes`, `${repoId}.git`))).toBe(true)
  })

  it('archives the repository, then removes it, its rules and its reservation', async () => {
    const r = await as('admin', 'DELETE', `${base}/private-folders/${tempId}?confirm=${encodeURIComponent('一時'.normalize('NFD'))}`)
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ path: 'sales/一時', archived: true })
    expect(r.text).not.toContain(process.env.DATA_DIR!)
    expect(existsSync(join(process.env.REPOS_DIR!, `${CO}.scopes`, `${repoId}.git`))).toBe(false)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scopes WHERE id = ?`).get(tempId)).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_rules WHERE scope_id = ?`).get(tempId)).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scope_repos WHERE id = ?`).get(repoId)).toEqual({ n: 0 })

    const archive = db.prepare(`SELECT action, file, path, created_by FROM private_folder_archives WHERE scope_id = ?`).get(tempId) as Loose
    expect(archive).toMatchObject({ action: 'delete', path: 'sales/一時', created_by: 'u-admin' })
    const bundle = join(process.env.DATA_DIR!, 'backups', 'private-folders', CO, archive.file)
    expect(statSync(bundle).mode & 0o777).toBe(0o600)
    // the whole history can be restored from it
    const restored = join(workDir, 'restored')
    git(['clone', '-q', bundle, restored])
    expect(git(['-C', restored, 'show', 'HEAD:memo.md'])).toBe('secret memo\n')

    // the editor lost it like losing access; the path is free again
    expect((await as('editor', 'GET', `${base}/me/scopes`)).body.data.scopes.map((s: Loose) => s.scopeId)).not.toContain(tempId)
    expect((await cloneAs(scopeUrl(tempId), 'editor')).ok).toBe(false)
    expect((await as('other', 'POST', `${base}/paths/check`, { paths: ['sales/一時/a.md'] })).body.data.results[0].usable).toBe(true)
    expect((await as('owner', 'DELETE', `${base}/private-folders/${tempId}?confirm=一時`)).status).toBe(404)
  })
})

describe('push checks added by the 2026-10-22 review', () => {
  async function pushFiles(user: User, files: Record<string, string>, prepare?: (dir: string) => void) {
    const c = await cloneAs(companyUrl(), user)
    for (const [rel, content] of Object.entries(files)) writeFile(c.dir, rel, content)
    prepare?.(c.dir)
    commitAll(c.dir, 'try')
    return pushAs(c.dir, companyUrl(), user)
  }

  it('a file or symlink where a folder above a private folder must stay a folder is refused (owner too)', async () => {
    // 人事 holds the private 人事/評価: it cannot become a symlink …
    for (const user of ['other', 'owner'] as const) {
      const link = await pushFiles(user, {}, (dir) => {
        git(['rm', '-r', '-q', '人事'], dir)
        symlinkSync('/tmp', join(dir, '人事'))
      })
      expect(link.ok).toBe(false)
      expect(sectionPaths(link.output, 'RESERVED_PATH')).toEqual(['人事'])
      expect(link.output).toContain('『人事』というフォルダ名は使えません。')
      expect(link.output).not.toContain('評価')
    }
    // … nor a file (any case), nor a gitlink
    const file = await pushFiles('other', {}, (dir) => {
      git(['rm', '-r', '-q', '人事'], dir)
      writeFileSync(join(dir, '人事'), 'not a folder\n')
    })
    expect(sectionPaths(file.output, 'RESERVED_PATH')).toEqual(['人事'])
    // a symlink AT the private folder's path is refused as before
    const at = await pushFiles('other', {}, (dir) => symlinkSync('/etc', join(dir, '人事', '面談')))
    expect(sectionPaths(at.output, 'RESERVED_PATH')).toEqual(['人事/面談'])
    // folders elsewhere may still become files
    const fine = await pushFiles('other', { 'docs2/a.md': 'a\n' })
    expect(fine.ok).toBe(true)
  })

  it('.backups/ and .workspace/ content is never shared, for anyone ([LOCAL_ONLY_PATH]); deleting it is fine', async () => {
    const r = await pushFiles('owner', { '.backups/2026-10-22/sales/a.md': 'mine\n', 'sales/.Workspace/tmp.txt': 't\n', 'sales/ok.md': 'ok\n' })
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'LOCAL_ONLY_PATH')).toEqual(['.backups/2026-10-22/sales/a.md', 'sales/.Workspace/tmp.txt'])
    expect(r.output).not.toContain('PERSONAL_PATH')
    // already shared before the rule (server-side commit): it can be removed
    const seed = join(workDir, 'local-only-seed')
    git(['clone', '-q', bare, seed])
    writeFile(seed, '.workspace/old.txt', 'old\n')
    git(['add', '-f', '.workspace/old.txt'], seed)
    git(['-c', 'user.name=s', '-c', 'user.email=s@e', 'commit', '-q', '-m', 'old'], seed)
    git(['-C', bare, 'fetch', '-q', seed, 'HEAD:refs/heads/main'])  // no hook: as if shared before the rule
    const del = await pushFiles('other', {}, (dir) => git(['rm', '-q', '.workspace/old.txt'], dir))
    expect(del.ok).toBe(true)
  })

  it('CLAUDE.md / AGENTS.md / CLAUDE.local.md: owner/admin anywhere, a manager inside their department, nobody else', async () => {
    const member = await pushFiles('other', { 'sales/CLAUDE.md': 'x\n', '人事/sub/AGENTS.md': 'x\n', 'CLAUDE.local.md': 'x\n', 'sales/notes.md': 'fine\n' })
    expect(member.ok).toBe(false)
    expect(sectionPaths(member.output, 'PROTECTED_CONFIG')).toEqual(['CLAUDE.local.md', 'sales/CLAUDE.md', '人事/sub/AGENTS.md'])

    // hrmgr manages 人事: theirs inside it (any depth, any case), not elsewhere, not the root
    const outside = await pushFiles('hrmgr', { '人事/claude.md': 'hr\n', '人事/a/b/AGENTS.md': 'hr\n', 'sales/CLAUDE.md': 'x\n', 'CLAUDE.md': 'x\n' })
    expect(sectionPaths(outside.output, 'PROTECTED_CONFIG')).toEqual(['CLAUDE.md', 'sales/CLAUDE.md'])
    const inside = await pushFiles('hrmgr', { '人事/claude.md': 'hr\n', '人事/a/b/AGENTS.md': 'hr\n' })
    expect(inside.ok).toBe(true)

    const admin = await pushFiles('admin', { 'CLAUDE.md': 'company\n', 'sales/AGENTS.md': 's\n' })
    expect(admin.ok).toBe(true)
    // a member deleting one is a change too
    const del = await pushFiles('other', {}, (dir) => git(['rm', '-q', 'CLAUDE.md'], dir))
    expect(sectionPaths(del.output, 'PROTECTED_CONFIG')).toEqual(['CLAUDE.md'])
  })
})

describe('a push racing the creation of a private folder at its path', () => {
  /**
   * A proxy in front of git-http that forwards the push's request headers at
   * once (so the server registers the push and takes its permission
   * snapshot) but holds its body until released.
   */
  async function delayedProxy(): Promise<{ url: string; release: () => void; held: Promise<void>; close: () => void }> {
    const http = await import('http')
    const target = new URL(gitBase)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let markHeld!: () => void
    const held = new Promise<void>(r => { markHeld = r })
    let holding = true
    const proxy = http.createServer((req, res) => {
      const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      up.on('error', () => res.destroy())
      if (holding && req.method === 'POST' && req.url?.endsWith('/git-receive-pack')) {
        holding = false
        up.flushHeaders()
        markHeld()
        void gate.then(() => req.pipe(up))
      } else {
        req.pipe(up)
      }
    })
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()))
    const port = (proxy.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}${target.pathname}/${CO}.git`, release, held, close: () => proxy.close() }
  }

  it('the push that started first wins: creation waits for it, sees its files and refuses', async () => {
    const { companyPushesInFlight } = await import('../../src/lib/private-folders')
    const proxy = await delayedProxy()
    try {
      const c = await cloneAs(companyUrl(), 'owner')
      writeFile(c.dir, 'sales/Race/plan.md', 'public plan\n')
      commitAll(c.dir, 'race')
      const push = pushAs(c.dir, proxy.url, 'owner')
      await proxy.held
      for (let i = 0; i < 200 && companyPushesInFlight(CO) === 0; i++) await new Promise(r => setTimeout(r, 25))
      expect(companyPushesInFlight(CO)).toBeGreaterThan(0)

      const creating = create('owner', { parentPath: 'sales', name: 'Race', viewers: ['u-editor'] })
      // Creation must not finish while the push that predates it is still running.
      const early = await Promise.race([creating.then(() => 'done'), new Promise(r => setTimeout(() => r('waiting'), 1500))])
      expect(early).toBe('waiting')
      proxy.release()

      const [p, r] = await Promise.all([push, creating])
      expect(p.ok).toBe(true)
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('FOLDER_NAME_UNAVAILABLE')
      expect(git(['-C', bare, 'show', 'main:sales/Race/plan.md'])).toBe('public plan\n')
      expect(db.prepare(`SELECT COUNT(*) AS n FROM scopes WHERE company_id = ? AND path = ?`).get(CO, 'sales/Race')).toEqual({ n: 0 })
      expect(companyPushesInFlight(CO)).toBe(0)
    } finally {
      proxy.close()
    }
  })

  it('without a push in flight creation does not wait; a push starting afterwards is refused', async () => {
    const r = await create('owner', { parentPath: 'sales', name: 'Race2', viewers: ['u-editor'] })
    expect(r.status).toBe(201)
    const c = await cloneAs(companyUrl(), 'owner')
    writeFile(c.dir, 'sales/Race2/plan.md', 'x\n')
    commitAll(c.dir, 'late')
    const p = await pushAs(c.dir, companyUrl(), 'owner')
    expect(sectionPaths(p.output, 'RESERVED_PATH')).toEqual(['sales/Race2/plan.md'])
  })
})
