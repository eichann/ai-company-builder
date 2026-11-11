import type { JobDefinition, JobPauseReason, JobPlacement, JobState, JobTrigger } from '../../shared/core/jobs'
import type { JobWaiting } from '../../shared/types/jobs'

/**
 * Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is the responsible
 * person of, read with their session in main (IPC `jobs:*`) — what waits for their 「受け取る」 and their
 * own pause / resume. The server decides every rule (who accepts, which pause is theirs to lift).
 */

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
   * the member cannot read now (the server would refuse the acceptance too).
   */
  toAccept: { version: number; fingerprint: string | null; definition: JobDefinition | null } | null
  /** The member runs it (the approved version names them): they may pause it, and resume their own pause. */
  controls: boolean
}

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
  if (kind === 'job_accept_needed') return 'jobs'
  if (kind === 'job_expired' || kind === 'job_skipped' || kind === 'job_failed' || kind === 'job_paused') return 'none'
  return null
}
