// The app's temporary save files. The document review saves a sidecar by
// writing `.<name>.acb-tmp-<random>` next to it and renaming it over the
// target (src/features/doc-review/api.ts), so for a few milliseconds the file
// sits in a company folder. Sync never commits one: it is ignored through a
// managed block of .git/info/exclude (local, never shared) and unstaged if it
// reached the index anyway (sync-guards.md).

const MARK = '.acb-tmp-'

/** The temporary file for saving `name` (a file name, no folder). */
export function tempSaveFileName(name: string, random: string): string {
  return `.${name}${MARK}${random}`
}

/** A repository-relative or absolute path whose last segment is such a temporary file. */
export function isTempSaveFile(p: string): boolean {
  const name = p.slice(p.lastIndexOf('/') + 1)
  return name.startsWith('.') && name.indexOf(MARK, 1) > 1
}

/** The gitignore line that ignores them at any depth (no slash: matches the name in every folder). */
export const TEMP_SAVE_EXCLUDE_PATTERN = `.*${MARK}*`
