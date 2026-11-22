import { knownJobDefinition, type JobDefinition, type JobOccurrenceState, type JobPauseReason, type JobPlacement, type JobRetryBlock, type JobState, type JobTrigger } from '../../shared/core/jobs'
import type { JobWaiting } from '../../shared/types/jobs'

/**
 * Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is the responsible
 * person of, read with their session in main (IPC `jobs:*`) — what waits for their 「受け取る」 and their
 * own pause / resume. The server decides every rule (who accepts, which pause is theirs to lift).
 */

/**
 * The definition shapes **this app** shows and accepts in 「定期の仕事」 (stage 4b-0.5, owner memo 「段4b 設計メモ」 §5-1): what
 * every job request announces (`X-ACB-Job-Schemas`, `electron/features/jobs/ipc.ts`), never the shared parser's
 * `JOB_SCHEMAS` — a later core may read a shape (4b-1's `schema: 3`) before this app can show it, and the server must
 * then neither hand it its definition nor take its 受け取る. Each one's words are checked by
 * `client/tests/job-screen-schemas.test.ts`. `3` since stage 4b-2 (an event run by this PC's AI), in the same build
 * that runs it (fail closed, the event claim's locks: `electron/features/ai-turns/job-runs.ts`).
 * `4` since member proposals' PR C (a member's proposal: schema 1's words, its card and 「受け取る」 in this app; `jobs.md`
 * "Member proposals" "The app (PR C)").
 */
export const APP_JOB_SCHEMAS: readonly number[] = [1, 2, 3, 4]

/** A definition this app shows: a shape the core knows and this app announces; anything else is shown as hidden. */
export function appReadsJobDefinition(d: unknown): JobDefinition | null {
  const known = knownJobDefinition(d)
  return known !== null && APP_JOB_SCHEMAS.includes(known.schema) ? known : null
}

/** The server answers jobs without who the member is to them (a build before PR 4): nothing can be shown honestly. */
export const JOBS_SERVER_TOO_OLD_TEXT = 'サーバーの更新が必要です。会社のサーバーが新しくなると、ここに定期の仕事が出ます。'

export const JOBS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは定期の仕事を読み込めません（オフラインの可能性があります）。'

/** One job the member is responsible for, as the app shows it. */
export interface MyJob {
  id: string
  /** The approved version's name (else the newest's); 「定期の仕事」 when a place it names is not the member's to read (the server's rule). */
  name: string
  state: JobState
  waiting: JobWaiting
  pausedReason: JobPauseReason | null
  trigger: JobTrigger | null
  /** `a`: on the responsible person's PC — does not run before PR 5. */
  placement: JobPlacement | null
  nextSlot: string | null
  /**
   * The approved version waiting for the member's 「受け取る」, or null. `definition` null: it names a place
   * the member cannot read now (the server would refuse the acceptance too). `why`: `accept` — not accepted
   * yet; `place` — accepted, but the deliverable place they chose can no longer be used (a Drive folder pick
   * past its 90 days): 「受け取る」 again chooses it anew.
   */
  toAccept: { version: number; fingerprint: string | null; definition: JobDefinition | null; why: 'accept' | 'place' } | null
  /**
   * The deliverable place outside (the server's `deliverTo`): its kind's words, whether one was chosen and is
   * usable now; its name and when the pick ends (only the responsible person's own). null: none.
   */
  deliverTo: { label: string; chosen: boolean; usable: boolean; name: string | null; expiresAt: string | null } | null
  /** The member runs it (the approved version names them): they may pause it, and resume their own pause. */
  controls: boolean
  /**
   * Stage 4a ①: an event job whose chain of watched records stopped — why, as the server words it for the member. null:
   * it goes on, or it is not an event job. The member (its responsible person) chooses the next watched やること.
   */
  chainStopped: { why: string } | null
  /** The approved version's number (the one 「選び直す」 acts on), or null. */
  approvedVersion: number | null
}

/** `jobs:watchChoices`: the member's open やること (title only), the first page of what matches. */
export type WatchChoicesResult = { success: true; choices: Array<{ id: string; title: string }>; total: number } | JobsFailure

export type JobsFailure = { success: false; offline: boolean; code: string | null; error: string }

/** `jobs:mine`. */
export type MyJobsResult = { success: true; jobs: MyJob[] } | JobsFailure
/** `jobs:accept` / `jobs:pause` / `jobs:resume`. */
export type JobActionResult = { success: true } | JobsFailure

/**
 * What opening a job's notice in the bell does (they are about a job, not a record): 「受け取りが要ります」 opens
 * this section (it goes to the responsible person alone); an occurrence's notice (`job_expired` …) also
 * reaches the job's creator, who may run nothing here, so it opens nothing — its text says what happened.
 * null: not a job's notice.
 */
export function jobNoticeTarget(kind: string): 'jobs' | 'none' | null {
  // A stopped chain (stage 4a): the responsible person chooses the next watched やること there.
  if (kind === 'job_accept_needed' || kind === 'job_chain_stopped') return 'jobs'
  // A member's proposal returned (member proposals): the proposer sees its state in their list of proposals there.
  if (kind === 'job_proposal_returned') return 'jobs'
  // A proposal waiting for an owner / admin: decided in the admin console, nothing to press here.
  if (kind === 'job_proposal') return 'none'
  // `company_restored` (deployment.md "After a restore"): about the jobs and the AI stopped; its text says what to check.
  if (kind === 'job_expired' || kind === 'job_skipped' || kind === 'job_failed' || kind === 'job_paused' || kind === 'company_restored') return 'none'
  return null
}

/**
 * One occurrence of an event job this PC's AI ran for the member (stage 4b-2, owner memo 「段4b 設計メモ」 §4-3 / D11; `GET
 * /me/job-occurrences`, the server's `MyJobOccurrenceView`): what the server returns and nothing derived — `retry` and
 * `unknownOperations` only where the member's rights cover them (the server leaves them out otherwise). `name` is the
 * name of the version they ran (「定期の仕事」 when it names a place they cannot read now).
 */
export interface MyJobOccurrence {
  id: string
  jobId: string
  name: string
  dueSlot: string
  /** null: a state this app does not know (a later server's). */
  state: JobOccurrenceState | null
  outcomeCode: string | null
  /** `why`: a `JobRetryBlock`, or `UNKNOWN` for a reason this app does not know (`jobRetryBlockText` says it in generic words). */
  retry: { allowed: true } | { allowed: false; why: JobRetryBlock | 'UNKNOWN' } | null
  unknownOperations: Array<{ key: string; kind: string }>
  madeBefore: Array<{ kind: string; count: number }>
}

/** `jobs:occurrences`. `supported: false`: a server before stage 4b-1 (nothing to show, said as nothing). */
export type MyJobOccurrencesResult = { success: true; supported: boolean; occurrences: MyJobOccurrence[] } | JobsFailure

/** 「後始末」's question for an outside operation whose result nobody knows, in plain words. */
export const JOB_RECONCILE_ASK = 'が作られたか分かりません。あなたの「送るもの」や置き先で確かめて、どちらかを押してください。押しても、この回は動き出しません。'
