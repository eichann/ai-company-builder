'use client'

// 「定期の仕事」's dialogs (jobs.md "The screens"): the form that makes a version, the approval that shows
// exactly the version approved (and whether its responsible person must accept again), and a job's
// occurrences. The definition is checked by the shared parser before it is sent; the server decides.
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { jobsApi, type JobVersionView, type JobView, type Member } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import {
  JOB_EXPIRY_CHOICES, JOB_HOURS, JOB_MINUTES, definitionFromForm, emptyJobForm, formFromDefinition, jobProblemText, type JobForm,
} from '@/lib/jobs'
import { useQuery } from '@/lib/use-query'
import type { JobDefinition, JobWeekday } from '../../../../shared/core/jobs'
import {
  jobCheckText, jobGrantLines, jobMissedText, jobOccurrenceText, jobPlacementText, jobRunText, jobRunsText, jobSlotText, jobTriggerText,
} from '../../../../shared/core/job-words'

const personName = (m: { name: string | null; email: string | null } | undefined) => (m ? m.name || m.email || '名前未設定' : 'もういない人')
const SELECT = 'rounded-md border bg-background px-2 py-1 text-sm'
const WEEKDAYS: Array<[JobWeekday, string]> = [['mon', '月曜'], ['tue', '火曜'], ['wed', '水曜'], ['thu', '木曜'], ['fri', '金曜'], ['sat', '土曜'], ['sun', '日曜']]

/** Make a job (`job` null) or a new version of it. */
export function JobFormDialog({ job, members, defaultActingUser, onClose, onSaved }: {
  job: JobView | null
  members: Member[]
  defaultActingUser: string
  onClose: () => void
  onSaved: () => void
}) {
  const { companyId } = useCompany()
  const detail = useQuery(job ? `job:${companyId}:${job.id}` : null, () => jobsApi.get(companyId, job!.id))
  const newest = detail.data?.versions?.[0]?.definition ?? null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{job ? `「${job.name}」を直す` : '定期の仕事を作る'}</DialogTitle>
          <DialogDescription>
            {job ? '直すと新しい版になります。承認するまでは、いまの版のとおりに動きます。' : '作ったあと、承認と責任者の受け取りが済むと動き始めます。'}
          </DialogDescription>
        </DialogHeader>
        {job && !detail.data ? (
          detail.error ? <p role="alert" className="text-sm text-destructive">{describeError(detail.error)}</p> : <ListSkeleton rows={3} />
        ) : job && newest && !formFromDefinition(newest) ? (
          <p className="text-sm text-muted-foreground">責任者の PC で動く手順の仕事は、この画面ではまだ直せません。</p>
        ) : (
          <JobFormFields
            key={job?.id ?? 'new'}
            initial={newest ? (formFromDefinition(newest) as JobForm) : emptyJobForm(defaultActingUser)}
            members={members}
            onCancel={onClose}
            onSubmit={async (definition) => {
              if (job) {
                const saved = await jobsApi.update(companyId, job.id, definition)
                toast.success(saved.changed ? `第${saved.latestVersion}版を作りました。承認すると、この版で動きます` : '変わったところはありません')
              } else {
                await jobsApi.create(companyId, definition)
                toast.success('作りました。「承認する」から承認してください')
              }
              onSaved()
              onClose()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  )
}

function JobFormFields({ initial, members, onCancel, onSubmit }: {
  initial: JobForm
  members: Member[]
  onCancel: () => void
  onSubmit: (definition: JobDefinition) => Promise<void>
}) {
  const [f, setF] = useState<JobForm>(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof JobForm>(k: K, v: JobForm[K]) => setF((prev) => ({ ...prev, [k]: v }))
  const expiry = JOB_EXPIRY_CHOICES.some((c) => c.minutes === f.expiresAfterMinutes)
    ? JOB_EXPIRY_CHOICES
    : [...JOB_EXPIRY_CHOICES, { minutes: f.expiresAfterMinutes, label: `${f.expiresAfterMinutes}分` }]

  const submit = async () => {
    const parsed = definitionFromForm(f)
    if (!parsed.ok) { setProblem(jobProblemText(parsed.problems)); return }
    setProblem(null)
    setBusy(true)
    try {
      await onSubmit(parsed.definition)
    } catch (err) {
      setProblem(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <Row label="名前">
        <Input aria-label="名前" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例：週の報告" />
      </Row>
      <Row label="責任者（この人のやることを作ります）">
        <select aria-label="責任者" className={SELECT} value={f.actingUser} onChange={(e) => set('actingUser', e.target.value)}>
          {!members.some((m) => m.userId === f.actingUser) && <option value={f.actingUser}>もういない人</option>}
          {members.map((m) => <option key={m.userId} value={m.userId}>{personName(m)}</option>)}
        </select>
      </Row>
      <Row label="いつ">
        <select aria-label="くり返し" className={SELECT} value={f.every} onChange={(e) => set('every', e.target.value as JobForm['every'])}>
          <option value="day">毎日</option>
          <option value="week">毎週</option>
          <option value="month">毎月</option>
        </select>
        {f.every === 'day' && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={f.businessDaysOnly} onChange={(e) => set('businessDaysOnly', e.target.checked)} />
            営業日だけ
          </label>
        )}
        {f.every === 'week' && (
          <>
            <select aria-label="曜日" className={SELECT} value={f.weekday} onChange={(e) => set('weekday', e.target.value as JobWeekday)}>
              {WEEKDAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select aria-label="何営業日前" className={SELECT} value={f.businessDaysBefore} onChange={(e) => set('businessDaysBefore', Number(e.target.value))}>
              <option value={0}>当日</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}営業日前</option>)}
            </select>
          </>
        )}
        {f.every === 'month' && (
          <>
            <select aria-label="日" className={SELECT} value={String(f.monthDay)} onChange={(e) => set('monthDay', e.target.value === 'last' ? 'last' : Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}日</option>)}
              <option value="last">末日</option>
            </select>
            <select aria-label="休みの日なら" className={SELECT} value={f.ifHoliday} onChange={(e) => set('ifHoliday', e.target.value as JobForm['ifHoliday'])}>
              <option value="before">休みの日なら前の営業日</option>
              <option value="after">休みの日なら次の営業日</option>
              <option value="as_is">休みの日もその日</option>
            </select>
          </>
        )}
        <select aria-label="時" className={SELECT} value={f.hour} onChange={(e) => set('hour', e.target.value)}>
          {JOB_HOURS.map((h) => <option key={h} value={h}>{h}時</option>)}
        </select>
        <select aria-label="分" className={SELECT} value={f.minute} onChange={(e) => set('minute', e.target.value)}>
          {JOB_MINUTES.map((m) => <option key={m} value={m}>{m}分</option>)}
        </select>
      </Row>
      <Row label="作るやること">
        <Input aria-label="作るやること" value={f.taskTitle} onChange={(e) => set('taskTitle', e.target.value)} placeholder="例：週の報告を書く" />
        <select aria-label="期限" className={SELECT} value={f.dueBusinessDays === null ? 'none' : String(f.dueBusinessDays)}
          onChange={(e) => set('dueBusinessDays', e.target.value === 'none' ? null : Number(e.target.value))}>
          <option value="none">期限なし</option>
          <option value="0">期限はその日</option>
          {[1, 2, 3, 5, 10, 20].map((n) => <option key={n} value={n}>期限は{n}営業日後</option>)}
        </select>
      </Row>
      <Row label="時間に動けなかったとき（サーバーが止まっていたなど）">
        <select aria-label="動けなかったとき" className={SELECT} value={f.missedPolicy} onChange={(e) => set('missedPolicy', e.target.value as JobForm['missedPolicy'])}>
          <option value="latest_only">あとから一番新しい回だけ動かす</option>
          <option value="skip">見送る</option>
        </select>
        <select aria-label="期限切れまで" className={SELECT} value={f.expiresAfterMinutes} onChange={(e) => set('expiresAfterMinutes', Number(e.target.value))}>
          {expiry.map((c) => <option key={c.minutes} value={c.minutes}>{c.label}で期限切れ</option>)}
        </select>
      </Row>
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>キャンセル</Button>
        <Button type="submit" disabled={busy}>保存</Button>
      </DialogFooter>
    </form>
  )
}

/** The sentences of a version, as the approver and the responsible person read them. */
export function JobVersionWords({ definition, members }: { definition: JobDefinition; members: Member[] }) {
  const who = members.find((m) => m.userId === definition.actingUser)
  const check = jobCheckText(definition.check)
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">名前</dt><dd>{definition.name}</dd>
      <dt className="text-muted-foreground">責任者</dt><dd>{personName(who)}（この人の権限で動きます）</dd>
      <dt className="text-muted-foreground">いつ</dt><dd>{jobTriggerText(definition.trigger)}</dd>
      <dt className="text-muted-foreground">すること</dt><dd>{jobRunText(definition.run)}</dd>
      {check && (<><dt className="text-muted-foreground">確かめること</dt><dd>{check}</dd></>)}
      <dt className="text-muted-foreground">動く場所</dt><dd>{jobPlacementText(definition.placement)}</dd>
      <dt className="text-muted-foreground">できること</dt>
      <dd><ul className="list-disc pl-4">{jobGrantLines(definition.grant).map((l) => <li key={l}>{l}</li>)}</ul></dd>
      <dt className="text-muted-foreground">動けないとき</dt><dd>{jobMissedText(definition.missed)}</dd>
    </dl>
  )
}

/** Approve the newest version, showing exactly it (sent back with its fingerprint: the server refuses another). */
export function JobApproveDialog({ job, members, myUserId, onClose, onApproved }: {
  job: JobView
  members: Member[]
  myUserId: string | null
  onClose: () => void
  onApproved: (next: JobView) => void
}) {
  const { companyId } = useCompany()
  const detail = useQuery(`job:${companyId}:${job.id}`, () => jobsApi.get(companyId, job.id))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const versions: JobVersionView[] = detail.data?.versions ?? []
  const newest = versions[0] ?? null
  const definition = newest?.definition ?? null
  // The server's own rule: the newest version's consent is the accepted one (else a new 受け取る is needed).
  const mustAccept = detail.data?.latestConsentAccepted !== true
  const who = definition ? personName(members.find((m) => m.userId === definition.actingUser)) : ''
  const own = definition !== null && definition.actingUser === myUserId

  const approve = async () => {
    if (!newest?.fingerprint) return
    setBusy(true)
    setProblem(null)
    try {
      let next = await jobsApi.approve(companyId, job.id, newest.version, newest.fingerprint)
      onApproved(next)
      // Their own job: the approver accepts it in their own name with the same press (the note says so).
      if (own && mustAccept) {
        try {
          next = await jobsApi.accept(companyId, job.id, newest.version, newest.fingerprint)
          onApproved(next)
        } catch (err) {
          toast.error('承認しましたが、受け取れませんでした', { description: describeError(err) })
          onClose()
          return
        }
      }
      toast.success(approvedText(newest.version, next, who))
      onClose()
    } catch (err) {
      setProblem(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{newest ? `第${newest.version}版を承認しますか？` : '承認'}</DialogTitle>
          <DialogDescription>承認するのは、下の内容そのものです。あとで直しても、承認した版は変わりません。</DialogDescription>
        </DialogHeader>
        {!detail.data ? (
          detail.error ? <p role="alert" className="text-sm text-destructive">{describeError(detail.error)}</p> : <ListSkeleton rows={4} />
        ) : definition ? (
          <div className="space-y-3">
            <JobVersionWords definition={definition} members={members} />
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" role="note">
              {own
                ? 'あなたが責任者です。承認すると、あなたの名前で受け取ったことにもなります。'
                : mustAccept
                  ? `承認したあと、${who}さんが内容を確かめて「受け取る」を押すまで動きません（${who}さんに知らせが届きます）。`
                  : `${who}さんは、この内容（だれの権限で・何を・どこで）をすでに受け取っています。承認すると、受け取り直しなしでこの版に切り替わります。`}
            </p>
          </div>
        ) : null}
        {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void approve()} disabled={busy || !newest?.fingerprint}>承認する</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What the approval did, from the job as the server answered it (it may still not run: paused, stopped, a PC job). */
export function approvedText(version: number, after: JobView, who: string): string {
  if (after.waiting === 'NOT_ACCEPTED') return `第${version}版を承認しました。${who}さんの受け取りを待ちます`
  return `第${version}版を承認しました。いまは「${jobRunsText(after.waiting, after.pausedReason, after.placement)}」です`
}

/** A job's occurrences (newest first): when, what became of it and why, in plain words. */
export function JobOccurrences({ jobId }: { jobId: string }) {
  const { companyId } = useCompany()
  const list = useQuery(`job-occurrences:${companyId}:${jobId}`, () => jobsApi.occurrences(companyId, jobId))
  if (list.error && !list.data) return <p role="alert" className="text-sm text-destructive">{describeError(list.error)}</p>
  if (!list.data) return <ListSkeleton rows={2} />
  if (list.data.occurrences.length === 0) return <p className="text-sm text-muted-foreground">まだ回がありません。</p>
  return (
    <ul aria-label="回の記録" className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      {list.data.occurrences.map((o) => {
        const words = jobOccurrenceText(o.state, o.outcomeCode)
        return (
          <li key={o.id} className="flex flex-wrap gap-x-3">
            <span className="tabular-nums">{jobSlotText(o.dueSlot)}</span>
            <span className="font-medium">{words.label}</span>
            {words.why && <span className="text-muted-foreground">{words.why}</span>}
            <span className="text-xs text-muted-foreground">第{o.jobVersion}版</span>
          </li>
        )
      })}
    </ul>
  )
}
