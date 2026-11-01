/**
 * Security Test: no endpoint answers a request that carries no sign-in.
 *
 * Every handler of every route file in src/routes is called without a session
 * (and without git Basic credentials); each must answer 401. Route files and
 * handlers are discovered at run time, so a new endpoint is covered the day it
 * is added, whichever helper it uses to check the session (getUserFromRequest,
 * a route's own authenticateMember, git-http's Basic auth, …).
 *
 * The only endpoints meant to be reachable without a session are listed in
 * PUBLIC_ENDPOINTS with their reason.
 *
 * Every endpoint also names one of src/routes/guards.ts's guards as its first
 * handler (companyMember, signedIn, publicRoute), so a forgotten check cannot
 * be written (server.md "Route guards"). Files still being moved onto the
 * guards are in NOT_YET_GUARDED; that list only shrinks.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readdirSync } from 'fs'
import { join } from 'path'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { guardKind } from '../../src/routes/guards'

const ROUTES_DIR = join(__dirname, '../../src/routes')

/** `<file> <METHOD> <path>` → why it needs no session. */
const PUBLIC_ENDPOINTS: Record<string, string> = {
  'invitations.ts GET /invitations/:token': 'the sign-up page validates an invitation link before an account exists',
  'google-drive.ts GET /': 'the static Google Picker page (google-drive.md): it holds no secret; the token reaches it only from the app\'s own Picker window',
  'slack-connection.ts POST /events/:companyId': 'Slack sends a company\'s events without an ACB session; the company\'s own signing secret (HMAC of the exact body, 5 minutes) is the proof — anything unsigned answers an empty 401 (slack-connector.md)',
  'oauth.ts GET /:provider/callback': 'the provider (Google, Slack) sends the member\'s browser back without an ACB session; the state (single use, 10 min, found only inside its own company and for that provider) is the proof',
}

/**
 * Route files whose endpoints still check the session by hand. Moved file by
 * file onto the guards; remove a file here when it is moved (the test fails
 * while a listed file is fully guarded). Never add one.
 */
const NOT_YET_GUARDED = new Set([
  'agent-events.ts', 'agent-sandbox.ts', 'agent-stops.ts', 'ai-runs.ts', 'approvals.ts',
  'broker-relay.ts', 'companies.ts', 'company-files.ts', 'core-connectors.ts', 'departments.ts',
  'folder-sizes.ts', 'git-http.ts', 'git.ts', 'google-drive.ts', 'google.ts', 'identities.ts',
  'inbox.ts', 'invitations.ts', 'key-broker.ts', 'minutes.ts', 'oauth.ts', 'outbound-mail.ts',
  'permission-rules.ts', 'permissions.ts', 'plugins.ts', 'private-folders.ts',
  'records-ai-identities.ts', 'records-ai-inbox.ts', 'records-ai.ts', 'records.ts',
  'slack-connection.ts',
])

interface Endpoint { file: string; method: string; path: string; app: Hono; guard: ReturnType<typeof guardKind> }

const endpoints: Endpoint[] = []

beforeAll(async () => {
  (await import('../../src/db')).initDatabase()
  for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts')).sort()) {
    const mod = await import(join(ROUTES_DIR, file)) as Record<string, unknown>
    for (const value of Object.values(mod)) {
      if (!(value instanceof Hono)) continue
      const app = new Hono().route('/', value)
      const seen = new Set<string>()
      for (const r of value.routes) {
        if (r.method === 'ALL') continue // middleware
        // `get(path, guard, …, handler)` lists one entry per handler: the first is the guard.
        const key = `${r.method} ${r.path}`
        if (seen.has(key)) continue
        seen.add(key)
        endpoints.push({ file, method: r.method, path: r.path, app, guard: guardKind(r.handler) })
      }
    }
  }
})

/**
 * A concrete URL for a route pattern: each parameter becomes a harmless value.
 * git's advertisement always carries ?service= (a request without it is refused
 * before anything is read, so it would not reach the sign-in check).
 */
function concrete(path: string): string {
  const url = path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_, name: string) => (name === 'repo' ? 'company-x.git' : `${name}-x`))
  return url.endsWith('/info/refs') ? `${url}?service=git-upload-pack` : url
}

describe('Authentication guards', () => {
  it('finds the endpoints of every route file', () => {
    expect(endpoints.length).toBeGreaterThan(50)
    const files = new Set(endpoints.map(e => e.file))
    for (const file of ['companies.ts', 'departments.ts', 'permissions.ts', 'permission-rules.ts', 'private-folders.ts', 'git-http.ts', 'agent-events.ts']) {
      expect(files, file).toContain(file)
    }
  })

  it('every endpoint answers 401 to a request without a session (except the listed public ones)', async () => {
    const violations: string[] = []
    const publicSeen = new Set<string>()
    for (const e of endpoints) {
      const key = `${e.file} ${e.method} ${e.path}`
      const init: RequestInit = { method: e.method }
      if (e.method !== 'GET' && e.method !== 'HEAD') {
        init.body = '{}'
        init.headers = { 'Content-Type': 'application/json' }
      }
      const res = await e.app.request(concrete(e.path), init)
      if (key in PUBLIC_ENDPOINTS) {
        publicSeen.add(key)
        continue
      }
      if (res.status !== 401) violations.push(`${key} → ${res.status}`)
    }
    expect(violations, `These endpoints answer without a session:\n${violations.join('\n')}`).toEqual([])
    expect([...publicSeen].sort(), 'a listed public endpoint no longer exists: remove it from PUBLIC_ENDPOINTS')
      .toEqual(Object.keys(PUBLIC_ENDPOINTS).sort())
  })

  it('every endpoint starts with a route guard (companyMember, signedIn, publicRoute)', () => {
    const missing: string[] = []
    const wrongPublic: string[] = []
    for (const e of endpoints) {
      if (NOT_YET_GUARDED.has(e.file)) continue
      const key = `${e.file} ${e.method} ${e.path}`
      if (e.guard === null) missing.push(key)
      else if ((e.guard === 'public') !== (key in PUBLIC_ENDPOINTS)) wrongPublic.push(`${key} (${e.guard})`)
    }
    expect(missing, 'Endpoints without a guard from src/routes/guards.ts as their first handler').toEqual([])
    expect(wrongPublic, 'publicRoute(...) is for exactly the PUBLIC_ENDPOINTS, and they use it').toEqual([])
  })

  it('NOT_YET_GUARDED lists only files that still have an unguarded endpoint', () => {
    const files = new Set(endpoints.map(e => e.file))
    const stale = [...NOT_YET_GUARDED].filter(f => files.has(f) && endpoints.filter(e => e.file === f).every(e => e.guard !== null))
    expect(stale, 'these files are fully guarded now: remove them from NOT_YET_GUARDED').toEqual([])
  })
})
