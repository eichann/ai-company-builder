import { useCallback, useState, type ReactNode } from 'react'
import { CircleNotch, PencilSimpleLine, Sparkle, TreeStructure } from '@phosphor-icons/react'
import { bundleTileAction, type BundleAction, type BundleActions, type BundleDetailView, type BundleTileField } from '../../../../shared/record-details'
import type { RecordCardView } from '../../../../shared/record-views'
import { CALM } from '../../../../shared/thing-words'
import { commandArea, runCommand } from '../../../shared/commands/commands'
import { workListRef } from '../../../shared/lib/workThrough'
import { WorkThroughNotice } from '../../../shared/ui/WorkThrough'
import { InlineDate } from '../../../shared/ui/InlineDate'
import { InlineText } from '../../../shared/ui/InlineText'
import { Button } from '../../../shared/ui/primitives'
import { ThingIcon } from '../../../shared/ui/ThingIcon'

/**
 * 責任者, chosen where it is shown: pressed, the name turns into the list of members (the member first, 「自分」) and
 * ［替える］. Only ［替える］ (or Enter) saves — an arrow key or a typed letter on the list only moves the choice, since a
 * new 責任者 is told (independent review); Esc or leaving puts it back unchanged. A refusal stays under it.
 */
function InlinePerson({ value, label, people, busy, children, onSave }: { value: string | null; label: string; people: BundleActions['people']; busy: boolean; children: ReactNode; onSave: (id: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choose = async (id: string) => {
    if (saving || !id || id === value) { setOpen(false); return }
    setSaving(true)
    try {
      const failure = await onSave(id)
      if (failure === null) { setOpen(false); setError(null) } else setError(failure)
    } finally { setSaving(false) }
  }
  if (!open) {
    return (
      <span className="block">
        <button type="button" disabled={busy} aria-label={label} title={label} onClick={() => { setError(null); setDraft(value ?? ''); setOpen(true) }}
          className="group -mx-1 inline-flex items-center gap-1 rounded-small px-1 text-left hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-disabled">
          {children}<PencilSimpleLine aria-hidden size={14} className="shrink-0 text-text-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
        {error && <span role="alert" className="block text-small font-normal text-danger-text">{error}</span>}
      </span>
    )
  }
  return (
    <span className="block space-y-1"
      // Leaving the list and its button (not moving between them) puts it back.
      onBlur={e => { if (!saving && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void choose(draft) }
      }}>
      <span className="flex items-center gap-1.5">
        <select aria-label="責任者" autoFocus value={draft} disabled={saving} onChange={e => setDraft(e.target.value)}
          className="-mx-1 block min-w-0 flex-1 rounded-small border border-border-control bg-bg px-1 py-0.5 text-body font-normal text-text focus:border-focus-border focus:outline-none">
          {!value && <option value="">選んでください</option>}
          {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Button size="sm" variant="primary" disabled={saving || !draft || draft === value} onClick={() => void choose(draft)}>替える</Button>
      </span>
      {error && <span role="alert" className="block text-small font-normal text-danger-text">{error}</span>}
    </span>
  )
}

const shortDue = (due: string | null) => {
  const m = due?.match(/^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/)
  return m ? `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}` : null
}

/** What the tiles need to correct a field in place: the card's actions and its press (the server decides each). */
export interface BundleTileEdit {
  actions: BundleActions
  busy: boolean
  onAct: (action: BundleAction, args: Record<string, string>) => Promise<string | null>
}

/** Working through みんなのやること beside the 案件 (tasks-ui.md "Working through a list"): the task shown and how a row shows one. */
export interface BundleWork {
  listKey: string
  shown: string | null
  onOpen: (taskId: string) => void
}

/**
 * A 案件・プロジェクト (新しい画面のデモ E): what for, who is responsible, the due and how far, its approval
 * requests as cards, and everyone's やること by whose turn (a row opens the task). なんのため・責任者・期限 are corrected
 * where they are shown (owner 2026-11-27) by whom the type lets (`bundleTileAction`); for anyone else they are text.
 */
export function BundleBody({ b, renderApproval, edit, work }: { b: BundleDetailView; renderApproval?: (approvalId: string) => ReactNode; edit?: BundleTileEdit; work?: BundleWork }) {
  // ↑ ↓ go over what is still to do (終わったこと is left out); a card drawn again scrolls back to the row it showed.
  const order = b.groups.flatMap(g => g.tasks.filter(t => t.turn !== null).map(t => t.id))
  const shown = work?.shown ?? null
  const intoView = useCallback((el: HTMLElement | null) => { if (el && shown) el.scrollIntoView({ block: 'nearest' }) }, [shown])
  const may = (field: BundleTileField) => (edit ? bundleTileAction(edit.actions, field) : null)
  const send = (a: BundleAction, value: string) => edit!.onAct(a, { [a.args[0].name]: value })
  const purposeAction = may('purpose')
  const ownerAction = may('owner')
  const dueAction = may('due')
  const purpose = purposeAction
    ? <InlineText value={b.purpose ?? ''} label={b.purpose ? 'なんのためを直す' : 'なんのためを書く'} fieldLabel="なんのため" multiline busy={edit!.busy}
        className={b.purpose ? '' : 'font-normal text-text-subtle'}
        onSave={draft => (draft.trim() === (b.purpose ?? '').trim() ? Promise.resolve(null) : send(purposeAction, draft.trim()))}>
        {b.purpose ?? 'なんのためを書く'}
      </InlineText>
    : b.purpose ?? '—'
  const ownerShown = b.owner ? `${b.owner}さん` : '—'
  const owner = ownerAction
    ? <InlinePerson value={ownerAction.args[0].value} label="責任者を替える" people={edit!.actions.people} busy={edit!.busy} onSave={id => send(ownerAction, id)}>{ownerShown}</InlinePerson>
    : ownerShown
  const dueShown = b.due ? shortDue(b.due) ?? b.due : '—'
  const due = dueAction
    ? <InlineDate value={b.due ?? null} label={b.due ? '期限を変える' : '期限を決める'} busy={edit!.busy} onSave={d => send(dueAction, d)}>{dueShown}</InlineDate>
    : dueShown
  const tiles: Array<[string, ReactNode]> = [
    ['なんのため', purpose],
    ['責任者', owner],
    // 期限 only where the type has one to show or set (a business plugin's 案件 may have none).
    ...(b.due || dueAction ? [['期限', due] as [string, ReactNode]] : []),
    ['進み具合', b.total > 0 ? `${b.total}つのうち ${b.done}つ終わった` : 'まだやることはありません'],
  ]
  return (
    <>
      <div className={`grid gap-2 ${tiles.length === 4 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'}`}>
        {tiles.map(([k, v]) => (
          // `min-w-0` + `overflow-wrap: anywhere` (FB #36): a long URL in なんのため wraps inside its tile
          // instead of running into 進み具合 (tests/ui/record-card.spec.ts `&purpose=url`).
          <div key={k} data-tile={k} className="min-w-0 rounded-control bg-gray-50 px-3 py-2 dark:bg-zinc-800/60">
            <div className="text-caption font-normal text-gray-500">{k}</div>
            <div className="whitespace-pre-wrap text-body font-semibold leading-snug [overflow-wrap:anywhere]">{v}</div>
          </div>
        ))}
      </div>
      {renderApproval && b.pendingApprovals.map(id => <div key={id}>{renderApproval(id)}</div>)}
      <section aria-label="みんなのやること">
        <h2 className="mb-2 flex items-center gap-1.5 text-body font-semibold text-gray-700 dark:text-zinc-200"><TreeStructure size={14} className="text-primary" />みんなのやること</h2>
        {b.total > 0 && (
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-zinc-800" role="progressbar" aria-label="進み具合" aria-valuemin={0} aria-valuemax={b.total} aria-valuenow={b.done}>
            <div className="h-full bg-emerald-500" style={{ width: `${(b.done / b.total) * 100}%` }} />
          </div>
        )}
        {b.groups.length === 0
          ? <p className="text-small text-gray-400">{CALM.emptyLinks}</p>
          : (
            <>
            {work && <WorkThroughNotice listKey={work.listKey} />}
            <div {...(work ? { ref: workListRef(work.listKey, order), 'data-work-list': work.listKey, ...commandArea('list', work.listKey) } : {})}
              className="divide-y divide-gray-100 rounded-control border border-gray-200 dark:divide-zinc-800 dark:border-zinc-700">
              {b.groups.map(g => (
                <section key={g.title} aria-label={g.title} className="px-3 py-2">
                  <h3 className="mb-1 text-caption font-semibold text-gray-500">{g.title}</h3>
                  {g.tasks.map(t => (
                    // Working through it, a row shows its やること beside the 案件; otherwise it opens in a tab.
                    <button key={t.id} type="button" data-work-row={t.id} aria-current={shown === t.id ? 'true' : undefined} ref={shown === t.id ? intoView : undefined}
                      onClick={() => (work ? work.onOpen(t.id) : runCommand('record.open', { recordId: t.id }))}
                      className={`flex w-full items-center gap-2 rounded-small px-1.5 py-1 text-left text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${shown === t.id ? 'bg-selected-bg' : 'hover:bg-gray-50 dark:hover:bg-zinc-800'}`}>
                      <ThingIcon kind="task" size={13} label="" />
                      <span className={`flex-1 truncate ${t.turn === null ? 'text-gray-400 line-through' : 'text-link'}`}>{t.title}</span>
                      <span className="shrink-0 text-caption font-normal text-gray-500">{[t.turn, shortDue(t.due)].filter(Boolean).join('・')}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
            </>
          )}
      </section>
    </>
  )
}

/**
 * 「AI が反映しています…（あと少し）」 while it works, 「AI が反映しました（11/2 09:56）」 after (plan I.4): one
 * line in fixed words — what it did is in 経緯 (［経緯で見る］), never the AI's own step names here.
 */
export function AiBand({ ai, onShowHistory }: { ai: NonNullable<RecordCardView['ai']>; onShowHistory?: () => void }) {
  if (ai.working) {
    return <p role="status" className="flex items-center gap-2 rounded-card border border-ai-border bg-ai-bg px-3 py-2 text-small"><CircleNotch size={14} className="animate-spin text-ai-icon" />{CALM.aiWorking}</p>
  }
  if (!ai.done) return null
  const at = new Date(ai.done.at)
  const time = Number.isNaN(at.getTime()) ? '' : `（${at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`
  return (
    <p role="status" className="flex items-center gap-2 truncate rounded-control bg-emerald-500/[0.07] px-3 py-2 text-small">
      <Sparkle size={14} weight="fill" className="shrink-0 text-emerald-600" /><span className="min-w-0 flex-1 truncate">AI が反映しました{time}</span>
      {onShowHistory && <button type="button" onClick={onShowHistory} className="shrink-0 text-small text-link hover:underline">経緯で見る</button>}
    </p>
  )
}
