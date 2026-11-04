/**
 * The server clock (stage 2 S14, owner decision 2026-11-01;
 * `.claude/rules/notifications.md` "The server clock"). **The AI never runs on
 * the server.** The clock only notices that a time has come and:
 *
 * 1. moves a waiting task whose 「返事・届く見込み」 (`wait_until`) has passed to
 *    the right turn so 追いかけ can happen (core-types.ts `WAIT_OVER`): the
 *    AI's turn when the assignee's own 自動で進める is on (their PC runs it:
 *    shared/core/work-switches.ts) and the type has an AI step there, else
 *    the assignee's — through the service writer (its value
 *    and reader checks, compare-and-set, one ledger entry with the clock as
 *    actor, `CLOCK_ACTOR`), which tells the assignee (a notice, S5);
 * 2. writes the overdue (A-2) and stuck-AI-turn (C-18) notices
 *    (`notifications.sweep`);
 * 3. erases expired content (the content store's retention, `expireContent`);
 * 4. reads each connected member's new mail into the inbox (`pollInbox`,
 *    inbox.md "Receiving": header facts and pointers, never the text).
 *
 * Everything is derived from stored data (no state kept between runs is
 * needed for correctness): running twice changes nothing more — a moved task
 * is no longer waiting, a notice's dedupe key is already there. One run at a
 * time per server; each company in its own batch with limits, so one
 * company's backlog cannot hold up another, with a yield to the event loop
 * between companies (requests keep being served). Each company only through
 * its own handle.
 */
import { CLOCK_ACTOR, WAIT_OVER, WAIT_OVER_ACTION } from '../../shared/core/core-types'
import { aiTurnStates } from '../../shared/core/record-types'
import type { LedgerValue } from '../../shared/core/record-ledger'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { ServiceRecordWriter } from './record-engine'
import { companyNow } from './notifications'
import { currentTypes } from './record-index'

/** Per company and run: tasks moved at most, records looked at per notice kind at most. */
export const CLOCK_LIMITS = Object.freeze({ moves: 50, notices: 500 })
/** How often the clock runs (overdue notices wait for 09:00; a few minutes late is fine). */
export const CLOCK_INTERVAL_MS = 5 * 60_000

export interface ServerClockDeps {
  companyIds: () => string[]
  companyData: CompanyDataSource
  clock: Clock
  writer: Pick<ServiceRecordWriter, 'transition'>
  notifications: { sweep(companyId: string, limit: number): number }
  /**
   * Whether 自動で進める is on for the record's assignee (their own switch within the company's
   * 使ってよいか; services/work-switches.ts `isOn`). No assignee: the company's 初めの値.
   */
  autoRunFor: (companyId: string, assignee: string | null) => boolean
  timeZoneOf: (companyId: string) => string
  /**
   * The content store's retention (records.md "The content store"): erase
   * what expired in this company (reason `retention`), the number erased.
   */
  expireContent?: (companyId: string) => number | Promise<number>
  /** The inbox's poll of this company's mail (inbox.md): the number of messages read. */
  pollInbox?: (companyId: string) => Promise<number>
  /** Let the event loop serve requests between companies. */
  yieldNow: () => Promise<void>
  log?: (message: string) => void
  limits?: { moves: number; notices: number }
}

export interface ClockRun {
  /** False when a run was still going (nothing done). */
  ran: boolean
  moved: number
  notices: number
  expired: number
  mailRead: number
  failedCompanies: number
}

export function createServerClock(deps: ServerClockDeps) {
  const limits = deps.limits ?? CLOCK_LIMITS
  const log = deps.log ?? ((message: string) => console.log(message))
  let running = false

  /** Waiting records of one company whose expected time has passed, moved to the right turn. */
  function moveWaitOver(companyId: string): number {
    const records = deps.companyData.forCompany(companyId).records
    const types = currentTypes(records)
    const now = companyNow(deps.clock.nowMs(), deps.timeZoneOf(companyId))
    const today = now.slice(0, 10)
    let moved = 0
    for (const [type, rule] of Object.entries(WAIT_OVER)) {
      const def = types.get(type)?.definition
      if (!def || def.fields[rule.field]?.kind !== 'date' || !def.states.includes(rule.from)) continue
      const left = limits.moves - moved
      if (left <= 0) break
      // A day is over (`< today`), or a time today has come (`today T…` up to now) — oldest first.
      const sort = { field: rule.field, order: 'asc' as const }
      const passed = [
        ...records.candidates({ types: [type], states: [rule.from], ranges: [{ name: rule.field, lt: today }], sort }, left),
        ...records.candidates({ types: [type], states: [rule.from], ranges: [{ name: rule.field, gte: `${today}T`, lt: now }], sort }, left),
      ].slice(0, left)
      if (passed.length === 0) continue
      const hasAiStep = aiTurnStates(def).has(rule.aiTurn)
      for (const s of records.states(passed.map(r => r.id))) {
        if (s.state !== rule.from) continue
        let fields: Record<string, LedgerValue> = {}
        try { fields = JSON.parse(s.fields) as Record<string, LedgerValue> } catch { continue }
        const assignee = typeof fields.assignee === 'string' && fields.assignee !== '' ? fields.assignee : null
        // The AI's turn runs on the assignee's PC: their own 自動で進める decides.
        const to = hasAiStep && deps.autoRunFor(companyId, assignee) ? rule.aiTurn : rule.personTurn
        if (!def.states.includes(to)) continue
        const r = deps.writer.transition(companyId, {
          recordId: s.recordId, action: WAIT_OVER_ACTION, expectedVersion: s.version, to,
          // The assignee's turn (also while the AI prepares: 「AI の番」 shows whose).
          ...(assignee ? { fields: { next_actor: assignee } } : {}),
          // 経緯 says why it came back, with the 見込み it passed (「返事の見込み（11/6）を過ぎました」).
          actor: { ...CLOCK_ACTOR }, note: waitOverNote(fields[rule.field]),
        })
        // `stale`: someone moved it in between — their change stands; the next run looks again.
        if (r.ok) moved++
      }
    }
    return moved
  }

  async function runCompany(companyId: string, run: ClockRun) {
    const handle = deps.companyData.forCompany(companyId)
    if (!handle.records.settings().enabled) return
    run.moved += moveWaitOver(companyId)
    run.notices += deps.notifications.sweep(companyId, limits.notices)
    if (deps.expireContent) run.expired += await deps.expireContent(companyId)
    if (deps.pollInbox) run.mailRead += await deps.pollInbox(companyId)
  }

  return {
    /** One pass over every company. A call while a pass is running does nothing (`ran: false`). */
    async runOnce(): Promise<ClockRun> {
      const run: ClockRun = { ran: false, moved: 0, notices: 0, expired: 0, mailRead: 0, failedCompanies: 0 }
      if (running) return run
      running = true
      run.ran = true
      try {
        for (const companyId of deps.companyIds()) {
          try {
            await runCompany(companyId, run)
          } catch (error) {
            // One company's failure never stops the others (no content in the log).
            run.failedCompanies++
            log(`[server-clock] company ${companyId} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
          }
          await deps.yieldNow()
        }
      } finally {
        running = false
      }
      if (run.moved + run.notices + run.expired + run.mailRead + run.failedCompanies > 0) {
        log(`[server-clock] moved ${run.moved}, notices ${run.notices}, expired ${run.expired}, mail read ${run.mailRead}${run.failedCompanies ? `, ${run.failedCompanies} company(ies) failed` : ''}`)
      }
      return run
    },
  }
}

export type ServerClock = ReturnType<typeof createServerClock>

/** The clock's 経緯 note: 「返事の見込み（11/6）を過ぎました」, 「…（11/6 15:00）…」 with a time. */
export function waitOverNote(waitUntil: LedgerValue | undefined): string {
  const m = typeof waitUntil === 'string' ? /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(waitUntil) : null
  return m ? `返事の見込み（${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}）を過ぎました` : '返事の見込みを過ぎました'
}
