// A meeting's card from under its name down (minutes.md "Meetings for their attendees", design §4-5):
// first its main buttons (［AI に読ませる］, ［この会議について相談する］ — the only way this card opens a
// consultation — and ［招待する］) with whether the card could be read; a meeting not read yet asks for the
// reading where its summary would be; then the summary, the proposals (drawn by the screen), the
// series' automatic reading and the 案件. An older server answers nothing here: no buttons, plain lists, said so.
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
  /** The AI's summary is there: else, while it may be read, the card asks for the reading in its place. */
  hasSummary: boolean
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

export function MeetingPanel({ companyId, meetingId, members, onConsult, summary, hasSummary, outputs, bundle, renderReview, onChanged }: Props) {
  const { load, reloading, reload } = useMeetingCardState(companyId, meetingId)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // 「この定例は次から自動で読む」 is offered once per meeting on this PC.
  const [offered, setOffered] = useState(() => readOffered(companyId))
  const shown = load.kind === 'ready' ? load.state : null
  const m: MeetingArrivalView | null = shown?.meeting ?? null
  const review = shown && m?.status === 'read' ? shown.review : null
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
  // Not read yet: the empty summary is where the member asks for the reading (the only ［AI に読ませる］ then).
  const askInPlace = canRead && !hasSummary && !review && (m?.status === 'arrived' || m?.status === 'skipped' || m?.status === 'failed')
  const readButton = m && canRead && <button type="button" disabled={busy} onClick={() => void read(m.version)} className={MAIN_BUTTON}>AI に読ませる</button>
  const again = <button type="button" disabled={reloading} onClick={reload} className={SMALL_BUTTON}>{reloading ? '読み込んでいます…' : 'もう一度'}</button>
  return (
    <section aria-label="この会議の議事録" className="space-y-5">
      <div data-meeting-actions className="space-y-2">
        {load.kind === 'loading' && (
          <p role="status" className="flex items-center gap-1.5 text-small text-text-muted"><CircleNotch size={12} className="animate-spin" />会議の情報を読み込んでいます…</p>
        )}
        {load.kind === 'failed' && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-control border border-failed-border bg-failed-bg px-3 py-2 text-small text-failed-text">
            <span className="min-w-0 flex-1">{load.error} AI に読ませる・相談するなどのボタンは、読み込めると出ます。</span>
            {again}
          </div>
        )}
        {load.kind === 'unavailable' && (
          <p role="note" className="text-small text-text-muted">この会議では、AI に読ませる・相談するなどの操作は使えません（会社のサーバーが対応していないか、この機能が止まっています）。</p>
        )}
        {reading && (
          <p className="flex items-center gap-1.5 text-small text-link">
            <CircleNotch size={12} className="animate-spin" />{readingBanner?.kind === 'reading' ? readingWords(readingBanner) : 'AI が読んでいます…'}
          </p>
        )}
        {m?.status === 'skipped' && m.by && <p className="text-small text-text-muted">{m.byYou ? 'あなた' : `${m.by.displayName}さん`}が読まないにしました。あとから［AI に読ませる］で読めます。</p>}
        {m && (
          <div className="flex flex-wrap items-center gap-1.5">
            {!askInPlace && readButton}
            <button type="button" onClick={() => onConsult({ id: m.recordId, title: m.title })} className={SMALL_BUTTON}><ChatCircleDots size={12} />この会議について相談する</button>
            <button type="button" onClick={() => setInviting(true)} className={SMALL_BUTTON}><UserPlus size={12} />招待する</button>
          </div>
        )}
        {load.kind === 'ready' && load.refreshFailed && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-small text-text-muted">
            <span className="min-w-0 flex-1">最新の状態を読み込めませんでした。前に読み込んだ内容を出しています。{load.refreshFailed}</span>
            {again}
          </div>
        )}
        {error && <p role="alert" className="text-small text-text-muted">{error}</p>}
        {note && <p role="status" className="text-small text-success-text">{note}</p>}
      </div>
      {shown?.renewGoogle && (
        <p className="text-small text-text-muted">{GOOGLE_RENEW_MINUTES_TEXT}
          <button type="button" onClick={() => void renew()} className="ml-1 text-link hover:underline">許可をし直す</button>
        </p>
      )}
      {askInPlace ? (
        <section aria-label="要約" data-read-in-place className="rounded-control border border-dashed border-border px-4 py-3 text-body">
          <h2 className="mb-1 text-body font-semibold">要約</h2>
          <p className="mb-2 text-text-muted">AI はまだ議事録を読んでいません。AI に読ませると、ここに要約が出て、決めたこととやることの案を作ります。</p>
          {readButton}
        </section>
      ) : summary}
      {review ? renderReview(review) : load.kind !== 'loading' && outputs}
      {!threeChoices && m?.status === 'read' && m.series && !m.autoSeries && !offered.has(meetingId) && (
        <div data-auto-offer className="flex flex-wrap items-start gap-2 rounded-control bg-info-bg px-3 py-2 text-small">
          <span className="min-w-0 flex-1">
            <span className="font-medium">この定例は次から自動で読みますか？</span>
            <span className="block text-small text-text-muted">同じ定例の議事録が届いたら、ボタンを押さなくても AI が読みます。</span>
          </span>
          <button type="button" onClick={() => void auto(true)} className={SMALL_BUTTON}>この定例は次から自動で読む</button>
          <button type="button" onClick={markOffered} className="text-small text-text-muted hover:text-link">今はいい</button>
        </div>
      )}
      {!threeChoices && m?.autoSeries && (
        <p className="text-small text-text-muted">この定例は、議事録が届くと AI が自動で読みます。
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
      {bundle}
      {inviting && m && <InviteDialog companyId={companyId} meetingId={m.recordId} version={m.version} members={members}
        onDone={added => { setInviting(false); if (added) { setNote(added); changed() } }} />}
    </section>
  )
}
