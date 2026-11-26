import { memo, useState } from 'react'
import { CheckCircle } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { STATE_BOX } from '../../../shared/ui/stateStyles'
import { AI_ASKED_UNDO_STALE_CODES, aiAskedHeading, aiAskedUndoStaleText, type AiAskedCard, type AiAskedItem } from '../../../../shared/ai-asked'
import { aiAskedStateNow, undoAiAsked, type AiAskedCardPort } from '../api'

type ItemState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'undone' } | { kind: 'stale'; text: string } | { kind: 'error'; text: string }

/**
 * 「AI が頼まれて片づけました」 (client/shared/ai-asked.ts): what the AI completed or ended at the member's request in
 * one turn, drawn by the app — never from the AI's text — one line per record with ［取り消す］, the member's own undo.
 */
export const AiAskedCardView = memo(function AiAskedCardView({ card, port }: { card: AiAskedCard; port?: AiAskedCardPort }) {
  const [states, setStates] = useState<Record<string, ItemState>>({})
  const keyOf = (item: AiAskedItem) => `${item.recordId}@${item.version}`

  const undo = async (item: AiAskedItem) => {
    const key = keyOf(item)
    if (states[key]?.kind === 'busy' || states[key]?.kind === 'undone') return
    setStates(s => ({ ...s, [key]: { kind: 'busy' } }))
    try {
      const r = await (port ? undoAiAsked(card.companyId, item.recordId, item.version, port) : undoAiAsked(card.companyId, item.recordId, item.version))
      if (r.success) { setStates(s => ({ ...s, [key]: { kind: 'undone' } })); return }
      // Undone already (another window, a press before a restart) or changed since: say so, with the record's state now.
      if (r.code && AI_ASKED_UNDO_STALE_CODES.includes(r.code)) {
        const now = await (port ? aiAskedStateNow(card.companyId, item.recordId, port) : aiAskedStateNow(card.companyId, item.recordId))
        setStates(s => ({ ...s, [key]: { kind: 'stale', text: aiAskedUndoStaleText(now) } }))
        return
      }
      setStates(s => ({ ...s, [key]: { kind: 'error', text: r.error } }))
    } catch {
      setStates(s => ({ ...s, [key]: { kind: 'error', text: '取り消せませんでした。少し待ってから、もう一度押してください。' } }))
    }
  }

  return (
    <div role="group" aria-label={aiAskedHeading(card.items.length)} data-ai-asked className={`my-2 rounded-card border p-3 ${STATE_BOX.plain}`}>
      <div className="flex items-center gap-1.5 text-body font-strong text-text">
        <CheckCircle size={15} weight="bold" aria-hidden className="text-text-muted" />
        {aiAskedHeading(card.items.length)}
      </div>
      <ul className="mt-2 space-y-1">
        {card.items.map(item => {
          const state = states[keyOf(item)] ?? { kind: 'idle' }
          return (
            <li key={keyOf(item)} data-ai-asked-item={item.recordId} className="flex flex-wrap items-center gap-2 text-small text-text">
              <span className="min-w-0 flex-1 truncate">「{item.title}」を{item.done}</span>
              {state.kind === 'undone'
                ? <span className="text-text-muted">取り消しました</span>
                : state.kind === 'stale' ? null
                  : <Button size="sm" variant="secondary" disabled={state.kind === 'busy'} onClick={() => void undo(item)}>取り消す</Button>}
              {state.kind === 'stale' && <span role="status" className="w-full text-text-muted">{state.text}</span>}
              {state.kind === 'error' && <span role="alert" className="w-full text-danger-text">{state.text}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
})
