/**
 * The request log's breakdown (server.md "Request log"): `db=` is the time the
 * request itself spent inside SQLite — not another request's, not counted twice
 * for a statement inside a transaction —, `git=` counts overlapping git
 * processes once, and `app=` prints only a well-formed build. These numbers
 * decide where stage 1+ of reducing the apps' polling cuts, so a wrong one
 * would send the work to the wrong place.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { requestLog, requestOperations, takeServerLoadCounters } from '../../src/lib/request-log'
import { timeSqliteCalls } from '../../src/adapters/sqlite/timing'
import { gitAsync } from '../../src/lib/git-exec'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// A query that keeps SQLite busy for a while (a few hundred ms).
const SLOW_SQL = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) SELECT count(*) AS n FROM c'

let db: Database.Database
const lines: string[] = []
const app = new Hono()
let slowQueryMs = 0
let transactionMs = 0

function field(line: string, name: string): number | undefined {
  const m = new RegExp(` ${name}=([0-9.]+)(?: |$)`).exec(line)
  return m ? Number(m[1]) : undefined
}

async function call(path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await app.request(`http://acb.test${path}`, { headers })
  const id = res.headers.get('X-Request-Id')
  return lines.find(l => l.includes(` ${id} `))!
}

beforeAll(() => {
  timeSqliteCalls(requestOperations)
  db = new Database(':memory:')
  app.use('*', requestLog(line => lines.push(line)))
  app.get('/slow-query', (c) => {
    const t0 = performance.now()
    db.prepare(SLOW_SQL).get()
    slowQueryMs = performance.now() - t0
    return c.json({ ok: true })
  })
  app.get('/slow-transaction', (c) => {
    const t0 = performance.now()
    db.transaction(() => db.prepare(SLOW_SQL).get())()
    transactionMs = performance.now() - t0
    return c.json({ ok: true })
  })
  app.get('/waits', async (c) => {
    await sleep(Number(c.req.query('ms') ?? 50))
    return c.json({ ok: true })
  })
  app.get('/two-git', async (c) => {
    // A: 0–120 ms, B: 40–160 ms → at least one running for ~160 ms, not 240.
    const endA = requestOperations.start('git')
    await sleep(40)
    const endB = requestOperations.start('git')
    await sleep(80)
    endA()
    await sleep(40)
    endB()
    endB() // a second end changes nothing
    return c.json({ ok: true })
  })
  app.get('/real-git', async (c) => {
    await gitAsync(['--version'])
    return c.json({ ok: true })
  })
})

describe('request log: where the time went', () => {
  it('db= is the time spent inside SQLite for this request', async () => {
    const line = await call('/slow-query')
    expect(slowQueryMs).toBeGreaterThan(20)
    const db = field(line, 'db')!
    expect(db).toBeGreaterThanOrEqual(slowQueryMs * 0.9)
    expect(db).toBeLessThanOrEqual(slowQueryMs + 1)
    expect(line).not.toContain('git=')
    expect(line).not.toContain('ext=')
  })

  it('a statement inside a transaction is counted once', async () => {
    const line = await call('/slow-transaction')
    expect(field(line, 'db')!).toBeLessThanOrEqual(transactionMs + 1)
    expect(field(line, 'db')!).toBeGreaterThanOrEqual(transactionMs * 0.9)
  })

  it('another request\'s SQLite time while this one waits is not this one\'s', async () => {
    const waiting = call('/waits?ms=150')
    await sleep(10)
    await call('/slow-query')
    const line = await waiting
    expect(slowQueryMs).toBeGreaterThan(20)
    expect(field(line, 'db')!).toBeLessThan(5)
  })

  it('overlapping git operations count once (union, not sum)', async () => {
    const line = await call('/two-git')
    const git = field(line, 'git')!
    expect(git).toBeGreaterThanOrEqual(150)
    expect(git).toBeLessThan(220)
  })

  it('a git process the server runs counts as git=', async () => {
    const line = await call('/real-git')
    expect(field(line, 'git')!).toBeGreaterThan(0)
  })

  it('the server-wide counters see requests and SQLite time, and start over when taken', async () => {
    takeServerLoadCounters()
    await call('/slow-query')
    const taken = takeServerLoadCounters()
    expect(taken.requests).toBe(1)
    expect(taken.busyMs.db).toBeGreaterThanOrEqual(slowQueryMs * 0.9)
    expect(takeServerLoadCounters()).toEqual({ requests: 0, busyMs: { db: 0, git: 0, ext: 0 } })
  })

  it('app= prints a well-formed desktop build and nothing else a client sends', async () => {
    const good = await call('/waits?ms=1', { 'X-ACB-Client-Version': '0.0.1+95346af.20261021031200' })
    expect(good).toMatch(/ app=0\.0\.1\+95346af\.20261021031200$/)
    for (const bad of ['山田太郎', 'yamada@example.com', '0.0.1 /Users/yamada/人事', `0.0.1+${'a'.repeat(90)}`]) {
      const line = await call('/waits?ms=1', { 'X-ACB-Client-Version': encodeURI(bad) === bad ? bad : encodeURIComponent(bad) })
      expect(line, bad).not.toContain('app=')
      expect(line, bad).not.toContain('yamada')
    }
  })
})
