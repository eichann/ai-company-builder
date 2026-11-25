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
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { createBrowserSkillService, type BrowserSkillService } from '../../src/services/browser-skills'
import { BROWSER_FRAME_TIMES, createBrowserFrameService, type BrowserFrameService } from '../../src/services/browser-frames'
import type { BrowserSkillContent, BrowserSkillSource } from '../../src/ports/browser-skills'
import type { BrowserOperationSettings } from '../../../shared/core/browser-operation'
import type { BrowserFrameRunView } from '../../../shared/types/browser-frames'
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
    companyData: data, transactions: sqliteTransactions(conn), clock, ids,
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

async function openAdhoc(m: Member = alice): Promise<BrowserFrameRunView> {
  const run = value(await frames.start(m, { plan: adhoc }, PC))
  return value(await frames.approve(m, run.runId, { planHash: run.planHash }, PC))
}
const permit = (runId: string, frame: number, m: Member = alice) => frames.permit(m, runId, { frame }, PC)
const report = (runId: string, write: number, result: string, m: Member = alice) => frames.report(m, runId, { write, result })

describe('frames: a run of free operation', () => {
  it('an ad-hoc plan waits for the person to approve exactly what the card showed', async () => {
    const run = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(run).toMatchObject({ state: 'waiting', needsApproval: true, source: 'adhoc', approval: null })
    expect(run.frames.map(f => [f.frame, f.path, f.max, f.used])).toEqual([[1, '/api/orders/register', 2, 0], [2, '/api/orders/{n}/note', 1, 0]])
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_NOT_APPROVED')
    expect(code(await frames.approve(alice, run.runId, { planHash: `sha256:${'0'.repeat(64)}` }, PC))).toBe('BROWSER_FRAME_PLAN_CHANGED')
    const open = value(await frames.approve(alice, run.runId, { planHash: run.planHash }, PC))
    expect(open).toMatchObject({ state: 'open', approval: 'card' })
    expect(code(await permit(run.runId, 1))).toBe('ok')
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
    expect(code(await frames.permit(alice, run.runId, { frame: 1 }, 'pc-2'))).toBe('BROWSER_DEVICE_ELSEWHERE')
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
    expect(code(await frames.approve(alice, first.runId, { planHash: first.planHash, files: 'git:0000' }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    value(await frames.approve(alice, first.runId, { planHash: first.planHash }, PC))
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
    expect(code(await frames.approve(alice, run.runId, { planHash: run.planHash }, PC))).toBe('BROWSER_SKILL_CHANGED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    expect(value(await skills.approvedFrames(alice, SKILL)).needsRunCard).toBe(true)
  })

  it('another member\'s or company\'s run is not found', async () => {
    const run = await openAdhoc()
    expect(code(frames.get(bob, run.runId))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(await permit(run.runId, 1, bob))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
    expect(code(await frames.approve(bob, run.runId, { planHash: run.planHash }, PC))).toBe('BROWSER_FRAME_RUN_NOT_FOUND')
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
    expect(code(frames.report(alice, run.runId, { write: 1, result: 'verified' }))).toBe('BROWSER_FRAME_BAD_REQUEST')
  })

  it('the tables let a write move only forward', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1)); value(report(run.runId, 1, 'done'))
    expect(() => conn.prepare(`UPDATE browser_frame_writes SET state = 'permitted' WHERE company_id = ? AND run_id = ?`).run(CO, run.runId)).toThrow()
    value(frames.end(alice, run.runId))
    expect(() => conn.prepare(`UPDATE browser_frame_runs SET state = 'open', ended_at = NULL WHERE company_id = ? AND id = ?`).run(CO, run.runId)).toThrow()
  })
})
