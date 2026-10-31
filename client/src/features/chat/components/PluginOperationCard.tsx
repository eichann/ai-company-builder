import { memo, useState } from 'react'
import { ArrowCounterClockwise, ArrowRight, CheckCircle, Question, Robot, Warning, XCircle } from '@phosphor-icons/react'
import {
  UNDO_BUTTON_LABEL, UNDO_NOTICE_FALLBACK, reconcileResultView, shownValue, undoResultView,
  type CardActionView, type PluginCardOutcome, type PluginOperationCard as Card,
} from '../../../../shared/plugin-operations'
import { reconcilePluginOperation, undoPluginOperation } from '../api'

const HEADINGS: Record<PluginCardOutcome, { text: (s: string) => string; tone: 'ok' | 'warn' | 'error' | 'plain' }> = {
  applied: { text: s => `${s} を更新しました`, tone: 'ok' },
  unchanged: { text: s => `${s} はすでにこの値でした`, tone: 'plain' },
  refused: { text: () => '変更しませんでした', tone: 'plain' },
  'not-sent': { text: s => `${s} に書けませんでした`, tone: 'error' },
  conflict: { text: () => '先にほかの変更がありました', tone: 'warn' },
  unknown: { text: s => `${s} に届いたか分かりません`, tone: 'warn' },
  observed: { text: () => '値は変わっていますが、確かめきれていません', tone: 'warn' },
}

const TONE_CLASS = {
  ok: 'border-emerald-500/40 bg-emerald-500/5',
  warn: 'border-amber-500/40 bg-amber-500/5',
  error: 'border-red-500/40 bg-red-500/5',
  plain: 'border-gray-200 dark:border-zinc-700',
} as const

function ToneIcon({ tone }: { tone: 'ok' | 'warn' | 'error' | 'plain' }) {
  if (tone === 'ok') return <CheckCircle size={15} weight="bold" aria-hidden className="text-emerald-600" />
  if (tone === 'error') return <XCircle size={15} weight="bold" aria-hidden className="text-red-500" />
  if (tone === 'warn') return <Warning size={15} weight="bold" aria-hidden className="text-amber-500" />
  return <Question size={15} weight="bold" aria-hidden className="text-gray-400" />
}

/**
 * An outside system's write made in this consultation (client/shared/plugin-operations.ts):
 * what changed, before → after, and what is not known. 「変更前の値を書き戻す」 is the person's
 * own action, sent with their session; the server re-checks everything and answers.
 */
export const PluginOperationCard = memo(function PluginOperationCard({ card }: { card: Card }) {
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<CardActionView | null>(null)
  const heading = HEADINGS[card.outcome]
  const canUndo = card.outcome === 'applied' && card.undoable && !!card.operationId && !action?.done
  const canReconcile = card.outcome === 'unknown' && !!card.operationId && !action?.done

  const run = async (kind: 'undo' | 'reconcile') => {
    if (!card.operationId || busy) return
    setBusy(true)
    try {
      const result = kind === 'undo'
        ? await undoPluginOperation(card.companyId, card.pluginId, card.operationId, card.conversationId ?? undefined)
        : await reconcilePluginOperation(card.companyId, card.pluginId, card.operationId)
      setAction(kind === 'undo' ? undoResultView(card, result) : reconcileResultView(card, result))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="group" aria-label={heading.text(card.systemLabel)} data-outcome={card.outcome} className={`my-2 rounded-xl border p-3 ${TONE_CLASS[heading.tone]}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <ToneIcon tone={heading.tone} />
        {heading.text(card.systemLabel)}
        {card.byAi && <span className="ml-auto flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-normal text-gray-600 dark:bg-zinc-800 dark:text-zinc-300" title="この変更は、AI があなたの代わりに行い、そのように記録されています">
          <Robot size={12} aria-hidden />AI が記録
        </span>}
      </div>
      {card.recordTitle && <p className="mt-1 text-sm text-gray-800 dark:text-zinc-200">{card.recordTitle}</p>}
      {card.fields.length > 0 && <ul aria-label="変更した欄" className="mt-2 space-y-1">
        {card.fields.map(f => <li key={f.field} className="flex flex-wrap items-center gap-1.5 text-xs text-gray-800 dark:text-zinc-200">
          <span className="text-gray-500 dark:text-zinc-400">{f.label}</span>
          {f.before !== undefined
            ? <><span>{shownValue(f.before, f.valueLabels)}</span><ArrowRight size={11} aria-hidden /><span className="sr-only">から</span><span className="font-medium">{shownValue(f.after, f.valueLabels)}</span></>
            : <span>{card.outcome === 'unchanged' ? '' : '変えようとした値：'}<span className="font-medium">{shownValue(f.after, f.valueLabels)}</span></span>}
          {f.current !== undefined && <span className="text-amber-700 dark:text-amber-400">（いまの値：{shownValue(f.current, f.valueLabels)}）</span>}
        </li>)}
      </ul>}
      <p className="mt-2 text-xs text-gray-700 dark:text-zinc-300">{card.message}</p>
      {card.reason && <p className="mt-1 text-xs text-gray-500 dark:text-zinc-400">理由：{card.reason}</p>}
      {card.outcome === 'applied' && <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">{UNDO_NOTICE_FALLBACK}</p>}
      {action && <div role="status" className={`mt-2 rounded-lg border px-2 py-1.5 text-xs ${TONE_CLASS[action.tone]}`}>
        {action.message}
        {action.current && action.current.length > 0 && <ul className="mt-1">
          {action.current.map(c => <li key={c.label}>いまの {c.label}：{shownValue(c.value)}</li>)}
        </ul>}
      </div>}
      {(canUndo || canReconcile) && <div className="mt-2 flex flex-wrap items-center gap-2">
        {canUndo && <button type="button" disabled={busy} onClick={() => void run('undo')}
          className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
          <ArrowCounterClockwise size={13} aria-hidden />{busy ? '書き戻しています…' : UNDO_BUTTON_LABEL}
        </button>}
        {canReconcile && <button type="button" disabled={busy} onClick={() => void run('reconcile')}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
          {busy ? '確かめています…' : 'もう一度確かめる'}
        </button>}
      </div>}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
