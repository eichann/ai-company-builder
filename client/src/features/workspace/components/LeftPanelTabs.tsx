import { useState } from 'react'
import { resolveLeftPanel, shownPanels, type LeftPanel } from '../leftPanels'

interface Props {
  panels: ReadonlyArray<LeftPanel>
  /** The remembered tab; an id without a shown panel opens the first one. */
  selectedId: string
  onSelect: (id: string) => void
}

/** The left panel: a tab per registered panel, and the panels opened so far (hidden when not shown). */
export function LeftPanelTabs({ panels, selectedId, onSelect }: Props) {
  const shown = shownPanels(panels)
  const activeId = resolveLeftPanel(selectedId, panels)
  // Panels opened at least once stay mounted (hidden), so switching tabs keeps their state.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(activeId ? [activeId] : []))
  if (activeId && !visited.has(activeId)) setVisited(new Set([...visited, activeId]))

  return (
    <>
      <div className="flex-shrink-0 flex border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900">
        {shown.map(panel => {
          const active = panel.id === activeId
          const Icon = panel.icon
          return (
            <button
              key={panel.id}
              onClick={() => { onSelect(panel.id); panel.onOpen?.() }}
              className={`
                flex items-center gap-2 px-4 py-2.5 text-sm font-medium
                border-b-2 transition-colors
                ${active
                  ? 'border-accent text-gray-900 dark:text-zinc-100'
                  : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                }
              `}
            >
              <Icon size={16} weight={active ? 'fill' : 'regular'} />
              {panel.title}
              {panel.badgeCount ? (
                <span className="min-w-[18px] px-1.5 rounded-full bg-accent text-white text-[11px] leading-[18px] text-center">
                  {panel.badgeCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="flex-1 overflow-hidden min-w-0">
        {shown.map(panel => (panel.mount === 'always' || visited.has(panel.id)) && (
          <div key={panel.id} className={`h-full ${panel.className ?? ''} ${panel.id !== activeId ? 'hidden' : ''}`}>
            {panel.render()}
          </div>
        ))}
      </div>
    </>
  )
}
