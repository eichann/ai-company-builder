import type { ReactNode } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'

/** Where a request to the AI is (files-and-editor.md "Asking the AI to fix a passage"). */
export type AiFixPhase =
  | { kind: 'waiting' }
  | { kind: 'proposal'; markdown: string; removed: string[]; added: string[] }
  /** Nothing can be adopted: the AI gave no fix, it cannot be written faithfully, or the document changed. */
  | { kind: 'refused'; message: string }

interface Props {
  /** What was asked (a suggestion, the member's words, or 「コメントを反映」). */
  ask: string
  phase: AiFixPhase
  /** The fix drawn as the chat draws a reply (the screen's part: no raw HTML). */
  preview: (markdown: string) => ReactNode
  onAdopt: () => void
  onCancel: () => void
}

/**
 * The AI's fix in the document's flow, right under the passage it is for (owner decision 2026-11-28: no
 * floating box). Shown inside the editor as a widget: it is never part of the text and never written.
 */
export function AiFixCard({ ask, phase, preview, onAdopt, onCancel }: Props) {
  return (
    <section
      role="region"
      aria-label="AI の直し案"
      data-ai-fix
      contentEditable={false}
      className="my-3 rounded-control border border-ai-border bg-ai-bg p-3 text-body text-text"
    >
      <div className="flex items-center gap-2 text-small font-medium text-ai-text">
        <Sparkle size={14} className="text-ai-icon" />AI の直し案
        <span className="rounded-small border border-ai-border bg-surface-raised px-1.5 py-0.5 text-caption font-normal">{ask}</span>
      </div>
      {phase.kind === 'waiting' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-small text-text-muted" role="status">相談の AI に頼んでいます。返事は右の相談にも残ります。</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>やめる</Button>
        </div>
      )}
      {phase.kind === 'refused' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-small text-text" role="status">{phase.message}</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>閉じる</Button>
        </div>
      )}
      {phase.kind === 'proposal' && (
        <>
          <p className="mt-2 text-caption text-text-muted">直したあとの見た目</p>
          <div className="mt-1 rounded-small border border-[color:var(--color-border)] bg-bg px-3 py-2" data-ai-fix-preview>
            {preview(phase.markdown)}
          </div>
          <p className="mt-2 text-caption text-text-muted">
            採用すると変わる行：{phase.removed.length} 行（新しく {phase.added.length} 行）・ほかの行はそのまま
          </p>
          <div className="mt-1 overflow-x-auto rounded-small font-mono text-caption" data-ai-fix-lines>
            {phase.removed.map((line, i) => <div key={`r${i}`} className="whitespace-pre bg-danger-bg px-2 text-danger-text">− {line}</div>)}
            {phase.added.map((line, i) => <div key={`a${i}`} className="whitespace-pre bg-success-bg px-2 text-success-text">＋ {line}</div>)}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={onCancel}>やめる</Button>
            <Button size="sm" variant="primary" onClick={onAdopt}>採用</Button>
          </div>
        </>
      )}
    </section>
  )
}
