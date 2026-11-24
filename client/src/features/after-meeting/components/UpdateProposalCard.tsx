// The update proposal card (4b-4 PR6-A, owner memo 「4b-4 挟む部分」 S3 / S4 / S11): the run's 更新案.json on this PC, edited and
// ticked by the member, handed to ONE consultation by ［反映する］ after a last check (the consultation does the writing: plugin
// operations, approvals, the Skill's scripts). Kept whole (~300 lines): the items, the press and its results change together.
import { useCallback, useRef, useState } from 'react'
import { CheckCircle, Hourglass, Plus, WarningOctagon } from '@phosphor-icons/react'
import { runCommand } from '../../../shared/commands/commands'
import { Button, Callout } from '../../../shared/ui/primitives'
import { Dialog, DialogFooter, DialogTitle } from '../../../shared/ui/Dialog'
import { useInterval } from '../../../shared/hooks/useInterval'
import { itemStatus, mayUndoHubspot, mayUndoSheet, type AfterMeetingRead, type UpdateTarget } from '../../../../shared/after-meeting'
import { noteAfterMeeting, readAfterMeeting, undoHubspotWrite } from '../api'
import {
  ADDABLE_HUBSPOT_ITEMS, addedItem, applyAsk, cardNotes, cardOffers, draftsFrom, edited, handedOf, itemsToApply, newPressId, redoDraftAsk, shareDraftAsk, sheetUndoAsk,
  statusText, statusTone, valueProblem, valueText, type DraftItem,
} from '../model'
import { ValueEditor } from './ValueEditor'
import { DraftButtons } from './DraftButtons'

type Loaded = Extract<AfterMeetingRead, { run: object }>

export interface CardTask { id: string; title: string; madeAt: string | null; open: boolean }

export function UpdateProposalCard({ companyId, rootPath, occurrenceId, task }: { companyId: string; rootPath: string; occurrenceId: string; task: CardTask }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [items, setItems] = useState<DraftItem[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [adding, setAdding] = useState<{ target: UpdateTarget; deal: string; item: string; problem: string | null } | null>(null)
  // One press at a time, also between a click and the state change (a double click); main checks again.
  const pressing = useRef(false)
  const loadedFor = useRef<string | null>(null)

  const reload = useCallback(async () => {
    const r = await readAfterMeeting(companyId, rootPath, occurrenceId).catch(() => null)
    if (!r?.success) { setMessage(r ? r.error : 'この PC の更新案を読めませんでした。'); return }
    if (!r.run) return
    setData(r)
    // The member's edits stay while the card is open; the file is read once for them.
    setItems(prev => prev ?? draftsFrom(r.proposals))
  }, [companyId, rootPath, occurrenceId])
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === occurrenceId) return
    loadedFor.current = occurrenceId
    void reload()
  }, [occurrenceId, reload])

  const now = Date.now()
  const statusOf = (key: string) => itemStatus(key, data?.mark ?? { v: 1, applies: [], undone: [], draftDismissed: false }, data?.results ?? [], now)
  const offers = items ? cardOffers(items, statusOf) : null
  // While a consultation works on it, its result is read again now and then (it writes result.json on this PC).
  useInterval(() => { void reload() }, offers?.pending ? 15_000 : null)

  if (!data) return <div ref={loadRef} />
  const run = data.run
  const list = items ?? []
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  const disabled = working || !task.open
  const change = (key: string, patch: Partial<DraftItem>) => setItems(xs => (xs ?? []).map(x => (x.key === key ? { ...x, ...patch } : x)))
  const chosen = itemsToApply(list, statusOf)
  const notes = cardNotes({ confidence: run.confidence, runAt: run.at, statuses: list.map(d => statusOf(d.key)), now })
  const unapplied = list.filter(d => statusOf(d.key).kind === 'new').length
  const work = (detail: string) => runCommand('chat.consultAbout', { recordId: task.id, title: task.title, purpose: 'work', ...(task.madeAt ? { madeAt: task.madeAt } : {}), detail })

  const press = async (kind: 'apply' | 'undo') => {
    if (pressing.current) return
    pressing.current = true
    setWorking(true)
    setMessage(null)
    try {
      const id = newPressId(kind)
      const sheet = list.map(d => ({ d, s: statusOf(d.key) })).filter(x => mayUndoSheet(x.s))
      const keys = kind === 'apply' ? chosen.map(d => d.key) : sheet.map(x => x.d.key)
      if (keys.length === 0) return
      const r = await noteAfterMeeting(companyId, rootPath, occurrenceId, { kind, id, keys })
      if (!r.success) { setMessage(r.error); await reload(); return }
      setData({ ...data, mark: r.mark })
      const detail = kind === 'apply'
        ? applyAsk({ pressId: id, folder: run.folder, meetingId: data.meetingId, minutesDocVersion: run.minutesDocVersion, items: chosen })
        : sheetUndoAsk({ pressId: id, folder: run.folder, items: sheet.flatMap(({ d, s }) => (s.kind === 'result' && s.result.前の値 !== undefined && s.result.書いた値 !== undefined ? [{ 取引: d.取引, 項目: d.項目, 前の値: s.result.前の値, 書いた値: s.result.書いた値 }] : [])) })
      void work(detail)
      setMessage(kind === 'apply'
        ? '反映の相談を始めました。HubSpot と係数表に書くのは、その相談の AI です（承認が要るものは承認のお願いになります）。結果はここに出ます。'
        : '係数表を元に戻す相談を始めました。結果はここに出ます。')
    } finally {
      pressing.current = false
      setWorking(false)
      setChecking(false)
    }
  }

  const undoHubspot = async (d: DraftItem) => {
    const s = statusOf(d.key)
    if (!mayUndoHubspot(s) || pressing.current) return
    pressing.current = true
    setWorking(true)
    try {
      const r = await undoHubspotWrite(companyId, s.result.プラグイン, s.result.操作)
      if (!r.success) { setMessage(r.error); return }
      const n = await noteAfterMeeting(companyId, rootPath, occurrenceId, { kind: 'undone', key: d.key })
      if (n.success) setData({ ...data, mark: n.mark })
      setMessage('HubSpot の値を元に戻しました（HubSpot のワークフローや通知は戻りません）。')
    } finally {
      pressing.current = false
      setWorking(false)
    }
  }

  const add = () => {
    if (!adding) return
    const made = addedItem(list, adding.target, adding.deal, adding.item)
    if ('problem' in made) { setAdding({ ...adding, problem: made.problem }); return }
    setItems([...list, made])
    setAdding(null)
  }

  return (
    <section aria-label="会議のあとの更新案" className="space-y-3 rounded-card border border-border bg-surface-raised p-3 text-small text-text">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-title font-strong">HubSpot・係数表の更新案</h3>
        {unapplied > 0 && <span className="text-text-muted">反映していない更新案が {unapplied} 件あります</span>}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={working} onClick={() => void reload()}>読み直す</Button>
      </div>
      {notes.map(n => <Callout key={n} tone="warning">{n}</Callout>)}
      {data.problem === 'version' && <Callout tone="warning">このアプリでは表示できない形の更新案です。アプリを新しくしてください。</Callout>}
      {data.problem === 'shape' && <Callout tone="warning">更新案のファイルを読めませんでした（形が違います）。［作り直す］で作り直せます。</Callout>}
      {data.problem === null && list.length === 0 && <p className="text-text-muted">この回には更新案がありません。</p>}
      <ul className="space-y-2">
        {list.map(d => {
          const s = statusOf(d.key)
          const tone = statusTone(s)
          const line = statusText(s)
          const editable = !disabled && (s.kind === 'new' || s.kind === 'stopped' || (s.kind === 'result' && (s.result.状態 === '失敗' || s.result.状態 === '反映しない')))
          const problem = valueProblem(d.値)
          return (
            <li key={d.key} aria-label={`${d.取引} の ${d.項目}`} className="space-y-1.5 rounded-control border border-border bg-surface p-2">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={d.on} disabled={!editable} onChange={e => change(d.key, { on: e.target.checked })} />
                  <span className="font-strong">{d.書き先 === 'hubspot' ? 'HubSpot' : '係数表'}・{d.項目}</span>
                </label>
                <span className="text-text-muted">取引：{d.取引}</span>
                {edited(d) && <span className="rounded-small bg-selected-bg px-1 text-selected-text">直しました</span>}
                {d.proposed === null && <span className="rounded-small bg-selected-bg px-1 text-selected-text">足した項目</span>}
                {!d.on && s.kind === 'new' && <span className="text-text-muted">反映しない</span>}
              </div>
              {editable && d.on ? <ValueEditor item={d} stages={data.stages} disabled={!editable} onChange={v => change(d.key, { 値: v })} /> : <p>{valueText(d.値)}</p>}
              {problem && d.on && editable && <p role="alert" className="text-danger-text">{problem}</p>}
              {edited(d) && d.proposed !== null && <p className="text-text-muted">AI の案：{valueText(d.proposed)}</p>}
              {d.理由 && <p className="text-text-muted">理由：{d.理由}</p>}
              {d.根拠 && <p className="text-text-muted">議事録の引用：「{d.根拠}」</p>}
              {editable && d.on && (d.理由 || d.根拠) && (
                <div className="flex flex-wrap gap-3 text-text-muted">
                  {d.理由 && <label className="inline-flex items-center gap-1"><input type="checkbox" checked={d.shareReason} onChange={e => change(d.key, { shareReason: e.target.checked })} />理由を HubSpot・承認に渡す</label>}
                  {d.根拠 && <label className="inline-flex items-center gap-1"><input type="checkbox" checked={d.shareQuote} onChange={e => change(d.key, { shareQuote: e.target.checked })} />議事録の引用も渡す</label>}
                </div>
              )}
              {line && (
                <p role="status" className={`flex items-center gap-1 ${tone === 'failed' ? 'text-danger-text' : tone === 'done' ? 'text-success-text' : tone === 'waiting' ? 'text-awaiting-text' : 'text-text-muted'}`}>
                  {tone === 'done' && <CheckCircle size={14} weight="fill" />}{tone === 'failed' && <WarningOctagon size={14} weight="fill" />}{tone === 'waiting' && <Hourglass size={14} weight="fill" />}
                  {line}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {s.kind === 'result' && s.result.状態 === '承認待ち' && s.result.承認 && (
                  <Button size="sm" onClick={() => void runCommand('record.open', { recordId: s.result.承認! })}>開く</Button>
                )}
                {mayUndoHubspot(s) && <Button size="sm" disabled={working} onClick={() => void undoHubspot(d)}>この項目を元に戻す</Button>}
              </div>
            </li>
          )
        })}
      </ul>
      {adding ? (
        <div role="group" aria-label="項目を足す" className="space-y-2 rounded-control border border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="書き先" className="rounded-control border border-border-control bg-bg px-2 py-1" value={adding.target} onChange={e => setAdding({ ...adding, target: e.target.value as UpdateTarget, item: '' })}>
              <option value="hubspot">HubSpot</option><option value="係数表">係数表</option>
            </select>
            <input aria-label="取引" placeholder="取引（HubSpot の番号、または 新規:会社名）" className="min-w-0 flex-1 rounded-control border border-border-control bg-bg px-2 py-1" list={`deals-${occurrenceId}`} value={adding.deal} onChange={e => setAdding({ ...adding, deal: e.target.value })} />
            <datalist id={`deals-${occurrenceId}`}>{[...new Set(list.map(d => d.取引))].map(x => <option key={x} value={x} />)}</datalist>
            {adding.target === 'hubspot'
              ? <select aria-label="項目" className="rounded-control border border-border-control bg-bg px-2 py-1" value={adding.item} onChange={e => setAdding({ ...adding, item: e.target.value })}>
                  <option value="">項目を選ぶ</option>{ADDABLE_HUBSPOT_ITEMS.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              : <input aria-label="項目" placeholder="係数表の項目" className="rounded-control border border-border-control bg-bg px-2 py-1" value={adding.item} onChange={e => setAdding({ ...adding, item: e.target.value })} />}
          </div>
          {adding.problem && <p role="alert" className="text-danger-text">{adding.problem}</p>}
          <div className="flex gap-2"><Button size="sm" onClick={add}>足す</Button><Button size="sm" variant="ghost" onClick={() => setAdding(null)}>やめる</Button></div>
        </div>
      ) : task.open && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setAdding({ target: 'hubspot', deal: list[0]?.取引 ?? '', item: '', problem: null })}><Plus size={12} />項目を足す</Button>}
      <div className="flex flex-wrap items-center gap-2">
        {offers?.apply && task.open && (
          <Button size="sm" variant="primary" disabled={disabled || offline || chosen.length === 0} onClick={() => setChecking(true)}>
            {offers.apply === 'rest' ? '残りを反映する' : '反映する'}
          </Button>
        )}
        {offers?.pending && <Button size="sm" variant="primary" disabled>反映中…</Button>}
        {offers?.sheetUndo && task.open && <Button size="sm" disabled={disabled || offline} onClick={() => void press('undo')}>係数表を元に戻す</Button>}
        {offline && <span className="text-text-muted">オフラインです。つながったら押してください。</span>}
      </div>
      {message && <p role="status" className="text-text-muted">{message}</p>}
      {!data.mark.draftDismissed && (run.decision === 'proceed' || run.decision === 'ask') && task.open && (
        <DraftButtons disabled={disabled} onRedo={hint => void work(redoDraftAsk(run.folder, hint))} onShare={() => void work(shareDraftAsk(run.folder))}
          onDismiss={async () => {
            const r = await noteAfterMeeting(companyId, rootPath, occurrenceId, { kind: 'draft-dismissed' })
            if (r.success) setData({ ...data, mark: r.mark }); else setMessage(r.error)
          }} />
      )}
      {checking && (
        // The last check (S11 #1): exactly what goes to HubSpot, the approvals and the coefficient sheet, right before the press.
        <Dialog onClose={() => setChecking(false)} labelledBy="after-meeting-check" size="lg" dismissible={!working}>
          <DialogTitle id="after-meeting-check">この内容で反映しますか？</DialogTitle>
          <p className="mt-2 text-body text-text-muted">次の {chosen.length} 件だけを、相談の AI に渡します。HubSpot・承認のお願い・係数表に出るのは、ここにあるものだけです。</p>
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-body">
            {chosen.map(d => {
              const h = handedOf(d)
              return (
                <li key={d.key} className="rounded-control border border-border p-2">
                  <p className="font-strong">{d.書き先 === 'hubspot' ? 'HubSpot' : '係数表'}・{d.項目}（{d.取引}）</p>
                  <p>{valueText(d.値)}</p>
                  {typeof h.理由 === 'string' && <p className="text-text-muted">理由：{h.理由}</p>}
                  {typeof h.引用 === 'string' && <p className="text-text-muted">議事録の引用：「{h.引用}」</p>}
                </li>
              )
            })}
          </ul>
          <DialogFooter>
            <Button onClick={() => setChecking(false)} disabled={working}>やめる</Button>
            <Button variant="primary" disabled={working} onClick={() => void press('apply')}>この内容で反映する</Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  )
}

