// 「会議のあと」 (4b-4 PR6-A, owner memo 「4b-4 挟む部分」 H-9 A): the one door of this feature. AppShell draws it under a job's
// やること only while the company's 「使う機能」 has it on (`afterMeeting`, off by default). Remove the feature: jobs.md
// "The 4b-4 screens (PR6-A)" lists every place and line (client/tests/after-meeting-removable.test.ts holds them).
import { UpdateProposalCard, type CardTask } from './components/UpdateProposalCard'
import { WeeklyReportPart } from './components/WeeklyReportPart'
import { isWeeklyReportTask, occurrenceOfTask } from './model'

export interface AfterMeetingPartProps {
  /** The company's 「使う機能」 `afterMeeting` (off by default): off → nothing of this feature is drawn or read. */
  enabled: boolean
  companyId: string
  rootPath: string
  task: CardTask
  busy: boolean
  /** The card's own 完了にする (its refusal's words), or null when not offered to the member now. */
  onComplete: (() => Promise<string | null>) | null
}

export function AfterMeetingPart({ enabled, companyId, rootPath, task, busy, onComplete }: AfterMeetingPartProps) {
  if (!enabled || !rootPath) return null
  if (isWeeklyReportTask(task.title)) return <WeeklyReportPart task={task} busy={busy} onComplete={onComplete} />
  const occurrenceId = occurrenceOfTask(task.id)
  // Keyed by the やること: another one starts from its own file, never from the edits of the last.
  return occurrenceId ? <UpdateProposalCard key={task.id} companyId={companyId} rootPath={rootPath} occurrenceId={occurrenceId} task={task} /> : null
}
