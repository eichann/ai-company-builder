/**
 * Integration Test: links to files follow renames and moves (owner decision
 * 10/29, `.claude/rules/records.md` "Links to files") — a real bare
 * repository with the real push checker, the real indexer reading git's
 * rename detection, the records API and the department service.
 *
 * Guards:
 * - a file renamed and moved in one push takes the record's link along;
 * - a deleted file's link stays and the detail says it is broken
 *   (`broken: true`), a present one `broken: false`;
 * - a folder renamed in one push takes the links to it and to folders inside
 *   it along, and the detail says `folder: true`; a folder only some files
 *   left keeps its links (it still exists);
 * - a department renamed by the server takes its server records' folder and
 *   their links to files under it along (the record stays readable, the
 *   links stay whole).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const CO = 'reclink-co'
let workDir: string
let bare: string
let clone: string
let origin: string
let server: { close: () => void }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let services: any
const owner = { companyId: CO, userId: 'u-owner', role: 'owner' }

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}
function write(rel: string, content: string) {
  const full = join(clone, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}
function commitAndPush(message: string) {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', message], clone)
  const r = spawnSync('git', ['push', bare, 'HEAD:main'], { cwd: clone, env: { ...process.env, ACB_PUSHER_ROLE: 'owner' }, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`)
}

async function api(method: string, path: string, body?: unknown) {
  currentUser.id = 'u-owner'
  const res = await fetch(`${origin}/api/companies/${CO}/records${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown>; code?: string } }
}
const fileLinks = async (id: string) => ((await api('GET', `/item/${id}`)).body.data?.links as Array<{ path?: string; broken?: boolean }>)
  .filter(l => l.path !== undefined)
  .map(l => ({ path: l.path, broken: l.broken }))

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-record-links-'))
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'u-owner', now, now)
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('m-u-owner', 'u-owner', CO, 'owner', now, now)
  db.prepare('INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('dep-sales', CO, '営業部', '営業部', now, now)
  const { ensureCompanyScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, CO)

  const { configureBareRepo } = await import('../../src/routes/git')
  bare = join(process.env.REPOS_DIR!, `${CO}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  clone = join(workDir, 'clone')
  git(['init', '-q', '--initial-branch=main', clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  write('営業部/商談/提案書.md', '# 提案書\n\n第1章から第5章まで、導入の流れを書いた提案書の本文。\n')
  write('営業部/見積.md', '# 見積\n\n初期費用と月額の内訳。\n')
  commitAndPush('seed')

  services = (await import('../../src/composition')).services
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { recordsRoute } = await import('../../src/routes/records')
  const app = new Hono()
  app.route('/api/companies/:companyId', recordsRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      origin = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
  expect((await api('PUT', '/settings', { enabled: true })).status).toBe(200)
  await services.records.refreshIndex(owner)
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('links to files', () => {
  let id = ''

  it('follow a rename and a move; a deleted file’s link stays and reads as broken', async () => {
    const created = await api('POST', '/item', { type: 'task', title: '提案書の見直し', folder: '営業部', links: { files: ['営業部/商談/提案書.md', '営業部/見積.md'] } })
    expect(created.status).toBe(201)
    id = (created.body.data?.record as { id: string }).id
    expect(await fileLinks(id)).toEqual([{ path: '営業部/商談/提案書.md', broken: false }, { path: '営業部/見積.md', broken: false }])

    mkdirSync(join(clone, '営業部/提案'), { recursive: true })
    git(['mv', '営業部/商談/提案書.md', '営業部/提案/提案書_最終.md'], clone)
    git(['rm', '-q', '営業部/見積.md'], clone)
    commitAndPush('rename, move and delete')
    await services.records.refreshIndex(owner)
    expect(await fileLinks(id)).toEqual([{ path: '営業部/提案/提案書_最終.md', broken: false }, { path: '営業部/見積.md', broken: true }])
  })

  it('a folder moved as a whole takes its links along (and says it is a folder); one only partly emptied keeps them', async () => {
    write('営業部/資料/概要.md', '# 概要\n')
    write('営業部/資料/図/構成.md', '# 構成\n')
    write('営業部/束/一.md', '# 一\n')
    write('営業部/束/二.md', '# 二\n')
    commitAndPush('folders')
    await services.records.refreshIndex(owner)
    const created = await api('POST', '/item', { type: 'task', title: '資料をまとめる', folder: '営業部', links: { files: ['営業部/資料', '営業部/資料/図', '営業部/束'] } })
    expect(created.status).toBe(201)
    const folderTask = (created.body.data?.record as { id: string }).id
    const links = async () => ((await api('GET', `/item/${folderTask}`)).body.data?.links as Array<{ path?: string; broken?: boolean; folder?: true }>)
      .filter(l => l.path !== undefined).map(l => ({ path: l.path, broken: l.broken, folder: l.folder }))
    expect(await links()).toEqual([
      { path: '営業部/資料', broken: false, folder: true },
      { path: '営業部/資料/図', broken: false, folder: true },
      { path: '営業部/束', broken: false, folder: true },
    ])

    git(['mv', '営業部/資料', '営業部/資料2024'], clone)
    mkdirSync(join(clone, '営業部/別'), { recursive: true })
    git(['mv', '営業部/束/一.md', '営業部/別/一.md'], clone)
    commitAndPush('rename a folder; move one file out of another')
    await services.records.refreshIndex(owner)
    expect(await links()).toEqual([
      { path: '営業部/資料2024', broken: false, folder: true },
      { path: '営業部/資料2024/図', broken: false, folder: true },
      // Still there (二.md stayed): the link stays.
      { path: '営業部/束', broken: false, folder: true },
    ])
  })

  it('a department renamed by the server takes its records and their links along', async () => {
    const member = { companyId: CO, userId: 'u-owner', role: 'owner' }
    const dept = services.departments.get(member, 'dep-sales')
    expect(dept.ok).toBe(true)
    const renamed = await services.departments.update(member, dept.value, { folder: '営業一部' })
    expect(renamed.ok).toBe(true)
    await services.records.refreshIndex(owner)
    const detail = await api('GET', `/item/${id}`)
    expect(detail.status).toBe(200)
    // Its readers' folder moved with the department's scope.
    const { db } = await import('../../src/db')
    expect(db.prepare('SELECT folder FROM records WHERE company_id = ? AND id = ?').get(CO, id)).toEqual({ folder: '営業一部' })
    expect(await fileLinks(id)).toEqual([{ path: '営業一部/提案/提案書_最終.md', broken: false }, { path: '営業一部/見積.md', broken: true }])
  })
})
