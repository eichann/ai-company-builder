// 「定期の仕事」 in the app: what a message says after the member's act, from the job as the server answers
// after it (it may still not run: paused, the company's stop; a PC job runs only while the app is open).
import type { MyJob } from '../../../shared/jobs'
import { jobRunsText } from '../../../../shared/core/job-words'

export const runsLine = (job: MyJob) => `いまは「${jobRunsText(job.waiting, job.pausedReason, job.placement)}」です。`

/**
 * The deliverable place outside, in one line (jobs.md "A deliverable place outside"): chosen and usable — its name
 * (the member's own pick) and until when ACB may use it; not usable — that it must be chosen again; none chosen —
 * that 「受け取る」 asks for it. null: the job puts nothing outside.
 */
export function placeLine(job: MyJob): string | null {
  const d = job.deliverTo
  if (!d) return null
  if (!d.chosen) return `できたものを置く先：${d.label}（「受け取る」を押すと、選ぶ画面が開きます）`
  if (!d.usable) return `できたものを置く先：${d.label}が使えなくなりました（選んでから90日たったか、消されました）。選び直すまで動きません。`
  const until = d.expiresAt ? new Date(d.expiresAt) : null
  const when = until && !Number.isNaN(until.getTime()) ? `（${until.getMonth() + 1}/${until.getDate()} まで使えます。そのあとは選び直します）` : ''
  return `できたものを置く先：${d.label}${d.name ? `「${d.name}」` : ''}${when}`
}

/** After 受け取る: what will really happen. */
export function acceptedText(after: MyJob | null): string {
  if (!after) return '受け取りました。'
  if (after.waiting === null && after.placement === 'a') return '受け取りました。次の回から、このアプリが開いていて「自動で進める」が入っているときに動きます。'
  if (after.waiting === null) return '受け取りました。次の回から動きます。'
  return `受け取りました。${runsLine(after)}`
}
