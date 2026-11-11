import type { JobDefinition, JobPauseReason, JobState, JobTrigger } from '../../shared/core/jobs'
import type { JobWaiting } from '../../shared/types/jobs'

/**
 * Settings → 「定期の仕事」 (jobs.md "The screens", PR 4): the scheduled jobs the member is the responsible
 * person of, read with their session in main (IPC `jobs:*`) — what waits for their 「受け取る」 and their
 * own pause / resume. The server decides every rule (who accepts, which pause is theirs to lift).
 */

export const JOBS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは定期の仕事を読み込めません（オフラインの可能性があります）。'

/** One job the member is responsible for, as the app shows it. */
export interface MyJob {
  id: string
  /** 「定期の仕事」 when a place its newest version names is not the member's to read (the server's rule). */
  name: string
  state: JobState
  waiting: JobWaiting
  pausedReason: JobPauseReason | null
  trigger: JobTrigger | null
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

/** The bell's notices that open this section (they are about a job, not a record). */
export function opensJobs(kind: string): boolean {
  return kind === 'job_accept_needed' || kind === 'job_expired' || kind === 'job_skipped' || kind === 'job_failed'
}
