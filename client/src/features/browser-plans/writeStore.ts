// The write cards' copy of what main answered (keyed by member, company and card), read through useSyncExternalStore: the
// first card showing it starts the one read (no effect), cards shown together share it, and every press puts main's answer
// back here. Memory only, and only while a card shows it: main's copy decides (cleared on sign-out), never one kept here.
import { readBrowserCard } from '../../../shared/browser-inspection'
import { readBrowserWriteView, type BrowserWriteGetResult, type BrowserWriteView } from '../../../shared/browser-line-writes'

export interface WriteEntry {
  view: BrowserWriteView | null
  /** Why there is no card (gone after a restart, another window), or null while it loads. */
  message: string | null
}

const EMPTY: WriteEntry = Object.freeze({ view: null, message: null }) as WriteEntry
const entries = new Map<string, WriteEntry>()
const listeners = new Map<string, Set<() => void>>()
const loading = new Map<string, number>()
let generation = 0

export const writeKey = (userId: string, companyId: string, cardId: string) => `${userId}|${companyId}|${cardId}`
export const writeEntry = (key: string): WriteEntry => entries.get(key) ?? EMPTY

/** Take main's answer; a card is shown only in the shape the renderer checks. A refusal of a press keeps the card shown. */
export function putWrite(key: string, r: BrowserWriteGetResult, unreadable: string): void {
  const view = r.ok ? readBrowserWriteView(r.view, readBrowserCard) : null
  const before = entries.get(key)
  if (!view && before?.view && !r.ok) entries.set(key, { view: before.view, message: r.message })
  else entries.set(key, view ? { view, message: null } : { view: null, message: r.ok ? unreadable : r.message })
  loading.delete(key)
  for (const l of listeners.get(key) ?? []) l()
}

export function subscribeWrite(key: string, load: () => Promise<BrowserWriteGetResult>, unreadable: string, listener: () => void): () => void {
  let listening = listeners.get(key)
  if (!listening) listeners.set(key, listening = new Set())
  listening.add(listener)
  if (listening.size === 1) {
    const asked = ++generation
    loading.set(key, asked)
    void load()
      .catch((): BrowserWriteGetResult => ({ ok: false, message: unreadable }))
      .then(r => { if (loading.get(key) === asked) putWrite(key, r, unreadable) })
  }
  return () => {
    listening.delete(listener)
    if (listening.size === 0) {
      listeners.delete(key)
      entries.delete(key)
      loading.delete(key)
    }
  }
}
