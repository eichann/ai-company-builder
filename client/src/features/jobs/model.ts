// 「定期の仕事」 in the app: what a message says after the member's act, from the job as the server answers
// after it (it may still not run: paused, the company's stop; a PC job runs only while the app is open).
import type { MyJob } from '../../../shared/jobs'
import { jobRunsText } from '../../../../shared/core/job-words'

export const runsLine = (job: MyJob) => `いまは「${jobRunsText(job.waiting, job.pausedReason, job.placement)}」です。`

/** After 受け取る: what will really happen. */
export function acceptedText(after: MyJob | null): string {
  if (!after) return '受け取りました。'
  if (after.waiting === null && after.placement === 'a') return '受け取りました。次の回から、このアプリが開いていて「自動で進める」が入っているときに動きます。'
  if (after.waiting === null) return '受け取りました。次の回から動きます。'
  return `受け取りました。${runsLine(after)}`
}
