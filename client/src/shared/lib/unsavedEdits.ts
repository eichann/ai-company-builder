// Which open editor tabs hold edits not yet written to disk. The editor
// publishes; automatic sync waits while any are left (a sync then would
// share half a change, or a receive would put a teammate's version under
// the tab). Autosave writes after a second, so this is usually empty.

let dirty: ReadonlySet<string> = new Set()

/** Replace the editor's set of unsaved tabs (paths). */
export function publishUnsavedEdits(paths: Iterable<string>): void {
  dirty = new Set(paths)
}

export function hasUnsavedEdits(): boolean {
  return dirty.size > 0
}

/** The tabs (paths) holding unsaved edits now. */
export function unsavedPaths(): string[] {
  return [...dirty]
}

// Leaving (sign-out, closing the window): every editor saves its tabs first.
// A saver writes what it can without asking and answers the paths it could
// not save (changed on disk meanwhile, the write failed); the caller then
// asks the member before anything is lost.
type UnsavedEditsSaver = () => Promise<string[]>
const savers = new Set<UnsavedEditsSaver>()

/** Register an editor's saver while it is mounted; returns the unregister function. */
export function registerUnsavedEditsSaver(saver: UnsavedEditsSaver): () => void {
  savers.add(saver)
  return () => { savers.delete(saver) }
}

/** Save every editor's unsaved tabs; resolves to the paths still unsaved (a saver that throws counts as every unsaved tab). */
export async function saveUnsavedEdits(): Promise<string[]> {
  const left: string[] = []
  for (const saver of [...savers]) {
    try {
      left.push(...await saver())
    } catch {
      left.push(...dirty)
    }
  }
  return [...new Set(left)]
}

// ［保存せずに進む］: before leaving, every editor keeps the edits of the tabs it
// could not save in the backups (the member's work is never just dropped). A
// keeper answers the paths it kept; a path no keeper kept (none holds it, its
// keep failed, a keeper threw) is answered as not kept, so the caller can say so.
type UnsavedEditsKeeper = (paths: readonly string[]) => Promise<string[]>
const keepers = new Set<UnsavedEditsKeeper>()

/** Register an editor's keeper while it is mounted; returns the unregister function. */
export function registerUnsavedEditsKeeper(keeper: UnsavedEditsKeeper): () => void {
  keepers.add(keeper)
  return () => { keepers.delete(keeper) }
}

/** Keep the edits of `paths` in the backups; resolves to the paths whose edits could not be kept. */
export async function keepUnsavedEdits(paths: readonly string[]): Promise<string[]> {
  const kept = new Set<string>()
  for (const keeper of [...keepers]) {
    try {
      for (const p of await keeper(paths)) kept.add(p)
    } catch {
      // Counts as not kept: its paths stay in the answer.
    }
  }
  return paths.filter(p => !kept.has(p))
}
