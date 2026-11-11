'use client'

// A PC job's choices in 「定期の仕事」's form (jobs.md "The screens", B PR 5a-2), beside job-dialogs.tsx.
import type { ReactNode } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DELIVERY_PLACE_CHOICES, PC_JOB_MINUTES, type JobForm } from '@/lib/jobs'

const SELECT = 'rounded-md border bg-background px-2 py-1 text-sm'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  )
}

/**
 * A PC job's choices (jobs.md "The screens"): the Skill, what is checked before the AI runs, and what it may
 * read, write and draft. Each is a plain choice; the shared parser and the server decide.
 */
export function PcJobFields({ f, set, hasCompanyFolder, shelfSkills }: {
  f: JobForm
  set: <K extends keyof JobForm>(k: K, v: JobForm[K]) => void
  hasCompanyFolder: boolean
  shelfSkills: Array<{ id: string; name: string; department: { name: string } | null }>
}) {
  return (
    <>
      <Row label="手順にする Skill">
        {hasCompanyFolder ? (
          <Input aria-label="Skill" value={f.skillName} onChange={(e) => set('skillName', e.target.value)} placeholder="会社の Skill のフォルダ名（例：weekly-report）" />
        ) : (
          <select aria-label="Skill" className={SELECT} value={f.shelfItem} onChange={(e) => set('shelfItem', e.target.value)}>
            <option value="">選んでください</option>
            {shelfSkills.map((s) => <option key={s.id} value={s.id}>{s.name}{s.department ? `（${s.department.name}）` : '（全社）'}</option>)}
          </select>
        )}
      </Row>
      <Row label="AI を動かす前に確かめること">
        <select aria-label="確かめること" className={SELECT} value={f.checkKind} onChange={(e) => set('checkKind', e.target.value as JobForm['checkKind'])}>
          <option value="new_files">決めた場所に新しいファイルがあるか</option>
          <option value="new_meetings">責任者が出た会議があったか</option>
        </select>
        {f.checkKind === 'new_files' ? (
          <Input aria-label="確かめる場所" value={f.checkPath} onChange={(e) => set('checkPath', e.target.value)} placeholder="例：人事部/面談" />
        ) : (
          <Input aria-label="会議の名前に含む言葉" value={f.titleWords} onChange={(e) => set('titleWords', e.target.value)} placeholder="例：面談、1on1（空ならすべての会議）" />
        )}
      </Row>
      {f.checkKind === 'new_meetings' && (
        <p className="text-xs text-muted-foreground">AI が読めるのは、前の回のあとに責任者が出た会議（言葉を入れたときは名前にその言葉を含むもの）の議事録だけです。</p>
      )}
      <Row label="ほかに読んでよい場所（1行に1つ）">
        <textarea aria-label="読んでよい場所" className="min-h-16 w-full rounded-md border bg-background px-2 py-1 text-sm" value={f.readPaths} onChange={(e) => set('readPaths', e.target.value)} />
      </Row>
      <Row label="できること">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={f.readRecords} onChange={(e) => set('readRecords', e.target.checked)} />
          責任者のやることや記録を読む
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={f.mailDrafts} onChange={(e) => set('mailDrafts', e.target.checked)} />
          メールの下書きを作る（送るのは人）
        </label>
      </Row>
      <Row label="作ったファイルの置き場所（責任者だけのフォルダ。空なら保存しない）">
        <Input aria-label="置き場所の場所" value={f.writePlace} onChange={(e) => set('writePlace', e.target.value)} placeholder="例：人事部" />
        <Input aria-label="置き場所のフォルダ名" value={f.writeFolder} onChange={(e) => set('writeFolder', e.target.value)} placeholder="例：interview-reports" />
      </Row>
      <Row label="できたものを外にも置く">
        <select aria-label="できたものを置く先" className={SELECT} value={f.deliverTo} onChange={(e) => set('deliverTo', e.target.value)}>
          <option value="">置かない</option>
          {DELIVERY_PLACE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </Row>
      {f.deliverTo && (
        <p className="text-xs text-muted-foreground">
          置き先は、責任者が「受け取る」ときに自分で選びます（その人が選んだ1か所だけに置けます。社外の人も見られる場所には置きません）。{DELIVERY_PLACE_CHOICES.find((c) => c.value === f.deliverTo)?.lapseNote ?? ''}
        </p>
      )}
      <Row label="1回の上限">
        <select aria-label="1回の上限" className={SELECT} value={f.limits.minutes} onChange={(e) => set('limits', { ...f.limits, minutes: Number(e.target.value) })}>
          {[...new Set([...PC_JOB_MINUTES, f.limits.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m}分</option>)}
        </select>
      </Row>
      <p className="text-xs text-muted-foreground">終わると、責任者だけに見えるやることが1つできます。責任者のアプリが開いていて「自動で進める」が入っているときに動きます。</p>
    </>
  )
}
