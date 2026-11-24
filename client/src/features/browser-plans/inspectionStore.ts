// The inspection cards' copy of what main answered (keyed by member, company and plan), read through
// useSyncExternalStore: the first card showing it starts the one read (no effect), cards shown together share it.
// Memory only, and only while a card shows it: main's copy decides (cleared on sign-out), never one kept here.
import { readBrowserInspectionView, type BrowserInspectionGetResult, type BrowserInspectionView } from '../../../shared/browser-inspection'

export interface InspectionEntry {
  view: BrowserInspectionView | null
  /** Why there is no card (gone after a restart, another window), or null while it loads. */
  message: string | null
}

const EMPTY: InspectionEntry = Object.freeze({ view: null, message: null }) as InspectionEntry
const entries = new Map<string, InspectionEntry>()
const listeners = new Map<string, Set<() => void>>()
/** The read on its way per key (its number): an answer whose read is no longer the latest is dropped. */
const loading = new Map<string, number>()
let generation = 0

export const inspectionKey = (userId: string, companyId: string, planId: string) => `${userId}|${companyId}|${planId}`
export const inspectionEntry = (key: string): InspectionEntry => entries.get(key) ?? EMPTY

/** Take main's answer; a card is shown only in the shape the renderer checks (`readBrowserInspectionView`). */
export function putInspection(key: string, r: BrowserInspectionGetResult, unreadable: string): void {
  const view = r.ok ? readBrowserInspectionView(r.view) : null
  entries.set(key, view ? { view, message: null } : { view: null, message: r.ok ? unreadable : r.message })
  for (const l of listeners.get(key) ?? []) l()
}

/**
 * The first card showing it asks main every time (main's card is the only copy that counts: gone after a sign-out or a
 * restart); when the last card showing it goes, the copy goes too, and an answer still on its way is dropped.
 */
export function subscribeInspection(key: string, load: () => Promise<BrowserInspectionGetResult>, unreadable: string, listener: () => void): () => void {
  let listening = listeners.get(key)
  if (!listening) listeners.set(key, listening = new Set())
  listening.add(listener)
  if (listening.size === 1) {
    const asked = ++generation
    loading.set(key, asked)
    void load()
      .catch((): BrowserInspectionGetResult => ({ ok: false, message: unreadable }))
      .then(r => { if (loading.get(key) === asked) putInspection(key, r, unreadable) })
      .finally(() => { if (loading.get(key) === asked) loading.delete(key) })
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
