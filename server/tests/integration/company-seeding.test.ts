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
 *     timeout; the company is still created (201), as when seeding failed
 *     before, and nothing reached the shared branch.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
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
import { initDatabase } from '../../src/db'
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
  return { status: res.status, body: await res.json() as { success: boolean; data: { id: string; role: string; name: string; repoPath: string | null } } }
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

  it('kills a hung push at the timeout and still creates the company, as when seeding failed before', async () => {
    const pidFile = join(scratch, 'hook.pid')
    usePreReceiveHook(`echo $$ > '${pidFile}'\nsleep 600`)
    const restore = setRepoGitTimeoutsForTests({ local: 60_000, push: 15_000 })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const started = Date.now()
      const { result, maxGapMs } = await measureStall(() => createCompany('Hung Hook Co'))
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(15_000)
      expect(elapsed).toBeLessThan(60_000)
      expect(maxGapMs).toBeLessThan(1000)
      expect(result.status).toBe(201)
      expect(result.body.data.role).toBe('owner')

      const failure = errors.mock.calls.find(call => call[0] === 'Failed to seed department folders:')
      expect(failure).toBeDefined()
      expect(String(failure![1])).toMatch(/timed out/)

      // Nothing reached the shared branch
      expect(() => bareGit(result.body.data.id, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])).toThrow()

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
})
