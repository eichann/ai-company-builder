/**
 * Scheduled jobs (定期の仕事, `.claude/rules/jobs.md`), behind the company handle (`CompanyData.jobs`;
 * adapters/sqlite/jobs.ts). Every method is limited to the handle's company: another company's job id
 * is not found and nothing of it changes. Versions are append-only: there is no method that rewrites a
 * version's definition (and a trigger refuses it), only one that adds a version and ones that mark a
 * version approved / accepted once.
 */
import type { JobDeliveryPlace, JobOccurrenceState, JobPauseReason, JobState, LedgerEventRow } from '../../shared/core/jobs'

export interface JobRow {
  id: string
  name: string
  state: JobState
  actingUserId: string
  latestVersion: number
  approvedVersion: number | null
  approvedFingerprint: string | null
  acceptedVersion: number | null
  acceptedConsent: string | null
  /** The deliverable place outside the responsible person chose when accepting (`ref` filled), or null. */
  acceptedPlace: JobDeliveryPlace | null
  pausedReason: JobPauseReason | null
  pausedBy: string | null
  pausedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface JobVersionRow {
  jobId: string
  version: number
  schema: number
  /** The canonical JSON of the definition. */
  definition: string
  fingerprint: string
  consentFingerprint: string
  actingUserId: string
  createdBy: string
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  acceptedBy: string | null
  acceptedAt: string | null
}

/** An occurrence (回) of a job (`ai_job_occurrences`). */
export interface JobOccurrenceRow {
  id: string
  jobId: string
  /** The approved version when the clock made it: the run is pinned to it. */
  jobVersion: number
  /** Company time, `YYYY-MM-DDTHH:MM`: the occurrence's identity within its job. */
  dueSlot: string
  timeZone: string
  /** UTC ISO instants. */
  dueAt: string
  expiresAt: string
  state: JobOccurrenceState
  runId: string | null
  outcomeCode: string | null
  /**
   * Where its check stopped looking (B PR 5a-2): set at the first claim — the occurrence's own `dueAt`, or for a
   * meeting check that found more than one run takes, the time of the first meeting left for the next one. The next
   * occurrence's check starts there. null: not claimed yet, or made by a build before it.
   */
  checkedUntil?: string | null
  /**
   * The commit a `new_files` check in the shared folder looked up to (B PR 5a-2): the app names it with its first
   * claim (its place's repository, synced); the next occurrence's check lists what was added after it, whatever the
   * commits' dates. null: none named (a working folder, a meeting check, an older app).
   */
  checkedCommit?: string | null
  /** 「もう一度」 (B PR 5b): how often an owner / admin sent it back to `due` (0: never), and the last press. */
  retries?: number
  retriedBy?: string | null
  retriedAt?: string | null
  /**
   * Stage 4a, an event occurrence (`due_slot` `ev:<seq>`): the ledger's delivery number of its event, the record and
   * its version then, and the company's day it was made (the day's limit counts these). Absent / null: a time slot.
   */
  eventSeq?: number | null
  eventRecordId?: string | null
  eventVersion?: number | null
  eventDay?: string | null
  /**
   * Stage 4b-0.5: the watch (`JobEventCursor.generation`) an event occurrence was made for. Only an occurrence of the
   * watch now moves, stops or clears it; null / absent (a time slot, or a watch not known) never does.
   */
  watchGeneration?: number | null
  createdAt: string
  updatedAt: string
}

/** A stretch no event of a job runs in (stage 4a): delivery numbers in (`from`, `until`]; `until` null while it lasts. */
export interface JobEventGap { from: number; until: number | null }

/**
 * An event job's place in the ledger and what it watches (stage 4a): `seen` the delivery number looked at up to;
 * `watch` the one record it watches now (server-managed), `start` the accepted start record it began from, `fired`
 * whether `watch` made its occurrence already.
 */
export interface JobEventCursor {
  seen: number; watch: string; start: string; fired: boolean
  /** What this build last wrote of the job (`ai_jobs.updated_at`) and of the company's stop (`ai_job_settings.updated_at`, '' = none). */
  jobStamp: string; stopStamp: string
  /** The chain of watched records stopped (owner decision ①): why, on which record, when; null while it goes on. */
  chainStop: { code: string; record: string; at: string } | null
  /** Stage 4b-0.5: which watch this is (+ 1 each time it starts over or moves); null only before the startup migration. */
  generation: number | null
}

export interface JobRepository {
  /** Every job of the company, newest first. */
  list(): JobRow[]
  /** The jobs whose newest or approved version names the member as responsible person. */
  listFor(userId: string): JobRow[]
  find(jobId: string): JobRow | null
  /** A job with its first version, in one transaction (the caller's). */
  create(job: JobRow, first: JobVersionRow): void
  /** Append a version (its number = latest + 1, checked by the caller) and move the job's newest version, name and responsible person. */
  addVersion(version: JobVersionRow, at: string): void
  versions(jobId: string): JobVersionRow[]
  version(jobId: string, version: number): JobVersionRow | null
  /** The version approved: the job's pin, and the version's approved_* (set once). */
  approve(jobId: string, version: number, fingerprint: string, by: string, at: string, state: JobState): void
  /** The responsible person accepted this version's consent: the job's accepted_*, and the version's accepted_* (set once). */
  accept(jobId: string, version: number, consentFingerprint: string, by: string, at: string, place: JobDeliveryPlace | null): void
  /** Pause / resume: the state with its reason (null on resume). */
  setState(jobId: string, state: JobState, reason: JobPauseReason | null, by: string | null, at: string): void
  /** 「定期の仕事をすべて止める」. */
  stopped(): boolean
  setStopped(stopped: boolean, by: string, at: string): void

  // Every occurrence method below acts as if a **frozen** occurrence did not exist (stage 4b-0.5, the rollback floor:
  // pinned to a version of a shape this build does not know — a later build made it): none is read, listed, counted,
  // moved or sent back, and the limits count only the others. Exceptions: `holdFrozen` (a pause / stop / restore holds
  // every one, without a limit) and `isHiddenOccurrence`, a yes/no used only to refuse. (Event occurrences, which
  // stage 4-0.1 left out the same way, are read here since 4a: every answer to a person checks their record.)
  /** Insert an occurrence unless its (job, slot) is there already (`UNIQUE`): false = it was (nothing written). */
  insertOccurrence(row: JobOccurrenceRow): boolean
  occurrence(occurrenceId: string): JobOccurrenceRow | null
  /**
   * A job's occurrences, newest first, from `offset`: by when each came — a time slot by its time, an event one by when
   * it was made (a job whose trigger changed has both) — and events of one moment by delivery number.
   */
  occurrences(jobId: string, limit: number, offset?: number): JobOccurrenceRow[]
  /** Occurrences in `due`, oldest due first (every job of the company, or `jobId`'s only). */
  dueOccurrences(limit: number, jobId?: string | null): JobOccurrenceRow[]
  /** Occurrences in `running` (a PC's run holds them, B PR 5a), oldest due first (every job of the company, or `jobId`'s only). */
  runningOccurrences(limit: number, jobId?: string | null): JobOccurrenceRow[]
  /**
   * Stage 4b-1: whether an occurrence of the job other than `exceptId` is `running` — every one, no limit (a PC's event
   * occurrence waits while another of its job runs: they never run side by side, whatever the history's length).
   */
  otherRunning(jobId: string, exceptId: string): boolean
  /**
   * Stage 4b-1 (owner memo 「段4b 設計メモ」 D11): the distinct event records of occurrences pinned to a version whose
   * responsible person is `userId`, newest event first, from `offset`, at most `limit` (the reader check is the caller's).
   */
  eventRecordsPinnedTo(userId: string, limit: number, offset?: number): string[]
  /**
   * The occurrences pinned to a version whose responsible person is `userId`, of the event `records` only (left out in
   * SQL before the limit), newest first, at most `limit`: what that person ran, whoever is responsible now.
   */
  occurrencesPinnedTo(userId: string, records: readonly string[], limit: number): JobOccurrenceRow[]
  /**
   * Stage 4b-0.5: a pause, the company's stop or a restore holds every frozen occurrence of the job (null: of every job)
   * still `due` or `running` — `held` with `code`, **no limit** — and answers the runs of those that were running, for
   * the caller to end. Nothing else: no notice, no watch stopped (a later build reads them again).
   */
  holdFrozen(jobId: string | null, code: string, at: string): string[]
  /**
   * Move an occurrence from one of `from` to `to` (compare-and-set): false = it was no longer in
   * `from` (someone else moved it first; nothing written).
   */
  /**
   * 「もう一度」 (B PR 5b): from one of `from` back to `due` (compare-and-set) with no run, no outcome, the new
   * `expiresAt`, `retries` + 1 and who pressed it. Where its check stopped (`checked_until` / `checked_commit`) is
   * kept: it looks at the same window again. false = it was no longer in `from` (nothing written).
   */
  retryOccurrence(occurrenceId: string, from: readonly JobOccurrenceState[], expiresAt: string, by: string, at: string): boolean
  moveOccurrence(occurrenceId: string, from: readonly JobOccurrenceState[], to: JobOccurrenceState, change: { runId?: string | null; outcomeCode: string | null; checkedUntil?: string; checkedCommit?: string | null }, at: string): boolean

  // Stage 4a, event-triggered jobs (jobs.md "Event-triggered jobs").
  /** The company's newest delivery number given so far (0: none): where a cursor or a gap starts "now". */
  ledgerSeqNow(): number
  /**
   * One record's ledger rows with a delivery number in (`afterSeq`, `upToSeq`], in delivery order, at most `limit`
   * (with the record's type): what a job watching that record looks at (indexed by the record).
   */
  watchedEvents(recordId: string, afterSeq: number, upToSeq: number, limit: number): LedgerEventRow[]
  /** The job's distinct event records, newest event first, at most `limit` (who may see its occurrences is who reads them). */
  eventRecordsOf(jobId: string, limit: number): string[]
  /**
   * The job's newest occurrences (the order of `occurrences`), at most `limit`: every time slot, and the event ones of
   * `records` only — leaving the others out in SQL, before the limit.
   */
  occurrencesOf(jobId: string, records: readonly string[], limit: number): JobOccurrenceRow[]
  /** Where the job's scan has looked up to and what it watches, or null: never accepted as an event job. */
  eventCursor(jobId: string): JobEventCursor | null
  /**
   * The responsible person accepted a version watching `startRecord`: the cursor at the company's newest delivery
   * number (never moved back) — and, when that start record is not the one it began from, the watch starts over there.
   */
  startEventCursor(jobId: string, startRecord: string, at: string): void
  /**
   * The responsible person chose `recordId` to watch (owner decision ①): the watch starts over there — whatever was
   * watched — the stop is gone, and the cursor is at now (what happened before is never looked at).
   */
  restartWatch(jobId: string, recordId: string, at: string): void
  /** Move the cursor from `from` to `to` (compare-and-set): false = it was not at `from` (nothing written). */
  moveEventCursor(jobId: string, from: number, to: number, at: string): boolean
  /** The watched record made its occurrence: it fires no more (compare-and-set on the record; false = it was not, or fired). */
  markWatchFired(jobId: string, recordId: string, at: string): boolean
  /**
   * The next record to watch (`followMadeTask`): only while `from` is still the watched one **of `generation`** — the
   * occurrence's own watch (false = it was not: nothing written; null never matches). Ends a chain stop; a new generation.
   */
  moveWatch(jobId: string, from: string, to: string, at: string, generation: number | null): boolean
  /** The chain stopped (owner decision ①) on `recordId`, the one watched now: false when it had stopped already (one notice per stop) or another record is watched. */
  stopChain(jobId: string, code: string, recordId: string, at: string): boolean
  /** The chain goes on after all (the occurrence it stopped on ran, after 「もう一度」): only a stop on `recordId`, of the watch `generation` (null: none). */
  clearChainStop(jobId: string, recordId: string, generation: number | null): void
  /** Which gaps are open now: the job's (`jobId` as given) and / or the company's stop's (''). */
  openGapKeys(jobId: string): string[]
  /** The job's gaps and the company's (its stops), in any order. */
  eventGaps(jobId: string): JobEventGap[]
  /** A pause (`jobId`) or the company's stop (null) begins: a gap from the newest delivery number now, unless one is open. */
  openEventGap(jobId: string | null, id: string, at: string): void
  /**
   * It ends: every open gap of the job (null: of the company's stop) ends at the newest delivery number now — or at
   * `untilSeq` (never before where it began). How many ended.
   */
  closeEventGaps(jobId: string | null, at: string, untilSeq?: number): number
  /**
   * Look at nothing from before now (the job's cursor; null: every event job's of the company): a pause or a stop a build
   * before 4a made has no gap, so nothing that happened since the cursor may run. The stamps take what is written now.
   */
  resyncEventCursors(jobId: string | null, at: string): void
  /** When the company's stop was last written (`ai_job_settings.updated_at`), '' when never. */
  stopStamp(): string
  /** How many event occurrences of the job were made on the company's `day`. */
  eventOccurrencesOn(jobId: string, day: string): number
  /**
   * Stage 4-0.1: a pause or the company's stop (restore's included) holds the job's (null: every job's) event
   * occurrences still `due` — `held` with `code` — so that returning to 4a never runs one that waited before the pause.
   * On 4-0.1 the only write that touches one. 4a holds them in `holdDue`'s own loop (stopping their chains) and calls
   * this after it, for any left beyond that loop's limit.
   */
  holdEventOccurrences(jobId: string | null, code: string, at: string): void
  /**
   * Stage 4-0.1: whether this id is an event occurrence — only so that a refusal can treat a PC run on one as a missing
   * run (`ai-runs.ts` `ownRun`; 4a runs every event occurrence on the server, so none has a PC run). Stage 4b-0.5: a
   * frozen occurrence too (a later build's PC run on it is a missing run here).
   */
  isHiddenOccurrence(occurrenceId: string): boolean
}
