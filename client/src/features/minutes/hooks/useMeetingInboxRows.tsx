// The meetings of the last days as the inbox's rows (owner decision 2026-11-26: the 「議事録が届きました」 banner above やること
// is gone; minutes.md "In the app"). ［AI に読ませる］ only changes the line — the member's AI reads it as their 「AI の番」 and
// nothing opens; ［読まない］ hides it with 元に戻す. The server decides each press and drops a meeting after 3 days.
import { useRef, useState, type ReactNode } from 'react'
import type { AiTurnItemsView } from '../../../../shared/ai-turns'
import type { MeetingArrivalView } from '../../../../shared/minutes-app'
import type { MeetingNewsRow, RowButton } from '../../../../shared/notifications-app'
import { requestMeetingReading, setMeetingAutoRead, setMeetingAutoSeries, skipMeetingReading, undoMeetingSkip } from '../api'
import { meetingBanner, meetingNewsOf } from '../model'
import { useAutoReadSuggestion } from './useAutoReadSuggestion'

type Toast = { text: string; undo?: () => void }

const closedKey = (companyId: string) => `meeting-banners-closed:${companyId}`
function readClosed(companyId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(closedKey(companyId)) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-200) : [])
  } catch { return new Set() }
}

interface Args {
  companyId: string
  items: readonly MeetingArrivalView[]
  /** Where this PC's automatic runner has each record (a problem is said on the line). */
  aiTurns: AiTurnItemsView | null
  /** 「読み終わりました」's ［見る］: the meeting's card in the middle. */
  onView: (meeting: { id: string; title: string }) => void
  /** Something changed on the server: read the meetings again. */
  onChanged: () => void
  /** 決めたこと is on (「使う機能」): off, the lines do not speak of decisions. */
  decisionsOn: boolean
}

/**
 * The rows (`MeetingNewsRow`, with their buttons), `markSeen` for a finished one looked at on this PC (the closed list the
 * banner kept, localStorage `meeting-banners-closed:<company>`), the 「元に戻す」 toast and the auto-read suggestion.
 */
export function useMeetingInboxRows({ companyId, items, aiTurns, onView, onChanged, decisionsOn }: Args): {
  rows: MeetingNewsRow[]; markSeen: (id: string) => void; toast: ReactNode; suggestion: ReactNode
} {
  const [closed, setClosed] = useState(() => ({ companyId, ids: readClosed(companyId) }))
  const closedIds = closed.companyId === companyId ? closed.ids : readClosed(companyId)
  // Chosen ［読まない］ here: gone at once while 元に戻す is offered.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  // Pressed ［AI に読ませる］ at this version: 「AI が読んでいます…」 at once, until the server's answer is read again.
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(new Map())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const suggestion = useAutoReadSuggestion(companyId)

  const say = (t: Toast) => {
    clearTimeout(timer.current)
    setToast(t)
    timer.current = setTimeout(() => setToast(null), 8000)
  }
  const markSeen = (id: string) => {
    if (closedIds.has(id)) return
    const next = new Set(closedIds).add(id)
    setClosed({ companyId, ids: next })
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
  const autoReadOutside = async () => {
    // A choice made meanwhile (Settings, another PC) is never replaced by the suggestion.
    if (!(await suggestion.stillNeverChose())) return
    const r = await setMeetingAutoRead(companyId, 'outside')
    if (!r.success) { say({ text: r.error || 'できませんでした。' }); return }
    suggestion.answered(r)
    say({
      text: '社外の人がいる会議は、次から AI が自動で読みます（設定 →「自分の設定」で変えられます）',
      undo: () => void setMeetingAutoRead(companyId, 'off').then(back => { if (back.success) suggestion.answered(back); else say({ text: back.error }) }),
    })
  }

  const now = Date.now()
  const rows = items.flatMap((item): MeetingNewsRow[] => {
    const pressable = item.status === 'arrived' || item.status === 'failed' || item.status === 'skipped' || (item.status === 'asked' && !item.byYou)
    const m = asked.get(item.recordId) === item.version && pressable
      ? { ...item, status: 'asked' as const, byYou: true, askedAutomatically: false } : item
    // A finished one closed here stays a row (seen), so it can still be found in 「確認したもの」.
    const banner = meetingBanner(m, { closed: false, hidden: hidden.has(m.recordId), ai: aiTurns?.items.find(i => i.recordId === m.recordId) })
    const news = meetingNewsOf(m, banner, { now, closed: closedIds.has(m.recordId), decisionsOn })
    if (!news || !banner) return []
    const locked = busy === m.recordId
    const actions: RowButton[] = []
    const readButton: RowButton = { label: 'AI に読ませる', primary: true, disabled: locked, run: () => void read(m), title: decisionsOn ? 'AI に読ませると、決めたこととやることの案を作ります' : 'AI に読ませると、やることの案を作ります' }
    const skipButton: RowButton = { label: '読まない', disabled: locked, run: () => void skip(m) }
    if (banner.kind === 'arrived') actions.push(readButton, skipButton)
    if (banner.kind === 'reading') {
      if (banner.canRead) actions.push({ ...readButton, title: '待たずに、あなたの AI が読みます' })
      if (banner.problem?.canRetry) actions.push({ label: 'もう一度', run: () => aiTurns?.retry(m.recordId) })
      if (banner.canSkip) actions.push(skipButton)
      if (banner.auto === 'series') actions.push({ label: '次から自動で読まない', run: () => void stopAuto(m) })
    }
    if (banner.kind === 'read') actions.push({ label: '見る', primary: true, run: () => { markSeen(m.recordId); onView({ id: m.recordId, title: m.title }) } })
    return [{ ...news, line: errors[m.recordId] ?? news.line, actions }]
  })

  return {
    rows,
    markSeen,
    toast: toast && (
      <div role="status" className="fixed bottom-4 left-4 z-toast flex items-center gap-3 rounded-control bg-toast px-toast-x py-toast-y text-small text-on-toast shadow-pop">
        {toast.text}
        {toast.undo && <button type="button" onClick={() => { toast.undo?.(); setToast(null) }} className="font-strong text-on-toast underline-offset-2 hover:underline">元に戻す</button>}
      </div>
    ),
    // The setting is read once this is on screen (a callback ref: the renderer's effects are capped).
    suggestion: rows.length > 0 ? (
      <div ref={suggestion.loadRef}>
        {suggestion.suggest && (
          <p data-auto-read-suggestion className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-small text-text-muted">
            <span className="min-w-0">押さなくても、届いた議事録を AI が読めます。</span>
            <button type="button" onClick={() => void autoReadOutside()} className="text-small text-link hover:text-link-hover">社外の人がいる会議だけ自動で読む</button>
            <button type="button" onClick={suggestion.dismiss} className="text-small text-text-muted hover:text-text">今はいい</button>
          </p>
        )}
      </div>
    ) : null,
  }
}
