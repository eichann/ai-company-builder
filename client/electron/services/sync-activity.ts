// Long operations that must not overlap an automatic sync and do not take
// sync's per-repository lock: applying download choices (sparse-checkout
// set) and creating a private folder. `git:autoSync` skips while one runs
// (.claude/rules/sync.md "Automatic sync").

export type SyncActivityKind = 'download-choices' | 'private-folder-setup'

export interface SyncActivity {
  /** Run `fn` marked as `kind` (also when it throws, the mark is removed). */
  during<T>(kind: SyncActivityKind, fn: () => Promise<T>): Promise<T>
  /** The first operation still running, or null. */
  current(): SyncActivityKind | null
}

export function createSyncActivity(): SyncActivity {
  const running: SyncActivityKind[] = []
  return {
    async during(kind, fn) {
      running.push(kind)
      try {
        return await fn()
      } finally {
        running.splice(running.indexOf(kind), 1)
      }
    },
    current: () => running[0] ?? null,
  }
}
