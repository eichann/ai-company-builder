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
 *   leaves, its lease (`BROWSER_RUN_LIMITS.leaseMs`, renewed by each continue) runs out, or it reaches
 *   `BROWSER_RUN_LIMITS.runMs` whatever its renewals — judged on every touch (start on that domain, continue, finish),
 *   never by a timer, so a crashed app frees the domain at the latest a lease later.
 * - **The log** (I8): only steps that pass `browserRunLogProblem` (page patterns, the fixed actions, labels already in
 *   the kept form): no value can be stored. Written once per run, append-only (trigger). The member sees their own runs,
 *   an owner / admin everyone's; another company's run is the same 404 as none.
 * Nothing here reads, stores or answers a value the site showed or the operator typed.
 */
import { browserAiStopped, normalizeBrowserHost, type BrowserOperationSettings } from '../../shared/core/browser-operation'
import {
  BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, BROWSER_RUN_OUTCOMES, browserRunLogProblem, isBrowserRunEndReason,
  type BrowserRunLogStep, type BrowserRunOutcome, type BrowserRunState,
} from '../../shared/core/browser-run-log'
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
} as const
const W = BROWSER_OPERATOR_RUN_WORDS

const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,100}$/
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

  /** Has a running row run out (its lease, or the whole run's limit)? */
  const outOfTime = (row: BrowserRunRow, now: number) =>
    Date.parse(row.leaseUntil) <= now || Date.parse(row.startedAt) + BROWSER_RUN_LIMITS.runMs <= now

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
    /** POST /browser-runs { host, conversationId? } + this PC's key header: the gate, then the lock. */
    start(member: Member, body: unknown, deviceKey: string | undefined): Outcome<BrowserRunStarted> {
      if (!isMap(body) || Object.keys(body).some(k => k !== 'host' && k !== 'conversationId') || typeof body.host !== 'string'
        || (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !CONVERSATION_RE.test(body.conversationId)))) {
        return refuse('bad-request', W.badRun, { code: 'BROWSER_BAD_RUN' })
      }
      const host = normalizeBrowserHost(body.host)
      if (!host || host !== body.host) return refuse('conflict', W.notAllowed, { code: 'BROWSER_NOT_ALLOWED' })
      const pc = deps.devices.check(member, deviceKey, null)
      if (!pc.ok) return pc
      const refused = allowed(member, host)
      if (refused) return refused
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
      return deps.transactions.run((): Outcome<BrowserRunStarted> => {
        const now = deps.clock.nowMs()
        const r = repo(member.companyId)
        const holder = r.runningOn(host)
        if (holder) settleTime(member.companyId, holder, now)
        const id = `bo_${deps.ids.newToken().slice(0, 32)}`
        const inserted = r.insert({
          id, userId: member.userId, host, deviceId: pc.value.deviceId, conversationId, state: 'running', reason: null,
          startedAt: iso(now), leaseUntil: iso(now + BROWSER_RUN_LIMITS.leaseMs), endedAt: null,
        })
        if (!inserted) return refuse('conflict', W.busy, { code: 'BROWSER_RUN_BUSY' })
        return ok({ runId: id, leaseMs: BROWSER_RUN_LIMITS.leaseMs })
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
      const until = Math.min(now + BROWSER_RUN_LIMITS.leaseMs, Date.parse(row.startedAt) + BROWSER_RUN_LIMITS.runMs)
      if (!repo(member.companyId).renew(row.id, iso(until))) return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
      return ok({ leaseMs: until - now })
    },

    /**
     * POST /browser-runs/:runId/finish { outcome, reason?, steps }: the log kept (once), the lock released. A run that
     * already ended (timed out, refused) still gets its log once: what was done is always known afterwards (I8).
     */
    finish(member: Member, runId: string, body: unknown): Outcome<{ state: BrowserRunState }> {
      const row = ownRun(member, runId)
      if (!row) return refuse('not-found', W.notFound, { code: 'BROWSER_RUN_NOT_FOUND' })
      if (!isMap(body) || Object.keys(body).some(k => k !== 'outcome' && k !== 'reason' && k !== 'steps')
        || !(BROWSER_RUN_OUTCOMES as readonly unknown[]).includes(body.outcome) || browserRunLogProblem(body.steps)
        || (body.reason !== undefined && typeof body.reason !== 'string')) {
        return refuse('bad-request', W.badRun, { code: 'BROWSER_BAD_RUN' })
      }
      const outcome = body.outcome as BrowserRunOutcome
      const reason = isBrowserRunEndReason(body.reason) ? body.reason : null
      const steps = body.steps as BrowserRunLogStep[]
      return deps.transactions.run((): Outcome<{ state: BrowserRunState }> => {
        const r = repo(member.companyId)
        const now = deps.clock.nowMs()
        const current = r.byId(row.id)
        if (!current) return refuse('not-found', W.notFound, { code: 'BROWSER_RUN_NOT_FOUND' })
        if (current.state === 'running') {
          if (!settleTime(member.companyId, current, now)) r.end(current.id, outcome, reason, iso(now))
        } else if (r.logOf([current.id]).length > 0) {
          return refuse('conflict', W.ended, { code: 'BROWSER_RUN_ENDED' })
        }
        r.appendLog(steps.map((s, i) => ({ runId: current.id, idx: i + 1, page: s.page, action: s.action, label: s.label })))
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
      return ok({
        runs: settled.map(row => view(row, log.filter(l => l.runId === row.id).map(l => ({ page: l.page, action: l.action, label: l.label })))),
      })
    },

    /** In removeMember's transaction: their running runs end (`left`), the lock goes. */
    memberLeft(companyId: string, userId: string): void {
      const at = iso(deps.clock.nowMs())
      for (const id of repo(companyId).runningOf(userId)) repo(companyId).end(id, 'left', null, at)
    },
  }
}

export type BrowserRunService = ReturnType<typeof createBrowserRunService>
