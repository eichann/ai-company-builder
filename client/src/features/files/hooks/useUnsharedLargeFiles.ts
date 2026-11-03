// The files the tree marks 「大きすぎて共有されていません」: over 100 MB and not
// tracked, so sync keeps them on this computer (sync.md step 4). One store per
// company folder, loaded when the first tree subscribes and again shortly
// after files change (a large file added, deleted, or downloaded by a sync).
// No effect: useSyncExternalStore subscribes, the store loads.
import { useCallback, useSyncExternalStore } from 'react'
import { subscribeFileChanges } from '../../../shared/lib/fileEvents'
import { normalizePathSeparators } from '../../../shared/lib/path'
import { getUnsharedLargeFiles } from '../api'

const RELOAD_DELAY_MS = 1500
const EMPTY: ReadonlySet<string> = new Set()

interface Store {
  /** Absolute paths ('/'-separated, NFC). */
  files: ReadonlySet<string>
  listeners: Set<() => void>
  stopEvents: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
}

const stores = new Map<string, Store>()

const keyOf = (p: string) => normalizePathSeparators(p).normalize('NFC').replace(/\/+$/, '')

function storeFor(rootPath: string): Store {
  let store = stores.get(rootPath)
  if (!store) {
    store = { files: EMPTY, listeners: new Set(), stopEvents: null, timer: null }
    stores.set(rootPath, store)
  }
  return store
}

async function load(rootPath: string, store: Store) {
  const root = keyOf(rootPath)
  const files = new Set((await getUnsharedLargeFiles(rootPath)).map(rel => `${root}/${rel.normalize('NFC')}`))
  const same = files.size === store.files.size && [...files].every(f => store.files.has(f))
  if (same) return
  store.files = files
  for (const listener of [...store.listeners]) listener()
}

function subscribe(rootPath: string, listener: () => void): () => void {
  const store = storeFor(rootPath)
  store.listeners.add(listener)
  if (!store.stopEvents) {
    const root = keyOf(rootPath)
    void load(rootPath, store)
    store.stopEvents = subscribeFileChanges(changes => {
      if (!changes.some(c => keyOf(c.path).startsWith(`${root}/`))) return
      if (store.timer) clearTimeout(store.timer)
      store.timer = setTimeout(() => { store.timer = null; void load(rootPath, store) }, RELOAD_DELAY_MS)
    })
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size > 0) return
    store.stopEvents?.()
    store.stopEvents = null
    if (store.timer) clearTimeout(store.timer)
    store.timer = null
  }
}

/** Whether a file (absolute path) is one sync does not share because of its size. */
export function useUnsharedLargeFiles(rootPath: string): (path: string) => boolean {
  const sub = useCallback((listener: () => void) => (rootPath ? subscribe(rootPath, listener) : () => {}), [rootPath])
  const files = useSyncExternalStore(sub, () => (rootPath ? storeFor(rootPath).files : EMPTY))
  return useCallback((p: string) => files.has(keyOf(p)), [files])
}
