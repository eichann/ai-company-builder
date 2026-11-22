'use client'

// 「届いた案」 (jobs.md "Member proposals", PR B): the time jobs members proposed from the AI chat, for owners / admins — who
// sent it (the stored proposer, never the responsible person), the server-made name, what the version they sent does in plain
// words, its state and when. Approving goes through the job's own approval (the newest version with its fingerprint), which
// never accepts; 「差し戻す」 names one fixed reason, never text. The server decides every move.
import { useState } from 'react'
import { toast } from 'sonner'

import { ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ApiError, jobProposalsApi, jobsApi, type JobProposalView, type JobView, type Member } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeJobError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { PROPOSAL_FILTERS, RETURN_REASON_CHOICES, proposalStateText, proposalVersionText } from '@/lib/job-proposals'
import { JOB_VERSION_HIDDEN, editableDefinition, hiddenVersion, needsNewerScreen } from '@/lib/jobs'
import { useQuery } from '@/lib/use-query'
import { JOB_NEEDS_NEWER_SCREEN } from '../../../../shared/core/jobs'
import type { JobProposalReturnReason } from '../../../../shared/core/job-proposals'
import { JobVersionWords } from './job-dialogs'

const personName = (m: { name: string | null; email: string | null } | undefined) => (m ? m.name || m.email || '名前未設定' : 'もういない人')
const SELECT = 'rounded-control border bg-background px-2 py-1 text-body'

/** 「届いた案」: the list by state (waiting first). A server without member proposals (404) shows nothing: none can arrive there. */
export function JobProposals({ jobs, members, onApprove, onChanged }: {
  jobs: JobView[]
  members: Member[]
  /** Open the job's approval (the existing path: the newest version, its fingerprint, never an acceptance). */
  onApprove: (job: JobView) => void
  /** A return changed a job (it is retired now): read the list again. */
  onChanged: () => void
}) {
  const { companyId } = useCompany()
  const [state, setState] = useState<(typeof PROPOSAL_FILTERS)[number]['value']>('submitted')
  const proposals = useQuery(`job-proposals:${companyId}:${state}`, () => jobProposalsApi.list(companyId, state))
  const [open, setOpen] = useState<string | null>(null)
  const [returning, setReturning] = useState<JobProposalView | null>(null)
  if (proposals.error instanceof ApiError && proposals.error.status === 404) return null
  const byId = new Map(members.map((m) => [m.userId, m]))
  const jobOf = (id: string) => jobs.find((j) => j.id === id) ?? null
  const list = proposals.data?.proposals ?? []

  return (
    <Card className="mb-6 space-y-3 px-5 py-4" aria-label="届いた案">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 font-medium">届いた案</h2>
        <select aria-label="案の状態" className={SELECT} value={state} onChange={(e) => { setState(e.target.value as typeof state); setOpen(null) }}>
          {PROPOSAL_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <p className="text-small text-muted-foreground">
        社員が「AIへの相談」から出した定期の仕事の案です。承認しても、出した人が自分のアプリで「受け取る」を押すまで動きません。
      </p>
      {proposals.error && !proposals.data ? (
        <p role="alert" className="text-body text-danger-text">{describeJobError(proposals.error)}</p>
      ) : !proposals.data ? (
        <ListSkeleton rows={2} />
      ) : list.length === 0 ? (
        <p className="text-body text-muted-foreground">{state === 'submitted' ? '確認を待っている案はありません。' : 'この状態の案はありません。'}</p>
      ) : (
        <ul aria-label="届いた案の一覧" className="divide-y">
          {list.map((p) => {
            const job = jobOf(p.jobId)
            const who = personName(byId.get(p.proposerId))
            const name = job?.name ?? '定期の仕事'
            return (
              <li key={p.id} aria-label={`${who}さんからの案`} className="space-y-2 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">{name}</p>
                    <p className="text-small text-muted-foreground">
                      {who}さんからの案　{formatDateTime(p.createdAt)}　{proposalStateText(p)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button variant="outline" size="sm" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>中身を見る</Button>
                    {p.state === 'submitted' && job && job.state !== 'retired' && (
                      <Button size="sm" onClick={() => onApprove(job)}>承認する</Button>
                    )}
                    {p.state === 'submitted' && (
                      <Button variant="outline" size="sm" onClick={() => setReturning(p)}>差し戻す</Button>
                    )}
                  </div>
                </div>
                {open === p.id && <ProposalContent proposal={p} proposerName={who} members={members} />}
              </li>
            )
          })}
        </ul>
      )}
      {returning && (
        <JobReturnDialog
          proposal={returning}
          jobName={jobOf(returning.jobId)?.name ?? '定期の仕事'}
          proposerName={personName(byId.get(returning.proposerId))}
          onClose={() => setReturning(null)}
          onReturned={() => { proposals.reload(); onChanged() }}
        />
      )}
    </Card>
  )
}

/**
 * The version the member sent, in the shared words (the job's detail, with the server's own hiding: a version naming what this
 * viewer cannot read is said as such, a shape this console cannot show likewise). A later version an owner / admin made is
 * named, not shown here: the approval shows the version it approves.
 */
function ProposalContent({ proposal, proposerName, members }: { proposal: JobProposalView; proposerName: string; members: Member[] }) {
  const { companyId } = useCompany()
  const detail = useQuery(`job:${companyId}:${proposal.jobId}`, () => jobsApi.get(companyId, proposal.jobId))
  if (detail.error && !detail.data) return <p role="alert" className="text-body text-danger-text">{describeJobError(detail.error)}</p>
  if (!detail.data) return <ListSkeleton rows={2} />
  const sent = (detail.data.versions ?? []).find((v) => v.version === proposal.submittedVersion) ?? null
  const definition = editableDefinition(sent)
  return (
    <div className="space-y-2 rounded-control border px-3 py-2" aria-label="出した内容">
      <p className="text-small text-muted-foreground">第{proposal.submittedVersion}版：{proposalVersionText(proposal.submittedVersion, proposal, proposerName)}</p>
      {needsNewerScreen(sent) ? (
        <p role="note" className="text-body">{JOB_NEEDS_NEWER_SCREEN}</p>
      ) : hiddenVersion(sent) || !definition ? (
        <p role="note" className="text-body">{JOB_VERSION_HIDDEN}</p>
      ) : (
        <JobVersionWords definition={definition} members={members} />
      )}
      {detail.data.latestVersion > proposal.submittedVersion && (
        <p className="text-small text-muted-foreground">このあと管理者が直した版（第{detail.data.latestVersion}版）があります。承認するときは、その版の内容を確かめます。</p>
      )}
    </div>
  )
}

/**
 * 「差し戻す」: one of the fixed reasons (no text box — a typed reason could carry a name the proposer must not read). The job
 * is not used afterwards (the server retires it) and the proposer is told the reason's words.
 */
export function JobReturnDialog({ proposal, jobName, proposerName, onClose, onReturned }: {
  proposal: JobProposalView
  jobName: string
  proposerName: string
  onClose: () => void
  onReturned: () => void
}) {
  const { companyId } = useCompany()
  const [reason, setReason] = useState<JobProposalReturnReason | ''>('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const send = async () => {
    if (!reason) return
    setBusy(true)
    setProblem(null)
    try {
      await jobProposalsApi.returnProposal(companyId, proposal.id, reason)
      toast.success(`差し戻しました。${proposerName}さんに理由が知らされます`)
      onReturned()
      onClose()
    } catch (err) {
      setProblem(describeJobError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>「{jobName}」の案を差し戻しますか？</DialogTitle>
          <DialogDescription>
            差し戻すと、この案から生まれた定期の仕事は使わなくなります（直したり承認したりできません）。{proposerName}さんには、選んだ理由が知らされます。
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-body font-medium">理由</legend>
          {RETURN_REASON_CHOICES.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-body">
              <input type="radio" name="return-reason" value={c.value} checked={reason === c.value} onChange={() => setReason(c.value)} />
              {c.label}
            </label>
          ))}
        </fieldset>
        {problem && <p role="alert" className="text-body text-danger-text">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button variant="destructive" onClick={() => void send()} disabled={busy || !reason}>差し戻す</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
