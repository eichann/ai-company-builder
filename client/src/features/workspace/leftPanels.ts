// The left panel's tabs as a list of registered panels (owner decision D7):
// today's four (スキル / ファイル / 検索 / 履歴) are entries like any other, so
// a later extension adds a tab by adding an entry, not by editing the screen.
import type { ReactNode } from 'react'
import type { Icon } from '@phosphor-icons/react'

export interface LeftPanel {
  id: string
  /** The tab's text. The app draws it; an extension only declares it (its manifest). */
  title: string
  /** One of the app's icons (an extension names one; it ships no React of its own). */
  icon: Icon
  /** A count shown on the tab (e.g. items waiting); nothing for 0 or none. */
  badgeCount?: number | null
  /** false = no tab; a remembered id of a hidden panel opens the default one. */
  visible?: boolean
  /**
   * 'always': mounted from the start; 'once-opened': mounted the first time it
   * is shown. Either way it then stays mounted, hidden, to keep its state.
   */
  mount: 'always' | 'once-opened'
  /** Extra classes on the panel's container. */
  className?: string
  /** Its tab was clicked (the search panel focuses its box). */
  onOpen?: () => void
  /** The content. An extension's panel will be the app's isolated frame, never the extension's own code. */
  render: () => ReactNode
}

/** The panels that have a tab, in order. */
export function shownPanels(panels: ReadonlyArray<LeftPanel>): LeftPanel[] {
  return panels.filter(panel => panel.visible !== false)
}

/** The panel to show for a remembered id: itself when it has a tab, else the first panel. */
export function resolveLeftPanel(id: string | null | undefined, panels: ReadonlyArray<LeftPanel>): string | null {
  const shown = shownPanels(panels)
  return shown.find(panel => panel.id === id)?.id ?? shown[0]?.id ?? null
}
