/**
 * Integration Test: partial clone over the real git-http endpoint.
 *
 * A member setting up a company for the first time picks their departments;
 * the desktop app then fetches with --filter=blob:none and sets the sparse
 * cone before the first checkout (client/electron/sync/first-setup.ts), so
 * only the chosen departments' blobs are downloaded. Everything else is
 * fetched lazily, by object id, when git needs it later.
 *
 * Through configureBareRepo, the real git-http route and real git clients
 * authenticating the way the app's createGit() does (GIT_ASKPASS printing
 * $GIT_TOKEN, credential.helper cleared, no terminal prompt):
 *  - a partial clone receives no blob outside the sparse cone;
 *  - a lazy fetch of a missing blob (current or historical — not a ref tip,
 *    which protocol v0 refuses without uploadpack.allowReachableSHA1InWant)
 *    works with the same auth;
 *  - without the token the lazy fetch fails, cleanly: the command exits
 *    non-zero and the repository is unchanged and still usable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { db, initDatabase } from '../../src/db'
import { configureBareRepo } from '../../src/routes/git'
import { gitHttpRoute } from '../../src/routes/git-http'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const COMPANY = 'partialco'
const TOKEN = 'tok-partial-member'
const BIG = Buffer.alloc(200_000, 7) // stands in for the pptx / png / mp4 that make up most of a company repo

const app = new Hono()
app.route('/api/git-http', gitHttpRoute)

let workDir: string
let server: { close: () => void }
let remoteUrl: string
let askPass: string

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string | Buffer) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/**
 * git as the desktop app runs it (sync/git-factory.ts): askpass + token,
 * no credential helper, no prompt. Async: the server runs in this process.
 */
function appGit(args: string[], cwd: string, opts: { token?: string } = {}): Promise<{ ok: boolean; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askPass, GIT_TOKEN: opts.token ?? TOKEN }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', ['-c', 'credential.helper=', '-c', 'core.quotePath=false', ...args], { cwd, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

async function ok(args: string[], cwd: string, opts: { token?: string } = {}): Promise<string> {
  const r = await appGit(args, cwd, opts)
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed:\n${r.output}`)
  return r.output
}

/** Blob ids missing from the clone (never downloaded). --missing disables lazy fetching. */
function missingObjects(clone: string): Set<string> {
  const out = git(['rev-list', '--objects', '--missing=print', '--all'], clone)
  return new Set(out.split('\n').filter(l => l.startsWith('?')).map(l => l.slice(1).trim()))
}

/** path → blob id at `rev` in the bare repository. */
function treeAt(rev: string): Map<string, string> {
  const bare = join(process.env.REPOS_DIR!, `${COMPANY}.git`)
  const map = new Map<string, string>()
  for (const entry of git(['ls-tree', '-r', '-z', rev], bare).split('\0')) {
    if (!entry) continue
    const [meta, file] = entry.split('\t')
    map.set(file, meta.split(' ')[2])
  }
  return map
}

/** What first-setup.ts does: fetch without blobs, set the cone, then check out. */
async function partialClone(name: string, cone: string[]): Promise<string> {
  const clone = join(workDir, name)
  mkdirSync(clone)
  await ok(['init', '-q', '-b', 'main'], clone)
  await ok(['remote', 'add', 'origin', remoteUrl], clone)
  await ok(['fetch', '-q', '--filter=blob:none', 'origin'], clone)
  await ok(['sparse-checkout', 'set', '--cone', ...cone], clone)
  await ok(['checkout', '-q', '-b', 'main', 'origin/main'], clone)
  return clone
}

beforeAll(async () => {
  initDatabase()
  workDir = mkdtempSync(join(tmpdir(), 'acb-partial-clone-'))
  askPass = join(workDir, 'askpass.sh')
  writeFileSync(askPass, '#!/bin/sh\necho "$GIT_TOKEN"\n')
  chmodSync(askPass, 0o755)

  const now = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(COMPANY, 'Partial', 'partial', 'u-partial', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run('u-partial', 'u-partial@example.com', 'partial')
  authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)')
    .run('s-partial', 'u-partial', TOKEN, new Date(Date.now() + 3600_000).toISOString())
  authDb.close()
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('m-partial', 'u-partial', COMPANY, 'member', now, now)

  // Two commits, so one version of the big file is reachable only from history.
  const bare = join(process.env.REPOS_DIR!, `${COMPANY}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  const seed = join(workDir, 'seed')
  git(['clone', '-q', bare, seed])
  writeFile(seed, 'README.md', 'company\n')
  writeFile(seed, '.claude/skills/s/SKILL.md', '---\nname: s\n---\n')
  writeFile(seed, '営業部/提案書.md', 'sales v1\n')
  writeFile(seed, '開発部/設計.md', 'dev v1\n')
  writeFile(seed, '開発部/demo.mp4', BIG)
  git(['add', '-A'], seed)
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'v1'], seed)
  writeFile(seed, '開発部/設計.md', 'dev v2\n')
  writeFile(seed, '営業部/提案書.md', 'sales v2\n')
  git(['add', '-A'], seed)
  git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'v2'], seed)
  git(['push', '-q', 'origin', 'main'], seed)
  configureBareRepo(bare)

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      remoteUrl = `http://127.0.0.1:${info.port}/api/git-http/${COMPANY}.git`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('partial clone over git-http', () => {
  it('downloads no blob outside the sparse cone', async () => {
    const clone = await partialClone('cone', ['営業部', '.claude'])
    expect(readFileSync(join(clone, '営業部/提案書.md'), 'utf-8')).toBe('sales v2\n')
    expect(existsSync(join(clone, 'README.md'))).toBe(true)
    expect(existsSync(join(clone, '.claude/skills/s/SKILL.md'))).toBe(true)
    expect(existsSync(join(clone, '開発部'))).toBe(false)

    const missing = missingObjects(clone)
    const head = treeAt('main')
    for (const [file, oid] of head) {
      if (file.startsWith('開発部/')) expect(missing.has(oid), `${file} should not be downloaded`).toBe(true)
      else expect(missing.has(oid), `${file} should be present`).toBe(false)
    }
    // History outside the cone is not downloaded either (e.g. old versions).
    expect(missing.has(treeAt('main~1').get('開発部/設計.md')!)).toBe(true)
    expect(git(['config', 'remote.origin.promisor'], clone).trim()).toBe('true')
    expect(git(['config', 'remote.origin.partialclonefilter'], clone).trim()).toBe('blob:none')
  })

  it('fetches a missing blob lazily with the same auth — tip and history alike', async () => {
    const clone = await partialClone('lazy', ['営業部'])
    expect(await ok(['cat-file', '-p', 'origin/main:開発部/設計.md'], clone)).toBe('dev v2\n')
    // Not a ref tip: refused under protocol v0 without allowReachableSHA1InWant.
    expect(await ok(['cat-file', '-p', 'origin/main~1:開発部/設計.md'], clone)).toBe('dev v1\n')
    // Adding a department later (the settings panel) downloads just that folder.
    await ok(['sparse-checkout', 'set', '--cone', '営業部', '開発部'], clone)
    expect(readFileSync(join(clone, '開発部/demo.mp4')).equals(BIG)).toBe(true)
    expect(git(['status', '--porcelain'], clone).trim()).toBe('')
  })

  it('fails cleanly without the token: non-zero exit, nothing changed, repository still usable', async () => {
    const clone = await partialClone('noauth', ['営業部'])
    const before = missingObjects(clone)
    const oid = treeAt('main').get('開発部/demo.mp4')!
    expect(before.has(oid)).toBe(true)

    const denied = await appGit(['cat-file', '-p', oid], clone, { token: 'wrong-token' })
    expect(denied.ok).toBe(false)
    const addDenied = await appGit(['sparse-checkout', 'set', '--cone', '営業部', '開発部'], clone, { token: 'wrong-token' })
    expect(addDenied.ok).toBe(false)
    // sparse-checkout rolled back: the cone and the worktree are as before.
    expect(git(['-c', 'core.quotePath=false', 'sparse-checkout', 'list'], clone).trim().split('\n')).toEqual(['営業部'])
    expect(existsSync(join(clone, '開発部'))).toBe(false)
    expect(git(['status', '--porcelain'], clone).trim()).toBe('')
    expect(missingObjects(clone)).toEqual(before)
    git(['fsck', '--connectivity-only', '--no-progress'], clone)

    // With the token again the same command succeeds.
    await ok(['sparse-checkout', 'set', '--cone', '営業部', '開発部'], clone)
    expect(existsSync(join(clone, '開発部/demo.mp4'))).toBe(true)
  })
})
