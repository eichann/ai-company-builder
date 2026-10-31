/**
 * Integration Test: write permission is enforced on push.
 *
 * Every push through git-http carries a permission snapshot (the pusher and
 * the company's scopes with their rules) to the pre-receive hook, and the
 * push checker evaluates resolveAccess(pusher, path).write for every path the
 * push changes — adds, edits, deletes and both sides of a rename, in every
 * new commit and in the net diff. Denied paths reject the push with a
 * [WRITE_DENIED] section, which the server records in push_rejections.
 *
 * Real HTTP (git-http route served on a loopback port), real hook, real git.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const companyId = 'writeperm'
const USERS = ['owner', 'admin', 'member', 'manager', 'other'] as const
type User = typeof USERS[number]
const ROLE: Record<User, string> = { owner: 'owner', admin: 'admin', member: 'member', manager: 'member', other: 'member' }

let workDir: string
let bare: string
let baseUrl: string
let server: { close: () => void }
let db: import('better-sqlite3').Database
let salesScopeId: string

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string, message: string) {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

const remoteHead = () => git(['-C', bare, 'rev-parse', 'main']).trim()

/** Push HEAD to main over HTTP as `user` (async: the server runs in this process). */
function httpPush(clone: string, user: User): Promise<{ ok: boolean; output: string }> {
  const url = baseUrl.replace('http://', `http://git:tok-${user}@`)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', ['push', url, 'HEAD:main'], { cwd: clone, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/** Paths of the [WRITE_DENIED] section (the client's parsing: "- " lines up to the second separator). */
function deniedPathsIn(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s?/, '').trim())
  const start = lines.findIndex(l => l.startsWith('[WRITE_DENIED]'))
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

let cloneCount = 0
/** A fresh clone of the current server state. */
function freshClone(): string {
  const clone = join(workDir, `clone${++cloneCount}`)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  return clone
}

function addRule(scopeId: string, subjectType: 'everyone' | 'role' | 'user', subjectId: string | null, canRead: boolean, canWrite: boolean): string {
  const id = `rule-${Math.random().toString(36).slice(2)}`
  db.prepare(`INSERT INTO scope_rules (company_id, id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('writeperm', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, scopeId, subjectType, subjectId, canRead ? 1 : 0, canWrite ? 1 : 0, new Date().toISOString())
  return id
}
const removeRule = (id: string) => db.prepare('DELETE FROM scope_rules WHERE id = ?').run(id)

/** Owner seeds the given files. */
async function seed(files: Record<string, string>) {
  const clone = freshClone()
  for (const [rel, content] of Object.entries(files)) writeFile(clone, rel, content)
  commitAll(clone, 'seed')
  const r = await httpPush(clone, 'owner')
  if (!r.ok) throw new Error(`seed failed: ${r.output}`)
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-write-perm-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  db = dbModule.db
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(companyId, 'Write', 'write-perm', 'u-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  for (const u of USERS) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(`u-${u}`, `${u}@example.com`, u)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${u}`, `u-${u}`, `tok-${u}`, expires)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${u}`, `u-${u}`, companyId, ROLE[u], now, now)
  }
  authDb.close()

  // The default: company scope with everyone: read + write; a department "sales".
  const { ensureCompanyScope, ensureDepartmentScope } = await import('../../src/adapters/sqlite/permission-store')
  ensureCompanyScope(db, companyId)
  db.prepare(`INSERT INTO departments (id, company_id, name, folder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('d-sales', companyId, '営業', 'sales', now, now)
  ensureDepartmentScope(db, companyId, 'd-sales', 'sales')
  salesScopeId = (db.prepare(`SELECT id FROM scopes WHERE company_id = ? AND path = 'sales'`).get(companyId) as { id: string }).id
  db.prepare(`INSERT INTO department_managers (company_id, department_id, user_id, created_at) VALUES ('writeperm', ?, ?, ?)`).run('d-sales', 'u-manager', now)

  bare = join(process.env.REPOS_DIR!, `${companyId}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const app = new Hono()
  app.route('/api/git-http', gitHttpRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      baseUrl = `http://127.0.0.1:${info.port}/api/git-http/${companyId}.git`
      resolve()
    })
  })

  await seed({ 'README.md': 'hi\n', 'sales/a.md': 'a\n', 'sales/keep.md': 'k\n', 'other/x.md': 'x\n' })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('write permission on push (git-http → hook → push checker)', () => {
  it('default rules (everyone: read + write): a member writes anywhere', async () => {
    const clone = freshClone()
    writeFile(clone, 'sales/new.md', 'n\n')
    commitAll(clone, 'member writes sales')
    const r = await httpPush(clone, 'member')
    expect(r.output).not.toContain('WRITE_DENIED')
    expect(r.ok).toBe(true)
  })

  describe('with sales read-only for everyone (manager has a user rule)', () => {
    let readOnly: string
    let managerRule: string
    beforeAll(() => {
      readOnly = addRule(salesScopeId, 'everyone', null, true, false)
      managerRule = addRule(salesScopeId, 'user', 'u-manager', true, true)
    })
    afterAll(() => {
      removeRule(readOnly)
      removeRule(managerRule)
    })

    it('rejects a member adding and editing files in the folder, lists the paths, leaves the server untouched, records it', async () => {
      const clone = freshClone()
      writeFile(clone, 'sales/b.md', 'b\n')
      writeFile(clone, 'sales/a.md', 'a2\n')
      writeFile(clone, 'other/y.md', 'y\n')
      commitAll(clone, 'member writes sales')
      const before = remoteHead()
      const r = await httpPush(clone, 'member')
      expect(r.ok).toBe(false)
      expect(deniedPathsIn(r.output)).toEqual(['sales/a.md', 'sales/b.md'])
      expect(r.output).toContain('変更する権限のないファイル')
      expect(remoteHead()).toBe(before)

      // Recorded for the admin overview (lib/push-rejections.ts, deferred write).
      await new Promise(res => setTimeout(res, 200))
      const row = db.prepare(`SELECT marker, paths, user_id FROM push_rejections WHERE company_id = ? AND marker = 'WRITE_DENIED' ORDER BY created_at DESC LIMIT 1`)
        .get(companyId) as { marker: string; paths: string; user_id: string } | undefined
      expect(row).toBeDefined()
      expect(row!.user_id).toBe('u-member')
      expect(JSON.parse(row!.paths)).toEqual(['sales/a.md', 'sales/b.md'])
    })

    it('accepts the same push from the owner and from an admin', async () => {
      for (const who of ['owner', 'admin'] as const) {
        const clone = freshClone()
        writeFile(clone, `sales/by-${who}.md`, 'o\n')
        commitAll(clone, `${who} writes sales`)
        const r = await httpPush(clone, who)
        expect(r.output).not.toContain('WRITE_DENIED')
        expect(r.ok).toBe(true)
      }
    })

    it('a department manager writes because resolveAccess grants it (the user rule), not because of being manager', async () => {
      const clone = freshClone()
      writeFile(clone, 'sales/by-manager.md', 'm\n')
      commitAll(clone, 'manager writes sales')
      const r = await httpPush(clone, 'manager')
      expect(r.ok).toBe(true)

      removeRule(managerRule)
      try {
        const c2 = freshClone()
        writeFile(c2, 'sales/by-manager-2.md', 'm\n')
        commitAll(c2, 'manager without a rule')
        const denied = await httpPush(c2, 'manager')
        expect(denied.ok).toBe(false)
        expect(deniedPathsIn(denied.output)).toEqual(['sales/by-manager-2.md'])
      } finally {
        managerRule = addRule(salesScopeId, 'user', 'u-manager', true, true)
      }
    })

    it('rejects deletes, renames out of the folder and renames into it (both sides of a rename count)', async () => {
      const del = freshClone()
      unlinkSync(join(del, 'sales/keep.md'))
      commitAll(del, 'delete')
      const r1 = await httpPush(del, 'member')
      expect(r1.ok).toBe(false)
      expect(deniedPathsIn(r1.output)).toEqual(['sales/keep.md'])

      const out = freshClone()
      renameSync(join(out, 'sales/keep.md'), join(out, 'other/keep.md'))
      commitAll(out, 'rename out')
      const r2 = await httpPush(out, 'member')
      expect(r2.ok).toBe(false)
      expect(deniedPathsIn(r2.output)).toEqual(['sales/keep.md'])

      const into = freshClone()
      renameSync(join(into, 'other/x.md'), join(into, 'sales/x.md'))
      commitAll(into, 'rename in')
      const r3 = await httpPush(into, 'member')
      expect(r3.ok).toBe(false)
      expect(deniedPathsIn(r3.output)).toEqual(['sales/x.md'])
    })

    it('checks every new commit, not only the net diff (added then removed again)', async () => {
      const clone = freshClone()
      writeFile(clone, 'sales/tmp.md', 't\n')
      commitAll(clone, 'add')
      unlinkSync(join(clone, 'sales/tmp.md'))
      writeFile(clone, 'other/z.md', 'z\n')
      commitAll(clone, 'remove again')
      const r = await httpPush(clone, 'member')
      expect(r.ok).toBe(false)
      expect(deniedPathsIn(r.output)).toEqual(['sales/tmp.md'])
    })

    it('treats a different A–Z case of the folder as the folder (macOS/Windows check it out there)', async () => {
      const clone = freshClone()
      // Straight into the index: on a case-insensitive file system the file
      // would land in the existing sales/ folder.
      const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, input: 'u\n' }).toString().trim()
      git(['update-index', '--add', '--cacheinfo', `100644,${sha},Sales/upper.md`], clone)
      git(['commit', '-q', '--no-verify', '-m', 'case'], clone)
      const r = await httpPush(clone, 'member')
      expect(r.ok).toBe(false)
      expect(deniedPathsIn(r.output)).toEqual(['Sales/upper.md'])
    })

    it('accepts a member push outside the restricted folder, and reports WRITE_DENIED next to other sections', async () => {
      const ok = freshClone()
      writeFile(ok, 'other/fine.md', 'f\n')
      commitAll(ok, 'outside')
      expect((await httpPush(ok, 'member')).ok).toBe(true)

      const both = freshClone()
      writeFile(both, 'sales/c.md', 'c\n')
      writeFile(both, '.mcp.json', '{}\n')
      commitAll(both, 'two problems')
      const r = await httpPush(both, 'member')
      expect(r.ok).toBe(false)
      expect(r.output).toContain('[PROTECTED_CONFIG]')
      expect(deniedPathsIn(r.output)).toEqual(['sales/c.md'])
    })

    it('a role rule narrows a whole folder for members (folder scope deeper than the company)', async () => {
      const other = db.prepare(`INSERT INTO scopes (id, company_id, path, kind, created_at) VALUES (?, ?, ?, 'folder', ?)`)
      other.run('scope-other', companyId, 'other/locked', new Date().toISOString())
      const rule = addRule('scope-other', 'role', 'member', true, false)
      try {
        const clone = freshClone()
        writeFile(clone, 'other/locked/x.md', 'x\n')
        writeFile(clone, 'other/open.md', 'o\n')
        commitAll(clone, 'locked')
        const r = await httpPush(clone, 'other')
        expect(r.ok).toBe(false)
        expect(deniedPathsIn(r.output)).toEqual(['other/locked/x.md'])
      } finally {
        removeRule(rule)
        db.prepare(`DELETE FROM scopes WHERE id = 'scope-other'`).run()
      }
    })
  })
})

describe('which pushes are write-checked (local transport, as the server and tests push)', () => {
  function localPush(clone: string, env: Record<string, string>): { ok: boolean; output: string } {
    const full = { ...process.env }
    for (const k of Object.keys(full)) if (k.startsWith('ACB_')) delete full[k]
    const r = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: clone, env: { ...full, ...env }, encoding: 'utf-8' })
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
  }

  function snapshot(policy: unknown): string {
    const file = join(workDir, `policy-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(policy))
    return file
  }

  const restricted = {
    version: 1,
    companyId,
    scopes: [
      { id: 's0', path: '', kind: 'company', departmentId: null, repoId: null, rules: [{ id: 'r0', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }] },
      { id: 's1', path: 'sales', kind: 'department', departmentId: null, repoId: null, rules: [{ id: 'r1', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }] },
    ],
  }

  it('a snapshot is always enforced — ACB_INTERNAL_PUSH does not switch it off', () => {
    const clone = freshClone()
    writeFile(clone, 'sales/local.md', 'l\n')
    commitAll(clone, 'local')
    const policy = snapshot({ ...restricted, pusher: { id: 'u-member', role: 'member' } })
    const r = localPush(clone, { ACB_PUSHER_ROLE: 'member', ACB_PUSH_POLICY: policy, ACB_INTERNAL_PUSH: '1' })
    expect(r.ok).toBe(false)
    expect(deniedPathsIn(r.output)).toEqual(['sales/local.md'])
  })

  it('no resolvable pusher: every changed path is denied while some rule restricts writing; allowed when writing is open', () => {
    const clone = freshClone()
    writeFile(clone, 'other/anon.md', 'a\n')
    commitAll(clone, 'anon')
    const r = localPush(clone, { ACB_PUSH_POLICY: snapshot({ ...restricted, pusher: null }) })
    expect(r.ok).toBe(false)
    expect(deniedPathsIn(r.output)).toEqual(['other/anon.md'])
    const open = localPush(clone, { ACB_PUSH_POLICY: snapshot({ ...restricted, scopes: restricted.scopes.slice(0, 1), pusher: null }) })
    expect(open.ok).toBe(true)
  })

  it('an unreadable or invalid snapshot rejects the push with [HOOK_ERROR] (never accepted unchecked)', () => {
    const clone = freshClone()
    writeFile(clone, 'other/bad.md', 'b\n')
    commitAll(clone, 'bad')
    for (const policy of ['', join(workDir, 'missing.json'), snapshot({ version: 99 })]) {
      const r = localPush(clone, { ACB_PUSHER_ROLE: 'owner', ACB_PUSH_POLICY: policy })
      expect(r.ok).toBe(false)
      expect(r.output).toContain('[HOOK_ERROR]')
    }
  })

  it('the server\'s own pushes (ACB_INTERNAL_PUSH, no snapshot) are not write-checked; content rules still apply', () => {
    const clone = freshClone()
    writeFile(clone, 'sales/internal.md', 'i\n')
    commitAll(clone, 'internal')
    expect(localPush(clone, { ACB_INTERNAL_PUSH: '1' }).ok).toBe(true)
    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'internal protected')
    const r = localPush(clone, { ACB_INTERNAL_PUSH: '1' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
  })

  it('rejects with [HOOK_ERROR] when the checker cannot run at all', () => {
    const clone = freshClone()
    writeFile(clone, 'other/nochecker.md', 'n\n')
    commitAll(clone, 'no checker')
    // A hook whose checker entry does not exist: the thin caller must refuse.
    const hookPath = join(bare, 'hooks', 'pre-receive')
    const original = execFileSync('cat', [hookPath]).toString()
    writeFileSync(hookPath, original.replace(/entry\.ts'/, "entry-missing.ts'"))
    try {
      const r = localPush(clone, { ACB_PUSHER_ROLE: 'owner' })
      expect(r.ok).toBe(false)
      expect(r.output).toContain('[HOOK_ERROR]')
    } finally {
      writeFileSync(hookPath, original)
    }
  })
})
