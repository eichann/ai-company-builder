import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { Diagram } from '../diagrams'
import { diagramKey, diagramState, watchDiagram } from '../diagramRenderer'

/**
 * A ```mermaid / ```svg block of a reply drawn as a picture (diagramRenderer.ts keeps it from running or loading
 * anything). While it is drawn a quiet line shows; a block that cannot be drawn is shown as the code it is.
 */
export function ChatDiagram({ diagram, isDark, code }: { diagram: Diagram; isDark: boolean; code: ReactNode }) {
  const { kind, source } = diagram
  const key = diagramKey(diagram, isDark)
  // By kind and text, not the object: a re-render of the block makes a new one for the same picture.
  const subscribe = useCallback((onChange: () => void) => watchDiagram({ kind, source }, isDark, onChange), [kind, source, isDark])
  const state = useSyncExternalStore(subscribe, () => diagramState(key))

  if (state.status === 'failed') return <>{code}</>
  if (state.status === 'drawing') return <div className="py-2 text-small text-text-muted">図を描いています…</div>
  return (
    <figure className="m-0" data-chat-diagram={kind}>
      <div className="overflow-x-auto rounded-control border border-[color:var(--color-border)] bg-surface-raised p-2">
        <img src={state.src} alt="AI の返事の図" width={state.width} height={state.height} draggable={false}
          className="block h-auto max-w-full m-0" />
      </div>
      <details className="mt-1 text-small text-text-muted">
        <summary className="cursor-pointer select-none">図のもとの書き方</summary>
        {code}
      </details>
    </figure>
  )
}
