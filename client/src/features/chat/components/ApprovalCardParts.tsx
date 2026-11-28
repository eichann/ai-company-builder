// The approval card's parts that only draw (props in, JSX out): what changes, the folded rows and the duplicate check.
// The presses, the reason and the hash sent stay in ApprovalCard.tsx, so what is shown and what is sent come from one view.
import type { ReactNode } from 'react'
import { ArrowRight, CaretRight, CheckCircle } from '@phosphor-icons/react'
import { Button, StatusBadge } from '../../../shared/ui/primitives'
import { STATE_BOX } from '../../../shared/ui/stateStyles'
import { nameOf, percentText } from '../../../../shared/approvals'
import type { ApprovalView, SimilarRecord } from '../../../../../shared/types/approvals'
import { basisSummary } from '../approvalCard'

/** ① What changes, large: the value before struck through, the value after, and the change in percent. */
export function ChangeSection({ view }: { view: ApprovalView }) {
  return (
    <section aria-label="何がどう変わるか" className="mt-2">
      {view.recordTitle && <p className="text-small text-text-muted">{view.recordTitle}</p>}
      {view.changes.length > 0 && <ul aria-label="変える欄" className="space-y-1">
        {view.changes.map(c => <li key={c.field} className="mt-1">
          <p className="text-small text-text-muted">{c.label}</p>
          <p className="flex flex-wrap items-center gap-2 text-heading text-text">
            <span className="text-text-muted line-through">{c.beforeShown}</span>
            <ArrowRight size={16} aria-hidden className="text-text-subtle" /><span className="sr-only">から</span>
            <span className="font-strong">{c.afterShown}</span>
            {percentText(c.changePercent) && <StatusBadge variant="neutral" icon={null}>{percentText(c.changePercent)}</StatusBadge>}
          </p>
        </li>)}
      </ul>}
      {view.create && <div className="mt-1">
        <p className="text-small text-text-muted">新しく作る{view.similar?.typeLabel ?? 'もの'}</p>
        <p className="text-heading font-strong text-text">{view.create.title}</p>
        {view.create.fields.length > 0 && <ul aria-label="作るものの中身" className="mt-0.5 text-body text-text">
          {view.create.fields.map(f => <li key={f.label}><span className="text-text-muted">{f.label}：</span>{f.shown}</li>)}
        </ul>}
      </div>}
    </section>
  )
}

/** One folded row: its summary says what is inside, so an empty one is a single quiet line, never a block. */
function Fold({ summary, empty, children }: { summary: ReactNode; empty?: boolean; children?: ReactNode }) {
  if (empty) return <p className="flex items-center gap-1 py-1 text-small text-text-subtle"><span className="inline-block w-3" aria-hidden />{summary}</p>
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-small py-1 text-small text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <CaretRight size={12} aria-hidden className="flex-shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 truncate">{summary}</span>
      </summary>
      <div className="mb-1 ml-4 text-small text-text">{children}</div>
    </details>
  )
}

/** The basis (the minutes' quote, the materials), precedents and similar requests: one line each, unfolded on demand. */
export function BasisFolds({ view, names }: { view: ApprovalView; names: Record<string, string> }) {
  const basis = basisSummary(view)
  const requests = view.similarRequests ?? []
  return (
    <div className="mt-2 border-t border-[color:var(--color-border)] pt-1">
      {basis ? <Fold summary={basis}>
        {view.basis.quote && <>
          <p className="text-caption text-text-muted">{view.basis.meetingTitle ? `会議「${view.basis.meetingTitle}」の議事録から` : '議事録から'}</p>
          <blockquote className="mt-0.5 whitespace-pre-wrap border-l-2 border-border-control pl-2">{view.basis.quote}</blockquote>
        </>}
        {view.materials.length > 0 && <ul aria-label="材料" className="mt-1 space-y-0.5 text-text-muted">
          {view.materials.map(m => <li key={m.recordId}>{m.kind === 'meeting' ? '会議' : '記録'}「{m.title}」{m.version !== null ? `（お願いしたときの版 ${m.version}）` : ''}</li>)}
        </ul>}
      </Fold> : <Fold summary="根拠：なし" empty />}
      {view.precedents.total > 0 ? <Fold summary={`前例（同じ部署・同じ欄の承認）：${view.precedents.total} 件`}>
        {view.precedents.items.length === 0 ? <p className="text-text-muted">見られる前例はありません</p> : <ul aria-label="前例" className="space-y-1">
          {view.precedents.items.map(p => <li key={p.approvalId}>
            <span className="text-text-muted">{p.at.slice(0, 10)}</span>{' '}
            {p.fields.map(f => `${f.label} ${f.beforeShown} → ${f.afterShown}`).join('、')}{' '}
            <StatusBadge variant={p.state === 'approved' ? 'success' : 'warning'} icon={null}>{p.state === 'approved' ? '承認' : '差し戻し'}</StatusBadge>
            {p.reason && <span className="block text-text-muted">{p.reason}</span>}
            {p.nowShown && p.nowShown.length > 0 && <span className="block text-text-subtle">（その後：{p.nowShown.map(n => `${n.label} ${n.shown}`).join('、')}）</span>}
          </li>)}
        </ul>}
      </Fold> : <Fold summary="前例：なし" empty />}
      {requests.length > 0 && <Fold summary={`似ているお願い（まだ承認待ちのもの）：${requests.length} 件`}>
        <ul aria-label="似ているお願い" className="space-y-0.5">{requests.map(x => <li key={x.approvalId}>
          <span className="font-strong">{x.title || '（名前なし）'}</span>
          <span className="text-text-muted">{`・${nameOf(names, x.requestedBy)}さんのお願い・${x.createdAt.slice(0, 10)}${x.sameSource ? '・同じ会議から' : ''}`}</span>
        </li>)}</ul>
      </Fold>}
    </div>
  )
}

/** Why a similar record is listed, in the person's words. */
function matchedText(x: SimilarRecord, systemLabel: string): string {
  if (x.matchedBy === 'counterpart') return '同じ相手'
  if (x.matchedBy === 'outside') return `${systemLabel} で見つかりました`
  return '名前が似ています'
}

/**
 * ② A new record with similar ones listed: before 「承認する」, the person says whether it is one of them (「同じ」 makes
 * nothing) or a new one. `chosen`: 「別の…として作る」 was chosen for the content shown now.
 */
export function DuplicateCheck({ view, names, chosen, actable, locked, linkMeeting, onLinkMeeting, onSame, onDistinct, onChooseAgain }: {
  view: ApprovalView
  names: Record<string, string>
  chosen: boolean
  /** The viewer may answer or withdraw: only then are 「同じ」 / 「別」 offered. */
  actable: boolean
  locked: boolean
  linkMeeting: boolean
  onLinkMeeting: (on: boolean) => void
  onSame: (recordId: string) => void
  onDistinct: () => void
  onChooseAgain: () => void
}) {
  const similar = view.similar
  if (!similar) return null
  const items = similar.items
  const outsideNote = similar.outside === 'unavailable' && <p className="mt-1 text-caption text-text-muted">{view.systemLabel} にはいま聞けませんでした（ACB にあるものだけを出しています）</p>
  if (items.length === 0) return <div className="mt-2 text-small text-text-muted"><p>似ているもの（すでにある{similar.typeLabel}）：見つかりませんでした</p>{outsideNote}</div>
  const list = (
    <ul aria-label="似ているもの" className="mt-1.5 space-y-1.5">{items.map(x => (
      <li key={x.recordId} className="flex flex-wrap items-center gap-2 rounded-control border border-[color:var(--color-border)] bg-surface-raised px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-small font-strong text-text">{x.title || '（件名なし）'}</p>
          <p className="text-caption text-text-muted">{[x.status, x.assignee ? `担当 ${nameOf(names, x.assignee)}さん` : null, `更新 ${x.updatedAt.slice(0, 10)}`, matchedText(x, view.systemLabel)].filter(Boolean).join('・')}</p>
        </div>
        {actable && !chosen && <Button size="sm" variant="secondary" disabled={locked} onClick={() => onSame(x.recordId)}>これと同じ{similar.typeLabel}です（作らない）</Button>}
      </li>
    ))}</ul>
  )
  if (!actable) return <section aria-label="同じものがないか" className="mt-2"><p className="text-small text-text-muted">似ているもの（すでにある{similar.typeLabel}）</p>{list}{outsideNote}</section>
  return (
    <section aria-label="同じものがないか" className={`mt-3 rounded-control border p-2 ${chosen ? STATE_BOX.plain : STATE_BOX.warn}`}>
      {chosen ? (
        <p className="flex flex-wrap items-center gap-1.5 text-small text-text">
          <CheckCircle size={14} weight="bold" aria-hidden className="text-success-icon" />
          すでにある{similar.typeLabel}とは別の{similar.typeLabel}として作ります
          <button type="button" disabled={locked} onClick={onChooseAgain} className="ml-auto text-small text-link hover:underline disabled:opacity-disabled">選び直す</button>
        </p>
      ) : <>
        <p className="text-small font-strong text-text">まず確かめてください：すでにある{similar.typeLabel}と同じではありませんか？</p>
        {list}
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" disabled={locked} onClick={onDistinct}>別の{similar.typeLabel}として作る</Button>
          {view.basis.meetingId && <label className="flex items-center gap-1 text-caption text-text-muted">
            <input type="checkbox" checked={linkMeeting} onChange={e => onLinkMeeting(e.target.checked)} />同じだったら、会議もその{similar.typeLabel}につなぐ
          </label>}
        </div>
      </>}
      {outsideNote}
    </section>
  )
}
