import { memo, useState } from 'react'
import { ArrowRight, CheckCircle, Clock, Robot, Warning, XCircle } from '@phosphor-icons/react'
import { nameOf, percentText, stateLine, type ApprovalCardRef } from '../../../../shared/approvals'
import { APPROVE_HASH_NOTE, type ApprovalView } from '../../../../../shared/types/approvals'
import { approveApproval, getApproval, sendBackApproval, withdrawApproval, type ApprovalOutbound } from '../api'
import { putApproval } from '../approvalStore'
import { useApproval } from '../hooks/useApproval'

const TONE_CLASS = {
  ok: 'border-emerald-500/40 bg-emerald-500/5',
  warn: 'border-amber-500/40 bg-amber-500/5',
  error: 'border-red-500/40 bg-red-500/5',
  plain: 'border-gray-200 dark:border-zinc-700',
} as const

const STATE_TONE: Record<ApprovalView['state'], keyof typeof TONE_CLASS> = {
  pending: 'plain', approved: 'ok', sent_back: 'warn', stale: 'warn', withdrawn: 'plain', failed: 'error',
}

function StateIcon({ state }: { state: ApprovalView['state'] }) {
  if (state === 'approved') return <CheckCircle size={15} weight="bold" aria-hidden className="text-emerald-600" />
  if (state === 'failed') return <XCircle size={15} weight="bold" aria-hidden className="text-red-500" />
  if (state === 'pending') return <Clock size={15} weight="bold" aria-hidden className="text-gray-500" />
  return <Warning size={15} weight="bold" aria-hidden className="text-amber-500" />
}

const BUTTON = 'rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50'

/**
 * An approval request (承認のお願い; client/shared/approvals.ts), drawn by the app — never by a
 * plugin or the AI's text. It reads the request with the member's session each time it is
 * shown; 「承認」 sends the reason and the hash of the content shown here, and the server acts
 * only when that is still the content it holds.
 */
export const ApprovalCard = memo(function ApprovalCard({ card, outbound }: { card: ApprovalCardRef; outbound?: ApprovalOutbound }) {
  const { key, view, names, error: loadError } = useApproval(card.companyId, card.approvalId, outbound)
  const [message, setMessage] = useState<{ tone: keyof typeof TONE_CLASS; text: string } | null>(null)
  // null until the approver edits it: the AI's draft is shown first.
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reason = edited ?? view?.proposedReason ?? ''

  const act = async (kind: 'approve' | 'send-back' | 'withdraw') => {
    if (!view || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const r = kind === 'approve'
        ? await (outbound ? approveApproval(card.companyId, view.id, view.hash, reason, outbound) : approveApproval(card.companyId, view.id, view.hash, reason))
        : kind === 'send-back'
          ? await (outbound ? sendBackApproval(card.companyId, view.id, reason, outbound) : sendBackApproval(card.companyId, view.id, reason))
          : await (outbound ? withdrawApproval(card.companyId, view.id, outbound) : withdrawApproval(card.companyId, view.id))
      putApproval(key, r)
      if (!r.success) {
        setMessage({ tone: r.offline ? 'warn' : 'error', text: r.offline ? `${r.error} 承認できたかどうかは、開き直すと分かります。` : r.error })
        // The content changed (or the state moved): show what the server holds now.
        if (!r.approval && (r.code === 'CONTENT_CHANGED' || r.code === 'NOT_PENDING')) {
          putApproval(key, await (outbound ? getApproval(card.companyId, view.id, outbound) : getApproval(card.companyId, view.id)))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    return (
      <div role="group" aria-label="承認のお願い" className={`my-2 rounded-xl border p-3 text-xs text-gray-600 dark:text-zinc-300 ${TONE_CLASS.plain}`}>
        {loadError ?? '承認のお願いを読み込んでいます…'}
      </div>
    )
  }

  const pending = view.state === 'pending'
  const canAnswer = pending && view.viewerMayApprove
  const canWithdraw = view.viewerIsRequester && (pending || view.state === 'sent_back')
  return (
    <div role="group" aria-label="承認のお願い" data-state={view.state} className={`my-2 rounded-xl border p-3 ${TONE_CLASS[STATE_TONE[view.state]]}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-zinc-100">
        <StateIcon state={view.state} />
        承認のお願い：{view.operationLabel}
        {view.requestedByAi && <span className="ml-auto flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-normal text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Robot size={12} aria-hidden />AI の案から
        </span>}
      </div>
      {view.recordTitle && <p className="mt-1 text-sm text-gray-800 dark:text-zinc-200">{view.recordTitle}</p>}
      {view.changes.length > 0 && <ul aria-label="変える欄" className="mt-2 space-y-1">
        {view.changes.map(c => <li key={c.field} className="flex flex-wrap items-center gap-1.5 text-xs text-gray-800 dark:text-zinc-200">
          <span className="text-gray-500 dark:text-zinc-400">{c.label}</span>
          <span>{c.beforeShown}</span><ArrowRight size={11} aria-hidden /><span className="sr-only">から</span>
          <span className="font-medium">{c.afterShown}</span>
          {percentText(c.changePercent) && <span className="text-gray-500 dark:text-zinc-400">（{percentText(c.changePercent)}）</span>}
        </li>)}
      </ul>}
      {view.create && <div className="mt-2 text-xs text-gray-800 dark:text-zinc-200">
        <p>作るもの：<span className="font-medium">{view.create.title}</span></p>
        {view.create.fields.length > 0 && <ul className="mt-1">{view.create.fields.map(f => <li key={f.label}>{f.label}：{f.shown}</li>)}</ul>}
      </div>}
      {view.similar && <div className="mt-2 text-xs text-gray-700 dark:text-zinc-300">
        <p className="text-gray-500 dark:text-zinc-400">似ているもの（すでにあるもの）</p>
        {view.similar.length === 0 ? <p>見つかりませんでした</p> : <ul aria-label="似ているもの">{view.similar.map(x => <li key={x.recordId}>{x.title ?? '（件名なし）'}</li>)}</ul>}
      </div>}
      {view.basis.quote && <div className="mt-2 text-xs text-gray-700 dark:text-zinc-300">
        <p className="text-gray-500 dark:text-zinc-400">理由（{view.basis.minutesTitle ? `議事録「${view.basis.minutesTitle}」` : '議事録'}の引用）</p>
        <blockquote className="mt-0.5 border-l-2 border-gray-300 pl-2 dark:border-zinc-600">{view.basis.quote}</blockquote>
      </div>}
      <div className="mt-2 text-xs text-gray-700 dark:text-zinc-300">
        <p className="text-gray-500 dark:text-zinc-400">前例（同じ部署の、同じ欄の承認：{view.precedents.total} 件）</p>
        {view.precedents.items.length === 0 ? <p>見られる前例はありません</p> : <ul aria-label="前例" className="mt-0.5 space-y-0.5">
          {view.precedents.items.map(p => <li key={p.approvalId}>
            {`${p.at.slice(0, 10)}・${p.fields.map(f => `${f.label} ${f.beforeShown} → ${f.afterShown}`).join('、')}・${p.state === 'approved' ? '承認' : '差し戻し'}`}
            {p.reason ? `：${p.reason}` : ''}
            {p.nowShown && p.nowShown.length > 0 ? `（その後：${p.nowShown.map(n => `${n.label} ${n.shown}`).join('、')}）` : ''}
          </li>)}
        </ul>}
      </div>
      {view.materials.length > 0 && <div className="mt-2 text-xs text-gray-700 dark:text-zinc-300">
        <p className="text-gray-500 dark:text-zinc-400">材料</p>
        <ul aria-label="材料">{view.materials.map(m => <li key={m.recordId}>{m.kind === 'minutes' ? '議事録' : '記録'}「{m.title}」{m.version !== null ? `（お願いしたときの版 ${m.version}）` : ''}</li>)}</ul>
      </div>}
      {view.proposedReason && <p className="mt-2 text-xs text-gray-500 dark:text-zinc-400">{view.requestedByAi ? 'AI のまとめ（参考）' : 'お願いした人のまとめ'}：{view.proposedReason}</p>}
      <p role="status" className="mt-2 text-xs text-gray-800 dark:text-zinc-200">{stateLine(view, names)}</p>
      {!pending && view.state !== 'sent_back' && view.outcome && <p className="mt-0.5 text-[11px] text-gray-500 dark:text-zinc-400">{nameOf(names, view.outcome.by)}さん・{view.outcome.at.slice(0, 16).replace('T', ' ')}</p>}
      {message && <div role="alert" className={`mt-2 rounded-lg border px-2 py-1.5 text-xs ${TONE_CLASS[message.tone]}`}>{message.text}</div>}
      {canAnswer && <div className="mt-2">
        <label className="block text-xs text-gray-600 dark:text-zinc-300">
          理由（必ず書いてください。AI の下書きを直せます）
          <textarea value={reason} onChange={e => setEdited(e.target.value)} rows={3} maxLength={2000}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 text-xs text-gray-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100" />
        </label>
        <p className="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">{APPROVE_HASH_NOTE}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <button type="button" disabled={busy || reason.trim() === ''} onClick={() => void act('approve')}
            className={`${BUTTON} border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700`}>{busy ? '確かめています…' : '承認'}</button>
          <button type="button" disabled={busy || reason.trim() === ''} onClick={() => void act('send-back')}
            className={`${BUTTON} border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800`}>差し戻す</button>
        </div>
      </div>}
      {canWithdraw && !canAnswer && <div className="mt-2">
        <button type="button" disabled={busy} onClick={() => void act('withdraw')}
          className={`${BUTTON} border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800`}>取り下げる</button>
      </div>}
    </div>
  )
}, (prev, next) => prev.card.id === next.card.id)
