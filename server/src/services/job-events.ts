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
 *   nothing is made, the job is never paused for it, and the responsible person is told once that day that some were
 *   left (no count).
 * - **Who sees an event occurrence** (⑥, `eventShown`): only someone who reads its record now — owners and admins too.
 */
import {
  eventDueSlot, isRecordTrigger, ledgerRowIsEvent, storedJobDefinition, triggerMatches,
  type JobDefinition, type JobOutcomeCode, type JobRecordTrigger, type LedgerEventRow,
} from '../../shared/core/jobs'
import { aiTurnStates } from '../../shared/core/record-types'
import { replayRecordState } from '../../shared/core/record-ledger'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import type { Member } from './access'
import { companyNow } from './notifications'
import { recordReader } from './record-access'
import { currentTypes } from './record-index'

/** Ledger rows the scan reads per company and clock tick (the rest next tick, from the cursors). */
export const EVENT_ROWS_PER_TICK = 500

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

/** Whether the viewer may see this occurrence at all (⑥): a time slot always; an event one only while they read its record. */
export function eventShown(handle: CompanyData, member: Member, occ: Pick<JobOccurrenceRow, 'eventRecordId'>): boolean {
  if (!occ.eventRecordId) return true
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

  const memberOf = (companyId: string, userId: string): Member | null => {
    const role = deps.roleOf(companyId, userId)
    return role === null ? null : { companyId, userId, role }
  }

  /**
   * Whether a change of the job's watched record is its event (the parts that need the record), at the event: the
   * responsible person reads the record now, its assignee at that version is them, its state then not the AI's turn (⑧).
   */
  function applies(handle: CompanyData, definition: JobDefinition, trigger: JobRecordTrigger, row: LedgerEventRow): boolean {
    const responsible = memberOf(handle.companyId, definition.actingUser)
    if (!responsible || readableRow(handle, responsible, row.recordId) === null) return false
    const then = at(handle, row.recordId, row.version)
    if (!then || then.assignee !== definition.actingUser) return false
    return !aiTurnState(handle, deps.aiStepStates, trigger.type, then.state)
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

  /** The day's limit was reached: the responsible person is told once that day, without a count (⑨). */
  function toldLimited(handle: CompanyData, job: JobRow, definition: JobDefinition, day: string, told: Set<string>) {
    if (deps.roleOf(handle.companyId, definition.actingUser) === null) return
    const written = handle.notifications.insert([{
      id: ids.newId(), userId: definition.actingUser, kind: 'job_events_skipped', recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      dedupeKey: `job_events_skipped:${job.id}:${day}`, createdAt: clock.now(), readAt: null,
    }])
    if (written.length > 0) told.add(definition.actingUser)
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
        made += scanJob(handle, job, stopped, { nowMs, stamp, zone, day }, told)
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
    // Paused, or the company's stop: nothing now; the gap opened then keeps what happens meanwhile from running later.
    if (job.state !== 'active' || stopped) return 0
    // The job or the company's stop was written by a build before 4a (a rollback: it pauses and stops without gaps):
    // nothing from before now runs (the safe side, Codex review of #700).
    if (job.updatedAt !== at.jobStamp || handle.jobs.stopStamp() !== at.stopStamp) {
      transactions.run(() => handle.jobs.resyncEventCursors(job.id, t.stamp))
      log(`[job-events] company ${handle.companyId} job ${job.id}: changed by an older build; events before now are not run`)
      return 0
    }
    // Another consent approved and not accepted yet: what happens before its 受け取る never runs.
    if (job.acceptedConsent === null || job.acceptedConsent !== version.consentFingerprint) {
      transactions.run(() => handle.jobs.startEventCursor(job.id, at.start, t.stamp))
      return 0
    }
    return transactions.run((): number => {
      const newest = handle.jobs.ledgerSeqNow()
      if (newest <= at.seen) return 0
      const rows = handle.jobs.watchedEvents(at.watch, at.seen, newest, EVENT_ROWS_PER_TICK)
      const gaps = handle.jobs.eventGaps(job.id)
      const inGap = (seq: number) => gaps.some(g => seq > g.from && (g.until === null || seq <= g.until))
      let n = 0
      let limited = false
      let today = handle.jobs.eventOccurrencesOn(job.id, t.day)
      // The one record watched, once (an undo and a second completion of it make nothing more).
      let fired = at.fired
      for (const row of rows) {
        if (fired || inGap(row.seq)) continue
        if (!ledgerRowIsEvent(row) || !triggerMatches(trigger, row) || !applies(handle, definition, trigger, row)) continue
        // The day's limit (company time): what comes beyond it is not made (and the job never pauses for it).
        if (today >= definition.grant.limits.runsPerDay) { limited = true; handle.jobs.markWatchFired(job.id, row.recordId, t.stamp); fired = true; continue }
        const occurrenceAt = new Date(t.nowMs).toISOString()
        const inserted = handle.jobs.insertOccurrence({
          id: `occ.${ids.newId().replace(/-/g, '').toLowerCase().slice(0, 32).padEnd(32, '0')}`,
          jobId: job.id, jobVersion: version.version, dueSlot: eventDueSlot(row.seq), timeZone: t.zone,
          dueAt: new Date(Date.parse(row.at)).toISOString(),
          // Its time to run counts from now (the event may have been read late), never from the event.
          expiresAt: new Date(t.nowMs + definition.missed.expiresAfterMinutes * 60_000).toISOString(),
          state: 'due', runId: null, outcomeCode: null, createdAt: occurrenceAt, updatedAt: occurrenceAt,
          eventSeq: row.seq, eventRecordId: row.recordId, eventVersion: row.version, eventDay: t.day,
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
      if (limited) toldLimited(handle, job, definition, t.day, told)
      return n
    })
  }

  return { scan, recheck }
}

export type JobEvents = ReturnType<typeof createJobEvents>
