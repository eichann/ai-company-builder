/**
 * The operator's runs of 「ブラウザ操作」 (services/browser-runs.ts; agent-browser.md "The operator's window tools"), against a
 * real database with the real PC registrations and site grants. Guards: the PC (unregistered, pending, another PC of the
 * member), the company's setting, an unregistered domain, the AI stop, a person at 使わない, another company; the lock —
 * one running run per company × domain, freed by finish, a refusal, leaving, the lease and the run's limit; the log holds
 * page patterns and labels only (no value can be stored), once, append-only; who sees which runs.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sha256TokenDigest } from '../../src/adapters/system'
import { createBrowserSiteGrants, type BrowserSiteGrants } from '../../src/services/browser-site-grants'
import { createBrowserDeviceService, type BrowserDeviceService } from '../../src/services/browser-devices'
import { createBrowserRunService, type BrowserRunService } from '../../src/services/browser-runs'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { Member } from '../../src/services/access'
import type { Refusal } from '../../src/services/outcome'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import { BROWSER_RUN_LIMITS, browserRunAddressPattern, browserRunLabel, browserRunLogProblem } from '../../../shared/core/browser-run-log'
import { BROWSER_RUN_BUDGETS } from '../../../shared/core/browser-run-budget'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const OLD_BROWSER_RUNS = `CREATE TABLE IF NOT EXISTS browser_runs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('running', 'done', 'stopped', 'failed', 'timed_out', 'refused', 'left')),
      reason TEXT,
      started_at TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      ended_at TEXT,
      log_written INTEGER NOT NULL DEFAULT 0 CHECK (log_written IN (0, 1)),
      PRIMARY KEY (company_id, id),
      CHECK ((state = 'running') = (ended_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_runs_lock ON browser_runs(company_id, host) WHERE state = 'running';
    CREATE INDEX IF NOT EXISTS idx_browser_runs_started ON browser_runs(company_id, started_at);
    CREATE TRIGGER IF NOT EXISTS browser_runs_fixed BEFORE UPDATE ON browser_runs
      WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id OR NEW.user_id IS NOT OLD.user_id OR NEW.host IS NOT OLD.host
        OR NEW.device_id IS NOT OLD.device_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.started_at IS NOT OLD.started_at
        OR (OLD.state <> 'running' AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.ended_at IS NOT OLD.ended_at OR NEW.lease_until IS NOT OLD.lease_until))
        OR (OLD.log_written = 1 AND NEW.log_written <> 1)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run only moves from running, once');
    END;`
const CO = 'co-1'
const OTHER_CO = 'co-2'
const HOST = 'shop.example.com'
const OTHER_HOST = 'tickets.example.net'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }

let conn: Database.Database
let data: CompanyDataSource
let now: number
let policies: Record<string, BrowserOperationSettings>
let stops: Record<string, { all: boolean; tools: string[] }>
let grants: BrowserSiteGrants
let dev: BrowserDeviceService
let runs: BrowserRunService
let keys: Record<string, string>
const iso = (ms: number) => new Date(ms).toISOString()
const site = (host: string, level: 'read' | 'write' | 'delete') => ({ host, level, assetHosts: [] })
const newKey = () => `v1.${randomBytes(32).toString('base64url')}`
const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }

function join(companyId: string, userId: string, role: string) {
  const at = iso(T0 - 3_600_000)
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
function value<T>(r: { ok: true; value: T } | Refusal): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const refusal = (r: { ok: boolean; kind?: string; body?: { code?: unknown } }) => (r.ok ? 'ok' : `${r.kind}:${r.body?.code ?? ''}`)

/** A PC registered and enabled for this member (by the owner). */
function enabledPc(m: Member): string {
  const key = newKey()
  value(dev.register(m, key, { label: 'PC' }))
  const list = value(dev.list({ ...owner, companyId: m.companyId, userId: m.companyId === CO ? owner.userId : otherOwner.userId }))
  const id = list.items.find(d => d.userId === m.userId && d.state === 'pending')!.id
  value(dev.enable({ ...owner, companyId: m.companyId, userId: m.companyId === CO ? owner.userId : otherOwner.userId }, id))
  return key
}
const start = (m: Member, host = HOST, key: string | undefined = keys[m.userId]) => runs.start(m, { host }, key)
const runRow = (id: string) => conn.prepare('SELECT state, reason FROM browser_runs WHERE id = ?').get(id) as { state: string; reason: string | null }

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner'); join(OTHER_CO, alice.userId, 'member')
  now = T0
  policies = {
    [CO]: { mode: 'on', sites: [site(HOST, 'read'), site(OTHER_HOST, 'write')] },
    [OTHER_CO]: { mode: 'on', sites: [site(OTHER_HOST, 'read')] },
  }
  stops = {}
  data = sqliteCompanyData(conn)
  const clock = { now: () => iso(now), nowMs: () => now }
  const transactions = sqliteTransactions(conn)
  dev = createBrowserDeviceService({ companyData: data, transactions, clock, ids, tokenDigest: sha256TokenDigest, accounts: { byIds: list => new Map(list.map(id => [id, { name: id, email: `${id}@example.com` }])) } })
  grants = createBrowserSiteGrants({ companyData: data, clock, memberships: sqliteMembershipRepository(conn), browserPolicy: m => policies[m.companyId] })
  runs = createBrowserRunService({
    companyData: data, transactions, clock, ids, browserPolicy: m => policies[m.companyId],
    aiStops: m => stops[m.companyId] ?? { all: false, tools: [] }, devices: dev.gate, siteGrants: grants,
  })
  keys = { [alice.userId]: enabledPc(alice), [bob.userId]: enabledPc(bob), [admin.userId]: enabledPc(admin) }
})

describe('starting a run: the server decides', () => {
  it('a member with an enabled PC at 見るだけ on a registered domain starts one, holding the lease', () => {
    const r = value(start(alice))
    expect(r.runId).toMatch(/^bo_[0-9a-f]{32}$/)
    expect(r.leaseMs).toBe(BROWSER_RUN_LIMITS.leaseMs)
    expect(runRow(r.runId)).toEqual({ state: 'running', reason: null })
  })

  it('a PC not registered, pending, or no key at all (a member) → refused, nothing held', () => {
    expect(refusal(start(alice, HOST, newKey()))).toBe('forbidden:BROWSER_DEVICE_NOT_REGISTERED')
    const pending = newKey()
    value(dev.register(alice, pending, { label: 'new' }))
    expect(refusal(start(alice, HOST, pending))).toBe('forbidden:BROWSER_DEVICE_PENDING')
    expect(refusal(runs.start(alice, { host: HOST }, undefined))).toBe('forbidden:BROWSER_DEVICE_NOT_REGISTERED')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_runs').get()).toEqual({ n: 0 })
  })

  it('the company off, the member\'s domain not registered, a spelling other than the registered one → BROWSER_NOT_ALLOWED', () => {
    expect(refusal(start(alice, 'other.example.org'))).toBe('conflict:BROWSER_NOT_ALLOWED')
    expect(refusal(start(alice, 'SHOP.example.com'))).toBe('conflict:BROWSER_NOT_ALLOWED')
    policies[CO] = { ...policies[CO], mode: 'off' }
    expect(refusal(start(alice))).toBe('conflict:BROWSER_NOT_ALLOWED')
  })

  it('the AI stopped (whole, web) → BROWSER_AI_STOPPED', () => {
    stops[CO] = { all: true, tools: [] }
    expect(refusal(start(alice))).toBe('conflict:BROWSER_AI_STOPPED')
    stops[CO] = { all: false, tools: ['web'] }
    expect(refusal(start(alice))).toBe('conflict:BROWSER_AI_STOPPED')
  })

  it('a person at 使わない → BROWSER_TYPE_NOT_GRANTED; 見るだけ is enough (nothing writes)', () => {
    value(grants.set(owner, alice.userId, { host: HOST, level: 'none' }))
    expect(refusal(start(alice))).toBe('forbidden:BROWSER_TYPE_NOT_GRANTED')
    value(grants.set(owner, alice.userId, { host: HOST, level: 'read' }))
    expect(start(alice).ok).toBe(true)
  })

  it('another company: its domain is not this company\'s, and this company\'s PC is not the other\'s', () => {
    // OTHER_HOST is registered by both; alice's key is registered in CO only.
    expect(refusal(runs.start({ ...alice, companyId: OTHER_CO }, { host: OTHER_HOST }, keys[alice.userId]))).toBe('forbidden:BROWSER_DEVICE_NOT_REGISTERED')
    const r = value(start(alice, OTHER_HOST))
    // The other company's owner cannot see or touch it.
    expect(refusal(runs.continue(otherOwner, r.runId, undefined))).toBe('not-found:BROWSER_RUN_NOT_FOUND')
    expect(refusal(runs.finish(otherOwner, r.runId, { outcome: 'done', steps: [] }))).toBe('not-found:BROWSER_RUN_NOT_FOUND')
    expect(value(runs.list(otherOwner)).runs).toEqual([])
  })

  it('a bad body → BROWSER_BAD_RUN', () => {
    for (const body of [null, {}, { host: 1 }, { host: HOST, extra: 1 }, { host: HOST, conversationId: '../x' }]) {
      expect(refusal(runs.start(alice, body, keys[alice.userId]))).toBe('bad-request:BROWSER_BAD_RUN')
    }
  })
})

describe('the lock: one run per company × domain', () => {
  it('a second run on the same domain is refused (whoever starts it); another domain or another company is free', () => {
    const first = value(start(alice))
    expect(refusal(start(bob))).toBe('conflict:BROWSER_RUN_BUSY')
    expect(refusal(start(alice))).toBe('conflict:BROWSER_RUN_BUSY')
    expect(start(bob, OTHER_HOST).ok).toBe(true)
    // Released by finishing.
    value(runs.finish(alice, first.runId, { outcome: 'done', steps: [] }))
    expect(start(bob).ok).toBe(true)
  })

  it('the database itself refuses a second running row (the index is the lock, not the service)', () => {
    value(start(alice))
    expect(() => conn.prepare("INSERT INTO browser_runs (company_id, id, user_id, host, state, started_at, lease_until) VALUES (?, 'bo_x', 'u-bob', ?, 'running', ?, ?)")
      .run(CO, HOST, iso(now), iso(now))).toThrow(/UNIQUE/)
  })

  it('a crashed run frees the domain once its lease runs out; a renewed one keeps it, up to the run\'s limit', () => {
    const r = value(start(alice))
    now += BROWSER_RUN_LIMITS.leaseMs - 1
    expect(refusal(start(bob))).toBe('conflict:BROWSER_RUN_BUSY')
    value(runs.continue(alice, r.runId, keys[alice.userId]))
    now += BROWSER_RUN_LIMITS.leaseMs - 1
    expect(refusal(start(bob))).toBe('conflict:BROWSER_RUN_BUSY')
    now += 1
    const second = value(start(bob))
    expect(runRow(r.runId)).toEqual({ state: 'timed_out', reason: 'timeout' })
    // Renewing never goes past the run's limit.
    const secondAt = now
    let ended = false
    for (let i = 0; i < 20 && !ended; i++) {
      now += BROWSER_RUN_LIMITS.leaseMs / 2
      const c = runs.continue(bob, second.runId, keys[bob.userId])
      if (!c.ok) { expect(refusal(c)).toBe('conflict:BROWSER_RUN_ENDED'); ended = true }
    }
    expect(ended).toBe(true)
    expect(now - secondAt).toBeLessThanOrEqual(BROWSER_RUN_BUDGETS.standard.runMs + BROWSER_RUN_LIMITS.leaseMs / 2)
    expect(runRow(second.runId).state).toBe('timed_out')
  })

  it('leaving the company ends their running run and frees the domain', () => {
    const r = value(start(alice))
    runs.memberLeft(CO, alice.userId)
    expect(runRow(r.runId).state).toBe('left')
    expect(start(bob).ok).toBe(true)
  })

  it('a state never moves once final (trigger)', () => {
    const r = value(start(alice))
    value(runs.finish(alice, r.runId, { outcome: 'done', steps: [] }))
    expect(() => conn.prepare("UPDATE browser_runs SET state = 'running', ended_at = NULL WHERE id = ?").run(r.runId)).toThrow(/only moves/)
  })
})

describe('a run\'s budget of steps (shared/core/browser-run-budget.ts)', () => {
  it('a standard run gets its 20 steps: the next continue ends it (timed_out, rounds) and frees the domain', () => {
    const r = value(start(alice))
    expect(r.budget).toBe('standard')
    for (let i = 0; i < BROWSER_RUN_BUDGETS.standard.steps; i++) value(runs.continue(alice, r.runId, keys[alice.userId]))
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('conflict:BROWSER_RUN_ENDED')
    expect(runRow(r.runId)).toEqual({ state: 'timed_out', reason: 'rounds' })
    expect(start(bob).ok).toBe(true)
  })

  it('a database from before the budget: its running row reads as standard, and the trigger now keeps the budget', () => {
    const before = new Database(':memory:')
    // browser_runs as the build before this one made it (origin/main 7f6dcfc2), with a running row.
    before.exec(`${OLD_BROWSER_RUNS}`)
    before.pragma('foreign_keys = OFF')
    before.prepare("INSERT INTO browser_runs (company_id, id, user_id, host, state, started_at, lease_until) VALUES ('co-1', 'bo_old', 'u', ?, 'running', ?, ?)").run(HOST, iso(now), iso(now))
    initDatabase(before)
    initDatabase(before)
    expect(before.prepare("SELECT budget, steps FROM browser_runs WHERE id = 'bo_old'").get()).toEqual({ budget: 'standard', steps: 0 })
    expect(() => before.prepare("UPDATE browser_runs SET budget = 'skill' WHERE id = 'bo_old'").run()).toThrow(/only moves from running/)
    // A new database ends with the same table and trigger.
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    const shape = (c: Database.Database) => c.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'browser_runs' ORDER BY type, name").all()
    expect(shape(before)).toEqual(shape(fresh))
  })
})

describe('every step asks again (continue)', () => {
  it('the AI stopped mid-run → refused, the run ends, the domain is free', () => {
    const r = value(start(alice))
    stops[CO] = { all: true, tools: [] }
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('conflict:BROWSER_AI_STOPPED')
    expect(runRow(r.runId)).toEqual({ state: 'refused', reason: 'ai-stopped' })
    stops[CO] = { all: false, tools: [] }
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('conflict:BROWSER_RUN_ENDED')
    expect(start(bob).ok).toBe(true)
  })

  it('the person lowered to 使わない, the setting off, the PC stopped, or another PC of theirs → refused and ended', () => {
    let r = value(start(alice))
    value(grants.set(owner, alice.userId, { host: HOST, level: 'none' }))
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('forbidden:BROWSER_TYPE_NOT_GRANTED')
    expect(runRow(r.runId).reason).toBe('not-granted')
    value(grants.set(owner, alice.userId, { host: HOST, level: 'read' }))

    r = value(start(alice))
    policies[CO] = { mode: 'off', sites: policies[CO].sites }
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('conflict:BROWSER_NOT_ALLOWED')
    expect(runRow(r.runId).reason).toBe('setting')
    policies[CO] = { mode: 'on', sites: policies[CO].sites }

    r = value(start(alice))
    const second = enabledPc(alice)
    expect(refusal(runs.continue(alice, r.runId, second))).toBe('conflict:BROWSER_DEVICE_ELSEWHERE')
    expect(runRow(r.runId).reason).toBe('device')

    r = value(start(alice))
    value(dev.withdraw(alice, keys[alice.userId]))
    expect(refusal(runs.continue(alice, r.runId, keys[alice.userId]))).toBe('forbidden:BROWSER_DEVICE_REVOKED')
    expect(runRow(r.runId).state).toBe('refused')
  })

  it('only the run\'s own member may continue or finish it', () => {
    const r = value(start(alice))
    expect(refusal(runs.continue(bob, r.runId, keys[bob.userId]))).toBe('not-found:BROWSER_RUN_NOT_FOUND')
    expect(refusal(runs.finish(owner, r.runId, { outcome: 'done', steps: [] }))).toBe('not-found:BROWSER_RUN_NOT_FOUND')
    expect(refusal(runs.continue(alice, 'bo_nope', keys[alice.userId]))).toBe('not-found:BROWSER_RUN_NOT_FOUND')
  })
})

describe('the run log: what was done, never with what', () => {
  const steps = [
    { page: '/orders?page&q', action: 'type', label: '検索' },
    { page: '/orders?page&q', action: 'click', label: '検索する' },
    { page: '/orders/{n}', action: 'click', label: null },
    { page: '/orders/{n}', action: 'back', label: null },
  ]

  it('kept with the run, once; the member sees their own, owners / admins everyone\'s', () => {
    const r = value(start(alice))
    expect(value(runs.finish(alice, r.runId, { outcome: 'done', steps }))).toEqual({ state: 'done' })
    expect(refusal(runs.finish(alice, r.runId, { outcome: 'done', steps }))).toBe('conflict:BROWSER_RUN_ENDED')
    const b = value(start(bob, OTHER_HOST))
    value(runs.finish(bob, b.runId, { outcome: 'stopped', reason: 'need-person', steps: [] }))
    expect(value(runs.list(alice)).runs.map(x => [x.id, x.state, x.steps])).toEqual([[r.runId, 'done', steps]])
    for (const m of [owner, admin]) expect(value(runs.list(m)).runs.map(x => x.id).sort()).toEqual([r.runId, b.runId].sort())
    expect(value(runs.list(bob)).runs.map(x => [x.state, x.reason])).toEqual([['stopped', 'need-person']])
    expect(() => conn.prepare("UPDATE browser_run_log SET label = 'x'").run()).toThrow(/append-only/)
    expect(() => conn.prepare('DELETE FROM browser_run_log').run()).toThrow(/append-only/)
    // Once, even when the first log was empty.
    const e = value(start(alice))
    value(runs.finish(alice, e.runId, { outcome: 'stopped', steps: [] }))
    expect(refusal(runs.finish(alice, e.runId, { outcome: 'done', steps }))).toBe('conflict:BROWSER_RUN_ENDED')
    expect(value(runs.list(alice)).runs.find(x => x.id === e.runId)?.steps).toEqual([])
  })

  it('a step that could carry a value is refused whole: nothing stored', () => {
    const r = value(start(alice))
    const bad = [
      [{ page: '/orders/12345', action: 'click', label: null }],
      [{ page: '/orders?q=山田', action: 'click', label: null }],
      [{ page: '/customers/tanaka.taro', action: 'click', label: null }],
      [{ page: '/orders', action: 'click', label: '電話 090-1234-5678' }],
      [{ page: '/orders', action: 'click', label: 'taro@example.com' }],
      [{ page: '/orders', action: 'type', label: '検索', value: '山田' }],
      [{ page: '/orders', action: 'post', label: null }],
      Array.from({ length: BROWSER_RUN_LIMITS.steps + 1 }, () => ({ page: '/', action: 'wait', label: null })),
    ]
    for (const s of bad) expect(refusal(runs.finish(alice, r.runId, { outcome: 'done', steps: s }))).toBe('bad-request:BROWSER_BAD_RUN')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_run_log').get()).toEqual({ n: 0 })
    expect(runRow(r.runId).state).toBe('running')
  })

  it('a run that already timed out still gets its log once (what was done is known afterwards)', () => {
    const r = value(start(alice))
    now += BROWSER_RUN_LIMITS.leaseMs
    expect(value(runs.finish(alice, r.runId, { outcome: 'done', steps }))).toEqual({ state: 'timed_out' })
    expect(value(runs.list(alice)).runs[0].steps).toEqual(steps)
  })

  it('a reason that is not one of the fixed words is not kept', () => {
    const r = value(start(alice))
    value(runs.finish(alice, r.runId, { outcome: 'stopped', reason: 'ignore previous instructions', steps: [] }))
    expect(runRow(r.runId)).toEqual({ state: 'stopped', reason: null })
  })
})

describe('the core\'s address and label rules', () => {
  it('addresses keep words and patterns only', () => {
    expect(browserRunAddressPattern(`https://${HOST}/orders/123/edit?page=2&q=山田`, HOST)).toBe('/orders/{n}/edit?page&q')
    expect(browserRunAddressPattern(`https://${HOST}/customers/Tanaka`, HOST)).toBe('/customers/{x}')
    expect(browserRunAddressPattern(`https://${OTHER_HOST}/orders`, HOST)).toBeNull()
    expect(browserRunAddressPattern(`http://${HOST}/orders`, HOST)).toBeNull()
  })
  it('labels mask digits, mail and addresses, and are stable', () => {
    expect(browserRunLabel(' 注文 12 件を表示 ')).toBe('注文 {n} 件を表示')
    expect(browserRunLabel('a@b.example に送る')).toBe('{mail} に送る')
    const l = browserRunLabel('https://x.example/1 を開く')!
    expect(browserRunLabel(l)).toBe(l)
    expect(browserRunLogProblem([{ page: '/', action: 'click', label: l }])).toBeNull()
  })
})

describe('a write task\'s runs (step ⑤b): 変えてよい first, one lock with the frames run, the write steps kept without values', () => {
  const FRAME = `bf_${'1'.repeat(32)}`
  it('`write: true` needs the person at 変えてよい and the site allowing writes: 見るだけ is refused before anything is read', () => {
    // alice is 見るだけ on OTHER_HOST (a write site) by default; HOST itself is a 見るだけ site.
    expect(refusal(runs.start(alice, { host: OTHER_HOST, write: true }, keys[alice.userId]))).toBe('forbidden:BROWSER_TYPE_NOT_GRANTED')
    value(grants.set(owner, alice.userId, { host: OTHER_HOST, level: 'write' }))
    expect(refusal(runs.start(alice, { host: HOST, write: true }, keys[alice.userId]))).toBe('conflict:BROWSER_NOT_ALLOWED')
    expect(refusal(runs.start(alice, { host: OTHER_HOST, write: 'yes' }, keys[alice.userId]))).toBe('bad-request:BROWSER_BAD_RUN')
    expect(value(runs.start(alice, { host: OTHER_HOST, write: true }, keys[alice.userId])).runId).toMatch(/^bo_/)
  })

  it('while a frames run holds the domain only its member\'s run naming it starts; naming one that holds nothing is refused', () => {
    let holder: { runId: string; userId: string } | 'busy' | null = { runId: FRAME, userId: alice.userId }
    runs = createBrowserRunService({
      companyData: data, transactions: sqliteTransactions(conn), clock: { now: () => iso(now), nowMs: () => now }, ids,
      browserPolicy: m => policies[m.companyId], aiStops: () => ({ all: false, tools: [] }), devices: dev.gate, siteGrants: grants,
      frameRunOn: () => holder,
    })
    expect(refusal(start(bob))).toBe('conflict:BROWSER_RUN_BUSY')
    expect(refusal(start(alice))).toBe('conflict:BROWSER_RUN_BUSY')
    expect(refusal(runs.start(bob, { host: HOST, frameRunId: FRAME }, keys[bob.userId]))).toBe('conflict:BROWSER_RUN_BUSY')
    expect(refusal(runs.start(alice, { host: HOST, frameRunId: `bf_${'2'.repeat(32)}` }, keys[alice.userId]))).toBe('conflict:BROWSER_RUN_BUSY')
    const started = value(runs.start(alice, { host: HOST, frameRunId: FRAME }, keys[alice.userId]))
    value(runs.finish(alice, started.runId, { outcome: 'done', steps: [] }))
    // An ended frames run's write may still be on its way: busy for everyone.
    holder = 'busy'
    expect(refusal(runs.start(alice, { host: HOST, frameRunId: FRAME }, keys[alice.userId]))).toBe('conflict:BROWSER_RUN_BUSY')
    holder = null
    expect(refusal(runs.start(alice, { host: HOST, frameRunId: FRAME }, keys[alice.userId]))).toBe('conflict:BROWSER_RUN_ENDED')
    expect(value(start(alice)).runId).toMatch(/^bo_/)
    // The frames run's start asks this side: a running operator run holds the domain.
    expect(runs.runningOn(CO, HOST)).toBe(true)
    expect(runs.runningOn(CO, OTHER_HOST)).toBe(false)
  })

  it('a run\'s write steps are kept and listed — the frame, method, path pattern and outcome only; a value anywhere refuses the whole finish', () => {
    const id = value(start(alice)).runId
    const write = { after: 0, frame: 1, method: 'POST', page: '/orders/{n}/note', outcome: 'done' }
    for (const bad of [
      [{ ...write, page: '/orders/88123/note' }], [{ ...write, body: 'x' }], [{ ...write, outcome: 'sent' }], [{ ...write, after: 2 }],
      [{ ...write, method: 'post' }], [{ ...write, frame: 0 }],
    ]) expect(refusal(runs.finish(alice, id, { outcome: 'done', steps: [], writes: bad }))).toBe('bad-request:BROWSER_BAD_RUN')
    value(runs.finish(alice, id, { outcome: 'done', steps: [], writes: [write, { ...write, frame: null, method: 'OTHER', page: '/autosave', outcome: 'refused' }] }))
    const listed = value(runs.list(alice)).runs.find(r => r.id === id)!
    expect(listed.writes).toEqual([write, { after: 0, frame: null, method: 'OTHER', page: '/autosave', outcome: 'refused' }])
    expect(() => conn.prepare("UPDATE browser_run_writes SET outcome = 'done'").run()).toThrow(/append-only/)
    expect(() => conn.prepare('DELETE FROM browser_run_writes').run()).toThrow(/append-only/)
  })
})
