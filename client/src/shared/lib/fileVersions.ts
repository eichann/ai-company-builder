/**
 * A per-path counter bumped on every watcher event for the path (change, add,
 * unlink — and, for a removed folder, every tracked path inside it). Previews
 * put it into their `local-file://…?v=<n>` URL, so a file replaced under the
 * same name (the AI rewrites an image, or writes a temp file and renames it
 * over) is fetched again instead of served from Chromium's image cache.
 */
import { normalizePathSeparators } from './path'

const keyOf = (p: string) => normalizePathSeparators(p).replace(/\/+$/, '')

export class FileVersionStore {
  private versions = new Map<string, number>()
  private listeners = new Set<() => void>()

  get(path: string): number {
    return this.versions.get(keyOf(path)) ?? 0
  }

  bump(changes: ReadonlyArray<{ type: string; path: string }>): void {
    if (changes.length === 0) return
    for (const change of changes) {
      const key = keyOf(change.path)
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
      if (change.type === 'unlink' || change.type === 'unlinkDir') {
        // A folder went away (the watcher cannot always tell a removed folder
        // from a removed file): everything previewed inside it changed too.
        const prefix = `${key}/`
        for (const [k, v] of this.versions) {
          if (k.startsWith(prefix)) this.versions.set(k, v + 1)
        }
      }
    }
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const fileVersions = new FileVersionStore()
