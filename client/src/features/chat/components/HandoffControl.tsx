import ReactMarkdown from 'react-markdown'
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { Note, X } from '@phosphor-icons/react'
import type { HandoffView } from '../../../../shared/handoff'
import { agentShortLabel } from '../../../../shared/agents/registry'
import { getHandoff, onHandoffChanged, updateHandoff } from '../api'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

export interface HandoffControlHandle { open: () => void }

/**
 * The hand-off memo (引き継ぎメモ) of one consultation. Its line under the header shows only once a memo
 * exists or is being made (owner FB 2026-11-27: 「未作成」 on every consultation was noise); the dialog
 * always opens from the header's 「…」 (`open`), so updating it by hand stays possible before the first one.
 */
export const HandoffControl = forwardRef<HandoffControlHandle, { companyId: string; sessionId: string; active?: boolean }>(function HandoffControl({ companyId, sessionId, active = true }, ref) {
  const [view, setView] = useState<HandoffView | null>(null)
  const [error, setError] = useState('')
  const refreshRef = useRef<() => void>(() => {})
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let alive = true
    setView(null); setError(''); dialog.current?.close()
    const refresh = () => void getHandoff(companyId, sessionId).then(value => { if (alive) { setView(value); setError('') } }).catch(() => { if (alive) setError('引き継ぎメモを読み込めませんでした。履歴は保持されています。') })
    refreshRef.current = refresh
    refresh()
    const off = onHandoffChanged(scope => { if (scope.companyId === companyId && scope.sessionId === sessionId) refresh() })
    return () => { alive = false; off() }
  }, [companyId, sessionId])
  useEffect(() => { if (!active) dialog.current?.close() }, [active])
  const openDialog = () => { refreshRef.current(); dialog.current?.showModal() }
  useImperativeHandle(ref, () => ({ open: openDialog }))
  async function update() {
    try { await updateHandoff(companyId, sessionId); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : '更新を開始できませんでした') }
  }
  const label = view?.status === 'running' ? '整理中…' : view?.status === 'queued' ? '更新待ち' : view?.status === 'error' || error ? '更新を確認' : view?.status === 'unsupported' ? '未対応' : view?.updatedAt ? `${new Date(view.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 保存` : '未作成'
  const recoveryLabel = view?.recovery?.status === 'recovering' ? '文脈を引き継いで再接続中…' : view?.recovery?.status === 'recovered' ? `${view.recovery.usedMemo ? 'メモと会話' : '保存した会話'}から再接続しました` : view?.recovery?.status === 'error' ? '再接続を完了できませんでした。履歴とメモは残っています。' : null
  const lineShown = !!view?.updatedAt || view?.status === 'running' || view?.status === 'queued'
  return <>
    {lineShown && <button type="button" onClick={openDialog} className="flex items-center gap-1 px-4 py-1 text-caption font-normal text-text-muted hover:text-link" aria-label="引き継ぎメモを確認">
      <Note size={12} />引き継ぎメモ：{label}
    </button>}
    {recoveryLabel && <p role="status" className="px-4 text-caption font-normal text-text-muted">{recoveryLabel}</p>}
    <dialog ref={dialog} className="m-auto w-[min(var(--size-dialog-lg),90vw)] max-h-[85vh] rounded-card border border-[color:var(--color-border)] bg-surface-raised text-text shadow-dialog p-dialog backdrop:bg-scrim" aria-labelledby={titleId}>
      <div className="flex justify-between items-center gap-3"><h2 id={titleId} className="text-title">引き継ぎメモ</h2><button type="button" aria-label="引き継ぎメモを閉じる" onClick={() => dialog.current?.close()} className="p-2 rounded-small hover:bg-gray-100 dark:hover:bg-zinc-800"><X size={16} /></button></div>
      <p className="mt-2 text-xs text-gray-500">同じ相談を長く続けるための要点です。元の履歴は残ります。相談を閉じてもメモは残り、相談を削除するとメモも削除されます。</p>
      <p className="mt-3 text-xs" role="status">{view?.message || '読み込み中…'}</p>
      {recoveryLabel && <p className="mt-2 text-xs text-gray-500">{recoveryLabel}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      {view?.updatedAt && <p className="mt-2 text-caption font-normal text-gray-500">保存日時：{new Date(view.updatedAt).toLocaleString('ja-JP')} · {agentShortLabel(view.provider)}{view.metrics && ` · ${(view.metrics.totalMs / 1000).toFixed(1)}秒`}</p>}
      <div className="mt-4 break-words text-xs leading-6 bg-gray-50 dark:bg-zinc-800 rounded-control p-3 max-h-[45vh] overflow-auto prose prose-sm dark:prose-invert max-w-none [&_h2]:text-sm [&_h2]:mt-3 [&_h2]:mb-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0">
        <ReactMarkdown components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{view?.markdown || 'メモはまだありません。応答が正常に終了して保存された会話が対象です。'}</ReactMarkdown>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-caption font-normal text-gray-500">自動更新：16往復または約12,000文字から。<br />同じ相談は10分間隔、全体で最大4回／時。</p>
        <button type="button" disabled={!view?.canUpdate} onClick={() => void update()} className={`rounded-control px-3 py-2 text-xs shrink-0 ${PRIMARY_ACTION}`}>メモを更新</button>
      </div>
      <p className="mt-2 text-[10px] text-gray-400">手動更新も利用量の上限内で実行します。AIの要約なので、重要な判断は元の履歴でも確認してください。</p>
    </dialog>
  </>
})
