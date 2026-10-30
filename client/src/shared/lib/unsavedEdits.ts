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
