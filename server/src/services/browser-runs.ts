/**
 * The operator's runs of 「ブラウザ操作」 (redesign step ④; agent-browser.md "The operator's window tools"; design memo §3 I5 /
 * I8, §7-1, D10). The operator AI moves through a registered domain's pages in the member's own window, **reading only**
 * (the window's gate refuses every write). The server decides whether a run may start and go on, holds the lock, and
 * keeps the run's log.
 *
 * Invariants (each tested in tests/unit/browser-runs.test.ts):
 * - **The gate** (start — after the body's shape — and every continue, in this order): this PC (`devices.check`: an enabled registration of the
 *   member — the owner's transition exception as on the plan paths —, and on a continue the very registration the run
 *   started from), the company's mode with the member's override on and the domain registered exactly
 *   (`BROWSER_NOT_ALLOWED`), the AI not stopped (`BROWSER_AI_STOPPED`), the member's own level on the domain at least
 *   見るだけ (`siteGrants.allows(…, 'read')`, `BROWSER_TYPE_NOT_GRANTED`). A refusal at a continue ends the run
 *   (`refused`) and lets the lock go. Finishing and the list never ask it: clean-up never stops.
 * - **The lock** (D10): at most one running run per company × domain — the partial unique index on `browser_runs`; a
 *   second start is `BROWSER_RUN_BUSY` and changes nothing. A run holds it until it finishes, is refused, its member
 *   leaves, its lease (`BROWSER_RUN_LIMITS.leaseMs`, renewed by each continue) runs out, or it reaches its budget's
 *   `runMs` whatever its renewals — judged on every touch (start on that domain, continue, finish), never by a timer, so
 *   a crashed app frees the domain at the latest a lease later.
 * - **The budget** ("Room for a Skill run", shared/core/browser-run-budget.ts): chosen here at the start by the core's one
 *   rule `browserRunBudgetFor` from this server's own rows — `skill` only for a write task's run naming its member's
 *   frames run of an approved company Skill that is open; everything else `standard` — stored with the row (fixed by
 *   trigger) and answered. **Once per frames run**: a later write run naming a frames run that already had its `skill`
 *   run is refused (`BROWSER_RUN_WORK_TAKEN`; the check here and a partial unique index). Every continue takes one of its
 *   `steps` (compare-and-set): past them the run ends (`timed_out`, `rounds`).
 * - **Never past the frames run** (`browserRunWindow`): a run naming a frames run ends (`ends_at`, fixed) no later than
 *   that frames run does, and the answer's `operateMs` tells the app how long it may operate; with less than a minute left
 *   it is refused (`BROWSER_RUN_TOO_LATE`).
 * - **Past its lease = ended, everywhere** (agent-browser.md "Letting a domain go"): a running row past its lease or hard end
 *   is ended `timed_out` on every touch — the lock (`runningOn`, start), a continue, the finish, the list, and the frames
 *   run asking whether its work is over (`workRunOver`) — so nothing reads it as still holding the domain.
 * - **The log** (I8): only steps that pass `browserRunLogProblem` (page patterns, the fixed actions, labels already in
 *   the kept form): no value can be stored. Written once per run, append-only (trigger). The member sees their own runs,
 *   an owner / admin everyone's; another company's run is the same 404 as none.
 * Nothing here reads, stores or answers a value the site showed or the operator typed.
 */
import { browserAiStopped, levelAllows, normalizeBrowserHost, type BrowserOperationSettings } from '../../shared/core/browser-operation'
import {
  BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, BROWSER_RUN_OUTCOMES, browserRunLogProblem, browserRunWritesProblem, isBrowserRunEndReason,
  type BrowserRunLogStep, type BrowserRunOutcome, type BrowserRunState, type BrowserRunWriteStep,
} from '../../shared/core/browser-run-log'
import { BROWSER_RUN_BUDGETS, browserRunBudgetFor, browserRunWindow } from '../../shared/core/browser-run-budget'
import type { BrowserRunContinued, BrowserRunsList, BrowserRunStarted, BrowserRunView } from '../../shared/types/browser-runs'
import type { BrowserRunRepository, BrowserRunRow } from '../ports/browser-runs'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import type { BrowserDeviceGate } from './browser-devices'
import type { BrowserSiteGrants } from './browser-site-grants'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserRunDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  browserPolicy: (member: Member) => BrowserOperationSettings
  aiStops: (member: Member) => { all: boolean; tools: readonly string[] }
  devices: Pick<BrowserDeviceGate, 'check'>
  siteGrants: Pick<BrowserSiteGrants, 'allows'>
  /**
   * The frames run holding this domain (services/browser-frames.ts `holderOn`; step ⑤b joins the two locks): its id,
   * member, source and state (the budget's rule reads the last two) and when it ends by its times (ms), `busy` while an
   * ended run's write may still be on its
   * way, or null. Absent: no frames service (tests of ④).
   */
  frameRunOn?: (companyId: string, host: string) => { runId: string; userId: string; source: string; state: string; endsAt: number } | 'busy' | null
}

export const BROWSER_OPERATOR_RUN_WORDS = {
  badRun: '頼み方の形が正しくありません',
  notFound: 'この作業が見つかりません',
  notAllowed: 'この会社では、いまこのサイトは使えません',
  aiStopped: 'AI が止められているので、ブラウザ操作はできません',
  notGranted: 'このサイトを AI に見てもらうことは、管理者から認められていません',
  busy: 'このサイトでは、いま別の AI の作業が動いています。終わってから、もう一度頼んでください',
  ended: 'この作業は、もう終わっています',
  elsewhere: 'この作業は、別の PC で始めたものです',
  workTaken: 'この計画の作業は、もう始まっています。もう一度頼んでください',
  tooLate: '時間切れです。計画の残り時間が足りないため、作業を始めませんでした。もう一度頼んでください',
} as const
const W = BROWSER_OPERATOR_RUN_WORDS

const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,100}$/
const FRAME_RUN_ID_RE = /^bf_[0-9a-f]{32}$/
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const iso = (ms: number) => new Date(ms).toISOString()

/** A run's refusal reason word as stored (fixed words only). */
const REFUSAL_REASON: Record<string, string> = {
  BROWSER_NOT_ALLOWED: 'setting', BROWSER_AI_STOPPED: 'ai-stopped', BROWSER_TYPE_NOT_GRANTED: 'not-granted',
}

export function createBrowserRunService(deps: BrowserRunDeps) {
  const repo = (companyId: string): BrowserRunRepository => deps.companyData.forCompany(companyId).browserRuns

  /** The setting, the stop and the person's level on the domain (the PC is checked by the caller). */
  function allowed(member: Member, host: string): Refusal | null {
    const settings = deps.browserPolicy(member)
    if (settings.mode !== 'on' || !settings.sites.some(s => s.host === host)) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
    if (browserAiStopped(deps.aiStops(member))) return refuse('conflict', W.aiStopped, { code: 'BROWSER_AI_STOPPED' })
    if (!deps.siteGrants.allows(member, host, 'read')) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
    return null
  }

  /** A run's hard end: as fixed at its start (an older build's row: its start + its budget's `runMs`). */
  const endOf = (row: BrowserRunRow) => (row.endsAt !== null ? Date.parse(row.endsAt) : Date.parse(row.startedAt) + BROWSER_RUN_BUDGETS[row.budget].runMs)
  /** Has a running row run out (its lease, or its hard end)? */
  const outOfTime = (row: BrowserRunRow, now: number) => Date.parse(row.leaseUntil) <= now || endOf(row) <= now

  /** A running row past its time ends `timed_out` (on every touch). True when it did. */
  function settleTime(companyId: string, row: BrowserRunRow, now: number): boolean {
    if (row.state !== 'running' || !outOfTime(row, now)) return false
    return repo(companyId).end(row.id, 'timed_out', 'timeout', iso(now))
  }

  /** The member's own run (anyone else's, another company's: the same 404 as none). */
  function ownRun(member: Member, runId: unknown): BrowserRunRow | null {
    if (typeof runId !== 'string' || !BROWSER_RUN_ID_RE.test(runId)) return null
    const row = repo(member.companyId).byId(runId)
    return row && row.userId === member.userId ? row : null
  }

  function view(row: BrowserRunRow, steps: BrowserRunLogStep[]): BrowserRunView {
    return { id: row.id, userId: row.userId, host: row.host, state: row.state, reason: row.reason, startedAt: row.startedAt, endedAt: row.endedAt, steps }
  }

  return {
    /**
     * POST /browser-runs { host, conversationId?, frameRunId? } + this PC's key header: the gate, then the lock. One lock per
     * company × domain across both kinds of run (step ⑤b): while a frames run holds the domain, only its own member's run
     * that names it (`frameRunId`: the preview of its plan, or its writes) may start; a run naming a frames run that no
     * longer holds the domain is refused.
     */
    start(member: Member, body: unknown, deviceKey: string | undefined): Outcome<BrowserRunStarted> {
      if (!isMap(body) || Object.keys(body).some(k => k !== 'host' && k !== 'conversationId' && k !== 'frameRunId' && k !== 'write') || typeof body.host !== 'string'
        || (body.write !== undefined && body.write !== true)
        || (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !CONVERSATION_RE.test(body.conversationId)))
        || (body.frameRunId !== undefined && (typeof body.frameRunId !== 'string' || !FRAME_RUN_ID_RE.test(body.frameRunId)))) {
        return refuse('bad-request', W.badRun, { code: 'BROWSER_BAD_RUN' })
      }
      const frameRunId = typeof body.frameRunId === 'string' ? body.frameRunId : null
      const host = normalizeBrowserHost(body.host)
      if (!host || host !== body.host) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
      const pc = deps.devices.check(member, deviceKey, null)
      if (!pc.ok) return pc
      const refused = allowed(member, host)
      if (refused) return refused
      // A write task's run (step ⑤b, `write: true`): the person's own level 変えてよい and the site's level allowing writes,
      // asked before anything is read — a person at 見るだけ never gets a write task's preview.
      if (body.write === true) {
        const site = deps.browserPolicy(member).sites.find(s => s.host === host)
        if (!site || !levelAllows(site.level, 'write')) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
        if (!deps.siteGrants.allows(member, host, 'write')) return refuse('forbidden', W.notGranted, { code: 'BROWSER_TYPE_NOT_GRANTED' })
      }
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
      return deps.transactions.run((): Outcome<BrowserRunStarted> => {
        const now = deps.clock.nowMs()
        const r = repo(member.companyId)
        const holder = r.runningOn(host)
        if (holder) settleTime(member.companyId, holder, now)
        // The frames run's lock (step ⑤b): the same domain is never operated by two runs at once.
        const framed = deps.frameRunOn ? deps.frameRunOn(member.companyId, host) : null
        if (framed === 'busy') return refuse('conflict', W.busy, { code: 'BROWSER_RUN_BUSY' })
        // `freeAt`: the latest the holder can keep the domain (its hard end), so the AI can say roughly when it frees up.
        if (framed && (framed.runId !== frameRunId || framed.userId !== member.userId)) {
          return refuse('conflict', W.busy, { code: 'BROWSER_RUN_BUSY', freeAt: iso(framed.endsAt) })
        }
        if (!framed && frameRunId) return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
        // The budget: from this server's own frames run (its member's, the one named, checked just above), never the app's word.
        const named = framed && frameRunId ? framed : null
        const budget = browserRunBudgetFor({ write: body.write === true, frameRun: named })
        // A frames run's work is one operator run: the `skill` budget once (a modified app cannot start a second one).
        if (budget === 'skill' && named && r.skillRunOf(named.runId)) return refuse('conflict', W.workTaken, { code: 'BROWSER_RUN_WORK_TAKEN' })
        // Never past the frames run it names; too little time left → refused, nothing started.
        const window = browserRunWindow(BROWSER_RUN_BUDGETS[budget], now, named ? named.endsAt : null)
        if (!window) return refuse('conflict', W.tooLate, { code: 'BROWSER_RUN_TOO_LATE' })
        const id = `bo_${deps.ids.newToken().slice(0, 32)}`
        const inserted = r.insert({
          id, userId: member.userId, host, deviceId: pc.value.deviceId, conversationId, state: 'running', reason: null,
          startedAt: iso(now), leaseUntil: iso(Math.min(now + BROWSER_RUN_LIMITS.leaseMs, window.endsAt)), endedAt: null, budget, steps: 0,
          frameRunId: named ? named.runId : null, endsAt: iso(window.endsAt),
        })
        if (!inserted) {
          const still = r.runningOn(host)
          return refuse('conflict', W.busy, { code: 'BROWSER_RUN_BUSY', ...(still ? { freeAt: iso(endOf(still)) } : {}) })
        }
        return ok({ runId: id, leaseMs: BROWSER_RUN_LIMITS.leaseMs, budget, operateMs: window.operateMs })
      })
    },

    /** POST /browser-runs/:runId/continue + this PC's key header: before each of the operator's steps, the gate again. */
    continue(member: Member, runId: string, deviceKey: string | undefined): Outcome<BrowserRunContinued> {
      const row = ownRun(member, runId)
      if (!row) return refuse('not-found', W.notFound, { code: 'BROWSER_RUN_NOT_FOUND' })
      const now = deps.clock.nowMs()
      if (row.state !== 'running' || settleTime(member.companyId, row, now)) return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
      const pc = deps.devices.check(member, deviceKey, null)
      if (!pc.ok || pc.value.deviceId !== row.deviceId) {
        repo(member.companyId).end(row.id, 'refused', 'device', iso(now))
        return pc.ok ? refuse('conflict', W.elsewhere, { code: 'BROWSER_DEVICE_ELSEWHERE' }) : pc
      }
      const refused = allowed(member, row.host)
      if (refused) {
        repo(member.companyId).end(row.id, 'refused', REFUSAL_REASON[refused.body.code as string] ?? 'refused', iso(now))
        return refused
      }
      const budget = BROWSER_RUN_BUDGETS[row.budget]
      const until = Math.min(now + BROWSER_RUN_LIMITS.leaseMs, endOf(row))
      // One of the budget's steps (compare-and-set): past them the run ends here.
      if (!repo(member.companyId).renew(row.id, iso(until), budget.steps)) {
        repo(member.companyId).end(row.id, 'timed_out', 'rounds', iso(now))
        return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
      }
      return ok({ leaseMs: until - now })
    },

    /**
     * POST /browser-runs/:runId/finish { outcome, reason?, steps }: the log kept (once), the lock released. A run that
     * already ended (timed out, refused) still gets its log once: what was done is always known afterwards (I8).
     */
    finish(member: Member, runId: string, body: unknown): Outcome<{ state: BrowserRunState }> {
      const row = ownRun(member, runId)
      if (!row) return refuse('not-found', W.notFound, { code: 'BROWSER_RUN_NOT_FOUND' })
      if (!isMap(body) || Object.keys(body).some(k => k !== 'outcome' && k !== 'reason' && k !== 'steps' && k !== 'writes')
        || !(BROWSER_RUN_OUTCOMES as readonly unknown[]).includes(body.outcome) || browserRunLogProblem(body.steps)
        || (body.writes !== undefined && browserRunWritesProblem(body.writes, (body.steps as unknown[]).length))
        || (body.reason !== undefined && typeof body.reason !== 'string')) {
        return refuse('bad-request', W.badRun, { code: 'BROWSER_BAD_RUN' })
      }
      // Copied field by field (only the five kept words: nothing else of the body is stored).
      const writes: BrowserRunWriteStep[] = ((body.writes ?? []) as BrowserRunWriteStep[]).map(w => ({ after: w.after, frame: w.frame, method: w.method, page: w.page, outcome: w.outcome }))
      const outcome = body.outcome as BrowserRunOutcome
      const reason = isBrowserRunEndReason(body.reason) ? body.reason : null
      const steps = body.steps as BrowserRunLogStep[]
      return deps.transactions.run((): Outcome<{ state: BrowserRunState }> => {
        const r = repo(member.companyId)
        const now = deps.clock.nowMs()
        const current = r.byId(row.id)
        if (!current) return refuse('not-found', W.notFound, { code: 'BROWSER_RUN_NOT_FOUND' })
        // The log is written once, even an empty one (a flag on the run, not a count of its rows).
        if (!r.markLogWritten(current.id)) return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
        if (current.state === 'running' && !settleTime(member.companyId, current, now)) r.end(current.id, outcome, reason, iso(now))
        r.appendLog(steps.map((s, i) => ({ runId: current.id, idx: i + 1, page: s.page, action: s.action, label: s.label })))
        if (writes.length > 0) r.appendWrites(current.id, writes)
        return ok({ state: r.byId(current.id)?.state ?? current.state })
      })
    },

    /** GET /browser-runs: the member's own runs; an owner / admin: everyone's. Newest first, with their logs. */
    list(member: Member): Outcome<BrowserRunsList> {
      const r = repo(member.companyId)
      const rows = r.list(BROWSER_RUN_LIMITS.list, hasFullAccess(member.role) ? undefined : member.userId)
      const now = deps.clock.nowMs()
      const settled = rows.map(row => (settleTime(member.companyId, row, now) ? r.byId(row.id) ?? row : row))
      const log = r.logOf(settled.map(row => row.id))
      const writes = r.writesOf(settled.map(row => row.id))
      return ok({
        runs: settled.map(row => ({
          ...view(row, log.filter(l => l.runId === row.id).map(l => ({ page: l.page, action: l.action, label: l.label }))),
          writes: writes.filter(w => w.runId === row.id).map(w => ({ after: w.after, frame: w.frame, method: w.method, page: w.page, outcome: w.outcome })),
        })),
      })
    },

    /**
     * Whether an operator run holds this domain now (a run past its lease or its hard end is ended first): the frames run's
     * start asks it. `until`: the latest it can hold the domain (its hard end), for the busy answer's `freeAt`.
     */
    runningOn(companyId: string, host: string): { until: number } | null {
      const row = repo(companyId).runningOn(host)
      return row && !settleTime(companyId, row, deps.clock.nowMs()) ? { until: endOf(row) } : null
    },

    /**
     * Whether the frames run's one work run (its `skill` run, at most one: "Room for a Skill run") was started and is over —
     * finished, refused, timed out, or past its lease or hard end (ended here first: a run past its lease counts as ended
     * everywhere). The frames service then lets the domain go at once (`holderOn`, `settle`) instead of at its hour.
     */
    workRunOver(companyId: string, frameRunId: string): boolean {
      const row = repo(companyId).skillRunFor(frameRunId)
      if (!row) return false
      return row.state !== 'running' || settleTime(companyId, row, deps.clock.nowMs())
    },

    /** In removeMember's transaction: their running runs end (`left`), the lock goes. */
    memberLeft(companyId: string, userId: string): void {
      const at = iso(deps.clock.nowMs())
      for (const id of repo(companyId).runningOf(userId)) repo(companyId).end(id, 'left', null, at)
    },
  }
}

export type BrowserRunService = ReturnType<typeof createBrowserRunService>
