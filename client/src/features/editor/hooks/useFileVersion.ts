import { useSyncExternalStore } from 'react'
import { fileVersions } from '../../../shared/lib/fileVersions'

/** The current version of a file (0 until the watcher reports something for it). */
export function useFileVersion(path: string | null | undefined): number {
  return useSyncExternalStore(
    fileVersions.subscribe,
    () => (path ? fileVersions.get(path) : 0),
    () => 0,
  )
}
