/**
 * Integration Test: the department list is read from the bare repository and
 * never blocks the event loop; mutations on the working clone are serialized
 * per company.
 *
 * GET /departments used to `git pull` (or clone) the server's working clone
 * synchronously on every call. On a 7.7 GB clone that froze the whole process
 * — every API request and every member's git-http push/fetch — for 42 s after
 * each large push. These tests pin:
 *
 * (a) the list returns exactly what the old implementation returned: DB rows
 *     (sorted by sort_order) whose folder is a non-hidden directory at the
 *     root of a checkout of the shared branch. The oracle below is that old
 *     algorithm, run on a fresh clone;
 * (b) GET list / stats run no synchronous child process and let other
 *     requests through while git runs;
 * (c) concurrent creates for one company are serialized and all succeed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

// Count synchronous child_process calls made by the server code under test.
const syncCalls = vi.hoisted(() => ({ count: 0, log: [] as string[] }))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const wrap = <F extends (...args: never[]) => unknown>(name: string, fn: F): F =>
    ((...args: Parameters<F>) => {
      syncCalls.count++
      syncCalls.log.push(`${name} ${JSON.stringify(args.slice(0, 2))}`)
      return fn(...args)
    }) as F
  const overrides = {
    execFileSync: wrap('execFileSync', actual.execFileSync),
    spawnSync: wrap('spawnSync', actual.spawnSync),
    execSync: wrap('execSync', actual.execSync),
  }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'dl-owner',
    email: 'owner@example.com',
    name: 'Owner',
    image: null,
    emailVerified: true,
  }),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { execFileSync, spawnSync } from 'child_process'
import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { departmentsRoute } from '../../src/routes/departments'
import { withCompanyLock } from '../../src/lib/company-lock'
import { configureBareRepo } from '../../src/routes/git'

// Every push runs the real pre-receive hook, which is slow on some hosts.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

// The server's own commits (department creation) rely on a git identity;
// CI runners have none configured.
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.com'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

const REPOS_DIR = process.env.REPOS_DIR as string

const app = new Hono()
app.route('/api/companies/:companyId/departments', departmentsRoute)
app.get('/api/ping', (c) => c.json({ ok: true }))

const ts = () => new Date().toISOString()

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

let scratch: string
let cloneCounter = 0

function addCompany(id: string) {
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, id, 'dl-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`m-${id}`, 'dl-owner', id, 'owner', ts(), ts())
}

function addDeptRow(companyId: string, folder: string, sortOrder: number, isActive = 1) {
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`row-${companyId}-${folder}`, companyId, `Name ${folder}`, folder, sortOrder, isActive, ts(), ts())
}

function initBare(companyId: string, branch = 'main'): string {
  const bare = join(REPOS_DIR, `${companyId}.git`)
  git(['init', '-q', '--bare', `--initial-branch=${branch}`, bare])
  configureBareRepo(bare)
  return bare
}

/** A member's clone that pushes plain commits (not through the department API). */
function memberClone(bare: string): string {
  const clone = join(scratch, `member-${++cloneCounter}`)
  git(['clone', '-q', bare, clone])
  return clone
}

function pushAll(clone: string, branch = 'main', message = 'member change') {
  git(['add', '-A', '.'], clone)
  git(['commit', '-q', '--allow-empty', '-m', message], clone)
  const r = spawnSync('git', ['push', '-q', 'origin', `HEAD:${branch}`], {
    cwd: clone, env: { ...process.env, ACB_PUSHER_ROLE: 'owner' }, encoding: 'utf-8',
  })
  if (r.status !== 0) throw new Error(`push failed: ${r.stdout}${r.stderr}`)
}

function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    result[camelKey] = key === 'is_active' ? Boolean(value) : value
  }
  return result
}

/**
 * The pre-change algorithm: a checkout of the shared branch, non-hidden root
 * directories, DB rows (ORDER BY sort_order) whose folder is among them.
 */
function oracleList(companyId: string): unknown[] {
  const bare = join(REPOS_DIR, `${companyId}.git`)
  let folders: string[] = []
  if (existsSync(bare)) {
    const checkout = join(scratch, `oracle-${++cloneCounter}`)
    git(['clone', '-q', bare, checkout])
    folders = readdirSync(checkout).filter(item =>
      !item.startsWith('.') && statSync(join(checkout, item)).isDirectory())
  }
  const set = new Set(folders)
  const rows = db.prepare('SELECT * FROM departments WHERE company_id = ? ORDER BY sort_order ASC')
    .all(companyId) as Record<string, unknown>[]
  return rows
    .filter(r => set.has(r.folder as string))
    .map(toCamelCase)
    .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number))
}

/** The pre-change stats count, on a fresh checkout. */
function oracleStats(companyId: string, folder: string): { files: number; folders: number; exists: boolean } {
  const bare = join(REPOS_DIR, `${companyId}.git`)
  const checkout = join(scratch, `oracle-${++cloneCounter}`)
  git(['clone', '-q', bare, checkout])
  const root = join(checkout, folder)
  if (!existsSync(root)) return { files: 0, folders: 0, exists: false }
  let files = 0
  let folders = 0
  const count = (p: string) => {
    for (const item of readdirSync(p)) {
      if (item.startsWith('.')) continue
      if (statSync(join(p, item)).isDirectory()) { folders++; count(join(p, item)) } else files++
    }
  }
  try {
    count(root)
  } catch {
    // The old handler's catch: e.g. a DB folder that is a file (ENOTDIR)
    return { files: 0, folders: 0, exists: false }
  }
  return { files, folders, exists: true }
}

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await app.request(path, init)
  return { status: res.status, text: await res.clone().text(), body: await res.json() as Record<string, unknown> }
}

const list = (companyId: string) => call('GET', `/api/companies/${companyId}/departments`)

beforeAll(() => {
  initDatabase()
  scratch = mkdtempSync(join(tmpdir(), 'acb-dept-list-'))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('GET /departments returns the same data as before', () => {
  const CO = 'dl-mixed'

  beforeAll(async () => {
    addCompany(CO)
    const bare = initBare(CO)
    // Seed the branch as company creation does
    const seed = memberClone(bare)
    git(['checkout', '-q', '-B', 'main'], seed)
    writeFile(seed, '.gitattributes', '* text=auto eol=lf\n')
    writeFile(seed, 'README.md', 'root file\n')
    pushAll(seed, 'main', 'seed')

    // Departments created through the API (ASCII and Japanese)
    for (const [name, folder] of [['Sales', 'sales'], ['営業部', '営業部'], ['コンテンツ', 'コンテンツ_2'], ['Gone', 'gone']]) {
      const r = await call('POST', `/api/companies/${CO}/departments`, { name, folder })
      expect(r.status, r.text).toBe(201)
    }

    // Plain pushes from a member: files inside departments, a folder with a DB
    // row only pushed (経理), a folder with no DB row (docs), a hidden folder,
    // and the deletion of an API-created department folder (gone).
    const member = memberClone(bare)
    writeFile(member, 'sales/proposal.md', 'p\n')
    writeFile(member, 'sales/2026/q3/plan.md', 'q\n')
    writeFile(member, 'sales/.hidden/secret.md', 'h\n')
    writeFile(member, '営業部/提案書/案件A.md', 'a\n')
    writeFile(member, '経理/月次/9月.md', 'x\n')
    writeFile(member, 'docs/readme.md', 'd\n')
    writeFile(member, '.claude/skills/x/SKILL.md', '---\nname: x\n---\nbody\n')
    rmSync(join(member, 'gone'), { recursive: true, force: true })
    pushAll(member)

    // DB rows without a matching directory, plus hidden / file names
    addDeptRow(CO, '経理', 10, 0)
    addDeptRow(CO, 'ghost', 11)
    addDeptRow(CO, 'README.md', 12)
    addDeptRow(CO, '.claude', 13)
  })

  it('matches the checkout-based listing field for field', async () => {
    const r = await list(CO)
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    const expected = oracleList(CO)
    expect(r.body.data).toEqual(expected)
    // Byte-compatible: same keys in the same order as the DB row mapping
    expect(r.text).toBe(JSON.stringify({ success: true, data: expected }))
    expect((r.body.data as Array<{ folder: string }>).map(d => d.folder))
      .toEqual(['sales', '営業部', 'コンテンツ_2', '経理'])
    const keiri = (r.body.data as Array<Record<string, unknown>>).find(d => d.folder === '経理')
    expect(keiri?.isActive).toBe(false)
  })

  it('follows sort_order changes (reorder)', async () => {
    const rows = db.prepare('SELECT id, folder FROM departments WHERE company_id = ?').all(CO) as Array<{ id: string; folder: string }>
    const order = ['経理', 'コンテンツ_2', 'sales', '営業部']
    const items = order.map((folder, i) => ({ id: rows.find(r => r.folder === folder)!.id, sortOrder: i }))
    const re = await call('POST', `/api/companies/${CO}/departments/reorder`, { items })
    expect(re.status).toBe(200)
    const r = await list(CO)
    expect(r.body.data).toEqual(oracleList(CO))
    expect((r.body.data as Array<{ folder: string }>).map(d => d.folder)).toEqual(order)
  })

  it('reflects a push immediately (no working clone involved)', async () => {
    const member = memberClone(join(REPOS_DIR, `${CO}.git`))
    writeFile(member, 'ghost/now-exists.md', 'g\n')
    pushAll(member)
    const r = await list(CO)
    expect(r.body.data).toEqual(oracleList(CO))
    expect((r.body.data as Array<{ folder: string }>).map(d => d.folder)).toContain('ghost')
  })

  it('stats match the checkout-based count', async () => {
    const rows = db.prepare('SELECT id, folder FROM departments WHERE company_id = ?').all(CO) as Array<{ id: string; folder: string }>
    for (const row of rows) {
      const r = await call('GET', `/api/companies/${CO}/departments/${row.id}/stats`)
      expect(r.status).toBe(200)
      expect(r.body, row.folder).toEqual({ success: true, data: oracleStats(CO, row.folder) })
    }
    const sales = rows.find(r => r.folder === 'sales')!
    const r = await call('GET', `/api/companies/${CO}/departments/${sales.id}/stats`)
    expect(r.body.data).toEqual({ files: 2, folders: 2, exists: true })
  })

  it('an empty repository (no branch yet) lists nothing, like before', async () => {
    addCompany('dl-empty')
    initBare('dl-empty')
    addDeptRow('dl-empty', 'sales', 0)
    const r = await list('dl-empty')
    expect(r.status).toBe(200)
    expect(r.text).toBe(JSON.stringify({ success: true, data: [] }))
    expect(oracleList('dl-empty')).toEqual([])
  })

  it('a missing repository lists nothing, like before', async () => {
    addCompany('dl-norepo')
    addDeptRow('dl-norepo', 'sales', 0)
    const r = await list('dl-norepo')
    expect(r.status).toBe(200)
    expect(r.text).toBe(JSON.stringify({ success: true, data: [] }))
  })

  it('a repository whose only branch is master is still listed (old pull fallback)', async () => {
    addCompany('dl-master')
    const bare = initBare('dl-master', 'master')
    const member = memberClone(bare)
    git(['checkout', '-q', '-B', 'master'], member)
    writeFile(member, 'legacy/a.md', 'a\n')
    pushAll(member, 'master')
    addDeptRow('dl-master', 'legacy', 0)
    const r = await list('dl-master')
    expect(r.body.data).toEqual(oracleList('dl-master'))
    expect((r.body.data as unknown[]).length).toBe(1)
  })
})

describe('GET /departments does not block the event loop', () => {
  const CO = 'dl-block'

  beforeAll(async () => {
    addCompany(CO)
    const bare = initBare(CO)
    const member = memberClone(bare)
    git(['checkout', '-q', '-B', 'main'], member)
    for (let i = 0; i < 20; i++) writeFile(member, `dept${i}/f.md`, `${i}\n`)
    pushAll(member, 'main', 'seed')
    for (let i = 0; i < 20; i++) addDeptRow(CO, `dept${i}`, i)
  })

  it('runs no synchronous child process for list and stats', async () => {
    syncCalls.count = 0
    syncCalls.log = []
    const r = await list(CO)
    const row = db.prepare('SELECT id FROM departments WHERE company_id = ? AND folder = ?').get(CO, 'dept3') as { id: string }
    const s = await call('GET', `/api/companies/${CO}/departments/${row.id}/stats`)
    expect(syncCalls.log).toEqual([])
    expect((r.body.data as unknown[]).length).toBe(20)
    expect(s.body.data).toEqual({ files: 1, folders: 0, exists: true })
    // And never creates the working clone
    expect(existsSync(join(process.env.DATA_DIR as string, 'workdirs', CO))).toBe(false)
  })

  it('lets timers and other requests run while the list is waiting on git', async () => {
    let listDone = false
    const listPromise = list(CO).then(r => { listDone = true; return r })
    // A timer scheduled after the list started fires before it finishes:
    // the list yields to the event loop while git runs in a child process.
    const pingStatus = await new Promise<number>(resolve => {
      setTimeout(async () => {
        const doneAtTimer = listDone
        const ping = await app.request('/api/ping')
        resolve(doneAtTimer ? -1 : ping.status)
      }, 0)
    })
    expect(pingStatus).toBe(200)
    const r = await listPromise
    expect((r.body.data as unknown[]).length).toBe(20)
  })
})

describe('department mutations are serialized per company', () => {
  it('withCompanyLock runs one task at a time per company and survives failures', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const task = (name: string, fail = false) => withCompanyLock('lock-co', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 10))
      order.push(name)
      active--
      if (fail) throw new Error('boom')
      return name
    })
    const results = await Promise.allSettled([task('a'), task('b', true), task('c'), task('d')])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    expect(order).toEqual(['a', 'b', 'c', 'd'])
    expect(maxActive).toBe(1)

    // Different companies do not wait for each other
    let otherRan = false
    const slow = withCompanyLock('lock-co', () => new Promise(r => setTimeout(r, 50)))
    await withCompanyLock('lock-other', async () => { otherRan = true })
    expect(otherRan).toBe(true)
    await slow
  })

  it('concurrent creates for the same company all succeed and all reach the repository', async () => {
    const CO = 'dl-concurrent'
    addCompany(CO)
    const bare = initBare(CO)
    const seed = memberClone(bare)
    git(['checkout', '-q', '-B', 'main'], seed)
    writeFile(seed, 'README.md', 'seed\n')
    pushAll(seed, 'main', 'seed')

    const folders = ['alpha', 'beta', '開発部', 'gamma', 'デザイン']
    const results = await Promise.all(folders.map(folder =>
      call('POST', `/api/companies/${CO}/departments`, { name: folder, folder })))
    for (const r of results) expect(r.status, r.text).toBe(201)

    const sortOrders = results.map(r => (r.body.data as { sortOrder: number }).sortOrder).sort()
    expect(sortOrders).toEqual([0, 1, 2, 3, 4])

    const tree = git(['-C', bare, 'ls-tree', '-z', '--name-only', 'main']).split('\0').filter(Boolean)
    for (const folder of folders) expect(tree).toContain(folder)
    const log = git(['-C', bare, 'log', '--format=%s', 'main']).trim().split('\n')
    expect(log.filter(l => l.startsWith('Add department: ')).length).toBe(folders.length)

    const r = await list(CO)
    expect((r.body.data as Array<{ folder: string }>).map(d => d.folder)).toEqual(folders.map(f => f)
      .sort((a, b) => {
        const oa = (results.find(x => (x.body.data as { folder: string }).folder === a)!.body.data as { sortOrder: number }).sortOrder
        const ob = (results.find(x => (x.body.data as { folder: string }).folder === b)!.body.data as { sortOrder: number }).sortOrder
        return oa - ob
      }))

    // A duplicate created concurrently with a rename and a delete still
    // leaves a consistent repository.
    const rows = db.prepare('SELECT id, folder FROM departments WHERE company_id = ?').all(CO) as Array<{ id: string; folder: string }>
    const [dup, ren, del] = await Promise.all([
      call('POST', `/api/companies/${CO}/departments`, { name: 'alpha', folder: 'alpha' }),
      call('PUT', `/api/companies/${CO}/departments/${rows.find(x => x.folder === 'beta')!.id}`, { folder: 'beta2' }),
      call('DELETE', `/api/companies/${CO}/departments/${rows.find(x => x.folder === 'gamma')!.id}`),
    ])
    expect(dup.status).toBe(409)
    expect(ren.status, ren.text).toBe(200)
    expect(del.status, del.text).toBe(200)
    const after = git(['-C', bare, 'ls-tree', '-z', '--name-only', 'main']).split('\0').filter(Boolean)
    expect(after).toContain('beta2')
    expect(after).not.toContain('beta')
    expect(after).not.toContain('gamma')
    expect(((await list(CO)).body.data as unknown[])).toEqual(oracleList(CO))
  })
})
