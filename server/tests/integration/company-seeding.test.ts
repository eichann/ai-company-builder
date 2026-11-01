/**
 * Integration Test: creating a company seeds the default department folders
 * without blocking the event loop, and a hung push is cut by a watchdog.
 *
 * POST /api/companies used to run clone / checkout / add / commit / push with
 * execFileSync inside the request. The push runs the pre-receive checker, so
 * the whole server (every member's sync, login, admin, API) stood still for
 * as long as it took — and forever if the checker hung. These tests pin:
 *
 * (a) the seeded repository is byte-identical in content to before
 *     (`.gitattributes`, `<dept>/.gitkeep`, `<dept>/.personal/.gitignore`)
 *     and is on the shared branch before the response, so GET /departments
 *     lists the six defaults right away;
 * (b) no synchronous child process runs, and timers keep firing while a
 *     slow pre-receive hook holds the push;
 * (c) a hook that never finishes is killed (with its children) at the
 *     timeout;
 * (d) creating a company is all or nothing (code review 2026-11): when
 *     seeding or any row fails, the answer is 503 COMPANY_CREATION_FAILED and
 *     no company, membership, department or scope row and no repository is
 *     left. Before, the company was created anyway (without its folders,
 *     departments or scopes) and the creator was told it succeeded.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

// When set, repositories created by the server get this pre-receive hook
// instead of the real push checker (a slow or hung hook on demand).
const hookOverride = vi.hoisted(() => ({ script: null as string | null }))

vi.mock('../../src/lib/git-server/hook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/git-server/hook')>()
  const { chmodSync, mkdirSync, writeFileSync } = await import('fs')
  const { join } = await import('path')
  return {
    ...actual,
    installPreReceiveHook: (repoPath: string, options?: Parameters<typeof actual.installPreReceiveHook>[1]) => {
      if (hookOverride.script === null) return actual.installPreReceiveHook(repoPath, options)
      mkdirSync(join(repoPath, 'hooks'), { recursive: true })
      writeFileSync(join(repoPath, 'hooks', 'pre-receive'), `#!/bin/sh\n${hookOverride.script}\n`)
      chmodSync(join(repoPath, 'hooks', 'pre-receive'), 0o755)
      return true
    },
  }
})

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'cs-owner',
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

import { execFileSync } from 'child_process'
import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { setRepoGitTimeoutsForTests } from '../../src/adapters/git-repo-store'
import { departmentsRoute } from '../../src/routes/departments'

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

const REPOS_DIR = process.env.REPOS_DIR as string

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId/departments', departmentsRoute)

const DEFAULT_FOLDERS = ['営業部', '経理部', '人事部', 'コンテンツ', '開発部', '総務']

let scratch: string

/** The next companies' repositories get `script` as their pre-receive hook. */
function usePreReceiveHook(script: string) {
  hookOverride.script = script
}

function bareGit(companyId: string, args: string[]): string {
  return execFileSync('git', ['-C', join(REPOS_DIR, `${companyId}.git`), ...args], { encoding: 'utf8' })
}

async function createCompany(name: string) {
  const res = await app.request('/api/companies', {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: { 'Content-Type': 'application/json' },
  })
  return { status: res.status, body: await res.json() as { success: boolean; code?: string; error?: string; data: { id: string; role: string; name: string; repoPath: string | null } } }
}

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n

/** Rows and repositories that exist now, to compare before and after a failed creation. */
function footprint() {
  return {
    companies: count('SELECT COUNT(*) AS n FROM companies'),
    memberships: count("SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'cs-owner'"),
    departments: count('SELECT COUNT(*) AS n FROM departments'),
    scopes: count('SELECT COUNT(*) AS n FROM scopes'),
    repos: readdirSync(REPOS_DIR).filter(name => name.endsWith('.git')).sort(),
  }
}

/** A failed creation: 503 with the Japanese explanation, and nothing kept. */
function expectNothingKept(result: Awaited<ReturnType<typeof createCompany>>, before: ReturnType<typeof footprint>) {
  expect(result.status).toBe(503)
  expect(result.body.success).toBeUndefined()
  expect(result.body.code).toBe('COMPANY_CREATION_FAILED')
  expect(result.body.error).toMatch(/会社を作成できませんでした/)
  expect(footprint()).toEqual(before)
}

/** Runs `fn` while a 10 ms ticker measures the longest stall of the event loop. */
async function measureStall<T>(fn: () => Promise<T>): Promise<{ result: T; maxGapMs: number; ticks: number }> {
  let last = Date.now()
  let maxGapMs = 0
  let ticks = 0
  const ticker = setInterval(() => {
    const t = Date.now()
    maxGapMs = Math.max(maxGapMs, t - last)
    last = t
    ticks++
  }, 10)
  try {
    const result = await fn()
    return { result, maxGapMs, ticks }
  } finally {
    clearInterval(ticker)
  }
}

let savedTemplateDir: string | undefined

beforeAll(() => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'cs-owner' // creating companies is for server operators
  scratch = mkdtempSync(join(tmpdir(), 'acb-seed-'))
  // A developer's global init.templateDir (e.g. git-secrets) would install
  // client-side hooks into new repositories and slow every git call down
  savedTemplateDir = process.env.GIT_TEMPLATE_DIR
  process.env.GIT_TEMPLATE_DIR = mkdtempSync(join(scratch, 'templates-'))
})

afterEach(() => {
  hookOverride.script = null
})

afterAll(() => {
  delete process.env.OPERATOR_USER_IDS
  if (savedTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR
  else process.env.GIT_TEMPLATE_DIR = savedTemplateDir
  rmSync(scratch, { recursive: true, force: true })
})

describe('company creation seeds the department folders asynchronously', () => {
  it('pushes the same seed as before, ready before the response', async () => {
    syncCalls.count = 0
    syncCalls.log = []
    const { status, body } = await createCompany('Seed Co')
    expect(status).toBe(201)
    expect(body.success).toBe(true)
    expect(body.data.role).toBe('owner')
    expect(body.data.name).toBe('Seed Co')
    expect(body.data.repoPath).toBe(join(REPOS_DIR, `${body.data.id}.git`))
    expect(syncCalls.log).toEqual([])

    const id = body.data.id
    const files = bareGit(id, ['ls-tree', '-r', '--name-only', '-z', 'main']).split('\0').filter(Boolean).sort()
    expect(files).toEqual([
      '.gitattributes',
      ...DEFAULT_FOLDERS.flatMap(f => [`${f}/.gitkeep`, `${f}/.personal/.gitignore`]),
    ].sort())
    expect(bareGit(id, ['show', 'main:.gitattributes']))
      .toBe('# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n')
    expect(bareGit(id, ['show', 'main:営業部/.personal/.gitignore'])).toBe('# Personal workspace — not synced\n*\n!.gitignore\n')
    expect(bareGit(id, ['show', 'main:営業部/.gitkeep'])).toBe('')
    expect(bareGit(id, ['log', '-1', '--format=%an <%ae>|%s', 'main']).trim())
      .toBe('AI Company Builder <system@ai-company-builder.local>|Initialize default department folders')
    // The company repository carries the push checker
    expect(existsSync(join(REPOS_DIR, `${id}.git`, 'hooks', 'pre-receive'))).toBe(true)
    expect(bareGit(id, ['config', 'receive.denyNonFastForwards']).trim()).toBe('true')

    const list = await app.request(`/api/companies/${id}/departments`)
    expect(list.status).toBe(200)
    const depts = (await list.json() as { data: Array<{ folder: string }> }).data
    expect(depts.map(d => d.folder)).toEqual(DEFAULT_FOLDERS)
  })

  it('keeps the event loop running while a slow pre-receive hook holds the push', async () => {
    usePreReceiveHook('sleep 2')
    syncCalls.count = 0
    syncCalls.log = []
    const started = Date.now()
    const { result, maxGapMs, ticks } = await measureStall(() => createCompany('Slow Hook Co'))
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000)
    expect(result.status).toBe(201)
    expect(syncCalls.log).toEqual([])
    // The hook alone held git for 2 s; timers kept firing throughout
    expect(ticks).toBeGreaterThan(50)
    expect(maxGapMs).toBeLessThan(1000)
    expect(bareGit(result.body.data.id, ['ls-tree', '--name-only', '-z', 'main']).split('\0')).toContain('総務')
  })

  it('kills a hung push at the timeout and keeps nothing of the company', async () => {
    const pidFile = join(scratch, 'hook.pid')
    usePreReceiveHook(`echo $$ > '${pidFile}'\nsleep 600`)
    const restore = setRepoGitTimeoutsForTests({ local: 60_000, push: 15_000 })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = footprint()
    try {
      const started = Date.now()
      const { result, maxGapMs } = await measureStall(() => createCompany('Hung Hook Co'))
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(15_000)
      expect(elapsed).toBeLessThan(60_000)
      expect(maxGapMs).toBeLessThan(1000)
      expectNothingKept(result, before)

      const failure = errors.mock.calls.map(call => String(call[0])).find(line => line.startsWith('[companies] failed to create the company; nothing was kept:'))
      expect(failure).toBeDefined()
      expect(failure).toContain('GitTimeoutError')

      // The hook (a grandchild of git push) was killed with it
      const hookPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(hookPid).toBeGreaterThan(0)
      await new Promise(r => setTimeout(r, 200))
      expect(() => process.kill(hookPid, 0)).toThrow()
    } finally {
      errors.mockRestore()
      restore()
    }
  })

  it('a rejected seed push keeps no company row and no repository', async () => {
    usePreReceiveHook('exit 1')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = footprint()
    try {
      expectNothingKept(await createCompany('Rejected Seed Co'), before)
    } finally {
      errors.mockRestore()
    }
  })

  it('a repository that cannot be created keeps no company row', async () => {
    // REPOS_DIR is a file for a moment: mkdir / git init fail
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reposBackup = `${REPOS_DIR}.held`
    const before = footprint()
    renameSync(REPOS_DIR, reposBackup)
    writeFileSync(REPOS_DIR, '')
    try {
      const result = await createCompany('No Repo Co')
      rmSync(REPOS_DIR)
      renameSync(reposBackup, REPOS_DIR)
      expectNothingKept(result, before)
    } finally {
      if (existsSync(reposBackup)) {
        rmSync(REPOS_DIR, { force: true })
        renameSync(reposBackup, REPOS_DIR)
      }
      errors.mockRestore()
    }
  })

  it('a row that cannot be written rolls back the company, its membership and departments, and removes the repository', async () => {
    // The last step of the transaction (the permission scopes) fails
    db.exec("CREATE TEMP TRIGGER fail_scope_insert BEFORE INSERT ON scopes BEGIN SELECT RAISE(ABORT, 'scope insert refused for the test'); END")
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = footprint()
    try {
      expectNothingKept(await createCompany('Rolled Back Co'), before)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_scope_insert')
      errors.mockRestore()
    }
    // Creating works again once the rows can be written
    const again = await createCompany('After Rollback Co')
    expect(again.status).toBe(201)
    expect(count('SELECT COUNT(*) AS n FROM departments WHERE company_id = ?', again.body.data.id)).toBe(6)
    expect(existsSync(join(REPOS_DIR, `${again.body.data.id}.git`))).toBe(true)
  })
})
