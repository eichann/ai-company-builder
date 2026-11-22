'use client'

// 「定期の仕事」's dialogs (jobs.md "The screens"): the form that makes a version, the approval that shows
// exactly the version approved (and whether its responsible person must accept again), and an owner/admin's own
// 「受け取る」 as the responsible person — a press of its own, never part of the approval. The occurrences are
// job-occurrences.tsx. The definition is checked by the shared parser before it is sent; the server decides.
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JOB_START_PAGE, jobsApi, skillShelfApi, type JobVersionView, type JobView, type Member } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { PcJobFields } from './pc-job-fields'
import { describeJobError } from '@/lib/errors'
import {
  JOB_EXPIRY_CHOICES, JOB_HOURS, JOB_MINUTES, JOB_VERSION_HIDDEN, definitionFromForm, editableDefinition, emptyJobForm, formFromDefinition, hiddenVersion, jobProblemText,
  needsNewerScreen, switchJobForm, type JobForm,
} from '@/lib/jobs'
import { useQuery } from '@/lib/use-query'
import { JOB_NEEDS_NEWER_SCREEN, isRecordTrigger, type JobDefinition, type JobWeekday } from '../../../../shared/core/jobs'
import {
  JOB_EVENT_NOTE, jobCheckText, jobEventStateText, jobGrantLines, jobMissedText, jobPlacementText, jobRecordTriggerText, jobRunText, jobRunsText, jobTriggerText,
} from '../../../../shared/core/job-words'

const personName = (m: { name: string | null; email: string | null } | undefined) => (m ? m.name || m.email || '名前未設定' : 'もういない人')
const SELECT = 'rounded-md border bg-background px-2 py-1 text-sm'
/** The states an event job may watch for (a やること), first the one the owner chose to start with (owner decision ⑤). */
const EVENT_STATES = ['done', 'review', 'waiting', 'in_progress', 'cancelled'] as const
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
  const newestVersion = detail.data?.versions?.[0] ?? null
  const newest = editableDefinition(newestVersion)
  // A shape this console does not read: never an empty form that would write over it (the server refuses it too).
  const tooNew = needsNewerScreen(newestVersion)
  // A version hidden from this viewer (a やること or place they cannot read): shown as such, never an empty form over it.
  const hidden = hiddenVersion(newestVersion)
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
          detail.error ? <p role="alert" className="text-sm text-destructive">{describeJobError(detail.error)}</p> : <ListSkeleton rows={3} />
        ) : tooNew ? (
          <p role="note" className="text-sm">{JOB_NEEDS_NEWER_SCREEN}</p>
        ) : hidden ? (
          <p role="note" className="text-body">{JOB_VERSION_HIDDEN}</p>
        ) : (
          <JobFormFields
            key={job?.id ?? 'new'}
            initial={newest ? formFromDefinition(newest) : emptyJobForm(defaultActingUser)}
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
  const { companyId, hasCompanyFolder } = useCompany()
  // A company without the shared folder picks its Skill from the Skill shelf (the server pins its version).
  const shelf = useQuery(!hasCompanyFolder ? `skill-shelf:${companyId}` : null, () => skillShelfApi.list(companyId))
  const shelfSkills = (shelf.data?.items ?? []).filter((i) => i.kind === 'skill' && i.version !== null)
  const [f, setF] = useState<JobForm>(initial)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof JobForm>(k: K, v: JobForm[K]) => setF((prev) => ({ ...prev, [k]: v }))
  // An event job's first watched やること: the responsible person's open ones that this console's user reads (the server
  // checks again that both of them read it).
  // Searched by name and paged (a member may have many open やること).
  const [startText, setStartText] = useState('')
  const [startOffset, setStartOffset] = useState(0)
  // Another responsible person: their list starts at its first page (Codex review of #700).
  const [startFor, setStartFor] = useState(f.actingUser)
  // The chosen やること was the previous person's: never kept for the new one (Codex review of #700).
  if (startFor !== f.actingUser) { setStartFor(f.actingUser); setStartOffset(0); if (f.startRecord) set('startRecord', '') }
  const starts = useQuery(f.when === 'event' ? `job-starts:${companyId}:${f.actingUser}:${startText.trim()}:${startOffset}` : null,
    () => jobsApi.startChoices(companyId, f.actingUser, startText, startOffset))
  const startRecords = (starts.data?.records ?? []) as Array<{ id: string; title: string }>
  const startTotal = starts.data?.total ?? 0
  const expiry = JOB_EXPIRY_CHOICES.some((c) => c.minutes === f.expiresAfterMinutes)
    ? JOB_EXPIRY_CHOICES
    : [...JOB_EXPIRY_CHOICES, { minutes: f.expiresAfterMinutes, label: `${f.expiresAfterMinutes}分` }]

  const submit = async () => {
    const parsed = definitionFromForm(f, shelfSkills.find((i) => i.id === f.shelfItem)?.name)
    if (!parsed.ok) { setProblem(jobProblemText(parsed.problems)); return }
    setProblem(null)
    setBusy(true)
    try {
      await onSubmit(parsed.definition)
    } catch (err) {
      setProblem(describeJobError(err))
    } finally {
      setBusy(false)
    }
  }
  // The trigger as the approval and the app will say it, with the やること chosen by name — the name only from this
  // viewer's own list (the server's reader), never from a definition.
  const startTitle = startRecords.find((r) => r.id === f.startRecord)?.title ?? null

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
      <Row label="いつ動くか">
        <select aria-label="いつ動くか" className={SELECT} value={f.when}
          onChange={(e) => setF((prev) => switchJobForm(prev, { when: e.target.value as JobForm['when'] }))}>
          <option value="time">決まった時間に</option>
          <option value="event">見張っているやることが終わったときなどに（出来事で）</option>
        </select>
      </Row>
      {f.when === 'event' ? (
        <>
          <Row label="見張るやること（責任者が担当のもの）">
            <Input aria-label="見張るやることを名前で探す" value={startText} placeholder="名前で探す"
              onChange={(e) => { setStartText(e.target.value); setStartOffset(0) }} />
            <select aria-label="見張るやること" className={SELECT} value={f.startRecord} onChange={(e) => set('startRecord', e.target.value)}>
              <option value="">選んでください</option>
              {f.startRecord && !startRecords.some((r) => r.id === f.startRecord) && <option value={f.startRecord}>いま選ばれているやること</option>}
              {startRecords.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
            {starts.data && startRecords.length === 0 && <span className="text-muted-foreground">責任者が担当の、まだ終わっていないやることがありません（あなたが見られるもの）</span>}
            {startTotal > JOB_START_PAGE && (
              <span className="flex items-center gap-2 text-muted-foreground">
                {startTotal}件中 {startOffset + 1}〜{Math.min(startOffset + JOB_START_PAGE, startTotal)}件
                <Button type="button" variant="outline" size="sm" disabled={startOffset === 0} onClick={() => setStartOffset(Math.max(0, startOffset - JOB_START_PAGE))}>前へ</Button>
                <Button type="button" variant="outline" size="sm" disabled={startOffset + JOB_START_PAGE >= startTotal} onClick={() => setStartOffset(startOffset + JOB_START_PAGE)}>次へ</Button>
              </span>
            )}
          </Row>
          <Row label="きっかけ">
            <select aria-label="きっかけ" className={SELECT} value={f.eventTo} onChange={(e) => set('eventTo', e.target.value)}>
              {EVENT_STATES.map((s) => <option key={s} value={s}>「{jobEventStateText('task', s)}」になったとき</option>)}
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={f.followMadeTask} onChange={(e) => set('followMadeTask', e.target.checked)} />
              作ったやることも続けて見張る（終わるたびに次を作る）
            </label>
          </Row>
          {f.startRecord && (
            <p className="text-small" role="note" aria-label="きっかけの文">
              {startTitle && <>最初は「{startTitle}」を見張ります。</>}
              {f.kind === 'pc' ? '責任者の PC の AI が動く' : 'やることを作る'}のは、
              {jobRecordTriggerText({ kind: 'record', type: 'task', event: 'state', to: f.eventTo, ...(f.eventFrom ? { from: f.eventFrom } : {}), assignee: 'responsible', startRecord: f.startRecord, followMadeTask: f.followMadeTask })}
              です。
            </p>
          )}
          <Row label="1日の上限">
            <select aria-label="1日の上限" className={SELECT} value={f.limits.runsPerDay} onChange={(e) => set('limits', { ...f.limits, runsPerDay: Number(e.target.value) })}>
              {[1, 2, 3, 5, 10, 24].map((n) => <option key={n} value={n}>1日 {n}回まで</option>)}
            </select>
          </Row>
          <p className="text-xs text-muted-foreground">{JOB_EVENT_NOTE}</p>
        </>
      ) : (
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
      )}
      <Row label="すること">
        <select aria-label="すること" className={SELECT} value={f.kind}
          onChange={(e) => setF((prev) => switchJobForm(prev, { kind: e.target.value as JobForm['kind'] }))}>
          <option value="task">やることを作る（サーバーで。AI は使いません）</option>
          <option value="pc">Skill を責任者の PC の AI で動かす</option>
        </select>
      </Row>
      {f.kind === 'task' ? (
        <Row label="作るやること">
          <Input aria-label="作るやること" value={f.taskTitle} onChange={(e) => set('taskTitle', e.target.value)} placeholder="例：週の報告を書く" />
          <select aria-label="期限" className={SELECT} value={f.dueBusinessDays === null ? 'none' : String(f.dueBusinessDays)}
            onChange={(e) => set('dueBusinessDays', e.target.value === 'none' ? null : Number(e.target.value))}>
            <option value="none">期限なし</option>
            <option value="0">期限はその日</option>
            {[1, 2, 3, 5, 10, 20].map((n) => <option key={n} value={n}>期限は{n}営業日後</option>)}
          </select>
        </Row>
      ) : (
        <PcJobFields f={f} set={set} hasCompanyFolder={hasCompanyFolder} shelfSkills={shelfSkills} event={f.when === 'event'} />
      )}
      <Row label={f.when === 'event' ? (f.kind === 'pc' ? '出来事のあと、動けなかったとき（責任者のアプリが閉じていたなど）' : '出来事のあと、動けなかったとき（サーバーが止まっていたなど）') : '時間に動けなかったとき（サーバーが止まっていたなど）'}>
        {f.when === 'time' && (
        <select aria-label="動けなかったとき" className={SELECT} value={f.missedPolicy} onChange={(e) => set('missedPolicy', e.target.value as JobForm['missedPolicy'])}>
          <option value="latest_only">あとから一番新しい回だけ動かす</option>
          <option value="skip">見送る</option>
        </select>
        )}
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
      <dt className="text-muted-foreground">いつ</dt><dd>{jobTriggerText(definition.trigger)}{isRecordTrigger(definition.trigger) && <span className="block text-xs text-muted-foreground">{JOB_EVENT_NOTE}</span>}</dd>
      <dt className="text-muted-foreground">すること</dt><dd>{jobRunText(definition.run)}</dd>
      {check && (<><dt className="text-muted-foreground">確かめること</dt><dd>{check}</dd></>)}
      <dt className="text-muted-foreground">動く場所</dt><dd>{jobPlacementText(definition.placement)}</dd>
      <dt className="text-muted-foreground">できること</dt>
      <dd><ul className="list-disc pl-4">{jobGrantLines(definition.grant, definition.trigger).map((l) => <li key={l}>{l}</li>)}</ul></dd>
      <dt className="text-muted-foreground">動けないとき</dt><dd>{jobMissedText(definition.missed, definition.trigger)}</dd>
    </dl>
  )
}

/**
 * Approve the newest version, showing exactly it (sent back with its fingerprint: the server refuses another).
 * Approving is never accepting (owner decision 2026-11-18): also when the approver is the responsible person, their
 * consent to run it with their rights is its own press afterwards (`JobAcceptDialog`).
 */
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
  const definition = editableDefinition(newest)
  const tooNew = needsNewerScreen(newest)
  // Hidden from this viewer: nothing to show, no fingerprint to send — never approved from here.
  const hidden = hiddenVersion(newest)
  // The server's own rule: the newest version's consent is the accepted one (else a new 受け取る is needed).
  const mustAccept = detail.data?.latestConsentAccepted !== true
  const who = definition ? personName(members.find((m) => m.userId === definition.actingUser)) : ''
  const own = definition !== null && definition.actingUser === myUserId
  // A place outside is chosen by the responsible person in their app when accepting: never here.
  const placeOutside = definition?.grant.deliverTo !== undefined

  const approve = async () => {
    if (!newest?.fingerprint || tooNew || hidden) return
    setBusy(true)
    setProblem(null)
    try {
      const next = await jobsApi.approve(companyId, job.id, newest.version, newest.fingerprint)
      onApproved(next)
      toast.success(approvedText(newest.version, next, own ? null : who))
      onClose()
    } catch (err) {
      setProblem(describeJobError(err))
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
          detail.error ? <p role="alert" className="text-sm text-destructive">{describeJobError(detail.error)}</p> : <ListSkeleton rows={4} />
        ) : tooNew ? (
          <p role="note" className="text-sm">{JOB_NEEDS_NEWER_SCREEN}</p>
        ) : hidden ? (
          <p role="note" className="text-body">{JOB_VERSION_HIDDEN}</p>
        ) : definition ? (
          <div className="space-y-3">
            <JobVersionWords definition={definition} members={members} />
            <p className="rounded-control border border-info-border bg-info-bg px-3 py-2 text-sm text-info-text" role="note">
              {own && !mustAccept
                ? 'あなたは責任者として、この内容（だれの権限で・何を・どこで）をすでに受け取っています。承認すると、受け取り直しなしでこの版に切り替わります。'
                : own && placeOutside
                ? `あなたが責任者です。${JOB_OWN_APPROVAL_NOTE}できたものを置く先は、承認したあとにあなたのアプリの「設定」→「仕事」→「定期の仕事」で選んで受け取ってください。`
                : own
                ? `あなたが責任者です。${JOB_OWN_APPROVAL_NOTE}承認したあと、この画面の「受け取る」を押してください。`
                : mustAccept
                  ? `承認したあと、${who}さんが内容を確かめて「受け取る」を押すまで動きません（${who}さんに知らせが届きます）。`
                  : `${who}さんは、この内容（だれの権限で・何を・どこで）をすでに受け取っています。承認すると、受け取り直しなしでこの版に切り替わります。`}
            </p>
          </div>
        ) : null}
        {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void approve()} disabled={busy || !newest?.fingerprint || tooNew || hidden}>承認する</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What the approval note says when the approver is the responsible person: approving does not consent for them. */
export const JOB_OWN_APPROVAL_NOTE = '承認は、管理者として内容を認めることです。あなたの権限で動かすことへの同意（「受け取る」）は、承認とは別に押します。受け取るまで動きません。'

/**
 * The responsible person's own 「受け取る」 for an owner/admin (`you.mustAccept`): the approved version's words, then
 * one press that consents to it running with their rights — never part of an approval (owner decision 2026-11-18).
 * A job that puts into a place outside is accepted in the app, where that place is chosen; it is not offered here.
 */
export function JobAcceptDialog({ job, members, onClose, onAccepted }: {
  job: JobView
  members: Member[]
  onClose: () => void
  onAccepted: (next: JobView) => void
}) {
  const { companyId } = useCompany()
  const detail = useQuery(`job:${companyId}:${job.id}`, () => jobsApi.get(companyId, job.id))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const version = (detail.data?.versions ?? []).find((v) => v.version === job.approvedVersion) ?? null
  const definition = editableDefinition(version)
  const tooNew = needsNewerScreen(version)
  const hidden = hiddenVersion(version)
  const placeOutside = definition?.grant.deliverTo !== undefined

  const accept = async () => {
    if (!version?.fingerprint || tooNew || hidden || placeOutside) return
    setBusy(true)
    setProblem(null)
    try {
      const next = await jobsApi.accept(companyId, job.id, version.version, version.fingerprint)
      onAccepted(next)
      toast.success(acceptedText(version.version, next))
      onClose()
    } catch (err) {
      setProblem(describeJobError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{version ? `第${version.version}版を受け取りますか？` : '受け取る'}</DialogTitle>
          <DialogDescription>責任者として、この仕事をあなたの権限で動かすことに同意します。承認とは別の操作です。</DialogDescription>
        </DialogHeader>
        {!detail.data ? (
          detail.error ? <p role="alert" className="text-sm text-destructive">{describeJobError(detail.error)}</p> : <ListSkeleton rows={4} />
        ) : tooNew ? (
          <p role="note" className="text-sm">{JOB_NEEDS_NEWER_SCREEN}</p>
        ) : hidden ? (
          <p role="note" className="text-body">{JOB_VERSION_HIDDEN}</p>
        ) : definition ? (
          <div className="space-y-3">
            <JobVersionWords definition={definition} members={members} />
            <p className="rounded-control border border-info-border bg-info-bg px-3 py-2 text-sm text-info-text" role="note">
              {placeOutside
                ? 'できたものを置く先を選んで受け取るので、あなたのアプリの「設定」→「仕事」→「定期の仕事」で受け取ってください。'
                : '受け取ると、この内容のとおりにあなたの名前と権限で動きます。違うところがあれば、受け取らずに直してください。'}
            </p>
          </div>
        ) : null}
        {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button onClick={() => void accept()} disabled={busy || !version?.fingerprint || tooNew || hidden || placeOutside}>受け取る</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What the approval did, from the job as the server answered it (it may still not run: paused, stopped, a PC job).
 * `who` null: the approver is the responsible person — it waits for their own 「受け取る」.
 */
export function approvedText(version: number, after: JobView, who: string | null): string {
  if (after.waiting === 'NOT_ACCEPTED') {
    return who === null ? `第${version}版を承認しました。まだ動きません。あなたが「受け取る」を押すと動き始めます` : `第${version}版を承認しました。${who}さんの受け取りを待ちます`
  }
  return `第${version}版を承認しました。いまは「${jobRunsText(after.waiting, after.pausedReason, after.placement)}」です`
}

/** What the acceptance did, from the job as the server answered it. */
export function acceptedText(version: number, after: JobView): string {
  return `第${version}版を受け取りました。いまは「${jobRunsText(after.waiting, after.pausedReason, after.placement)}」です`
}
