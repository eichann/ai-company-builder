// ACB foundation: working through a list one item after another — the やること list (features/tasks, shown by app/), a
// 案件's やること (features/records) and next the inbox (features/inbox) — kept in one place so they behave alike.
// Rules: .claude/rules/tasks-ui.md "Working through a list". Memory only: nothing here is saved or sent.

/** Where an item stands in its list, counted from 1 (「3 / 11」). */
export interface WorkPosition {
  readonly at: number
  readonly total: number
}

export function positionIn(order: readonly string[], id: string | null): WorkPosition | null {
  const i = id === null ? -1 : order.indexOf(id)
  return i < 0 ? null : { at: i + 1, total: order.length }
}

/**
 * The item ↑ / ↓ go to. From an item of the list: its neighbour, stopping at either end (the same item). From
 * nothing shown: back to `place` (where the member was) while it is still listed, else the first / last item.
 */
export function stepIn(order: readonly string[], shown: string | null, step: 1 | -1, place: string | null = null): string | null {
  const i = shown === null ? -1 : order.indexOf(shown)
  if (i >= 0) return order[Math.min(order.length - 1, Math.max(0, i + step))]
  if (place !== null && order.includes(place)) return place
  return order.length === 0 ? null : step === 1 ? order[0] : order[order.length - 1]
}

/** After an item is done with, the one that takes its place: the next one, else (it was the last) the one before. */
export function nextAfterLeaving(order: readonly string[], id: string): string | null {
  const i = order.indexOf(id)
  if (i < 0) return null
  return order[i + 1] ?? order[i - 1] ?? null
}

/** What the list says after an item was done with: the words and, while it can be undone, 取り消す. */
export interface WorkNotice {
  readonly text: string
  readonly undo: (() => void) | null
}

const EMPTY: readonly string[] = []
const orders = new Map<string, readonly string[]>()
const notices = new Map<string, WorkNotice>()
const places = new Map<string, string>()
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

export function subscribeWork(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The items the list shows now, in its order (what ↑ ↓ go over and 「3 / 11」 counts). */
export function publishOrder(listKey: string, order: readonly string[]): void {
  if (same(orders.get(listKey) ?? EMPTY, order)) return
  orders.set(listKey, [...order])
  notify()
}

/**
 * A ref callback for the element holding the list's rows: it publishes the order each time the list is drawn —
 * after the commit, so whoever shows the items reads what is on screen (no effect needed; a list taken off the
 * screen keeps its last order, which only that list's own keys and items read).
 */
export function workListRef(listKey: string, order: readonly string[]): (element: HTMLElement | null) => void {
  return element => { if (element) publishOrder(listKey, order) }
}

export function orderOf(listKey: string): readonly string[] {
  return orders.get(listKey) ?? EMPTY
}

/** Where the member was in a list: the last item shown from it (a list drawn again starts there). */
export function rememberPlace(listKey: string, id: string): void {
  places.set(listKey, id)
}

export function placeOf(listKey: string): string | null {
  return places.get(listKey) ?? null
}

export function setWorkNotice(listKey: string, notice: WorkNotice | null): void {
  if (notice === null ? !notices.has(listKey) : notices.get(listKey) === notice) return
  if (notice === null) notices.delete(listKey)
  else notices.set(listKey, notice)
  notify()
}

export function noticeOf(listKey: string): WorkNotice | null {
  return notices.get(listKey) ?? null
}
