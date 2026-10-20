/**
 * Integration Test: the pre-receive hook never lets `.personal/` content be
 * shared — for any pusher, owner/admin included.
 *
 * Department `.personal/` folders are protected only by the `.gitignore`
 * (`*` / `!.gitignore`) the server writes into them. A `.personal/` created
 * anywhere else used to sync like a normal folder, so the hook enforces the
 * rule server-side: adding or modifying a file inside a directory named
 * `.personal` (any depth) is rejected with `[PERSONAL_PATH]`, except the
 * `.gitignore` directly inside it. Deletions are always allowed — that is how
 * already-shared files get unshared.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

// The department route authenticates through lib/auth: act as the owner.
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue({
    id: 'u-personal-owner',
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

import { configureBareRepo } from '../../src/routes/git'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// The server's own commits (department creation) rely on a git identity;
// CI runners have none configured.
process.env.GIT_AUTHOR_NAME = 'test'
process.env.GIT_AUTHOR_EMAIL = 'test@example.com'
process.env.GIT_COMMITTER_NAME = 'test'
process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

type Role = 'owner' | 'admin' | 'member' | undefined

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string, message: string) {
  // -f: these fixtures deliberately commit paths a .gitignore may exclude.
  git(['add', '-A', '-f', '.'], clone)
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

function pushAs(clone: string, role: Role): { ok: boolean; output: string } {
  const env = { ...process.env }
  delete env.ACB_PUSHER_ROLE
  if (role) env.ACB_PUSHER_ROLE = role
  const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

function sectionPaths(output: string, marker: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s*/, '').trim())
  const start = lines.findIndex(l => l.includes(`[${marker}]`))
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

let workDir: string
let counter = 0

function setup(seed: Record<string, string>): { bare: string; clone: string } {
  const id = `p${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  for (const [rel, content] of Object.entries(seed)) writeFile(clone, rel, content)
  commitAll(clone, 'seed')
  const r = pushAs(clone, 'owner')
  if (!r.ok) throw new Error(`seed push failed: ${r.output}`)
  return { bare, clone }
}

const remoteHead = (bare: string) => git(['-C', bare, 'rev-parse', 'main']).trim()

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-personal-hook-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('pre-receive hook: .personal/ is never shared', () => {
  for (const role of ['member', 'admin', 'owner', undefined] as const) {
    it(`rejects a root-level .personal/ file from ${role ?? 'a pusher without role'}`, () => {
      const { bare, clone } = setup({ 'README.md': 'hi\n' })
      const before = remoteHead(bare)
      writeFile(clone, '.personal/memo.md', 'private\n')
      commitAll(clone, 'personal')
      const r = pushAs(clone, role)
      expect(r.ok).toBe(false)
      expect(sectionPaths(r.output, 'PERSONAL_PATH')).toEqual(['.personal/memo.md'])
      expect(r.output).not.toContain('[PROTECTED_CONFIG]')
      expect(remoteHead(bare)).toBe(before)
    })
  }

  it('rejects .personal/ content in a department and at deeper levels, case-insensitively', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '営業部/.personal/下書き.md', 'x\n')
    writeFile(clone, 'a/b/.personal/c/d.txt', 'x\n')
    writeFile(clone, 'x/.Personal/y.txt', 'x\n')
    commitAll(clone, 'nested')
    const r = pushAs(clone, 'owner')
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'PERSONAL_PATH').sort())
      .toEqual(['a/b/.personal/c/d.txt', 'x/.Personal/y.txt', '営業部/.personal/下書き.md'].sort())
  })

  it('allows the .gitignore directly inside .personal/ (what the server writes)', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '新部署/.personal/.gitignore', '*\n!.gitignore\n')
    writeFile(clone, '.personal/.gitignore', '*\n!.gitignore\n')
    commitAll(clone, 'gitignores')
    const r = pushAs(clone, 'member')
    expect(r.output).not.toContain('PERSONAL_PATH')
    expect(r.ok).toBe(true)
  })

  it('does not exempt a .gitignore deeper inside .personal/', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.personal/sub/.gitignore', '*\n')
    commitAll(clone, 'nested gitignore')
    const r = pushAs(clone, 'owner')
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'PERSONAL_PATH')).toEqual(['.personal/sub/.gitignore'])
  })

  it('allows deleting already-shared .personal/ files (that is how they get unshared)', () => {
    // Seeded the way legacy data looks: pushed before this rule existed.
    const id = `legacy${++counter}`
    const bare = join(workDir, `${id}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    const clone = join(workDir, id)
    git(['clone', '-q', bare, clone])
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    git(['checkout', '-q', '-B', 'main'], clone)
    writeFile(clone, '.personal/a.md', 'a\n')
    writeFile(clone, '.personal/b.md', 'b\n')
    commitAll(clone, 'legacy')
    git(['push', '-q', 'origin', 'main'], clone)
    configureBareRepo(bare) // hook installed afterwards, as on server startup

    // Modifying a shared one is still sharing → rejected.
    writeFile(clone, '.personal/b.md', 'b2\n')
    commitAll(clone, 'modify')
    const rejected = pushAs(clone, 'member')
    expect(rejected.ok).toBe(false)
    expect(sectionPaths(rejected.output, 'PERSONAL_PATH')).toEqual(['.personal/b.md'])

    // Moving a shared one out of .personal/ is allowed: the source side is a
    // deletion, the target is an ordinary shared path.
    git(['reset', '-q', '--hard', 'origin/main'], clone)
    mkdirSync(join(clone, 'notes'), { recursive: true })
    git(['mv', '.personal/a.md', 'notes/a.md'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'move out'], clone)
    const moved = pushAs(clone, 'member')
    expect(moved.output).not.toContain('PERSONAL_PATH')
    expect(moved.ok).toBe(true)

    git(['rm', '-q', '--cached', '.personal/b.md'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'unshare'], clone)
    const r = pushAs(clone, 'member')
    expect(r.output).not.toContain('PERSONAL_PATH')
    expect(r.ok).toBe(true)
  })

  it('rejects a rename into .personal/', () => {
    const { clone } = setup({ 'README.md': 'hi\n', 'notes/todo.md': 'todo\n' })
    mkdirSync(join(clone, '.personal'), { recursive: true })
    git(['mv', 'notes/todo.md', '.personal/todo.md'], clone)
    commitAll(clone, 'move in')
    const r = pushAs(clone, 'owner')
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'PERSONAL_PATH')).toEqual(['.personal/todo.md'])
  })

  it('reports PERSONAL_PATH and PROTECTED_CONFIG as separate sections', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.personal/memo.md', 'x\n')
    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'both')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(sectionPaths(r.output, 'PERSONAL_PATH')).toEqual(['.personal/memo.md'])
    expect(sectionPaths(r.output, 'PROTECTED_CONFIG')).toEqual(['.mcp.json'])
  })

  it('leaves pushes without .personal/ content unchanged', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, 'personal/notes.md', 'not the hidden folder\n')
    writeFile(clone, 'a.personal/x.md', 'x\n')
    commitAll(clone, 'similar names')
    const r = pushAs(clone, 'member')
    expect(r.output).not.toContain('PERSONAL_PATH')
    expect(r.ok).toBe(true)
  })
})

describe('department creation still reaches the bare repo', () => {
  it("the server's own push of <dept>/.personal/.gitignore passes the hook", async () => {
    const { db, initDatabase } = await import('../../src/db')
    const { Hono } = await import('hono')
    const { departmentsRoute } = await import('../../src/routes/departments')
    initDatabase()
    const companyId = 'personaldept'
    const now = new Date().toISOString()
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(companyId, 'Personal Dept', 'personal-dept', 'u-personal-owner', now, now)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('m-personal-owner', 'u-personal-owner', companyId, 'owner', now, now)

    // Bare repo with the real hook and a main branch, as after company creation.
    const bare = join(process.env.REPOS_DIR!, `${companyId}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)
    const seed = join(workDir, 'dept-seed')
    git(['clone', '-q', bare, seed])
    git(['checkout', '-q', '-B', 'main'], seed)
    writeFile(seed, 'README.md', 'hi\n')
    commitAll(seed, 'seed')
    expect(pushAs(seed, 'owner').ok).toBe(true)

    const app = new Hono()
    app.route('/api/companies/:companyId/departments', departmentsRoute)
    const res = await app.request(`/api/companies/${companyId}/departments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新しい部署', folder: '新しい部署' }),
    })
    expect(res.status).toBeLessThan(300)
    // The route's commitAndPush pushes over the local transport with no
    // ACB_PUSHER_ROLE; the .personal/.gitignore exception must let it through.
    expect(git(['-C', bare, 'show', 'main:新しい部署/.personal/.gitignore'])).toContain('!.gitignore')
    expect(git(['-C', bare, 'ls-tree', '--name-only', 'main', '新しい部署/'])).toContain('.gitkeep')
  })
})
