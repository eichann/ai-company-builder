// 「議事録が届きました」 at the top of やること (minutes.md "Meetings for their attendees", design §4-5):
// one line per meeting of the last days. ［AI に読ませる］ only changes the line — the member's AI
// reads it as their 「AI の番」 and nothing opens; ［読まない］ hides it with 元に戻す. The server
// decides each press and drops a line after 3 days.
import { useRef, useState } from 'react'
import { CheckCircle, CircleNotch, NotePencil, X } from '@phosphor-icons/react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { MeetingArrivalView } from '../../../../shared/minutes-app'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { requestMeetingReading, setMeetingAutoSeries, skipMeetingReading, undoMeetingSkip } from '../api'
import { madeWords, meetingBanner, meetingPeopleWords } from '../model'

const LINK = 'text-[11px] text-gray-500 underline-offset-2 hover:text-accent hover:underline dark:text-zinc-400'
const SHORT = `${MAIN_BUTTON} !px-2.5 !py-1 !text-[12px]`

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
}

type Toast = { text: string; undo?: () => void }

const closedKey = (companyId: string) => `meeting-banners-closed:${companyId}`
function readClosed(companyId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(closedKey(companyId)) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : [])
  } catch { return new Set() }
}

export function MeetingBanners({ companyId, items, aiTurns, onView, onChanged, now = Date.now() }: Props) {
  // 「読み終わりました」 closed on this PC (［見る］ or ×), per company.
  const [closed, setClosed] = useState(() => readClosed(companyId))
  // Chosen ［読まない］ here: gone at once while 元に戻す is offered.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  // Pressed ［AI に読ませる］ at this version: 「AI が読んでいます…」 at once, until the server's answer is read again.
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(new Map())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
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

  const shown = items.flatMap(item => {
    const m = asked.get(item.recordId) === item.version && (item.status === 'arrived' || item.status === 'failed' || item.status === 'skipped')
      ? { ...item, status: 'asked' as const, byYou: true } : item
    const banner = meetingBanner(m, { closed: closed.has(m.recordId), hidden: hidden.has(m.recordId), ai: aiTurns?.items.find(i => i.recordId === m.recordId) })
    return banner ? [{ m, banner }] : []
  })
  if (shown.length === 0 && !toast) return null
  return (
    <div className="space-y-1.5 border-b border-gray-200 px-2 py-2 dark:border-zinc-800" role="region" aria-label="議事録が届きました">
      {shown.map(({ m, banner }) => banner.kind === 'read' ? (
        <div key={m.recordId} data-banner={m.recordId} className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/70 px-2.5 py-2 text-[12.5px] leading-snug dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <CheckCircle size={14} weight="fill" className="mt-0.5 shrink-0 self-start text-emerald-600 dark:text-emerald-400" />
          <span className="min-w-0 flex-1 text-gray-800 dark:text-zinc-100">
            <span className="font-semibold">読み終わりました</span>{'　'}{m.title}：<span className="text-gray-600 dark:text-zinc-300">{madeWords(m.made)}</span>
          </span>
          <button type="button" onClick={() => { close(m.recordId); onView({ id: m.recordId, title: m.title }) }} className={SHORT}>見る</button>
          <button type="button" aria-label="閉じる" onClick={() => close(m.recordId)} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-zinc-800"><X size={11} /></button>
        </div>
      ) : (
        <div key={m.recordId} data-banner={m.recordId} className="rounded-lg border border-sky-200 bg-sky-50/70 px-2.5 py-2 dark:border-sky-900/60 dark:bg-sky-950/30">
          <div className="flex items-start gap-1.5 text-[12.5px] leading-snug">
            <NotePencil size={14} weight="duotone" className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" />
            <span className="min-w-0 text-gray-800 dark:text-zinc-100">
              <span className="font-semibold">議事録が届きました</span>{'　'}{m.title}
              <span className="text-gray-500 dark:text-zinc-400">（{meetingPeopleWords(m, now)}）</span>
            </span>
          </div>
          {banner.kind === 'arrived' && <>
            <p className="mt-0.5 pl-5 text-[11px] text-gray-500 dark:text-zinc-400">
              {banner.failedBefore ? '前回は AI が読めませんでした。もう一度読ませられます' : 'AI に読ませると、決めたこととやることの案を作ります'}
            </p>
            <div className="mt-1.5 flex gap-1.5 pl-5">
              <button type="button" disabled={busy === m.recordId} onClick={() => void read(m)} className={SHORT}>AI に読ませる</button>
              <button type="button" disabled={busy === m.recordId} onClick={() => void skip(m)} className={SMALL_BUTTON}>読まない</button>
            </div>
          </>}
          {banner.kind === 'reading' && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11.5px] text-accent">
              {banner.problem
                ? <span className="text-gray-600 dark:text-zinc-300">{banner.problem.reason}</span>
                : <><CircleNotch size={12} className="animate-spin" />{banner.auto ? '自動で読む定例です。AI が読んでいます…' : banner.reader ? `${banner.reader}さんの AI が読んでいます…` : 'AI が読んでいます…'}</>}
              <span className="ml-auto flex items-center gap-2">
                {banner.problem?.canRetry && <button type="button" onClick={() => aiTurns?.retry(m.recordId)} className={SMALL_BUTTON}>もう一度</button>}
                {banner.auto && <button type="button" onClick={() => void stopAuto(m)} className={LINK}>次から自動で読まない</button>}
                {banner.canSkip && <button type="button" disabled={busy === m.recordId} onClick={() => void skip(m)} className={SMALL_BUTTON}>読まない</button>}
              </span>
            </div>
          )}
          {banner.kind === 'skipped' && (
            <p className="mt-0.5 pl-5 text-[11.5px] text-gray-500 dark:text-zinc-400">{banner.by}さんが読まないにしました</p>
          )}
          {errors[m.recordId] && <p role="alert" className="mt-1 pl-5 text-[11.5px] text-gray-600 dark:text-zinc-300">{errors[m.recordId]}</p>}
        </div>
      ))}
      {toast && (
        <div role="status" className="fixed bottom-4 left-4 z-[60] flex items-center gap-3 rounded-lg bg-gray-900 px-3.5 py-2 text-[12.5px] text-white shadow-lg dark:bg-zinc-700">
          {toast.text}
          {toast.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null) }} className="font-semibold text-sky-300 hover:underline">元に戻す</button>}
        </div>
      )}
    </div>
  )
}
