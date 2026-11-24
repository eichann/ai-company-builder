// The inspection cards' copy of what main answered (keyed by member, company and plan), read through
// useSyncExternalStore: the first card showing it starts the one read (no effect), cards shown together share it.
// Memory only, as main's: what the site showed is never written anywhere on this PC.
import { readBrowserInspectionView, type BrowserInspectionGetResult, type BrowserInspectionView } from '../../../shared/browser-inspection'

export interface InspectionEntry {
  view: BrowserInspectionView | null
  /** Why there is no card (gone after a restart, another window), or null while it loads. */
  message: string | null
}

const EMPTY: InspectionEntry = Object.freeze({ view: null, message: null }) as InspectionEntry
const entries = new Map<string, InspectionEntry>()
const listeners = new Map<string, Set<() => void>>()
const loading = new Set<string>()

export const inspectionKey = (userId: string, companyId: string, planId: string) => `${userId}|${companyId}|${planId}`
export const inspectionEntry = (key: string): InspectionEntry => entries.get(key) ?? EMPTY

/** Take main's answer; a card is shown only in the shape the renderer checks (`readBrowserInspectionView`). */
export function putInspection(key: string, r: BrowserInspectionGetResult, unreadable: string): void {
  const view = r.ok ? readBrowserInspectionView(r.view) : null
  entries.set(key, view ? { view, message: null } : { view: null, message: r.ok ? unreadable : r.message })
  for (const l of listeners.get(key) ?? []) l()
}

export function subscribeInspection(key: string, load: () => Promise<BrowserInspectionGetResult>, unreadable: string, listener: () => void): () => void {
  let listening = listeners.get(key)
  if (!listening) listeners.set(key, listening = new Set())
  listening.add(listener)
  if (!entries.has(key) && !loading.has(key)) {
    loading.add(key)
    void load()
      .catch((): BrowserInspectionGetResult => ({ ok: false, message: unreadable }))
      .then(r => putInspection(key, r, unreadable))
      .finally(() => loading.delete(key))
  }
  return () => {
    listening.delete(listener)
    if (listening.size === 0) listeners.delete(key)
  }
}
