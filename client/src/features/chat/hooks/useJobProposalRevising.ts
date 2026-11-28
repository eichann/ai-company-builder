import { useCallback, useSyncExternalStore } from 'react'
import { revisingOf, subscribeRevising } from '../jobProposalRevising'

/** The change of a candidate sent from any of its cards and not answered yet (shared by the chat's card and the tab's). */
export function useJobProposalRevising(key: string) {
  const subscribe = useCallback((listener: () => void) => subscribeRevising(key, listener), [key])
  return useSyncExternalStore(subscribe, () => revisingOf(key), () => revisingOf(key))
}
