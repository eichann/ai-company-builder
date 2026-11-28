import { useCallback, useSyncExternalStore } from 'react'
import type { ContactEntry, ContactStore } from '../contactStore'

/**
 * Reads the contacts named (`id@stamp`: read again when the stamp changes — a new notice, the card opened) into the
 * inbox's store and redraws when an answer lands; returns every entry now (a new map after each change). Nothing is read
 * without a company. The reads start when the list of names changes (the subscription), never on every draw; a new
 * `again` (a reconnect, the panel shown again) asks the same names once more — the store reads only those whose read failed.
 */
export function useContacts(store: ContactStore, companyId: string | undefined, wanted: readonly string[], again = 0): ReadonlyMap<string, ContactEntry> {
  const key = wanted.join(',')
  const subscribe = useCallback((listener: () => void) => {
    const off = store.subscribe(listener)
    // `again` is only a reason to ask once more: the store decides what is read.
    void again
    if (companyId && key) store.want(companyId, key.split(','))
    return off
  }, [store, companyId, key, again])
  return useSyncExternalStore(subscribe, store.snapshot, store.snapshot)
}
