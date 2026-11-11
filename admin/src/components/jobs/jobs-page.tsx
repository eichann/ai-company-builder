'use client'

// 「定期の仕事」 (jobs.md "The screens", PR 4; owners and admins): the company's scheduled jobs — when each
// runs, whether it would, its next and last occurrence — with 作る・直す・承認・止める and the company-wide
// stop. The server decides every rule; the words come from shared/core/job-words.ts.
import { useState } from 'react'
import { toast } from 'sonner'
import { ClockCounterClockwise, Plus } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { companiesApi, jobsApi, type JobView, type Member } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'
import { jobOccurrenceText, jobSlotText, jobTriggerText, jobWaitingText } from '../../../../shared/core/job-words'
import { JobApproveDialog, JobFormDialog, JobOccurrences } from './job-dialogs'

export const JOBS_INTRO =
  '決まった時間に、責任者のやることを作る仕事です（例：毎週月曜 9:00 に「週の報告を書く」）。作ったあと、オーナーか管理者が承認し、責任者が内容を確かめて「受け取る」を押すと動き始めます。AI は使いません。'

const personName = (m: { name: string | null; email: string | null } | undefined) => (m ? m.name || m.email || '名前未設定' : 'もういない人')

/** The badge: the one word for where the job stands. */
export function jobBadge(job: JobView): { label: string; variant: 'success' | 'warning' | 'secondary' } {
  if (job.state === 'retired') return { label: '使っていません', variant: 'secondary' }
  if (job.state === 'paused') return { label: '止まっています', variant: 'warning' }
  if (job.waiting === 'COMPANY_STOPPED') return { label: 'すべて止めています', variant: 'warning' }
  if (job.waiting === 'NOT_APPROVED') return { label: '承認待ち', variant: 'secondary' }
  if (job.waiting === 'NOT_ACCEPTED') return { label: '受け取り待ち', variant: 'warning' }
  return { label: '動いています', variant: 'success' }
}

export function JobsPage() {
  const { companyId, isAdmin, role } = useCompany()
  const { user } = useAuth()
  const jobs = useQuery(isAdmin ? `jobs:${companyId}` : null, () => jobsApi.list(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [editing, setEditing] = useState<{ job: JobView | null } | null>(null)
  const [approving, setApproving] = useState<JobView | null>(null)
  const [historyOf, setHistoryOf] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  if (role !== null && !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <PageHeader title="定期の仕事" />
        <p className="text-sm text-muted-foreground">このページはオーナーと管理者だけが使えます。</p>
      </div>
    )
  }

  const memberList = (members.data ?? []) as Member[]
  const byId = new Map(memberList.map((m) => [m.userId, m]))
  const replace = (next: JobView) =>
    jobs.setData((prev) => (prev ? { ...prev, jobs: prev.jobs.map((j) => (j.id === next.id ? { ...j, ...next } : j)) } : prev!))
  const act = async (what: string, run: () => Promise<JobView>) => {
    try {
      replace(await run())
      toast.success(what)
    } catch (err) {
      toast.error('できませんでした', { description: describeError(err) })
    }
  }
  const setStopped = async (stopped: boolean) => {
    try {
      await jobsApi.setStopped(companyId, stopped)
      jobs.reload()
      toast.success(stopped ? '定期の仕事をすべて止めました' : '定期の仕事を動かせるようにしました')
    } catch (err) {
      toast.error('できませんでした', { description: describeError(err) })
      throw err
    }
  }

  const list = jobs.data?.jobs ?? []
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="定期の仕事"
        description={JOBS_INTRO}
        actions={
          <Button onClick={() => setEditing({ job: null })} disabled={!members.data}>
            <Plus />
            定期の仕事を作る
          </Button>
        }
      />
      {jobs.data && (
        <Card className="mb-6 flex flex-wrap items-center gap-3 px-5 py-4" aria-label="定期の仕事をすべて止める">
          <div className="min-w-0 flex-1 text-sm">
            {jobs.data.stopped ? (
              <p role="status" className="font-medium text-warning">いま、この会社の定期の仕事はすべて止まっています。止めていた間の回は、再開しても動きません。</p>
            ) : (
              <p className="text-muted-foreground">困ったときは、この会社の定期の仕事をまとめて止められます。止めている間の回は、あとで再開しても動きません。</p>
            )}
          </div>
          {jobs.data.stopped ? (
            <Button variant="outline" onClick={() => void setStopped(false).catch(() => {})}>動かせるようにする</Button>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmStop(true)}>すべて止める</Button>
          )}
        </Card>
      )}
      {jobs.error && !jobs.data ? (
        <ErrorState error={jobs.error} onRetry={jobs.reload} />
      ) : jobs.loading || !jobs.data ? (
        <ListSkeleton rows={3} />
      ) : list.length === 0 ? (
        <EmptyState icon={ClockCounterClockwise} title="まだ定期の仕事がありません" description="「定期の仕事を作る」から、いつ・だれに・何を作るかを決めてください。" />
      ) : (
        <Card className="p-0">
          <ul aria-label="定期の仕事" className="divide-y">
            {list.map((job) => {
              const badge = jobBadge(job)
              const newerDraft = job.approvedVersion !== null && job.latestVersion > job.approvedVersion
              const last = job.lastOccurrence ? jobOccurrenceText(job.lastOccurrence.state, job.lastOccurrence.outcomeCode) : null
              return (
                <li key={job.id} className="space-y-2 px-5 py-4" aria-label={job.name}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {job.name}
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        責任者：{personName(byId.get(job.actingUserId))}
                        {job.trigger && <>　いつ：{jobTriggerText(job.trigger)}</>}
                      </p>
                      <p className="text-sm">{jobWaitingText(job.waiting, job.pausedReason)}</p>
                      {newerDraft && (
                        <p className="text-xs text-muted-foreground">新しい版（第{job.latestVersion}版）が承認待ちです。承認するまでは第{job.approvedVersion}版のとおりに動きます。</p>
                      )}
                      {job.placement === 'a' && <p className="text-xs text-muted-foreground">責任者の PC で動く仕事は、まだ動きません（準備中）。</p>}
                      <p className="text-xs text-muted-foreground">
                        次の回：{job.nextSlot ? jobSlotText(job.nextSlot) : job.approvedVersion === null ? '承認すると決まります' : 'ありません'}
                        {'　'}前の回：{job.lastOccurrence && last ? `${jobSlotText(job.lastOccurrence.dueSlot)}　${last.label}` : 'まだありません'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {job.state !== 'retired' && (job.approvedVersion === null || newerDraft) && (
                        <Button size="sm" onClick={() => setApproving(job)}>承認する</Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setEditing({ job })} disabled={!members.data || job.state === 'retired'}>直す</Button>
                      {job.state === 'paused' ? (
                        <Button variant="outline" size="sm" onClick={() => void act('再開しました', () => jobsApi.resume(companyId, job.id))}>再開する</Button>
                      ) : job.state !== 'retired' ? (
                        <Button variant="outline" size="sm" onClick={() => void act('止めました', () => jobsApi.pause(companyId, job.id))}>止める</Button>
                      ) : null}
                      <Button variant="ghost" size="sm" aria-expanded={historyOf === job.id} onClick={() => setHistoryOf(historyOf === job.id ? null : job.id)}>
                        回の記録
                      </Button>
                    </div>
                  </div>
                  {historyOf === job.id && <JobOccurrences jobId={job.id} />}
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {editing && (
        <JobFormDialog
          job={editing.job}
          members={memberList}
          defaultActingUser={user?.id ?? memberList[0]?.userId ?? ''}
          onClose={() => setEditing(null)}
          onSaved={() => jobs.reload()}
        />
      )}
      {approving && (
        <JobApproveDialog
          job={approving}
          members={memberList}
          myUserId={user?.id ?? null}
          onClose={() => setApproving(null)}
          onApproved={(next) => replace(next)}
        />
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="定期の仕事をすべて止めますか？"
        description="この会社のすべての定期の仕事が動かなくなります。止めている間に来た回は、あとで動かせるようにしても動きません。"
        confirmLabel="すべて止める"
        onConfirm={() => setStopped(true)}
      />
    </div>
  )
}
