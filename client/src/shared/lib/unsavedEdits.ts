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
