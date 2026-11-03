// The places the middle showed, for ← → like a browser (design §7-4): its tabs, files and
// records alike (a record by its tab key, `editorTabs.ts`). Pure; usePlaceHistory holds it.

export type EditorPlace = { kind: 'file'; path: string }

export interface PlaceHistory {
  entries: EditorPlace[]
  /** The place shown now; -1 = none yet. */
  index: number
}

const MAX_PLACES = 50
export const EMPTY_PLACES: PlaceHistory = { entries: [], index: -1 }

export function samePlace(a: EditorPlace | undefined, b: EditorPlace): boolean {
  return !!a && a.path === b.path
}

/** A new place: the forward entries are dropped (as a browser does); the same place again changes nothing. */
export function visitPlace(h: PlaceHistory, place: EditorPlace): PlaceHistory {
  if (samePlace(h.entries[h.index], place)) return h
  const entries = [...h.entries.slice(0, h.index + 1), place].slice(-MAX_PLACES)
  return { entries, index: entries.length - 1 }
}

export const canGoBack = (h: PlaceHistory) => h.index > 0
export const canGoForward = (h: PlaceHistory) => h.index < h.entries.length - 1
export function stepPlace(h: PlaceHistory, by: -1 | 1): PlaceHistory {
  return (by < 0 ? canGoBack(h) : canGoForward(h)) ? { ...h, index: h.index + by } : h
}
