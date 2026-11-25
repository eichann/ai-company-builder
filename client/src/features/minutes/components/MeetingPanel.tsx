// A meeting's card from its summary down (minutes.md "Meetings for their attendees", design §4-5): the
// summary, once read the proposals (drawn by the screen) with the one-time 「この定例は次から自動で読む」,
// then ［AI に読ませる］ while nobody had it read, ［この会議について相談する］ (the only way this card opens
// a consultation), ［招待する］ and the 案件. An older server answers nothing here: no buttons, plain lists.
import { useState, type ReactNode } from 'react'
import { ChatCircleDots, CircleNotch, UserPlus } from '@phosphor-icons/react'
import type { MeetingArrivalView } from '../../../../shared/minutes-app'
import type { MinutesReviewView } from '../../../../shared/task-card'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { GOOGLE_OPENED_TEXT, GOOGLE_RENEW_MINUTES_TEXT } from '../../../../shared/google'
import { renewMinutesPermission, requestMeetingReading, setMeetingAutoSeries } from '../api'
import { useMeetingCardState } from '../hooks/useMeetingCardState'
import { meetingBanner, readingWords, SERIES_CHOICES } from '../model'
import { InviteDialog } from './InviteDialog'

interface Props {
  companyId: string
  meetingId: string
  /** The company's members (the member left out): whom ［招待する］ offers. */
  members: ReadonlyArray<{ id: string; name: string }>
  /** ［この会議について相談する］. */
  onConsult: (meeting: { id: string; title: string }) => void
  /** The card's summary, its plain lists (where there is no review) and its 案件 field. */
  summary: ReactNode
  outputs: ReactNode
  bundle: ReactNode
  /** The proposals and decisions of a read meeting (the tasks feature's part). */
  renderReview: (review: MinutesReviewView) => ReactNode
  /** Something changed on the server (the list and the banner read again). */
  onChanged: () => void
}

/** The series' current choice: the same size as the others, marked by the primary colour. */
const CHOSEN = 'inline-flex shrink-0 items-center gap-1 rounded-control border border-primary px-2 py-0.5 text-small font-strong text-link'

const offeredKey = (companyId: string) => `meeting-auto-offered:${companyId}`
function readOffered(companyId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(offeredKey(companyId)) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : [])
  } catch { return new Set() }
}

export function MeetingPanel({ companyId, meetingId, members, onConsult, summary, outputs, bundle, renderReview, onChanged }: Props) {
  const { result, reload } = useMeetingCardState(companyId, meetingId)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // 「この定例は次から自動で読む」 is offered once per meeting on this PC.
  const [offered, setOffered] = useState(() => readOffered(companyId))
  const m: MeetingArrivalView | null = result?.success ? result.meeting : null
  const review = result?.success && m?.status === 'read' ? result.review : null
  const changed = () => { reload(); onChanged() }
  const markOffered = () => {
    const next = new Set(offered).add(meetingId)
    setOffered(next)
    try { localStorage.setItem(offeredKey(companyId), JSON.stringify([...next].slice(-200))) } catch { /* memory only */ }
  }
  const read = async (version: number) => {
    setBusy(true)
    setError(null)
    const r = await requestMeetingReading(companyId, meetingId, version)
    setBusy(false)
    if (!r.success) setError(r.error)
    changed()
  }
  const auto = async (on: boolean | null) => {
    setError(null)
    const failure = await setMeetingAutoSeries(companyId, meetingId, on)
    if (failure) { setError(failure); return }
    if (on) markOffered()
    setNote(on ? 'この定例は、次から AI が自動で読みます。' : on === false ? 'この定例は、次から自動では読みません。' : 'この定例は、「届いた議事録を AI が自動で読む」の設定に従います。')
    changed()
  }
  const renew = async () => {
    setError(null)
    const failure = await renewMinutesPermission(companyId)
    if (failure) setError(failure)
    else setNote(GOOGLE_OPENED_TEXT)
  }
  const reading = m?.status === 'asked' || m?.status === 'reading'
  const readingBanner = m && reading ? meetingBanner(m, { closed: false, hidden: false }) : null
  // Also while only the clock asked it for another attendee: the member's own press takes it.
  const canRead = m?.status === 'arrived' || m?.status === 'skipped' || m?.status === 'failed' || (readingBanner?.kind === 'reading' && readingBanner.canRead)
  // A server that keeps a series' three choices says which (`seriesChoice`); an older one keeps its two buttons.
  const threeChoices = !!m?.series && m.seriesChoice !== undefined
  return (
    <section aria-label="この会議の議事録" className="space-y-5">
      {summary}
      {reading && (
        <p className="flex items-center gap-1.5 text-small text-link">
          <CircleNotch size={12} className="animate-spin" />{readingBanner?.kind === 'reading' ? readingWords(readingBanner) : 'AI が読んでいます…'}
        </p>
      )}
      {m?.status === 'skipped' && m.by && <p className="text-small text-gray-500">{m.byYou ? 'あなた' : `${m.by.displayName}さん`}が読まないにしました。あとから［AI に読ませる］で読めます。</p>}
      {result?.success && result.renewGoogle && (
        <p className="text-small text-gray-500">{GOOGLE_RENEW_MINUTES_TEXT}
          <button type="button" onClick={() => void renew()} className="ml-1 text-link hover:underline">許可をし直す</button>
        </p>
      )}
      {review ? renderReview(review) : result !== null && outputs}
      {!threeChoices && m?.status === 'read' && m.series && !m.autoSeries && !offered.has(meetingId) && (
        <div data-auto-offer className="flex flex-wrap items-start gap-2 rounded-control bg-sky-50 px-3 py-2 text-small dark:bg-sky-950/30">
          <span className="min-w-0 flex-1">
            <span className="font-medium">この定例は次から自動で読みますか？</span>
            <span className="block text-small text-gray-500 dark:text-zinc-400">同じ定例の議事録が届いたら、ボタンを押さなくても AI が読みます。</span>
          </span>
          <button type="button" onClick={() => void auto(true)} className={SMALL_BUTTON}>この定例は次から自動で読む</button>
          <button type="button" onClick={markOffered} className="text-small text-gray-500 hover:text-link">今はいい</button>
        </div>
      )}
      {!threeChoices && m?.autoSeries && (
        <p className="text-small text-gray-500">この定例は、議事録が届くと AI が自動で読みます。
          <button type="button" onClick={() => void auto(false)} className="ml-1 text-link hover:underline">次から自動で読まない</button>
        </p>
      )}
      {threeChoices && (
        <div data-series-choice role="radiogroup" aria-label="この定例の議事録を自動で読むか" className="flex flex-wrap items-center gap-1.5 text-small text-text-muted">
          <span>この定例は：</span>
          {SERIES_CHOICES.map(c => {
            const chosen = (m.seriesChoice ?? null) === c.choice
            return (
              <button key={c.label} type="button" role="radio" aria-checked={chosen} onClick={() => { if (!chosen) void auto(c.choice === null ? null : c.choice === 'auto') }}
                className={chosen ? CHOSEN : SMALL_BUTTON}>{c.label}</button>
            )
          })}
        </div>
      )}
      <div className="space-y-2">
        {m && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canRead && <button type="button" disabled={busy} onClick={() => void read(m.version)} className={MAIN_BUTTON}>AI に読ませる</button>}
            <button type="button" onClick={() => onConsult({ id: m.recordId, title: m.title })} className={SMALL_BUTTON}><ChatCircleDots size={12} />この会議について相談する</button>
            <button type="button" onClick={() => setInviting(true)} className={SMALL_BUTTON}><UserPlus size={12} />招待する</button>
          </div>
        )}
        {error && <p role="alert" className="text-small text-gray-600 dark:text-zinc-300">{error}</p>}
        {note && <p role="status" className="text-small text-emerald-700 dark:text-emerald-400">{note}</p>}
        {bundle}
      </div>
      {inviting && m && <InviteDialog companyId={companyId} meetingId={m.recordId} version={m.version} members={members}
        onDone={added => { setInviting(false); if (added) { setNote(added); changed() } }} />}
    </section>
  )
}
