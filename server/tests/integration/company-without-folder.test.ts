/**
 * Integration Test: a company without the shared company folder (owner decision 2026-11-07,
 * shared/core/company-folder.ts, server.md "Companies without a shared folder").
 *
 * Guards:
 * - creating one makes no repository, and nothing later makes one appear (git-http answers
 *   404 even for a repository someone put on disk under its id);
 * - its departments are its rows: list / create / rename / delete work without a repository,
 *   and a folder name is still taken once (nameKey);
 * - everything that needs the repository refuses with 409 NO_COMPANY_FOLDER and a plain
 *   Japanese sentence instead of crashing (500) or answering "empty" as if files existed;
 * - records keep working, placed in departments; file links are refused;
 * - a company created without choosing (and every company before this change) keeps the
 *   repository and its behaviour.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'nf-owner' as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { departmentsRoute } from '../../src/routes/departments'
import { privateFoldersRoute } from '../../src/routes/private-folders'
import { companyFilesRoute } from '../../src/routes/company-files'
import { folderSizesRoute } from '../../src/routes/folder-sizes'
import { gitRoute } from '../../src/routes/git'
import { gitHttpRoute } from '../../src/routes/git-http'
import { permissionRulesRoute } from '../../src/routes/permission-rules'
import { recordsRoute } from '../../src/routes/records'
import { setPrivateFoldersClientCutoffForTests } from '../../src/lib/client-version'
import { setRepoGitTimeoutsForTests } from '../../src/adapters/git-repo-store'
import { services } from '../../src/composition'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const REPOS_DIR = process.env.REPOS_DIR as string
const DATA_DIR = process.env.DATA_DIR as string

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.route('/api/companies/:companyId', privateFoldersRoute)
app.route('/api/companies/:companyId/files', companyFilesRoute)
app.route('/api/companies/:companyId/folder-sizes', folderSizesRoute)
app.route('/api/companies/:companyId', permissionRulesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

const SESSION_TOKEN = 'nf-session-token'
const repoOf = (id: string) => join(REPOS_DIR, `${id}.git`)

let none: string
let git: string
let scratch: string
let savedTemplateDir: string | undefined

/** 409 NO_COMPANY_FOLDER with a Japanese sentence that names the reason. */
function expectNoFolder(r: { status: number; body: Json }) {
  expect(r.status).toBe(409)
  expect(r.body.code).toBe('NO_COMPANY_FOLDER')
  expect(r.body.error).toMatch(/全社フォルダを使わない設定/)
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'nf-owner'
  setRepoGitTimeoutsForTests({ local: 60_000, push: 120_000 })
  scratch = mkdtempSync(join(tmpdir(), 'acb-no-folder-'))
  savedTemplateDir = process.env.GIT_TEMPLATE_DIR
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(scratch, 'templates-'))
  // A released app syncs private folders (else POST /private-folders refuses before anything else).
  setPrivateFoldersClientCutoffForTests('2026-01-01T00:00:00Z')
  // git-http's session token (accounts.bySessionToken reads Better Auth's table).
  const auth = new Database(join(DATA_DIR, 'auth.sqlite'))
  auth.prepare('INSERT INTO user (id, name, email) VALUES (?, ?, ?)').run('nf-owner', 'Owner', 'nf-owner@example.com')
  auth.prepare('INSERT INTO session (id, token, expiresAt, userId) VALUES (?, ?, ?, ?)')
    .run('nf-session', SESSION_TOKEN, new Date(Date.now() + 3600_000).toISOString(), 'nf-owner')
  auth.close()

  const created = await call('POST', '/api/companies', { name: 'No Folder Co', folderKind: 'none' })
  expect(created.status).toBe(201)
  none = created.body.data.id
  const plain = await call('POST', '/api/companies', { name: 'Git Co' })
  expect(plain.status).toBe(201)
  git = plain.body.data.id
  // A company with the folder gets its core types at its first push; none happens here.
  await services.records.refreshIndex({ companyId: git, userId: 'nf-owner', role: 'owner' })
})

afterAll(() => {
  delete process.env.OPERATOR_USER_IDS
  setPrivateFoldersClientCutoffForTests(undefined)
  if (savedTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR
  else process.env.GIT_TEMPLATE_DIR = savedTemplateDir
  rmSync(scratch, { recursive: true, force: true })
})

describe('creating a company with or without the shared folder', () => {
  it('without: no repository, and the company says so to its members', async () => {
    expect(existsSync(repoOf(none))).toBe(false)
    const got = await call('GET', `/api/companies/${none}`)
    expect(got.status).toBe(200)
    expect(got.body.data.folderKind).toBe('none')
    expect(got.body.data.repoPath).toBeNull()
    const listed = await call('GET', '/api/companies')
    expect(listed.body.data.find((c: Json) => c.id === none).folderKind).toBe('none')
  })

  it('not choosing keeps today\'s company: the repository and kind git', async () => {
    expect(existsSync(repoOf(git))).toBe(true)
    expect((await call('GET', `/api/companies/${git}`)).body.data.folderKind).toBe('git')
  })

  it('an unknown kind is refused and creates nothing', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n
    const r = await call('POST', '/api/companies', { name: 'Drive Co', folderKind: 'drive' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('INVALID_FOLDER_KIND')
    expect((db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n).toBe(before)
  })
})

describe('departments of a company without the shared folder are its rows', () => {
  const base = () => `/api/companies/${none}/departments`

  it('lists the default departments without a repository', async () => {
    const r = await call('GET', base())
    expect(r.status).toBe(200)
    expect(r.body.data.map((d: Json) => d.folder)).toEqual(['営業部', '経理部', '人事部', 'コンテンツ', '開発部', '総務'])
  })

  it('creates, renames and deletes departments; a folder name is taken once', async () => {
    const created = await call('POST', base(), { name: '企画', folder: 'Planning' })
    expect(created.status).toBe(201)
    expect((await call('POST', base(), { name: '企画2', folder: 'planning' })).status).toBe(409)
    expect((await call('GET', base())).body.data.map((d: Json) => d.folder)).toContain('Planning')

    const id = created.body.data.id
    expect((await call('PUT', `${base()}/${id}`, { folder: '営業部' })).status).toBe(409)
    const renamed = await call('PUT', `${base()}/${id}`, { folder: 'Kikaku', name: '企画部' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.data.folder).toBe('Kikaku')
    // Its permission scope moved with it (records placed there keep their rules).
    expect(db.prepare('SELECT path FROM scopes WHERE company_id = ? AND department_id = ?').get(none, id)).toEqual({ path: 'Kikaku' })
    // A case-only rename of its own folder is allowed.
    expect((await call('PUT', `${base()}/${id}`, { folder: 'KIKAKU' })).status).toBe(200)

    const stats = await call('GET', `${base()}/${id}/stats`)
    expect(stats.status).toBe(200)
    expect(stats.body.data).toEqual({ files: 0, folders: 0, exists: false })
    expect((await call('DELETE', `${base()}/${id}`)).status).toBe(200)
    expect((await call('GET', base())).body.data.map((d: Json) => d.folder)).not.toContain('KIKAKU')
    expect(existsSync(repoOf(none))).toBe(false)
  })

  it('"follow the folders" has nothing to follow', async () => {
    expectNoFolder(await call('POST', `${base()}/sync`))
  })
})

describe('what needs the repository refuses clearly', () => {
  it('private folders', async () => {
    expectNoFolder(await call('POST', `/api/companies/${none}/private-folders`, { parentPath: '営業部', name: 'secret' }))
  })

  it('reading company files for the AI', async () => {
    expectNoFolder(await call('GET', `/api/companies/${none}/files/tree?path=`))
    expectNoFolder(await call('GET', `/api/companies/${none}/files/content?path=${encodeURIComponent('営業部/a.md')}`))
    expectNoFolder(await call('GET', `/api/companies/${none}/files/search?q=x`))
    // …while a company with the folder answers as before.
    expect((await call('GET', `/api/companies/${git}/files/tree?path=`)).status).toBe(200)
  })

  it('folder sizes', async () => {
    expectNoFolder(await call('GET', `/api/companies/${none}/folder-sizes?path=`))
    expect((await call('GET', `/api/companies/${git}/folder-sizes?path=`)).status).toBe(200)
  })

  it('the repository URL', async () => {
    expectNoFolder(await call('GET', `/api/git/repos/${none}`))
    expect((await call('GET', `/api/git/repos/${git}`)).status).toBe(200)
  })

  it('git over HTTP, even for a repository put on disk under its id', async () => {
    execFileSync('git', ['init', '--bare', '--quiet', repoOf(none)])
    try {
      const auth = { Authorization: `Basic ${Buffer.from(`git:${SESSION_TOKEN}`).toString('base64')}` }
      const r = await call('GET', `/api/git-http/${none}.git/info/refs?service=git-upload-pack`, undefined, auth)
      expect(r.status).toBe(404)
      expect((await call('GET', `/api/git-http/${git}.git/info/refs?service=git-upload-pack`, undefined, auth)).status).toBe(200)
    } finally {
      rmSync(repoOf(none), { recursive: true, force: true })
    }
  })
})

describe('permission rules: the places are the departments', () => {
  it('lists the departments as folders and takes rules on them, nothing below', async () => {
    const top = await call('GET', `/api/companies/${none}/permissions/folders`)
    expect(top.status).toBe(200)
    expect(top.body.data.folders.map((f: Json) => f.name)).toContain('営業部')
    const inside = await call('GET', `/api/companies/${none}/permissions/folders?path=${encodeURIComponent('営業部')}`)
    expect(inside.status).toBe(200)
    expect(inside.body.data.folders).toEqual([])
    expect((await call('GET', `/api/companies/${none}/permissions/folders?path=${encodeURIComponent('どこにもない')}`)).status).toBe(404)

    const rule = { path: '経理部', subjectType: 'everyone', canRead: true, canWrite: false }
    expect((await call('POST', `/api/companies/${none}/permissions/rules`, rule)).status).toBe(201)
    expect((await call('POST', `/api/companies/${none}/permissions/rules`, { ...rule, path: '経理部/下' })).status).toBe(400)
  })
})

describe('records without the shared folder', () => {
  const records = () => `/api/companies/${none}/records`

  it('are placed in departments; a place that is no department is refused', async () => {
    const placed = await call('POST', `${records()}/item`, { type: 'task', title: '営業の段取り', folder: '営業部', fields: { assignee: 'nf-owner' } })
    expect(placed.status).toBe(201)
    const nowhere = await call('POST', `${records()}/item`, { type: 'task', title: 'どこか', folder: 'どこにもない', fields: { assignee: 'nf-owner' } })
    expect(nowhere.status).toBe(400)
    expect(nowhere.body.code).toBe('FOLDER_NOT_PLACEABLE')
  })

  it('refuse file links, on create and later', async () => {
    expectNoFolder(await call('POST', `${records()}/item`, { type: 'task', title: 'ファイル付き', fields: { assignee: 'nf-owner' }, links: { files: ['営業部/見積.md'] } }))

    const task = await call('POST', `${records()}/item`, { type: 'task', title: 'あとでつなぐ', fields: { assignee: 'nf-owner' } })
    expect(task.status).toBe(201)
    const id = task.body.data.record.id
    const version = task.body.data.record.version ?? 1
    const linked = await call('POST', `${records()}/item/${id}/file-links`, { path: '営業部/見積.md', expectedVersion: version })
    expectNoFolder(linked)
  })

  it('a company with the folder still links files', async () => {
    const task = await call('POST', `/api/companies/${git}/records/item`, { type: 'task', title: 'ファイル付き', fields: { assignee: 'nf-owner' }, links: { files: ['営業部/見積.md'] } })
    expect(task.status).toBe(201)
  })
})

describe('who sees a record does not depend on the repository', () => {
  // A record's visibility comes from the database (scopes and their rules, owner-only and
  // members-only lists): a place with no repository behind it must never make a record wider.
  const records = () => `/api/companies/${none}/records`
  const asMember = async <T>(fn: () => Promise<T>) => {
    currentUser.id = 'nf-member'
    try { return await fn() } finally { currentUser.id = 'nf-owner' }
  }

  beforeAll(() => {
    const at = new Date().toISOString()
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('nf-membership', 'nf-member', none, 'member', at, at)
    // 総務 is read only by owners and admins. The rule row is inserted directly: no API can make
    // a read-restricted place for a company without the shared folder yet (read restriction is
    // only through private folders, which it has none of; pinned below). The row proves that
    // who sees a record comes from the database and never widens without a repository.
    const scope = db.prepare('SELECT id FROM scopes WHERE company_id = ? AND path = ?').get(none, '総務') as { id: string }
    db.prepare('INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('nf-rule-somu', scope.id, 'everyone', null, 0, 0, at)
  })

  it('today the rules editor cannot restrict who reads a department (no private folders; a place without git is the next work)', async () => {
    const r = await call('POST', `/api/companies/${none}/permissions/rules`, { path: '経理部', subjectType: 'everyone', canRead: false, canWrite: false })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('READ_RESTRICTION_UNAVAILABLE')
  })

  it('a record in a department the member cannot read stays hidden; one they can read is shown', async () => {
    const hidden = await call('POST', `${records()}/item`, { type: 'task', title: '総務だけ', folder: '総務', fields: { assignee: 'nf-owner' } })
    expect(hidden.status).toBe(201)
    const shown = await call('POST', `${records()}/item`, { type: 'task', title: '営業の話', folder: '営業部', fields: { assignee: 'nf-owner' } })
    expect(shown.status).toBe(201)
    expect((await asMember(() => call('GET', `${records()}/item/${hidden.body.data.record.id}`))).status).toBe(404)
    expect((await asMember(() => call('GET', `${records()}/item/${shown.body.data.record.id}`))).status).toBe(200)
  })

  it('owner-only and members-only records stay with their people', async () => {
    const mine = await call('POST', `${records()}/item`, { type: 'task', title: '自分だけ', personal: true, fields: { assignee: 'nf-owner' } })
    expect(mine.status).toBe(201)
    const listed = await call('POST', `${records()}/item`, { type: 'task', title: 'この人たちだけ', members: ['nf-owner'], fields: { assignee: 'nf-owner' } })
    expect(listed.status).toBe(201)
    expect((await asMember(() => call('GET', `${records()}/item/${mine.body.data.record.id}`))).status).toBe(404)
    expect((await asMember(() => call('GET', `${records()}/item/${listed.body.data.record.id}`))).status).toBe(404)
  })
})
