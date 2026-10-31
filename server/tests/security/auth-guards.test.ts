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

const ROUTES_DIR = join(__dirname, '../../src/routes')

/** `<file> <METHOD> <path>` → why it needs no session. */
const PUBLIC_ENDPOINTS: Record<string, string> = {
  'invitations.ts GET /invitations/:token': 'the sign-up page validates an invitation link before an account exists',
  'oauth.ts GET /google/callback': 'Google sends the member\'s browser back without an ACB session; the state (single use, 10 min, found only inside its own company) is the proof',
}

interface Endpoint { file: string; method: string; path: string; app: Hono }

const endpoints: Endpoint[] = []

beforeAll(async () => {
  (await import('../../src/db')).initDatabase()
  for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts')).sort()) {
    const mod = await import(join(ROUTES_DIR, file)) as Record<string, unknown>
    for (const value of Object.values(mod)) {
      if (!(value instanceof Hono)) continue
      const app = new Hono().route('/', value)
      for (const r of value.routes) {
        if (r.method === 'ALL') continue // middleware
        endpoints.push({ file, method: r.method, path: r.path, app })
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
})
