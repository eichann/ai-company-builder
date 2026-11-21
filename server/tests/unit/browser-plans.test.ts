/**
 * 「ブラウザ操作」 plans on the server (services/browser-plans.ts; agent-browser.md "Plans, executions,
 * permits and locks"; internal design memo §30–§31), against a real database and the real approved
 * combination (shared/browser-connectors/approved.json), with the server's clock in the test's hand.
 *
 * Guards: every row of the plan and execution state tables; one claim, one permit, one confirm (the
 * second always loses); the permit's checks in its transaction (combination, setting, stop, grant,
 * lock, time); the time-outs judged on every touch; confirm only after permit + 5 s + 30 s and never
 * with the clock behind the permit; succeeded only with the secret from permitted / unknown, failed
 * only from permitted; late, duplicate and contradicting reports; the target lock (taken with the
 * claim, released only by the execution that holds it, only on a final state); leaving the company;
 * an unknown or retired combination; the facts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteBrowserExecutionLookup } from '../../src/adapters/sqlite/browser-plans'
import { fileBrowserConnectorCatalog } from '../../src/adapters/browser-connector-catalog'
import { sha256TokenDigest } from '../../src/adapters/system'
import { hashCanonical } from '../../src/lib/content-hash'
import { createBrowserPlanService, type BrowserPlanService } from '../../src/services/browser-plans'
import type { ApprovedCombinationRow, BrowserPlanRepository } from '../../src/ports/browser-plans'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import type { Member } from '../../src/services/access'

const T0 = Date.parse('2026-11-21T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const admin: Member = { companyId: CO, userId: 'u-admin', role: 'admin' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
// The current Lステップ row (written `pending` until a reviewed edit approves it, design memo §33.5), as approved.
const APPROVED: ApprovedCombinationRow = { ...fileBrowserConnectorCatalog().combinations().find(r => r.status !== 'retired')!, status: 'approved' }
const OP = 'reminder_step_add_template'
const SITE = { host: 'manager.linestep.net', level: 'write' as const, assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }

let conn: Database.Database
let now: number
let rows: ApprovedCombinationRow[]
let policy: BrowserOperationSettings
let stops: { all: boolean; tools: string[] }
let svc: BrowserPlanService
let data: CompanyDataSource

const iso = (ms: number) => new Date(ms).toISOString()

function build() {
  data = sqliteCompanyData(conn)
  svc = createBrowserPlanService({
    companyData: data, transactions: sqliteTransactions(conn),
    clock: { now: () => iso(now), nowMs: () => now },
    ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') },
    tokenDigest: sha256TokenDigest, catalog: { combinations: () => rows }, executionLookup: sqliteBrowserExecutionLookup(conn),
    memberships: sqliteMembershipRepository(conn), accounts: { byIds: () => new Map() } as never,
    browserPolicy: () => policy, aiStops: () => stops, log: { warn: () => {} },
  })
}

function join(companyId: string, userId: string, role: string, at = iso(T0 - 3_600_000)) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, at, at)
}
const leave = (companyId: string, userId: string) => { conn.prepare('DELETE FROM memberships WHERE company_id = ? AND user_id = ?').run(companyId, userId); svc.memberLeft(companyId, userId) }

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, admin.userId, 'admin'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  now = T0
  rows = [APPROVED]
  policy = { mode: 'on', sites: [SITE] }
  stops = { all: false, tools: [] }
  build()
  for (const m of [alice, bob]) grant(m)
})

function grant(m: Member, allowed = true) {
  const r = svc.setGrant(owner, m.userId, { connector: 'lstep', operation: OP, declarationHash: APPROVED.declarationHash, allowed })
  if (!r.ok) throw new Error(JSON.stringify(r.body))
}

const fact = (value: unknown) => ({ status: 'known', value, complete: true, readAt: iso(now), source: '/line/episode/show/11' })
function input(over: Record<string, unknown> = {}, target = { reminder: '11', step: '22' }) {
  return {
    connector: { id: 'lstep', version: APPROVED.version }, operation: OP,
    declarationHash: APPROVED.declarationHash, checkerHash: APPROVED.checkerHash, factsVersion: APPROVED.factsVersion,
    target, change: { template: '7' },
    facts: {
      account: fact({ id: 'acc1' }), step_parent: fact({ reminder: target.reminder }), state: fact({ templates: ['5'] }),
      names: fact({ reminder: 'リマインダ', step: '1日目' }), template_bodies: fact({ 5: '本文A', 7: '本文B' }),
      shared_with: fact({ count: 1, items: ['第1回'] }),
    },
    explanation: '7番のテンプレートを足します',
    ...over,
  }
}

function value<T>(r: { ok: true; value: T } | { ok: false; body: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)

function draft(m = alice, over: Record<string, unknown> = {}, target?: { reminder: string; step: string }) { return value(svc.register(m, input(over, target), undefined)) }
function approved(m = alice, target?: { reminder: string; step: string }) {
  const p = draft(m, {}, target)
  value(svc.approve(m, p.id, { contentHash: p.contentHash }, undefined))
  return p
}
function claimed(m = alice, target?: { reminder: string; step: string }) {
  const p = approved(m, target)
  return { plan: p, claim: value(svc.claim(m, p.id, undefined)) }
}
function permitted(m = alice, target?: { reminder: string; step: string }) {
  const c = claimed(m, target)
  value(svc.permit(m, c.claim.executionId, c.claim.secret, undefined))
  return c
}
const execState = (m: Member, planId: string) => value(svc.get(m, planId)).execution?.state
const lockHolder = (key: string) => (conn.prepare('SELECT execution_id FROM browser_target_locks WHERE company_id = ? AND lock_key = ?').get(CO, key) as { execution_id: string } | undefined)?.execution_id ?? null
const lockKeyOf = (executionId: string) => (conn.prepare('SELECT lock_key FROM browser_executions WHERE id = ?').get(executionId) as { lock_key: string }).lock_key

describe('registering a plan', () => {
  it('a candidate with facts becomes a draft whose content is fixed by a hash; the facts are kept as read', () => {
    const p = draft()
    expect(p).toMatchObject({ state: 'draft', account: 'acc1', target: { reminder: '11', step: '22' }, change: { template: '7' }, delivers: 'none', execution: null })
    expect(p.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(p.expiresAt).toBe(iso(T0 + 3_600_000))
    expect(p.facts.shared_with.value).toEqual({ count: 1, items: ['第1回'] })
    expect(p.sharedNote).toContain('共有のリマインダ')
    // The content never changes in the table (trigger).
    // Nor any column authorisation or the lock key reads.
    for (const [column, v] of [['content', '{}'], ['id', 'bp_x'], ['user_id', 'u-bob'], ['connector_id', 'other'], ['connector_version', '9.9.9'], ['operation', 'other'],
      ['declaration_hash', 'x'], ['checker_hash', 'x'], ['facts_version', 2], ['account', 'acc2'], ['content_hash', 'x'], ['created_at', 'x'], ['expires_at', 'x']] as const) {
      expect(() => conn.prepare(`UPDATE browser_plans SET ${column} = ? WHERE id = ?`).run(v, p.id), column).toThrow(/never changes/)
    }
    // The state may move.
    expect(conn.prepare("UPDATE browser_plans SET state = 'closed' WHERE id = ?").run(p.id).changes).toBe(1)
  })

  it('refuses a combination not approved (another checker, declaration or facts version) and a retired one', () => {
    expect(code(svc.register(alice, input({ checkerHash: `sha256:${'0'.repeat(64)}` }), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
    expect(code(svc.register(alice, input({ declarationHash: `sha256:${'1'.repeat(64)}` }), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
    expect(code(svc.register(alice, input({ factsVersion: 2 }), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
    expect(code(svc.register(alice, input({ connector: { id: 'lstep', version: '0.0.1' } }), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
    rows = [{ ...APPROVED, status: 'retired' }]; build()
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_RETIRED')
    // A row listed but not yet approved (design memo §33.5) accepts nothing.
    rows = [{ ...APPROVED, status: 'pending' }]; build()
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
    // A row whose declaration is not the one its hash names is not a combination at all.
    rows = [{ ...APPROVED, declaration: APPROVED.declaration.replace('delivers: none', 'delivers: unknown') }]; build()
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_NOT_APPROVED')
  })

  it('the first version runs no type that delivers at once, and none whose result cannot come true', () => {
    const variant = (from: string, to: string): ApprovedCombinationRow => {
      expect(APPROVED.declaration).toContain(from)
      const declaration = APPROVED.declaration.replace(from, to)
      return { ...APPROVED, declaration, declarationHash: hashCanonical(declaration) }
    }
    const delivering = variant('delivers: none', 'delivers: immediate')
    rows = [delivering]; build()
    expect(code(svc.register(alice, input({ declarationHash: delivering.declarationHash }), undefined))).toBe('BROWSER_OPERATION_NOT_YET')
    const removing = variant('add: "{template}"', 'remove: "{template}"')
    rows = [removing]; build()
    value(svc.setGrant(owner, alice.userId, { connector: 'lstep', operation: OP, declarationHash: removing.declarationHash, allowed: true }))
    // Removing template 7 from a step that holds only 5 cannot come true.
    expect(code(svc.register(alice, input({ declarationHash: removing.declarationHash }), undefined))).toBe('BROWSER_CANNOT_COME_TRUE')
  })

  it('a combination with a least app version refuses an older app and one that does not say', () => {
    rows = [{ ...APPROVED, minAppVersion: '0.0.2' }]; build()
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_APP_TOO_OLD')
    expect(code(svc.register(alice, input(), '0.0.1+abc1234.20261121000000'))).toBe('BROWSER_APP_TOO_OLD')
    expect(code(svc.register(alice, input(), '0.0.2+abc1234.20261121000000'))).toBe('ok')
  })

  it('refuses when the company setting, the site, its level, the AI stop or the member\'s grant does not allow it', () => {
    policy = { mode: 'off', sites: [SITE] }
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [] }
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [{ ...SITE, level: 'read' }] }
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_NOT_ALLOWED')
    policy = { mode: 'on', sites: [SITE] }
    for (const s of [{ all: true, tools: [] }, { all: false, tools: ['web'] }, { all: false, tools: ['mcp-external'] }]) {
      stops = s
      expect(code(svc.register(alice, input(), undefined)), JSON.stringify(s)).toBe('BROWSER_AI_STOPPED')
    }
    stops = { all: false, tools: ['command'] }
    expect(code(svc.register(alice, input(), undefined))).toBe('ok')
    stops = { all: false, tools: [] }
    expect(code(svc.register(owner, input(), undefined))).toBe('BROWSER_TYPE_NOT_GRANTED')
    grant(alice, false)
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_NOT_GRANTED')
  })

  it('a grant given before the member left and came back does not apply', () => {
    conn.prepare('UPDATE memberships SET created_at = ? WHERE user_id = ?').run(iso(T0 + 1), alice.userId)
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_NOT_GRANTED')
  })

  it('refuses missing, unknown, incomplete, stale or contradicting facts, and values that do not fit the type', () => {
    const facts = input().facts
    expect(code(svc.register(alice, input({ facts: { ...facts, shared_with: { status: 'unknown', readAt: iso(now), source: '/a' } } }), undefined))).toBe('BROWSER_FACTS_REFUSED')
    expect(code(svc.register(alice, input({ facts: { ...facts, state: { ...facts.state, complete: false } } }), undefined))).toBe('BROWSER_FACTS_REFUSED')
    const withoutNames: Record<string, unknown> = { ...facts }
    delete withoutNames.names
    expect(code(svc.register(alice, input({ facts: withoutNames }), undefined))).toBe('BROWSER_FACTS_REFUSED')
    expect(code(svc.register(alice, input({ facts: { ...facts, step_parent: fact({ reminder: '99' }) } }), undefined))).toBe('BROWSER_FACTS_REFUSED')
    expect(code(svc.register(alice, input({ facts: { ...facts, account: { ...facts.account, readAt: iso(now - 11 * 60_000) } } }), undefined))).toBe('BROWSER_FACTS_STALE')
    expect(code(svc.register(alice, input({ facts: { ...facts, account: { ...facts.account, readAt: iso(now + 2 * 60_000) } } }), undefined))).toBe('BROWSER_FACTS_STALE')
    expect(code(svc.register(alice, input({ target: { reminder: '11', step: '22', hole: '1' } }), undefined))).toBe('BROWSER_BAD_PLAN')
    expect(code(svc.register(alice, input({ change: { template: '../7' } }), undefined))).toBe('BROWSER_BAD_PLAN')
    expect(code(svc.register(alice, input({ verified: true }), undefined))).toBe('BROWSER_BAD_PLAN')
    expect(code(svc.register(alice, input({ conversationId: 'a b' }), undefined))).toBe('BROWSER_BAD_PLAN')
  })
})

describe('the plan\'s states (draft → approved → claimed → done, or closed)', () => {
  it('approve takes the content the person saw; another hash, a second approve or an approve after cancel are refused', () => {
    const p = draft()
    expect(code(svc.approve(alice, p.id, { contentHash: `sha256:${'2'.repeat(64)}` }, undefined))).toBe('CONTENT_CHANGED')
    expect(value(svc.approve(alice, p.id, { contentHash: p.contentHash }, undefined)).state).toBe('approved')
    expect(code(svc.approve(alice, p.id, { contentHash: p.contentHash }, undefined))).toBe('BROWSER_PLAN_NOT_DRAFT')
    const q = draft()
    expect(value(svc.cancel(alice, q.id)).state).toBe('closed')
    expect(code(svc.approve(alice, q.id, { contentHash: q.contentHash }, undefined))).toBe('BROWSER_PLAN_NOT_DRAFT')
    expect(code(svc.claim(alice, q.id, undefined))).toBe('BROWSER_PLAN_NOT_APPROVED')
  })

  it('only the plan\'s member sees and acts on it; another company\'s handle finds nothing', () => {
    const p = draft()
    for (const m of [bob, owner, admin, { ...alice, companyId: OTHER_CO }]) {
      expect(code(svc.get(m, p.id))).toBe('BROWSER_PLAN_NOT_FOUND')
      expect(code(svc.approve(m, p.id, { contentHash: p.contentHash }, undefined))).toBe('BROWSER_PLAN_NOT_FOUND')
      expect(code(svc.cancel(m, p.id))).toBe('BROWSER_PLAN_NOT_FOUND')
      expect(code(svc.claim(m, p.id, undefined))).toBe('BROWSER_PLAN_NOT_FOUND')
    }
  })

  it('a plan lives an hour from its creation: approving does not extend it; draft and approved close on the next touch', () => {
    const d = draft()
    const a = approved()
    now = T0 + 3_600_000
    expect(code(svc.approve(alice, d.id, { contentHash: d.contentHash }, undefined))).toBe('BROWSER_PLAN_EXPIRED')
    expect(code(svc.claim(alice, a.id, undefined))).toBe('BROWSER_PLAN_EXPIRED')
    expect(value(svc.get(alice, d.id))).toMatchObject({ state: 'closed', closeReason: 'expired' })
    now = T0 + 3_599_999
  })

  it('the checks are asked again at approve and at claim: a stop, a removed grant or a setting turned off refuse there', () => {
    const p = draft()
    stops = { all: true, tools: [] }
    expect(code(svc.approve(alice, p.id, { contentHash: p.contentHash }, undefined))).toBe('BROWSER_AI_STOPPED')
    stops = { all: false, tools: [] }
    value(svc.approve(alice, p.id, { contentHash: p.contentHash }, undefined))
    grant(alice, false)
    expect(code(svc.claim(alice, p.id, undefined))).toBe('BROWSER_TYPE_NOT_GRANTED')
    grant(alice)
    rows = [{ ...APPROVED, status: 'retired' }]; build()
    expect(code(svc.claim(alice, p.id, undefined))).toBe('BROWSER_TYPE_RETIRED')
    rows = [APPROVED]; build()
    expect(value(svc.claim(alice, p.id, undefined)).executionId).toMatch(/^bx_/)
  })

  it('claim is once per plan: the second claim (a lost answer asked again, another PC) gets no execution and no secret', () => {
    const p = approved()
    const first = value(svc.claim(alice, p.id, undefined))
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(first.plan).toMatchObject({ planId: p.id, account: 'acc1', before: { templates: ['5'] }, target: { reminder: '11', step: '22' }, change: { template: '7' } })
    expect(code(svc.claim(alice, p.id, undefined))).toBe('BROWSER_PLAN_NOT_APPROVED')
    expect((conn.prepare('SELECT COUNT(*) AS n FROM browser_executions').get() as { n: number }).n).toBe(1)
    // Only its hash is stored.
    expect(JSON.stringify(conn.prepare('SELECT * FROM browser_executions').all())).not.toContain(first.secret)
    expect(value(svc.get(alice, p.id)).state).toBe('claimed')
  })

  it('cancel: draft and approved close; a claimed execution without a permit becomes void and lets the target go; after a permit it is refused', () => {
    const { plan, claim } = claimed()
    const key = lockKeyOf(claim.executionId)
    expect(value(svc.cancel(alice, plan.id))).toMatchObject({ state: 'done', execution: { state: 'void', voidReason: 'cancelled' } })
    expect(lockHolder(key)).toBeNull()
    expect(code(svc.permit(alice, claim.executionId, claim.secret, undefined))).toBe('BROWSER_EXECUTION_CLOSED')
    const second = permitted()
    expect(code(svc.cancel(alice, second.plan.id))).toBe('BROWSER_MAY_HAVE_SENT')
    expect(execState(alice, second.plan.id)).toBe('permitted')
  })
})

describe('the target lock', () => {
  it('another plan for the same target cannot be claimed while an execution holds it (claimed, permitted, unknown); another target can', () => {
    const first = claimed()
    const other = approved()
    expect(code(svc.claim(alice, other.id, undefined))).toBe('BROWSER_TARGET_BUSY')
    // Refused as a whole: the plan stays approved, no second execution.
    expect(value(svc.get(alice, other.id)).state).toBe('approved')
    expect(code(svc.claim(alice, approved(alice, { reminder: '11', step: '23' }).id, undefined))).toBe('ok')
    // Even another member's plan for the same target and account.
    expect(code(svc.claim(bob, approved(bob).id, undefined))).toBe('BROWSER_TARGET_BUSY')
    value(svc.permit(alice, first.claim.executionId, first.claim.secret, undefined))
    now += 35_000
    expect(execState(alice, first.plan.id)).toBe('unknown')
    expect(code(svc.claim(alice, other.id, undefined))).toBe('BROWSER_TARGET_BUSY')
    value(svc.confirm(alice, first.claim.executionId, { result: 'not_done' }))
    expect(code(svc.claim(alice, other.id, undefined))).toBe('ok')
  })

  it('a claim left without a permit for 2 minutes becomes void when someone next touches the target, and lets it go', () => {
    const first = claimed()
    const key = lockKeyOf(first.claim.executionId)
    const other = approved()
    now += 119_999
    expect(code(svc.claim(alice, other.id, undefined))).toBe('BROWSER_TARGET_BUSY')
    now += 1
    const second = value(svc.claim(alice, other.id, undefined))
    expect(lockHolder(key)).toBe(second.executionId)
    expect(execState(alice, first.plan.id)).toBe('void')
    // The old execution can never be permitted now.
    expect(code(svc.permit(alice, first.claim.executionId, first.claim.secret, undefined))).toBe('BROWSER_EXECUTION_CLOSED')
  })

  it('is released only by the execution that holds it', () => {
    const a = claimed()
    const key = lockKeyOf(a.claim.executionId)
    data.forCompany(CO).browserPlans.releaseLock(key, 'bx_someone_else')
    expect(lockHolder(key)).toBe(a.claim.executionId)
    // Another company's handle reaches nothing.
    data.forCompany(OTHER_CO).browserPlans.releaseLock(key, a.claim.executionId)
    expect(lockHolder(key)).toBe(a.claim.executionId)
  })
})

describe('the send permit', () => {
  it('is given once: claimed → permitted; asking again is not a new permit', () => {
    const { plan, claim } = claimed()
    const p = value(svc.permit(alice, claim.executionId, claim.secret, undefined))
    expect(p).toEqual({ permittedAt: iso(now), validMs: 5000 })
    expect(code(svc.permit(alice, claim.executionId, claim.secret, undefined))).toBe('BROWSER_PERMIT_USED')
    expect(execState(alice, plan.id)).toBe('permitted')
  })

  it('needs the execution\'s secret and its member: another secret, another member or another company finds nothing', () => {
    const { claim } = claimed()
    const other = claimed(alice, { reminder: '12', step: '22' })
    expect(code(svc.permit(alice, claim.executionId, other.claim.secret, undefined))).toBe('BROWSER_EXECUTION_NOT_FOUND')
    expect(code(svc.permit(alice, claim.executionId, undefined, undefined))).toBe('BROWSER_EXECUTION_NOT_FOUND')
    expect(code(svc.permit(bob, claim.executionId, claim.secret, undefined))).toBe('BROWSER_EXECUTION_NOT_FOUND')
    expect(code(svc.permit({ ...alice, companyId: OTHER_CO }, claim.executionId, claim.secret, undefined))).toBe('BROWSER_EXECUTION_NOT_FOUND')
  })

  it('is refused after 2 minutes without one; a stop, a changed setting, a revoked grant, a retired combination or a too-old app ends the execution for good', () => {
    const late = claimed()
    now += 120_000
    expect(code(svc.permit(alice, late.claim.executionId, late.claim.secret, undefined))).toBe('BROWSER_EXECUTION_CLOSED')
    expect(execState(alice, late.plan.id)).toBe('void')
    const changes: Array<[() => void, () => void, string]> = [
      [() => { stops = { all: false, tools: ['web'] } }, () => { stops = { all: false, tools: [] } }, 'BROWSER_AI_STOPPED'],
      [() => { policy = { mode: 'off', sites: [SITE] } }, () => { policy = { mode: 'on', sites: [SITE] } }, 'BROWSER_NOT_ALLOWED'],
      [() => grant(alice, false), () => grant(alice), 'BROWSER_TYPE_NOT_GRANTED'],
      [() => { rows = [{ ...APPROVED, status: 'retired' }]; build() }, () => { rows = [APPROVED]; build() }, 'BROWSER_TYPE_RETIRED'],
      [() => { rows = [{ ...APPROVED, minAppVersion: '0.0.2' }]; build() }, () => { rows = [APPROVED]; build() }, 'BROWSER_APP_TOO_OLD'],
    ]
    const reasons: string[] = []
    for (const [i, [change, undo, expected]] of changes.entries()) {
      const c = claimed(alice, { reminder: String(20 + i), step: '22' })
      const key = lockKeyOf(c.claim.executionId)
      change()
      expect(code(svc.permit(alice, c.claim.executionId, c.claim.secret, undefined)), expected).toBe(expected)
      // Void at once, its target let go; lifting the cause never revives the same secret.
      expect(lockHolder(key), expected).toBeNull()
      undo()
      expect(code(svc.permit(alice, c.claim.executionId, c.claim.secret, undefined)), expected).toBe('BROWSER_EXECUTION_CLOSED')
      const view = value(svc.get(alice, c.plan.id))
      expect(view.state).toBe('done')
      expect(view.execution?.state).toBe('void')
      reasons.push(view.execution?.voidReason as string)
    }
    expect(reasons).toEqual(['stopped', 'setting', 'not-granted', 'retired', 'app-too-old'])
  })

  it('an execution that does not hold its target lock gets no permit', () => {
    const c = claimed()
    conn.prepare('DELETE FROM browser_target_locks WHERE execution_id = ?').run(c.claim.executionId)
    expect(code(svc.permit(alice, c.claim.executionId, c.claim.secret, undefined))).toBe('BROWSER_EXECUTION_CLOSED')
    expect(execState(alice, c.plan.id)).toBe('claimed')
  })

  it('a claim past its plan\'s hour is void at the permit, even within its 2 minutes', () => {
    const p = approved()
    now = T0 + 59 * 60_000
    const c = value(svc.claim(alice, p.id, undefined))
    now = T0 + 3_600_000
    expect(code(svc.permit(alice, c.executionId, c.secret, undefined))).toBe('BROWSER_EXECUTION_CLOSED')
    expect(execState(alice, p.id)).toBe('void')
  })

  it('a stop while permitted does not make it void (it may have been sent)', () => {
    const c = permitted()
    stops = { all: true, tools: [] }
    now += 10_000
    expect(execState(alice, c.plan.id)).toBe('permitted')
  })
})

describe('reports (the secret alone)', () => {
  const report = (secret: string, result: string, reason?: string) => svc.report(secret, reason ? { result, reason } : { result })

  it('permitted → succeeded, failed (stopped before sending) or unknown; final states let the target go', () => {
    for (const [i, result] of (['succeeded', 'failed', 'unknown'] as const).entries()) {
      const c = permitted(alice, { reminder: String(30 + i), step: '22' })
      const key = lockKeyOf(c.claim.executionId)
      expect(value(report(c.claim.secret, result, 'stopped-before-send'))).toEqual({ state: result, outcome: 'applied' })
      expect(lockHolder(key)).toBe(result === 'unknown' ? c.claim.executionId : null)
      expect(value(svc.get(alice, c.plan.id)).state).toBe(result === 'unknown' ? 'claimed' : 'done')
    }
  })

  it('unknown → succeeded with the valid secret (a late, sure success); failed after unknown is kept but changes nothing', () => {
    const c = permitted()
    now += 35_000
    expect(execState(alice, c.plan.id)).toBe('unknown')
    expect(value(report(c.claim.secret, 'failed'))).toEqual({ state: 'unknown', outcome: 'recorded' })
    expect(value(report(c.claim.secret, 'unknown'))).toEqual({ state: 'unknown', outcome: 'same' })
    expect(value(report(c.claim.secret, 'succeeded'))).toEqual({ state: 'succeeded', outcome: 'applied' })
  })

  it('the same report again is answered the same; a contradicting one is refused and kept, marked', () => {
    const c = permitted()
    value(report(c.claim.secret, 'succeeded'))
    expect(value(report(c.claim.secret, 'succeeded'))).toEqual({ state: 'succeeded', outcome: 'same' })
    expect(value(report(c.claim.secret, 'unknown'))).toEqual({ state: 'succeeded', outcome: 'recorded' })
    expect(code(report(c.claim.secret, 'failed'))).toBe('BROWSER_REPORT_CONFLICT')
    const f = permitted(alice, { reminder: '40', step: '22' })
    value(report(f.claim.secret, 'failed'))
    expect(code(report(f.claim.secret, 'succeeded'))).toBe('BROWSER_REPORT_CONFLICT')
    expect(execState(alice, f.plan.id)).toBe('failed')
    const kept = data.forCompany(CO).browserPlans.reports(c.claim.executionId).map(r => r.outcome)
    expect(kept).toEqual(['applied', 'same', 'recorded', 'conflict'])
  })

  it('nothing is reported for an execution without a permit (claimed or void): refused, kept', () => {
    const c = claimed()
    expect(code(report(c.claim.secret, 'succeeded'))).toBe('BROWSER_REPORT_CONFLICT')
    expect(execState(alice, c.plan.id)).toBe('claimed')
    value(svc.cancel(alice, c.plan.id))
    expect(code(report(c.claim.secret, 'succeeded'))).toBe('BROWSER_REPORT_CONFLICT')
    expect(execState(alice, c.plan.id)).toBe('void')
  })

  it('after a person confirmed, a report never changes the result: agreeing is kept, contradicting is refused', () => {
    const done = permitted()
    now += 35_000
    value(svc.confirm(alice, done.claim.executionId, { result: 'done' }))
    expect(value(report(done.claim.secret, 'succeeded'))).toEqual({ state: 'confirmed_done', outcome: 'recorded' })
    expect(code(report(done.claim.secret, 'failed'))).toBe('BROWSER_REPORT_CONFLICT')
    const notDone = permitted(alice, { reminder: '41', step: '22' })
    now += 35_000
    value(svc.confirm(alice, notDone.claim.executionId, { result: 'not_done' }))
    expect(code(report(notDone.claim.secret, 'succeeded'))).toBe('BROWSER_REPORT_CONFLICT')
    expect(execState(alice, notDone.plan.id)).toBe('confirmed_not_done')
  })

  it('an unknown secret or a malformed report is refused', () => {
    const c = permitted()
    expect(code(report(randomBytes(32).toString('hex'), 'succeeded'))).toBeUndefined()
    expect(svc.report(randomBytes(32).toString('hex'), { result: 'succeeded' })).toMatchObject({ ok: false, kind: 'unauthorized' })
    expect(svc.report(undefined, { result: 'succeeded' })).toMatchObject({ ok: false, kind: 'unauthorized' })
    expect(code(svc.report(c.claim.secret, { result: 'done' }))).toBe('BROWSER_BAD_REPORT')
    expect(code(svc.report(c.claim.secret, { result: 'succeeded', reason: 'Free text!' }))).toBe('BROWSER_BAD_REPORT')
    expect(code(svc.report(c.claim.secret, { result: 'succeeded', body: 'x' }))).toBe('BROWSER_BAD_REPORT')
    expect(execState(alice, c.plan.id)).toBe('permitted')
  })
})

describe('「確かめた」 (済んでいた / されていなかった)', () => {
  it('only after permit + 5 s + 30 s by the server\'s clock; a permitted execution becomes unknown at that moment', () => {
    const c = permitted()
    now += 34_999
    expect(code(svc.confirm(alice, c.claim.executionId, { result: 'done' }))).toBe('BROWSER_TOO_EARLY')
    expect(execState(alice, c.plan.id)).toBe('permitted')
    now += 1
    expect(value(svc.confirm(alice, c.claim.executionId, { result: 'done' }))).toMatchObject({ state: 'confirmed_done', confirmedBy: alice.userId })
    expect(value(svc.get(alice, c.plan.id)).state).toBe('done')
  })

  it('never while the server\'s clock reads before the permit (it went backwards)', () => {
    const c = permitted()
    now += 40_000
    expect(execState(alice, c.plan.id)).toBe('unknown')
    now -= 60_000
    expect(code(svc.confirm(alice, c.claim.executionId, { result: 'not_done' }))).toBe('BROWSER_CLOCK_BACKWARDS')
  })

  it('once: the second confirm loses, whatever it says', () => {
    const c = permitted()
    now += 35_000
    value(svc.confirm(alice, c.claim.executionId, { result: 'not_done' }))
    expect(code(svc.confirm(alice, c.claim.executionId, { result: 'done' }))).toBe('BROWSER_ALREADY_SETTLED')
    expect(execState(alice, c.plan.id)).toBe('confirmed_not_done')
  })

  it('nothing to confirm without a permit; a malformed answer is refused', () => {
    const c = claimed()
    expect(code(svc.confirm(alice, c.claim.executionId, { result: 'done' }))).toBe('BROWSER_NOT_PERMITTED')
    expect(code(svc.confirm(alice, c.claim.executionId, { result: 'maybe' }))).toBe('BROWSER_BAD_CONFIRM')
  })

  it('another member cannot see it; an owner / admin may only once the member left or 24 hours after the permit', () => {
    const c = permitted()
    now += 35_000
    expect(code(svc.confirm(bob, c.claim.executionId, { result: 'done' }))).toBe('BROWSER_EXECUTION_NOT_FOUND')
    expect(code(svc.confirm(admin, c.claim.executionId, { result: 'done' }))).toBe('BROWSER_CONFIRM_NOT_YET')
    now += 24 * 3_600_000
    expect(value(svc.confirm(admin, c.claim.executionId, { result: 'done' })).state).toBe('confirmed_done')
    const d = permitted(alice, { reminder: '50', step: '22' })
    now += 35_000
    expect(code(svc.confirm(owner, d.claim.executionId, { result: 'not_done' }))).toBe('BROWSER_CONFIRM_NOT_YET')
    leave(CO, alice.userId)
    expect(value(svc.confirm(owner, d.claim.executionId, { result: 'not_done' })).state).toBe('confirmed_not_done')
  })

  it('the waiting list: the member\'s own; an owner / admin also others\', marked when they may confirm', () => {
    const a = permitted()
    claimed(alice, { reminder: '60', step: '22' })
    const b = permitted(bob, { reminder: '61', step: '22' })
    expect(value(svc.waiting(alice)).items.map(i => [i.executionId, i.state, i.canConfirm])).toEqual([[a.claim.executionId, 'permitted', false]])
    now += 35_000
    expect(value(svc.waiting(alice)).items.map(i => [i.state, i.canConfirm])).toEqual([['unknown', true]])
    const forAdmin = value(svc.waiting(admin)).items
    expect(forAdmin.map(i => i.executionId).sort()).toEqual([a.claim.executionId, b.claim.executionId].sort())
    expect(forAdmin.every(i => !i.canConfirm)).toBe(true)
    expect(value(svc.waiting(bob)).items.map(i => i.executionId)).toEqual([b.claim.executionId])
  })
})

describe('leaving the company', () => {
  it('drafts and approved plans close, a claimed execution is void and lets go, permitted / unknown ones stay with their lock, the grants go', () => {
    const d = draft()
    const a = approved(alice, { reminder: '70', step: '22' })
    const c = claimed(alice, { reminder: '71', step: '22' })
    const p = permitted(alice, { reminder: '72', step: '22' })
    leave(CO, alice.userId)
    expect(data.forCompany(CO).browserPlans.plan(d.id)).toMatchObject({ state: 'closed', closeReason: 'left' })
    expect(data.forCompany(CO).browserPlans.plan(a.id)).toMatchObject({ state: 'closed', closeReason: 'left' })
    expect(data.forCompany(CO).browserPlans.execution(c.claim.executionId)).toMatchObject({ state: 'void', voidReason: 'left' })
    expect(lockHolder(lockKeyOf(c.claim.executionId))).toBeNull()
    expect(data.forCompany(CO).browserPlans.execution(p.claim.executionId)?.state).toBe('permitted')
    expect(lockHolder(lockKeyOf(p.claim.executionId))).toBe(p.claim.executionId)
    expect(data.forCompany(CO).browserPlans.grants().filter(g => g.userId === alice.userId)).toEqual([])
    // Their app may still report: a sure success with the secret moves it on.
    expect(value(svc.report(p.claim.secret, { result: 'succeeded' }))).toEqual({ state: 'succeeded', outcome: 'applied' })
    // Invited back: nothing returns.
    join(CO, alice.userId, 'member', iso(now))
    expect(code(svc.register(alice, input(), undefined))).toBe('BROWSER_TYPE_NOT_GRANTED')
    expect(code(svc.approve(alice, a.id, { contentHash: a.contentHash }, undefined))).toBe('BROWSER_PLAN_NOT_DRAFT')
  })
})

function seedOpen(count: number, state: 'claimed' | 'permitted') {
  const insertPlan = conn.prepare(`INSERT INTO browser_plans (company_id, id, user_id, connector_id, connector_version, operation, declaration_hash, checker_hash,
    facts_version, account, content, content_hash, state, created_at, expires_at) VALUES (?, ?, ?, 'lstep', ?, ?, ?, ?, 1, 'acc1', ?, 'h', 'claimed', ?, ?)`)
  const insertExec = conn.prepare(`INSERT INTO browser_executions (company_id, id, plan_id, user_id, secret_hash, lock_key, state, claimed_at, permitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertLock = conn.prepare('INSERT INTO browser_target_locks (company_id, lock_key, execution_id, created_at) VALUES (?, ?, ?, ?)')
  const content = JSON.stringify({ target: { reminder: '1', step: '2' } })
  conn.transaction(() => {
    for (let i = 0; i < count; i++) {
      const plan = `bp_${String(i).padStart(32, '0')}`
      const exec = `bx_${String(i).padStart(32, '0')}`
      insertPlan.run(CO, plan, alice.userId, APPROVED.version, OP, APPROVED.declarationHash, APPROVED.checkerHash, content, iso(now), iso(now + 3_600_000))
      insertExec.run(CO, exec, plan, alice.userId, `hash-${i}`, `lock-${i}`, state, iso(now + i), state === 'permitted' ? iso(now + i) : null)
      insertLock.run(CO, `lock-${i}`, exec, iso(now))
    }
  })()
}

describe('many executions', () => {
  it('leaving makes every claimed execution of the member void, however many (no page limit in lifecycle work)', () => {
    seedOpen(520, 'claimed')
    leave(CO, alice.userId)
    expect(conn.prepare("SELECT COUNT(*) AS n FROM browser_executions WHERE company_id = ? AND state = 'claimed'").get(CO)).toEqual({ n: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_target_locks WHERE company_id = ?').get(CO)).toEqual({ n: 0 })
  })

  it('the waiting list comes a page at a time, and the pages together hold every open execution', () => {
    seedOpen(250, 'permitted')
    const seen: string[] = []
    let after: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = value(svc.waiting(alice, after))
      seen.push(...page.items.map(i => i.executionId))
      if (!page.next) break
      after = page.next
    }
    expect(seen).toHaveLength(250)
    expect(new Set(seen).size).toBe(250)
    expect(code(svc.waiting(alice, '../x'))).toBe('BROWSER_BAD_CURSOR')
  })
})

describe('compare-and-set', () => {
  it('a state change from a state the row no longer has changes nothing', () => {
    const p = draft()
    const repo = data.forCompany(CO).browserPlans
    expect(repo.setPlanState(p.id, 'draft', 'approved', { approvedAt: iso(now) })).toBe(true)
    // Cancel read "draft" a moment before: its change loses.
    expect(repo.setPlanState(p.id, 'draft', 'closed', { closeReason: 'cancelled' })).toBe(false)
    expect(repo.plan(p.id)?.state).toBe('approved')
    const c = claimed(alice, { reminder: '80', step: '22' })
    expect(repo.setExecutionState(c.claim.executionId, 'claimed', 'permitted', { permittedAt: iso(now) })).toBe(true)
    expect(repo.setExecutionState(c.claim.executionId, 'claimed', 'void', { voidReason: 'expired' })).toBe(false)
  })

  /**
   * Another request changes the row between the service's read and its write (what a database that
   * is not synchronous would allow): the service's own compare-and-set must lose.
   */
  function racing(on: 'setPlanState' | 'setExecutionState', before: (repo: BrowserPlanRepository) => void) {
    const real = data
    const repoOf = (companyId: string): BrowserPlanRepository => {
      const repo = real.forCompany(companyId).browserPlans
      let raced = false
      return {
        ...repo,
        [on]: (...args: unknown[]) => {
          if (!raced) { raced = true; before(repo) }
          return (repo[on] as (...a: unknown[]) => boolean)(...args)
        },
      }
    }
    const wrapped: CompanyDataSource = { forCompany: companyId => ({ ...real.forCompany(companyId), browserPlans: repoOf(companyId) }) }
    svc = createBrowserPlanService({
      companyData: wrapped, transactions: sqliteTransactions(conn), clock: { now: () => iso(now), nowMs: () => now },
      ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') },
      tokenDigest: sha256TokenDigest, catalog: { combinations: () => rows }, executionLookup: sqliteBrowserExecutionLookup(conn),
      memberships: sqliteMembershipRepository(conn), accounts: { byIds: () => new Map() } as never,
      browserPolicy: () => policy, aiStops: () => stops, log: { warn: () => {} },
    })
  }

  it('a permit that loses its compare-and-set to another permit is not given', () => {
    const c = claimed()
    racing('setExecutionState', repo => { repo.setExecutionState(c.claim.executionId, 'claimed', 'permitted', { permittedAt: iso(now) }) })
    expect(code(svc.permit(alice, c.claim.executionId, c.claim.secret, undefined))).toBe('BROWSER_PERMIT_USED')
  })

  it('a claim that loses its compare-and-set to another claim gives no execution and no secret', () => {
    const p = approved()
    racing('setPlanState', repo => { repo.setPlanState(p.id, 'approved', 'claimed', {}) })
    expect(code(svc.claim(alice, p.id, undefined))).toBe('BROWSER_PLAN_NOT_APPROVED')
    expect((conn.prepare('SELECT COUNT(*) AS n FROM browser_executions').get() as { n: number }).n).toBe(0)
  })
})

describe('the reports\' log', () => {
  it('no report is deleted while its company exists; deleting the company still takes them', () => {
    const c = permitted()
    value(svc.report(c.claim.secret, { result: 'succeeded' }))
    expect(() => conn.prepare('DELETE FROM browser_execution_reports WHERE company_id = ?').run(CO)).toThrow(/append-only/)
    expect(() => conn.prepare("UPDATE browser_execution_reports SET outcome = 'same' WHERE company_id = ?").run(CO)).toThrow(/append-only/)
    conn.pragma('foreign_keys = ON')
    conn.prepare('DELETE FROM companies WHERE id = ?').run(CO)
    expect((conn.prepare('SELECT COUNT(*) AS n FROM browser_execution_reports').get() as { n: number }).n).toBe(0)
  })
})

describe('managing who may use a type', () => {
  it('owner / admin only; a member of the company; only an approved type the first version runs', () => {
    expect(svc.grants(alice)).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(svc.setGrant(alice, bob.userId, { connector: 'lstep', operation: OP, declarationHash: APPROVED.declarationHash, allowed: true })).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(svc.setGrant(admin, 'u-nobody', { connector: 'lstep', operation: OP, declarationHash: APPROVED.declarationHash, allowed: true })).toMatchObject({ ok: false, kind: 'not-found' })
    expect(code(svc.setGrant(admin, bob.userId, { connector: 'lstep', operation: 'other', declarationHash: APPROVED.declarationHash, allowed: true }))).toBe('BROWSER_UNKNOWN_OPERATION')
    expect(code(svc.setGrant(admin, bob.userId, { connector: 'lstep', operation: OP, declarationHash: `sha256:${'3'.repeat(64)}`, allowed: true }))).toBe('BROWSER_UNKNOWN_OPERATION')
    const view = value(svc.grants(admin))
    expect(view.types).toEqual([{ connector: 'lstep', version: APPROVED.version, declarationHash: APPROVED.declarationHash, operation: OP, label: 'リマインダの段にテンプレートを足す' }])
    expect(view.grants.map(g => g.userId).sort()).toEqual([alice.userId, bob.userId])
  })
})
