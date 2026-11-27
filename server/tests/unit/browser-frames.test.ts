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
import { BROWSER_FRAME_TIMES, WORK_ENDED, createBrowserFrameService, type BrowserFrameService } from '../../src/services/browser-frames'
import { BROWSER_RUN_LIMITS } from '../../../shared/core/browser-run-log'
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
/** The company's Skill by its path (what a run keeps), and a department's of the same name (agent-browser.md "Department Skills"). */
const SKILL_P = `.claude/skills/${SKILL}`
const DEPT_P = `営業/.claude/skills/${SKILL}`
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
/** Who does not read the department 営業 now (the core's read rules, as a test sets them). */
let notReadingSales: Set<string>
let frames: BrowserFrameService
const iso = (ms: number) => new Date(ms).toISOString()
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')

const source: BrowserSkillSource = {
  list: async companyId => ({ paths: Object.keys(store[companyId] ?? {}).sort(), complete: true }),
  withName: async (companyId, name) => ({ paths: Object.keys(store[companyId] ?? {}).filter(p => p.endsWith(`/${name}`)).sort(), complete: true }),
  read: async (companyId, path) => store[companyId]?.[path] ?? null,
  pushed: async () => [],
  shelfLanded: async () => null,
  // Each folder version's step files, as `put` wrote them (null: that version cannot be read).
  stepFiles: async (_companyId, content) => (content.files in stepFiles ? stepFiles[content.files] : null),
}
/** The step files of each folder version (`SKILL.md` holds the text `put` was given). */
let stepFiles: Record<string, Array<{ name: 'SKILL.md' | 'site-notes.md'; text: string } | { name: 'SKILL.md' | 'site-notes.md'; tooLarge: true }> | null> = {}
function put(declaration: string, text = 'v1', path = SKILL_P) {
  const files = `git:${sha(`${path}\0${declaration}\0${text}`).slice(0, 40)}`
  store[CO] = { ...(store[CO] ?? {}), [path]: { path, declaration, files } }
  stepFiles[files] = [{ name: 'SKILL.md', text }]
}
async function approveSkill(mode: 'per_run' | 'pre_approved', path = SKILL_P) {
  const item = (await skills.list(owner) as { ok: true; value: { items: Array<{ path: string; declarationHash: string; files: string }> } }).value.items.find(i => i.path === path)!
  value(await skills.approve(owner, { skill: path, declarationHash: item.declarationHash, files: item.files, mode }))
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
  stepFiles = {}
  policy = { mode: 'on', sites: [{ host: DOMAIN, level: 'write', assetHosts: [] }] }
  stopped = false
  level = { [alice.userId]: 'write', [bob.userId]: 'write', [owner.userId]: 'write', [otherOwner.userId]: 'write' }
  betweenReadAndWrite = null
  notReadingSales = new Set([bob.userId])
  const data = sqliteCompanyData(conn)
  const clock = { now: () => iso(now), nowMs: () => now }
  const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
  skills = createBrowserSkillService({
    companyData: data, clock, ids, memberships: sqliteMembershipRepository(conn),
    accounts: { byIds: list => new Map(list.map(id => [id, { name: id, email: `${id}@example.test` }])) },
    source, registeredHosts: () => policy.sites.map(s => s.host), sha256: sha,
    // Bob does not read the department 営業 (alice and owners / admins do), unless a test changes it.
    readsPath: (m, path) => !(notReadingSales.has(m.userId) && path.startsWith('営業/')),
  })
  frames = makeFrames()
})

/** The frames service as each test builds it (`extra`: the operator runs joined, as composition.ts wires them). */
function makeFrames(extra: Partial<Parameters<typeof createBrowserFrameService>[0]> = {}): BrowserFrameService {
  const data = sqliteCompanyData(conn)
  const clock = { now: () => iso(now), nowMs: () => now }
  const ids = { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') }
  return createBrowserFrameService({
    companyData: data, transactions: sqliteTransactions(conn), clock, ids, tokenDigest: sha256TokenDigest,
    monotonic: { bootId: 'boot-1', monoMs: () => now - monoBase },
    browserPolicy: () => policy,
    aiStops: () => ({ all: stopped, tools: [] }),
    // This PC: the key names the registration (absent = the owner transition, here for anyone: no registration).
    devices: { check: (_m, key) => ({ ok: true, value: { deviceId: key === undefined ? null : `bd_${key}` } }) },
    siteGrants: { allows: (m, host, effect) => host === DOMAIN && (effect === 'read' ? level[m.userId] !== 'none' : level[m.userId] === 'write') },
    skills: {
      resolve: (m, s) => skills.resolve(m, s),
      approvedFrames: async (m, s) => { const r = await skills.approvedFrames(m, s); betweenReadAndWrite?.(); return r },
      stillApproved: (m, s, h, a) => skills.stillApproved(m, s, h, a),
      runCardShown: (m, s, h, f) => skills.runCardShown(m, s, h, f),
      stepsSeal: (m, s, f) => skills.stepsSeal(m, s, f),
    },
    ...extra,
  })
}

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
      [1, { method: 'POST', path: '/api/orders/register?copy=1', fields: {} }, 'query'],
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
      const item = store[CO][SKILL_P]
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
      const item = store[CO][SKILL_P]
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

  it('a Skill run\'s start seals its steps at the folder version its frames come from; unreadable starts nothing; an ad-hoc plan has none', async () => {
    put(yaml, '手順 v1')
    await approveSkill('pre_approved')
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    // Exactly the text the app hands the operator: `# SKILL.md\n<text>`.
    expect(run.steps).toEqual({ state: 'sealed', hash: `sha256:${sha('# SKILL.md\n手順 v1')}` })
    value(frames.end(alice, run.runId))
    // Too large on the server: said so (the app does not start).
    stepFiles[store[CO][SKILL_P].files] = [{ name: 'SKILL.md', tooLarge: true }]
    const large = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(large.steps).toEqual({ state: 'too-large' })
    value(frames.end(alice, large.runId))
    // No step files: none.
    stepFiles[store[CO][SKILL_P].files] = []
    const none = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(none.steps).toEqual({ state: 'none' })
    value(frames.end(alice, none.runId))
    // That version cannot be read: nothing is started (never a seal of something else).
    stepFiles[store[CO][SKILL_P].files] = null
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_CHANGED')
    const adhocRun = value(await frames.start(alice, { plan: adhoc }, PC))
    expect('steps' in adhocRun).toBe(false)
  })

  it('a pre-approved Skill needs no card; a per-run one does', async () => {
    put(yaml)
    await approveSkill('per_run')
    const perRun = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(perRun).toMatchObject({ state: 'waiting', needsApproval: true, source: 'skill', skill: SKILL_P })
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
      skills: { resolve: async () => { throw new Error('no skill here') }, approvedFrames: async () => { throw new Error('no skill here') }, stillApproved: () => false, runCardShown: () => {}, stepsSeal: async () => null },
      operatorRunOn: () => (operatorRunning ? { until: now + 60_000 } : null),
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

  it('an approved company Skill\'s work gets the skill budget: 60 steps and 17 minutes; its preview its own skill_preview allowance (40 steps), which never takes the work', async () => {
    put(yaml)
    await approveSkill('per_run')
    const runs = operatorRuns()
    const run = value(await frames.start(alice, { skill: SKILL }, PC))
    // The preview (the frames run still waiting for the card): skill_preview, its whole budget of steps and time.
    const preview = work(runs, run.runId)
    expect(preview.budget).toBe('skill_preview')
    expect(preview.operateMs).toBe(BROWSER_RUN_BUDGETS.skill_preview.operateMs)
    expect(stepsGiven(runs, preview.runId)).toBe(BROWSER_RUN_BUDGETS.skill_preview.steps)
    expect(runRow(preview.runId)).toEqual({ state: 'timed_out', reason: 'rounds', budget: 'skill_preview' })
    // The waiting frames run outlives a whole preview (it was made before it) and still waits for the card after it.
    now += BROWSER_RUN_BUDGETS.skill_preview.runMs
    expect(value(frames.get(alice, run.runId)).state).toBe('waiting')
    // The work is still the first `skill` run of this frames run.
    expect(conn.prepare("SELECT COUNT(*) AS n FROM browser_runs WHERE frame_run_id = ? AND budget = 'skill'").get(run.runId)).toEqual({ n: 0 })
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
    now = madeAt + BROWSER_FRAME_TIMES.approveSkill - 1_000
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

describe('letting a domain go: a Skill run whose one work run is over (agent-browser.md "Letting a domain go")', () => {
  // The incident of 2026-11-27: the work run stopped in the app at the moment the network dropped; its finish never
  // arrived, the operator run kept saying `running` past its lease and the open frames run held the domain to its hour.
  let runs: BrowserRunService
  let joined: BrowserFrameService
  beforeEach(() => {
    joined = makeFrames({
      operatorRunOn: (companyId, host) => runs.runningOn(companyId, host),
      workRunOver: (companyId, frameRunId) => runs.workRunOver(companyId, frameRunId),
    })
    runs = createBrowserRunService({
      companyData: sqliteCompanyData(conn), transactions: sqliteTransactions(conn), clock: { now: () => iso(now), nowMs: () => now },
      ids: { newId: () => randomBytes(8).toString('hex'), newToken: () => randomBytes(32).toString('hex') },
      browserPolicy: () => policy, aiStops: () => ({ all: stopped, tools: [] }),
      devices: { check: (_m, key) => ({ ok: true, value: { deviceId: key === undefined ? null : `bd_${key}` } }) },
      siteGrants: { allows: (m, host, effect) => host === DOMAIN && (effect === 'read' ? level[m.userId] !== 'none' : level[m.userId] === 'write') },
      frameRunOn: (companyId, host) => joined.holderOn(companyId, host),
    })
  })
  const runState = (id: string) => conn.prepare('SELECT state, end_reason AS reason FROM browser_frame_runs WHERE id = ?').get(id)
  const jpermit = (runId: string, frame: number) => joined.permit(alice, runId, { frame, request: FITS[frame] }, PC)
  const jreport = (runId: string, write: number, result: string) => joined.report(alice, runId, { write, result }, PC)
  async function skillWork() {
    put(yaml)
    await approveSkill('pre_approved')
    const run = value(await joined.start(alice, { skill: SKILL }, PC))
    const worked = value(runs.start(alice, { host: DOMAIN, frameRunId: run.runId, write: true }, PC))
    expect(worked.budget).toBe('skill')
    return { run, worked }
  }

  it('the work run lost with the network: busy (with when it frees) until its lease runs out, then free at once, not at the hour', async () => {
    const { run, worked } = await skillWork()
    // While the work run's lease lasts the domain is held, and the refusal says the latest it frees up.
    now += BROWSER_RUN_LIMITS.leaseMs - 1
    const busy = await joined.start(bob, { plan: adhoc }, PC)
    expect(code(busy)).toBe('BROWSER_RUN_BUSY')
    expect((busy as Refusal).body.freeAt).toBe(iso(T0 + BROWSER_FRAME_TIMES.run))
    // Past the lease (no finish ever came): the operator run counts as ended, the frames run ends `work-ended`, the domain is free.
    now += 1
    const bobs = value(await joined.start(bob, { plan: adhoc }, PC))
    expect(runState(run.runId)).toEqual({ state: 'ended', reason: WORK_ENDED })
    expect(conn.prepare('SELECT state, reason FROM browser_runs WHERE id = ?').get(worked.runId)).toEqual({ state: 'timed_out', reason: 'timeout' })
    expect(bobs.state).toBe('waiting')
    // The ended run permits nothing (a late app asking gets "ended"); the list says the work run ended too.
    expect(code(await jpermit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
    expect(value(runs.list(alice)).runs.find(r => r.id === worked.runId)).toMatchObject({ state: 'timed_out', reason: 'timeout' })
  })

  it('a finished work run frees the domain at once (holderOn and the operator runs\' start), whatever the app does next', async () => {
    const { run, worked } = await skillWork()
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: run.runId })
    value(runs.finish(alice, worked.runId, { outcome: 'stopped', reason: 'no-answer', steps: [] }))
    expect(joined.holderOn(CO, DOMAIN)).toBeNull()
    expect(runState(run.runId)).toEqual({ state: 'ended', reason: WORK_ENDED })
    expect(value(runs.start(bob, { host: DOMAIN }, PC)).budget).toBe('standard')
    // The app's own end afterwards (or again) changes nothing.
    expect(value(joined.end(alice, run.runId))).toMatchObject({ state: 'ended', endReason: WORK_ENDED })
  })

  it('a write on its way keeps the domain until it is recorded; a write in doubt keeps it to the hour, as before', async () => {
    const { run, worked } = await skillWork()
    value(await jpermit(run.runId, 1))
    value(runs.finish(alice, worked.runId, { outcome: 'stopped', steps: [] }))
    // Permitted (it may be on its way): held, busy.
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: run.runId })
    expect(code(await joined.start(bob, { plan: adhoc }, PC))).toBe('BROWSER_RUN_BUSY')
    // Unknown (the run locked): still held — never let go while a write is in doubt.
    value(jreport(run.runId, 1, 'unknown'))
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: run.runId, state: 'locked' })
    now = T0 + BROWSER_FRAME_TIMES.run - 1
    expect(code(await joined.start(bob, { plan: adhoc }, PC))).toBe('BROWSER_RUN_BUSY')
    now += 1
    expect(value(await joined.start(bob, { plan: adhoc }, PC)).state).toBe('waiting')
    expect(runState(run.runId)).toEqual({ state: 'ended', reason: 'expired' })
  })

  it('a done write then the work\'s end: free; before the work starts, a waiting card or an ad-hoc plan: held as before', async () => {
    const { run, worked } = await skillWork()
    value(await jpermit(run.runId, 1))
    value(jreport(run.runId, 1, 'done'))
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: run.runId })
    value(runs.finish(alice, worked.runId, { outcome: 'done', steps: [] }))
    expect(joined.holderOn(CO, DOMAIN)).toBeNull()

    // A pre-approved run whose work has not started yet: held.
    const second = value(await joined.start(alice, { skill: SKILL }, PC))
    now += 20 * 60_000
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: second.runId, state: 'open' })
    value(joined.end(alice, second.runId))
    // A per-run Skill's card up after its preview finished: held (the card waits for the person).
    await approveSkill('per_run')
    const waiting = value(await joined.start(alice, { skill: SKILL }, PC))
    const preview = value(runs.start(alice, { host: DOMAIN, frameRunId: waiting.runId, write: true }, PC))
    value(runs.finish(alice, preview.runId, { outcome: 'done', steps: [] }))
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: waiting.runId, state: 'waiting' })
    value(joined.end(alice, waiting.runId))
    // An ad-hoc plan's work (no once-rule there): held to its hour, as before.
    const started = value(await joined.start(alice, { plan: adhoc }, PC))
    const plan = value(await joined.approve(alice, started.runId, { planHash: started.planHash, approvalToken: started.approvalToken }, PC))
    const adhocWork = value(runs.start(alice, { host: DOMAIN, frameRunId: plan.runId, write: true }, PC))
    value(runs.finish(alice, adhocWork.runId, { outcome: 'done', steps: [] }))
    expect(joined.holderOn(CO, DOMAIN)).toMatchObject({ runId: plan.runId, state: 'open' })
  })

  it('the busy answers say when the holder frees up at the latest', async () => {
    const { worked } = await skillWork()
    const refusedByFrames = runs.start(bob, { host: DOMAIN }, PC)
    expect(code(refusedByFrames)).toBe('BROWSER_RUN_BUSY')
    expect((refusedByFrames as Refusal).body.freeAt).toBe(iso(T0 + BROWSER_FRAME_TIMES.run))
    value(runs.finish(alice, worked.runId, { outcome: 'done', steps: [] }))
    // An operator run holding the domain: its hard end, from both kinds of start.
    value(runs.start(alice, { host: DOMAIN }, PC))
    const refused = runs.start(bob, { host: DOMAIN }, PC)
    expect(code(refused)).toBe('BROWSER_RUN_BUSY')
    expect((refused as Refusal).body.freeAt).toBe(iso(now + BROWSER_RUN_BUDGETS.standard.runMs))
    const framesRefused = await joined.start(bob, { plan: adhoc }, PC)
    expect((framesRefused as Refusal).body.freeAt).toBe(iso(now + BROWSER_RUN_BUDGETS.standard.runMs))
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
    // The same answer again (ours lost on the way back): answered as kept, still once, still by the first press.
    now += 1_000
    expect(value(confirm(run.runId, 1, 'not_done')).writes[0].confirmed).toEqual({ answer: 'not_done', by: alice.userId, at: iso(now - 1_000) })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_frame_write_confirms').get()).toEqual({ n: 1 })
    // The answer never unlocks the run: nothing more is permitted in it.
    expect(answered.state).toBe('locked')
    expect(code(await permit(run.runId, 2))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
    // And no later report changes what the person said: one that agrees is kept, one that contradicts is refused and noted.
    expect(value(report(run.runId, 1, 'refused')).outcome).toBe('recorded')
    const warned: string[] = []
    const was = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    try {
      expect(code(report(run.runId, 1, 'done'))).toBe('BROWSER_REPORT_CONFLICT')
    } finally {
      console.warn = was
    }
    expect(warned).toEqual([`[browser-frames] run ${run.runId} write 1: a report "done" contradicts the person's answer "not_done"; kept as answered`])
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
    const shape = (c: Database.Database) => c.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('browser_frame_writes', 'browser_run_writes', 'browser_frame_made', 'browser_write_ledger') ORDER BY type, name").all()
    const fresh = new Database(':memory:')
    initDatabase(fresh)
    expect(shape(before)).toEqual(shape(fresh))
    const execs: string[] = []
    const exec = before.exec.bind(before)
    before.exec = ((sql: string) => { execs.push(sql); return exec(sql) }) as typeof before.exec
    initDatabase(before)
    before.exec = exec
    expect(execs.filter(sql => /RENAME TO/.test(sql))).toEqual([])
    // A row whose parent is gone (foreign keys on, as at startup) never stops the start: kept, counted in a log line.
    const orphaned = new Database(':memory:')
    orphaned.pragma('foreign_keys = OFF')
    orphaned.exec(readFileSync(new URL('../fixtures/browser-writes-before-refused.sql', import.meta.url), 'utf8'))
    orphaned.prepare(`INSERT INTO browser_frame_writes (company_id, run_id, seq, frame_idx, state, permitted_at) VALUES ('co-1', 'bf_gone', 1, 1, 'done', ?)`).run(iso(T0))
    orphaned.pragma('foreign_keys = ON')
    const warned: string[] = []
    const was = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    try {
      initDatabase(orphaned)
    } finally {
      console.warn = was
    }
    expect(orphaned.prepare('SELECT run_id FROM browser_frame_writes').all()).toEqual([{ run_id: 'bf_gone' }])
    expect(warned).toContain('[db] browser_frame_writes: 1 row(s) without their parent kept as they were')
    expect(orphaned.pragma('foreign_keys', { simple: true })).toBe(1)
    // The upgraded tables take the new words and keep the old rules.
    before.prepare("UPDATE browser_frame_writes SET state = 'refused'").run()
    expect(() => before.prepare("UPDATE browser_frame_writes SET state = 'done'").run()).toThrow(/state table/)
    before.prepare(`INSERT INTO browser_run_writes (company_id, run_id, idx, after_step, frame, method, page, outcome) VALUES ('co-1', 'bo_1', 2, 0, 1, 'POST', '/a', 'site-refused')`).run()
    expect(() => before.prepare('UPDATE browser_run_writes SET page = \'/b\'').run()).toThrow(/append-only/)
  })
})

describe('frames: writes only to what this run made ({made:<id>})', () => {
  // A plan is made (frame 1, the site answers its id), then items are added to that plan only (frame 2).
  const madeYaml = `domain: ${DOMAIN}\nwrites:\n  - id: new-plan\n    method: POST\n    path: /api/plans\n    max: 2\n  - method: POST\n    path: "/api/plans/{made:new-plan}/items"\n    max: 2\n`
  const item = (id: string): BrowserFramePermitRequest => ({ method: 'POST', path: `/api/plans/${id}/items`, fields: {} })
  const MAKE: BrowserFramePermitRequest = { method: 'POST', path: '/api/plans', fields: {} }
  const done = (runId: string, write: number, created?: string, key: string | undefined = PC) =>
    frames.report(alice, runId, { write, result: 'done', ...(created !== undefined ? { created } : {}) }, key)
  const madeRows = () => conn.prepare('SELECT run_id, seq, frame_idx, made FROM browser_frame_made ORDER BY run_id, seq').all()
  async function openMade(): Promise<BrowserFrameRunView> {
    put(madeYaml)
    await approveSkill('per_run')
    return value(await approve(alice, value(await frames.start(alice, { skill: SKILL }, PC))))
  }
  const reason = (r: Outcome<unknown>) => [code(r as Refusal), (r as Refusal).body?.reason]

  it('the frames carry the maker\'s place, and nothing fits {made} before the maker\'s write is done with an id', async () => {
    const run = await openMade()
    expect(run.frames.map(f => f.path)).toEqual(['/api/plans', '/api/plans/{made:1}/items'])
    expect(reason(await permit(run.runId, 2, alice, item('77')))).toEqual(['BROWSER_FRAME_MISMATCH', 'made'])
    expect(value(await permit(run.runId, 1, alice, MAKE)).write).toBe(1)
    value(await done(run.runId, 1, '77'))
    expect(madeRows()).toEqual([{ run_id: run.runId, seq: 1, frame_idx: 1, made: '77' }])
    // Only that id: another plan (one the person or an earlier run made) is never written.
    expect(reason(await permit(run.runId, 2, alice, item('78')))).toEqual(['BROWSER_FRAME_MISMATCH', 'made'])
    expect(reason(await permit(run.runId, 2, alice, { method: 'POST', path: '/api/plans/77/other', fields: {} }))).toEqual(['BROWSER_FRAME_MISMATCH', 'path'])
    value(await permit(run.runId, 2, alice, item('77')))
    value(await done(run.runId, 2))
    // `max` still applies.
    value(await permit(run.runId, 2, alice, item('77')))
    value(await done(run.runId, 3))
    expect(code(await permit(run.runId, 2, alice, item('77')))).toBe('BROWSER_FRAME_USED_UP')
    expect(value(frames.get(alice, run.runId)).frames.map(f => f.used)).toEqual([1, 2])
  })

  /** An ad-hoc plan without `{made}` (every run not ended is ended first: one run per domain). */
  async function openPlain(): Promise<BrowserFrameRunView> {
    for (const r of conn.prepare("SELECT id FROM browser_frame_runs WHERE state <> 'ended'").all() as Array<{ id: string }>) value(frames.end(alice, r.id))
    const plan = { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/plans', max: 1 }] }
    return value(await approve(alice, value(await frames.start(alice, { plan }, PC))))
  }

  it('an ad-hoc plan (the AI wrote it) never carries {made}: refused at its start', async () => {
    const plan = { domain: DOMAIN, writes: [{ id: 'p', method: 'POST', path: '/api/plans', max: 1 }, { method: 'POST', path: '/api/plans/{made:p}/items', max: 1 }] }
    expect(code(await frames.start(alice, { plan }, PC))).toBe('BROWSER_FRAME_BAD_PLAN')
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_frame_runs').get()).toEqual({ n: 0 })
  })

  it('a done without an id records nothing; an id only with done, only a plain token — of any frame (the run\'s promise counts it as made here)', async () => {
    const run = await openMade()
    value(await permit(run.runId, 1, alice, MAKE))
    for (const body of [
      { write: 1, result: 'unknown', created: '77' },
      { write: 1, result: 'refused', created: '77' },
      { write: 1, result: 'done', created: '../x' },
      { write: 1, result: 'done', created: '' },
      { write: 1, result: 'done', created: 'a'.repeat(65) },
      { write: 1, result: 'done', created: 77 },
    ]) expect(code(frames.report(alice, run.runId, body, PC)), JSON.stringify(body)).toBe('BROWSER_FRAME_BAD_REQUEST')
    value(await done(run.runId, 1))
    expect(madeRows()).toEqual([])
    expect(reason(await permit(run.runId, 2, alice, item('77')))).toEqual(['BROWSER_FRAME_MISMATCH', 'made'])
    // A frame no later frame names keeps what it made too (agent-browser.md "The run's promise": a target this run made); a
    // `{made:<n>}` frame still fits only its own maker's (the run above).
    const other = await openPlain()
    value(await permit(other.runId, 1, alice, MAKE))
    value(await done(other.runId, 1, '5'))
    expect(madeRows()).toEqual([{ run_id: other.runId, seq: 1, frame_idx: 1, made: '5' }])
  })

  it('an unknown write gives no id, a late done after it neither; a refused one none, its retry that is done does', async () => {
    const run = await openMade()
    value(await permit(run.runId, 1, alice, MAKE))
    value(await report(run.runId, 1, 'refused'))
    value(await permit(run.runId, 1, alice, MAKE))
    value(await done(run.runId, 2, 'p9'))
    value(await permit(run.runId, 2, alice, item('p9')))
    value(await report(run.runId, 3, 'unknown'))
    expect(madeRows()).toEqual([{ run_id: run.runId, seq: 2, frame_idx: 1, made: 'p9' }])
    value(frames.end(alice, run.runId))
    const second = value(await approve(alice, value(await frames.start(alice, { skill: SKILL }, PC))))
    // Another run never inherits what an earlier run made.
    expect(reason(await permit(second.runId, 2, alice, item('p9')))).toEqual(['BROWSER_FRAME_MISMATCH', 'made'])
    value(await permit(second.runId, 1, alice, MAKE))
    value(await report(second.runId, 1, 'unknown'))
    value(await done(second.runId, 1, 'p10'))
    expect(madeRows()).toEqual([{ run_id: run.runId, seq: 2, frame_idx: 1, made: 'p9' }])
  })

  it('the same done again is the same only with the same id; a done from another PC records nothing', async () => {
    const run = await openMade()
    value(await permit(run.runId, 1, alice, MAKE))
    expect(code(await done(run.runId, 1, '77', 'pc-other'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    expect(madeRows()).toEqual([])
    expect(value(await done(run.runId, 1, '77')).outcome).toBe('applied')
    expect(value(await done(run.runId, 1, '77')).outcome).toBe('same')
    expect(code(await done(run.runId, 1, '78'))).toBe('BROWSER_REPORT_CONFLICT')
    expect(code(await done(run.runId, 1))).toBe('BROWSER_REPORT_CONFLICT')
    expect(madeRows()).toEqual([{ run_id: run.runId, seq: 1, frame_idx: 1, made: '77' }])
  })

  it('the table keeps an id only beside its done write, as reported', async () => {
    const run = await openMade()
    value(await permit(run.runId, 1, alice, MAKE))
    const insert = (seq: number, frame: number, made: string) => conn.prepare('INSERT INTO browser_frame_made (company_id, run_id, seq, frame_idx, made, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, run.runId, seq, frame, made, iso(now))
    expect(() => insert(1, 1, '77')).toThrow(/done write/)
    value(await done(run.runId, 1))
    expect(() => insert(1, 2, '77')).toThrow(/done write/)
    expect(() => insert(1, 1, 'a/b')).toThrow(/CHECK/)
    insert(1, 1, '77')
    expect(() => insert(1, 1, '78')).toThrow(/UNIQUE|PRIMARY/)
    expect(() => conn.prepare("UPDATE browser_frame_made SET made = '78'").run()).toThrow(/as reported/)
    expect(() => conn.prepare('DELETE FROM browser_frame_made').run()).toThrow(/as reported/)
  })
})

describe('frames: a write with an exact query (agent-browser.md "A write with an exact query")', () => {
  const queryYaml = (q: string) => `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: /api/labels, query: "${q}", max: 2 }\n  - { method: POST, path: /api/labels, max: 1 }\n`
  const at = (path: string): BrowserFramePermitRequest => ({ method: 'POST', path, fields: {} })
  const reason = (r: Outcome<unknown>) => [code(r as Refusal), (r as Refusal).body?.reason]
  async function openQuery(q = 'return') {
    put(queryYaml(q))
    await approveSkill('per_run')
    return value(await approve(alice, value(await frames.start(alice, { skill: SKILL }, PC))))
  }

  it('the frame carries its query; the permit takes exactly it and refuses every near miss, taking nothing', async () => {
    const run = await openQuery()
    expect(run.frames.map(f => [f.path, f.query])).toEqual([['/api/labels', 'return'], ['/api/labels', undefined]])
    expect('query' in run.frames[1]).toBe(false)
    for (const path of ['/api/labels', '/api/labels?', '/api/labels?return=', '/api/labels?return=1', '/api/labels?Return', '/api/labels?return&return',
      '/api/labels?return&x', '/api/labels?x&return', '/api/labels?%72eturn', '/api/labels?return;x', '/api/labels?return#x', '/api/labels?return+',
      '/api/labels?return&_method=DELETE', '/api/labels?_method=DELETE']) {
      expect([path, ...reason(await permit(run.runId, 1, alice, at(path)))]).toEqual([path, 'BROWSER_FRAME_MISMATCH', 'query'])
    }
    expect(reason(await permit(run.runId, 1, alice, at('/api/labels/x?return')))).toEqual(['BROWSER_FRAME_MISMATCH', 'path'])
    // The frame without a query beside it refuses any query, as before.
    expect(reason(await permit(run.runId, 2, alice, at('/api/labels?return')))).toEqual(['BROWSER_FRAME_MISMATCH', 'query'])
    expect(value(frames.get(alice, run.runId)).frames.map(f => f.used)).toEqual([0, 0])
    expect(value(await permit(run.runId, 1, alice, at('/api/labels?return'))).frame).toBe(1)
    value(report(run.runId, 1, 'done'))
    expect(value(await permit(run.runId, 2, alice, at('/api/labels'))).frame).toBe(2)
  })

  it('another query is another declaration: approved anew, a run on the old one ends, and the plan\'s hash moves', async () => {
    const run = await openQuery('return')
    put(queryYaml('back'))
    expect(code(await permit(run.runId, 1, alice, at('/api/labels?return')))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_NOT_APPROVED')
    await approveSkill('per_run')
    const next = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(next.frames[0].query).toBe('back')
    expect(next.planHash).not.toBe(run.planHash)
  })

  it('a value not fixed (`return={x}`, "A query value not fixed"): one plain value fits, near misses take nothing; stored and read back as declared', async () => {
    const run = await openQuery('return={x}')
    expect(run.frames[0].query).toBe('return={x}')
    // The column keeps its alphabet (its CHECK cannot change): the placeholder is kept in a spelling the grammar never makes.
    expect(conn.prepare('SELECT query FROM browser_frames WHERE company_id = ? AND run_id = ? AND idx = 1').get(CO, run.runId)).toEqual({ query: 'return==x' })
    for (const path of ['/api/labels', '/api/labels?return', '/api/labels?return=', '/api/labels?return=%41', '/api/labels?return=a+b', '/api/labels?return=a;b',
      '/api/labels?return=a&x=1', '/api/labels?x=1&return=a', '/api/labels?return=a&return=b', '/api/labels?Return=a', '/api/labels?return=a=b',
      `/api/labels?return=${'a'.repeat(65)}`, '/api/labels?return=a&_method=DELETE']) {
      expect([path, ...reason(await permit(run.runId, 1, alice, at(path)))]).toEqual([path, 'BROWSER_FRAME_MISMATCH', 'query'])
    }
    expect(value(frames.get(alice, run.runId)).frames.map(f => f.used)).toEqual([0, 0])
    expect(value(await permit(run.runId, 1, alice, at('/api/labels?return=folder-7.v2'))).frame).toBe(1)
  })

  it('a placeholder value is another declaration than the bare name: approved anew', async () => {
    const run = await openQuery('return')
    put(queryYaml('return={x}'))
    expect(code(await permit(run.runId, 1, alice, at('/api/labels?return')))).toBe('BROWSER_SKILL_NOT_APPROVED')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_NOT_APPROVED')
  })

  it('an ad-hoc plan (the AI wrote it) may carry no query', async () => {
    const plan = { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/labels', query: 'return', max: 1 }] }
    expect(code(await frames.start(alice, { plan }, PC))).toBe('BROWSER_FRAME_BAD_PLAN')
  })

  it('the stored query is fixed and plain (trigger, CHECK); a frame row from before the column reads as no query', async () => {
    const run = await openQuery()
    expect(() => conn.prepare("UPDATE browser_frames SET query = 'x' WHERE company_id = ? AND run_id = ? AND idx = 1").run(CO, run.runId)).toThrow(/query never changes/)
    expect(() => conn.prepare("UPDATE browser_frames SET query = NULL WHERE company_id = ? AND run_id = ? AND idx = 1").run(CO, run.runId)).toThrow(/query never changes/)
    expect(() => conn.prepare(`INSERT INTO browser_frames (company_id, run_id, idx, method, path, query, fields, max) VALUES (?, ?, 9, 'POST', '/a', 'a%20b', '{}', 1)`).run(CO, run.runId)).toThrow(/CHECK/)
    expect(() => conn.prepare(`INSERT INTO browser_frames (company_id, run_id, idx, method, path, query, fields, max) VALUES (?, ?, 9, 'POST', '/a', '', '{}', 1)`).run(CO, run.runId)).toThrow(/CHECK/)
    // A database whose browser_frames predates the column: its rows keep their meaning (null = no query).
    const before = new Database(':memory:')
    before.pragma('foreign_keys = OFF')
    before.exec(`CREATE TABLE browser_frames (company_id TEXT NOT NULL, run_id TEXT NOT NULL, idx INTEGER NOT NULL CHECK (idx >= 1),
      method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')), path TEXT NOT NULL, fields TEXT NOT NULL,
      max INTEGER NOT NULL CHECK (max >= 1), used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= max), PRIMARY KEY (company_id, run_id, idx))`)
    before.prepare(`INSERT INTO browser_frames (company_id, run_id, idx, method, path, fields, max) VALUES ('co-1', 'bf_old', 1, 'POST', '/api/orders/register', '{}', 1)`).run()
    initDatabase(before)
    initDatabase(before) // idempotent
    expect(before.prepare('SELECT path, query FROM browser_frames').all()).toEqual([{ path: '/api/orders/register', query: null }])
    expect(sqliteCompanyData(before).forCompany('co-1').browserFrames.frames('bf_old')).toEqual([{ idx: 1, method: 'POST', path: '/api/orders/register', query: null, fields: '{}', max: 1, used: 0, promise: null }])
    expect(() => before.prepare("UPDATE browser_frames SET query = 'x'").run()).toThrow(/query never changes/)
  })
})

describe('frames: a department Skill (agent-browser.md "Department Skills")', () => {
  it('a run from a department Skill keeps its path; a name shared with the company\'s Skill is refused, never guessed', async () => {
    put(yaml, 'v1', DEPT_P)
    await approveSkill('pre_approved', DEPT_P)
    // The name alone: only the department's has it, so it is that one.
    const byName = value(await frames.start(alice, { skill: SKILL }, PC))
    expect(byName).toMatchObject({ state: 'open', source: 'skill', skill: DEPT_P })
    value(frames.end(alice, byName.runId))
    // The company's Skill of the same name appears: the name is now two Skills.
    put(yaml, 'v1', SKILL_P)
    expect(code(await frames.start(alice, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_AMBIGUOUS')
    // By its path, each is its own: the department's approved, the company's not.
    expect(value(await frames.start(alice, { skill: DEPT_P }, PC))).toMatchObject({ skill: DEPT_P })
  })

  it('a member who cannot read the department cannot run its Skill; one who loses it mid-run gets no permit', async () => {
    put(yaml, 'v1', DEPT_P)
    await approveSkill('pre_approved', DEPT_P)
    expect(code(await frames.start(bob, { skill: DEPT_P }, PC))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(code(await frames.start(bob, { skill: SKILL }, PC))).toBe('BROWSER_SKILL_NOT_FOUND')
    // Alice runs it; taken off the department during the run, her next permit is refused and nothing is written.
    const run = value(await frames.start(alice, { skill: DEPT_P }, PC))
    notReadingSales.add(alice.userId)
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_SKILL_NOT_FOUND')
    expect(value(frames.get(alice, run.runId)).state).toBe('ended')
    expect(value(frames.get(alice, run.runId)).writes).toEqual([])
    // Within the transaction too: lost between the permit's read and its write (`stillApproved`).
    notReadingSales.delete(alice.userId)
    const second = value(await frames.start(alice, { skill: DEPT_P }, PC))
    betweenReadAndWrite = () => { betweenReadAndWrite = null; notReadingSales.add(alice.userId) }
    expect(code(await permit(second.runId, 1))).toBe('BROWSER_SKILL_CHANGED')
    notReadingSales.delete(alice.userId)
    const third = value(await frames.start(alice, { skill: DEPT_P }, PC))
    expect(code(await permit(third.runId, 1))).toBe('ok')
  })

  it('a body naming neither a Skill name nor a Skill path is refused', async () => {
    for (const skill of ['', 'x'.repeat(500), 42]) {
      expect(code(await frames.start(alice, { skill }, PC)), String(skill)).toBe('BROWSER_FRAME_BAD_REQUEST')
    }
    expect(code(await frames.start(alice, { skill: 'a/b/.claude/skills/x' }, PC))).toBe('BROWSER_SKILL_NOT_FOUND')
  })
})

describe('a run of a source this build does not know (the rollback floor of the drafts\' runs)', () => {
  /** A row a later build wrote (its table rebuilt with another source allowed), read by this build after a rollback. */
  function asLaterBuildsSource(runId: string, source: string) {
    conn.exec('DROP TRIGGER browser_frame_runs_fixed')
    conn.pragma('ignore_check_constraints = ON')
    conn.prepare('UPDATE browser_frame_runs SET source = ? WHERE id = ?').run(source, runId)
    conn.pragma('ignore_check_constraints = OFF')
  }

  it('an open run of an unknown source ends on its first touch and permits nothing; the domain is free again', async () => {
    const run = await openAdhoc()
    asLaterBuildsSource(run.runId, 'draft')
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_ENDED')
    expect(value(frames.get(alice, run.runId))).toMatchObject({ state: 'ended', endReason: 'unknown-source' })
    expect(frames.holderOn(CO, DOMAIN)).toBeNull()
  })

  it('a waiting one ends too: its card can no longer approve it', async () => {
    const started = value(await frames.start(alice, { plan: adhoc }, PC))
    asLaterBuildsSource(started.runId, 'draft')
    expect(code(await approve(alice, started))).toBe('BROWSER_RUN_ENDED')
    expect(value(frames.get(alice, started.runId))).toMatchObject({ state: 'ended', endReason: 'unknown-source' })
  })

  it('a locked one (a write in doubt) keeps the domain to its hour, as for every source (review of #889)', async () => {
    const run = await openAdhoc()
    expect(code(await permit(run.runId, 1))).toBe('ok')
    expect(code(await report(run.runId, 1, 'unknown'))).toBe('ok')
    asLaterBuildsSource(run.runId, 'draft')
    expect(value(frames.get(alice, run.runId))).toMatchObject({ state: 'locked', endReason: null })
    expect(frames.holderOn(CO, DOMAIN)).not.toBeNull()
    expect(code(await permit(run.runId, 1))).toBe('BROWSER_RUN_AFTER_UNKNOWN')
  })

  it('a known source runs as before', async () => {
    const run = await openAdhoc()
    expect(code(await permit(run.runId, 1))).toBe('ok')
  })
})

describe('the write ledger across requests (agent-browser.md "The write ledger across requests"; LedgerLife.tla)', () => {
  const confirm = (runId: string, write: number, answer: string, m: Member = alice) => frames.confirm(m, runId, { write, answer }, PC)
  const DAY = 24 * 60 * 60 * 1000
  /** A run whose write on `frame` went out and whose answer was lost; then the run ends. */
  async function lostAnswer(m: Member = alice, frame = 1): Promise<string> {
    const run = await openAdhoc(m)
    value(await permit(run.runId, frame, m))
    value(report(run.runId, 1, 'unknown', m))
    value(frames.end(m, run.runId))
    return run.runId
  }
  const startAdhoc = async (m: Member = alice, plan: unknown = adhoc) => value(await frames.start(m, { plan }, PC))

  it('a write in doubt blocks a permit to that very target in the next request, days later too: never by time', async () => {
    const earlier = await lostAnswer()
    now += 3 * DAY
    const next = await startAdhoc()
    expect(next.doubts).toEqual([{
      runId: earlier, write: 1, frame: { method: 'POST', path: '/api/orders/register', fields: {} },
      permittedAt: iso(T0), confirmableAt: iso(T0 + 35_000),
    }])
    value(await approve(alice, next))
    expect(code(await permit(next.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
    // Nothing taken, the run still open: the frame's units are untouched.
    const seen = value(frames.get(alice, next.runId))
    expect(seen).toMatchObject({ state: 'open' })
    expect(seen.frames[0]).toMatchObject({ used: 0, left: 2 })
    // A month later, past every run's hour: still refused.
    value(frames.end(alice, next.runId))
    now += 30 * DAY
    const later = value(await approve(alice, await startAdhoc()))
    expect(code(await permit(later.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
  })

  it('another target is not held up: the run goes on for it, and a run whose frames cannot meet the doubt is not asked', async () => {
    await lostAnswer()
    now += DAY
    const next = await openAdhoc()
    expect(code(await permit(next.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
    expect(code(await permit(next.runId, 2))).toBe('ok')
    value(report(next.runId, 1, 'done'))
    value(frames.end(alice, next.runId))
    const notesOnly = await startAdhoc(alice, { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/orders/{n}/note', max: 1 }] })
    expect(notesOnly.doubts).toEqual([])
  })

  it('a target named by a placeholder: the same object is held, another one is not; the start names a frame that may meet', async () => {
    await lostAnswer(alice, 2) // a note on order 42 in doubt
    now += DAY
    const next = await startAdhoc(alice, { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/orders/{x}/note', max: 2 }] })
    expect(next.doubts?.map(d => d.frame.path)).toEqual(['/api/orders/{n}/note'])
    value(await approve(alice, next))
    expect(code(await permit(next.runId, 1, alice, { method: 'POST', path: '/api/orders/42/note', fields: {} }))).toBe('BROWSER_WRITE_IN_DOUBT')
    expect(code(await permit(next.runId, 1, alice, { method: 'POST', path: '/api/orders/43/note', fields: {} }))).toBe('ok')
  })

  it('the person\'s answer ends the doubt — 済んでいた or されていなかった — and nothing of the earlier run moves', async () => {
    const first = await lostAnswer()
    now += DAY
    value(confirm(first, 1, 'not_done'))
    const next = await startAdhoc()
    expect(next.doubts).toEqual([])
    value(await approve(alice, next))
    value(await permit(next.runId, 1))
    value(report(next.runId, 1, 'unknown'))
    value(frames.end(alice, next.runId))
    now += DAY
    value(confirm(next.runId, 1, 'done'))
    expect(value(frames.get(alice, next.runId)).writes[0]).toMatchObject({ state: 'unknown', confirmed: { answer: 'done' } })
    const third = await openAdhoc()
    expect(code(await permit(third.runId, 1))).toBe('ok')
  })

  it('the site\'s answer ends it: a late done (also the app\'s read-back), or a late refusal read again and found unchanged — a refusal alone does not', async () => {
    const first = await lostAnswer()
    value(frames.report(alice, first, { write: 1, result: 'done', reason: 'read-back' }, PC))
    expect(conn.prepare('SELECT state, reason FROM browser_frame_writes WHERE company_id = ? AND run_id = ?').get(CO, first)).toEqual({ state: 'done', reason: 'read-back' })
    // A run of an app that keeps the run's promise (its refusals are read again before they count as "not saved").
    const waiting = value(await frames.start(alice, { plan: adhoc }, PC))
    value(frames.promise(alice, waiting.runId, { values: [], binds: [], decisions: [] }, PC))
    const next = value(await approve(alice, waiting))
    expect(code(await frames.permit(alice, next.runId, { frame: 1, request: FITS[1], check: { fields: {}, segments: [null, null, null] } }, PC))).toBe('ok')
    value(report(next.runId, 1, 'unknown'))
    value(frames.end(alice, next.runId))
    // The site's late error alone proves nothing was saved? No ("Sent is not done"): still in doubt (an unknown write is,
    // whichever app made it).
    value(report(next.runId, 1, 'refused'))
    const third = await openAdhoc()
    expect(code(await permit(third.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
    value(frames.end(alice, third.runId))
    // The same refusal read again and found unchanged: known not saved, the doubt ends.
    value(frames.report(alice, next.runId, { write: 1, result: 'refused', checked: 'unchanged' }, PC))
    const fourth = await openAdhoc()
    expect(code(await permit(fourth.runId, 1))).toBe('ok')
  })

  it('a read-back from another PC ends nothing (a sure report: the run\'s own PC only)', async () => {
    const first = await lostAnswer()
    expect(code(frames.report(alice, first, { write: 1, result: 'done', reason: 'read-back' }, 'other-pc'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    const next = await openAdhoc()
    expect(code(await permit(next.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
  })

  it('another member\'s account and another company are never mixed in', async () => {
    await lostAnswer(alice)
    const bobs = await startAdhoc(bob)
    expect(bobs.doubts).toEqual([])
    value(await approve(bob, bobs))
    expect(code(await permit(bobs.runId, 1, bob))).toBe('ok')
    value(report(bobs.runId, 1, 'done', bob))
    value(frames.end(bob, bobs.runId))
    const theirs = value(await frames.start(otherOwner, { plan: adhoc }, PC))
    expect(theirs.doubts).toEqual([])
    value(await approve(otherOwner, theirs))
    expect(code(await permit(theirs.runId, 1, otherOwner))).toBe('ok')
    value(report(theirs.runId, 1, 'done', otherOwner))
    // Alice's own doubt is still there.
    expect((await startAdhoc(alice)).doubts).toHaveLength(1)
  })

  it('a member who leaves with a write on its way: in doubt for their account; nobody else is held up', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    frames.memberLeft(CO, alice.userId)
    const bobs = value(await approve(bob, await startAdhoc(bob)))
    expect(code(await permit(bobs.runId, 1, bob))).toBe('ok')
    value(report(bobs.runId, 1, 'done', bob))
    value(frames.end(bob, bobs.runId))
    // Back in the company later: asked first, and refused until answered.
    now += DAY
    const back = await startAdhoc()
    expect(back.doubts?.map(d => [d.runId, d.write])).toEqual([[run.runId, 1]])
    value(await approve(alice, back))
    expect(code(await permit(back.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
  })

  it('the ledger keeps the target\'s hash only (no path), only beside a permitted write, never changed or removed', async () => {
    const run = await lostAnswer()
    const rows = conn.prepare('SELECT * FROM browser_write_ledger WHERE company_id = ?').all(CO) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ run_id: run, seq: 1, user_id: alice.userId, host: DOMAIN, account: `member:${alice.userId}` })
    expect(rows[0].target).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain('/api/orders')
    expect(() => conn.prepare('UPDATE browser_write_ledger SET target = ? WHERE company_id = ?').run(`sha256:${'0'.repeat(64)}`, CO)).toThrow(/kept as written/)
    expect(() => conn.prepare('DELETE FROM browser_write_ledger WHERE company_id = ?').run(CO)).toThrow(/kept as written/)
    const insert = conn.prepare('INSERT INTO browser_write_ledger (company_id, run_id, seq, user_id, host, account, target, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    // Not beside a write that is no longer permitted, nor for another member of the run.
    expect(() => insert.run(CO, run, 2, alice.userId, DOMAIN, 'member:x', `sha256:${'1'.repeat(64)}`, iso(now))).toThrow(/beside its permitted write/)
    const open = await openAdhoc()
    value(await permit(open.runId, 2))
    expect(conn.prepare('SELECT COUNT(*) AS n FROM browser_write_ledger WHERE company_id = ?').get(CO)).toEqual({ n: 2 })
    // Beside a permitted write, but naming another member than the run's: refused before the key is even looked at.
    expect(() => insert.run(CO, open.runId, 1, bob.userId, DOMAIN, 'member:x', `sha256:${'1'.repeat(64)}`, iso(now))).toThrow(/beside its permitted write/)
    expect(() => insert.run(CO, open.runId, 1, alice.userId, 'elsewhere.example.test', 'member:x', `sha256:${'1'.repeat(64)}`, iso(now))).toThrow(/beside its permitted write/)
  })
})

describe('the run\'s promise (agent-browser.md "The run\'s promise")', () => {
  /** A Skill binding the register write's `title` to 名前 and allowing `note` besides; the note frame's order is open (`{n}`). */
  const boundYaml = `domain: ${DOMAIN}\nwrites:\n  - { method: POST, path: /api/orders/register, max: 3, body: [title, note], bind: { title: 名前 } }\n  - { method: POST, path: "/api/orders/{n}/note", max: 2 }\n`
  /** The app's keyed digest of a value (a stand-in key: the server never computes one). */
  const D = (v: string) => `hmac:${sha(`key\0${v}`)}`
  const reason = (r: Outcome<unknown>) => [code(r as Refusal), (r as Refusal).body?.reason ?? null]
  const asked = (r: Outcome<unknown>) => {
    const b = (r as Refusal).body as { code?: string; fields?: string[]; targets?: number[]; values?: string[] }
    return [b.code, b.fields, b.targets, b.values]
  }
  const REGISTER = (title: string | null, extra: Record<string, string> = {}) => ({
    frame: 1, request: FITS[1], check: { fields: { ...(title === null ? {} : { title: D(title) }), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, D(v)])) }, segments: [null, null, null] },
  })
  const NOTE = (order: string, digest: string | null = D(order)) => ({
    frame: 2, request: { method: 'POST', path: `/api/orders/${order}/note`, fields: {} }, check: { fields: {}, segments: [null, null, digest, null] },
  })
  const promise = (runId: string, body: unknown, key: string | undefined = PC) => frames.promise(alice, runId, body, key)
  const add = (runId: string, body: unknown, key: string | undefined = PC) => frames.promiseAdd(alice, runId, body, key)
  const PROMISED = { values: [{ digest: D('冬の回'), source: 'person' }], binds: [{ frame: 1, field: 'title', digest: D('冬の回') }], decisions: [] }
  async function openBound(mode: 'per_run' | 'pre_approved' = 'pre_approved', withPromise: unknown = PROMISED): Promise<BrowserFrameRunView> {
    put(boundYaml)
    await approveSkill(mode)
    const started = value(await frames.start(alice, { skill: SKILL }, PC))
    if (withPromise !== null) value(promise(started.runId, withPromise))
    return mode === 'per_run' ? value(await approve(alice, started)) : started
  }
  const used = (runId: string) => value(frames.get(alice, runId)).frames.map(f => f.used)

  it('the frames carry the Skill\'s body and bind; the promise is made once, before the first permit, from this PC only', async () => {
    const run = await openBound('pre_approved', null)
    expect(run.frames.map(f => [f.body ?? null, f.bind ?? null])).toEqual([[['title', 'note'], { title: '名前' }], [null, null]])
    expect(code(promise(run.runId, PROMISED, 'other-pc'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    // Read strictly against the run's own frames: a field the frame does not bind, a value not in the promise, an unknown key.
    for (const bad of [
      { ...PROMISED, binds: [{ frame: 1, field: 'note', digest: D('冬の回') }] },
      { ...PROMISED, binds: [{ frame: 2, field: 'title', digest: D('冬の回') }] },
      { ...PROMISED, binds: [{ frame: 1, field: 'title', digest: D('夏の回') }] },
      { ...PROMISED, values: [{ digest: '冬の回', source: 'person' }] },
      { ...PROMISED, values: [{ digest: D('冬の回'), source: 'asked' }] },
      { ...PROMISED, decisions: ['use-it'] },
      { ...PROMISED, extra: 1 },
    ]) expect(code(promise(run.runId, bad)), JSON.stringify(bad)).toBe('BROWSER_FRAME_BAD_REQUEST')
    value(promise(run.runId, PROMISED))
    // The same again (a lost answer) is kept; another one is refused.
    value(promise(run.runId, PROMISED))
    expect(code(promise(run.runId, { ...PROMISED, decisions: ['proceed'] }))).toBe('BROWSER_PROMISE_MADE')
    // Nothing of a value is kept: digests only.
    expect(JSON.stringify(conn.prepare('SELECT content FROM browser_frame_promises').all())).not.toContain('冬の回')
  })

  it('a promise made after the run\'s first permit is refused (service and trigger)', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    expect(code(promise(run.runId, { values: [], binds: [], decisions: [] }))).toBe('BROWSER_PROMISE_TOO_LATE')
    expect(() => conn.prepare('INSERT INTO browser_frame_promises (company_id, run_id, content, created_at) VALUES (?, ?, ?, ?)').run(CO, run.runId, '{}', iso(now))).toThrow(/before its first permit/)
  })

  it('a bound field must hold the promised value: another value or none is never permitted, never asked, and takes nothing', async () => {
    const run = await openBound()
    expect(code(await frames.permit(alice, run.runId, { frame: 1, request: FITS[1] }, PC))).toBe('BROWSER_PROMISE_CHECK_MISSING')
    expect(reason(await frames.permit(alice, run.runId, REGISTER('夏の回'), PC))).toEqual(['BROWSER_PROMISE_BROKEN', 'value'])
    expect(reason(await frames.permit(alice, run.runId, REGISTER(null), PC))).toEqual(['BROWSER_PROMISE_BROKEN', 'missing'])
    expect(used(run.runId)).toEqual([0, 0])
    expect(value(await frames.permit(alice, run.runId, REGISTER('冬の回', { note: 'なんでも' }), PC)).frame).toBe(1)
  })

  it('a field outside the promise, a target nobody promised and a bound field with no value are asked — once; the person\'s answer adds exactly them', async () => {
    const run = await openBound('pre_approved', { values: [], binds: [], decisions: [] })
    // The bound field has no promised value, `memo` is outside `body`.
    expect(asked(await frames.permit(alice, run.runId, REGISTER('冬の回', { memo: 'x' }), PC))).toEqual(['BROWSER_PROMISE_ASK', ['memo'], [], ['title']])
    // A target this run did not make and nobody promised.
    expect(asked(await frames.permit(alice, run.runId, NOTE('42'), PC))).toEqual(['BROWSER_PROMISE_ASK', [], [2], []])
    expect(used(run.runId)).toEqual([0, 0])
    // The person's 「書いてよい」 (the card's), strictly read: only what that frame may carry.
    for (const bad of [
      { frame: 1, fields: [], targets: [], binds: [] },
      { frame: 1, fields: ['_method'], targets: [], binds: [] },
      { frame: 2, fields: [], targets: [], binds: [{ field: 'title', digest: D('冬の回') }] },
      { frame: 1, fields: [], targets: ['42'], binds: [] },
      { frame: 9, fields: ['memo'], targets: [], binds: [] },
    ]) expect(code(add(run.runId, bad)), JSON.stringify(bad)).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(add(run.runId, { frame: 1, fields: ['memo'], targets: [], binds: [{ field: 'title', digest: D('冬の回') }] }, 'other-pc'))).toBe('BROWSER_DEVICE_ELSEWHERE')
    value(add(run.runId, { frame: 1, fields: ['memo'], targets: [], binds: [{ field: 'title', digest: D('冬の回') }] }))
    value(add(run.runId, { frame: 2, fields: [], targets: [D('42')], binds: [] }))
    expect(value(await frames.permit(alice, run.runId, REGISTER('冬の回', { memo: 'x' }), PC)).frame).toBe(1)
    value(report(run.runId, 1, 'done'))
    expect(value(await frames.permit(alice, run.runId, NOTE('42'), PC)).frame).toBe(2)
    value(report(run.runId, 2, 'done'))
    // An addition never changes a value already promised: the bound field still holds only 冬の回.
    value(add(run.runId, { frame: 1, fields: [], targets: [], binds: [{ field: 'title', digest: D('夏の回') }] }))
    expect(reason(await frames.permit(alice, run.runId, REGISTER('夏の回'), PC))).toEqual(['BROWSER_PROMISE_BROKEN', 'value'])
    // Another target is asked again (only what the person saw was added).
    expect(asked(await frames.permit(alice, run.runId, NOTE('43'), PC))).toEqual(['BROWSER_PROMISE_ASK', [], [2], []])
  })

  it('a target this run made itself, or a value the person gave, needs no question; another run\'s does', async () => {
    const run = await openBound('pre_approved', { values: [{ digest: D('冬の回'), source: 'person' }, { digest: D('77'), source: 'person' }], binds: [{ frame: 1, field: 'title', digest: D('冬の回') }], decisions: [] })
    value(await frames.permit(alice, run.runId, REGISTER('冬の回'), PC))
    value(frames.report(alice, run.runId, { write: 1, result: 'done', created: '42' }, PC))
    expect(value(await frames.permit(alice, run.runId, NOTE('42'), PC)).frame).toBe(2)
    value(report(run.runId, 2, 'done'))
    expect(value(await frames.permit(alice, run.runId, NOTE('77'), PC)).frame).toBe(2)
    value(report(run.runId, 3, 'done'))
    value(frames.end(alice, run.runId))
    const next = value(await frames.start(alice, { skill: SKILL }, PC))
    value(promise(next.runId, PROMISED))
    // What the earlier run made is not this run's: asked.
    expect(asked(await frames.permit(alice, next.runId, NOTE('42'), PC))[0]).toBe('BROWSER_PROMISE_ASK')
  })

  it('only an open run with a promise takes the person\'s additions, at most 20', async () => {
    const waiting = await (async () => { put(boundYaml); await approveSkill('per_run'); return value(await frames.start(alice, { skill: SKILL }, PC)) })()
    value(promise(waiting.runId, PROMISED))
    expect(code(add(waiting.runId, { frame: 1, fields: ['memo'], targets: [], binds: [] }))).toBe('BROWSER_RUN_NOT_APPROVED')
    value(frames.end(alice, waiting.runId))
    const bare = await openAdhoc()
    expect(code(add(bare.runId, { frame: 1, fields: ['memo'], targets: [], binds: [] }))).toBe('BROWSER_PROMISE_MISSING')
    value(frames.end(alice, bare.runId))
    const run = await openBound()
    for (let i = 0; i < 20; i++) value(add(run.runId, { frame: 1, fields: [`f${i}`], targets: [], binds: [] }))
    expect(code(add(run.runId, { frame: 1, fields: ['g'], targets: [], binds: [] }))).toBe('BROWSER_PROMISE_FULL')
    expect(() => conn.prepare("UPDATE browser_frame_promise_adds SET content = '{}'").run()).toThrow(/kept as given/)
    expect(() => conn.prepare('DELETE FROM browser_frame_promise_adds').run()).toThrow(/kept as given/)
    expect(() => conn.prepare("UPDATE browser_frame_promises SET content = '{}'").run()).toThrow(/kept as made/)
    expect(() => conn.prepare('DELETE FROM browser_frame_promises').run()).toThrow(/kept as made/)
  })

  it('a run without a promise (an older app) is permitted as before; an AI-written plan carries no promise fields', async () => {
    const run = await openBound('pre_approved', null)
    expect(value(await frames.permit(alice, run.runId, { frame: 1, request: FITS[1] }, PC)).frame).toBe(1)
    value(report(run.runId, 1, 'done'))
    value(frames.end(alice, run.runId))
    const plan = { domain: DOMAIN, writes: [{ method: 'POST', path: '/api/orders/register', max: 1, body: ['a'], bind: { a: '名前' } }] }
    const ad = value(await frames.start(alice, { plan }, PC))
    expect(ad.frames[0]).not.toHaveProperty('bind')
    expect(ad.frames[0]).not.toHaveProperty('body')
  })

  it('a stopped card\'s answer the new run continues is kept in its promise (a fixed word, never the question)', async () => {
    const run = await openBound('pre_approved', { ...PROMISED, decisions: ['proceed'] })
    expect(JSON.parse((conn.prepare('SELECT content FROM browser_frame_promises WHERE run_id = ?').get(run.runId) as { content: string }).content).decisions).toEqual(['proceed'])
  })
})

describe('sent is not done (agent-browser.md "Sent is not done")', () => {
  const confirm = (runId: string, write: number, answer: string) => frames.confirm(alice, runId, { write, answer }, PC)
  const DAY = 24 * 60 * 60 * 1000
  /** The register write with its promise check (accepted and unused for a run without a promise). */
  const permit = (runId: string, frame: number) => frames.permit(alice, runId, { frame, request: FITS[frame], check: { fields: {}, segments: [null, null, null] } }, PC)
  /** A run of an app that keeps the run's promise (an empty one is enough). */
  async function openAdhoc(): Promise<BrowserFrameRunView> {
    const run = value(await frames.start(alice, { plan: adhoc }, PC))
    value(frames.promise(alice, run.runId, { values: [], binds: [], decisions: [] }, PC))
    return value(await approve(alice, run))
  }

  it('a refusal of a run without a promise (an older app, a row from before) is no doubt, as before', async () => {
    const run = value(await approve(alice, value(await frames.start(alice, { plan: adhoc }, PC))))
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'refused'))
    value(frames.end(alice, run.runId))
    const next = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(next.doubts).toEqual([])
  })

  it('the site\'s error alone is no proof: its own run goes on, every later run is held until it is read again unchanged or answered', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'refused'))
    expect(value(frames.get(alice, run.runId)).writes[0]).toMatchObject({ state: 'refused', checked: false })
    // The run's own corrected try goes on.
    value(await permit(run.runId, 1))
    value(report(run.runId, 2, 'refused'))
    value(frames.end(alice, run.runId))
    now += DAY
    const next = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(next.doubts?.map(d => [d.runId, d.write])).toEqual([[run.runId, 1], [run.runId, 2]])
    value(await approve(alice, next))
    expect(code(await permit(next.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
    // The person may answer about it like an unknown one.
    value(confirm(run.runId, 1, 'not_done'))
    expect(code(await permit(next.runId, 1))).toBe('BROWSER_WRITE_IN_DOUBT')
    value(confirm(run.runId, 2, 'not_done'))
    expect(code(await permit(next.runId, 1))).toBe('ok')
  })

  it('a refusal read again and found unchanged is known not saved: no doubt, nothing to answer', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(frames.report(alice, run.runId, { write: 1, result: 'refused', checked: 'unchanged' }, PC))
    expect(value(frames.get(alice, run.runId)).writes[0]).toMatchObject({ state: 'refused', checked: true, confirmableAt: null })
    value(frames.end(alice, run.runId))
    now += DAY
    expect(code(confirm(run.runId, 1, 'not_done'))).toBe('BROWSER_FRAME_NOT_UNKNOWN')
    const next = await openAdhoc()
    expect(code(await permit(next.runId, 1))).toBe('ok')
    // `checked` only with a refusal, only the one word; and only beside a refused write (trigger).
    expect(code(frames.report(alice, next.runId, { write: 1, result: 'done', checked: 'unchanged' }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(code(frames.report(alice, next.runId, { write: 1, result: 'refused', checked: 'yes' }, PC))).toBe('BROWSER_FRAME_BAD_REQUEST')
    expect(() => conn.prepare('INSERT INTO browser_frame_refusal_checks (company_id, run_id, seq, checked_at) VALUES (?, ?, 1, ?)').run(CO, next.runId, iso(now))).toThrow(/beside its refused write/)
  })

  it('a refusal its own run then wrote done to the same target is no doubt for later runs', async () => {
    const run = await openAdhoc()
    value(await permit(run.runId, 1))
    value(report(run.runId, 1, 'refused'))
    value(await permit(run.runId, 1))
    value(report(run.runId, 2, 'done'))
    value(frames.end(alice, run.runId))
    const next = value(await frames.start(alice, { plan: adhoc }, PC))
    expect(next.doubts).toEqual([])
  })
})
