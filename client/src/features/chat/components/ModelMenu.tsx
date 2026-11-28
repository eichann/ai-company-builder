import { useState, type KeyboardEvent } from 'react'
import { CaretDown, Check } from '@phosphor-icons/react'
import type { AuthMode, CodexStatus } from '../../../../shared/agent'
import { agentCan, agentShortLabel } from '../../../../shared/agents/registry'
import type { ReplyStyle } from '../../../../shared/reply-style'
import { MODEL_EFFORT_OPTIONS, CLAUDE_MODELS, MODEL_LABELS } from '../../../stores/appStore'
import { useDismiss } from '../../../shared/hooks/useDismiss'
import type { AgentModelSelection } from '../hooks/useAgentModelSelection'

/** The effort's name on screen (the agents' own words; Claude Code's xhigh reads xHigh). */
const effortLabel = (effort: string) => effort === 'xhigh' ? 'xHigh' : effort.charAt(0).toUpperCase() + effort.slice(1)

/** ふつう: today's reply. リッチ: the AI is told diagrams are welcome (diagrams in any reply are drawn either way). */
const REPLY_STYLE_LABELS: Record<ReplyStyle, string> = { plain: 'ふつう', rich: 'リッチ（図も使う）' }

interface Choice { key: string; label: string; checked: boolean; disabled?: boolean; choose: () => void }

/**
 * The model and the effort (「考える強さ」) the next request uses, as one small switch beside the input
 * (owner FB 2026-11-27: two pickers in the header were cut off, 「Mediu」). Per agent on purpose — Claude
 * Code's static list, Codex's live catalog — the one place a new agent brings its own choices.
 * The button never shrinks or clips (it wraps to its own line with the rest of the composer's row).
 */
export function ModelMenu({ authMode, codexStatus, models, modelLocked, replyStyle, onReplyStyle }: {
  authMode: AuthMode
  codexStatus: CodexStatus
  models: AgentModelSelection
  /** A turn is in flight: the model cannot change. */
  modelLocked: boolean
  /** 「返事の形」 of this consultation (reply-style.ts); offered only to an agent that takes it (`richReplies`). */
  replyStyle: ReplyStyle
  onReplyStyle: (style: ReplyStyle) => void
}) {
  const [open, setOpen] = useState(false)
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  useDismiss(frame, open, () => setOpen(false))

  const lockedNote = modelLocked ? '（応答中は変えられません）' : ''
  let modelChoices: Choice[] = []
  let effortChoices: Choice[] = []
  let modelName = ''
  let effortName = ''
  if (authMode === 'codex') {
    const { codexModel, selectedCodexEffort } = models
    modelName = codexModel?.label ?? ''
    effortName = selectedCodexEffort
    modelChoices = codexStatus.models.map(m => ({ key: m.id, label: m.label, checked: m.id === codexModel?.id, disabled: modelLocked, choose: () => models.chooseCodexModel(m.id) }))
    effortChoices = (codexModel?.efforts ?? []).map(e => ({ key: e, label: e, checked: e === selectedCodexEffort, disabled: modelLocked, choose: () => models.chooseCodexEffort(e) }))
  } else if (authMode === 'claude-code') {
    const { aiModel, aiEffort } = models
    modelName = MODEL_LABELS[aiModel]
    effortName = effortLabel(aiEffort)
    modelChoices = CLAUDE_MODELS.map(m => ({ key: m.id, label: m.label, checked: m.id === aiModel, disabled: modelLocked, choose: () => models.setAIModel(m.id) }))
    // Claude Code's effort may change while a turn runs: the next request takes it.
    effortChoices = MODEL_EFFORT_OPTIONS[aiModel].map(e => ({ key: e, label: effortLabel(e), checked: e === aiEffort, choose: () => models.setAIEffort(e) }))
  }
  if (modelChoices.length === 0) return null
  // The next request takes it, so it may change while a turn runs (like Claude Code's effort).
  const replyChoices: Choice[] = agentCan(authMode, 'richReplies')
    ? (['plain', 'rich'] as const).map(style => ({ key: style, label: REPLY_STYLE_LABELS[style], checked: style === replyStyle, choose: () => onReplyStyle(style) }))
    : []

  const name = [modelName, effortName, replyChoices.length > 0 && replyStyle === 'rich' ? 'リッチ' : ''].filter(Boolean).join('・')
  // ↑ ↓ move between the choices (the menu's own keys; Esc closes through useDismiss).
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  const section = (title: string, choices: Choice[]) => choices.length > 0 && (
    <div role="group" aria-label={title} className="py-1">
      <div className="px-3 pb-1 text-caption font-normal text-text-subtle">{title}</div>
      {choices.map(c => (
        <button key={c.key} type="button" role="menuitemradio" aria-checked={c.checked} disabled={c.disabled}
          onClick={() => { c.choose(); setOpen(false) }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-body text-left text-text hover:bg-surface-sunken focus-visible:outline-none focus-visible:bg-surface-sunken disabled:text-disabled-text disabled:hover:bg-transparent">
          <span className="w-4 shrink-0">{c.checked && <Check size={14} weight="bold" className="text-selected-icon" />}</span>
          <span className="whitespace-nowrap">{c.label}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div ref={setFrame} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`モデルと考える強さ：${name}`}
        title={`${agentShortLabel(authMode)} のモデルと考える強さ${lockedNote}`}
        onClick={() => setOpen(value => !value)}
        className="h-control-sm px-control-sm-x inline-flex items-center gap-1 whitespace-nowrap rounded-control text-small text-text-muted hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring">
        <span>{name}</span>
        <CaretDown size={12} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="モデルと考える強さ" onKeyDown={onMenuKey}
          className="absolute bottom-full right-0 mb-1 z-menu min-w-48 bg-surface-raised text-text border border-[color:var(--color-border)] rounded-control shadow-pop divide-y divide-[color:var(--color-border)]">
          {section(`モデル${lockedNote}`, modelChoices)}
          {section('考える強さ', effortChoices)}
          {section('返事の形', replyChoices)}
        </div>
      )}
    </div>
  )
}
