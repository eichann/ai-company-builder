/**
 * "Does the selected department's folder exist on disk?", keyed by folder.
 * The answer arrives asynchronously (fs:exists); an answer for another folder
 * must never apply to the one now selected — keeping the previous
 * department's value until the check returned made the not-downloaded prompt
 * flash and the file tree unmount and remount with a cold read on every
 * switch. Answers are remembered per folder, so returning is instant.
 */
export interface FolderCheck { path: string; exists: boolean }

const known = new Map<string, boolean>()

export function rememberFolderExists(path: string, exists: boolean): void {
  known.set(path, exists)
}

/**
 * The answer for `path`: the latest check if it is for this folder, else the
 * remembered answer, else true (assume it exists until told otherwise; the
 * sparse exclusions already say synchronously which departments are not
 * downloaded). null `path` = nothing to check (company-wide view).
 */
export function folderExistsFor(check: FolderCheck | null, path: string | null): boolean {
  if (path === null) return true
  if (check && check.path === path) return check.exists
  return known.get(path) ?? true
}

/** For tests. */
export function clearKnownFolders(): void {
  known.clear()
}
