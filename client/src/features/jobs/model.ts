// 「定期の仕事」 in the app: what a message says after the member's act, from the job as the server answers
// after it (it may still not run: paused, the company's stop, a job on the PC before PR 5).
import type { MyJob } from '../../../shared/jobs'
import { jobRunsText } from '../../../../shared/core/job-words'

export const runsLine = (job: MyJob) => `いまは「${jobRunsText(job.waiting, job.pausedReason, job.placement)}」です。`

/** After 受け取る: what will really happen. */
export function acceptedText(after: MyJob | null): string {
  if (!after) return '受け取りました。'
  if (after.waiting === null && after.placement !== 'a') return '受け取りました。次の回から動きます。'
  return `受け取りました。${runsLine(after)}`
}
