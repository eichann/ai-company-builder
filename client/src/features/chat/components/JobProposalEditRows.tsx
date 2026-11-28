import { useState, type ReactNode } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { isJobCandidatePlace, type JobCandidateInput } from '../../../../../shared/core/job-proposals'
import type { JobWeekday } from '../../../../../shared/core/jobs'
import { jobMinutesText } from '../../../../../shared/core/job-words'
import { jobTimeZoneText } from '../../../../shared/job-proposals'
import {
  CHECK_KIND_CHOICES, DAY_KIND_CHOICES, EVERY_CHOICES, MAIL_CHOICES, MISSED_CHOICES, MONTH_DAY_CHOICES, NO_DELIVERABLE, RECORDS_CHOICES,
  WEEKDAY_CHOICES, atChoices, minutesChoices, placeChoices, skillChoices, triggerWithEvery, type EditChoice,
} from '../jobProposalEdit'
import type { JobProposalChoices } from '../hooks/useJobProposalChoices'

const VALUE = 'rounded-small border-b border-dashed border-border-strong font-strong text-text hover:border-link hover:text-link disabled:opacity-disabled disabled:hover:border-border-strong disabled:hover:text-text'
const SELECT = 'h-control rounded-control border border-border-control bg-surface px-1.5 text-small text-text focus:outline-none focus:ring-focus focus:ring-focus-ring'

/**
 * One value of the card the member changes in place (「その場で直す」, edit-in-place): pressed, it becomes the list right there,
 * and a choice is the change. Nothing is typed; the list is the card's.
 */
function InlineChoice({ label, value, shown, choices, disabled, onOpen, onChoose }: {
  label: string; value: string; shown: ReactNode; choices: readonly EditChoice[] | 'loading'; disabled: boolean
  onOpen?: () => void; onChoose: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (open && !disabled) {
    return (
      <select aria-label={label} className={SELECT} autoFocus value={value} onBlur={() => setOpen(false)}
        onChange={e => { setOpen(false); if (e.target.value !== value) onChoose(e.target.value) }}>
        {choices === 'loading'
          ? <><option value={value}>{typeof shown === 'string' ? shown : value}</option><option disabled value="__loading">読み込んでいます…</option></>
          : choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    )
  }
  return <button type="button" className={VALUE} disabled={disabled} aria-label={`${label}を直す`} onClick={() => { onOpen?.(); setOpen(true) }}>{shown}</button>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border-control py-1.5 last:border-b-0">
      <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-text">{children}</dd>
    </div>
  )
}

interface Props {
  input: JobCandidateInput
  /** A company without the shared folder pins a shelf Skill: not offered to change here. */
  skillChangeable: boolean
  timeZone: string | null
  disabled: boolean
  choices: JobProposalChoices | 'loading' | null
  onLoadChoices: () => void
  onChange: (next: JobCandidateInput) => void
}

/** The candidate's values as rows, each changed in place; the card sends the whole input (the server checks it). */
export function JobProposalEditRows({ input, skillChangeable, timeZone, disabled, choices, onLoadChoices, onChange }: Props) {
  const t = input.trigger
  const set = (patch: Partial<JobCandidateInput>) => onChange({ ...input, ...patch })
  const known = choices && choices !== 'loading' ? choices.places : []
  const current = [...input.reads, ...(input.check.kind === 'new_files' ? [input.check.path] : []), ...(input.deliverable ? [input.deliverable] : [])]
  const places = (keep: string | null): readonly EditChoice[] | 'loading' => choices === 'loading' || choices === null ? 'loading'
    : placeChoices(known, keep ? [keep, ...current] : current).map(p => ({ value: p, label: p }))
  const zone = jobTimeZoneText(timeZone)
  const common = { disabled, onOpen: onLoadChoices }

  return (
    <dl aria-label="案の内容" className="mt-2 text-small">
      <Row label="いつ確かめるか">
        <InlineChoice label="いつ" value={t.every} shown={EVERY_CHOICES.find(c => c.value === t.every)!.label} choices={EVERY_CHOICES} disabled={disabled}
          onChoose={v => set({ trigger: triggerWithEvery(t, v) })} />
        {t.every === 'week' && <InlineChoice label="曜日" value={t.weekday} shown={WEEKDAY_CHOICES.find(c => c.value === t.weekday)!.label} choices={WEEKDAY_CHOICES} disabled={disabled}
          onChoose={v => set({ trigger: { ...t, weekday: v as JobWeekday } })} />}
        {t.every === 'week' && t.businessDaysBefore > 0 && <span>の{t.businessDaysBefore}営業日前</span>}
        {t.every === 'month' && <InlineChoice label="日" value={String(t.day)} shown={t.day === 'last' ? '末日' : `${t.day}日`} choices={MONTH_DAY_CHOICES} disabled={disabled}
          onChoose={v => set({ trigger: { ...t, day: v === 'last' ? 'last' : Number(v) } })} />}
        {t.every === 'day' && <InlineChoice label="営業日だけか" value={t.businessDaysOnly ? 'business' : 'all'} shown={t.businessDaysOnly ? '営業日だけ' : '休みの日も'} choices={DAY_KIND_CHOICES} disabled={disabled}
          onChoose={v => set({ trigger: { ...t, businessDaysOnly: v === 'business' } })} />}
        <InlineChoice label="時刻" value={t.at} shown={t.at} choices={atChoices(t.at)} disabled={disabled} onChoose={v => set({ trigger: { ...t, at: v } })} />
        <span className="text-text-muted">（{zone ?? '会社の時刻'}）</span>
      </Row>
      <Row label="何があったら動くか">
        {input.check.kind === 'new_files' ? (
          <span>「<InlineChoice label="確かめる場所" value={input.check.path} shown={input.check.path} choices={places(input.check.path)} {...common}
            onChoose={v => set({ check: { kind: 'new_files', path: v } })} />」に新しいファイルがあるときだけ</span>
        ) : <span>前の回のあとに、あなたが出た会議があるときだけ</span>}
        <InlineChoice label="何で確かめるか" value={input.check.kind} shown={input.check.kind === 'new_files' ? '（ファイルで）' : '（会議で）'}
          // Files need a place: the first the candidate already reads, else the first offered (then changed in place as any).
          choices={current.length > 0 || known.length > 0 ? CHECK_KIND_CHOICES : CHECK_KIND_CHOICES.filter(c => c.value === input.check.kind)}
          {...common} onChoose={v => {
            const path = current[0] ?? known.find(isJobCandidatePlace)
            if (v === 'new_meetings') set({ check: { kind: 'new_meetings' } })
            else if (path) set({ check: { kind: 'new_files', path } })
          }} />
      </Row>
      <Row label="すること">
        <span>会社の Skill「{skillChangeable
          ? <InlineChoice label="Skill" value={input.skill} shown={input.skill} {...common}
            choices={choices === 'loading' || choices === null ? 'loading' : skillChoices(choices.skills, input.skill).map(s => ({ value: s, label: s }))}
            onChoose={v => set({ skill: v })} />
          : <span className="font-strong">{input.skill}</span>}」を、あなたの PC の AI が動かします（責任者はあなたです）</span>
      </Row>
      <Row label="読む場所">
        {input.reads.map(r => (
          <span key={r} className="inline-flex items-center gap-0.5 rounded-control border border-border-control bg-surface-raised px-1.5">
            {r}
            <button type="button" aria-label={`「${r}」を外す`} disabled={disabled} className="text-text-muted hover:text-text disabled:opacity-disabled"
              onClick={() => set({ reads: input.reads.filter(x => x !== r) })}><X size={11} aria-hidden /></button>
          </span>
        ))}
        {input.reads.length === 0 && <span className="text-text-muted">なし</span>}
        {input.reads.length < 10 && (
          <InlineChoice label="足す読む場所" value="" shown={<span className="inline-flex items-center gap-0.5 font-normal text-link"><Plus size={11} aria-hidden />足す</span>} {...common}
            choices={(() => { const p = places(null); return p === 'loading' ? p : [{ value: '', label: '選んでください' }, ...p.filter(c => !input.reads.includes(c.value) && !(input.check.kind === 'new_files' && input.check.path === c.value))] })()}
            onChoose={v => { if (v) set({ reads: [...input.reads, v] }) }} />
        )}
      </Row>
      <Row label="置く場所">
        <InlineChoice label="置く場所" value={input.deliverable ?? NO_DELIVERABLE} shown={input.deliverable ?? '置かない'} {...common}
          choices={(() => { const p = places(input.deliverable); return p === 'loading' ? p : [{ value: NO_DELIVERABLE, label: '置かない' }, ...p] })()}
          onChoose={v => set({ deliverable: v === NO_DELIVERABLE ? null : v })} />
        {input.deliverable && <span>の中の、あなただけのフォルダ</span>}
      </Row>
      <Row label="やることや記録">
        <InlineChoice label="やることや記録を読むか" value={input.readRecords ? 'yes' : 'no'} shown={input.readRecords ? '読む' : '読まない'} choices={RECORDS_CHOICES} disabled={disabled}
          onChoose={v => set({ readRecords: v === 'yes' })} />
      </Row>
      <Row label="メール">
        <InlineChoice label="メール" value={input.mailDrafts ? 'yes' : 'no'} shown={input.mailDrafts ? '下書きまで作る（送るのは人）' : '作らない'} choices={MAIL_CHOICES} disabled={disabled}
          onChoose={v => set({ mailDrafts: v === 'yes' })} />
      </Row>
      <Row label="上限">
        1回<InlineChoice label="1回の時間" value={String(input.minutes)} shown={jobMinutesText(input.minutes)} choices={minutesChoices(input.minutes)} disabled={disabled}
          onChoose={v => set({ minutes: Number(v) })} />・1日 1回
      </Row>
      <Row label="動けなかった回">
        <span>{jobMinutesText(input.missed.expiresAfterMinutes)}以内なら</span>
        <InlineChoice label="動けなかった回" value={input.missed.policy} shown={input.missed.policy === 'skip' ? '見送る' : '一番新しい回だけ動く'} choices={MISSED_CHOICES} disabled={disabled}
          onChoose={v => set({ missed: { ...input.missed, policy: v as JobCandidateInput['missed']['policy'] } })} />
      </Row>
    </dl>
  )
}
