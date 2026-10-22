/**
 * Integration Test: the pre-receive hook protects agent-execution config.
 *
 * The desktop chat runs Claude Code inside the company's shared checkout,
 * where it loads `.claude/settings.json` (hooks, statusLine, apiKeyHelper,
 * env ...), `.mcp.json` (stdio MCP servers) and scripts under `.claude/hooks/`
 * and executes the commands in them without asking. Anything pushed there
 * runs on every member's machine at their next chat message, so only a
 * company owner/admin may change those paths. git-http.ts passes the pusher's
 * role as ACB_PUSHER_ROLE; without it the hook must fail closed for protected
 * paths only.
 *
 * These tests push to a real bare repository configured by configureBareRepo
 * (real hook), over the local transport with ACB_PUSHER_ROLE set the way
 * git-http.ts sets it. The HTTP path itself is covered at the bottom.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

// git.ts transitively imports lib/auth, which requires AUTH_SECRET at import
// time — mock it like the other integration tests do (auth is unused here;
// git-http.ts reads sessions straight from auth.sqlite).
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

// Each test drives several real git processes (and the hook) end to end.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

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
  git(['add', '-A'], clone)
  // --no-verify: fixtures (e.g. the fake AWS key) must not trip any
  // client-side commit hook installed on the developer's machine.
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

/** Push `main` as the given role; returns exit status + combined output. */
function pushAs(clone: string, role: Role, refspec = 'main'): { ok: boolean; output: string } {
  const env = { ...process.env }
  delete env.ACB_PUSHER_ROLE
  if (role) env.ACB_PUSHER_ROLE = role
  const r = spawnSync('git', ['push', 'origin', refspec], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

/** Paths listed in the PROTECTED_CONFIG section of a rejected push. */
function protectedPathsIn(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s*/, '').trim())
  const start = lines.findIndex(l => l.includes('[PROTECTED_CONFIG]'))
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

/** Fresh bare repo + clone. With `seed`, an admin-pushed initial commit. */
function setup(seed?: Record<string, string>): { bare: string; clone: string } {
  const id = `r${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  if (seed) {
    for (const [rel, content] of Object.entries(seed)) writeFile(clone, rel, content)
    commitAll(clone, 'seed')
    const r = pushAs(clone, 'owner')
    if (!r.ok) throw new Error(`seed push failed: ${r.output}`)
  }
  return { bare, clone }
}

const remoteHead = (bare: string) => git(['-C', bare, 'rev-parse', 'main']).trim()

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-protected-hook-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('pre-receive hook: protected agent config', () => {
  it('rejects a member adding .claude/settings.json and leaves the remote untouched', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n' })
    const before = remoteHead(bare)
    writeFile(clone, '.claude/settings.json', '{"hooks":{}}\n')
    commitAll(clone, 'add settings')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
    expect(protectedPathsIn(r.output)).toEqual(['.claude/settings.json'])
    expect(remoteHead(bare)).toBe(before)
  })

  it('accepts the same change from an admin', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.claude/settings.json', '{"hooks":{}}\n')
    commitAll(clone, 'add settings')
    expect(pushAs(clone, 'admin').ok).toBe(true)
    expect(remoteHead(bare)).toBe(git(['rev-parse', 'HEAD'], clone).trim())
  })

  it('accepts the same change from an owner', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.mcp.json', '{"mcpServers":{}}\n')
    commitAll(clone, 'add mcp')
    expect(pushAs(clone, 'owner').ok).toBe(true)
    expect(remoteHead(bare)).toBe(git(['rev-parse', 'HEAD'], clone).trim())
  })

  // Skills are not path-protected; only their auto-run parts are
  // (skill-autorun-hook.test.ts).
  it('accepts member pushes that do not touch protected paths — skills included', () => {
    const { clone } = setup({
      'README.md': 'hi\n',
      '.mcp.json': '{"mcpServers":{"playwright":{}}}\n',
      '.claude/settings.json': '{}\n',
    })
    writeFile(clone, 'sales/proposal.md', 'draft\n')
    writeFile(clone, '.claude/skills/report/SKILL.md', '---\nname: report\n---\n')
    writeFile(clone, '.claude/notes.md', 'notes\n')
    writeFile(clone, 'docs/settings.json', '{}\n')
    commitAll(clone, 'normal work')
    const r = pushAs(clone, 'member')
    expect(r.output).not.toContain('PROTECTED_CONFIG')
    expect(r.ok).toBe(true)
  })

  // Intended change (2026-10-22): AI instruction files are protected too.
  // Without a git-http snapshot nobody is a department manager, so only
  // owner/admin pass here (manager cases: private-folders.test.ts).
  it('AI instruction files (CLAUDE.md, CLAUDE.local.md, AGENTS.md, any depth/case): owner/admin only', () => {
    const files = { '.claude/CLAUDE.md': 'n\n', 'sales/claude.md': 's\n', 'CLAUDE.local.md': 'l\n', 'x/y/AGENTS.md': 'a\n' }
    const m = setup({ 'README.md': 'hi\n' })
    for (const [p, c] of Object.entries(files)) writeFile(m.clone, p, c)
    commitAll(m.clone, 'instructions')
    const rejected = pushAs(m.clone, 'member')
    expect(rejected.ok).toBe(false)
    expect(protectedPathsIn(rejected.output)).toEqual(['.claude/CLAUDE.md', 'CLAUDE.local.md', 'sales/claude.md', 'x/y/AGENTS.md'])
    expect(pushAs(m.clone, 'owner').ok).toBe(true)
  })

  it('initial push (zero old SHA): member with protected file rejected, without accepted', () => {
    const a = setup()
    writeFile(a.clone, 'README.md', 'hi\n')
    writeFile(a.clone, '.mcp.json', '{}\n')
    commitAll(a.clone, 'first')
    const rejected = pushAs(a.clone, 'member')
    expect(rejected.ok).toBe(false)
    expect(protectedPathsIn(rejected.output)).toEqual(['.mcp.json'])
    expect(() => git(['-C', a.bare, 'rev-parse', '--verify', 'main'])).toThrow()

    const b = setup()
    writeFile(b.clone, 'README.md', 'hi\n')
    commitAll(b.clone, 'first')
    expect(pushAs(b.clone, 'member').ok).toBe(true)
  })

  it('new branch (zero old SHA) from main: existing protected files do not count, new changes do', () => {
    const { clone } = setup({ 'README.md': 'hi\n', '.mcp.json': '{}\n' })
    git(['checkout', '-q', '-b', 'feature'], clone)
    writeFile(clone, 'notes.md', 'n\n')
    commitAll(clone, 'feature work')
    expect(pushAs(clone, 'member', 'feature').ok).toBe(true)

    git(['checkout', '-q', '-b', 'feature2'], clone)
    writeFile(clone, '.claude/hooks/run.sh', 'echo hi\n')
    commitAll(clone, 'sneak hook')
    const r = pushAs(clone, 'member', 'feature2')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.claude/hooks/run.sh'])
  })

  it('catches .mcp.json and .claude/settings.local.json nested in a department folder', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '営業部/.mcp.json', '{}\n')
    writeFile(clone, 'sales/team/.claude/settings.local.json', '{}\n')
    commitAll(clone, 'nested')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output).sort()).toEqual(['sales/team/.claude/settings.local.json', '営業部/.mcp.json'].sort())
  })

  it('catches a rename onto a protected path', () => {
    const { clone } = setup({ 'README.md': 'hi\n', 'tools/servers.json': '{"mcpServers":{}}\n' })
    git(['mv', 'tools/servers.json', '.mcp.json'], clone)
    commitAll(clone, 'rename')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
  })

  it('catches a member deleting a protected file', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n', '.mcp.json': '{}\n' })
    const before = remoteHead(bare)
    git(['rm', '-q', '.mcp.json'], clone)
    commitAll(clone, 'delete mcp')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
    expect(remoteHead(bare)).toBe(before)
  })

  it('catches a change in an earlier commit even when a later commit reverts it', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.claude/hooks/x.sh', 'echo x\n')
    commitAll(clone, 'add')
    git(['rm', '-q', '.claude/hooks/x.sh'], clone)
    commitAll(clone, 'remove')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.claude/hooks/x.sh'])
  })

  it('matches case-insensitively (macOS/Windows read .Claude/Settings.json too)', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.Claude/Settings.JSON', '{}\n')
    commitAll(clone, 'case')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.Claude/Settings.JSON'])
  })

  it('catches a symlink named .claude pointing at an unprotected folder', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, 'shared/settings.json', '{"hooks":{}}\n')
    symlinkSync('shared', join(clone, '.claude'))
    commitAll(clone, 'symlink')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.claude'])
    unlinkSync(join(clone, '.claude'))
  })

  it('fails closed when no role is provided — for protected paths only', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, 'notes.md', 'n\n')
    commitAll(clone, 'unrelated')
    expect(pushAs(clone, undefined).ok).toBe(true)

    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'protected')
    const r = pushAs(clone, undefined)
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
  })

  it('treats an unknown role as a member', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'protected')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(pushAs(clone, 'superuser' as any).ok).toBe(false)
  })

  it('does not blame a member for merging an admin change from the server', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n' })
    // Admin publishes a new MCP server from another clone.
    const adminClone = join(workDir, `admin-${counter}`)
    git(['clone', '-q', bare, adminClone])
    git(['config', 'user.name', 'admin'], adminClone)
    git(['config', 'user.email', 'admin@example.com'], adminClone)
    writeFile(adminClone, '.mcp.json', '{"mcpServers":{"playwright":{}}}\n')
    commitAll(adminClone, 'admin adds mcp')
    expect(pushAs(adminClone, 'admin').ok).toBe(true)

    // Member worked in parallel, then merges (not rebases) the server state.
    writeFile(clone, 'work.md', 'w\n')
    commitAll(clone, 'member work')
    git(['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], clone)
    const r = pushAs(clone, 'member')
    expect(r.output).not.toContain('PROTECTED_CONFIG')
    expect(r.ok).toBe(true)
  })

  it('catches a merge that rolls a protected file back to an older version', () => {
    const { bare, clone } = setup({ 'README.md': 'hi\n', '.mcp.json': '{"v":1}\n' })
    const oldCommit = git(['rev-parse', 'HEAD'], clone).trim()
    writeFile(clone, '.mcp.json', '{"v":2}\n')
    commitAll(clone, 'admin v2')
    expect(pushAs(clone, 'admin').ok).toBe(true)

    // Merge an old commit (already on the server) and take its .mcp.json.
    git(['checkout', '-q', '-b', 'old', oldCommit], clone)
    writeFile(clone, 'side.md', 's\n')
    commitAll(clone, 'side')
    git(['checkout', '-q', 'main'], clone)
    git(['merge', '-q', '--no-ff', '--no-commit', '-s', 'ours', 'old'], clone)
    git(['checkout', oldCommit, '--', '.mcp.json'], clone)
    git(['commit', '-q', '--no-verify', '--no-edit'], clone)
    const before = remoteHead(bare)
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
    expect(remoteHead(bare)).toBe(before)
  })

  it('still reports secrets alongside protected paths, and protected paths are listed only once', () => {
    const { clone } = setup({ 'README.md': 'hi\n' })
    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'one')
    writeFile(clone, '.mcp.json', '{"a":1}\n')
    writeFile(clone, 'leak.txt', `key=AKIA${'A'.repeat(16)}\n`)
    commitAll(clone, 'two')
    const r = pushAs(clone, 'member')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[SECRET_DETECTED]')
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
  })
})

describe('git-http: the pusher role reaches the hook from the server, not the client', () => {
  const companyId = 'protectedhttp'
  const tokens = { member: 'tok-member', admin: 'tok-admin', owner: 'tok-owner' } as const
  let baseUrl: string
  let server: { close: () => void }
  let clone: string

  beforeAll(async () => {
    const Database = (await import('better-sqlite3')).default
    const { db, initDatabase } = await import('../../src/db')
    initDatabase()
    const now = new Date().toISOString()
    const expires = new Date(Date.now() + 3600_000).toISOString()
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(companyId, 'Protected', 'protected-http', 'u-owner', now, now)
    const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
    for (const role of ['member', 'admin', 'owner'] as const) {
      const userId = `u-${role}`
      authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(userId, `${role}@example.com`, role)
      authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)')
        .run(`s-${role}`, userId, tokens[role], expires)
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`m-${role}`, userId, companyId, role, now, now)
    }
    authDb.close()

    const bare = join(process.env.REPOS_DIR!, `${companyId}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', bare])
    configureBareRepo(bare)

    const { Hono } = await import('hono')
    const { serve } = await import('@hono/node-server')
    const { gitHttpRoute } = await import('../../src/routes/git-http')
    const app = new Hono()
    app.route('/api/git-http', gitHttpRoute)
    await new Promise<void>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
        baseUrl = `http://127.0.0.1:${info.port}/api/git-http/${companyId}.git`
        resolve()
      })
      server = s
    })

    clone = join(workDir, 'http-clone')
    mkdirSync(clone)
    git(['init', '-q', '-b', 'main'], clone)
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    writeFile(clone, 'README.md', 'hi\n')
    commitAll(clone, 'first')
  })

  afterAll(() => {
    server?.close()
  })

  // Async on purpose: the server runs in this process, so a synchronous
  // spawn would block the event loop it needs to answer the push.
  function httpPush(role: keyof typeof tokens, extraArgs: string[] = []): Promise<{ ok: boolean; output: string }> {
    const url = baseUrl.replace('http://', `http://git:${tokens[role]}@`)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    delete env.ACB_PUSHER_ROLE
    return new Promise((resolve) => {
      const p = spawn('git', [...extraArgs, 'push', url, 'HEAD:main'], { cwd: clone, env })
      let output = ''
      p.stdout.on('data', (d: Buffer) => { output += d.toString() })
      p.stderr.on('data', (d: Buffer) => { output += d.toString() })
      p.on('close', (code) => resolve({ ok: code === 0, output }))
    })
  }

  it('member: unrelated push accepted over HTTP', async () => {
    const r = await httpPush('member')
    expect(r.output).not.toContain('PROTECTED_CONFIG')
    expect(r.ok).toBe(true)
  })

  it('member: protected change rejected over HTTP, even when the client sends role headers', async () => {
    writeFile(clone, '.mcp.json', '{}\n')
    commitAll(clone, 'mcp')
    const r = await httpPush('member', [
      '-c', 'http.extraHeader=ACB-Pusher-Role: owner',
      '-c', 'http.extraHeader=X-ACB-PUSHER-ROLE: owner',
      '-c', 'http.extraHeader=ACB_PUSHER_ROLE: owner',
    ])
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.mcp.json'])
  })

  it('admin: the same push is accepted over HTTP', async () => {
    expect((await httpPush('admin')).ok).toBe(true)
  })

  it('owner: a further protected change is accepted over HTTP', async () => {
    writeFile(clone, '.claude/settings.json', '{}\n')
    commitAll(clone, 'settings')
    expect((await httpPush('owner')).ok).toBe(true)
  })

  it('member: a skill with an auto-run part is rejected over HTTP (content check runs under the server), admin accepted', async () => {
    writeFile(clone, '.claude/skills/x/SKILL.md', '---\nname: x\nhooks:\n  Stop: []\n---\n')
    commitAll(clone, 'skill with hooks')
    const r = await httpPush('member')
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.claude/skills/x/SKILL.md'])
    expect(r.output).toContain('frontmatter の hooks')
    expect((await httpPush('admin')).ok).toBe(true)
  })
})
