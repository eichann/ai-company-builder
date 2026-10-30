/**
 * Integration Test: who may fetch from and push to a company repository over
 * git smart HTTP (routes/git-http.ts).
 *
 * Only a member of the company, presenting a live session token, gets the
 * repository: someone from another company, an unknown or expired token, or
 * no credentials at all is refused (401 / 403 / 404) on the ref
 * advertisement, on upload-pack (fetch) and on receive-pack (push) — and the
 * repository is left exactly as it was. Only the two smart-HTTP services are
 * served; anything else (git-upload-archive, the dumb protocol) is refused.
 *
 * Real HTTP (the route on a loopback port), real git http-backend, real hook.
 * The upload-pack / receive-pack requests are built by hand so they reach
 * the POST endpoints directly (a git client stops at the refused
 * advertisement and would never send them).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
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

const CO = 'gha-co'
const OTHER_CO = 'gha-other'

let workDir: string
let bare: string
let origin: string
let server: { close: () => void }

function git(args: string[], cwd?: string, input?: Buffer | string): Buffer {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}), ...(input !== undefined ? { input } : {}) })
}

/** Every ref of the repository with its commit: "unchanged" means this is equal. */
const refsOf = (repo: string) => git(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)']).toString()

const basic = (token: string) => `Basic ${Buffer.from(`git:${token}`).toString('base64')}`

function pkt(line: string): Buffer {
  const body = Buffer.from(line)
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body])
}
const FLUSH = Buffer.from('0000')

let tip: string
let newCommit: string
let packForNewCommit: Buffer

/** A receive-pack request that moves main from `tip` to `newCommit` (a valid push). */
const receivePackBody = () =>
  Buffer.concat([pkt(`${tip} ${newCommit} refs/heads/main\0report-status\n`), FLUSH, packForNewCommit])

/** An upload-pack request asking for `tip` (a valid fetch, protocol v0). */
const uploadPackBody = () => Buffer.concat([pkt(`want ${tip}\n`), FLUSH, pkt('done\n')])

async function request(path: string, opts: { token?: string; method?: string; body?: Buffer; contentType?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token !== undefined) headers.Authorization = basic(opts.token)
  if (opts.contentType) headers['Content-Type'] = opts.contentType
  const res = await fetch(`${origin}/api/git-http/${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body ? { body: opts.body } : {}),
  })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body }
}

/** Run a git client against the server with `token` (async: the server runs in this process). */
function gitClient(args: string[], cwd: string, token: string): Promise<{ ok: boolean; output: string }> {
  const url = `${origin.replace('http://', `http://git:${token}@`)}/api/git-http/${CO}.git`
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const k of Object.keys(env)) if (k.startsWith('ACB_')) delete env[k]
  return new Promise((resolve) => {
    const p = spawn('git', args.map(a => (a === '<url>' ? url : a)), { cwd, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'acb-git-http-access-'))
  const Database = (await import('better-sqlite3')).default
  const dbModule = await import('../../src/db')
  dbModule.initDatabase()
  const db = dbModule.db
  const now = new Date().toISOString()
  const live = new Date(Date.now() + 3600_000).toISOString()
  const expired = new Date(Date.now() - 60_000).toISOString()

  for (const id of [CO, OTHER_CO]) {
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, id, 'u-member', now, now)
  }
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  const sessions: Array<[user: string, token: string, expiresAt: string]> = [
    ['u-member', 'tok-member', live],
    ['u-outsider', 'tok-outsider', live], // a member of another company only
    ['u-expired', 'tok-expired', expired], // a member whose session has expired
  ]
  for (const [user, token, expiresAt] of sessions) {
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(user, `${user}@example.com`, user)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${user}`, user, token, expiresAt)
  }
  authDb.close()
  const member = (user: string, company: string) =>
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${user}-${company}`, user, company, 'member', now, now)
  member('u-member', CO)
  member('u-expired', CO)
  member('u-outsider', OTHER_CO)
  const { ensureCompanyScope } = await import('../../src/lib/permission-store')
  ensureCompanyScope(db, CO) // everyone: read + write — a member's push would be accepted
  ensureCompanyScope(db, OTHER_CO)

  for (const id of [CO, OTHER_CO]) {
    const repo = join(process.env.REPOS_DIR!, `${id}.git`)
    git(['init', '-q', '--bare', '--initial-branch=main', repo])
    configureBareRepo(repo)
  }
  bare = join(process.env.REPOS_DIR!, `${CO}.git`)

  // Seed the company repository, then prepare (but do not push) a next commit.
  const seed = join(workDir, 'seed')
  git(['init', '-q', '--initial-branch=main', seed])
  git(['config', 'user.name', 'test'], seed)
  git(['config', 'user.email', 'test@example.com'], seed)
  writeFileSync(join(seed, 'README.md'), 'company\n')
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], seed)
  git(['push', '-q', bare, 'main'], seed)
  tip = git(['rev-parse', 'HEAD'], seed).toString().trim()
  writeFileSync(join(seed, 'planted.md'), 'from outside\n')
  git(['add', '-A'], seed)
  git(['commit', '-q', '--no-verify', '-m', 'planted'], seed)
  newCommit = git(['rev-parse', 'HEAD'], seed).toString().trim()
  packForNewCommit = git(['pack-objects', '--stdout', '--revs'], seed, `${newCommit}\n^${tip}\n`)

  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { gitHttpRoute } = await import('../../src/routes/git-http')
  const app = new Hono()
  app.route('/api/git-http', gitHttpRoute)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      origin = `http://127.0.0.1:${info.port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

const RECEIVE_PACK = 'application/x-git-receive-pack-request'
const UPLOAD_PACK = 'application/x-git-upload-pack-request'

describe('git smart HTTP: only members with a live session reach the company repository', () => {
  it('a member with a live session can fetch and push (the requests below are valid)', async () => {
    // Without this, every refusal below could be a malformed request.
    const ads = await request(`${CO}.git/info/refs?service=git-upload-pack`, { token: 'tok-member' })
    expect(ads.status).toBe(200)
    expect(ads.body.toString()).toContain(tip)
    const fetched = await request(`${CO}.git/git-upload-pack`, { token: 'tok-member', method: 'POST', body: uploadPackBody(), contentType: UPLOAD_PACK })
    expect(fetched.status).toBe(200)
    expect(fetched.body.includes(Buffer.from('PACK'))).toBe(true)
  })

  const callers: Array<[who: string, token: string | undefined, expected: number[]]> = [
    ['someone from another company', 'tok-outsider', [403, 404]],
    ['a member whose session has expired', 'tok-expired', [401]],
    ['an unknown token', 'tok-made-up', [401]],
    ['no credentials', undefined, [401]],
  ]

  for (const [who, token, expected] of callers) {
    describe(who, () => {
      it('gets no ref advertisement for fetch or push', async () => {
        for (const service of ['git-upload-pack', 'git-receive-pack']) {
          const r = await request(`${CO}.git/info/refs?service=${service}`, { token })
          expect(expected, `${service}: ${r.status}`).toContain(r.status)
          expect(r.body.toString()).not.toContain(tip)
        }
        const head = await request(`${CO}.git/HEAD`, { token })
        expect(expected).toContain(head.status)
      })

      it('cannot download the repository through upload-pack', async () => {
        const r = await request(`${CO}.git/git-upload-pack`, { token, method: 'POST', body: uploadPackBody(), contentType: UPLOAD_PACK })
        expect(expected).toContain(r.status)
        expect(r.body.includes(Buffer.from('PACK'))).toBe(false)
      })

      it('cannot push through receive-pack: the repository is unchanged', async () => {
        const before = refsOf(bare)
        const r = await request(`${CO}.git/git-receive-pack`, { token, method: 'POST', body: receivePackBody(), contentType: RECEIVE_PACK })
        expect(expected).toContain(r.status)
        expect(refsOf(bare)).toBe(before)
      })
    })
  }

  it('a git client from another company can neither clone nor push', async () => {
    const before = refsOf(bare)
    const cloneDir = join(workDir, 'outsider-clone')
    const clone = await gitClient(['clone', '-q', '<url>', cloneDir], workDir, 'tok-outsider')
    expect(clone.ok).toBe(false)

    const local = join(workDir, 'outsider-work')
    git(['clone', '-q', join(workDir, 'seed'), local])
    const push = await gitClient(['push', '<url>', 'HEAD:main'], local, 'tok-outsider')
    expect(push.ok).toBe(false)
    expect(refsOf(bare)).toBe(before)
  })

  // Last: it moves main. Proves the receive-pack request refused above is a
  // push the server accepts from a member.
  it('the same receive-pack request from a member moves main', async () => {
    const r = await request(`${CO}.git/git-receive-pack`, { token: 'tok-member', method: 'POST', body: receivePackBody(), contentType: RECEIVE_PACK })
    expect(r.status).toBe(200)
    expect(git(['-C', bare, 'rev-parse', 'main']).toString().trim()).toBe(newCommit)
  })
})

describe('git smart HTTP: only the two smart services are served', () => {
  it('refuses git-upload-archive, an unknown service and the dumb protocol, even for a member', async () => {
    for (const query of ['?service=git-upload-archive', '?service=git-anything', '']) {
      const r = await request(`${CO}.git/info/refs${query}`, { token: 'tok-member' })
      expect(r.status, `info/refs${query}`).toBe(400)
      expect(r.body.toString()).not.toContain(tip)
    }
    const archive = await request(`${CO}.git/git-upload-archive`, { token: 'tok-member', method: 'POST', body: Buffer.from('0000') })
    expect(archive.status).toBe(404)
  })
})
