'use client'

// A set watch's choices in 「定期の仕事」's form (jobs.md "The set watch (schema 5)", 4b-4 PR7), beside job-dialogs.tsx:
// one of the opened combinations — never words of the admin's own —, the department Skill it runs and the Skills it reads,
// the places it reads and writes, and its limits. Each is a plain choice; the shared parser and the server decide (the
// server pins the Skills at their trees and copies the reasons from the Skill's decision.json when the version is made).
import type { ReactNode } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { departmentsApi } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import {
  PC_JOB_MINUTES, SET_WATCH_DAY_LIMITS, type JobForm,
} from '@/lib/jobs'
import { useQuery } from '@/lib/use-query'
import { JOB_READ_SKILLS_MAX, JOB_SET_WATCH_OPENED } from '../../../../shared/core/jobs'
import { SET_WATCH_NOT_RUN_NOTE, SET_WATCH_SEEN_NOTE, jobCheckText, jobSetTriggerText, setWatchConditionLines } from '../../../../shared/core/job-words'
import { isValidFolderName } from '../../../../shared/core/names'

const SELECT = 'rounded-control border bg-background px-2 py-1 text-body'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2 text-body">{children}</div>
    </div>
  )
}

export function SetWatchFields({ f, set }: {
  f: JobForm
  set: <K extends keyof JobForm>(k: K, v: JobForm[K]) => void
}) {
  const { companyId } = useCompany()
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  // A department's own folder (a root folder): where its Skills live (`<folder>/.claude/skills/<name>`).
  const folders = [...new Set((departments.data ?? []).map((d) => d.folder).filter((x) => isValidFolderName(x)))]
  const combo = JOB_SET_WATCH_OPENED[f.setCombo]
  return (
    <>
      <Row label="どれで動くか（使えるようになっている条件から選びます）">
        <select aria-label="条件" className={SELECT} value={f.setCombo} onChange={(e) => set('setCombo', Number(e.target.value))}>
          {JOB_SET_WATCH_OPENED.map((t, i) => <option key={i} value={i}>{jobSetTriggerText(t)}</option>)}
        </select>
      </Row>
      {combo && (
        <div className="space-y-1" role="note" aria-label="条件の中身">
          <ul className="list-disc space-y-0.5 pl-4 text-small">
            {setWatchConditionLines(combo).map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="text-small text-muted-foreground">{SET_WATCH_NOT_RUN_NOTE}</p>
        </div>
      )}
      <Row label="手順にする Skill（部署の Skill）">
        <select aria-label="Skill の部署" className={SELECT} value={f.skillPlace} onChange={(e) => set('skillPlace', e.target.value)}>
          <option value="">部署を選んでください</option>
          {f.skillPlace && !folders.includes(f.skillPlace) && <option value={f.skillPlace}>{f.skillPlace}</option>}
          {folders.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <Input aria-label="Skill" value={f.skillName} onChange={(e) => set('skillName', e.target.value)} placeholder="Skill のフォルダ名（例：proposal-draft）" />
      </Row>
      <p className="text-small text-muted-foreground">
        保存するとき、サーバーがこの Skill の今の版と、判断の理由の一覧（Skill のフォルダの decision.json）を読んで決めます。Skill を直したら、新しい版の承認と受け取りが要ります。
      </p>
      <Row label={`ほかに読む Skill（1行に1つ、${JOB_READ_SKILLS_MAX}つまで。ほかの部署なら「部署のフォルダ/Skill」）`}>
        <textarea aria-label="読む Skill" className="min-h-16 w-full rounded-control border bg-background px-2 py-1 text-body" value={f.readSkills} onChange={(e) => set('readSkills', e.target.value)} />
      </Row>
      <p className="text-small text-muted-foreground">{jobCheckText({ kind: 'matched_record' })}</p>
      <Row label="読んでよい場所（1行に1つ）">
        <textarea aria-label="読んでよい場所" className="min-h-16 w-full rounded-control border bg-background px-2 py-1 text-body" value={f.readPaths} onChange={(e) => set('readPaths', e.target.value)} />
      </Row>
      <Row label="作ったファイルの置き場所（責任者だけのフォルダ。空なら保存しない）">
        <Input aria-label="置き場所の場所" value={f.writePlace} onChange={(e) => set('writePlace', e.target.value)} placeholder="例：営業部" />
        <Input aria-label="置き場所のフォルダ名" value={f.writeFolder} onChange={(e) => set('writeFolder', e.target.value)} placeholder="例：提案書" />
      </Row>
      <Row label="上限">
        <select aria-label="1回の上限" className={SELECT} value={f.limits.minutes} onChange={(e) => set('limits', { ...f.limits, minutes: Number(e.target.value) })}>
          {[...new Set([...PC_JOB_MINUTES, f.limits.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>1回 {m}分</option>)}
        </select>
        <select aria-label="1日の上限" className={SELECT} value={f.limits.runsPerDay} onChange={(e) => set('limits', { ...f.limits, runsPerDay: Number(e.target.value) })}>
          {[...new Set([...SET_WATCH_DAY_LIMITS, f.limits.runsPerDay])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>1日 {n}回まで</option>)}
        </select>
      </Row>
      <ul className="list-disc space-y-0.5 pl-4 text-small text-muted-foreground">
        <li>AI が読める議事録は、動くきっかけになった会議のものだけです。メールの下書きや、外に置くことはしません。</li>
        <li>この形の仕事は、責任者1人に1つだけです（同じ人に2つ目は承認できません）。</li>
        <li>終わると、責任者だけに見えるやることが1つできます。責任者のアプリが開いていて「自動で進める」が入っているときに動きます。</li>
        <li>{SET_WATCH_SEEN_NOTE}</li>
      </ul>
    </>
  )
}
