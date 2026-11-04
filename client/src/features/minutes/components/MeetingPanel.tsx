// A meeting's own part of its card (minutes.md "Meetings for their attendees", design §4-5): ［AI に
// 読ませる］ while nobody had it read, ［この会議について相談する］ (the only way this card opens a
// consultation), ［招待する］, and once read the proposals (drawn by the screen) with the one-time
// 「この定例は次から自動で読む」. An older server answers nothing here: the card stays as before.
import { useState, type ReactNode } from 'react'
import { ChatCircleDots, CircleNotch, UserPlus } from '@phosphor-icons/react'
import type { MeetingArrivalView } from '../../../../shared/minutes-app'
import type { MinutesReviewView } from '../../../../shared/task-card'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { GOOGLE_OPENED_TEXT, GOOGLE_RENEW_MINUTES_TEXT } from '../../../../shared/google'
import { renewMinutesPermission, requestMeetingReading, setMeetingAutoSeries } from '../api'
import { useMeetingCardState } from '../hooks/useMeetingCardState'
import { InviteDialog } from './InviteDialog'

interface Props {
  companyId: string
  meetingId: string
  /** The company's members (the member left out): whom ［招待する］ offers. */
  members: ReadonlyArray<{ id: string; name: string }>
  /** ［この会議について相談する］. */
  onConsult: (meeting: { id: string; title: string }) => void
  /** The proposals and decisions of a read meeting (the tasks feature's part). */
  renderReview: (review: MinutesReviewView) => ReactNode
  /** Something changed on the server (the list and the banner read again). */
  onChanged: () => void
}

const offeredKey = (companyId: string) => `meeting-auto-offered:${companyId}`
function readOffered(companyId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(offeredKey(companyId)) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : [])
  } catch { return new Set() }
}

export function MeetingPanel({ companyId, meetingId, members, onConsult, renderReview, onChanged }: Props) {
  const { result, reload } = useMeetingCardState(companyId, meetingId)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // 「この定例は次から自動で読む」 is offered once per meeting on this PC.
  const [offered, setOffered] = useState(() => readOffered(companyId))
  if (!result?.success) return null
  const m: MeetingArrivalView = result.meeting
  const changed = () => { reload(); onChanged() }
  const markOffered = () => {
    const next = new Set(offered).add(m.recordId)
    setOffered(next)
    try { localStorage.setItem(offeredKey(companyId), JSON.stringify([...next].slice(-200))) } catch { /* memory only */ }
  }
  const read = async () => {
    setBusy(true)
    setError(null)
    const r = await requestMeetingReading(companyId, m.recordId, m.version)
    setBusy(false)
    if (!r.success) setError(r.error)
    changed()
  }
  const auto = async (on: boolean) => {
    setError(null)
    const failure = await setMeetingAutoSeries(companyId, m.recordId, on)
    if (failure) { setError(failure); return }
    if (on) markOffered()
    setNote(on ? 'この定例は、次から AI が自動で読みます。' : 'この定例は、次から自動では読みません。')
    changed()
  }
  const renew = async () => {
    setError(null)
    const failure = await renewMinutesPermission(companyId)
    if (failure) setError(failure)
    else setNote(GOOGLE_OPENED_TEXT)
  }
  const canRead = m.status === 'arrived' || m.status === 'skipped' || m.status === 'failed'
  const reading = m.status === 'asked' || m.status === 'reading'
  return (
    <section aria-label="この会議の議事録" className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {canRead && <button type="button" disabled={busy} onClick={() => void read()} className={MAIN_BUTTON}>AI に読ませる</button>}
        <button type="button" onClick={() => onConsult({ id: m.recordId, title: m.title })} className={SMALL_BUTTON}><ChatCircleDots size={12} />この会議について相談する</button>
        <button type="button" onClick={() => setInviting(true)} className={SMALL_BUTTON}><UserPlus size={12} />招待する</button>
      </div>
      {reading && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-accent">
          <CircleNotch size={12} className="animate-spin" />{m.byYou || !m.by ? 'AI が読んでいます…' : `${m.by.displayName}さんの AI が読んでいます…`}
        </p>
      )}
      {m.status === 'skipped' && m.by && <p className="text-[12.5px] text-gray-500">{m.byYou ? 'あなた' : `${m.by.displayName}さん`}が読まないにしました。あとから［AI に読ませる］で読めます。</p>}
      {canRead && m.status !== 'skipped' && <p className="text-[12.5px] text-gray-500">AI はまだ議事録を読んでいません。読ませると、要約と決めたこと・やることの案ができます。</p>}
      {result.renewGoogle && (
        <p className="text-[12px] text-gray-500">{GOOGLE_RENEW_MINUTES_TEXT}
          <button type="button" onClick={() => void renew()} className="ml-1 text-accent hover:underline">許可をし直す</button>
        </p>
      )}
      {error && <p role="alert" className="text-[12px] text-gray-600 dark:text-zinc-300">{error}</p>}
      {note && <p role="status" className="text-[12px] text-emerald-700 dark:text-emerald-400">{note}</p>}
      {m.status === 'read' && result.review && renderReview(result.review)}
      {m.status === 'read' && m.series && !m.autoSeries && !offered.has(m.recordId) && (
        <div data-auto-offer className="flex flex-wrap items-start gap-2 rounded-lg bg-sky-50 px-3 py-2 text-[12.5px] dark:bg-sky-950/30">
          <span className="min-w-0 flex-1">
            <span className="font-medium">この定例は次から自動で読みますか？</span>
            <span className="block text-[11.5px] text-gray-500 dark:text-zinc-400">同じ定例の議事録が届いたら、ボタンを押さなくても AI が読みます。</span>
          </span>
          <button type="button" onClick={() => void auto(true)} className={SMALL_BUTTON}>この定例は次から自動で読む</button>
          <button type="button" onClick={markOffered} className="text-[11.5px] text-gray-500 hover:text-accent">今はいい</button>
        </div>
      )}
      {m.autoSeries && (
        <p className="text-[12px] text-gray-500">この定例は、議事録が届くと AI が自動で読みます。
          <button type="button" onClick={() => void auto(false)} className="ml-1 text-accent hover:underline">次から自動で読まない</button>
        </p>
      )}
      {inviting && <InviteDialog companyId={companyId} meetingId={m.recordId} version={m.version} members={members}
        onDone={added => { setInviting(false); if (added) { setNote(added); changed() } }} />}
    </section>
  )
}
