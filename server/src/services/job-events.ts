/**
 * Event-triggered jobs (出来事で動く定期の仕事, stage 4a, `.claude/rules/jobs.md` "Event-triggered jobs"; owner memo
 * 「出来事で動く定期の仕事」 §3 / §10 / §11 / §12). **No AI here**: an event makes an occurrence, and the server's runner
 * makes its やること (services/job-occurrences.ts) as for a time slot.
 *
 * - **The scan** (`scan`, run by the clock inside `makeOccurrences`): each approved, active, accepted event job reads,
 *   on its own, the ledger rows **of its watched record** after its own cursor **by delivery number** (records.md
 *   "Delivery order": a row written later with an earlier time is never passed by), at most `EVENT_ROWS_PER_TICK` per
 *   tick — the rest next tick, from the cursor; with nothing more of that record, the cursor moves up to now. A job
 *   that fails or was paused long never holds another back. An occurrence (`due_slot` `ev:<seq>`, one per job and event: `UNIQUE`) and the cursor's move are one
 *   transaction (compare-and-set on the cursor), so a crash, a second tick or a restart neither misses nor doubles one.
 * - **What is never an event** (`ledgerRowIsEvent`, `triggerMatches` in shared/core/jobs.ts): a marked row (migration,
 *   the server's own actors), a run's row (`run_id`: a job's run, an AI turn), an outside actor's row (a plugin's
 *   import, the minutes intake), a row whose state did not change; a person's change and their own consultation's AI
 *   count. Here, besides: only the job's **watch target** (the one record it watches, server-managed: the accepted
 *   start record, then — with `followMadeTask` — the やること its occurrence made; never a title), once per target, its
 *   assignee at that version the responsible person (whoever completed it), the responsible person reading it now, at
 *   a state that is not the AI's turn (⑧).
 * - **Paused or stopped** (③): nothing is looked at while it lasts; the gap it opened (`openEventGap`, from the
 *   delivery number at the pause) keeps everything meanwhile from running after the resume, while what came before
 *   the pause and was not looked at yet still runs. Not accepted (a new consent approved): the cursor jumps to now.
 * - **The day's limit** (⑦ / ⑨): occurrences made per job and company day, at most the grant's `runsPerDay`; beyond it
 *   nothing is made, the job is never paused for it, and the chain stops — told once (`job_chain_stopped`), the limit as
 *   its cause (owner decision: one notice).
 * - **Who sees an event occurrence** (⑥, `eventShown`): only someone who reads its record now — owners and admins too.
 * - **A chain that stays stopped** (`remindStoppedChains`): its responsible person's own stop notice comes back once,
 *   `CHAIN_STOP_REMIND_AFTER_MS` after the stop, while they can still act on it.
 */
import {
  eventDueSlot, isEventOccurrenceSlot, isRecordTrigger, jobSetWatchOpened, ledgerRowIsEvent, newOccurrenceId, storedJobDefinition, triggerMatches,
  type JobDefinition, type JobOutcomeCode, type JobRecordTrigger, type JobSetMarkOutcome, type LedgerEventRow,
} from '../../shared/core/jobs'
import { aiTurnStates } from '../../shared/core/record-types'
import { replayRecordState } from '../../shared/core/record-ledger'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { CHAIN_STOP_REMINDED, companyNow } from './notifications'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'
import { isSetWatchDefinition, minutesReviewEvent, minutesReviewKindKnown, setGuardRefusal, setOccurrenceShown, type MinutesReviewId } from './job-set-watch'

/** Ledger rows of a watched record the scan reads per job and clock tick (the rest next tick, from the cursor). */
export const EVENT_ROWS_PER_TICK = 500
/** How many of a watched record's rows a skipped stretch (an older build's pause, a content not accepted) is checked over. */
const DROPPED_ROWS_CHECKED = 5000

/**
 * How long a chain stays stopped before its one reminder (jobs.md "A stopped chain"): 3 days. A stop on a Friday evening
 * comes back on Monday evening — after a weekend nobody reads the bell, not before — and a daily chain has not been
 * silently off for a whole week. One reminder only: after it the stop stays shown in 「定期の仕事」 as before.
 */
export const CHAIN_STOP_REMIND_AFTER_MS = 3 * 24 * 60 * 60_000

/** The states where it is the AI's turn for a type, from the business plugins' steps (plugin-steps.ts). */
export type AiStepStates = (companyId: string, type: string) => ReadonlySet<string>

export interface JobEventDeps {
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  roleOf: (companyId: string, userId: string) => string | null
  timeZoneOf: (companyId: string) => string
  /** A business plugin step's states that run as 「AI の番」 (absent: the type's own AI-only states alone). */
  aiStepStates?: AiStepStates
  /**
   * 4b-4 PR2, the set watch (job-set-watch.ts): the id of a meeting's 「議事録を確認する」. Absent → a set watch reads nothing (fails
   * closed: its records cannot be told apart from a person's).
   */
  minutesReviewId?: MinutesReviewId
  log?: (message: string) => void
}

class CursorMoved extends Error {
  constructor() { super('cursor moved'); this.name = 'CursorMoved' }
}

/** Whether `state` of `type` is the AI's turn now: an AI-only action starts there, or a business plugin's step runs there. */
export function aiTurnState(handle: CompanyData, aiStepStates: AiStepStates | undefined, type: string, state: string | null): boolean {
  if (state === null) return false
  const def = currentTypes(handle.records).get(type)?.definition
  if (def && aiTurnStates(def).has(state)) return true
  return aiStepStates?.(handle.companyId, type).has(state) === true
}

/** The record as `member` reads it now: there, not removed, and theirs to read (owner-only / members-only included); else null. */
function readableRow(handle: CompanyData, member: Member, recordId: string) {
  const row = handle.records.byIds([recordId])[0]
  if (!row || row.removedAt !== null) return null
  return recordReader(member, handle.scopes.listWithRules()).record(row) ? row : null
}

/**
 * Whether the viewer may see this occurrence at all (⑥): a time slot always; an event one only while they read its
 * record — and an `ev:` slot that names no record (never written by 4a) by nobody (fails closed, as 4-0.1 did). A set watch's
 * (4b-4 PR2, its meeting pinned) only while they also read that meeting and are one of its people (§2-5: never an owner / admin
 * who did not attend).
 */
export function eventShown(handle: CompanyData, member: Member, occ: { eventRecordId?: string | null; dueSlot?: string; eventMeetingId?: string | null }): boolean {
  if (!occ.eventRecordId) return !isEventOccurrenceSlot(occ.dueSlot ?? '')
  if (occ.eventMeetingId) return setOccurrenceShown(handle, member, occ.eventRecordId, occ.eventMeetingId)
  return readableRow(handle, member, occ.eventRecordId) !== null
}

/** An occurrence's slot as an answer may carry it: an event one's is its event's time in company time, never its delivery number (§11). */
export function shownSlot(occ: Pick<JobOccurrenceRow, 'eventSeq' | 'dueSlot' | 'dueAt' | 'timeZone'>): string {
  return occ.eventSeq !== null && occ.eventSeq !== undefined ? companyNow(Date.parse(occ.dueAt), occ.timeZone) : occ.dueSlot
}

/** The record's state and assignee at one of its versions (its ledger replayed), or null when the ledger cannot say. */
function at(handle: CompanyData, recordId: string, version: number): { state: string | null; assignee: string | null } | null {
  try {
    const r = replayRecordState(handle.records.ledger(recordId), version)
    return { state: r.state, assignee: typeof r.fields.assignee === 'string' ? r.fields.assignee : null }
  } catch {
    return null
  }
}

/** The record's state and assignee now. */
function now(handle: CompanyData, recordId: string): { state: string | null; assignee: string | null } {
  const s = handle.records.states([recordId])[0]
  let fields: Record<string, unknown> = {}
  try { fields = s ? JSON.parse(s.fields) as Record<string, unknown> : {} } catch { fields = {} }
  return { state: s?.state ?? null, assignee: typeof fields.assignee === 'string' ? fields.assignee : null }
}

/**
 * The company's own check of a record trigger (`JobService` on save and approval), beyond the parser's: the type is
 * there with an `assignee`, its states are the type's, the watched state is not the AI's turn (⑧), and the start record
 * — when named — is a live record of that type read both by `saver` (when given) and by the responsible person: one code
 * whatever fails, so the answer never tells a record someone cannot read from one that does not exist. Codes only.
 */
export function recordTriggerProblems(handle: CompanyData, aiStepStates: AiStepStates | undefined, trigger: JobRecordTrigger,
  readers: Member[]): string[] {
  const problems: string[] = []
  const def = currentTypes(handle.records).get(trigger.type)?.definition
  if (!def || def.fields.assignee?.kind !== 'person') return ['trigger.type.NOT_HERE']
  for (const s of [trigger.to, trigger.from]) if (s !== undefined && !def.states.includes(s)) problems.push('trigger.state.NOT_HERE')
  if (trigger.event === 'state' && aiTurnState(handle, aiStepStates, trigger.type, trigger.to ?? null)) problems.push('trigger.to.AI_TURN')
  if (trigger.startRecord !== undefined) {
    const ok = readers.every(m => {
      const row = readableRow(handle, m, trigger.startRecord as string)
      return row !== null && row.type === trigger.type
    })
    if (!ok) problems.push('trigger.startRecord.NOT_FOUND')
  }
  return problems
}

export function createJobEvents(deps: JobEventDeps) {
  const { transactions, clock, ids } = deps
  const log = deps.log ?? ((message: string) => console.log(message))
  /** Jobs whose scan failed last time: logged once while it keeps failing. */
  const failing = new Set<string>()
  /** Jobs whose reminder check failed last time (logged once while it keeps failing). */
  const remindFailing = new Set<string>()

  const memberOf = (companyId: string, userId: string): Member | null => {
    const role = deps.roleOf(companyId, userId)
    return role === null ? null : { companyId, userId, role }
  }

  /**
   * Whether a change of the job's watched record is its event (the parts that need the record), at the event: the
   * responsible person reads the record now, its assignee at that version is them, its state then not the AI's turn (⑧).
   * null when it is; else why not — the watched record reached the state, so the chain stops for that (owner decision ①).
   */
  function applies(handle: CompanyData, definition: JobDefinition, trigger: JobRecordTrigger, row: LedgerEventRow): null | 'EVENT_RECORD_GONE' | 'EVENT_NOT_ASSIGNEE' | 'EVENT_AI_TURN' {
    const responsible = memberOf(handle.companyId, definition.actingUser)
    if (!responsible || readableRow(handle, responsible, row.recordId) === null) return 'EVENT_RECORD_GONE'
    const then = at(handle, row.recordId, row.version)
    if (!then || then.assignee !== definition.actingUser) return 'EVENT_NOT_ASSIGNEE'
    return aiTurnState(handle, deps.aiStepStates, trigger.type, then.state) ? 'EVENT_AI_TURN' : null
  }

  /**
   * Right before the runner acts on an event occurrence: why it must not (skipped, the job left as it is — ⑥), or null.
   * The record still the responsible person's to read, its assignee them now, the state of its event not the AI's turn
   * now (a business plugin installed since), and still the job's watched record (no other start record accepted since).
   */
  function recheck(handle: CompanyData, occ: JobOccurrenceRow, definition: JobDefinition): JobOutcomeCode | null {
    const trigger = definition.trigger
    if (!isRecordTrigger(trigger) || !occ.eventRecordId || occ.eventVersion === null || occ.eventVersion === undefined) return 'EVENT_RECORD_GONE'
    const responsible = memberOf(handle.companyId, definition.actingUser)
    if (!responsible || readableRow(handle, responsible, occ.eventRecordId) === null) return 'EVENT_RECORD_GONE'
    if (handle.jobs.eventCursor(occ.jobId)?.watch !== occ.eventRecordId) return 'EVENT_NOT_WATCHED'
    if (now(handle, occ.eventRecordId).assignee !== definition.actingUser) return 'EVENT_NOT_ASSIGNEE'
    const then = at(handle, occ.eventRecordId, occ.eventVersion)
    if (!then || aiTurnState(handle, deps.aiStepStates, trigger.type, then.state)) return 'EVENT_AI_TURN'
    return null
  }

  /**
   * The chain of watched records stopped (owner decision ①): kept on the cursor with why and on which record, and — once
   * per stop — the responsible person is told (always: they choose the next watched やること — the owner-approved exception
   * to ⑥, D7 = A) and the job's creator only while an owner / admin **who reads that record now** (every stop is
   * record-side: it happened because the record reached the watched state; for anyone else it does not exist, as an
   * event occurrence of a record they cannot read). The notice names only the job; its cause is built when read
   * (`jobs.chainStopNotice`, which checks the reader again). In the caller's transaction.
   */
  function chainStopped(handle: CompanyData, jobId: string, code: string, recordId: string, told: Set<string>): void {
    const at = clock.now()
    if (!handle.jobs.stopChain(jobId, code, recordId, at)) return
    const job = handle.jobs.find(jobId)
    if (!job) return
    const version = job.approvedVersion === null ? null : handle.jobs.version(jobId, job.approvedVersion)
    const to = new Set<string>()
    if (version && deps.roleOf(handle.companyId, version.actingUserId) !== null) to.add(version.actingUserId)
    const creator = memberOf(handle.companyId, job.createdBy)
    if (creator && (creator.role === 'owner' || creator.role === 'admin') && readableRow(handle, creator, recordId) !== null) to.add(job.createdBy)
    const written = handle.notifications.insert([...to].map(userId => ({
      id: ids.newId(), userId, kind: 'job_chain_stopped' as const, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      dedupeKey: `job_chain_stopped:${jobId}:${at}`, createdAt: at, readAt: null,
    })))
    if (written.length > 0) for (const u of to) told.add(u)
  }

  /**
   * A chain that stays stopped (jobs.md "A stopped chain", its reminder): `CHAIN_STOP_REMIND_AFTER_MS` after the stop,
   * the responsible person's **own stop notice comes back once** — unread again, on top, worded 「止まったままです」 — and
   * nothing new is written (no new kind or key: a build that does not know the reminder, the rollback floor included,
   * shows and hides that row exactly as before). Only while they can act on it and nothing changed since: the job active
   * (not paused, retired or under the company's stop), **not written since the stop** (`ai_jobs.updated_at`: no approval —
   * also an older version approved again —, edit, acceptance, pause or resume after it, so its approved version and
   * responsible person are the ones the stop was told about), its approved content accepted, the responsible person a
   * member who **reads the stop's record now** (never anyone who cannot: the safe side of D7's exception), and that very
   * stop still standing (a choice made again, the watch moved, a new stop: another key). While the company's records are
   * off nothing is looked at (the reminder waits; it is not used up). Every check and the compare-and-set on the row's
   * mark are one transaction: once per stop. Nobody else is touched.
   */
  function remindStoppedChains(handle: CompanyData, stopped: boolean, told: Set<string>): void {
    if (stopped || !handle.records.settings().enabled) return
    const nowMs = clock.nowMs()
    for (const job of handle.jobs.list()) {
      // Each job on its own, as the scan: one that fails never holds another back. Logged once while it keeps failing;
      // not while its scan's failure is logged already — and so logged once that has passed, if this still fails.
      try {
        remindOne(handle, job.id, nowMs, told)
        remindFailing.delete(job.id)
      } catch (error) {
        if (failing.has(job.id)) continue
        if (!remindFailing.has(job.id)) log(`[job-events] company ${handle.companyId} job ${job.id} reminder failed: ${error instanceof Error ? error.name : 'unknown error'}`)
        remindFailing.add(job.id)
      }
    }
  }

  /** One job's part of `remindStoppedChains`: a cheap look first, then everything again with the write. */
  function remindOne(handle: CompanyData, jobId: string, nowMs: number, told: Set<string>): void {
    const due = (stop: { at: string } | null): stop is { at: string } => stop !== null && nowMs - Date.parse(stop.at) >= CHAIN_STOP_REMIND_AFTER_MS
    const seen = handle.jobs.eventCursor(jobId)?.chainStop ?? null
    if (!due(seen)) return
    transactions.run(() => {
      const job = handle.jobs.find(jobId)
      const stop = handle.jobs.eventCursor(jobId)?.chainStop ?? null
      if (!due(stop) || !job || job.state !== 'active' || job.approvedVersion === null) return
      if (Date.parse(job.updatedAt) > Date.parse(stop.at)) return
      const version = handle.jobs.version(jobId, job.approvedVersion)
      const definition = version ? storedJobDefinition(version) : null
      if (!version || !definition || !isRecordTrigger(definition.trigger)) return
      if (job.acceptedConsent === null || job.acceptedConsent !== version.consentFingerprint) return
      const responsible = memberOf(handle.companyId, version.actingUserId)
      if (!responsible || readableRow(handle, responsible, stop.record) === null) return
      if (handle.notifications.remindOnce(responsible.userId, `job_chain_stopped:${jobId}:${stop.at}`, CHAIN_STOP_REMINDED, clock.now())) told.add(responsible.userId)
    })
  }

  /**
   * What happened to the watched record since the cursor is never run (a pause or a stop an older build made, a new
   * content not accepted yet): when it reached the watched state meanwhile, the chain stops for `code`. Then the cursor
   * is at now. `jobId` null: every event job of the company. In the caller's transaction.
   */
  function dropUntilNow(handle: CompanyData, jobId: string | null, code: string, told: Set<string>): void {
    for (const job of jobId === null ? handle.jobs.list() : [handle.jobs.find(jobId)].filter((j): j is JobRow => j !== null)) {
      const cursor = handle.jobs.eventCursor(job.id)
      const version = job.approvedVersion === null ? null : handle.jobs.version(job.id, job.approvedVersion)
      const definition = version ? storedJobDefinition(version) : null
      if (cursor && definition && isRecordTrigger(definition.trigger) && !cursor.fired) {
        const rows = handle.jobs.watchedEvents(cursor.watch, cursor.seen, handle.jobs.ledgerSeqNow(), DROPPED_ROWS_CHECKED)
        const trigger = definition.trigger
        // Whatever the record-side checks would say: it reached the state while nothing ran, and that is the cause.
        if (rows.some(row => ledgerRowIsEvent(row) && triggerMatches(trigger, row))) {
          handle.jobs.markWatchFired(job.id, cursor.watch, clock.now())
          chainStopped(handle, job.id, code, cursor.watch, told)
        }
      }
      handle.jobs.resyncEventCursors(job.id, clock.now())
    }
  }

  /**
   * The clock's part for one company (`makeOccurrences`): the event occurrences of every event job, bounded per tick.
   * `stopped`: the company's 「定期の仕事をすべて止める」. The number made; `told` gets who was told.
   */
  function scan(handle: CompanyData, stopped: boolean, told: Set<string>): number {
    const companyId = handle.companyId
    const nowMs = clock.nowMs()
    const stamp = clock.now()
    const zone = deps.timeZoneOf(companyId)
    const day = companyNow(nowMs, zone).slice(0, 10)
    let made = 0
    for (const job of handle.jobs.list()) {
      if (job.approvedVersion === null || (job.state !== 'active' && job.state !== 'paused')) continue
      // Each job on its own (review of #700): one that fails — or one paused for long — never holds another back.
      try {
        made += scanJob(handle, job, stopped, { nowMs, stamp, zone, day }, told) + scanSetJob(handle, job, stopped, { nowMs, stamp, zone, day }, told)
        failing.delete(job.id)
      } catch (error) {
        // Another clock moved its cursor first (two servers): nothing of this pass was kept. Anything else: logged once
        // while it keeps failing (error name only), and the next tick tries again.
        if (!(error instanceof CursorMoved) && !failing.has(job.id)) {
          failing.add(job.id)
          log(`[job-events] company ${companyId} job ${job.id} scan failed: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    }
    return made
  }

  /**
   * Whether a job's cursor may be read on now (an event job's and a set watch's alike): the job active and the company's jobs not
   * stopped (the gap opened then keeps what happens meanwhile from running later); not written by an older build since (a
   * rollback: it pauses and stops without gaps — nothing from before now runs, the safe side, Codex review of #700; a stale gap
   * ends now); the approved consent accepted (else what happens before its 受け取る never runs: the cursor moves to now).
   * `setWatch`: an older build's change also moves a set watch's switch boundary to now — it may have accepted a new consent
   * without moving it (independent review of 4b-4 PR2), so nothing read or made before now counts as after an acceptance.
   */
  function cursorReady(handle: CompanyData, job: JobRow, consent: string, at: NonNullable<ReturnType<CompanyData['jobs']['eventCursor']>>, stopped: boolean, stamp: string, told: Set<string>, setWatch = false): boolean {
    // Paused, or the company's stop: nothing now; the gap opened then keeps what happens meanwhile from running later.
    if (job.state !== 'active' || stopped) return false
    // Running, yet a gap of its pause (or of the company's stop) is still open: the pause or the stop was lifted by a
    // build before 4a (a rollback round trip) — 4a never leaves one open while running (review of #700).
    const staleGap = handle.jobs.openGapKeys(job.id)
    if (job.updatedAt !== at.jobStamp || handle.jobs.stopStamp() !== at.stopStamp) {
      transactions.run(() => {
        for (const key of staleGap) handle.jobs.closeEventGaps(key === '' ? null : job.id, stamp)
        dropUntilNow(handle, job.id, 'PAUSED_EVENT', told)
        if (setWatch) handle.jobs.startSetCursor(job.id, stamp)
      })
      log(`[job-events] company ${handle.companyId} job ${job.id}: changed by an older build; events before now are not run`)
      return false
    }
    // A stale gap this job saw lifted already (its stamps match: its cursor began after the older build lifted it — a job
    // made since): it ends where this job began looking, and what came after runs as usual.
    if (staleGap.length > 0) transactions.run(() => { for (const key of staleGap) handle.jobs.closeEventGaps(key === '' ? null : job.id, stamp, at.seen) })
    // Another consent approved and not accepted yet: what happens before its 受け取る never runs.
    if (job.acceptedConsent === null || job.acceptedConsent !== consent) {
      transactions.run(() => dropUntilNow(handle, job.id, 'VERSION_EVENT', told))
      return false
    }
    return true
  }

  /**
   * A set watch's part of a tick (schema 5, 4b-4 PR2; jobs.md "The set watch (schema 5)"), in one transaction: the company's
   * ledger rows into `done` of a やること after its cursor, by delivery number (never by time), at most `EVENT_ROWS_PER_TICK`; for
   * each that is the combination's event of **this** job's responsible person (job-set-watch.ts `minutesReviewEvent`: someone
   * else's record is left to that person's job, nothing marked here), the record's 「使った」 mark — one per record in the company —
   * is written whatever comes of it: `made` with its occurrence, or why not (inside a pause's gap, before the boundary or a guard
   * that does not hold, beyond the day's limit, a business plugin step busy with it). A record marked already (by any job) makes
   * nothing. The cursor moves in the same transaction (compare-and-set). A combination no longer opened, or a task type that no
   * longer means it (T9), reads nothing and its cursor follows now (what came meanwhile never runs late).
   */
  function scanSetJob(handle: CompanyData, job: JobRow, stopped: boolean, t: { nowMs: number; stamp: string; zone: string; day: string }, told: Set<string>): number {
    const version = handle.jobs.version(job.id, job.approvedVersion as number)
    const definition = version ? storedJobDefinition(version) : null
    if (!version || !isSetWatchDefinition(definition)) return 0
    const trigger = definition.trigger
    const at = handle.jobs.eventCursor(job.id)
    // A line taken out of `JOB_SET_WATCH_OPENED` stops its jobs: nothing read, nothing made (T22) — and its cursor follows now,
    // so nothing completed meanwhile runs late if the line comes back (compare-and-set: another clock's move wins).
    if (!jobSetWatchOpened(trigger)) {
      if (at !== null) transactions.run(() => { handle.jobs.moveEventCursor(job.id, at.seen, Math.max(at.seen, handle.jobs.ledgerSeqNow()), t.stamp) })
      return 0
    }
    // Never accepted (its acceptance starts the cursor and the boundary), or nothing to tell its records by: nothing.
    const reviewId = deps.minutesReviewId
    if (at === null || !reviewId) return 0
    if (!cursorReady(handle, job, version.consentFingerprint, at, stopped, t.stamp, told, true)) return 0
    // The task type no longer means what the job names (T9): nothing is read until it does again — never a guess — and, as for a
    // line taken out above, its cursor follows now (compare-and-set), so what was completed meanwhile never runs late once the
    // kind is back (owner decision, the safe side of 4b-4 PR2's open question).
    if (!minutesReviewKindKnown(handle)) {
      if (!failing.has(`${job.id}:kind`)) log(`[job-events] company ${handle.companyId} job ${job.id}: its record kind is no longer known; nothing is read`)
      failing.add(`${job.id}:kind`)
      transactions.run(() => { handle.jobs.moveEventCursor(job.id, at.seen, Math.max(at.seen, handle.jobs.ledgerSeqNow()), t.stamp) })
      return 0
    }
    failing.delete(`${job.id}:kind`)
    const responsible = memberOf(handle.companyId, definition.actingUser)
    return transactions.run((): number => {
      const newest = handle.jobs.ledgerSeqNow()
      if (newest <= at.seen) return 0
      const rows = handle.jobs.ledgerInto('task', 'done', at.seen, newest, EVENT_ROWS_PER_TICK)
      const gaps = handle.jobs.eventGaps(job.id)
      const inGap = (seq: number) => gaps.some(g => seq > g.from && (g.until === null || seq <= g.until))
      let today = handle.jobs.eventOccurrencesOn(job.id, t.day)
      let n = 0
      for (const row of rows) {
        // `causes: human` under `ledger_v1`: a person, or their own consultation's AI — never a migration, the server, a run,
        // an outside writer or a business plugin's screen.
        if (!ledgerRowIsEvent(row)) continue
        const event = minutesReviewEvent(handle, reviewId, definition.actingUser, row)
        if (!event) continue
        // `unit: record`: one mark per record in the company — whichever job, version or outcome wrote it.
        if (handle.jobs.meetingReviewMarked(row.recordId)) continue
        const mark = (outcome: JobSetMarkOutcome, occurrenceId: string | null = null) => handle.jobs.markMeetingReview({
          recordId: row.recordId, meetingId: event.meetingId, jobId: job.id, outcome, occurrenceId, at: t.stamp,
        })
        // Reached while paused or stopped: never runs (③).
        if (inGap(row.seq)) { mark('paused'); continue }
        const refused = responsible
          ? setGuardRefusal(handle, trigger, definition, { responsible, boundary: at.setBoundary, recordId: row.recordId, version: row.version, meetingId: event.meetingId, at: t.stamp })
          : 'not_matched'
        if (refused) { mark(refused); continue }
        // The day's limit (company time): beyond it nothing is made — its one notice a day to the responsible person (no
        // meeting's name, no count); they can still have it made in a consultation.
        if (today >= definition.grant.limits.runsPerDay) {
          mark('day_limit')
          dayLimitNotice(handle, job.id, definition.actingUser, t.day, t.stamp, told)
          continue
        }
        const id = newOccurrenceId(ids.newId().replace(/-/g, '').toLowerCase().slice(0, 32).padEnd(32, '0'))
        const occurrenceAt = new Date(t.nowMs).toISOString()
        const inserted = handle.jobs.insertOccurrence({
          id, jobId: job.id, jobVersion: version.version, dueSlot: eventDueSlot(row.seq), timeZone: t.zone,
          dueAt: new Date(Date.parse(row.at)).toISOString(),
          // Its time to run counts from now (the event may have been read late), never from the event.
          expiresAt: new Date(t.nowMs + definition.missed.expiresAfterMinutes * 60_000).toISOString(),
          state: 'due', runId: null, outcomeCode: null, createdAt: occurrenceAt, updatedAt: occurrenceAt,
          eventSeq: row.seq, eventRecordId: row.recordId, eventVersion: row.version, eventDay: t.day,
          // No watched record (no generation): its end moves, stops or clears no watch.
          watchGeneration: null, eventMeetingId: event.meetingId,
        })
        // One there already is this very event (`UNIQUE (company, job, event_seq)`): marked by the pass that made it.
        if (!inserted) continue
        mark('made', id)
        n++
        today++
      }
      // More rows than one tick reads: on from the last one next tick. Else up to now.
      const to = rows.length >= EVENT_ROWS_PER_TICK ? rows[rows.length - 1].seq : newest
      if (!handle.jobs.moveEventCursor(job.id, at.seen, to, t.stamp)) throw new CursorMoved()
      return n
    })
  }

  /**
   * 「1日の上限を超えたため、作らなかった会議があります」 (4b-4 PR2, §6-2): to the set watch's responsible person only (while a member),
   * once per job and company day (`job_day_limit:<job>:<day>`), recordless; its words are built when read (no meeting's name, no
   * count — `jobs.dayLimitNotice`). In the caller's transaction.
   */
  function dayLimitNotice(handle: CompanyData, jobId: string, userId: string, day: string, at: string, told: Set<string>): void {
    if (deps.roleOf(handle.companyId, userId) === null) return
    const written = handle.notifications.insert([{
      id: ids.newId(), userId, kind: 'job_day_limit' as const, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      dedupeKey: `job_day_limit:${jobId}:${day}`, createdAt: at, readAt: null,
    }])
    if (written.length > 0) told.add(userId)
  }

  /**
   * One event job's part of a tick, in one transaction: the ledger rows **of its watched record only** (by delivery
   * number, after its cursor; at most `EVENT_ROWS_PER_TICK`), what they make, and the cursor's move — to the last row
   * read when there may be more, else to the company's newest delivery number (nothing else can concern this job: it
   * watches one record, and the runner moves the watch only after this tick).
   */
  function scanJob(handle: CompanyData, job: JobRow, stopped: boolean, t: { nowMs: number; stamp: string; zone: string; day: string }, told: Set<string>): number {
    const version = handle.jobs.version(job.id, job.approvedVersion as number)
    const definition = version ? storedJobDefinition(version) : null
    if (!version || !definition || !isRecordTrigger(definition.trigger)) return 0
    const trigger = definition.trigger
    const at = handle.jobs.eventCursor(job.id)
    // Never accepted as an event job: nothing to look at (its acceptance starts the cursor at "now").
    if (at === null) return 0
    if (!cursorReady(handle, job, version.consentFingerprint, at, stopped, t.stamp, told)) return 0
    return transactions.run((): number => {
      const newest = handle.jobs.ledgerSeqNow()
      if (newest <= at.seen) return 0
      const rows = handle.jobs.watchedEvents(at.watch, at.seen, newest, EVENT_ROWS_PER_TICK)
      const gaps = handle.jobs.eventGaps(job.id)
      const inGap = (seq: number) => gaps.some(g => seq > g.from && (g.until === null || seq <= g.until))
      let n = 0
      let today = handle.jobs.eventOccurrencesOn(job.id, t.day)
      // The one record watched, once (an undo and a second completion of it make nothing more).
      let fired = at.fired
      for (const row of rows) {
        if (fired) continue
        if (!ledgerRowIsEvent(row) || !triggerMatches(trigger, row)) continue
        // Reached while paused or stopped (③): never runs — the chain stops there, and says so (①).
        if (inGap(row.seq)) { handle.jobs.markWatchFired(job.id, row.recordId, t.stamp); fired = true; chainStopped(handle, job.id, 'PAUSED_EVENT', row.recordId, told); continue }
        // The watched record reached the state but is not the responsible person's to act on (unreadable, someone else's
        // assignee, 「AI の番」): it never runs, and the chain stops with that cause (owner decision ①).
        const why = applies(handle, definition, trigger, row)
        if (why) { handle.jobs.markWatchFired(job.id, row.recordId, t.stamp); fired = true; chainStopped(handle, job.id, why, row.recordId, told); continue }
        // The day's limit (company time): what comes beyond it is not made (and the job never pauses for it); the chain stops.
        if (today >= definition.grant.limits.runsPerDay) {
          handle.jobs.markWatchFired(job.id, row.recordId, t.stamp); fired = true
          chainStopped(handle, job.id, 'DAY_LIMIT', row.recordId, told)
          continue
        }
        const occurrenceAt = new Date(t.nowMs).toISOString()
        const inserted = handle.jobs.insertOccurrence({
          id: `occ.${ids.newId().replace(/-/g, '').toLowerCase().slice(0, 32).padEnd(32, '0')}`,
          jobId: job.id, jobVersion: version.version, dueSlot: eventDueSlot(row.seq), timeZone: t.zone,
          dueAt: new Date(Date.parse(row.at)).toISOString(),
          // Its time to run counts from now (the event may have been read late), never from the event.
          expiresAt: new Date(t.nowMs + definition.missed.expiresAfterMinutes * 60_000).toISOString(),
          state: 'due', runId: null, outcomeCode: null, createdAt: occurrenceAt, updatedAt: occurrenceAt,
          eventSeq: row.seq, eventRecordId: row.recordId, eventVersion: row.version, eventDay: t.day,
          // The watch it is made for (stage 4b-0.5): only it may move, stop or clear that watch when it ends.
          watchGeneration: at.generation,
        })
        if (inserted) { n++; today++ }
        // Fired whether made or not (one already there is this very event): the target makes nothing more.
        handle.jobs.markWatchFired(job.id, row.recordId, t.stamp)
        fired = true
      }
      // More rows of the record than one tick reads: on from the last one next tick. Else up to now.
      const to = rows.length >= EVENT_ROWS_PER_TICK ? rows[rows.length - 1].seq : newest
      // In the same transaction as what it made: never past an event it did not look at, never back over one.
      if (!handle.jobs.moveEventCursor(job.id, at.seen, to, t.stamp)) throw new CursorMoved()
      return n
    })
  }

  return { scan, recheck, chainStopped, dropUntilNow, remindStoppedChains }
}

export type JobEvents = ReturnType<typeof createJobEvents>
