/**
 * Writes within frames on the server (services/browser-frames.ts; agent-browser.md "Writes within frames";
 * model/browser-plan/FramesLife.tla), against a real database and the real 「Skill の承認」 service over a stand-in of
 * the server's own copy of the Skills. The site is fictional.
 *
 * Guards (each mutation-checked): a frame is never used past its max (service and CHECK); one write in flight per run
 * (service, partial unique index, two permits racing); after `unknown` nothing more is permitted, also after a late
 * "done"; after the AI stop, the person lowered to 見るだけ, the Skill's approval revoked (also between the git read and
 * the transaction) or another PC, the permit is refused and the run ends; a write silent past its window turns unknown;
 * the run's time ends it; an ad-hoc plan needs the person's approval of exactly what the card showed; a pre-approved
 * Skill whose text changed needs the card once, marked seen only with the server's own `files`; another member's or
 * company's run is not found; an ended run's frames are gone; leaving ends the run and its write in flight is unknown.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sha256TokenDigest } from '../../src/adapters/system'
import { createBrowserSkillService, type BrowserSkillService } from '../../src/services/browser-skills'
import { BROWSER_FRAME_TIMES, createBrowserFrameService, type BrowserFrameService } from '../../src/services/browser-frames'
import { createBrowserRunService, type BrowserRunService } from '../../src/services/browser-runs'
import { BROWSER_RUN_BUDGETS, BROWSER_RUN_MIN_OPERATE_MS } from '../../../shared/core/browser-run-budget'
import type { BrowserSkillContent, BrowserSkillSource } from '../../src/ports/browser-skills'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import type { BrowserFramePermitRequest, BrowserFrameRunStart, BrowserFrameRunView } from '../../../shared/types/browser-frames'
import type { Member } from '../../src/services/access'
import type { Outcome, Refusal } from '../../src/services/outcome'

const T0 = Date.parse('2026-11-25T00:00:00.000Z')
const CO = 'co-1'
const OTHER_CO = 'co-2'
const owner: Member = { companyId: CO, userId: 'u-owner', role: 'owner' }
const alice: Member = { companyId: CO, userId: 'u-alice', role: 'member' }
const bob: Member = { companyId: CO, userId: 'u-bob', role: 'member' }
const otherOwner: Member = { companyId: OTHER_CO, userId: 'u-other', role: 'owner' }
const DOMAIN = 'shop.example.test'
const SKILL = 'order-copy'
const PC = 'pc-1'

const yaml = `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: /api/orders/register, max: 2 }\n  - { method: POST, path: "/api/orders/{n}/note", max: 1 }\n`
const adhoc = { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/orders/register', max: 2 }, { method: 'POST', path: '/api/orders/{n}/note', max: 1 }] }

let conn: Database.Database
let now: number
let monoBase: number
let store: Record<string, Record<string, BrowserSkillContent>>
let policy: BrowserOperationSettings
let stopped: boolean
let level: Record<string, 'none' | 'read' | 'write'>
let skills: BrowserSkillService
let betweenReadAndWrite: (() => void) | null
let frames: BrowserFrameService
const iso = (ms: number) => new Date(ms).toISOString()
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

const source: BrowserSkillSource = {
  list: async companyId => Object.keys(store[companyId] ?? {}).sort(),
  read: async (companyId, name) => store[companyId]?.[name] ?? null,
  pushed: async () => [],
  shelfLanded: async () => null,
}
function put(declaration: string, text = 'v1') {
  store[CO] = { ...(store[CO] ?? {}), [SKILL]: { name: SKILL, declaration, files: `git:${sha(`${declaration}\0${text}`).slice(0, 40)}` } }
}
async function approveSkill(mode: 'per_run' | 'pre_approved') {
  const item = (await skills.list(owner) as { ok: true; value: { items: Array<{ declarationHash: string; files: string }> } }).value.items[0]
  value(await skills.approve(owner, { skill: SKILL, declarationHash: item.declarationHash, files: item.files, mode }))
}

function value<T>(r: Outcome<T>): T {
  if (!r.ok) throw new Error(JSON.stringify((r as Refusal).body))
  return r.value
}
const code = (r: { ok: boolean; body?: { code?: unknown } }) => (r.ok ? 'ok' : r.body?.code)

function join(companyId: string, userId: string, role: string) {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${companyId}-${userId}`, userId, companyId, role, iso(T0), iso(T0))
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const co of [CO, OTHER_CO]) conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(co, co, co, 'u-owner', iso(T0), iso(T0))
  join(CO, owner.userId, 'owner'); join(CO, alice.userId, 'member'); join(CO, bob.userId, 'member')
  join(OTHER_CO, otherOwner.userId, 'owner')
  now = T0
  monoBase = T0
  store = {}
  policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'write', assetHosts: [] }] }
  stopped = false
  level = { [alice.userId]: 'write', [bob.userId]: 'write', [owner.userId]: 'write', [otherOwner.userId]: 'write' }
  betweenReadAndWrite = null
  const data = sqliteCompanyData(conn)
  const clock = { now: () => iso(now), nowMs: () => now }
  const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
  skills = createBrowserSkillService({
    companyData: data, clock, ids, memberships: sqliteMembershipRepository(conn),
    accounts: { byIds: list => new Map(list.map(id => [id, { name: id, email: `${id}@example.test` }])) },
    source, registeredHosts: () => policy.sites.map(s => s.host), sha256: sha,
  })
  frames = createBrowserFrameService({
    companyData: data, transactions: sqliteTransactions(conn), clock, ids, tokenDigest: sha256TokenDigest,
    monotonic: { bootId: 'boot-1', monoMs: () => now - monoBase },
    browserPolicy: () => policy,
    aiStops: () => ({ all: stopped, tools: [] }),
    // This PC: the key names the registration (absent = the owner transition, here for anyone: no registration).
    devices: { check: (_m, key) => ({ ok: true, value: { deviceId: key === undefined ? null : `bd_${key}` } }) },
    siteGrants: { allows: (m, host, effect) => host === DOMAIN && (effect === 'read' ? level[m.userId] !== 'none' : level[m.userId] === 'write') },
    skills: {
      approvedFrames: async (m, s) => { const r = await skills.approvedFrames(m, s); betweenReadAndWrite?.(); return r },
      stillApproved: (m, s, h, a) => skills.stillApproved(m, s, h, a),
      runCardShown: (m, s, h, f) => skills.runCardShown(m, s, h, f),
    },
  })
})

/** The card's ［任せる］: the plan's hash and the one-time value only the start's answer carried. */
const approve = (m: Member, run: BrowserFrameRunStart, key: string | undefined = PC) =>
  frames.approve(m, run.runId, { planHash: run.planHash, approvalToken: run.approvalToken }, key)
async function openAdhoc(m: Member = alice): Promise<BrowserFrameRunView> {
  return value(await approve(m, value(await frames.start(m, { plan: adhoc }, PC))))
}
/** A held write that fits each frame of `yaml` / `adhoc` (frame 1: register; frame 2: a note on order 42). */
const FITS: Record<number, BrowserFramePermitRequest> = {
  1: { method: 'POST', path: '/api/orders/register', fields: {} },
  2: { method: 'POST', path: '/api/orders/42/note', fields: {} },
}
const permit = (runId: string, frame: number, m: Member = alice, request: BrowserFramePermitRequest = FITS[frame] ?? FITS[1]) =>
  frames.permit(m, runId, { frame, request }, PC)
const report = (runId: string, write: number, result: string, m: Member = alice, key: string | undefined = PC) =>
  frames.report(m, runId, { write, result }, key)

describe('frames: a run of free operation', () => {
  it('an ad-hoc plan waits for the person to approve exactly what the card showed', async () => {
    const run = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(run).toMatchObject({ state: 'waiting', needsApproval: true, source: 'adhoc', approval: null })
    expect(run.frames.map(f => [f.frame, f.path, f.max, f.used])).toEqual([[1, '/api/orders/register', 2, 0], [2, '/api/orders/{n}/note', 1, 0]])
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_NOT_APPROVED')
    expect(code(await frames.approve(alice, run.runId, { planHash: `sha256:${'0'.repeat(64)}`, approvalToken: run.approvalToken }, PC))).toBe('BROWSER_FRAME_PLAN_CHANGED')
    const open = value(await approve(alice, run))
    expect(open).toMatchObject({ state: 'open', approval: 'card' })
    expect(code(await permit(run.runId, 1))).toBe('ok')
  })

  it('only the one-time value the start answered approves: never from the run\'s view, never guessed, never twice', async () => {
    const run = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(run.approvalToken).toMatch(/^[0-9a-f]{64}$/)
    const seen = value(frames.get(alice, run.runId))
    expect(JSON.stringify(seen)).not.toContain(run.approvalToken as string)
    expect(seen).not.toHaveProperty('approvalToken')
    expect(code(await frames.approve(alice, run.runId, { planHash: run.planHash }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(await frames.approve(alice, run.runId, { planHash: run.planHash, approvalToken: 'a'.repeat(64) }, PC))).toBe('BROWSER_FRAME_APPROVAL_REFUSED')
    expect(value(frames.get(alice, run.runId)).state).toBe('waiting')
    value(await approve(alice, run))
    expect(code(await approve(alice, run))).toBe('BROWSER_RUN_NOT_WAITING')
    // A pre-approved run opens without a card: no value to hand out.
    put(yaml)
    await approveSkill('pre_approved')
    value(frames.end(alice, run.runId))
    expect(value(await frames.start(alice, { skill: SKILL }, PC)).approvalToken).toBeNull()
  })

  it('a permit is given only for a held write that fits its frame; a mismatch takes nothing', async () => {
    const run = await openAdhoc()
    const tries: Array<[number, BrowserFramePermitRequest, string]> = [
      [1, { method: 'PUT', path: '/api/orders/register', fields: {} }, 'method'],
      [1, { method: 'POST', path: '/api/orders/register/x', fields: {} }, 'path'],
      [1, { method: 'POST', path: '/api/orders/register?copy=1', fields: {} }, 'path'],
      [2, { method: 'POST', path: '/api/orders/abc/note', fields: {} }, 'path'],
      [1, { method: 'POST', path: '/api/orders/register', fields: { _method: 'DELETE' } }, 'method-override'],
      [1, { method: 'POST', path: '/api/orders/register', fields: { title: 'x' } }, 'fields'],
    ]
    for (const [frame, request, reason] of tries) {
      const r = await permit(run.runId, frame, alice, request)
      expect([code(r), (r as Refusal).body?.reason]).toEqual(['BROWSER_FRAME_MISMATCH', reason])
    }
    const after = value(frames.get(alice, run.runId))
    expect(after.state).toBe('open')
    expect(after.frames.map(f => f.used)).toEqual([0, 0])
    expect(after.writes).toEqual([])
    expect(code(await frames.permit(alice, run.runId, { frame: 1 }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(await permit(run.runId, 2))).toBe('ok')
  })

  it('a frame that fixes fields and `_method` needs exactly them', async () => {
    const plan = { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/orders/{n}', max: 1, fields: { _method: 'PATCH', status: 'closed' } }] }
    const run = value(await approve(alice, value(await frames.start(alice, { plan }, PC))))
    const fit = { method: 'POST', path: '/api/orders/7', fields: { _method: 'PATCH', status: 'closed' } }
    expect((await permit(run.runId, 1, alice, { ...fit, fields: { status: 'closed' } }) as Refusal).body.reason).toBe('method-override')
    expect((await permit(run.runId, 1, alice, { ...fit, fields: { _method: 'DELETE', status: 'closed' } }) as Refusal).body.reason).toBe('method-override')
    expect((await permit(run.runId, 1, alice, { ...fit, fields: { _method: 'PATCH', status: 'open' } }) as Refusal).body.reason).toBe('fields')
    expect((await permit(run.runId, 1, alice, { ...fit, fields: { _method: 'PATCH' } }) as Refusal).body.reason).toBe('fields')
    expect(code(await permit(run.runId, 1, alice, fit))).toBe('ok')
  })

  it('an ad-hoc plan may not be "any path"', async () => {
    for (const path of ['/{x}', '/{n}/note', '/']) {
      expect(code(await frames.start(alice, { plan: { domain: DOMAIN, writes: [{ method: 'POST', path, max: 1 }] } }, PC))).toBe('BROWSER_FRAME_BAD_PLAN')
    }
  })

  it('a sure report counts only from the run\'s own PC; unknown from anywhere', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    expect(code(report(run.runId, 1, 'not_sent', alice, 'pc-2'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(code(frames.report(alice, run.runId, { write: 1, result: 'done' }, undefined))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(value(frames.get(alice, run.runId)).writes[0].state).toBe('permitted')
    expect(value(report(run.runId, 1, 'unknown', alice, 'pc-2')).run.state).toBe('locked')
  })

  it('one waiting card per member: a new start replaces the older card', async () => {
    const first = value(await frames.start(alice, { plan: adhoc }, PC))
    const second = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(value(frames.get(alice, first.runId))).toMatchObject({ state: 'ended', endReason: 'superseded' })
    expect(code(await approve(alice, first))).toBe('BROWSER_RUN_ENDED')
    expect(value(await approve(alice, second)).state).toBe('open')
    // The table holds at most one waiting run per member as well.
    expect(() => conn.prepare(`INSERT INTO browser_frame_runs (company_id, id, user_id, host, source, plan_hash, state, created_at, expires_at)
      VALUES (?, ?, ?, 'x.example.test', 'adhoc', ?, 'waiting', ?, ?)`).run(CO, `bf_${'1'.repeat(32)}`, alice.userId, `sha256:${'a'.repeat(64)}`, iso(now), iso(now))).not.toThrow()
    expect(() => conn.prepare(`INSERT INTO browser_frame_runs (company_id, id, user_id, host, source, plan_hash, state, created_at, expires_at)
      VALUES (?, ?, ?, 'y.example.test', 'adhoc', ?, 'waiting', ?, ?)`).run(CO, `bf_${'2'.repeat(32)}`, alice.userId, `sha256:${'a'.repeat(64)}`, iso(now), iso(now))).toThrow()
  })

  it('an ad-hoc plan is checked with the declaration\'s rules and only on a registered domain', async () => {
    expect(code(await frames.start(alice, { plan: { ...adhoc, writes: [{ method: 'POST', path: '/a', max: 99 }] } }, PC))).toBe('BROWSER_FRAME_BAD_PLAN')
    expect(code(await frames.start(alice, { plan: { ...adhoc, writes: [{ method: 'POST', path: '/a', max: 1, fields: { _token: 'x' } }] } }, PC))).toBe('BROWSER_FRAME_BAD_PLAN')
    expect(code(await frames.start(alice, { plan: { ...adhoc, domain: 'other.example.test' } }, PC))).toBe('BROWSER_NOT_ALLOWED')
    expect(code(await frames.start(alice, { plan: adhoc, skill: SKILL }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(await frames.start(alice, { plan: adhoc, approved: true }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
  })

  it('a frame is never used past its max', async () => {
    const run = await openAdhoc()
    for (const write of [1, 2]) {
      expect(value(await permit(run.runId, 1))).toMatchObject({ write, frame: 1, validMs: 5000 })
      value(report(run.runId, write, 'done'))
    }
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_FRAME_USED_UP')
    // The other frame still has its unit; a frame the run does not have is a bad request.
    expect(code(await permit(run.runId, 2))).toBe('ok')
    value(report(run.runId, 3, 'done'))
    expect(code(await permit(run.runId, 3))).toBe('BROWSER_FRAME_BAD_REQUEST')
    // The table itself refuses a unit past max.
    expect(() => conn.prepare('UPDATE browser_frames SET used = used + 1 WHERE company_id = ? AND run_id = ? AND idx = 1').run(CO, run.runId)).toThrow()
  })

  it('one write on its way at a time: the second waits until the first\'s result is recorded', async () => {
    const run = await openAdhoc()
    expect(code(await permit(run.runId, 1))).toBe('ok')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_WRITE_IN_FLIGHT')
    value(report(run.runId, 1, 'not_sent'))
    expect(code(await permit(run.runId, 2))).toBe('ok')
    // The table refuses a second permitted write of one run.
    expect(() => conn.prepare(`INSERT INTO browser_frame_writes (company_id, run_id, seq, frame_idx, state, permitted_at) VALUES (?, ?, 9, 1, 'permitted', ?)`).run(CO, run.runId, iso(now))).toThrow()
  })

  it('two permits racing (each past its git read) give one write', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(run.state).toBe('open')
    const answers = await Promise.all([permit(run.runId, 1), permit(run.runId, 2)])
    expect(answers.map(code).sort()).toEqual(['BROWSER_RUN_WRITE_IN_FLIGHT', 'ok'])
  })

  it('after unknown nothing more is permitted, also after a late done', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    expect(value(report(run.runId, 1, 'unknown')).run.state).toBe('locked')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
    const late = value(report(run.runId, 1, 'done'))
    expect(late.run.writes[0].state).toBe('done')
    expect(late.run.state).toBe('locked')
    expect(late.run.frames.every(f => f.left === 0)).toBe(true)
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
  })

  it('a permitted write silent past permit + 5 s + 30 s (both clocks) is unknown and the run locks', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    now += 34_999
    expect(value(frames.get(alice, run.runId)).state).toBe('open')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_WRITE_IN_FLIGHT')
    now += 1
    const after = value(frames.get(alice, run.runId))
    expect(after.state).toBe('locked')
    expect(after.writes[0].state).toBe('unknown')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
  })

  it('the wall clock jumping forward alone does not make a write unknown', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    now += 60_000
    monoBase += 60_000 // the monotonic clock did not move
    expect(value(frames.get(alice, run.runId)).writes[0].state).toBe('permitted')
  })

  it('after the AI stop the permit is refused and the run ends for good', async () => {
    const run = await openAdhoc()
    stopped = true
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_AI_STOPPED')
    stopped = false
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
    expect(value(frames.get(alice, run.runId))).toMatchObject({ state: 'ended', endReason: 'BROWSER_AI_STOPPED' })
  })

  it('the person lowered to 見るだけ mid-run: the next permit is refused and the run ends', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1)); value(report(run.runId, 1, 'done'))
    level[alice.userId] = 'read'
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_TYPE_NOT_GRANTED')
    level[alice.userId] = 'write'
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
  })

  it('the site lowered or the company turned off mid-run: refused', async () => {
    const run = await openAdhoc()
    policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'read', assetHosts: [] }] }
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_NOT_ALLOWED')
  })

  it('another PC cannot use the run (and that ends it)', async () => {
    const run = await openAdhoc()
    expect(code(await frames.permit(alice, run.runId, { frame: 1, request: FITS[1] }, 'pc-2'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
  })

  it('the Skill\'s approval revoked mid-run: refused', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    value(await permit(run.runId, 1)); value(report(run.runId, 1, 'done'))
    value(skills.revoke(owner, { skill: SKILL }))
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
  })

  it('the Skill\'s approval revoked between the git read and the transaction: refused', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    betweenReadAndWrite = () => { betweenReadAndWrite = null; value(skills.revoke(owner, { skill: SKILL })) }
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
    expect(value(frames.get(alice, run.runId)).writes).toEqual([])
  })

  it('the Skill\'s approval revoked between the git read and the start: nothing is started', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    betweenReadAndWrite = () => { betweenReadAndWrite = null; value(skills.revoke(owner, { skill: SKILL })) }
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_CHANGED')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_frame_runs').get()).toEqual({ n: 0 })
  })

  it('a pre-approved approval turned per-run between the git read and the start: no run opens without the card', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    betweenReadAndWrite = () => {
      betweenReadAndWrite = null
      const item = store[CO][SKILL]
      value(skills.revoke(owner, { skill: SKILL }))
      conn.prepare(`INSERT INTO browser_skill_approvals (company_id, skill_path, declaration_hash, mode, how, approved_by, approved_at, files_seen)
        VALUES (?, ?, ?, 'per_run', 'approved', ?, ?, ?)`).run(CO, `.claude/skills/${SKILL}`, `sha256:${sha(item.declaration as string)}`, owner.userId, iso(now), item.files)
    }
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_CHANGED')
    const again = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(again).toMatchObject({ state: 'waiting', needsApproval: true })
  })

  it('a pre-approved approval turned per-run between the git read and a permit: refused', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    betweenReadAndWrite = () => {
      betweenReadAndWrite = null
      const item = store[CO][SKILL]
      conn.prepare(`INSERT INTO browser_skill_approvals (company_id, skill_path, declaration_hash, mode, how, approved_by, approved_at, files_seen)
        VALUES (?, ?, ?, 'per_run', 'approved', ?, ?, ?)`).run(CO, `.claude/skills/${SKILL}`, `sha256:${sha(item.declaration as string)}`, owner.userId, iso(now), item.files)
    }
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
  })

  it('the approval\'s mode or the Skill\'s text changed mid-run: the run ends', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    value(await permit(run.runId, 1)); value(report(run.runId, 1, 'done'))
    await approveSkill('per_run') // the same declaration, now per run: another approval row
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    await approveSkill('pre_approved')
    const second = value(await frames.start(alice, { skill: SKILL }, PC))
    put(yaml, 'v2') // only the steps' text
    expect(code(await permit(second.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
  })

  it('approving the card checks the gate and the approval again (between the git read and the transaction too)', async () => {
    const run = value(await frames.start(alice, { plan: adhoc }, PC))
    stopped = true
    expect(code(await approve(alice, run))).toBe('BROWSER_AI_STOPPED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    stopped = false
    put(yaml)
    await approveSkill('per_run')
    const skillRun = value(await frames.start(alice, { skill: SKILL }, PC))
    betweenReadAndWrite = () => { betweenReadAndWrite = null; value(skills.revoke(owner, { skill: SKILL })) }
    expect(code(await approve(alice, skillRun))).toBe('BROWSER_SKILL_CHANGED')
    expect(value(frames.get(alice, skillRun.runId)).state).toBe('ended')
  })

  it('a write of an ended run still on its way keeps the domain busy until it is recorded', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(frames.end(alice, run.runId))
    expect(code(await frames.start(bob, { plan: adhoc }, PC))).toBe('BROWSER_RUN_BUSY')
    value(report(run.runId, 1, 'done'))
    expect(code(await frames.start(bob, { plan: adhoc }, PC))).toBe('ok')
  })

  it('the Skill\'s declaration changed mid-run: the run\'s frames are no longer the approved ones', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    put(yaml.replace('max: 2', 'max: 5'))
    await approveSkill('pre_approved')
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
  })

  it('a pre-approved Skill needs no card; a per-run one does', async () => {
    put(yaml)
    await approveSkill('per_run')
    const perRun = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(perRun).toMatchObject({ state: 'waiting', needsApproval: true, source: 'skill', skill: SKILL })
    value(frames.end(alice, perRun.runId))
    await approveSkill('pre_approved')
    expect(value(await frames.start(alice, { skill: SKILL }, PC))).toMatchObject({ state: 'open', approval: 'pre_approved', needsApproval: false })
  })

  it('a pre-approved Skill whose text changed needs the card once; seen with the server\'s own files', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    put(yaml, 'v2') // only the steps' text moved
    const first = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(first.state).toBe('waiting')
    // The approval names nothing but the plan's hash: a `files` from the request is refused.
    expect(code(await frames.approve(alice, first.runId, { planHash: first.planHash, approvalToken: first.approvalToken, files: 'git:0000' }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    value(await approve(alice, first))
    expect(value(await skills.approvedFrames(alice, SKILL))).toMatchObject({ textChanged: false, needsRunCard: false })
    value(frames.end(alice, first.runId))
    expect(value(await frames.start(alice, { skill: SKILL }, PC)).state).toBe('open')
  })

  it('a text changed again while the card was up: the approval ends the run and marks nothing seen', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    put(yaml, 'v2')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    put(yaml, 'v3')
    expect(code(await approve(alice, run))).toBe('BROWSER_SKILL_CHANGED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    expect(value(await skills.approvedFrames(alice, SKILL)).needsRunCard).toBe(true)
  })

  it('another member\'s or company\'s run is not found', async () => {
    const run = await openAdhoc()
    expect(code(frames.get(bob, run.runId))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(await permit(run.runId, 1, bob))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(await frames.approve(bob, run.runId, { planHash: run.planHash, approvalToken: 'a'.repeat(64) }, PC))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(frames.end(bob, run.runId))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(frames.get(otherOwner, run.runId))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(await permit(run.runId, 1, otherOwner))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    value(await permit(run.runId, 1))
    expect(code(report(run.runId, 1, 'done', otherOwner))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(value(frames.get(alice, run.runId)).writes[0].state).toBe('permitted')
  })

  it('one run per company × domain at a time', async () => {
    const run = await openAdhoc()
    expect(code(await frames.start(bob, { plan: adhoc }, PC))).toBe('BROWSER_RUN_BUSY')
    value(frames.end(alice, run.runId))
    expect(code(await frames.start(bob, { plan: adhoc }, PC))).toBe('ok')
  })

  it('frames vanish when the run ends; a write still on its way settles by its report', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    const ended = value(frames.end(alice, run.runId))
    expect(ended.state).toBe('ended')
    expect(ended.frames.map(f => f.left)).toEqual([0, 0])
    value(report(run.runId, 1, 'done'))
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_ENDED')
  })

  it('the run\'s time ends it; a plan waiting for approval ends sooner', async () => {
    const waiting = value(await frames.start(alice, { plan: adhoc }, PC))
    now += BROWSER_FRAME_TIMES.approve
    expect(value(frames.get(alice, waiting.runId))).toMatchObject({ state: 'ended', endReason: 'expired' })
    const run = await openAdhoc()
    now += BROWSER_FRAME_TIMES.run
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
  })

  it('leaving the company ends the run; its write in flight is unknown', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    frames.memberLeft(CO, alice.userId)
    const after = value(frames.get(alice, run.runId))
    expect(after.state).toBe('ended')
    expect(after.writes[0].state).toBe('unknown')
  })

  it('leaving after ending a run whose write is still on its way: that write is unknown, the run\'s end kept', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(frames.end(alice, run.runId))
    frames.memberLeft(CO, alice.userId)
    const row = conn.prepare('SELECT state, end_reason FROM browser_frame_runs WHERE company_id = ? AND id = ?').get(CO, run.runId)
    expect(row).toEqual({ state: 'ended', end_reason: 'ended' })
    expect(conn.prepare('SELECT state FROM browser_frame_writes WHERE company_id = ? AND run_id = ?').get(CO, run.runId)).toEqual({ state: 'unknown' })
  })

  it('reports: the same again is same, a contradiction is refused, not_sent after unknown is only recorded', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    expect(value(report(run.runId, 1, 'not_sent')).outcome).toBe('applied')
    expect(value(report(run.runId, 1, 'not_sent')).outcome).toBe('same')
    expect(code(report(run.runId, 1, 'done'))).toBe('BROWSER_REPORT_CONFLICT')
    value(await permit(run.runId, 1))
    value(report(run.runId, 2, 'unknown'))
    expect(value(report(run.runId, 2, 'not_sent')).outcome).toBe('recorded')
    expect(value(frames.get(alice, run.runId)).writes[1].state).toBe('unknown')
    expect(code(report(run.runId, 7, 'done'))).toBe('BROWSER_FRAME_WRITE_NOT_FOUND')
    expect(code(frames.report(alice, run.runId, { write: 1, result: 'verified' }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
  })

  it('the tables let a write move only forward', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1)); value(report(run.runId, 1, 'done'))
    expect(() => conn.prepare(`UPDATE browser_frame_writes SET state = 'permitted' WHERE company_id = ? AND run_id = ?`).run(CO, run.runId)).toThrow()
    value(frames.end(alice, run.runId))
    expect(() => conn.prepare(`UPDATE browser_frame_runs SET state = 'open', ended_at = NULL WHERE company_id = ? AND id = ?`).run(CO, run.runId)).toThrow()
    const locked = await openAdhoc()
    value(await permit(locked.runId, 1)); value(report(locked.runId, 1, 'unknown'))
    expect(() => conn.prepare(`UPDATE browser_frame_runs SET state = 'open' WHERE company_id = ? AND id = ?`).run(CO, locked.runId)).toThrow()
    // A frame's units: one at a time, never back, never past max — whatever the code does.
    expect(() => conn.prepare('UPDATE browser_frames SET used = used + 2 WHERE company_id = ? AND run_id = ? AND idx = 2').run(CO, locked.runId)).toThrow()
    expect(() => conn.prepare('UPDATE browser_frames SET used = 0 WHERE company_id = ? AND run_id = ? AND idx = 1').run(CO, locked.runId)).toThrow()
    expect(() => conn.prepare('UPDATE browser_frames SET max = 9 WHERE company_id = ? AND run_id = ? AND idx = 1').run(CO, locked.runId)).toThrow()
  })
})

describe('step ⑤b: what the app is answered, one lock with the operator runs', () => {
  it('a Skill run\'s start answers the approved declaration\'s after-read and never-read addresses (an ad-hoc plan none)', async () => {
    put(`${yaml}never_read: [ "/api/orders/{n}?copy=1" ]\nafter_read: [ "/api/orders/{created}" ]\n`)
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(run.afterRead).toEqual(['/api/orders/{created}'])
    expect(run.neverRead).toEqual(['/api/orders/{n}?copy=1'])
    value(frames.end(alice, run.runId))
    const plan = value(await frames.start(alice, { plan: adhoc }, PC))
    expect([plan.afterRead, plan.neverRead]).toEqual([[], []])
    // `get` never answers them (nor the approval value): the start is the app's one source.
    expect(Object.keys(value(frames.get(alice, plan.runId)))).not.toContain('afterRead')
  })

  it('a frames run never starts while an operator run holds the domain; `holderOn` names the run holding it for the operator runs', async () => {
    let operatorRunning = true
    const withRuns = createBrowserFrameService({
      companyData: sqliteCompanyData(conn), transactions: sqliteTransactions(conn), clock: { now: () => iso(now), nowMs: () => now },
      ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }, tokenDigest: sha256TokenDigest,
      monotonic: { bootId: 'boot-1', monoMs: () => now - monoBase }, browserPolicy: () => policy, aiStops: () => ({ all: false, tools: [] }),
      devices: { check: (_m, key) => ({ ok: true, value: { deviceId: key === undefined ? null : `bd_${key}` } }) },
      siteGrants: { allows: () => true },
      skills: { approvedFrames: async () => { throw new Error('no skill here') }, stillApproved: () => false, runCardShown: () => {} },
      operatorRunOn: () => operatorRunning,
    })
    expect(code(await withRuns.start(alice, { plan: adhoc }, PC))).toBe('BROWSER_RUN_BUSY')
    expect(withRuns.holderOn(CO, DOMAIN)).toBeNull()
    operatorRunning = false
    const run = value(await withRuns.start(alice, { plan: adhoc }, PC))
    expect(withRuns.holderOn(CO, DOMAIN)).toEqual({ runId: run.runId, userId: alice.userId, source: 'adhoc', state: 'waiting', endsAt: now + BROWSER_FRAME_TIMES.approve })
    expect(withRuns.holderOn(CO, 'other.example.test')).toBeNull()
    // Ended with a write permitted: busy until it is recorded or times out.
    value(await withRuns.approve(alice, run.runId, { planHash: run.planHash, approvalToken: run.approvalToken }, PC))
    value(await withRuns.permit(alice, run.runId, { frame: 1, request: FITS[1] }, PC))
    value(withRuns.end(alice, run.runId))
    expect(withRuns.holderOn(CO, DOMAIN)).toBe('busy')
    value(withRuns.report(alice, run.runId, { write: 1, result: 'done' }, PC))
    expect(withRuns.holderOn(CO, DOMAIN)).toBeNull()
  })
})

describe('room for a Skill run: the operator run\'s budget is the server\'s choice (shared/core/browser-run-budget.ts)', () => {
  /** The real operator runs service joined to this frames service, as composition.ts wires them. */
  function operatorRuns(): BrowserRunService {
    return createBrowserRunService({
      companyData: sqliteCompanyData(conn), transactions: sqliteTransactions(conn), clock: { now: () => iso(now), nowMs: () => now },
      ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') },
      browserPolicy: () => policy, aiStops: () => ({ all: stopped, tools: [] }),
      devices: { check: (_m, key) => ({ ok: true, value: { deviceId: key === undefined ? null : `bd_${key}` } }) },
      siteGrants: { allows: (m, host, effect) => host === DOMAIN && (effect === 'read' ? level[m.userId] !== 'none' : level[m.userId] === 'write') },
      frameRunOn: (companyId, host) => frames.holderOn(companyId, host),
    })
  }
  const work = (runs: BrowserRunService, frameRunId: string, write = true) =>
    value(runs.start(alice, { host: DOMAIN, frameRunId, ...(write ? { write: true } : {}) }, PC))
  /** Continues until the server refuses one: how many steps the run was given. */
  function stepsGiven(runs: BrowserRunService, runId: string): number {
    let n = 0
    while (n < 100 && runs.continue(alice, runId, PC).ok) n++
    return n
  }
  const runRow = (id: string) => conn.prepare('SELECT state, reason, budget FROM browser_runs WHERE id = ?').get(id)

  it('an approved company Skill\'s work gets the skill budget: 60 steps and 17 minutes; its preview stays standard', async () => {
    put(yaml)
    await approveSkill('per_run')
    const runs = operatorRuns()
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    // The preview (the frames run still waiting for the card): standard.
    const preview = work(runs, run.runId)
    expect(preview.budget).toBe('standard')
    value(runs.finish(alice, preview.runId, { outcome: 'done', steps: [] }))
    value(await approve(alice, run))
    const worked = work(runs, run.runId)
    expect(worked.budget).toBe('skill')
    expect(stepsGiven(runs, worked.runId)).toBe(BROWSER_RUN_BUDGETS.skill.steps)
    expect(runRow(worked.runId)).toEqual({ state: 'timed_out', reason: 'rounds', budget: 'skill' })
  })

  it('a skill run\'s lock lasts its 17 minutes (renewed), where a standard one ends at 6', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const runs = operatorRuns()
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    const worked = work(runs, run.runId)
    expect(worked.budget).toBe('skill')
    const startedAt = now
    while (now - startedAt < BROWSER_RUN_BUDGETS.skill.runMs - 60_000) {
      now += 60_000
      expect(runs.continue(alice, worked.runId, PC).ok).toBe(true)
    }
    now = startedAt + BROWSER_RUN_BUDGETS.skill.runMs
    expect(code(runs.continue(alice, worked.runId, PC))).toBe('BROWSER_RUN_ENDED')
    expect(runRow(worked.runId)).toMatchObject({ state: 'timed_out', reason: 'timeout' })
  })

  it('an ad-hoc plan\'s work, a read-only run naming a Skill run, and a run naming nothing stay standard: 20 steps, 6 minutes', async () => {
    const runs = operatorRuns()
    const adhocRun = await openAdhoc()
    const adhocWork = work(runs, adhocRun.runId)
    expect(adhocWork.budget).toBe('standard')
    expect(stepsGiven(runs, adhocWork.runId)).toBe(BROWSER_RUN_BUDGETS.standard.steps)
    value(frames.end(alice, adhocRun.runId))
    // An open Skill run named by a run that is not a write task's.
    put(yaml)
    await approveSkill('pre_approved')
    const skillRun = value(await frames.start(alice, { skill: SKILL }, PC))
    const reading = work(runs, skillRun.runId, false)
    expect(reading.budget).toBe('standard')
    now += BROWSER_RUN_BUDGETS.standard.runMs
    expect(code(runs.continue(alice, reading.runId, PC))).toBe('BROWSER_RUN_ENDED')
    value(frames.end(alice, skillRun.runId))
    const plain = value(runs.start(alice, { host: DOMAIN, write: true }, PC))
    expect(plain.budget).toBe('standard')
  })

  it('the skill budget once per frames run: a second write run naming it is refused, while the first runs and after it finished', async () => {
    put(yaml)
    await approveSkill('pre_approved')
    const runs = operatorRuns()
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    const first = work(runs, run.runId)
    expect(first.budget).toBe('skill')
    expect(code(runs.start(alice, { host: DOMAIN, frameRunId: run.runId, write: true }, PC))).toBe('BROWSER_RUN_WORK_TAKEN')
    value(runs.finish(alice, first.runId, { outcome: 'done', steps: [] }))
    expect(code(runs.start(alice, { host: DOMAIN, frameRunId: run.runId, write: true }, PC))).toBe('BROWSER_RUN_WORK_TAKEN')
    expect(conn.prepare("SELECT COUNT(*) AS n FROM browser_runs WHERE frame_run_id = ? AND budget = 'skill'").get(run.runId)).toEqual({ n: 1 })
    // The database refuses a second skill run of one frames run by itself (behind the service's check).
    expect(() => conn.prepare(`INSERT INTO browser_runs (company_id, id, user_id, host, state, reason, started_at, lease_until, ended_at, budget, frame_run_id)
      VALUES (?, 'bo_x', ?, ?, 'done', NULL, ?, ?, ?, 'skill', ?)`).run(CO, alice.userId, DOMAIN, iso(now), iso(now), iso(now), run.runId)).toThrow(/UNIQUE/)
    // A run that is not a write task's still starts (standard, as any read).
    expect(value(runs.start(alice, { host: DOMAIN, frameRunId: run.runId }, PC)).budget).toBe('standard')
  })

  it('a run never outlives the frames run it names: a work started late gets what is left; too little left is refused (時間切れ)', async () => {
    put(yaml)
    await approveSkill('per_run')
    const runs = operatorRuns()
    const madeAt = now
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    // Approved at the card's last moment, the work started 11 minutes later (slow reads before it).
    now = madeAt + BROWSER_FRAME_TIMES.approve - 1_000
    value(await approve(alice, run))
    now += 11 * 60_000
    const late = work(runs, run.runId)
    expect(late.budget).toBe('skill')
    const frameEnd = madeAt + BROWSER_FRAME_TIMES.run
    const margin = BROWSER_RUN_BUDGETS.skill.runMs - BROWSER_RUN_BUDGETS.skill.operateMs
    expect(late.operateMs).toBe(frameEnd - now - margin)
    expect(conn.prepare('SELECT ends_at FROM browser_runs WHERE id = ?').get(late.runId)).toEqual({ ends_at: iso(frameEnd) })
    // Renewed to the end, never past it: the lock ends with the frames run.
    while (now < frameEnd - 60_000) { now += 60_000; expect(runs.continue(alice, late.runId, PC).ok).toBe(true) }
    now = frameEnd
    expect(code(runs.continue(alice, late.runId, PC))).toBe('BROWSER_RUN_ENDED')
    value(frames.end(alice, run.runId))

    // Another run: started with less than a minute of operating left → refused, nothing started.
    const madeAt2 = now
    const run2 = value(await frames.start(alice, { skill: SKILL }, PC))
    value(await approve(alice, run2))
    now = madeAt2 + BROWSER_FRAME_TIMES.run - margin - BROWSER_RUN_MIN_OPERATE_MS + 1
    expect(code(runs.start(alice, { host: DOMAIN, frameRunId: run2.runId, write: true }, PC))).toBe('BROWSER_RUN_TOO_LATE')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_runs WHERE frame_run_id = ?').get(run2.runId)).toEqual({ n: 0 })
    now -= 2
    expect(work(runs, run2.runId).operateMs).toBe(BROWSER_RUN_MIN_OPERATE_MS + 1)
  })

  it('the app cannot ask for a budget: a body naming one is refused, and the stored budget never changes', async () => {
    const runs = operatorRuns()
    expect(code(runs.start(alice, { host: DOMAIN, write: true, budget: 'skill' }, PC))).toBe('BROWSER_BAD_RUN')
    const plain = value(runs.start(alice, { host: DOMAIN }, PC))
    expect(() => conn.prepare("UPDATE browser_runs SET budget = 'skill' WHERE id = ?").run(plain.runId)).toThrow(/only moves from running/)
    expect(() => conn.prepare('UPDATE browser_runs SET ends_at = ? WHERE id = ?').run(iso(now + 3_600_000), plain.runId)).toThrow(/only moves from running/)
    expect(() => conn.prepare("UPDATE browser_runs SET frame_run_id = 'bf_x' WHERE id = ?").run(plain.runId)).toThrow(/only moves from running/)
    expect(() => conn.prepare('UPDATE browser_runs SET steps = steps + 2 WHERE id = ?').run(plain.runId)).toThrow(/only moves from running/)
    expect(() => conn.prepare('UPDATE browser_runs SET steps = steps - 1 WHERE id = ?').run(plain.runId)).toThrow(/CHECK|only moves from running/)
  })
})

describe('recovering from a failed write: the site refused it; the person answers about one in doubt', () => {
  /** The person's answer from the card (this PC's key by default). */
  const confirm = (runId: string, write: number, answer: string, m: Member = alice, key: string | undefined = PC) =>
    frames.confirm(m, runId, { write, answer }, key)

  it('a write the site refused (4xx) is `refused`: never done, the run goes on, trying again is a new write within the frame\'s max', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    const refused = value(report(run.runId, 1, 'refused'))
    expect(refused.run.writes[0].state).toBe('refused')
    expect(refused.run.state).toBe('open')
    // The unit it took is not given back: frame 1 (max 2) has one left for the corrected try.
    expect(refused.run.frames[0]).toMatchObject({ used: 1, left: 1 })
    const again = value(await permit(run.runId, 1))
    expect(again.write).toBe(2)
    value(report(run.runId, 2, 'done'))
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_FRAME_USED_UP')
    expect(value(frames.get(alice, run.runId)).writes.map(w => w.state)).toEqual(['refused', 'done'])
  })

  it('`refused` is a sure answer: only from the run\'s own PC; a late one after unknown keeps the run locked', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    expect(code(report(run.runId, 1, 'refused', alice, 'other-pc'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    value(report(run.runId, 1, 'unknown'))
    const late = value(report(run.runId, 1, 'refused'))
    expect(late.run.writes[0].state).toBe('refused')
    expect(late.run.state).toBe('locked')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
  })

  it('the person answers about a write in doubt once, past its window, from the run\'s own PC; who and when are kept', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'unknown'))
    const seen = value(frames.get(alice, run.runId)).writes[0]
    expect(seen.confirmableAt).toBe(iso(Date.parse(seen.permittedAt) + 35_000))
    expect(seen.confirmed).toBeNull()
    // It may still be on its way: too early.
    expect(code(confirm(run.runId, 1, 'not_done'))).toBe('BROWSER_TOO_EARLY')
    now += 35_000
    expect(code(confirm(run.runId, 1, 'not_done', alice, 'other-pc'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(code(confirm(run.runId, 1, 'not_done', bob))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(confirm(run.runId, 1, 'maybe'))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(frames.confirm(alice, run.runId, { write: 1, answer: 'not_done', unlock: true }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    const answered = value(confirm(run.runId, 1, 'not_done'))
    expect(answered.writes[0]).toMatchObject({ state: 'unknown', confirmed: { answer: 'not_done', by: alice.userId, at: iso(now) }, confirmableAt: null })
    expect(code(confirm(run.runId, 1, 'done'))).toBe('BROWSER_FRAME_CONFIRMED')
    // The answer never unlocks the run: nothing more is permitted in it.
    expect(answered.state).toBe('locked')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
    // And no later report changes what the person said.
    expect(value(report(run.runId, 1, 'done')).outcome).toBe('recorded')
    expect(value(frames.get(alice, run.runId)).writes[0].state).toBe('unknown')
  })

  it('only a write in doubt can be answered about; the answer is kept as given (table)', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'done'))
    now += 35_000
    expect(code(confirm(run.runId, 1, 'done'))).toBe('BROWSER_FRAME_NOT_UNKNOWN')
    expect(code(confirm(run.runId, 2, 'done'))).toBe('BROWSER_FRAME_WRITE_NOT_FOUND')
    value(await permit(run.runId, 1))
    value(report(run.runId, 2, 'unknown'))
    now += 35_000
    value(confirm(run.runId, 2, 'done'))
    expect(() => conn.prepare("UPDATE browser_frame_write_confirms SET answer = 'not_done'").run()).toThrow(/kept as given/)
    expect(() => conn.prepare('DELETE FROM browser_frame_write_confirms').run()).toThrow(/kept as given/)
  })

  it('the tables let a write move to `refused` only from permitted or unknown', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'done'))
    expect(() => conn.prepare("UPDATE browser_frame_writes SET state = 'refused' WHERE run_id = ?").run(run.runId)).toThrow(/state table/)
    value(await permit(run.runId, 1))
    value(report(run.runId, 2, 'refused'))
    expect(() => conn.prepare("UPDATE browser_frame_writes SET state = 'done' WHERE run_id = ? AND seq = 2").run(run.runId)).toThrow(/state table/)
  })

  it('a database from before: both tables rebuilt once with every row kept, ending like a new one; a later start changes nothing', () => {
    const before = new Database(':memory:')
    // Rows without their parents: only the two tables are under test here.
    before.pragma('foreign_keys = OFF')
    before.exec(readFileSync(new URL('../fixtures/browser-writes-before-refused.sql', import.meta.url), 'utf8'))
    before.prepare(`INSERT INTO browser_frame_writes (company_id, run_id, seq, frame_idx, state, permitted_at) VALUES ('co-1', 'bf_1', 1, 1, 'unknown', ?)`).run(iso(T0))
    before.prepare(`INSERT INTO browser_run_writes (company_id, run_id, idx, after_step, frame, method, page, outcome) VALUES ('co-1', 'bo_1', 1, 0, 1, 'POST', '/a', 'done')`).run()
    initDatabase(before)
    expect(before.prepare('SELECT state FROM browser_frame_writes').all()).toEqual([{ state: 'unknown' }])
    expect(before.prepare('SELECT outcome FROM browser_run_writes').all()).toEqual([{ outcome: 'done' }])
    const shape = (c: Database.Database) => c.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('browser_frame_writes', 'browser_run_writes') ORDER BY type, name").all()
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    expect(shape(before)).toEqual(shape(fresh))
    const execs: string[] = []
    const exec = before.exec.bind(before)
    before.exec = ((sql: string) => { execs.push(sql); return exec(sql) }) as typeof before.exec
    initDatabase(before)
    before.exec = exec
    expect(execs.filter(sql => /RENAME TO/.test(sql))).toEqual([])
    // The upgraded tables take the new words and keep the old rules.
    before.prepare("UPDATE browser_frame_writes SET state = 'refused'").run()
    expect(() => before.prepare("UPDATE browser_frame_writes SET state = 'done'").run()).toThrow(/state table/)
    before.prepare(`INSERT INTO browser_run_writes (company_id, run_id, idx, after_step, frame, method, page, outcome) VALUES ('co-1', 'bo_1', 2, 0, 1, 'POST', '/a', 'site-refused')`).run()
    expect(() => before.prepare('UPDATE browser_run_writes SET page = \'/b\'').run()).toThrow(/append-only/)
  })
})
