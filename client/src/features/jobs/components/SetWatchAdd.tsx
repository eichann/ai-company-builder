// 「会議のあとの見張りを足す」 in Settings → 「定期の仕事」 (4b-4 PR6b, jobs.md "Member proposals" "A set watch from the app"): the
// member chooses an opened combination, the Skill it runs and the Skills it reads; the server builds the candidate, which is
// shown in the 受け取る words and sent to an owner / admin only by the member's own press. Nothing runs before their approval
// and the member's 受け取る.
import { useState } from 'react'
import { Button, Callout, Card, SubHeading } from '../../../shared/ui/primitives'
import { JOB_CANDIDATE_NOTES, type SetWatchSkill, type ShownJobCandidate } from '../../../../shared/job-proposals'
import { JOB_SET_WATCH_OPENED } from '../../../../../shared/core/jobs'
import { jobSetTriggerText, setWatchConditionLines } from '../../../../../shared/core/job-words'
import { JobWordsList } from './JobWordsList'
import { createSetWatchCandidate, discardSetWatchCandidate, getSetWatchSkills, submitSetWatchCandidate } from '../api'
import {
  setWatchChoiceOf, setWatchReadChoices, setWatchRunChoices, setWatchSkillKey, setWatchSkillLabel, toggleSetWatchRead, type SetWatchPick,
} from '../model'

type Stage = { kind: 'closed' } | { kind: 'choosing'; skills: SetWatchSkill[] | null } | { kind: 'candidate'; candidate: ShownJobCandidate }

/** The notes of a candidate, without the time job's 「新しいものが無い回は」 line (a set watch runs only when a meeting matches). */
const NOTES = [JOB_CANDIDATE_NOTES[0], JOB_CANDIDATE_NOTES[2]]

export function SetWatchAdd({ companyId, onSubmitted }: { companyId: string; onSubmitted: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'closed' })
  const [pick, setPick] = useState<SetWatchPick>({ combo: 0, run: null, reads: [] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setMessage(null)
    setError(null)
    setStage({ kind: 'choosing', skills: null })
    const r = await getSetWatchSkills(companyId)
    if (!r.success) { setError(r.error); setStage({ kind: 'closed' }); return }
    if (!r.supported) { setError('この会社のサーバーでは、まだ見張りを足せません（サーバーの更新が必要です）。'); setStage({ kind: 'closed' }); return }
    const runs = setWatchRunChoices(r.skills)
    setPick({ combo: 0, run: runs.length === 1 ? setWatchSkillKey(runs[0]) : null, reads: [] })
    setStage({ kind: 'choosing', skills: r.skills })
  }

  async function make(skills: SetWatchSkill[]) {
    const choice = setWatchChoiceOf(pick, skills)
    if (!choice) return
    setBusy(true)
    setError(null)
    try {
      const r = await createSetWatchCandidate(companyId, choice)
      if (r.success) setStage({ kind: 'candidate', candidate: r.candidate })
      else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  async function submit(candidate: ShownJobCandidate) {
    setBusy(true)
    setError(null)
    try {
      // Exactly the candidate and the fingerprint shown (the server refuses anything else).
      const r = await submitSetWatchCandidate(companyId, candidate.id, candidate.fingerprint)
      if (!r.success) { setError(r.error); return }
      setStage({ kind: 'closed' })
      setMessage('管理者に出しました。承認されたら、この画面で内容を確かめて「受け取る」を押すと動き始めます。')
      onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  async function discard(candidate: ShownJobCandidate) {
    setBusy(true)
    try {
      const r = await discardSetWatchCandidate(companyId, candidate.id)
      if (!r.success) { setError(r.error); return }
      setStage({ kind: 'closed' })
      setMessage('この案はやめました。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <SubHeading>会議のあとの見張りを足す</SubHeading>
      <p className="text-body text-text-muted">
        条件に合う会議のあと、あなたの PC の AI が部署の Skill で下書きを作ります。管理者が承認し、あなたが「受け取る」を押すまでは動きません。
      </p>
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
      {message && <p role="status" className="text-small text-text-muted">{message}</p>}
      {stage.kind === 'closed' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void open()}>見張りを足す</Button>
      )}
      {stage.kind === 'choosing' && stage.skills === null && <p className="text-body text-text-muted">読み込み中…</p>}
      {stage.kind === 'choosing' && stage.skills !== null && (
        <Choosing
          skills={stage.skills} pick={pick} busy={busy} onPick={setPick}
          onMake={() => void make(stage.skills ?? [])} onCancel={() => setStage({ kind: 'closed' })}
        />
      )}
      {stage.kind === 'candidate' && (
        <div className="space-y-3">
          <JobWordsList definition={stage.candidate.definition} label="見張りの案" />
          <ul className="space-y-1 text-small text-text-muted">{NOTES.map(n => <li key={n}>{n}</li>)}</ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit(stage.candidate)}>これで管理者に出す</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard(stage.candidate)}>やめる</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function Choosing({ skills, pick, busy, onPick, onMake, onCancel }: {
  skills: SetWatchSkill[]; pick: SetWatchPick; busy: boolean; onPick: (p: SetWatchPick) => void; onMake: () => void; onCancel: () => void
}) {
  const runs = setWatchRunChoices(skills)
  const reads = setWatchReadChoices(skills, pick.run)
  const ready = setWatchChoiceOf(pick, skills) !== null
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-body font-strong text-text">いつ動くか</legend>
        {JOB_SET_WATCH_OPENED.map((t, i) => (
          <label key={i} className="flex items-start gap-2 text-body text-text">
            <input type="radio" name="set-watch-combo" className="mt-1" checked={pick.combo === i} onChange={() => onPick({ ...pick, combo: i })} />
            <span>
              {jobSetTriggerText(t)}
              <span className="block text-small text-text-muted">{setWatchConditionLines(t).join('／')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-body font-strong text-text">動かす Skill</legend>
        {runs.length === 0 ? (
          <p className="text-body text-text-muted">
            動かせる Skill がありません。AI が判断の理由を選ぶ一覧（decision.json）がある部署の Skill だけを選べます。Skill を直せる人に頼んでください。
          </p>
        ) : runs.map(s => (
          <label key={setWatchSkillKey(s)} className="flex items-center gap-2 text-body text-text">
            <input
              type="radio" name="set-watch-run" checked={pick.run === setWatchSkillKey(s)}
              onChange={() => onPick({ ...pick, run: setWatchSkillKey(s), reads: pick.reads.filter(k => k !== setWatchSkillKey(s)) })}
            />
            {setWatchSkillLabel(s)}
          </label>
        ))}
      </fieldset>
      {reads.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-body font-strong text-text">AI が読んでよい Skill（4つまで。なくてもかまいません）</legend>
          {reads.map(s => (
            <label key={setWatchSkillKey(s)} className="flex items-center gap-2 text-body text-text">
              <input type="checkbox" checked={pick.reads.includes(setWatchSkillKey(s))} onChange={() => onPick(toggleSetWatchRead(pick, setWatchSkillKey(s)))} />
              {setWatchSkillLabel(s)}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-small text-text-muted">
        できたものは、あなたの PC の「{pick.run ? pick.run.split('/')[0] : '動かす Skill の部署'}」の中の、あなただけのフォルダ（.personal/提案書 の中に、会議ごとに「日付_会社名」のフォルダ）にだけ置かれます（同期されません）。1回30分・1日10回までです。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy || !ready} onClick={onMake}>案を作る</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>閉じる</Button>
      </div>
    </div>
  )
}
