import { useCallback, useState } from 'react'
import { useIsNarrowerThan } from '../../../shared/hooks/useIsNarrowerThan'
import { resolveLeftPanel, shownPanels, tabStripWidth, type LeftPanel } from '../leftPanels'

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
  // The tab whose peek is open (pointer on the tab or its peek, or focus on the tab).
  const [peeking, setPeeking] = useState<string | null>(null)
  // Too narrow for icon and name side by side: the name goes under the icon, smaller. Names always
  // show; when even that does not fit (many plugin tabs) the strip scrolls sideways.
  const [stripRef, stacked] = useIsNarrowerThan<HTMLDivElement>(tabStripWidth(shown))
  // The chosen tab scrolled into view when it changes (only the strip scrolls, never the page).
  const activeRef = useCallback((button: HTMLButtonElement | null) => {
    const strip = button?.closest('[data-left-tabs]')
    if (!button || !strip || button.dataset.leftTab !== activeId) return
    const b = button.getBoundingClientRect()
    const s = strip.getBoundingClientRect()
    if (b.left < s.left) strip.scrollLeft -= s.left - b.left
    else if (b.right > s.right) strip.scrollLeft += b.right - s.right
  }, [activeId])

  return (
    <>
      <div ref={stripRef} data-left-tabs className="flex-shrink-0 flex min-w-0 overflow-x-auto overflow-y-hidden border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900">
        {shown.map(panel => {
          const active = panel.id === activeId
          const Icon = panel.icon
          const mark = panel.badgeCount ? (
            <span className="block min-w-[18px] px-1.5 rounded-full bg-accent text-white text-[11px] leading-[18px] text-center">
              {panel.badgeCount}
            </span>
          ) : panel.dot ? <span data-new-dot aria-label="新しいものがあります" className="block h-2 w-2 rounded-full bg-accent" /> : null
          const tab = (
            <button
              key={panel.id}
              ref={active ? activeRef : undefined}
              type="button"
              title={panel.title}
              data-left-tab={panel.id}
              onClick={() => { setPeeking(null); onSelect(panel.id); panel.onOpen?.() }}
              className={`
                relative flex flex-shrink-0 font-medium whitespace-nowrap border-b-2 transition-colors
                ${stacked
                  ? 'grow basis-auto flex-col items-center gap-0.5 px-[3px] pt-1.5 pb-1 text-[11px] leading-[14px]'
                  : 'items-center gap-1.5 px-2.5 py-2.5 text-[13px]'}
                ${active
                  ? 'border-accent text-gray-900 dark:text-zinc-100'
                  : 'border-transparent text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200'
                }
              `}
            >
              <Icon size={stacked ? 18 : 16} weight={active ? 'fill' : 'regular'} className="flex-shrink-0" />
              <span data-left-tab-name>{panel.title}</span>
              {/* After the name, so the accessible name starts with it; stacked, it sits at the icon's corner. */}
              {mark && (stacked ? <span className="absolute top-1 left-1/2 ml-1.5">{mark}</span> : mark)}
            </button>
          )
          if (!panel.peek) return tab
          return (
            <div key={panel.id} className={`relative flex ${stacked ? 'grow basis-auto' : ''}`} data-peek-for={panel.id}
              onMouseEnter={() => setPeeking(panel.id)} onMouseLeave={() => setPeeking(p => (p === panel.id ? null : p))}
              onFocus={() => setPeeking(panel.id)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeeking(null) }}
              onKeyDown={e => { if (e.key === 'Escape') setPeeking(null) }}>
              {tab}
              {peeking === panel.id && <div className="absolute left-0 top-full z-40 pt-1">{panel.peek()}</div>}
            </div>
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
