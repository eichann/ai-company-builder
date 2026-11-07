// 「議事録が届きました」 at the top of やること (minutes.md "Meetings for their attendees", design §4-5):
// one compact block: two meetings of the last days as one-line rows, the rest behind 「ほか N 件」, so
// the list below always keeps the pane. ［AI に読ませる］ only changes the line — the member's AI
// reads it as their 「AI の番」 and nothing opens; ［読まない］ hides it with 元に戻す. The server
// decides each press and drops a line after 3 days.
import { useRef, useState } from 'react'
import { CaretDown, CaretRight, CheckCircle, CircleNotch, NotePencil, X } from '@phosphor-icons/react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { MeetingArrivalView } from '../../../../shared/minutes-app'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { requestMeetingReading, setMeetingAutoSeries, skipMeetingReading, undoMeetingSkip } from '../api'
import { foldMeetings, madeWords, meetingBanner, meetingRowWords, skippableMeetings } from '../model'

const LINK = 'text-[11px] text-gray-500 underline-offset-2 hover:text-accent hover:underline dark:text-zinc-400'
const SHORT = `${MAIN_BUTTON} shrink-0 !px-1.5 !py-0.5 !text-[11px]`
const QUIET = `${SMALL_BUTTON} shrink-0 !px-1.5 !py-0.5 !text-[11px]`
/** `busy` while ［まとめて読まない］ goes through the folded meetings. */
const BULK = 'bulk'

interface Props {
  companyId: string
  items: readonly MeetingArrivalView[]
  /** Where this PC's automatic runner has each record (a problem is said on the line). */
  aiTurns: AiTurnItemsView | null
  /** 「読み終わりました」's ［見る］: the meeting's card in the middle. */
  onView: (meeting: { id: string; title: string }) => void
  /** Something changed on the server: read the meetings again. */
  onChanged: () => void
  now?: number
  /** 決めたこと is on (「使う機能」): off, the AI makes no decisions from the minutes and the lines do not say it. */
  decisionsOn?: boolean
}

type Toast = { text: string; undo?: () => void }

const closedKey = (companyId: string) => `meeting-banners-closed:${companyId}`
function readClosed(companyId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(closedKey(companyId)) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : [])
  } catch { return new Set() }
}

export function MeetingBanners({ companyId, items, aiTurns, onView, onChanged, now = Date.now(), decisionsOn = true }: Props) {
  // 「読み終わりました」 closed on this PC (［見る］ or ×), per company.
  const [closed, setClosed] = useState(() => readClosed(companyId))
  // Chosen ［読まない］ here: gone at once while 元に戻す is offered.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  // Pressed ［AI に読ませる］ at this version: 「AI が読んでいます…」 at once, until the server's answer is read again.
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(new Map())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  // 「ほか N 件」 opened.
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const say = (t: Toast) => {
    clearTimeout(timer.current)
    setToast(t)
    timer.current = setTimeout(() => setToast(null), 8000)
  }
  const close = (id: string) => {
    const next = new Set(closed).add(id)
    setClosed(next)
    try { localStorage.setItem(closedKey(companyId), JSON.stringify([...next].slice(-200))) } catch { /* memory only */ }
  }
  const setError = (id: string, text: string | null) => setErrors(e => {
    const next = { ...e }
    if (text) next[id] = text
    else delete next[id]
    return next
  })

  const read = async (m: MeetingArrivalView) => {
    setBusy(m.recordId)
    setError(m.recordId, null)
    const r = await requestMeetingReading(companyId, m.recordId, m.version)
    setBusy(null)
    if (r.success) setAsked(s => new Map(s).set(m.recordId, m.version))
    else setError(m.recordId, r.error)
    onChanged()
  }
  const skip = async (m: MeetingArrivalView) => {
    setBusy(m.recordId)
    setError(m.recordId, null)
    const r = await skipMeetingReading(companyId, m.recordId, m.version)
    setBusy(null)
    onChanged()
    if (!r.success) { setError(m.recordId, r.error); return }
    setHidden(s => new Set(s).add(m.recordId))
    say({
      text: `「${m.title}」は読まないにしました`,
      undo: () => void undoMeetingSkip(companyId, m.recordId, r.version).then(failure => {
        if (failure) say({ text: failure })
        else setHidden(s => { const next = new Set(s); next.delete(m.recordId); return next })
        onChanged()
      }),
    })
  }
  const stopAuto = async (m: MeetingArrivalView) => {
    const failure = await setMeetingAutoSeries(companyId, m.recordId, false)
    onChanged()
    if (failure) { setError(m.recordId, failure); return }
    say({
      text: `「${m.title}」は次から自動で読みません（今回の分は読み終えます）`,
      undo: () => void setMeetingAutoSeries(companyId, m.recordId, true).then(f => { if (f) say({ text: f }); onChanged() }),
    })
  }

  const rows = items.flatMap(item => {
    const m = asked.get(item.recordId) === item.version && (item.status === 'arrived' || item.status === 'failed' || item.status === 'skipped')
      ? { ...item, status: 'asked' as const, byYou: true } : item
    const banner = meetingBanner(m, { closed: closed.has(m.recordId), hidden: hidden.has(m.recordId), ai: aiTurns?.items.find(i => i.recordId === m.recordId) })
    return banner ? [{ m, banner }] : []
  })
  const { shown, folded } = foldMeetings(rows)
  const skippable = skippableMeetings(folded)

  const skipAll = async () => {
    setBusy(BULK)
    const done: Array<{ m: MeetingArrivalView; version: number }> = []
    for (const { m } of skippable) {
      const r = await skipMeetingReading(companyId, m.recordId, m.version)
      if (r.success) done.push({ m, version: r.version })
      else setError(m.recordId, r.error)
    }
    setBusy(null)
    onChanged()
    if (done.length === 0) return
    setHidden(s => new Set([...s, ...done.map(d => d.m.recordId)]))
    say({
      text: `${done.length}件を読まないにしました`,
      undo: () => void (async () => {
        const back: string[] = []
        let failure: string | null = null
        for (const d of done) {
          const f = await undoMeetingSkip(companyId, d.m.recordId, d.version)
          if (f) failure = f
          else back.push(d.m.recordId)
        }
        if (failure) say({ text: failure })
        setHidden(s => new Set([...s].filter(id => !back.includes(id))))
        onChanged()
      })(),
    })
  }

  const locked = (id: string) => busy === id || busy === BULK
  const row = ({ m, banner }: (typeof rows)[number]) => {
    const words = meetingRowWords(m, now)
    const line = banner.kind === 'read' ? `読み終わりました ${m.title}：${madeWords(m.made, decisionsOn)}` : words
    return (
      <div key={m.recordId} data-banner={m.recordId} className="px-1 py-0.5">
        <div className="flex items-center gap-1.5 text-[12px] leading-5">
          {banner.kind === 'read'
            ? <CheckCircle size={13} weight="fill" className="shrink-0 text-emerald-600 dark:text-emerald-400" />
            : banner.kind === 'reading' && !banner.problem
              ? <CircleNotch size={13} className="shrink-0 animate-spin text-accent" />
              : <NotePencil size={13} weight="duotone" className="shrink-0 text-sky-600 dark:text-sky-400" />}
          <span title={line} className="min-w-0 flex-1 truncate text-gray-800 dark:text-zinc-100">{line}</span>
          {banner.kind === 'arrived' && <>
            {banner.failedBefore && <span title="前回は AI が読めませんでした。もう一度読ませられます" className="shrink-0 text-[10.5px] text-gray-500 dark:text-zinc-400">前回読めず</span>}
            <button type="button" disabled={locked(m.recordId)} title={decisionsOn ? 'AI に読ませると、決めたこととやることの案を作ります' : 'AI に読ませると、やることの案を作ります'} onClick={() => void read(m)} className={SHORT}>AI に読ませる</button>
            <button type="button" disabled={locked(m.recordId)} onClick={() => void skip(m)} className={QUIET}>読まない</button>
          </>}
          {banner.kind === 'reading' && <>
            {!banner.problem && <span className="min-w-0 shrink truncate text-[11px] text-accent">{banner.auto ? '自動で読む定例です。AI が読んでいます…' : banner.reader ? `${banner.reader}さんの AI が読んでいます…` : 'AI が読んでいます…'}</span>}
            {banner.problem?.canRetry && <button type="button" onClick={() => aiTurns?.retry(m.recordId)} className={QUIET}>もう一度</button>}
            {banner.canSkip && <button type="button" disabled={locked(m.recordId)} onClick={() => void skip(m)} className={QUIET}>読まない</button>}
          </>}
          {banner.kind === 'read' && <>
            <button type="button" onClick={() => { close(m.recordId); onView({ id: m.recordId, title: m.title }) }} className={SHORT}>見る</button>
            <button type="button" aria-label="閉じる" onClick={() => close(m.recordId)} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-zinc-800"><X size={11} /></button>
          </>}
          {banner.kind === 'skipped' && <span className="min-w-0 shrink truncate text-[11px] text-gray-500 dark:text-zinc-400">{banner.by}さんが読まないにしました</span>}
        </div>
        {banner.kind === 'reading' && banner.problem && <p className="pl-5 text-[11px] text-gray-600 dark:text-zinc-300">{banner.problem.reason}</p>}
        {banner.kind === 'reading' && banner.auto && <p className="pl-5"><button type="button" onClick={() => void stopAuto(m)} className={LINK}>次から自動で読まない</button></p>}
        {errors[m.recordId] && <p role="alert" className="pl-5 text-[11px] leading-snug text-gray-600 dark:text-zinc-300">{errors[m.recordId]}</p>}
      </div>
    )
  }

  return <>
    {rows.length > 0 && (
      // A block of its own height at most: the list below keeps the rest of the pane, however many arrive.
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-gray-200 bg-sky-50/50 px-2 py-1 dark:border-zinc-800 dark:bg-sky-950/20" role="region" aria-label="議事録が届きました">
        <p className="px-1 text-[11px] font-semibold text-gray-600 dark:text-zinc-300">議事録が届きました</p>
        {shown.map(row)}
        {folded.length > 0 && (
          <div className="flex items-center gap-2 px-1 pt-0.5">
            <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`${LINK} inline-flex items-center gap-0.5`}>
              {open ? <CaretDown size={9} /> : <CaretRight size={9} />}ほか {folded.length} 件
            </button>
            {open && skippable.length > 0 && <button type="button" disabled={busy !== null} onClick={() => void skipAll()} className={`${LINK} ml-auto`}>まとめて読まない</button>}
          </div>
        )}
        {open && folded.length > 0 && <div data-testid="meetings-folded" className="max-h-40 overflow-y-auto">{folded.map(row)}</div>}
      </div>
    )}
    {toast && (
      <div role="status" className="fixed bottom-4 left-4 z-[60] flex items-center gap-3 rounded-lg bg-gray-900 px-3.5 py-2 text-[12.5px] text-white shadow-lg dark:bg-zinc-700">
        {toast.text}
        {toast.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null) }} className="font-semibold text-sky-300 hover:underline">元に戻す</button>}
      </div>
    )}
  </>
}
