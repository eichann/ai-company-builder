/**
 * Writes within frames (redesign step ⑤a; agent-browser.md "Writes within frames"; the contract as a checked model:
 * `model/browser-plan/FramesLife.tla`, whose server actions name the functions here). **The one owner of every state
 * move** of a frames run and its writes; the tables' CHECKs and triggers (db/schema/browser-frames.ts) are a second layer.
 *
 * The AI operates a registered domain freely; each write its page makes is held by the app (step ⑤b), matched to one of
 * the run's **frames** (a write target × at most `max` uses) and sent **once** under a permit of this service. Unlike the
 * opened lines' state table (browser-line-steps.ts, the safe pattern), the writes are not known in advance: a run holds
 * only an upper bound per frame, and a write row is appended per permit, naming the frame whose unit it took.
 *
 * - **Where the frames come from** (`start`): a company Skill's **approved** declaration, read by the server itself
 *   (`approvedFrames`: never content an app sent), or an **ad-hoc plan** the person approves on the card — checked with
 *   the declaration's own rules, never pre-approvable. A `pre_approved` Skill version needs no card, unless its text
 *   changed since (`needsRunCard`): then the card once, and `runCardShown` with the `files` of this service's own
 *   `approvedFrames` call at approval (never from the request). A `per_run` Skill or an ad-hoc plan: the card before any
 *   permit (owner decision D1).
 * - **A permit** (one transaction): the run `open` (`waiting` → not approved; `locked` → a write was unknown, nothing more
 *   is sent in this run; `ended` → its frames are gone), **nothing in flight** (the second page write waits until the
 *   first's result is recorded), a unit of the frame left, then the gate — this PC (the run's own registration), the
 *   company's mode and the site's level, the AI stop, the person's own level (変えてよい), and for a Skill run the approval
 *   still in force for the run's declaration — a refusal of which **ends the run**. Then one unit taken (compare-and-set)
 *   and the write appended `permitted`, with both clocks' readings.
 * - **A report** names its write: `permitted` → `done` ("the site returned success"; `verified`, a safe pattern's machine
 *   check, is reserved) / `not_sent` / `unknown` (the run locks); `unknown` + `done` → `done` (late and sure; the run stays
 *   locked). A permitted write silent past permit + 5 s + 30 s on both clocks becomes `unknown` on the next touch.
 * - **What this run made** (agent-browser.md "Writes only to what this run made"): a frame whose path has `{made:<n>}`
 *   fits only an id the n-th frame's own `done` write returned in this run. The id comes with that write's `done` report
 *   (`created`), from the run's own PC like every sure report, only while the write moves `permitted` → `done` and only for
 *   a frame some frame of the run refers to; it is kept (`browser_frame_made`, the one page value the server keeps) and
 *   every permit matches against it. An `unknown`, `refused` or `not_sent` write never gives one (a late `done` after
 *   `unknown` neither: the run is locked anyway).
 * - **The end** (`end`, the run's time, leaving): the run `ended`, its unused frames gone. A write still `permitted` is left
 *   to its report or time-out (it may be on its way); leaving makes it `unknown` at once (nobody will report it).
 *
 * - **The work over** (`settle`, agent-browser.md "Letting a domain go"): a Skill run allows one work run, so an `open`
 *   Skill run whose work run is over (finished, refused, past its lease or hard end) and that has no write `permitted`
 *   ends at once (`work-ended`) and frees the domain — never a `waiting` run (its card is up), never a `locked` one (a write
 *   in doubt keeps the domain as before), never while a write may be on its way.
 *
 * Time-outs are judged on every touch, never by a timer. Everything is the member's own session; another member's or
 * another company's run is the same 404 as one that does not exist.
 */
import { browserAiStopped, levelAllows, type BrowserOperationSettings } from '../../shared/core/browser-operation'
import { BROWSER_PLAN_TIMES, BROWSER_REPORT_REASONS } from '../../shared/core/browser-plans'
import { browserSkillDeclarationFrom, BROWSER_SKILL_PROBLEM_WORDS, type BrowserSkillWrite } from '../../shared/core/browser-skill'
import { BROWSER_DEVICE_WORDS } from '../../shared/core/browser-device'
import { browserAdhocWritesProblem, browserFrameMismatch, BROWSER_FRAME_REQUEST_LIMITS, type BrowserFrameRequest, type BrowserMadeIds } from '../../shared/core/browser-frame-match'
import { browserMadeFrom } from '../../shared/core/browser-skill'
import { BROWSER_FRAME_RUN_TIMES } from '../../shared/core/browser-run-budget'
import { canonicalJson } from '../../shared/core/fixed-content'
import type {
  BrowserFrameConfirmAnswer, BrowserFramePermit, BrowserFrameReportAnswer, BrowserFrameRunStart, BrowserFrameRunView, BrowserFrameWriteResult,
} from '../../shared/types/browser-frames'
import type { TokenDigest } from '../ports/key-broker'
import type { BrowserFrameRepository, FrameRunRow, FrameWriteRow } from '../ports/browser-frames'
import type { Clock, IdGenerator, MonotonicClock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Transactions } from '../ports/transactions'
import { hashCanonical } from '../lib/content-hash'
import type { Member } from './access'
import type { BrowserDeviceGate } from './browser-devices'
import type { BrowserSiteGrants } from './browser-site-grants'
import { BROWSER_SKILL_REF_MAX, type BrowserSkillApproved, type BrowserSkillService } from './browser-skills'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserFrameDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  monotonic: MonotonicClock
  ids: IdGenerator
  /** sha256 of the card's one-time approval value (only its digest is stored). */
  tokenDigest: TokenDigest
  /** The member's browser setting now (the company's mode with their own, the registered sites and their levels). */
  browserPolicy: (member: Member) => BrowserOperationSettings
  aiStops: (member: Member) => { all: boolean; tools: readonly string[] }
  /** This PC's registration (agent-browser.md "This PC's registration"). */
  devices: Pick<BrowserDeviceGate, 'check'>
  /** The person's own level on the registered site (agent-browser.md "Who may use a site"). */
  siteGrants: Pick<BrowserSiteGrants, 'allows'>
  /** 「Skill の承認」 (services/browser-skills.ts): the frames of an approved declaration, read by the server. */
  skills: Pick<BrowserSkillService, 'resolve' | 'approvedFrames' | 'stillApproved' | 'runCardShown'>
  /**
   * Whether an operator run (services/browser-runs.ts, step ④) holds the domain now: step ⑤b joins the two locks, so a
   * frames run never starts while another run operates the domain. Absent: no operator runs (tests of ⑤a).
   */
  operatorRunOn?: (companyId: string, host: string) => { until: number } | null
  /**
   * Whether the run's one work run (its `skill` operator run, services/browser-runs.ts `workRunOver`) was started and is
   * over — finished, refused, or past its lease or hard end. An open Skill run whose work is over and that has no write in
   * flight can be used for nothing more, so it ends at once (`work-ended`) and lets the domain go. Absent: never.
   */
  workRunOver?: (companyId: string, frameRunId: string) => boolean
  /** Where a report that contradicts the person's answer is noted (ids and fixed words only; default console). */
  log?: Pick<Console, 'warn'>
}

export const BROWSER_FRAME_TIMES = {
  /** A run waiting for the person's approval of its plan ends after this (shared/core/browser-run-budget.ts: the app's card waits as long). */
  approve: BROWSER_FRAME_RUN_TIMES.approve,
  /** A run ends this long after it started, whatever its state (its unused frames are gone; room for a Skill run's work). */
  run: BROWSER_FRAME_RUN_TIMES.run,
  /** A permit is good for this long (the app sends only within it). */
  permit: BROWSER_PLAN_TIMES.permit,
  /** Beyond the permit, how long before a silent write becomes unknown. */
  grace: BROWSER_PLAN_TIMES.grace,
} as const

export const BROWSER_FRAME_WORDS = {
  badRequest: '頼み方の形が正しくありません',
  notFound: 'この実行は見つかりません',
  notAllowed: 'この会社では、いまこのサイトで書き込みはできません',
  aiStopped: 'AI が止められているので、ブラウザ操作はできません',
  notGranted: 'このサイトで AI に変えてもらうことは、まだ認められていません',
  busy: 'このサイトでは、ほかの実行が動いています。それが済むまで待ってください',
  notApproved: '計画がまだ承認されていません。カードで確かめてください',
  planChanged: '計画が変わりました。カードを見直してから、もう一度確かめてください',
  skillChanged: 'Skill が直されました。もう一度頼み直してください',
  afterUnknown: '前の書き込みが届いたか分からないので、この実行では、もう書き込みません',
  ended: 'この実行は終わりました。書き込むなら、もう一度頼んでください',
  inFlight: 'ひとつ前の書き込みの結果がまだ届いていません。届いてからもう一度',
  usedUp: 'この送り先には、決めた回数まで書き込みました',
  notWaiting: 'この計画は、もう承認を待っていません',
  reportConflict: '前の報告と食い違う報告です',
  writeNotFound: 'その書き込みは見つかりません',
  mismatch: 'この書き込みは、計画の送り先の枠に合いません（送りません）',
  widePlan: '計画の送り先が広すぎます。送り先は決まった言葉で始まるアドレスにしてください',
  madePlan: '「この作業で作ったものにだけ書く」指定は、承認された会社の Skill でだけ使えます',
  queryPlan: '送り先のアドレスの ? のあと（query）の指定は、承認された会社の Skill でだけ使えます',
  approvalRefused: 'この承認は受け付けられません。カードからもう一度確かめてください',
  confirmNotUnknown: 'この書き込みは、届いたか分からないものではありません',
  confirmTooEarly: 'まだ送られるかもしれないため、少し待ってから確かめてください',
  confirmDone: 'この書き込みについては、もう答えてあります',
} as const
const W = BROWSER_FRAME_WORDS

/** The end reason of a Skill run ended because its one work run is over (`settle`). */
export const WORK_ENDED = 'work-ended'

const RUN_ID_RE = /^bf_[0-9a-f]{32}$/
const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,100}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const TOKEN_RE = /^[0-9a-f]{64}$/
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.[\]-]*$/
/** What a done write made, as its report names it (the app's `createdIdOf`: a plain token). */
const MADE_RE = /^[A-Za-z0-9_-]{1,64}$/

/** The permit's `request` as the app read the held write (only its shape: method, path, the frame's fixed fields). */
function requestOf(v: unknown): BrowserFrameRequest | null {
  if (!isMap(v) || Object.keys(v).length !== 3 || typeof v.method !== 'string' || typeof v.path !== 'string' || !isMap(v.fields)) return null
  if (v.method.length > 10 || v.path.length > BROWSER_FRAME_REQUEST_LIMITS.path) return null
  const entries = Object.entries(v.fields)
  if (entries.length > BROWSER_FRAME_REQUEST_LIMITS.fields) return null
  const fields: Record<string, string> = {}
  for (const [k, value] of entries) {
    if (k.length > BROWSER_FRAME_REQUEST_LIMITS.fieldName || !FIELD_NAME_RE.test(k)) return null
    if (typeof value !== 'string' || value.length > BROWSER_FRAME_REQUEST_LIMITS.fieldValue) return null
    fields[k] = value
  }
  return { method: v.method, path: v.path, fields }
}
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const keysWithin = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every(k => allowed.includes(k))
const iso = (ms: number) => new Date(ms).toISOString()
const ms = (s: string) => Date.parse(s)
const RESULTS: readonly BrowserFrameWriteResult[] = ['done', 'not_sent', 'unknown', 'refused']
const CONFIRM_ANSWERS: readonly BrowserFrameConfirmAnswer[] = ['done', 'not_done']

/** What a run made, by the frame that made it (the permit's `{made:<n>}` matches against it). */
function madeIds(rows: ReadonlyArray<{ frameIdx: number; made: string }>): BrowserMadeIds {
  const out = new Map<number, Set<string>>()
  for (const row of rows) out.set(row.frameIdx, (out.get(row.frameIdx) ?? new Set()).add(row.made))
  return out
}

interface StartFrames {
  host: string
  source: 'skill' | 'adhoc'
  skill: string | null
  declarationHash: string | null
  files: string | null
  writes: readonly BrowserSkillWrite[]
  /** The approved declaration's addresses (a Skill run; an ad-hoc plan has none), answered by the start only. */
  afterRead: readonly string[]
  neverRead: readonly string[]
  /** The run may open at once (a pre-approved Skill version whose text nobody changed since). */
  preApproved: boolean
  /** A Skill's approval row the frames rest on (checked again inside the start's transaction). */
  approval: number | null
}

export function createBrowserFrameService(deps: BrowserFrameDeps) {
  const { companyData, transactions, clock, monotonic, ids, tokenDigest } = deps
  const repo = (companyId: string): BrowserFrameRepository => companyData.forCompany(companyId).browserFrames
  const bad = (): Refusal => refuse('bad-request', W.badRequest, { code: 'BROWSER_FRAME_BAD_REQUEST' })
  const missing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_FRAME_RUN_NOT_FOUND' })

  /** Permit + 5 s + 30 s on both clocks, from this write's permit (a restart counts from the start). */
  function pastWindow(w: FrameWriteRow, now: number): boolean {
    const window = BROWSER_FRAME_TIMES.permit + BROWSER_FRAME_TIMES.grace
    if (now < ms(w.permittedAt) + window) return false
    const mono = Math.floor(monotonic.monoMs())
    const sameStart = w.permittedBoot === monotonic.bootId && w.permittedMonoMs !== null
    return (sameStart ? mono - (w.permittedMonoMs as number) : mono) >= window
  }

  /** When a run not ended ends by its times: a waiting one at its card's time, any other at its hour. */
  const endsAt = (run: FrameRunRow): number =>
    run.state === 'waiting' ? Math.min(ms(run.createdAt) + BROWSER_FRAME_TIMES.approve, ms(run.expiresAt)) : ms(run.expiresAt)

  /** `RunEnds`: the run ended, its unused frames gone (a permitted write is left to its report or time-out). */
  function endRun(companyId: string, run: FrameRunRow, reason: string, now: number): void {
    repo(companyId).setRunState(run.id, run.state, 'ended', { endReason: reason, endedAt: iso(now) })
  }

  /**
   * `ServerSettlesUnknown`, the run's times and its work's end, on every touch. A Skill run allows one work run
   * (`BROWSER_RUN_WORK_TAKEN`), so once that run is over an `open` run with no write `permitted` can permit nothing that
   * matters any more: it ends (`work-ended`) instead of holding the domain to its hour. A write `permitted` (it may be on
   * its way) or `unknown` (the run `locked`) keeps the run, and so the domain, as before.
   */
  function settle(companyId: string, found: FrameRunRow, now: number): FrameRunRow {
    const r = repo(companyId)
    const inFlight = r.writes(found.id).find(w => w.state === 'permitted')
    if (inFlight && pastWindow(inFlight, now) && r.setWriteState(found.id, inFlight.seq, 'permitted', 'unknown', { settledAt: iso(now), reason: 'no-answer' })) {
      r.setRunState(found.id, 'open', 'locked', {})
    }
    const run = r.run(found.id) as FrameRunRow
    if (run.state !== 'ended' && now >= endsAt(run)) endRun(companyId, run, 'expired', now)
    else if (workOver(companyId, run)) endRun(companyId, run, WORK_ENDED, now)
    return r.run(found.id) as FrameRunRow
  }

  /** An open Skill run whose one work run is over, with no write `permitted` (`settle`). */
  function workOver(companyId: string, run: FrameRunRow): boolean {
    if (run.state !== 'open' || run.source !== 'skill' || !deps.workRunOver) return false
    if (repo(companyId).writes(run.id).some(w => w.state === 'permitted')) return false
    return deps.workRunOver(companyId, run.id)
  }

  function view(companyId: string, run: FrameRunRow): BrowserFrameRunView {
    const r = repo(companyId)
    const usable = run.state === 'open' || run.state === 'waiting'
    return {
      runId: run.id, state: run.state, endReason: run.endReason, host: run.host, source: run.source, skill: run.skill,
      planHash: run.planHash, needsApproval: run.state === 'waiting', approval: run.approval,
      createdAt: run.createdAt, expiresAt: run.expiresAt, endedAt: run.endedAt,
      frames: r.frames(run.id).map(f => ({
        frame: f.idx, method: f.method, path: f.path, ...(f.query !== null ? { query: f.query } : {}),
        fields: JSON.parse(f.fields) as Record<string, string>, max: f.max, used: f.used,
        left: usable ? f.max - f.used : 0,
      })),
      writes: (() => {
        const confirms = new Map(r.confirms(run.id).map(c => [c.seq, c]))
        return r.writes(run.id).map(w => {
          const c = confirms.get(w.seq)
          return {
            write: w.seq, frame: w.frameIdx, state: w.state, permittedAt: w.permittedAt, settledAt: w.settledAt,
            confirmableAt: w.state === 'unknown' && !c ? iso(ms(w.permittedAt) + BROWSER_FRAME_TIMES.permit + BROWSER_FRAME_TIMES.grace) : null,
            confirmed: c ? { answer: c.answer, by: c.confirmedBy, at: c.confirmedAt } : null,
          }
        })
      })(),
    }
  }

  /** The member's own run (anyone else's, another company's: the same 404 as none). */
  function ownRun(member: Member, runId: string): FrameRunRow | null {
    if (!RUN_ID_RE.test(runId)) return null
    const run = repo(member.companyId).run(runId)
    return run && run.userId === member.userId ? run : null
  }

  /**
   * The gate of start, approve and every permit, in this order: this PC (and the run's own registration), the company's
   * mode with the member's and the site's level allowing writes, the AI stop, the person's own level (変えてよい).
   */
  function gate(member: Member, host: string, deviceKey: string | undefined, run: FrameRunRow | null): Outcome<{ deviceId: string | null }> {
    const pc = deps.devices.check(member, deviceKey, null)
    if (!pc.ok) return pc
    if (run && run.deviceId !== pc.value.deviceId) {
      return refuse('conflict', BROWSER_DEVICE_WORDS.refusals.BROWSER_DEVICE_ELSEWHERE, { code: 'BROWSER_DEVICE_ELSEWHERE' })
    }
    const settings = deps.browserPolicy(member)
    const site = settings.sites.find(s => s.host === host)
    if (settings.mode !== 'on' || !site || !levelAllows(site.level, 'write')) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
    if (browserAiStopped(deps.aiStops(member))) return refuse('conflict', W.aiStopped, { code: 'BROWSER_AI_STOPPED' })
    if (!deps.siteGrants.allows(member, host, 'write')) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
    return ok({ deviceId: pc.value.deviceId })
  }

  /**
   * A Skill run's Skill as read before the transaction: still exactly what the run started on — the declaration (and
   * domain), the folder version (the steps' text: a change needs the card again, so the run ends) and the approval row —,
   * and, asked inside the transaction, that row still the skill's latest, in force (not revoked, superseded or given
   * another mode since: independent review of ⑤a).
   */
  function sameSkill(member: Member, run: FrameRunRow, now: Outcome<BrowserSkillApproved>): Refusal | null {
    if (!now.ok) return now
    // The declaration and domain compared here are a second layer: another declaration has another approval row, which
    // `stillApproved` (the run's own row still the latest) refuses by itself.
    if (now.value.declarationHash !== run.declarationHash || now.value.frames.domain !== run.host || now.value.files !== run.files
      || !deps.skills.stillApproved(member, run.skill as string, run.declarationHash as string, run.approvalSeq as number)) {
      return refuse('conflict', W.skillChanged, { code: 'BROWSER_SKILL_CHANGED' })
    }
    return null
  }

  const planHashOf = (member: Member, f: StartFrames) => hashCanonical(canonicalJson({
    company: member.companyId, user: member.userId, host: f.host, source: f.source, skill: f.skill, declarationHash: f.declarationHash,
    // A frame's query is part of what the card shows and the person approves (absent when none: a plan without queries
    // hashes as before).
    files: f.files, writes: f.writes.map(w => ({ method: w.method, path: w.path, ...(w.query !== null ? { query: w.query } : {}), max: w.max, fields: { ...w.fields } })),
  }))

  /** What a start's body names: a Skill (its approved frames, read now) or an ad-hoc plan (checked as a declaration). */
  async function framesOf(member: Member, body: Record<string, unknown>): Promise<Outcome<StartFrames>> {
    if (own(body, 'skill') === own(body, 'plan')) return bad()
    if (own(body, 'skill')) {
      if (typeof body.skill !== 'string' || body.skill.length === 0 || body.skill.length > BROWSER_SKILL_REF_MAX) return bad()
      // A Skill path, or a name only when exactly one Skill of it is there for this member (never a guess); the run keeps
      // the path (two departments may each have a Skill of one name).
      const which = await deps.skills.resolve(member, body.skill)
      if (!which.ok) return which
      const approved = await deps.skills.approvedFrames(member, which.value)
      if (!approved.ok) return approved
      const a = approved.value
      return ok({
        host: a.frames.domain, source: 'skill', skill: a.skill, declarationHash: a.declarationHash, files: a.files, writes: a.frames.writes,
        afterRead: a.frames.afterRead, neverRead: a.frames.neverRead,
        preApproved: a.mode === 'pre_approved' && !a.needsRunCard, approval: a.approval,
      })
    }
    const plan = body.plan
    if (!isMap(plan) || !keysWithin(plan, ['domain', 'writes'])) return bad()
    // The same strict rules as a Skill's `browser.yaml` (exact keys, limits, paths, `_method`, no login / CSRF field).
    const parsed = browserSkillDeclarationFrom({ domain: plan.domain, writes: plan.writes })
    if (!parsed.ok) return refuse('bad-request', BROWSER_SKILL_PROBLEM_WORDS[parsed.problem], { code: 'BROWSER_FRAME_BAD_PLAN' })
    // The AI wrote it: narrower than a reviewed declaration — every path begins with a literal segment (never "any path").
    // And never `{made}` (only a reviewed company Skill's declaration says "only what this run made").
    const adhoc = browserAdhocWritesProblem(parsed.declaration.writes)
    if (adhoc) return refuse('bad-request', adhoc === 'made' ? W.madePlan : adhoc === 'query' ? W.queryPlan : W.widePlan, { code: 'BROWSER_FRAME_BAD_PLAN' })
    // Its domain must be a registered one with writes allowed: the gate below (the same check as every permit's).
    // An ad-hoc plan is never pre-approvable: the person approves it on the card.
    return ok({
      host: parsed.declaration.domain, source: 'adhoc', skill: null, declarationHash: null, files: null, writes: parsed.declaration.writes,
      afterRead: [], neverRead: [], preApproved: false, approval: null,
    })
  }

  return {
    pastWindow,

    /**
     * Who holds a domain for the operator runs' start (step ⑤b, services/browser-runs.ts): the run not ended there (its id,
     * member, source and state — the operator run's budget is chosen from the last two — and when it ends by its times, ms:
     * an operator run naming it never outlives it), `busy` while an ended run's write to it may still be on its way, else
     * null. Time-outs judged first.
     */
    holderOn(companyId: string, host: string): { runId: string; userId: string; source: FrameRunRow['source']; state: FrameRunRow['state']; endsAt: number } | 'busy' | null {
      const now = clock.nowMs()
      const r = repo(companyId)
      const live = r.liveRunOn(host)
      if (live) settle(companyId, live, now)
      const still = r.liveRunOn(host)
      if (still) return { runId: still.id, userId: still.userId, source: still.source, state: still.state, endsAt: endsAt(still) }
      for (const ended of r.runsInFlightOn(host)) settle(companyId, ended, now)
      return r.runsInFlightOn(host).length > 0 ? 'busy' : null
    },

    /**
     * POST /browser-frame-runs { skill } | { plan: { domain, writes } } (+ conversationId?) with the PC's key header: a
     * run with its frames, built here. `waiting` until the person approves the plan on the card, or `open` at once for a
     * pre-approved Skill version whose text nobody changed since. A waiting run carries a **one-time approval value**
     * (`approvalToken`), answered here only — never by `get` or anything else — so only the app's main process that
     * started the run (and shows the card) can approve it; only its sha256 is stored. A member has at most one waiting
     * run: a new start ends the older one (`superseded`; its card can no longer approve).
     */
    async start(member: Member, body: unknown, deviceKey?: string): Promise<Outcome<BrowserFrameRunStart>> {
      if (!isMap(body) || !keysWithin(body, ['skill', 'plan', 'conversationId'])) return bad()
      if (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !CONVERSATION_RE.test(body.conversationId))) return bad()
      const framed = await framesOf(member, body)
      if (!framed.ok) return framed
      const f = framed.value
      return transactions.run((): Outcome<BrowserFrameRunStart> => {
        const passed = gate(member, f.host, deviceKey, null)
        if (!passed.ok) return passed
        // A Skill's approval revoked or replaced (another mode included) since the read above: nothing is started.
        if (f.source === 'skill' && !deps.skills.stillApproved(member, f.skill as string, f.declarationHash as string, f.approval as number)) {
          return refuse('conflict', W.skillChanged, { code: 'BROWSER_SKILL_CHANGED' })
        }
        const now = clock.nowMs()
        const r = repo(member.companyId)
        // At most one waiting run per member (a partial unique index too): the older card is replaced, its domain freed.
        for (const older of r.unsettledRunsOf(member.userId)) {
          if (older.state === 'waiting') endRun(member.companyId, older, 'superseded', now)
        }
        // A busy answer says the latest the holder can keep the domain (`freeAt`), so the AI can say roughly when it frees up.
        const busy = (until: number) => refuse('conflict', W.busy, { code: 'BROWSER_RUN_BUSY', freeAt: iso(until) })
        const holder = r.liveRunOn(f.host)
        if (holder) settle(member.companyId, holder, now)
        const live = r.liveRunOn(f.host)
        if (live) return busy(endsAt(live))
        // An ended run's write may still be on its way to this domain (its 5 s permit): the domain stays busy until that
        // write is recorded or times out, so two writes never travel to one site at once (independent review of ⑤a).
        for (const ended of r.runsInFlightOn(f.host)) settle(member.companyId, ended, now)
        const flying = r.runsInFlightOn(f.host).flatMap(run => r.writes(run.id).filter(w => w.state === 'permitted'))
        if (flying.length > 0) return busy(Math.max(...flying.map(w => ms(w.permittedAt) + BROWSER_FRAME_TIMES.permit + BROWSER_FRAME_TIMES.grace)))
        // An operator run (step ④) on this domain holds it too (step ⑤b: one lock across both kinds of run).
        const operating = deps.operatorRunOn?.(member.companyId, f.host)
        if (operating) return busy(operating.until)
        const approvalToken = f.preApproved ? null : ids.newToken()
        const run: FrameRunRow = {
          id: `bf_${ids.newToken().slice(0, 32)}`, userId: member.userId, host: f.host, deviceId: passed.value.deviceId,
          conversationId: (body.conversationId as string | undefined) ?? null, source: f.source, skill: f.skill,
          declarationHash: f.declarationHash, files: f.files, approvalSeq: f.approval, planHash: planHashOf(member, f),
          approvalTokenHash: approvalToken === null ? null : tokenDigest.digest(approvalToken),
          state: f.preApproved ? 'open' : 'waiting', approval: f.preApproved ? 'pre_approved' : null, approvedAt: f.preApproved ? iso(now) : null,
          endReason: null, createdAt: iso(now), expiresAt: iso(now + BROWSER_FRAME_TIMES.run), endedAt: null,
        }
        r.insertRun(run, f.writes.map((w, i) => ({ idx: i + 1, method: w.method, path: w.path, query: w.query, fields: canonicalJson({ ...w.fields }), max: w.max })))
        return ok({ ...view(member.companyId, run), approvalToken, afterRead: [...f.afterRead], neverRead: [...f.neverRead] })
      })
    },

    /** GET /browser-frame-runs/:runId: the member's own run (time-outs judged first). */
    get(member: Member, runId: string): Outcome<BrowserFrameRunView> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      return transactions.run(() => ok(view(member.companyId, settle(member.companyId, found, clock.nowMs()))))
    },

    /**
     * `PersonApproves` — POST /browser-frame-runs/:runId/approve { planHash, approvalToken } with the PC's key header: the
     * person approved the plan the card showed (its hash), with the one-time value only the start's answer carried. A Skill run is read again first: a declaration or folder version that moved
     * since the run started ends it (the card showed another version). Then `runCardShown` with the files of **this**
     * read — never a value from the request.
     */
    async approve(member: Member, runId: string, body: unknown, deviceKey?: string): Promise<Outcome<BrowserFrameRunView>> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      if (!isMap(body) || Object.keys(body).length !== 2 || typeof body.planHash !== 'string' || !HASH_RE.test(body.planHash)
        || typeof body.approvalToken !== 'string' || !TOKEN_RE.test(body.approvalToken)) return bad()
      const planHash = body.planHash
      const approvalHash = tokenDigest.digest(body.approvalToken)
      const skillNow = found.source === 'skill' ? await deps.skills.approvedFrames(member, found.skill as string) : null
      return transactions.run((): Outcome<BrowserFrameRunView> => {
        const now = clock.nowMs()
        const run = settle(member.companyId, found, now)
        if (run.state !== 'waiting') return refuse('conflict', run.state === 'ended' ? W.ended : W.notWaiting, { code: run.state === 'ended' ? 'BROWSER_RUN_ENDED' : 'BROWSER_RUN_NOT_WAITING' })
        if (run.approvalTokenHash === null || approvalHash !== run.approvalTokenHash) return refuse('forbidden', W.approvalRefused, { code: 'BROWSER_FRAME_APPROVAL_REFUSED' })
        if (planHash !== run.planHash) return refuse('conflict', W.planChanged, { code: 'BROWSER_FRAME_PLAN_CHANGED' })
        const passed = gate(member, run.host, deviceKey, run)
        if (!passed.ok) { endRun(member.companyId, run, String(passed.body.code ?? 'refused'), now); return passed }
        if (skillNow) {
          const moved = sameSkill(member, run, skillNow)
          if (moved) { endRun(member.companyId, run, String(moved.body.code ?? 'refused'), now); return moved }
        }
        if (!repo(member.companyId).setRunState(run.id, 'waiting', 'open', { approval: 'card', approvedAt: iso(now) })) {
          return refuse('conflict', W.notWaiting, { code: 'BROWSER_RUN_NOT_WAITING' })
        }
        // The card was shown for this version: the files are the ones the server read just now (equal to the run's).
        if (skillNow && skillNow.ok) deps.skills.runCardShown(member, run.skill as string, skillNow.value.declarationHash, skillNow.value.files)
        return ok(view(member.companyId, repo(member.companyId).run(run.id) as FrameRunRow))
      })
    },

    /**
     * `ServerPermits` / `ServerRefuses` — POST /browser-frame-runs/:runId/permit { frame, request: { method, path, fields } }
     * with the PC's key header: one write's permit for one unit of that frame, **for a held write whose shape fits it**
     * (`browserFrameMismatch`, the one rule ⑤b's app asks too: method, path pattern, the body's `_method`, the frame's fixed
     * fields — never any other value). Refused (nothing taken) while not open, while a write is in flight, when the frame
     * is used up or the request does not fit; a refusal of the gate (or of the Skill's approval) also ends the run.
     */
    async permit(member: Member, runId: string, body: unknown, deviceKey?: string): Promise<Outcome<BrowserFramePermit>> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      if (!isMap(body) || Object.keys(body).length !== 2 || !Number.isSafeInteger(body.frame) || (body.frame as number) < 1) return bad()
      const frameIdx = body.frame as number
      const request = requestOf(body.request)
      if (!request) return bad()
      // The git read happens before the transaction; the approval row is looked at again inside it.
      const skillNow = found.source === 'skill' ? await deps.skills.approvedFrames(member, found.skill as string) : null
      return transactions.run((): Outcome<BrowserFramePermit> => {
        const now = clock.nowMs()
        const r = repo(member.companyId)
        const run = settle(member.companyId, found, now)
        if (run.state === 'waiting') return refuse('conflict', W.notApproved, { code: 'BROWSER_RUN_NOT_APPROVED' })
        if (run.state === 'locked') return refuse('conflict', W.afterUnknown, { code: 'BROWSER_RUN_AFTER_UNKNOWN' })
        if (run.state === 'ended') return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
        const writes = r.writes(run.id)
        if (writes.some(w => w.state === 'permitted')) return refuse('conflict', W.inFlight, { code: 'BROWSER_RUN_WRITE_IN_FLIGHT' })
        const frame = r.frames(run.id).find(f => f.idx === frameIdx)
        if (!frame) return bad()
        if (frame.used >= frame.max) return refuse('conflict', W.usedUp, { code: 'BROWSER_FRAME_USED_UP' })
        const mismatch = browserFrameMismatch({ method: frame.method, path: frame.path, query: frame.query, max: frame.max, fields: JSON.parse(frame.fields) as Record<string, string> }, request, madeIds(r.made(run.id)))
        if (mismatch) return refuse('conflict', W.mismatch, { code: 'BROWSER_FRAME_MISMATCH', reason: mismatch })
        const passed = gate(member, run.host, deviceKey, run)
        const refused: Refusal | null = !passed.ok
          ? passed
          : skillNow
            ? sameSkill(member, run, skillNow)
            : null
        if (refused) {
          // The gate closed (stop, level, setting, PC, approval): for good in this run — its frames vanish.
          endRun(member.companyId, run, String(refused.body.code ?? 'refused'), now)
          return refused
        }
        if (!r.takeUnit(run.id, frameIdx)) return refuse('conflict', W.usedUp, { code: 'BROWSER_FRAME_USED_UP' })
        const seq = writes.length + 1
        r.insertWrite(run.id, { seq, frameIdx, state: 'permitted', permittedAt: iso(now), permittedMonoMs: monotonic.monoMs(), permittedBoot: monotonic.bootId })
        return ok({ write: seq, frame: frameIdx, permittedAt: iso(now), validMs: BROWSER_FRAME_TIMES.permit })
      })
    },

    /**
     * `ServerGetsReport` — POST /browser-frame-runs/:runId/report { write, result: done | not_sent | unknown, reason?,
     * created? }: judged after the time-outs. Not gated by the stop or the levels (they never keep a write from settling), but a sure
     * answer — `done` or `not_sent` — counts only from **the run's own PC** (its key header; independent review of ⑤a):
     * from anywhere else it is refused and the write settles as unknown at its time-out. `unknown` is taken from any
     * session of the member (it only makes the run stricter). `created` (only with `done`, only for a frame another frame's
     * `{made:<n>}` refers to, else 400): the id the site's answer named, kept with the write moving to `done` — the same
     * report again is `same` only with the same id.
     */
    report(member: Member, runId: string, body: unknown, deviceKey?: string): Outcome<BrowserFrameReportAnswer> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      if (!isMap(body) || !keysWithin(body, ['write', 'result', 'reason', 'created']) || !Number.isSafeInteger(body.write) || (body.write as number) < 1
        || !(RESULTS as readonly unknown[]).includes(body.result) || (body.reason !== undefined && typeof body.reason !== 'string')) return bad()
      if (body.created !== undefined && (body.result !== 'done' || typeof body.created !== 'string' || !MADE_RE.test(body.created))) return bad()
      const seq = body.write as number
      const result = body.result as BrowserFrameWriteResult
      const created = body.created as string | undefined
      // Only a word of the one list is kept (never a page's text).
      const reason = typeof body.reason === 'string' && (BROWSER_REPORT_REASONS as readonly string[]).includes(body.reason) ? body.reason : null
      if (result !== 'unknown') {
        const pc = deps.devices.check(member, deviceKey, null)
        if (!pc.ok) return pc
        if (pc.value.deviceId !== found.deviceId) return refuse('conflict', BROWSER_DEVICE_WORDS.refusals.BROWSER_DEVICE_ELSEWHERE, { code: 'BROWSER_DEVICE_ELSEWHERE' })
      }
      return transactions.run((): Outcome<BrowserFrameReportAnswer> => {
        const now = clock.nowMs()
        const r = repo(member.companyId)
        const run = settle(member.companyId, found, now)
        const w = r.writes(run.id).find(x => x.seq === seq)
        if (!w) return refuse('not-found', W.writeNotFound, { code: 'BROWSER_FRAME_WRITE_NOT_FOUND' })
        const answer = (outcome: BrowserFrameReportAnswer['outcome']) => ok({ outcome, run: view(member.companyId, r.run(run.id) as FrameRunRow) })
        // An id only for a frame some frame of this run refers to (`{made:<n>}`): no other value of the page is kept.
        if (created !== undefined && !r.frames(run.id).some(f => browserMadeFrom(f.path) === w.frameIdx)) return bad()
        if (w.state === 'permitted') {
          if (!r.setWriteState(run.id, seq, 'permitted', result, { settledAt: iso(now), reason })) throw new Error('browser frames: a write moved inside its transaction')
          if (created !== undefined) r.insertMade(run.id, { seq, frameIdx: w.frameIdx, made: created }, iso(now))
          // `unknown`: nothing more is sent in this run (the run locks; an ended run stays ended). `refused` (the site said
          // no): the run goes on; the unit stays used, and trying again is a new write with its own permit.
          if (result === 'unknown') r.setRunState(run.id, 'open', 'locked', {})
          return answer('applied')
        }
        if (w.state === result || (w.state === 'verified' && result === 'done')) {
          // The same done again (its answer lost on the way back) only with what it made then; another id is not the same.
          const kept = r.made(run.id).find(m => m.seq === seq)?.made
          if (result === 'done' && w.state === 'done' && created !== kept) {
            return refuse('conflict', W.reportConflict, { code: 'BROWSER_REPORT_CONFLICT' })
          }
          return answer('same')
        }
        // Once the person answered about it, no report changes it. One that agrees is kept as it was; one that contradicts
        // the answer (done after されていなかった, refused / not sent after 済んでいた) is refused and noted — ids and words only.
        const answered = r.confirms(run.id).find(c => c.seq === seq)
        if (answered) {
          const contradicts = answered.answer === 'not_done' ? result === 'done' : result === 'refused' || result === 'not_sent'
          if (!contradicts) return answer('recorded')
          ;(deps.log ?? console).warn(`[browser-frames] run ${run.id} write ${seq}: a report "${result}" contradicts the person's answer "${answered.answer}"; kept as answered`)
          return refuse('conflict', W.reportConflict, { code: 'BROWSER_REPORT_CONFLICT' })
        }
        if (w.state === 'unknown' && (result === 'done' || result === 'refused')) {
          // Late and sure: the site's answer came after all; the run stays locked (never runs on after an unknown). A
          // `created` with it is not kept: nothing more is permitted in this run anyway.
          r.setWriteState(run.id, seq, 'unknown', result, { settledAt: iso(now), reason })
          return answer('applied')
        }
        // `not_sent` after `unknown`: it may have been sent all the same — kept as it was.
        if (w.state === 'unknown' && result === 'not_sent') return answer('recorded')
        return refuse('conflict', W.reportConflict, { code: 'BROWSER_REPORT_CONFLICT' })
      })
    },

    /**
     * `PersonConfirms` — POST /browser-frame-runs/:runId/confirm { write, answer: done | not_done } with this PC's key
     * header (agent-browser.md "Recovering from a failed write"): the person's answer about a write in doubt, from the
     * card. Bound like a sure report — the member's own run and **its own PC** — and only for an `unknown` write, only past
     * its permit + 5 s + 30 s on both clocks (it may still be on its way before), once (another answer after it:
     * `BROWSER_FRAME_CONFIRMED`; the same answer again — a lost answer of ours — is answered as kept, nothing written). Kept
     * with who and when; it **never moves the write or the run**: a locked run stays locked whatever the answer, and
     * nothing is sent again (「されていなかった」: the person asks again in the chat — a new run).
     */
    confirm(member: Member, runId: string, body: unknown, deviceKey?: string): Outcome<BrowserFrameRunView> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      if (!isMap(body) || Object.keys(body).length !== 2 || !Number.isSafeInteger(body.write) || (body.write as number) < 1
        || !(CONFIRM_ANSWERS as readonly unknown[]).includes(body.answer)) return bad()
      const pc = deps.devices.check(member, deviceKey, null)
      if (!pc.ok) return pc
      if (pc.value.deviceId !== found.deviceId) return refuse('conflict', BROWSER_DEVICE_WORDS.refusals.BROWSER_DEVICE_ELSEWHERE, { code: 'BROWSER_DEVICE_ELSEWHERE' })
      const seq = body.write as number
      const given = body.answer as BrowserFrameConfirmAnswer
      return transactions.run((): Outcome<BrowserFrameRunView> => {
        const now = clock.nowMs()
        const r = repo(member.companyId)
        const run = settle(member.companyId, found, now)
        const w = r.writes(run.id).find(x => x.seq === seq)
        if (!w) return refuse('not-found', W.writeNotFound, { code: 'BROWSER_FRAME_WRITE_NOT_FOUND' })
        // Once: the same answer again (its first answer lost on the way back) is answered as kept; another one is refused.
        const before = r.confirms(run.id).find(c => c.seq === seq)
        if (before) return before.answer === given ? ok(view(member.companyId, run)) : refuse('conflict', W.confirmDone, { code: 'BROWSER_FRAME_CONFIRMED' })
        if (w.state !== 'unknown') return refuse('conflict', W.confirmNotUnknown, { code: 'BROWSER_FRAME_NOT_UNKNOWN' })
        if (!pastWindow(w, now)) return refuse('conflict', W.confirmTooEarly, { code: 'BROWSER_TOO_EARLY' })
        if (!r.insertConfirm(run.id, { seq, answer: given, confirmedBy: member.userId, confirmedAt: iso(now) })) {
          return refuse('conflict', W.confirmDone, { code: 'BROWSER_FRAME_CONFIRMED' })
        }
        return ok(view(member.companyId, r.run(run.id) as FrameRunRow))
      })
    },

    /** `RunEnds` — POST /browser-frame-runs/:runId/end: the run ends; its unused frames vanish. */
    end(member: Member, runId: string): Outcome<BrowserFrameRunView> {
      const found = ownRun(member, runId)
      if (!found) return missing()
      return transactions.run((): Outcome<BrowserFrameRunView> => {
        const now = clock.nowMs()
        const run = settle(member.companyId, found, now)
        if (run.state !== 'ended') endRun(member.companyId, run, 'ended', now)
        return ok(view(member.companyId, repo(member.companyId).run(run.id) as FrameRunRow))
      })
    },

    /**
     * Leaving the company (inside the removal's transaction): every run of the member ends (`left`) and a write still
     * permitted becomes `unknown` at once — it may have been sent, and nobody will report it.
     */
    memberLeft(companyId: string, userId: string): void {
      const now = clock.nowMs()
      const r = repo(companyId)
      // Ended runs too, while a write of theirs is still permitted (ended by the member, then they left: Codex review).
      for (const run of r.unsettledRunsOf(userId)) {
        for (const w of r.writes(run.id)) {
          if (w.state === 'permitted') r.setWriteState(run.id, w.seq, 'permitted', 'unknown', { settledAt: iso(now), reason: 'context-changed' })
        }
        if (run.state !== 'ended') endRun(companyId, r.run(run.id) as FrameRunRow, 'left', now)
      }
    },
  }
}

export type BrowserFrameService = ReturnType<typeof createBrowserFrameService>
