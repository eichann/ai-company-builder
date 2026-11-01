import { useCallback, useState } from 'react'
import { canGoBack, canGoForward, EMPTY_PLACES, stepPlace, visitPlace, type EditorPlace, type PlaceHistory } from '../places'

interface Options {
  /** A new company starts a new history. */
  companyId: string | undefined
  /** The file tab shown when nothing was visited yet (restored tabs): ← returns to it. */
  activeFilePath: string | null
  /** ← / → reached a file: show its tab (open it again when it was closed). */
  showFile: (path: string) => void
}

/** ← → over the files and record cards the editor area showed, like a browser (design §7-4). */
export function usePlaceHistory({ companyId, activeFilePath, showFile }: Options) {
  const [state, setState] = useState<{ companyId: string | undefined; history: PlaceHistory }>({ companyId, history: EMPTY_PLACES })
  let history = state.history
  if (state.companyId !== companyId) {
    history = EMPTY_PLACES
    setState({ companyId, history })
  } else if (history.index === -1 && activeFilePath) {
    history = visitPlace(history, { kind: 'file', path: activeFilePath })
    setState({ companyId, history })
  }

  const visit = useCallback((place: EditorPlace) => {
    setState(s => ({ ...s, history: visitPlace(s.history, place) }))
  }, [])
  const step = useCallback((by: -1 | 1) => {
    const next = stepPlace(history, by)
    if (next === history) return
    setState(s => ({ ...s, history: next }))
    const place = next.entries[next.index]
    if (place.kind === 'file') showFile(place.path)
  }, [history, showFile])

  const current = history.entries[history.index]
  return {
    /** The record whose card the editor area shows now, else null (a file tab is shown). */
    recordId: current?.kind === 'record' ? current.id : null,
    visitFile: useCallback((path: string) => visit({ kind: 'file', path }), [visit]),
    visitRecord: useCallback((id: string) => visit({ kind: 'record', id }), [visit]),
    back: useCallback(() => step(-1), [step]),
    forward: useCallback(() => step(1), [step]),
    canBack: canGoBack(history),
    canForward: canGoForward(history),
  }
}
