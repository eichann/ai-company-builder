// ACB foundation: the side that shows a list's items — AppShell for the やること list (its card in the middle), the
// records feature for a 案件's やること (its card beside the list), next the inbox. Rules: tasks-ui.md "Working through a list".
import { useSyncExternalStore } from 'react'
import { useCommandHandler } from '../commands/commands'
import { nextAfterLeaving, orderOf, placeOf, positionIn, rememberPlace, setWorkNotice, stepIn, subscribeWork, undoOfEnded, type WorkPosition } from '../lib/workThrough'
import { useLatestRef } from './useLatestRef'

/** A field, a menu or a dialog keeps its own keys (↑ ↓ Enter Esc mean something there). */
const KEEPS_ITS_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

export interface WorkThrough {
  /** 「3 / 11」 of the item shown, while it is one of the list's. */
  position: WorkPosition | null
  /** ↑ / ↓ (the bar's buttons): the neighbour of the item shown, or the place the member was. */
  step: (delta: 1 | -1) => void
  /** A row pressed: shows its item and remembers the place. */
  show: (id: string) => void
  /**
   * The item `id` was done with (完了, 済んだ…). When it is the one shown, the next one takes its place and the list says
   * so, with 取り消す when `undo` is given (it answers a refusal's words, or null). Answers `next` (the next one is
   * shown now), `last` (none is left: the caller puts the item away) or null (not the item shown: the caller does what
   * it did before).
   */
  ended: (id: string, title: string, undo?: () => Promise<string | null>) => 'next' | 'last' | null
}

/**
 * One list worked through: ↑ ↓ (j k) show the neighbour, Enter moves into the item shown, Esc goes back to its row
 * (commands `list.*`, delivered while the focus is in the list's rows — `data-work-list` — or the item shown —
 * `data-work-card`, both marked `commandArea('list', listKey)`). `open` shows an item; the list publishes its order
 * (`workListRef`) and marks each row's open button `data-work-row`.
 */
export function useWorkThrough({ listKey, shownId, open }: { listKey: string; shownId: string | null; open: (id: string) => void }): WorkThrough {
  const order = useSyncExternalStore(subscribeWork, () => orderOf(listKey))
  const shown = shownId !== null && order.includes(shownId) ? shownId : null
  const latest = useLatestRef({ order, shown, open })

  const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-work-list="${listKey}"] [data-work-row="${id}"]`)
  const cardOf = () => document.querySelector<HTMLElement>(`[data-work-card="${listKey}"]`)
  const focused = () => (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const inList = () => !!focused()?.closest(`[data-work-list="${listKey}"]`)
  const inCard = () => !!focused()?.closest(`[data-work-card="${listKey}"]`)
  const keepsKeys = () => !!focused()?.closest(KEEPS_ITS_KEYS)
  const focusRow = (id: string) => {
    const row = rowOf(id)
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }
  // The item drawn next replaces the one shown: its frame may be new, so look for it once it is on screen.
  const focusCard = () => requestAnimationFrame(() => cardOf()?.focus())

  const show = (id: string) => {
    rememberPlace(listKey, id)
    setWorkNotice(listKey, null)
    latest.current.open(id)
  }
  const step = (delta: 1 | -1, focus: 'row' | 'card' | 'none' = 'none') => {
    const { order: now, shown: at } = latest.current
    const next = stepIn(now, at, delta, placeOf(listKey))
    if (next === null || next === at) return
    show(next)
    if (focus === 'row') focusRow(next)
    if (focus === 'card') focusCard()
  }

  const target = listKey
  // ↑ ↓ from a row (or anything else in the rows: a ☑, a fold) or from the item's own frame — not from a button in
  // the item, whose menu may use them.
  const movesHere = () => !keepsKeys() && (inList() || cardOf() === focused())
  useCommandHandler('list.next', () => step(1, inList() ? 'row' : 'card'), { target, acceptsKey: movesHere })
  useCommandHandler('list.previous', () => step(-1, inList() ? 'row' : 'card'), { target, acceptsKey: movesHere })
  // Enter on a row's own open button only (a ☑ or a chip keeps its Enter).
  useCommandHandler('list.show', () => {
    const id = focused()?.getAttribute('data-work-row')
    if (!id) return
    if (id !== latest.current.shown) show(id)
    focusCard()
  }, { target, acceptsKey: () => !!focused()?.matches(`[data-work-list="${listKey}"] [data-work-row]`) })
  useCommandHandler('list.back', () => {
    const id = latest.current.shown ?? placeOf(listKey)
    if (id) focusRow(id)
  }, { target, acceptsKey: () => inCard() && !keepsKeys() })

  const ended = (id: string, title: string, undo?: () => Promise<string | null>) => {
    const { order: now, shown: at } = latest.current
    if (id !== at) return null
    const next = nextAfterLeaving(now, id)
    const takeBack = undo ? undoOfEnded(listKey, id, title, undo, show) : null
    setWorkNotice(listKey, { text: next ? `「${title}」を片づけました。次の件です` : `「${title}」を片づけました。この一覧の件は、これで最後です`, undo: takeBack })
    if (next) {
      rememberPlace(listKey, next)
      latest.current.open(next)
    }
    return next ? 'next' : 'last'
  }

  return { position: positionIn(order, shown), step: delta => step(delta), show, ended }
}
