/**
 * Scheduled jobs' occurrences (定期の仕事の回, B PR 3b, `.claude/rules/jobs.md` "The clock" / "The runner").
 * **No AI runs here** (owner decision D6): the clock only makes occurrences, the runner only does a
 * job's server operation (placement `e`: today a やること for the responsible person).
 *
 * - **The clock** (`makeOccurrences`, called by the server clock for every company before its slower
 *   work): for each approved job (placement `e`, and since B PR 5a-2 `a`, whose occurrences the responsible
 *   person's app claims; active or paused, never a draft or retired), the
 *   newest slot of the approved version's trigger at or before now (company time, `job-schedule.ts`) is
 *   written once (`INSERT OR IGNORE` on `UNIQUE (company, job, due_slot)`: a second clock run, a restart
 *   or a second server make nothing more). Slots before the version was approved are never made. Its
 *   state is decided once, when made: the job paused, the company's stop on or the approved version not
 *   accepted → `held` (never run, also not on resume); its time ran out (`expires_at`, the server was
 *   down) → `expired` with a notice; found late under `skip` → `skipped` (`MISSED`); else `due`. Only the
 *   newest slot is made (`latest_only`: missed ones in between are never made) and an older `due` one of
 *   the job becomes `skipped` (`SUPERSEDED`). A `due` one whose time ran out becomes `expired` (notice).
 *   It reads no content and calls nothing outside: fast.
 * - **The runner** (`createJobRunner`, started by the clock but never awaited by it, so a slow company's
 *   mail or calendar never holds an occurrence up): each `due` occurrence in one transaction — checks
 *   at run time (expired, the company's stop, the job paused, another version approved, not accepted,
 *   the responsible person still a member with the pinned version's rights — else the job is paused as
 *   in 3a and owners / admins are told —, absent that day (D5: no delegate) → skipped with a notice),
 *   then the run: an `ai_runs` row (`subject_kind: 'occurrence'`, device `server`, its events), the
 *   operation by its key (`ai_run_operations`), the やること (id from the occurrence: one by construction),
 *   the run closed `done` and the occurrence `done` with the run's id — all or nothing, so a crash
 *   leaves the occurrence `due` and nothing made, and a second runner finds it no longer `due`. A run
 *   of the server is opened and closed in that one transaction: no open occurrence run ever exists.
 * - **Notices** (`job_expired`, `job_skipped`, `job_failed`; recordless, key `<kind>:<job>:<occurrence>:<retries>:<code>`):
 *   to the responsible person and the job's creator while an owner / admin, written in the same
 *   transaction as the occurrence's change; their text is built when read (notifications.ts). No notice
 *   when it ran (D9).
 */
import { addBusinessDays } from '../../shared/core/business-days'
import {
  JOB_ACTOR, JOB_ON_TIME_MS, JOB_SERVER_STEP, isEventOccurrenceSlot, isRecordTrigger, isTimeTrigger, newOccurrenceId, occurrenceTaskId, storedJobDefinition,
  type JobDefinition, type JobDeliveryPlace, type JobOccurrenceState, type JobOutcomeCode,
} from '../../shared/core/jobs'
import { latestJobSlot } from '../../shared/core/job-schedule'
import type { NotificationKind } from '../../shared/types/notifications'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import type { AiRunRow } from '../ports/ai-runs'
import { hasFullAccess } from './access'
import type { JobService } from './jobs'
import { companyNow } from './notifications'
import type { ServiceCreateInput, ServiceRecordWriter } from './record-engine'
import { aiTurnState, createJobEvents, eventShown, type AiStepStates } from './job-events'
import { isSetWatchOccurrence, setWatchCondition, type MinutesReviewId } from './job-set-watch'
import { madeBefore } from './job-retry'

/** Per company and run: occurrences the runner takes at most. */
export const JOB_RUNNER_LIMIT = 50
/**
 * How many waiting occurrences of a company the clock looks at for expiry, and the runner reads to find the
 * server's own among the PC's (at most one `due` occurrence per job: an older one is superseded).
 */
const OPEN_SCAN_LIMIT = 10_000

export interface JobOccurrenceDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  timeZoneOf: (companyId: string) => string
  /** The company's own days off (task settings), for business-day triggers and dues. */
  holidaysOf: (companyId: string) => string[]
  roleOf: (companyId: string, userId: string) => string | null
  jobs: Pick<JobService, 'runnerRefusal' | 'pauseBySystem'>
  writer: Pick<ServiceRecordWriter, 'check' | 'create'>
  /** Tell these members their notices changed (push signal; never fails the change). */
  noticesChanged?: (companyId: string, userIds: string[]) => void
  log?: (message: string) => void
  /**
   * A deliverable place outside (jobs.md "A deliverable place outside"): the responsible person's chosen place is
   * usable now (a Drive folder pick within its 90 days), answered by its connector. Absent → never usable.
   */
  placeUsable?: (companyId: string, userId: string, place: JobDeliveryPlace) => boolean
  /** Event-triggered jobs (stage 4a): a business plugin step's states that run as 「AI の番」 (never an event's state, ⑧). */
  aiStepStates?: AiStepStates
  /** 4b-4 PR2, the set watch: the id of a meeting's 「議事録を確認する」 (absent → a set watch reads nothing). */
  minutesReviewId?: MinutesReviewId
}

/** Company time `YYYY-MM-DDTHH:MM` in `timeZone` → the UTC instant (ISO). Two passes settle a zone's offset. */
export function companyTimeToUtc(local: string, timeZone: string): string {
  const asUtc = Date.parse(`${local}:00Z`)
  let guess = asUtc
  for (let i = 0; i < 2; i++) {
    const seen = Date.parse(`${companyNow(guess, timeZone)}:00Z`)
    guess += asUtc - seen
  }
  return new Date(guess).toISOString()
}

class TaskNotCreated extends Error {
  constructor() { super('task not created'); this.name = 'TaskNotCreated' }
}

/** The stored definition, or null for a shape this build does not know (jobs.md "Shapes this build does not know"): never run. */
const definitionOf = (v: JobVersionRow): JobDefinition | null => storedJobDefinition(v)

/**
 * A PC run's hard deadline (B PR 5a): its first claim — the run's creation, which renewals and re-claims never
 * move — plus the approved grant's `limits.minutes`. After it no call, renew-extended or not, goes on.
 */
export function pcRunDeadlineMs(run: Pick<AiRunRow, 'createdAt'>, definition: JobDefinition): number {
  return Date.parse(run.createdAt) + definition.grant.limits.minutes * 60_000
}

/**
 * End a PC occurrence's run from outside its finish (in the caller's transaction): `waiting_person` with `code`
 * (an outside operation still in flight becomes unknown, as at a finish, and then `waiting_reconcile`), no
 * holder — its tokens are fenced at once, its renew and finish refused (`RUN_SUPERSEDED`). Its occurrence
 * is moved by the caller (held / needs_person), so a later 「もう一度」 of the run claims nothing.
 */
export function endPcRun(handle: CompanyData, runId: string | null, code: string, at: string): void {
  const run = runId ? handle.aiRuns.byId(runId) : null
  if (!run || (run.state !== 'running' && run.state !== 'open' && run.state !== 'retry_later')) return
  // As a finish does (ai-runs.ts `inFlightToUnknown`): an outside operation still in flight may have happened.
  for (const o of handle.aiRuns.operations(run.id)) if (o.state === 'in_progress') handle.aiRuns.updateOperation(run.id, o.key, ['in_progress'], { state: 'unknown' }, at)
  const unknown = handle.aiRuns.operations(run.id).some(o => o.state === 'unknown')
  // One whose outside result nobody knows waits for a person's reconciliation, as a finish would leave it.
  const ended: AiRunRow = unknown
    ? { ...run, state: 'waiting_reconcile', deviceId: null, claimExpiresAt: null, failureClass: 'unknown-result', failureCode: code, retryAt: null, updatedAt: at }
    : { ...run, state: 'waiting_person', deviceId: null, claimExpiresAt: null, failureClass: 'bad-input', failureCode: code, retryAt: null, updatedAt: at }
  if (handle.aiRuns.update(ended, { generation: run.generation, state: run.state })) {
    handle.aiRuns.appendEvent({ runId: run.id, event: 'finished', generation: run.generation, stateAfter: ended.state, code, at })
  }
}

/**
 * An event occurrence run by the responsible person's PC (schema 3, stage 4b-1, jobs.md "Event jobs on the PC"): an event
 * occurrence pinned to a PC procedure with the source-record check. Its conditions (C1–C9, owner memo 「段4b 設計メモ」 §5-2)
 * are checked at the list, the claim, every call, every renew, the finish and by the clock (`eventCondition`). Since 4b-4 PR2
 * also a set watch's occurrence (schema 5, `matched_record`: its record and meeting pinned — job-set-watch.ts), whose conditions
 * are the same machinery with the combination's own in place of C3–C9.
 */
export function isEventPcOccurrence(occ: Pick<JobOccurrenceRow, 'eventRecordId' | 'eventMeetingId'>, definition: JobDefinition | null): definition is JobDefinition {
  if (!occ.eventRecordId || definition === null || definition.placement !== 'a') return false
  return definition.check.kind === 'source_record' || isSetWatchOccurrence(occ, definition)
}

/** Where an event PC occurrence goes when a condition fails and its run made nothing outside (owner memo §4-4). */
function eventEndState(code: JobOutcomeCode): { to: JobOccurrenceState; notice: NotificationKind | null } {
  switch (code) {
    // C1: as a time occurrence — held, not told (a pause / the stop / another version / not accepted).
    case 'COMPANY_STOPPED': case 'JOB_PAUSED': case 'JOB_VERSION_CHANGED': case 'NOT_ACCEPTED': return { to: 'held', notice: null }
    // C4 / C9: no longer needed — nothing, not told (only the stopped chain is: D4).
    case 'EVENT_NOT_NEEDED': case 'EVENT_DONE_MARK': return { to: 'nothing', notice: null }
    // C7: records off — a person looks (told).
    case 'RECORDS_OFF': return { to: 'needs_person', notice: 'job_failed' }
    // D5: absent that day — skipped and told, as every occurrence.
    case 'OWNER_ABSENT': return { to: 'skipped', notice: 'job_skipped' }
    // C2 / C3 / C5 / C6 / C8: skipped, not told (4a's own rule) — and the job is never paused for it (⑥).
    default: return { to: 'skipped', notice: null }
  }
}

export function createJobOccurrences(deps: JobOccurrenceDeps) {
  const { companyData, transactions, clock, ids } = deps
  const log = deps.log ?? ((message: string) => console.log(message))
  // Event-triggered jobs (stage 4a, services/job-events.ts): the scan the clock runs, the checks before acting.
  const events = createJobEvents({ transactions, clock, ids, roleOf: deps.roleOf, timeZoneOf: deps.timeZoneOf, aiStepStates: deps.aiStepStates, minutesReviewId: deps.minutesReviewId, log })

  /** Write an occurrence notice for the responsible person and the job's creator (if owner / admin now), in the caller's transaction. */
  function notice(companyId: string, handle: CompanyData, kind: NotificationKind, occ: JobOccurrenceRow, job: JobRow | null, actingUserId: string | null, told: Set<string>) {
    const to = new Set<string>()
    if (actingUserId && deps.roleOf(companyId, actingUserId) !== null) to.add(actingUserId)
    if (job) { const role = deps.roleOf(companyId, job.createdBy); if (role !== null && hasFullAccess(role)) to.add(job.createdBy) }
    // An event occurrence (stage 4a, ⑥): only someone who reads its record now — never an owner / admin who does not.
    for (const userId of [...to]) {
      const role = deps.roleOf(companyId, userId)
      if (role === null || !eventShown(handle, { companyId, userId, role }, occ)) to.delete(userId)
    }
    if (to.size === 0) return
    const at = clock.now()
    // As written now (every caller moved it first, in this transaction): its press count and its reason.
    const now = handle.jobs.occurrence(occ.id) ?? occ
    handle.notifications.insert([...to].map(userId => ({
      id: ids.newId(), userId, kind, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      // Once per occurrence — and once more after each 「もう一度」 (B PR 5b: a second failure is told again); the reason
      // it was written with rides along, so a later press (which clears the occurrence's code) never rewords it. The
      // bell reads the job and the occurrence from the first two parts, an older build too.
      dedupeKey: `${kind}:${occ.jobId}:${occ.id}:${now.retries ?? 0}:${now.outcomeCode ?? ''}`, createdAt: at, readAt: null,
    })))
    for (const u of to) told.add(u)
  }

  function tell(companyId: string, told: Set<string>) {
    if (told.size === 0) return
    try { deps.noticesChanged?.(companyId, [...told]) } catch { /* the apps' own check catches up */ }
  }

  /**
   * Whether an event occurrence belongs to its job's watch **now** (stage 4b-0.5, watch generations): made for this very
   * watch (`watchGeneration`, pinned when made) and that watch still on its record. One of an earlier watch — the same
   * record watched again (「選び直す」), or one whose watch the startup migration could not prove — stops no chain when it
   * ends (and moves or clears nothing: `moveWatch` / `clearChainStop` take its generation).
   */
  const ownsWatch = (handle: CompanyData, occ: JobOccurrenceRow): boolean => {
    if (!occ.eventRecordId || occ.watchGeneration === null || occ.watchGeneration === undefined) return false
    const cursor = handle.jobs.eventCursor(occ.jobId)
    return cursor !== null && cursor.generation === occ.watchGeneration && cursor.watch === occ.eventRecordId
  }

  /** The approved version's responsible person accepted that version's consent. */
  const accepted = (job: JobRow, version: JobVersionRow) => job.acceptedConsent !== null && job.acceptedConsent === version.consentFingerprint
  /** The place the responsible person chose for the version's deliverables is theirs and usable now (job-runs.ts checks it again at the claim). */
  const placeUsable = (companyId: string, job: JobRow, definition: JobDefinition): boolean => {
    const wanted = definition.grant.deliverTo
    const chosen = job.acceptedPlace
    if (!wanted || !chosen || chosen.connector !== wanted.connector || chosen.kind !== wanted.kind) return false
    return deps.placeUsable?.(companyId, definition.actingUser, chosen) === true
  }

  /**
   * The newest slot of an approved job at or before now, as an occurrence row would hold it (state still to
   * decide), or null: no approved version, no slot, or a slot from before the version was approved. A PC job's
   * (placement `a`) is made the same way since B PR 5a-2: its responsible person's app claims it.
   */
  function latestSlotOf(companyId: string, handle: CompanyData, job: JobRow, nowMs: number) {
    if (job.approvedVersion === null || (job.state !== 'active' && job.state !== 'paused')) return null
    const version = handle.jobs.version(job.id, job.approvedVersion)
    if (!version || version.approvedAt === null) return null
    const definition = definitionOf(version)
    // A shape this build does not know (a newer build approved it, then the server was rolled back): no occurrence.
    if (definition === null || (definition.placement !== 'e' && definition.placement !== 'a')) return null
    // An event-triggered job has no slots: its occurrences come from the ledger (`events.scan`).
    if (!isTimeTrigger(definition.trigger)) return null
    const zone = deps.timeZoneOf(companyId)
    const slot = latestJobSlot(definition.trigger, companyNow(nowMs, zone), deps.holidaysOf(companyId))
    if (slot === null) return null
    const dueAt = companyTimeToUtc(slot, zone)
    const dueMs = Date.parse(dueAt)
    // Never a slot from before the version was approved.
    if (dueMs < Date.parse(version.approvedAt)) return null
    const expiresAt = new Date(dueMs + definition.missed.expiresAfterMinutes * 60_000).toISOString()
    return { version, definition, slot, zone, dueAt, dueMs, expiresAt }
  }

  const newRow = (job: JobRow, s: NonNullable<ReturnType<typeof latestSlotOf>>, state: JobOccurrenceState, code: JobOutcomeCode | null): JobOccurrenceRow => {
    const at = clock.now()
    return {
      id: newOccurrenceId(ids.newId().replace(/-/g, '').toLowerCase().slice(0, 32).padEnd(32, '0')),
      jobId: job.id, jobVersion: s.version.version, dueSlot: s.slot, timeZone: s.zone, dueAt: s.dueAt, expiresAt: s.expiresAt, state, runId: null, outcomeCode: code,
      createdAt: at, updatedAt: at,
    }
  }

  /**
   * The clock's part (fast, no content, nothing outside): make each approved job's newest slot once, and
   * expire `due` occurrences whose time ran out. The number of occurrences made or expired.
   */
  function makeOccurrences(companyId: string): number {
    const handle = companyData.forCompany(companyId)
    const nowMs = clock.nowMs()
    const told = new Set<string>()
    let changed = 0
    const stopped = handle.jobs.stopped()
    for (const job of handle.jobs.list()) {
      const latest = latestSlotOf(companyId, handle, job, nowMs)
      if (!latest) continue
      const { version, definition, slot, dueMs, expiresAt } = latest
      let state: JobOccurrenceState = 'due'
      let code: JobOutcomeCode | null = null
      if (job.state === 'paused') { state = 'held'; code = 'JOB_PAUSED' }
      else if (stopped) { state = 'held'; code = 'COMPANY_STOPPED' }
      else if (!accepted(job, version)) { state = 'held'; code = 'NOT_ACCEPTED' }
      else if (nowMs >= Date.parse(expiresAt)) { state = 'expired'; code = 'EXPIRED' }
      // Its deliverable place is no longer usable (a folder pick's 90 days are over): a person chooses it again
      // (decision for the owner: never renewed by itself). Told now, at the slot, instead of an occurrence nobody claims.
      else if (definition.grant.deliverTo && !placeUsable(companyId, job, definition)) { state = 'needs_person'; code = 'PLACE_NOT_USABLE' }
      else if (definition.missed.policy === 'skip' && nowMs >= dueMs + JOB_ON_TIME_MS) { state = 'skipped'; code = 'MISSED' }
      const row = newRow(job, latest, state, code)
      const at = row.createdAt
      transactions.run(() => {
        if (!handle.jobs.insertOccurrence(row)) return
        changed++
        if (state === 'expired') notice(companyId, handle, 'job_expired', row, job, version.actingUserId, told)
        // Told once while it stays so: not again for each slot after one that already said the place is not usable.
        const before = handle.jobs.occurrences(job.id, 2).find(o => o.id !== row.id)
        if (state === 'needs_person' && before?.outcomeCode !== 'PLACE_NOT_USABLE') notice(companyId, handle, 'job_failed', row, job, version.actingUserId, told)
        // latest_only: an older occurrence still waiting is not run any more.
        for (const older of handle.jobs.occurrences(job.id, 20)) {
          if (older.id !== row.id && older.state === 'due' && older.dueSlot < slot) handle.jobs.moveOccurrence(older.id, ['due'], 'skipped', { outcomeCode: 'SUPERSEDED' }, at)
        }
      })
    }
    // Event-triggered jobs (stage 4a): what happened since each one's cursor, bounded per tick.
    changed += events.scan(handle, stopped, told)
    // A chain stopped for days: its responsible person's stop notice comes back once (not counted: nothing is made).
    events.remindStoppedChains(handle, stopped, told)
    // A PC's run (B PR 5a), in this order:
    // - past its hard deadline (first claim + approved minutes; renewing never moves it) → the run ended,
    //   `needs_person` `TIME_LIMIT`, told — also while its app still holds and renews it;
    // - waiting for a person to reconcile an outside operation, and out of time (deadline or expiry) →
    //   `needs_person` `RESULT_UNKNOWN`, told; the run stays where it is for that person;
    // - stopped without finishing (the app closed, retried later, given back) and past its expiry → `expired`, told.
    // A run someone holds within its deadline finishes as it will — unless it is an event occurrence whose conditions failed
    // (stage 4b-1): ended now, whether or not its app renews.
    changed += endFailedEvents(companyId, handle, handle.jobs.runningOccurrences(OPEN_SCAN_LIMIT), told)
    for (const occ of handle.jobs.runningOccurrences(OPEN_SCAN_LIMIT)) {
      const run = occ.runId ? handle.aiRuns.byId(occ.runId) : null
      const version = handle.jobs.version(occ.jobId, occ.jobVersion)
      const pinned = version ? definitionOf(version) : null
      // A shape this build does not know never comes here (stage 4b-0.5: frozen, left out by the repository before the
      // limit — never expired, ended or told by this build); `pinned` null is a defence only.
      const overdue = run !== null && pinned !== null && nowMs >= pcRunDeadlineMs(run, pinned)
      const expired = nowMs >= Date.parse(occ.expiresAt)
      const job = handle.jobs.find(occ.jobId)
      const acting = version?.actingUserId ?? null
      if (run?.state === 'waiting_reconcile') {
        if (!overdue && !expired) continue
        transactions.run(() => {
          if (!handle.jobs.moveOccurrence(occ.id, ['running'], 'needs_person', { outcomeCode: 'RESULT_UNKNOWN' }, clock.now())) return
          changed++
          notice(companyId, handle, 'job_failed', occ, job, acting, told)
          // An event occurrence that ends without its やること stops its watch's chain (stage 4b-1).
          if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, 'RESULT_UNKNOWN', occ.eventRecordId, told)
        })
        continue
      }
      if (overdue) {
        transactions.run(() => {
          const at = clock.now()
          if (!handle.jobs.moveOccurrence(occ.id, ['running'], 'needs_person', { outcomeCode: 'TIME_LIMIT' }, at)) return
          endPcRun(handle, occ.runId, 'TIME_LIMIT', at)
          changed++
          notice(companyId, handle, 'job_failed', occ, job, acting, told)
          if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, 'TIME_LIMIT', occ.eventRecordId, told)
        })
        continue
      }
      if (!expired) continue
      const held = run !== null && run.state === 'running' && run.claimExpiresAt !== null && Date.parse(run.claimExpiresAt) > nowMs
      if (held) continue
      transactions.run(() => {
        const at = clock.now()
        if (!handle.jobs.moveOccurrence(occ.id, ['running'], 'expired', { outcomeCode: 'EXPIRED' }, at)) return
        endPcRun(handle, occ.runId, 'EXPIRED', at)
        changed++
        notice(companyId, handle, 'job_expired', occ, job, acting, told)
        if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, 'EXPIRED', occ.eventRecordId, told)
      })
    }
    // A waiting event occurrence of the PC whose conditions failed (stage 4b-1) ends now rather than at its expiry.
    changed += endFailedEvents(companyId, handle, handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT).filter(o => nowMs < Date.parse(o.expiresAt)), told)
    // A `due` occurrence whose time ran out (the runner, or a PC, could not take it): expired, and said so. Never a frozen
    // one (stage 4b-0.5: the repository does not answer it) — its own build decides when it comes back.
    for (const occ of handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT)) {
      if (nowMs < Date.parse(occ.expiresAt)) continue
      transactions.run(() => {
        if (!handle.jobs.moveOccurrence(occ.id, ['due'], 'expired', { outcomeCode: 'EXPIRED' }, clock.now())) return
        changed++
        const job = handle.jobs.find(occ.jobId)
        notice(companyId, handle, 'job_expired', occ, job, handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
        if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, 'EXPIRED', occ.eventRecordId, told)
      })
    }
    tell(companyId, told)
    return changed
  }

  /** The company day an occurrence is for: its slot's, or (an event's) the day its event happened, in company time. */
  const dayOf = (occ: JobOccurrenceRow): string =>
    occ.eventSeq !== null && occ.eventSeq !== undefined ? companyNow(Date.parse(occ.dueAt), occ.timeZone).slice(0, 10) : occ.dueSlot.slice(0, 10)

  /** The やること an occurrence makes (owner-only for the responsible person: the job's words reach nobody else). */
  function taskInput(companyId: string, occ: JobOccurrenceRow, definition: JobDefinition, runId: string): ServiceCreateInput | null {
    if (definition.run.kind !== 'operation') return null
    const day = dayOf(occ)
    const due = definition.run.dueBusinessDays === null ? null : definition.run.dueBusinessDays === 0 ? day : addBusinessDays(day, definition.run.dueBusinessDays, deps.holidaysOf(companyId))
    return {
      type: 'task', id: occurrenceTaskId(occ.id), title: definition.run.title, personalOwner: definition.actingUser,
      fields: { assignee: definition.actingUser, ...(due ? { due } : {}) },
      actor: { ...JOB_ACTOR, runId },
      note: '定期の仕事から作りました',
      // D9: no notice of its own — the やること in 「あなたの番」 is the notice.
      quiet: true,
    }
  }

  /**
   * Run one `due` occurrence (placement `e`) exactly once. The state it ended in, or null when it was
   * not `due` (another runner took it, or it is not the server's).
   */
  function runOccurrence(companyId: string, occurrenceId: string): JobOccurrenceState | null {
    const handle = companyData.forCompany(companyId)
    const told = new Set<string>()
    let outcome: JobOccurrenceState | null
    try {
      outcome = transactions.run((): JobOccurrenceState | null => {
        const occ = handle.jobs.occurrence(occurrenceId)
        if (!occ || occ.state !== 'due') return null
        const at = clock.now()
        const end = (to: JobOccurrenceState, code: JobOutcomeCode, kind: NotificationKind | null, job: JobRow | null, acting: string | null): JobOccurrenceState | null => {
          if (!handle.jobs.moveOccurrence(occ.id, ['due'], to, { outcomeCode: code }, at)) return null
          if (kind) notice(companyId, handle, kind, occ, job, acting, told)
          // An event occurrence that did not make its やること stops its job's chain (owner decision ①).
          if (occ.eventRecordId && job && ownsWatch(handle, occ)) events.chainStopped(handle, job.id, code, occ.eventRecordId, told)
          return to
        }
        const job = handle.jobs.find(occ.jobId)
        const version = handle.jobs.version(occ.jobId, occ.jobVersion)
        const acting = version?.actingUserId ?? null
        if (clock.nowMs() >= Date.parse(occ.expiresAt)) return end('expired', 'EXPIRED', 'job_expired', job, acting)
        if (!job || !version) return end('held', 'JOB_VERSION_CHANGED', null, job, acting)
        const definition = definitionOf(version)
        // Not run, not changed: a shape this build does not know is left as it is (its own build runs it).
        if (definition === null || definition.placement !== 'e' || definition.run.kind !== 'operation') return null
        // Stopped after it was made: held, nothing made (D8; a pause holds it too, also on resume).
        if (handle.jobs.stopped()) return end('held', 'COMPANY_STOPPED', null, job, acting)
        if (job.state !== 'active') return end('held', 'JOB_PAUSED', null, job, acting)
        // Another version approved since it was made: not run as pinned (acceptance was checked when it was made,
        // and only an approval of another version can change what the responsible person accepted).
        if (job.approvedVersion !== occ.jobVersion) return end('held', 'JOB_VERSION_CHANGED', null, job, acting)
        // The responsible person's rights now, with the pinned version (like approval): else the job pauses (3a's notice).
        const refusal = deps.jobs.runnerRefusal(companyId, version)
        // An event occurrence (its `ev:` slot; one with no record, never written by 4a, is skipped by the recheck).
        const event = isEventOccurrenceSlot(occ.dueSlot)
        // An event occurrence (⑥): only it is skipped — the job is not paused for what one record's occurrence found.
        if (refusal && event) return end('skipped', refusal, null, job, acting)
        if (refusal) {
          // The occurrence first (its own code), then the pause (which holds the job's other due ones).
          const held = end('held', refusal, null, job, acting)
          deps.jobs.pauseBySystem(companyId, job.id, refusal)
          return held
        }
        // An event occurrence, right before it acts (⑤ ⑥ ⑧): its record, its assignee, the AI's turn — skipped, not told.
        if (event) {
          const why = events.recheck(handle, occ, definition)
          if (why) return end('skipped', why, null, job, acting)
        }
        // Absent that day (D5): nobody runs it for them.
        const day = dayOf(occ)
        if (handle.tasks.absencesFrom(day).some(a => a.userId === definition.actingUser && a.from <= day && day <= a.until)) {
          return end('skipped', 'OWNER_ABSENT', 'job_skipped', job, acting)
        }
        const runId = ids.newId()
        const input = taskInput(companyId, occ, definition, runId) as ServiceCreateInput
        const refused = deps.writer.check(companyId, input)
        if (refused) return end('needs_person', refused.reason === 'records-off' ? 'RECORDS_OFF' : 'TASK_NOT_CREATED', 'job_failed', job, acting)
        // The run: opened and closed here, with its events and the operation by its key.
        const runs = handle.aiRuns
        const run = {
          id: runId, subject: { kind: 'occurrence' as const, id: occ.id }, step: JOB_SERVER_STEP, userId: definition.actingUser, state: 'running' as const,
          generation: 1, deviceId: 'server', conversationId: null, claimExpiresAt: null, failureClass: null, failureCode: null, retryAt: null, attempts: 0,
          pluginVersion: null, stepsVersion: null, procedure: null, createdAt: at, updatedAt: at, closedAt: null,
        }
        runs.insert(run)
        runs.appendEvent({ runId, event: 'claimed', generation: 1, stateAfter: 'running', code: null, at })
        const key = 'create_task'
        runs.insertOperation({
          runId, key, fingerprint: `${job.id}:${version.version}:${version.fingerprint}`, kind: 'record-create', state: 'in_progress', generation: 1,
          refKind: null, refId: null, status: null, reconciledBy: null, createdAt: at, updatedAt: at,
        })
        const made = deps.writer.create(companyId, input)
        // Rolled back whole: no run, no key, no やること; the occurrence is then marked below.
        if (!made.ok) throw new TaskNotCreated()
        runs.updateOperation(runId, key, ['in_progress'], { state: 'done', refKind: 'record', refId: made.record.id }, at)
        // An event job that follows what it made (stage 4a): this やること is the record it watches next — set here, by the
        // server, in the same transaction (a duplicate, a tag or an edit of anything never moves it). Either way a chain
        // that had stopped on this record goes on (it ran after 「もう一度」).
        if (event && occ.eventRecordId) {
          // Only its own watch (stage 4b-0.5: the generation it was made for; an earlier watch's occurrence moves nothing).
          if (isRecordTrigger(definition.trigger) && definition.trigger.followMadeTask) handle.jobs.moveWatch(job.id, occ.eventRecordId, made.record.id, at, occ.watchGeneration ?? null)
          else handle.jobs.clearChainStop(job.id, occ.eventRecordId, occ.watchGeneration ?? null)
        }
        if (!runs.update({ ...run, state: 'done', updatedAt: at, closedAt: at }, { generation: 1, state: 'running' })) throw new Error('run changed')
        runs.appendEvent({ runId, event: 'finished', generation: 1, stateAfter: 'done', code: 'DONE', at })
        if (!handle.jobs.moveOccurrence(occ.id, ['due'], 'done', { runId, outcomeCode: null }, at)) throw new Error('occurrence changed')
        return 'done'
      })
    } catch (error) {
      if (!(error instanceof TaskNotCreated)) {
        // Left `due`: the next run tries again until it expires (then it is told). No content in the log.
        log(`[job-runner] company ${companyId} occurrence failed: ${error instanceof Error ? error.name : 'unknown error'}`)
        return null
      }
      outcome = transactions.run(() => {
        const occ = handle.jobs.occurrence(occurrenceId)
        if (!occ || !handle.jobs.moveOccurrence(occ.id, ['due'], 'needs_person', { outcomeCode: 'TASK_NOT_CREATED' }, clock.now())) return null
        notice(companyId, handle, 'job_failed', occ, handle.jobs.find(occ.jobId), handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
        // Its やること was not made: the chain stops there too (owner decision ①; Codex review of #700).
        if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, 'TASK_NOT_CREATED', occ.eventRecordId, told)
        return 'needs_person' as const
      })
    }
    tell(companyId, told)
    return outcome
  }

  /**
   * A pause or the company's stop begins (in the caller's transaction, jobs.md "Held"): every occurrence of
   * the job (null: of every job of the company) still `due` is `held` — it never runs, also not after resuming.
   * One a PC is running (B PR 5a) is `held` too and its run ended (`endPcRun`): its token, renew and finish are
   * refused from now on, and resuming or lifting the stop brings neither back. A waiting event occurrence (stage 4a) is
   * held like any other and its chain stops (owner decision ①). Every one, without a limit (stage 4b-0.5), and a frozen
   * one (a later build's shape) too — held, its run ended, nothing told (`holdFrozen`).
   */
  function holdDue(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void {
    const handle = companyData.forCompany(companyId)
    const at = clock.now()
    // Event-triggered jobs (stage 4a, ③): what happens from now until it ends never runs (a gap from this delivery number).
    handle.jobs.openEventGap(jobId, ids.newId(), at)
    const told = new Set<string>()
    // Every one, not the first `OPEN_SCAN_LIMIT` (stage 4b-0.5): batch after batch of the job's own (SQL keeps to the job),
    // until none is left waiting — a moved one leaves `due`, so the next batch is the rest.
    for (let batch = handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT, jobId); batch.length > 0; batch = handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT, jobId)) {
      let moved = 0
      for (const occ of batch) {
        if (!handle.jobs.moveOccurrence(occ.id, ['due'], 'held', { outcomeCode: code }, at)) continue
        moved++
        // A held event occurrence never runs: its chain stops (owner decision ①).
        if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, code, occ.eventRecordId, told)
      }
      if (moved === 0) break
    }
    // Any event occurrence still waiting is held too (stage 4-0.1's write; kept as a net).
    handle.jobs.holdEventOccurrences(jobId, code, at)
    for (let batch = handle.jobs.runningOccurrences(OPEN_SCAN_LIMIT, jobId); batch.length > 0; batch = handle.jobs.runningOccurrences(OPEN_SCAN_LIMIT, jobId)) {
      let moved = 0
      for (const occ of batch) {
        if (!handle.jobs.moveOccurrence(occ.id, ['running'], 'held', { outcomeCode: code }, at)) continue
        moved++
        endPcRun(handle, occ.runId, code, at)
        // A running event occurrence (the PC's, stage 4b-1) held: its chain stops as a waiting one's does.
        if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, code, occ.eventRecordId, told)
      }
      if (moved === 0) break
    }
    // Frozen ones (stage 4b-0.5: a later build's shape) are held as well, all of them, and their runs ended — nothing else:
    // no notice, no chain stopped (a later build reads them again, as held).
    for (const runId of handle.jobs.holdFrozen(jobId, code, at)) endPcRun(handle, runId, code, at)
    tell(companyId, told)
  }

  /**
   * A pause or the company's stop ends (in the caller's transaction): the newest slot that passed while it
   * lasted — not made yet because no clock ran in between — is written `held`, so the clock never makes
   * it `due` afterwards (「再開しても動かさない」). For the job (null: every job of the company).
   */
  function holdPassedSlot(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void {
    const handle = companyData.forCompany(companyId)
    const nowMs = clock.nowMs()
    // The gap it opened ends here: events after now run again, those before it never (③). None open: the pause or the
    // stop was made by a build before 4a (a rollback, deployment.md) — nothing from before now runs (Codex review of #700).
    if (handle.jobs.closeEventGaps(jobId, clock.now()) === 0) {
      const told = new Set<string>()
      events.dropUntilNow(handle, jobId, 'PAUSED_EVENT', told)
      tell(companyId, told)
    }
    for (const job of jobId === null ? handle.jobs.list() : [handle.jobs.find(jobId)].filter((j): j is JobRow => j !== null)) {
      const latest = latestSlotOf(companyId, handle, job, nowMs)
      if (latest) handle.jobs.insertOccurrence(newRow(job, latest, 'held', code))
    }
  }

  /**
   * The company's `due` occurrences the server runs itself (placement `e`), oldest first, at most `limit`: a PC
   * job's (`a`, claimed by its responsible person's app) never takes a place in the runner's batch.
   */
  function serverDue(companyId: string, limit: number): JobOccurrenceRow[] {
    const handle = companyData.forCompany(companyId)
    const placement = new Map<string, string | null>()
    const placementOf = (o: JobOccurrenceRow) => {
      const key = `${o.jobId}\n${o.jobVersion}`
      if (!placement.has(key)) {
        const v = handle.jobs.version(o.jobId, o.jobVersion)
        placement.set(key, v ? definitionOf(v)?.placement ?? 'unknown' : null)
      }
      return placement.get(key)
    }
    // A version gone (never: versions are append-only) is left to runOccurrence, which holds it. A shape this build
    // does not know never takes a place in the batch: the repository leaves it out before the limit (stage 4b-0.5,
    // frozen); the `unknown` filter here is a defence only.
    return handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT).filter(o => placementOf(o) !== 'a' && placementOf(o) !== 'unknown').slice(0, limit)
  }

  /**
   * An occurrence notice (`job_expired` / `job_skipped` / `job_failed`) to its responsible person and the job's
   * creator while an owner / admin, in the caller's transaction (B PR 5a: the PC's run). The members told, for
   * the push afterwards (`tell`).
   */
  function writeNotice(companyId: string, kind: NotificationKind, occ: JobOccurrenceRow): string[] {
    const handle = companyData.forCompany(companyId)
    const told = new Set<string>()
    notice(companyId, handle, kind, occ, handle.jobs.find(occ.jobId), handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
    return [...told]
  }

  /** The responsible person as a member now, or null (left the company). */
  const memberOf = (companyId: string, userId: string) => {
    const role = deps.roleOf(companyId, userId)
    return role === null ? null : { companyId, userId, role }
  }

  /**
   * Why an event occurrence run by the PC must not run (go on running) now, or null — its conditions (owner memo
   * 「段4b 設計メモ」 §5-2), in this order: C1 the job runs as pinned (the company's stop, a pause, another version, the
   * consent accepted); C7 records on; C2 the responsible person a member with the pinned version's rights (an event job is
   * never paused for it, ⑥: the occurrence alone ends); C3 its record theirs to read now; C8 still the watch it was made
   * for (its generation); C4 the record still in the trigger's state; C5 its assignee them; C6 that state not 「AI の番」
   * now (a business plugin installed since); C9 no done mark (`file_linked`: a file linked from the record). `absentToo`:
   * also D5 (absent on the event's day) — asked before a run starts, not while it runs. Reads only.
   */
  function eventCondition(handle: CompanyData, occ: JobOccurrenceRow, absentToo: boolean): JobOutcomeCode | null {
    const job = handle.jobs.find(occ.jobId)
    const version = job ? handle.jobs.version(occ.jobId, occ.jobVersion) : null
    const definition = version ? definitionOf(version) : null
    const setWatch = isSetWatchOccurrence(occ, definition)
    if (!job || !version || !isEventPcOccurrence(occ, definition) || (!setWatch && !isRecordTrigger(definition.trigger))) return 'JOB_VERSION_CHANGED'
    if (handle.jobs.stopped()) return 'COMPANY_STOPPED'
    if (job.state !== 'active') return 'JOB_PAUSED'
    if (job.approvedVersion !== occ.jobVersion) return 'JOB_VERSION_CHANGED'
    if (!accepted(job, version)) return 'NOT_ACCEPTED'
    if (!handle.records.settings().enabled) return 'RECORDS_OFF'
    const refusal = deps.jobs.runnerRefusal(handle.companyId, version)
    if (refusal) return refusal
    const responsible = memberOf(handle.companyId, definition.actingUser)
    // A set watch's occurrence (4b-4 PR2): its combination still opened, the record and its pinned meeting still the responsible
    // person's (read, one of the meeting's people), the meeting still the record's, the record still done and theirs — in place of
    // C3–C9 (it watches no one record, so no watch generation or done mark applies).
    if (setWatch) {
      const why = setWatchCondition(handle, definition, responsible, occ)
      if (why) return why
      if (absentToo) {
        const day = dayOf(occ)
        if (handle.tasks.absencesFrom(day).some(a => a.userId === definition.actingUser && a.from <= day && day <= a.until)) return 'OWNER_ABSENT'
      }
      return null
    }
    if (!isRecordTrigger(definition.trigger)) return 'JOB_VERSION_CHANGED'
    const recordId = occ.eventRecordId as string
    if (!responsible || !eventShown(handle, responsible, occ)) return 'EVENT_RECORD_GONE'
    if (!ownsWatch(handle, occ)) return 'EVENT_NOT_WATCHED'
    const state = handle.records.states([recordId])[0]
    let fields: Record<string, unknown> = {}
    try { fields = state ? JSON.parse(state.fields) as Record<string, unknown> : {} } catch { fields = {} }
    if (!state || state.state !== definition.trigger.to) return 'EVENT_NOT_NEEDED'
    if (fields.assignee !== definition.actingUser) return 'EVENT_NOT_ASSIGNEE'
    if (aiTurnState(handle, deps.aiStepStates, definition.trigger.type, state.state)) return 'EVENT_AI_TURN'
    if (definition.check.kind === 'source_record' && definition.check.doneMark === 'file_linked'
      && handle.records.linksFrom([recordId]).some(l => l.targetPath !== null)) return 'EVENT_DONE_MARK'
    if (absentToo) {
      const day = dayOf(occ)
      if (handle.tasks.absencesFrom(day).some(a => a.userId === definition.actingUser && a.from <= day && day <= a.until)) return 'OWNER_ABSENT'
    }
    return null
  }

  /**
   * End an event occurrence run by the PC because `code` failed (in the caller's transaction): its run ended first
   * (`endPcRun`: its tokens fenced at once, an operation in flight made unknown), then the occurrence (owner memo §4-4) —
   * with an outside result nobody knows, `needs_person` `RESULT_UNKNOWN` (its run waits for reconciliation); with
   * something made outside that is known (this run's or an earlier one's), `needs_person` `MADE_THEN_STOPPED`; else as the
   * condition says (`eventEndState`). Told as that says; the watch's chain stops (only this watch's, D7's recipients).
   * C1 holds whatever was made (as a pause does; a held one is reconciled on the occurrence). The members told.
   */
  function endEventIn(handle: CompanyData, occ: JobOccurrenceRow, code: JobOutcomeCode, told: Set<string>): boolean {
    const at = clock.now()
    const from: JobOccurrenceState[] = ['due', 'running']
    if (!from.includes(occ.state)) return false
    if (occ.state === 'running') endPcRun(handle, occ.runId, code, at)
    const plain = eventEndState(code)
    let to = plain.to
    let outcome = code
    let kind = plain.notice
    if (to !== 'held') {
      const unknown = occ.runId !== null && handle.aiRuns.operations(occ.runId).some(o => o.state === 'unknown' || o.state === 'in_progress')
      if (unknown) { to = 'needs_person'; outcome = 'RESULT_UNKNOWN'; kind = 'job_failed' }
      else if (madeBefore(handle, occ.id).length > 0) { to = 'needs_person'; outcome = 'MADE_THEN_STOPPED'; kind = 'job_failed' }
    }
    if (!handle.jobs.moveOccurrence(occ.id, from, to, { outcomeCode: outcome }, at)) return false
    const job = handle.jobs.find(occ.jobId)
    if (kind) notice(handle.companyId, handle, kind, occ, job, handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
    if (occ.eventRecordId && ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, code, occ.eventRecordId, told)
    return true
  }

  /** `endEventIn` in its own transaction, the members told after it. */
  function endEvent(companyId: string, occurrenceId: string, code: JobOutcomeCode): void {
    const handle = companyData.forCompany(companyId)
    const told = new Set<string>()
    transactions.run(() => {
      const occ = handle.jobs.occurrence(occurrenceId)
      if (occ) endEventIn(handle, occ, code, told)
    })
    tell(companyId, told)
  }

  /**
   * An event occurrence of its watch ended (in the caller's transaction, stage 4b-1): `made` — its やること, which the watch
   * follows (`followMadeTask`) or which lets a stopped chain go on, as the server's runner does; null — it ended without
   * one (`nothing`, a person needed, the deadline), so the chain stops for `code`. Only its own watch (its generation).
   * The members told.
   */
  function eventEnded(companyId: string, occ: JobOccurrenceRow, made: string | null, code: string): string[] {
    const handle = companyData.forCompany(companyId)
    const told = new Set<string>()
    // A set watch's occurrence (4b-4 PR2) watches no one record: its end moves, stops or clears no watch.
    if (!occ.eventRecordId || occ.eventMeetingId) return []
    if (made === null) {
      if (ownsWatch(handle, occ)) events.chainStopped(handle, occ.jobId, code, occ.eventRecordId, told)
      return [...told]
    }
    const version = handle.jobs.version(occ.jobId, occ.jobVersion)
    const definition = version ? definitionOf(version) : null
    if (definition && isRecordTrigger(definition.trigger) && definition.trigger.followMadeTask) handle.jobs.moveWatch(occ.jobId, occ.eventRecordId, made, clock.now(), occ.watchGeneration ?? null)
    else handle.jobs.clearChainStop(occ.jobId, occ.eventRecordId, occ.watchGeneration ?? null)
    return []
  }

  /** The clock's look at the event occurrences the PC runs (stage 4b-1): one whose condition failed is ended now, so a run nobody renews stops too. */
  function endFailedEvents(companyId: string, handle: CompanyData, occs: JobOccurrenceRow[], told: Set<string>): number {
    let ended = 0
    for (const occ of occs) {
      if (!occ.eventRecordId) continue
      const version = handle.jobs.version(occ.jobId, occ.jobVersion)
      if (!isEventPcOccurrence(occ, version ? definitionOf(version) : null)) continue
      const code = eventCondition(handle, occ, occ.state === 'due')
      if (!code) continue
      transactions.run(() => {
        const now = handle.jobs.occurrence(occ.id)
        if (now && endEventIn(handle, now, code, told)) ended++
      })
    }
    return ended
  }

  return {
    makeOccurrences,
    runOccurrence,
    eventCondition,
    endEvent,
    eventEnded,
    holdDue,
    holdPassedSlot,
    writeNotice,
    /** Tell these members their notices changed (after the transaction that wrote them). */
    tell: (companyId: string, userIds: string[]) => tell(companyId, new Set(userIds)),
    /** The runner's part for one company: its `due` server occurrences, oldest first, at most `limit`. The number that ran (`done`). */
    runDue(companyId: string, limit = JOB_RUNNER_LIMIT): number {
      let ran = 0
      for (const occ of serverDue(companyId, limit)) if (runOccurrence(companyId, occ.id) === 'done') ran++
      return ran
    },
    /** The ids of the company's `due` server occurrences, oldest first, at most `limit` (the runner's batch). */
    dueIds(companyId: string, limit = JOB_RUNNER_LIMIT): string[] {
      return serverDue(companyId, limit).map(o => o.id)
    },
  }
}

export type JobOccurrences = ReturnType<typeof createJobOccurrences>

export interface JobRunnerDeps {
  companyIds: () => string[]
  occurrences: Pick<JobOccurrences, 'dueIds' | 'runOccurrence'>
  /** Let the event loop serve requests between occurrences and companies. */
  yieldNow: () => Promise<void>
  log?: (message: string) => void
}

/**
 * The (e) runner: every company's `due` occurrences, one company at a time with a yield between, one
 * company's failure logged and the others run. Never overlaps itself (a second call while running does
 * nothing). Started by the server clock without being awaited.
 */
export function createJobRunner(deps: JobRunnerDeps) {
  const log = deps.log ?? ((message: string) => console.log(message))
  let running: Promise<number> | null = null
  async function pass(): Promise<number> {
    let ran = 0
    for (const companyId of deps.companyIds()) {
      try {
        // One occurrence at a time, a yield after each: a batch never holds the event loop.
        for (const id of deps.occurrences.dueIds(companyId)) {
          if (deps.occurrences.runOccurrence(companyId, id) === 'done') ran++
          await deps.yieldNow()
        }
      } catch (error) {
        log(`[job-runner] company ${companyId} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      }
      await deps.yieldNow()
    }
    if (ran > 0) log(`[job-runner] ran ${ran}`)
    return ran
  }
  return {
    /** One pass; while one is going, the same pass is returned (nothing starts twice). */
    runOnce(): Promise<number> {
      if (running) return running
      running = pass().finally(() => { running = null })
      return running
    },
  }
}

export type JobRunner = ReturnType<typeof createJobRunner>
