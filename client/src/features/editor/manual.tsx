// 「使い方」 (the user manual) as a screen tab of the middle panel (files-and-editor.md "The user manual"):
// what the screen skeleton needs to open it at a page and draw it.
import { Question } from '@phosphor-icons/react'
import { ManualPane } from './components/ManualPane'

/** The middle tab's name (the editor's screen tab `viewTabKey(MANUAL_VIEW)`). */
export const MANUAL_VIEW = 'manual'

/** How the tab reads in the tab bar. */
export const MANUAL_TAB_LOOK = { title: '使い方', icon: <Question size={14} className="flex-shrink-0" aria-hidden /> }

/** ⌘K finds it by these words. */
export const MANUAL_PALETTE_ACTION = { id: 'manual', title: '使い方', words: ['使い方', '取説', 'マニュアル', 'ヘルプ', 'help', 'manual'] } as const

/** Which page the tab shows; `request` grows with every open, so asking again (another page) opens it afresh. */
export interface ManualTarget {
  page: string
  anchor: string | null
  request: number
}

/** The tab's page: a new request is a new pane (a new view at the asked page). */
export function renderManual(target: ManualTarget) {
  return <ManualPane key={target.request} page={target.page} anchor={target.anchor} />
}
