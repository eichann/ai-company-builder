// 返事待ち and its 見込み on the task card (task version 12, owner decision 2026-11-03 「②」): the
// chooser 「いつごろ来そうか」, the window of 「返事待ちにする」/「もう少し待つ」, and the band that shows
// the 見込み while waiting or 「先方からの返事が来ていません（3日）」 once the clock gave it back.
import { useState } from 'react'
import { CheckCircle, Clock, PencilSimpleLine, Warning } from '@phosphor-icons/react'
import type { TaskCardData } from '../../../../shared/task-card'
import { cameBackLine, defaultWaitUntil, waitChoices, waitingLine, waitUntilText, type TaskActInput } from '../../../../shared/tasks'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'

const FIELD = 'w-full rounded border border-gray-300 bg-transparent px-2 py-1 text-[12.5px] dark:border-zinc-600'
const CHIP = 'rounded-full border px-2.5 py-0.5 text-[12px]'
const CHIP_ON = 'border-accent bg-accent/10 text-accent'
const CHIP_OFF = 'border-gray-300 text-gray-700 hover:border-accent dark:border-zinc-600 dark:text-zinc-200'

type Run = (steps: Array<Omit<TaskActInput, 'expectedVersion'>>, done?: string) => Promise<string | null>

/** 「いつごろ来そうか」: ［明日］［3日後］［来週］［日を選ぶ］. `value` null = nothing chosen (the server's 3 business days). */
export function WaitChooser({ today, holidays, value, onChange, showDefault = true }: { today: string; holidays: string[]; value: string | null; onChange: (until: string | null) => void; showDefault?: boolean }) {
  const choices = waitChoices(today, holidays)
  const [picking, setPicking] = useState(value !== null && !choices.some(c => c.until === value))
  return (
    <div role="group" aria-label="いつごろ来そうか" className="space-y-1.5">
      <span className="text-[12px] text-gray-600 dark:text-zinc-300">いつごろ来そうか</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map(c => (
          <button key={c.key} type="button" aria-pressed={value === c.until && !picking}
            onClick={() => { setPicking(false); onChange(value === c.until && !picking ? null : c.until) }}
            className={`${CHIP} ${value === c.until && !picking ? CHIP_ON : CHIP_OFF}`}>
            {c.label}<span className="ml-1 tabular-nums text-[11px] opacity-70">{waitUntilText(c.until)}</span>
          </button>
        ))}
        <button type="button" aria-pressed={picking} onClick={() => { setPicking(p => !p); if (picking) onChange(null) }} className={`${CHIP} ${picking ? CHIP_ON : CHIP_OFF}`}>日を選ぶ</button>
        {picking && <input type="date" aria-label="見込みの日" min={today} value={value ?? ''} onChange={e => onChange(e.target.value || null)} className="rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-[12px] dark:border-zinc-600" />}
      </div>
      {showDefault && value === null && <p className="text-[11px] text-gray-500">選ばなければ 3営業日後（{waitUntilText(defaultWaitUntil(today, holidays))}）にします。過ぎても返事待ちのままなら、あなたの番に戻ります。</p>}
    </div>
  )
}

/** 「返事待ちにする」 and 「もう少し待つ」: what is awaited and until when, as one action (`wait`). */
export function WaitDialog({ card, today, again, busy, onClose, onRun }: { card: TaskCardData; today: string; again: boolean; busy: boolean; onClose: () => void; onRun: Run }) {
  const [on, setOn] = useState(card.wait?.on ?? '')
  const [until, setUntil] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = again ? 'もう少し待ちますか？' : '返事待ちにしますか？'
  const run = async () => {
    const shown = until ?? defaultWaitUntil(today, card.holidays)
    // Nothing chosen: no date is sent and the server sets its own 3 business days (ARG_DEFAULTS).
    const failure = await onRun([{ action: 'wait', args: { waiting_on: on.trim() || '相手からの返事', ...(until ? { wait_until: until } : {}) } }],
      `返事待ちにしました（${waitUntilText(shown)} ごろまで）`)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={e => e.stopPropagation()} className="w-[440px] space-y-3 rounded-xl bg-white p-4 text-[13px] text-gray-800 shadow-2xl dark:bg-zinc-800 dark:text-zinc-100">
        <div className="text-[14px] font-semibold">{title}</div>
        <dl className="space-y-1.5 text-[12.5px]">
          <div className="flex gap-2"><dt className="w-[84px] shrink-0 text-gray-500">何が起きるか</dt><dd>あなたの番から外れ、「ほかの人の番・返事待ち」に移ります。見込みを過ぎたら、あなたの番に戻ります</dd></div>
          <div className="flex gap-2"><dt className="w-[84px] shrink-0 text-gray-500">知らせる人</dt><dd>だれにも知らせません</dd></div>
        </dl>
        <label className="block space-y-1">
          <span className="text-[12px] text-gray-600 dark:text-zinc-300">何を待っていますか</span>
          <input aria-label="待っているもの" value={on} onChange={e => setOn(e.target.value)} placeholder="例：先方からの見積の返事" className={FIELD} />
        </label>
        <WaitChooser today={today} holidays={card.holidays} value={until} onChange={setUntil} />
        {error && <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={SMALL_BUTTON}>やめておく</button>
          <button type="button" disabled={busy} onClick={() => void run()} className={MAIN_BUTTON}>{again ? 'もう少し待つ' : '返事待ちにする'}</button>
        </div>
      </div>
    </div>
  )
}

/**
 * The band under the title: 「返事待ち：先方からの返事（11/6 ごろまで）」 + ［見込みを変える］ while waiting;
 * 「先方からの返事が来ていません（3日）」 + ［催促の下書きを作る］［もう少し待つ］［完了にする］ once given back.
 */
export function WaitBand({ card, today, busy, onRun, onNudge }: { card: TaskCardData; today: string; busy: boolean; onRun: Run; onNudge?: () => void }) {
  const [changing, setChanging] = useState(false)
  const [until, setUntil] = useState<string | null>(null)
  const [again, setAgain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wait = card.wait
  if (!wait) return null
  const wait_ = card.actions.find(a => a.action === 'wait')
  const complete = card.actions.find(a => a.action === 'complete' && !a.needsOk && !a.noteRequired)
  if (wait.cameBack) {
    return (
      <section aria-label="返事が来ていません" className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-3 text-[12.5px]">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold"><Warning size={14} weight="fill" className="text-amber-500" />{cameBackLine(wait.on, wait.cameBack.waitedSince, today, card.holidays)}</p>
        <p className="text-[11.5px] text-gray-600 dark:text-zinc-300">{wait.until ? `返事の見込み（${waitUntilText(wait.until)}）を過ぎたので、あなたの番に戻りました。` : '返事の見込みを過ぎたので、あなたの番に戻りました。'}</p>
        <div className="flex flex-wrap gap-2">
          {onNudge && <button type="button" disabled={busy} onClick={onNudge} className={MAIN_BUTTON}><PencilSimpleLine size={13} />催促の下書きを作る</button>}
          {wait_ && <button type="button" disabled={busy} onClick={() => setAgain(true)} className={SMALL_BUTTON}>もう少し待つ</button>}
          {complete && <button type="button" disabled={busy} onClick={() => void onRun([{ action: 'complete' }], '完了にしました').then(setError)} className={SMALL_BUTTON}><CheckCircle size={12} className="mr-1 inline" />完了にする</button>}
        </div>
        {onNudge && <p className="text-[10.5px] text-gray-500">AI が短い催促の下書きを作ります。送るのはあなたです。</p>}
        {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
        {again && <WaitDialog card={card} today={today} again busy={busy} onClose={() => setAgain(false)} onRun={onRun} />}
      </section>
    )
  }
  const change = async () => {
    if (!until) return
    const failure = await onRun([{ action: 'set_wait_until', args: { wait_until: until } }], `見込みを${waitUntilText(until)}に変えました`)
    setError(failure)
    if (!failure) setChanging(false)
  }
  return (
    <section aria-label="返事待ち" className="space-y-2 rounded-xl border border-sky-500/30 bg-sky-500/[0.05] p-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        <Clock size={14} className="text-sky-600 dark:text-sky-300" />
        <span className="font-medium">{waitingLine(wait.on, wait.until)}</span>
        {wait.canChange && !changing && <button type="button" disabled={busy} onClick={() => setChanging(true)} className={SMALL_BUTTON}>{wait.until ? '見込みを変える' : '見込みを決める'}</button>}
      </div>
      {changing && (
        <div className="space-y-2 pl-5">
          <WaitChooser today={today} holidays={card.holidays} value={until} onChange={setUntil} showDefault={false} />
          <div className="flex gap-2">
            <button type="button" disabled={busy || !until} onClick={() => void change()} className={MAIN_BUTTON}>この日にする</button>
            <button type="button" onClick={() => { setChanging(false); setUntil(null) }} className={SMALL_BUTTON}>やめておく</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
    </section>
  )
}
