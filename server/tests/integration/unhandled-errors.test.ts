/**
 * Integration Test: an error no route handled (app.ts onError) gets one fixed
 * answer, 500 { error, code: 'INTERNAL' }, with no message or stack, and its
 * log line (lib/error-log.ts) holds the error's kind and the request id — never
 * the message, which here quotes a private folder's name and the request body
 * the way a git or parse error can. Answers a route gives itself are unchanged.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const SECRET_FOLDER = '人事評価_極秘'
const SECRET_BODY = 'body-text-should-not-be-logged-0123'

vi.mock('../../src/lib/auth', async () => {
  const Database = (await import('better-sqlite3')).default
  const { join } = await import('path')
  return {
    authDb: new Database(join(process.env.DATA_DIR!, 'auth.sqlite')),
    // `x-test-fail`: fail the way a git or database call can, quoting a path and what was sent.
    getUserFromRequest: vi.fn().mockImplementation(async (req: Request) => {
      if (req.headers.get('x-test-fail')) {
        const sent = req.method === 'GET' ? '' : await req.clone().text()
        const err = new Error(`git ls-tree failed for 営業部/${SECRET_FOLDER}: ${sent}`) as Error & { code?: number }
        err.code = 128
        throw err
      }
      const id = req.headers.get('x-test-user')
      return id ? { id, email: `${id}@example.com`, name: id, image: null, emailVerified: true } : null
    }),
    getUsersByIds: vi.fn().mockImplementation(() => new Map()),
    auth: {
      handler: vi.fn().mockImplementation(async () => new Response('{}', { status: 200 })),
      api: { getSession: vi.fn().mockResolvedValue(null) },
    },
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
const printed: string[] = []

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')) })
  }
  const { initDatabase } = await import('../../src/db')
  initDatabase()
  app = (await import('../../src/app')).app
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('errors no route handled', () => {
  it('a handler that throws answers the fixed 500, and the log line has no message or body', async () => {
    printed.length = 0
    const res: Response = await app.request('http://acb.test/api/companies', {
      method: 'POST',
      headers: { 'x-test-fail': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SECRET_BODY }),
    })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'サーバーでエラーが起きました', code: 'INTERNAL' })
    expect(text).not.toContain(SECRET_FOLDER)
    expect(text).not.toContain('at ')

    const requestId = res.headers.get('x-request-id')
    expect(requestId).toBeTruthy()
    const line = printed.find(l => l.startsWith('[http] Unhandled error in a request:'))
    expect(line).toBeDefined()
    expect(line!.split('\n')[0]).toBe(`[http] Unhandled error in a request: Error exit=128 request=${requestId}`)
    const all = printed.join('\n')
    expect(all).not.toContain(SECRET_FOLDER)
    expect(all).not.toContain(SECRET_BODY)
    expect(all).not.toContain('git ls-tree')
    // The request line still records the 500 under the same id.
    expect(printed.some(l => l.includes(requestId!) && / 500 /.test(l))).toBe(true)
  })

  it('a route\'s own answers are unchanged (signed out: 401 from the guard)', async () => {
    const res: Response = await app.request('http://acb.test/api/me')
    expect(res.status).toBe(401)
    expect(await res.json()).not.toHaveProperty('code', 'INTERNAL')
  })

  it('an unknown path answers a JSON 404', async () => {
    const res: Response = await app.request('http://acb.test/api/no-such-endpoint')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
  })
})
