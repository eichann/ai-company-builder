'use client'

// 「定期の仕事」 (jobs.md "The screens", PR 4; owners and admins): the company's scheduled jobs — when each
// runs, whether it would, its next and last occurrence — with 作る・直す・承認・止める and the company-wide
// stop. The server decides every rule; the words come from shared/core/job-words.ts.
import { useState } from 'react'
import { toast } from 'sonner'
import { ClockCounterClockwise, Plus } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Callout } from '@/components/ui/callout'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { companiesApi, jobsApi, type JobView, type Member } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useCompany } from '@/lib/company-context'
import { describeJobError } from '@/lib/errors'
import { JOB_VERSION_HIDDEN } from '@/lib/jobs'
import { useQuery } from '@/lib/use-query'
import { JOB_CHAIN_STOPPED_ASK, jobOccurrenceText, jobRunsText, jobSlotText, jobTriggerText } from '../../../../shared/core/job-words'
import { JOB_NEEDS_NEWER_SCREEN, JOB_SYSTEM_PAUSE_REASONS, isKnownJobTrigger, isRecordTrigger } from '../../../../shared/core/jobs'
import { STOP_LOOK } from '../../../../shared/design-tokens/stop-meaning'
import { JobAcceptDialog, JobApproveDialog, JobFormDialog } from './job-dialogs'
import { JobOccurrences } from './job-occurrences'

export const JOBS_INTRO =
  '決まった時間か、見張っているやることが終わったときなどに動く仕事です。やることを作るだけの仕事（例：毎週月曜 9:00 に「週の報告を書く」。AI は使いません）と、責任者の PC の AI が会社の Skill で作業して、終わったらやることを作る仕事があります。作ったあと、オーナーか管理者が承認し、責任者が内容を確かめて「受け取る」を押すと動き始めます。'

const personName = (m: { name: string | null; email: string | null } | undefined) => (m ? m.name || m.email || '名前未設定' : 'もういない人')

/**
 * The badge: the one word for where the job stands. 「止まっている」 by meaning (`STOP_LOOK`, owner decision
 * 2026-11-21, design-system.md P2b): paused by a person (an admin, the responsible person, the company's stop) → grey
 * 「止めています」; paused by the server because the responsible person left or lost rights → red
 * 「止まりました」 (it needs a new responsible person); waiting for approval or acceptance → amber.
 */
export function jobBadge(job: JobView): { label: string; variant: BadgeVariant } {
  if (job.state === 'retired') return { label: '使っていません', variant: 'neutral' }
  if (job.state === 'paused') {
    const meaning = job.pausedReason !== null && JOB_SYSTEM_PAUSE_REASONS.includes(job.pausedReason) ? 'failed' : 'stoppedOnPurpose'
    return { label: STOP_LOOK[meaning].word, variant: STOP_LOOK[meaning].variant }
  }
  if (job.waiting === 'COMPANY_STOPPED') return { label: 'すべて止めています', variant: STOP_LOOK.stoppedOnPurpose.variant }
  if (job.waiting === 'NOT_APPROVED') return { label: STOP_LOOK.awaitingApproval.word, variant: STOP_LOOK.awaitingApproval.variant }
  if (job.waiting === 'NOT_ACCEPTED') return { label: '受け取りを待っています', variant: STOP_LOOK.awaitingApproval.variant }
  if (job.placement === 'a') return { label: 'PC で動きます', variant: 'success' }
  return { label: '動いています', variant: 'success' }
}

export function JobsPage() {
  const { companyId, isAdmin, role } = useCompany()
  const { user } = useAuth()
  const jobs = useQuery(isAdmin ? `jobs:${companyId}` : null, () => jobsApi.list(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [editing, setEditing] = useState<{ job: JobView | null } | null>(null)
  const [approving, setApproving] = useState<JobView | null>(null)
  const [accepting, setAccepting] = useState<JobView | null>(null)
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
      toast.error('できませんでした', { description: describeJobError(err) })
    }
  }
  const setStopped = async (stopped: boolean) => {
    try {
      await jobsApi.setStopped(companyId, stopped)
      jobs.reload()
      toast.success(stopped ? '定期の仕事をすべて止めました' : '定期の仕事を動かせるようにしました')
    } catch (err) {
      toast.error('できませんでした', { description: describeJobError(err) })
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
              <Callout variant="paused" role="status">いま、この会社の定期の仕事はすべて止めています。止めていた間の回は、再開しても動きません。</Callout>
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
              // Who it runs as now: the approved version's responsible person (the newest draft's may differ).
              const runsAs = job.approved?.responsibleUserId ?? job.actingUserId
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
                        責任者：{personName(byId.get(runsAs))}
                        {job.needsUpdate ? <>　{JOB_NEEDS_NEWER_SCREEN}</> : isKnownJobTrigger(job.trigger) ? <>　いつ：{jobTriggerText(job.trigger)}</>
                          // No trigger and not a shape it cannot show: the version is hidden from this viewer (it names a
                          // やること or a place they cannot read) — said as such, never what it names.
                          : job.trigger === undefined && <>　{JOB_VERSION_HIDDEN}</>}
                      </p>
                      <p className="text-sm">{jobRunsText(job.waiting, job.pausedReason, job.placement)}</p>
                      {/* An event job's chain that stopped (owner decision ①): its cause as the server words it for this viewer. */}
                      {job.chainStopped && (
                        <p role="status" className="text-sm text-destructive">
                          {job.chainStopped.why}。{JOB_CHAIN_STOPPED_ASK}（責任者がアプリで選ぶか、「直す」で見張るやることを選びます）
                        </p>
                      )}
                      {job.you?.mustAccept === true && (
                        <p role="status" className="text-sm">
                          {job.deliverTo
                            ? 'あなたが責任者です。あなたのアプリの「設定」→「仕事」→「定期の仕事」で置き先を選んで受け取るまで動きません。'
                            : 'あなたが責任者です。内容を確かめて「責任者として受け取る」を押すまで動きません。'}
                        </p>
                      )}
                      {newerDraft && (
                        <p className="text-xs text-muted-foreground">
                          新しい版（第{job.latestVersion}版）が承認待ちです。承認するまでは第{job.approvedVersion}版のとおりに動きます。
                          {job.actingUserId !== runsAs && <>次の版では責任者が{personName(byId.get(job.actingUserId))}さんになります（未承認）。</>}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        次の回：{job.nextSlot ? jobSlotText(job.nextSlot) : job.approvedVersion === null ? '承認すると決まります'
                          : isRecordTrigger(job.trigger) ? '見張っているやることが、きっかけの状態になったとき'
                          // A version hidden from this viewer (no trigger, not a shape it cannot show): nothing it names is said.
                          : job.trigger === undefined && !job.needsUpdate ? '表示できません' : 'ありません'}
                        {'　'}前の回：{job.lastOccurrence && last ? `${jobSlotText(job.lastOccurrence.dueSlot)}　${last.label}` : 'まだありません'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {job.state !== 'retired' && (job.approvedVersion === null || newerDraft) && (
                        <Button size="sm" onClick={() => setApproving(job)}>承認する</Button>
                      )}
                      {/* The viewer is its responsible person and has not accepted it (the server's `you`): their own press. */}
                      {job.you?.mustAccept === true && !job.deliverTo && (
                        <Button size="sm" variant="secondary" onClick={() => setAccepting(job)}>責任者として受け取る</Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setEditing({ job })} disabled={!members.data || job.state === 'retired' || job.needsUpdate === true}>直す</Button>
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
                  {historyOf === job.id && <JobOccurrences jobId={job.id} placement={job.placement} nameOf={(userId) => personName(byId.get(userId))} />}
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
      {accepting && (
        <JobAcceptDialog
          job={accepting}
          members={memberList}
          onClose={() => setAccepting(null)}
          onAccepted={(next) => replace(next)}
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
