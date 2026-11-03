// After a sync, the 「前の版」 on screen read the file's history again (a teammate's change arrived).
const listeners = new Set<() => void>()

export function refreshFileVersions(): void {
  for (const listener of [...listeners]) listener()
}

export function onFileVersionsRefresh(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
