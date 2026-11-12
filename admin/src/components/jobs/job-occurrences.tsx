'use client'

// A job's occurrences (回の記録, jobs.md "The screens") and 「もう一度」 (B PR 5b): only on an occurrence the server says
// may run again (`retry`), after a confirmation; otherwise why not, in plain words. An outside operation whose result
// is unknown is settled first (作られていた／作られていなかった), as the responsible person found it. The server decides.
import { useState } from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { jobsApi, type JobOccurrenceView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'
import { jobMadeBeforeText, jobOccurrenceText, jobOperationKindText, jobRetryBlockText, jobSlotText } from '../../../../shared/core/job-words'

type Asking =
  | { kind: 'retry'; occ: JobOccurrenceView }
  | { kind: 'reconcile'; occ: JobOccurrenceView; key: string; what: string; done: boolean }

/** An ISO instant as 「11月12日 10:05」 (this computer's time). */
function whenText(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What the confirmation says will happen after 「もう一度」 (and, first, what earlier runs already made). */
export function retryConfirmText(placement: 'e' | 'a' | null | undefined, made: ReadonlyArray<{ kind: string; count: number }> = []): string {
  const before = jobMadeBeforeText(made)
  return (before ? `${before}もう一度すると、また作られることがあります。` : '') + (placement === 'a'
    ? 'この回を、もう一度動かします。責任者のアプリが開いていて「自動で進める」が入っているときに、責任者の PC の AI が始めます。期限は今から数え直します。やることが作られるのは、この回で1つだけです。'
    : 'この回を、もう一度動かします。数分のうちに、やることを作り直します（この回で1つだけです）。期限は今から数え直します。')
}

/** A job's occurrences (newest first): when, what became of it and why, in plain words — and 「もう一度」 where it works. */
export function JobOccurrences({ jobId, placement, nameOf }: {
  jobId: string
  placement?: 'e' | 'a' | null
  nameOf: (userId: string) => string
}) {
  const { companyId } = useCompany()
  const list = useQuery(`job-occurrences:${companyId}:${jobId}`, () => jobsApi.occurrences(companyId, jobId))
  const [asking, setAsking] = useState<Asking | null>(null)

  const confirm = async () => {
    if (!asking) return
    try {
      if (asking.kind === 'retry') {
        await jobsApi.retryOccurrence(companyId, jobId, asking.occ.id)
        toast.success('この回をもう一度動かします')
      } else {
        await jobsApi.reconcileOccurrence(companyId, jobId, asking.occ.id, asking.key, asking.done)
        toast.success('確かめた結果を残しました')
      }
      list.reload()
    } catch (err) {
      toast.error('できませんでした', { description: describeError(err) })
      list.reload()
      throw err
    }
  }

  if (list.error && !list.data) return <p role="alert" className="text-sm text-destructive">{describeError(list.error)}</p>
  if (!list.data) return <ListSkeleton rows={2} />
  if (list.data.occurrences.length === 0) return <p className="text-sm text-muted-foreground">まだ回がありません。</p>
  return (
    <>
      <ul aria-label="回の記録" className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {list.data.occurrences.map((o) => {
          const words = jobOccurrenceText(o.state, o.outcomeCode)
          const slot = jobSlotText(o.dueSlot)
          return (
            <li key={o.id} className="space-y-1" aria-label={`${slot}の回`}>
              <div className="flex flex-wrap gap-x-3">
                <span className="tabular-nums">{slot}</span>
                <span className="font-medium">{words.label}</span>
                {words.why && <span className="text-muted-foreground">{words.why}</span>}
                <span className="text-xs text-muted-foreground">第{o.jobVersion}版</span>
              </div>
              {o.retriedBy && o.retriedAt && (
                <p className="text-xs text-muted-foreground">
                  {nameOf(o.retriedBy)}さんが「もう一度」を押しました（{whenText(o.retriedAt)}{(o.retries ?? 0) > 1 ? `、${o.retries}回目` : ''}）
                </p>
              )}
              {jobMadeBeforeText(o.madeBefore ?? []) && (
                <p className="text-xs text-muted-foreground">{jobMadeBeforeText(o.madeBefore ?? [])}</p>
              )}
              {(o.unknownOperations ?? []).map((op) => {
                const what = jobOperationKindText(op.kind)
                return (
                  <div key={op.key} className="flex flex-wrap items-center gap-2 text-xs">
                    <span>{what}が作られたか分かりません。責任者に確かめてもらってから選んでください。</span>
                    <Button size="sm" variant="outline" onClick={() => setAsking({ kind: 'reconcile', occ: o, key: op.key, what, done: true })}>作られていた</Button>
                    <Button size="sm" variant="outline" onClick={() => setAsking({ kind: 'reconcile', occ: o, key: op.key, what, done: false })}>作られていなかった</Button>
                  </div>
                )
              })}
              {o.retry && (o.retry.allowed ? (
                <Button size="sm" variant="outline" onClick={() => setAsking({ kind: 'retry', occ: o })}>もう一度</Button>
              ) : (
                <p className="text-xs text-muted-foreground">「もう一度」はできません：{jobRetryBlockText(o.retry.why)}</p>
              ))}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => { if (!open) setAsking(null) }}
        destructive={false}
        title={asking?.kind === 'reconcile' ? `${asking.what}は${asking.done ? '作られていた' : '作られていなかった'}、で合っていますか？` : `${asking ? jobSlotText(asking.occ.dueSlot) : ''}の回をもう一度動かしますか？`}
        description={asking?.kind === 'reconcile'
          ? (asking.done
            ? '作られていたことにします。もう一度動かしたとき、AI がまた作ることがあります。'
            : '作られていなかったことにします。もう一度動かすと、AI がもう一度作ります。')
          : retryConfirmText(placement, asking?.occ.madeBefore ?? [])}
        confirmLabel={asking?.kind === 'reconcile' ? 'はい' : 'もう一度'}
        onConfirm={confirm}
      />
    </>
  )
}
