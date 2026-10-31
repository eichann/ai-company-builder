/**
 * Integration Test: per-member client build / sync tracking (client_activity).
 *
 * - API requests under a company that carry X-ACB-Client-Version record the
 *   build; requests without it (old apps, admin panel) record nothing.
 * - git-http records the build (or NULL when absent), last_fetch_at when an
 *   upload-pack completes, and last_push_at only when receive-pack accepted
 *   every ref — through a real bare repo, the real pre-receive hook and real
 *   git clients configured with http.extraHeader the way the desktop app's
 *   createGit() does.
 * - Writes are throttled; the owner/admin-only endpoint; the "all active
 *   members on build >= X" helper.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import type { AddressInfo } from 'net'

const currentUser = vi.hoisted(() => ({ id: 'u-owner' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) =>
    new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { configureBareRepo, gitRoute } from '../../src/routes/git'
import { gitHttpRoute } from '../../src/routes/git-http'
import { clientActivityMiddleware } from '../../src/routes/client-activity-middleware'
import { receivePackSucceeded } from '../../src/lib/client-activity'
import type { ClientActivityRow } from '../../src/ports/client-activity'
import { services } from '../../src/composition'

const { activeMembersBuildCheck, areActiveMembersOnBuild } = services.clientActivity
const recordClientActivity = services.clientActivity.record
const resetClientActivityThrottle = services.clientActivity.resetThrottleForTests
import { compareClientVersions, parseClientVersion } from '../../src/lib/client-version'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const COMPANY = 'activityco'
const V_NEW = '0.0.1+95346af.20261021031200'
const V_OLD = '0.0.1+810fdd6.20261001090000'
const PLATFORM = 'darwin/arm64'

const tokens: Record<string, string> = {}

function row(userId: string, companyId = COMPANY): ClientActivityRow | undefined {
  return db.prepare('SELECT * FROM client_activity WHERE user_id = ? AND company_id = ?')
    .get(userId, companyId) as ClientActivityRow | undefined
}

const app = new Hono()
app.use('/api/*', clientActivityMiddleware)
app.route('/api/companies', companiesRoute)
app.route('/api/git', gitRoute)
app.route('/api/git-http', gitHttpRoute)

let workDir: string
let server: { close: () => void }
let gitBase: string

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string, message: string) {
  git(['add', '-A', '-f', '.'], clone)
  git(['commit', '-q', '--no-verify', '--allow-empty', '-m', message], clone)
}

/** The -c list the desktop app adds in createGit() (client-identity.ts). */
function identityConfig(version?: string): string[] {
  if (!version) return []
  return [
    '-c', `http.extraHeader=X-ACB-Client-Version: ${version}`,
    '-c', `http.extraHeader=X-ACB-Client-Platform: ${PLATFORM}`,
  ]
}

// Async: the server runs in this process, a sync spawn would deadlock it.
function gitAs(userId: string, args: string[], cwd: string, version?: string): Promise<{ ok: boolean; output: string }> {
  const url = gitBase.replace('http://', `http://git:${tokens[userId]}@`)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.ACB_PUSHER_ROLE
  const finalArgs = [...identityConfig(version), ...args.map(a => (a === '<url>' ? url : a))]
  return new Promise((resolve) => {
    const p = spawn('git', finalArgs, { cwd, env })
    let output = ''
    p.stdout.on('data', (d: Buffer) => { output += d.toString() })
    p.stderr.on('data', (d: Buffer) => { output += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

beforeAll(async () => {
  initDatabase()
  workDir = mkdtempSync(join(tmpdir(), 'acb-client-activity-'))
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 3600_000).toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(COMPANY, 'Activity', 'activity', 'u-owner', now, now)
  const authDb = new Database(join(process.env.DATA_DIR!, 'auth.sqlite'))
  const users: Array<[string, string]> = [
    ['u-owner', 'owner'], ['u-admin', 'admin'], ['u-member', 'member'],
    ['u-pusher', 'member'], ['u-rejected', 'member'], ['u-oldapp', 'member'],
  ]
  for (const [id, role] of users) {
    tokens[id] = `tok-${id}`
    authDb.prepare('INSERT INTO user (id, email, name) VALUES (?, ?, ?)').run(id, `${id}@example.com`, id)
    authDb.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${id}`, id, tokens[id], expires)
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`m-${id}`, id, COMPANY, role, now, now)
  }
  authDb.close()

  const bare = join(process.env.REPOS_DIR!, `${COMPANY}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      gitBase = `http://127.0.0.1:${info.port}/api/git-http/${COMPANY}.git`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetClientActivityThrottle()
  currentUser.id = 'u-owner'
})

describe('build identity ordering', () => {
  it('parses the app format', () => {
    expect(parseClientVersion(V_NEW)).toMatchObject({
      major: 0, minor: 0, patch: 1, prerelease: [], sha: '95346af', commitDate: '20261021031200', dev: false,
    })
    expect(parseClientVersion('0.0.1-dev+95346af.20261021031200')?.dev).toBe(true)
    expect(parseClientVersion('0.0.1+nogit.00000000000000')).toMatchObject({ sha: null, commitDate: null })
    expect(parseClientVersion('not a version')).toBeNull()
    expect(parseClientVersion(null)).toBeNull()
  })

  it('orders by semver, then pre-release, then commit date; the sha never orders', () => {
    const p = (v: string) => parseClientVersion(v)!
    expect(compareClientVersions(p(V_NEW), p(V_OLD))).toBeGreaterThan(0)
    expect(compareClientVersions(p(V_OLD), p(V_NEW))).toBeLessThan(0)
    expect(compareClientVersions(p('0.1.0+aaaaaaa.20200101000000'), p(V_NEW))).toBeGreaterThan(0)
    expect(compareClientVersions(p('0.0.1-dev+aaaaaaa.20990101000000'), p(V_OLD))).toBeLessThan(0)
    expect(compareClientVersions(p('0.0.1+bbbbbbb.20261021031200'), p(V_NEW))).toBe(0)
    expect(compareClientVersions(p('0.0.1+nogit.00000000000000'), p(V_OLD))).toBeLessThan(0)
    expect(compareClientVersions(p('1.0.0-alpha.2'), p('1.0.0-alpha.10'))).toBeLessThan(0)
  })
})

describe('receive-pack report-status', () => {
  const pkt = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s) : s
    return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b])
  }
  const sideband = (inner: Buffer) => pkt(Buffer.concat([Buffer.from([1]), inner]))

  it('accepts only when unpack ok and every ref ok (plain and side-band)', () => {
    const okReport = Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/main\n'), Buffer.from('0000')])
    expect(receivePackSucceeded(okReport)).toBe(true)
    expect(receivePackSucceeded(Buffer.concat([sideband(okReport), pkt(Buffer.from([2, 0x68, 0x69])), Buffer.from('0000')]))).toBe(true)
    const ng = Buffer.concat([pkt('unpack ok\n'), pkt('ok refs/heads/a\n'), pkt('ng refs/heads/main pre-receive hook declined\n'), Buffer.from('0000')])
    expect(receivePackSucceeded(sideband(ng))).toBe(false)
    const unpackFail = Buffer.concat([pkt('unpack index-pack abnormal exit\n'), pkt('ng refs/heads/main unpacker error\n'), Buffer.from('0000')])
    expect(receivePackSucceeded(unpackFail)).toBe(false)
    expect(receivePackSucceeded(Buffer.alloc(0))).toBe(false)
  })
})

describe('API requests', () => {
  it('records build and platform for a member request that carries the headers', async () => {
    currentUser.id = 'u-member'
    const res = await app.request(`/api/companies/${COMPANY}`, {
      headers: { 'X-ACB-Client-Version': V_NEW, 'X-ACB-Client-Platform': PLATFORM },
    })
    expect(res.status).toBe(200)
    const r = row('u-member')!
    expect(r.client_version).toBe(V_NEW)
    expect(r.client_platform).toBe(PLATFORM)
    expect(r.last_seen_at).toBeTruthy()
    expect(r.last_fetch_at).toBeNull()
    expect(r.last_push_at).toBeNull()
  })

  it('works unchanged and records nothing without the headers (old apps, admin panel)', async () => {
    currentUser.id = 'u-admin'
    const res = await app.request(`/api/companies/${COMPANY}`)
    expect(res.status).toBe(200)
    expect(row('u-admin')).toBeUndefined()
  })

  it('does not record for a non-member or outside a company context', async () => {
    currentUser.id = 'u-stranger'
    await app.request(`/api/companies/${COMPANY}`, { headers: { 'X-ACB-Client-Version': V_NEW } })
    expect(row('u-stranger')).toBeUndefined()
    currentUser.id = 'u-admin'
    await app.request('/api/companies', { headers: { 'X-ACB-Client-Version': V_NEW } })
    expect(row('u-admin')).toBeUndefined()
  })

  it('throttles writes to one per minute per member unless the build changes', async () => {
    currentUser.id = 'u-owner'
    const headers = { 'X-ACB-Client-Version': V_OLD, 'X-ACB-Client-Platform': PLATFORM }
    await app.request(`/api/companies/${COMPANY}/departments`, { headers })
    const first = row('u-owner')!
    await new Promise(r => setTimeout(r, 15))
    await app.request(`/api/companies/${COMPANY}`, { headers })
    expect(row('u-owner')!.updated_at).toBe(first.updated_at)
    // A different build is written immediately.
    await app.request(`/api/companies/${COMPANY}`, { headers: { ...headers, 'X-ACB-Client-Version': V_NEW } })
    expect(row('u-owner')!.client_version).toBe(V_NEW)

    // Direct: same values inside the window are skipped, after it written.
    const t0 = Date.parse('2030-01-01T00:00:00Z')
    const args = { userId: 'u-throttle', companyId: COMPANY, kind: 'seen' as const, version: V_NEW, platform: PLATFORM }
    expect(recordClientActivity({ ...args, nowMs: t0 })).toBe(true)
    expect(recordClientActivity({ ...args, nowMs: t0 + 59_000 })).toBe(false)
    expect(recordClientActivity({ ...args, nowMs: t0 + 60_000 })).toBe(true)
    expect(recordClientActivity({ ...args, kind: 'fetch', nowMs: t0 + 60_001 })).toBe(true)
    db.prepare('DELETE FROM client_activity WHERE user_id = ?').run('u-throttle')
  })
})

describe('git-http', () => {
  let clone: string

  beforeAll(() => {
    clone = join(workDir, 'clone')
    mkdirSync(clone)
    git(['init', '-q', '-b', 'main'], clone)
    git(['config', 'user.name', 'test'], clone)
    git(['config', 'user.email', 'test@example.com'], clone)
    writeFile(clone, 'README.md', 'hi\n')
    commitAll(clone, 'first')
  })

  it('records last_push_at, build and platform for an accepted push', async () => {
    const r = await gitAs('u-pusher', ['push', '<url>', 'HEAD:main'], clone, V_NEW)
    expect(r.ok, r.output).toBe(true)
    const a = row('u-pusher')!
    expect(a.client_version).toBe(V_NEW)
    expect(a.client_platform).toBe(PLATFORM)
    expect(a.last_push_at).toBeTruthy()
    expect(a.last_seen_at).toBeTruthy()
  })

  it('does not count a rejected push as a sync', async () => {
    writeFile(clone, '.personal/memo.md', 'private\n')
    commitAll(clone, 'personal')
    const r = await gitAs('u-rejected', ['push', '<url>', 'HEAD:main'], clone, V_NEW)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('PERSONAL_PATH')
    const a = row('u-rejected')!
    expect(a.last_seen_at).toBeTruthy()
    expect(a.last_push_at).toBeNull()

    // Also for a member whose earlier push was recorded.
    const before = row('u-pusher')!.last_push_at
    resetClientActivityThrottle()
    await new Promise(r => setTimeout(r, 15))
    const r2 = await gitAs('u-pusher', ['push', '<url>', 'HEAD:main'], clone, V_NEW)
    expect(r2.ok).toBe(false)
    expect(row('u-pusher')!.last_push_at).toBe(before)
    git(['reset', '-q', '--hard', 'HEAD~1'], clone)
  })

  it('records last_fetch_at for a fetch, including one with nothing new', async () => {
    const other = join(workDir, 'fetcher')
    mkdirSync(other)
    git(['init', '-q', '-b', 'main'], other)
    const r = await gitAs('u-member', ['fetch', '<url>', 'main'], other, V_NEW)
    expect(r.ok, r.output).toBe(true)
    const first = row('u-member')!.last_fetch_at
    expect(first).toBeTruthy()

    resetClientActivityThrottle()
    await new Promise(r => setTimeout(r, 15))
    const again = await gitAs('u-member', ['fetch', '<url>', 'main'], other, V_NEW)
    expect(again.ok).toBe(true)
    expect(row('u-member')!.last_fetch_at! > first!).toBe(true)
  })

  it('serves an old app without headers exactly as before and records its build as unknown', async () => {
    const other = join(workDir, 'oldapp')
    mkdirSync(other)
    git(['init', '-q', '-b', 'main'], other)
    // Simulate a member who used to run a new build on this account.
    recordClientActivity({ userId: 'u-oldapp', companyId: COMPANY, kind: 'seen', version: V_NEW, platform: PLATFORM, nowMs: Date.now() - 3_600_000 })
    const r = await gitAs('u-oldapp', ['fetch', '<url>', 'main'], other)
    expect(r.ok, r.output).toBe(true)
    const a = row('u-oldapp')!
    expect(a.client_version).toBeNull()
    expect(a.client_platform).toBeNull()
    expect(a.last_fetch_at).toBeTruthy()
  })
})

describe('GET /api/companies/:id/client-activity', () => {
  it('rejects a member with 403', async () => {
    currentUser.id = 'u-member'
    const res = await app.request(`/api/companies/${COMPANY}/client-activity`)
    expect(res.status).toBe(403)
  })

  it('rejects a non-member with 404 and an anonymous request with 401', async () => {
    currentUser.id = 'u-stranger'
    expect((await app.request(`/api/companies/${COMPANY}/client-activity`)).status).toBe(404)
    currentUser.id = null
    expect((await app.request(`/api/companies/${COMPANY}/client-activity`)).status).toBe(401)
  })

  it('returns every member with build, platform and last seen / fetch / push for an admin', async () => {
    currentUser.id = 'u-admin'
    const res = await app.request(`/api/companies/${COMPANY}/client-activity`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<Record<string, unknown>> }
    expect(body.data.map(m => m.userId).sort()).toEqual(['u-admin', 'u-member', 'u-oldapp', 'u-owner', 'u-pusher', 'u-rejected'])
    const pusher = body.data.find(m => m.userId === 'u-pusher')!
    expect(pusher).toMatchObject({
      role: 'member',
      email: 'u-pusher@example.com',
      clientVersion: V_NEW,
      clientPlatform: PLATFORM,
      build: { semver: '0.0.1', sha: '95346af', commitDate: '20261021031200', dev: false },
    })
    // A boolean for every member (false while AGENT_EVENTS_CLIENT_COMMIT_DATE is null, and for unknown builds).
    expect(body.data.every(m => typeof m.supportsAgentEvents === 'boolean')).toBe(true)
    expect(pusher.lastPushAt).toBeTruthy()
    const admin = body.data.find(m => m.userId === 'u-admin')!
    expect(admin).toMatchObject({ clientVersion: null, build: null, lastSeenAt: null, lastFetchAt: null, lastPushAt: null, supportsAgentEvents: false })
  })
})

describe('activeMembersBuildCheck', () => {
  const CO = 'gateco'
  const now = new Date('2030-06-15T00:00:00Z')
  const daysAgo = (d: number) => now.getTime() - d * 86_400_000

  beforeAll(() => {
    const ts = now.toISOString()
    db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(CO, 'Gate', 'gate', 'g-new', ts, ts)
    for (const id of ['g-new', 'g-old', 'g-unknown', 'g-stale', 'g-never']) {
      db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`m-${id}`, id, CO, 'member', ts, ts)
    }
    const rec = (userId: string, version: string | null, nowMs: number) =>
      recordClientActivity({ userId, companyId: CO, kind: 'seen', version, platform: PLATFORM, nowMs })
    rec('g-new', V_NEW, daysAgo(1))
    rec('g-old', V_OLD, daysAgo(2))
    rec('g-unknown', null, daysAgo(3))
    rec('g-stale', V_OLD, daysAgo(30))
    // A former member's row never counts.
    rec('g-removed', V_OLD, daysAgo(1))
  })

  it('reports outdated and unknown active members and ignores inactive ones', () => {
    const r = activeMembersBuildCheck(CO, V_NEW, { activeWithinDays: 14, now })
    expect(r.ok).toBe(false)
    expect(r.current.map(m => m.userId)).toEqual(['g-new'])
    expect(r.outdated.map(m => m.userId)).toEqual(['g-old'])
    expect(r.unknown.map(m => m.userId)).toEqual(['g-unknown'])
    expect(r.inactive.map(m => m.userId).sort()).toEqual(['g-never', 'g-stale'])
    expect(areActiveMembersOnBuild(CO, V_NEW, { activeWithinDays: 14, now })).toBe(false)
  })

  it('passes once everyone active is on the minimum build or newer', () => {
    expect(areActiveMembersOnBuild(CO, V_OLD, { activeWithinDays: 2.5, now })).toBe(true)
    expect(areActiveMembersOnBuild(CO, V_NEW, { activeWithinDays: 1.5, now })).toBe(true)
  })

  it('rejects an unparseable minimum', () => {
    expect(() => activeMembersBuildCheck(CO, 'latest')).toThrow()
  })
})
