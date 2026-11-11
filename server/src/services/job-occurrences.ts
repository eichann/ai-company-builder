/**
 * Scheduled jobs' occurrences (定期の仕事の回, B PR 3b, `.claude/rules/jobs.md` "The clock" / "The runner").
 * **No AI runs here** (owner decision D6): the clock only makes occurrences, the runner only does a
 * job's server operation (placement `e`: today a やること for the responsible person).
 *
 * - **The clock** (`makeOccurrences`, called by the server clock for every company before its slower
 *   work): for each approved job of placement `e` (active or paused, never a draft or retired), the
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
 * - **Notices** (`job_expired`, `job_skipped`, `job_failed`; recordless, key `<kind>:<job>:<occurrence>`):
 *   to the responsible person and the job's creator while an owner / admin, written in the same
 *   transaction as the occurrence's change; their text is built when read (notifications.ts). No notice
 *   when it ran (D9).
 */
import { addBusinessDays } from '../../shared/core/business-days'
import {
  JOB_ACTOR, JOB_ON_TIME_MS, JOB_SERVER_STEP, newOccurrenceId, occurrenceTaskId,
  type JobDefinition, type JobOccurrenceState, type JobOutcomeCode,
} from '../../shared/core/jobs'
import { latestJobSlot } from '../../shared/core/job-schedule'
import type { NotificationKind } from '../../shared/types/notifications'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyData, CompanyDataSource } from '../ports/company-data'
import type { JobOccurrenceRow, JobRow, JobVersionRow } from '../ports/jobs'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess } from './access'
import type { JobService } from './jobs'
import { companyNow } from './notifications'
import type { ServiceCreateInput, ServiceRecordWriter } from './record-engine'

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

const definitionOf = (v: JobVersionRow): JobDefinition => JSON.parse(v.definition) as JobDefinition

export function createJobOccurrences(deps: JobOccurrenceDeps) {
  const { companyData, transactions, clock, ids } = deps
  const log = deps.log ?? ((message: string) => console.log(message))

  /** Write an occurrence notice for the responsible person and the job's creator (if owner / admin now), in the caller's transaction. */
  function notice(companyId: string, handle: CompanyData, kind: NotificationKind, occ: JobOccurrenceRow, job: JobRow | null, actingUserId: string | null, told: Set<string>) {
    const to = new Set<string>()
    if (actingUserId && deps.roleOf(companyId, actingUserId) !== null) to.add(actingUserId)
    if (job) { const role = deps.roleOf(companyId, job.createdBy); if (role !== null && hasFullAccess(role)) to.add(job.createdBy) }
    if (to.size === 0) return
    const at = clock.now()
    handle.notifications.insert([...to].map(userId => ({
      id: ids.newId(), userId, kind, recordId: '', recordVersion: 0, action: '', actorId: null, actorKind: null,
      dedupeKey: `${kind}:${occ.jobId}:${occ.id}`, createdAt: at, readAt: null,
    })))
    for (const u of to) told.add(u)
  }

  function tell(companyId: string, told: Set<string>) {
    if (told.size === 0) return
    try { deps.noticesChanged?.(companyId, [...told]) } catch { /* the apps' own check catches up */ }
  }

  /** The approved version's responsible person accepted that version's consent. */
  const accepted = (job: JobRow, version: JobVersionRow) => job.acceptedConsent !== null && job.acceptedConsent === version.consentFingerprint

  /**
   * The newest slot of an approved placement-`e` job at or before now, as an occurrence row would hold it
   * (state still to decide), or null: no approved version, a PC job (claimed by its responsible person's app,
   * PR 5a-2: none made until then), no slot, or a slot from before the version was approved.
   */
  function latestSlotOf(companyId: string, handle: CompanyData, job: JobRow, nowMs: number) {
    if (job.approvedVersion === null || (job.state !== 'active' && job.state !== 'paused')) return null
    const version = handle.jobs.version(job.id, job.approvedVersion)
    if (!version || version.approvedAt === null) return null
    const definition = definitionOf(version)
    if (definition.placement !== 'e') return null
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
      else if (definition.missed.policy === 'skip' && nowMs >= dueMs + JOB_ON_TIME_MS) { state = 'skipped'; code = 'MISSED' }
      const row = newRow(job, latest, state, code)
      const at = row.createdAt
      transactions.run(() => {
        if (!handle.jobs.insertOccurrence(row)) return
        changed++
        if (state === 'expired') notice(companyId, handle, 'job_expired', row, job, version.actingUserId, told)
        // latest_only: an older occurrence still waiting is not run any more.
        for (const older of handle.jobs.occurrences(job.id, 20)) {
          if (older.id !== row.id && older.state === 'due' && older.dueSlot < slot) handle.jobs.moveOccurrence(older.id, ['due'], 'skipped', { outcomeCode: 'SUPERSEDED' }, at)
        }
      })
    }
    // A PC's run that stopped without finishing (the app closed, retried later, given back) and whose time ran
    // out: expired, and said so (B PR 5a). A run someone holds now finishes as it will; one with an outside
    // result nobody knows waits for a person's reconciliation (the run's own place) and stays as it is.
    for (const occ of handle.jobs.runningOccurrences(OPEN_SCAN_LIMIT)) {
      if (nowMs < Date.parse(occ.expiresAt)) continue
      const run = occ.runId ? handle.aiRuns.byId(occ.runId) : null
      const held = run !== null && run.state === 'running' && run.claimExpiresAt !== null && Date.parse(run.claimExpiresAt) > nowMs
      if (held || run?.state === 'waiting_reconcile') continue
      transactions.run(() => {
        if (!handle.jobs.moveOccurrence(occ.id, ['running'], 'expired', { outcomeCode: 'EXPIRED' }, clock.now())) return
        changed++
        notice(companyId, handle, 'job_expired', occ, handle.jobs.find(occ.jobId), handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
      })
    }
    // A `due` occurrence whose time ran out (the runner, or a PC, could not take it): expired, and said so.
    for (const occ of handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT)) {
      if (nowMs < Date.parse(occ.expiresAt)) continue
      transactions.run(() => {
        if (!handle.jobs.moveOccurrence(occ.id, ['due'], 'expired', { outcomeCode: 'EXPIRED' }, clock.now())) return
        changed++
        const job = handle.jobs.find(occ.jobId)
        notice(companyId, handle, 'job_expired', occ, job, handle.jobs.version(occ.jobId, occ.jobVersion)?.actingUserId ?? null, told)
      })
    }
    tell(companyId, told)
    return changed
  }

  /** The やること an occurrence makes (owner-only for the responsible person: the job's words reach nobody else). */
  function taskInput(companyId: string, occ: JobOccurrenceRow, definition: JobDefinition, runId: string): ServiceCreateInput | null {
    if (definition.run.kind !== 'operation') return null
    const day = occ.dueSlot.slice(0, 10)
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
          return to
        }
        const job = handle.jobs.find(occ.jobId)
        const version = handle.jobs.version(occ.jobId, occ.jobVersion)
        const acting = version?.actingUserId ?? null
        if (clock.nowMs() >= Date.parse(occ.expiresAt)) return end('expired', 'EXPIRED', 'job_expired', job, acting)
        if (!job || !version) return end('held', 'JOB_VERSION_CHANGED', null, job, acting)
        const definition = definitionOf(version)
        if (definition.placement !== 'e' || definition.run.kind !== 'operation') return null
        // Stopped after it was made: held, nothing made (D8; a pause holds it too, also on resume).
        if (handle.jobs.stopped()) return end('held', 'COMPANY_STOPPED', null, job, acting)
        if (job.state !== 'active') return end('held', 'JOB_PAUSED', null, job, acting)
        // Another version approved since it was made: not run as pinned (acceptance was checked when it was made,
        // and only an approval of another version can change what the responsible person accepted).
        if (job.approvedVersion !== occ.jobVersion) return end('held', 'JOB_VERSION_CHANGED', null, job, acting)
        // The responsible person's rights now, with the pinned version (like approval): else the job pauses (3a's notice).
        const refusal = deps.jobs.runnerRefusal(companyId, version)
        if (refusal) {
          // The occurrence first (its own code), then the pause (which holds the job's other due ones).
          const held = end('held', refusal, null, job, acting)
          deps.jobs.pauseBySystem(companyId, job.id, refusal)
          return held
        }
        // Absent that day (D5): nobody runs it for them.
        const day = occ.dueSlot.slice(0, 10)
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
        return 'needs_person' as const
      })
    }
    tell(companyId, told)
    return outcome
  }

  /**
   * A pause or the company's stop begins (in the caller's transaction, jobs.md "Held"): every occurrence of
   * the job (null: of every job of the company) still `due` is `held` — it never runs, also not after resuming.
   */
  function holdDue(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void {
    const handle = companyData.forCompany(companyId)
    const at = clock.now()
    for (const occ of handle.jobs.dueOccurrences(10_000)) {
      if (jobId === null || occ.jobId === jobId) handle.jobs.moveOccurrence(occ.id, ['due'], 'held', { outcomeCode: code }, at)
    }
  }

  /**
   * A pause or the company's stop ends (in the caller's transaction): the newest slot that passed while it
   * lasted — not made yet because no clock ran in between — is written `held`, so the clock never makes
   * it `due` afterwards (「再開しても動かさない」). For the job (null: every job of the company).
   */
  function holdPassedSlot(companyId: string, jobId: string | null, code: 'JOB_PAUSED' | 'COMPANY_STOPPED'): void {
    const handle = companyData.forCompany(companyId)
    const nowMs = clock.nowMs()
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
        placement.set(key, v ? definitionOf(v).placement : null)
      }
      return placement.get(key)
    }
    // A version gone (never: versions are append-only) is left to runOccurrence, which holds it.
    return handle.jobs.dueOccurrences(OPEN_SCAN_LIMIT).filter(o => placementOf(o) !== 'a').slice(0, limit)
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

  return {
    makeOccurrences,
    runOccurrence,
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
