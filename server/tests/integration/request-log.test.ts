/**
 * Integration Test: the shared request log (lib/request-log.ts) never prints
 * what a member sent — file paths, folder names (private ones included),
 * search terms, a relay token in `?key=`, an invitation token — and still
 * prints what troubleshooting needs: request id (also in X-Request-Id), method,
 * route pattern, status, duration, company and user ids (2026-10-31).
 *
 * Every console output of the server during the requests is captured, so a
 * handler that logs a path would fail this too.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join } = await import('path')
  const { noteRequestUser } = await import('../../src/lib/request-log')
  return {
    authDb: new Database(join(process.env.DATA_DIR!, 'auth.sqlite')),
    // As the real one: note the signed-in user for the log line.
    getUserFromRequest: vi.fn().mockImplementation(async (req: Request) => {
      const id = req.headers.get('x-test-user')
      if (id) noteRequestUser(req, id)
      return id ? { id, email: `${id}@example.com`, name: id, image: null, emailVerified: true } : null
    }),
    getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: id }]))),
    auth: {
      handler: vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const OWNER = 'rl-owner'
const SECRET_FOLDER = '人事評価_極秘'
const SEARCH_TERM = '給与明細の検索語'
const RELAY_TOKEN = `acb_tok_${'b'.repeat(64)}`
const INVITATION_TOKEN = 'inv-token-should-not-be-logged-0123456789'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let co: string
const printed: string[] = []

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')) })
  }
  const { initDatabase } = await import('../../src/db')
  initDatabase()
  const { services } = await import('../../src/composition')
  co = (await services.companies.create(OWNER, 'Request Log', undefined)).id
  app = (await import('../../src/app')).app
  printed.length = 0
})

afterAll(() => {
  vi.restoreAllMocks()
})

async function send(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-test-user': OWNER }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const res: Response = await app.request(`http://acb.test${path}`, init)
  await res.arrayBuffer()
  return res
}

describe('request log', () => {
  it('prints no path, folder name, search term or token a request carried', async () => {
    const base = `/api/companies/${co}`
    const q = encodeURIComponent
    await send('GET', `${base}/files/content?path=${q(`営業部/${SECRET_FOLDER}/査定.md`)}`)
    await send('GET', `${base}/files/search?q=${q(SEARCH_TERM)}`)
    await send('GET', `${base}/folder-sizes?path=${q(`営業部/${SECRET_FOLDER}`)}`)
    await send('POST', `${base}/paths/check`, { paths: [`営業部/${SECRET_FOLDER}`] })
    await send('POST', `${base}/private-folders`, { parentPath: '営業部', name: SECRET_FOLDER })
    await send('GET', `${base}/no-such-route/${q(SECRET_FOLDER)}`)
    await send('GET', `/api/broker/gemini/v1beta/models?key=${RELAY_TOKEN}`)
    await send('GET', `/api/invitations/${INVITATION_TOKEN}`)

    const all = printed.join('\n')
    for (const secret of [SECRET_FOLDER, q(SECRET_FOLDER), SEARCH_TERM, q(SEARCH_TERM), '査定', RELAY_TOKEN, INVITATION_TOKEN, '?']) {
      expect(all, secret).not.toContain(secret)
    }
    expect(printed.filter(l => l.startsWith('[http] '))).toHaveLength(8)
  })

  it('an error during a request is logged without its text, with the request id', async () => {
    const { services } = await import('../../src/composition')
    // What lib/git-exec.ts throws when git fails: the command line and stderr name the paths.
    const gitFailure = () => Object.assign(
      new Error(`Command failed: git ls-tree main 営業部/${SECRET_FOLDER} (exit 128)\nfatal: Not a valid object name 営業部/${SECRET_FOLDER}`),
      { code: 128, stderr: `fatal: 営業部/${SECRET_FOLDER}` })
    vi.spyOn(services.companyFiles, 'build').mockRejectedValue(gitFailure())
    vi.spyOn(services.departments, 'list').mockRejectedValue(gitFailure())
    vi.spyOn(services.privateFolders, 'create').mockRejectedValue(gitFailure())
    const base = `/api/companies/${co}`
    const requests: Array<[string, string, unknown?]> = [
      ['GET', `${base}/files/tree`],
      ['GET', `${base}/departments`],
      ['POST', `${base}/private-folders`, { parentPath: '営業部', name: SECRET_FOLDER, force: true }],
    ]
    for (const [method, path, body] of requests) {
      printed.length = 0
      const res = await send(method, path, body)
      const all = printed.join('\n')
      expect(all, path).not.toContain(SECRET_FOLDER)
      expect(all, path).not.toContain('Command failed')
      const errorLine = printed.find(l => !l.startsWith('[http] '))
      expect(errorLine, path).toBeDefined()
      expect(errorLine, path).toContain(`exit=128 request=${res.headers.get('X-Request-Id')}`)
    }
  })

  it('prints the request id (also returned as X-Request-Id), method, route pattern, status, duration, company and user', async () => {
    printed.length = 0
    const res = await send('GET', `/api/companies/${co}/files/search?q=${encodeURIComponent(SEARCH_TERM)}`)
    const id = res.headers.get('X-Request-Id')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const line = printed.find(l => l.startsWith('[http] '))!
    expect(line).toMatch(new RegExp(`^\\[http\\] ${id} GET /api/companies/:companyId/files/search ${res.status} \\d+ms company=${co} user=${OWNER}$`))

    // A response the handler built itself (git over HTTP) carries the id too.
    printed.length = 0
    const git = await send('GET', `/api/git-http/${co}.git/info/refs?service=git-upload-pack`)
    expect(git.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(printed.find(l => l.startsWith('[http] '))).toContain(`GET /api/git-http/:repo/info/refs ${git.status}`)
  })
})
