// What office apps leave next to a file they have open (sync-guards.md
// "Files open in another app").
//
// - Microsoft Office (Windows and Mac) writes an owner file `~$<name>` while a
//   document is open (Word shortens a long name: `~$cument.docx` for
//   `Document.docx`), and Word saves through `~WRL0001.tmp` / `~WRD0000.tmp`.
// - LibreOffice / OpenOffice write `.~lock.<name>#`.
//
// Two uses:
// 1. Never shared: committed, they told every teammate 「〇〇が編集中」 and
//    came back as a change at every save. Sync ignores them through a managed
//    block of .git/info/exclude (this computer only) and unstages a new one
//    that a shared .gitignore negation re-included.
// 2. The reliable cross-platform sign that a file is open: sync and the
//    automatic receive do not replace such a file with a teammate's version
//    (the app would later save its stale copy over it).

import { pathKey } from '../../shared/core/paths'

/** Gitignore lines (no slash: every folder). `#` is a comment only at the start of a line. */
export const OFFICE_LOCK_EXCLUDE_PATTERNS: readonly string[] = ['~$*', '.~lock.*#', '~WRL*.tmp', '~WRD*.tmp']

const WORD_EXTENSIONS = /\.(docx?|docm|dotx?|dotm|rtf)$/i

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** A repository-relative or absolute path whose last segment is an office lock or temporary file. */
export function isOfficeLockFile(p: string): boolean {
  const name = baseName(p)
  if (name.startsWith('~$') && name.length > 2) return true
  if (name.startsWith('.~lock.') && name.endsWith('#') && name.length > '.~lock.#'.length) return true
  return /^~WR[LD][^/]*\.tmp$/i.test(name)
}

/**
 * The lock-file names that say `name` (a file name, no folder) is open.
 * Word's owner file follows the old short-name rule: a stem of up to 6
 * characters keeps the whole name (`~$Help.doc`), 7 drops the first character
 * (`~$eport1.docx`), 8 or more drop the first two (`~$cument.docx` for
 * `Document.docx`). For a stem with non-ASCII characters (Japanese) it is not
 * known whether Word counts characters or bytes, so both shortened forms
 * count from 3 characters: a neighbour sharing the tail then waits too, the
 * safe side.
 */
export function lockNamesFor(name: string): string[] {
  const names = [`~$${name}`, `.~lock.${name}#`]
  if (WORD_EXTENSIONS.test(name)) {
    const stem = name.slice(0, name.lastIndexOf('.'))
    const length = [...stem].length
    const chars = [...name]
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(stem)) {
      if (length >= 3) names.push(`~$${chars.slice(1).join('')}`, `~$${chars.slice(2).join('')}`)
    } else if (length === 7) {
      names.push(`~$${name.slice(1)}`)
    } else if (length >= 8) {
      names.push(`~$${name.slice(2)}`)
    }
  }
  return names
}

/** Compare names the way the disk does (NFC, A–Z folded). */
export function lockNameKey(name: string): string {
  return pathKey(name)
}
