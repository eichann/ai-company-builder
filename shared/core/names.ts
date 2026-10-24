/**
 * Name rules shared by the server, the desktop app and the admin console:
 * department folder names (also private folder names and the top-level
 * folder of a permission scope), skill folder names, and the validation of a
 * scope path sent to the permission API.
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */

/**
 * Characters of a department folder name: ASCII word characters (\w without
 * the u flag: A–Z a–z 0–9 _), hiragana, katakana and CJK unified ideographs.
 */
const FOLDER_NAME_CHARS = '\\w\\u3040-\\u309F\\u30A0-\\u30FF\\u4E00-\\u9FFF'
const FOLDER_NAME_RE = new RegExp(`^[${FOLDER_NAME_CHARS}][${FOLDER_NAME_CHARS}._-]*$`)
const NOT_FOLDER_NAME_RUN_RE = new RegExp(`[^${FOLDER_NAME_CHARS}._-]+`, 'g')

/**
 * A department folder name: one of the characters above first, then those
 * plus "." "_" "-". No spaces, no slashes, never hidden.
 */
export function isValidFolderName(folder: string): boolean {
  return FOLDER_NAME_RE.test(folder)
}

/** A folder name suggested from a department name ("営業 企画部" → "営業-企画部"). */
export function suggestFolderName(name: string): string {
  return name
    .trim()
    .replace(NOT_FOLDER_NAME_RUN_RE, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
}

/** A skill folder name (also the SKILL.md `name`): ASCII lower case, digits, "-" and "_", not starting with "-" / "_". */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

/** A skill folder name suggested from a display name; `fallback` when nothing usable is left. */
export function suggestSkillName(displayName: string, fallback: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)
    || fallback
}

/** What a member types into a skill folder name field, reduced to the allowed characters. */
export function sanitizeSkillNameInput(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

/** Longest scope path the permission API accepts (UTF-16 code units). */
export const MAX_SCOPE_PATH_LENGTH = 1024
/** Longest folder name in a scope path (UTF-8 bytes, the file-system limit). */
export const MAX_SCOPE_SEGMENT_BYTES = 255

/** UTF-8 length of a string (TextEncoder: no Node Buffer). */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Validate a scope path from a request: '' or '/' is the company root;
 * otherwise repo-relative folder names separated by '/', no leading or
 * trailing slash, no '.' / '..', no hidden folders (their rules are built in:
 * .claude, .personal, …), no control characters or backslashes. The
 * top-level folder follows the department folder-name rule. Returned in NFC.
 */
export function parseScopePath(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'path must be a string' }
  if (raw === '' || raw === '/') return { path: '' }
  if (raw.length > MAX_SCOPE_PATH_LENGTH) return { error: 'path is too long' }
  if (raw.startsWith('/') || raw.endsWith('/')) return { error: 'path must be relative to the company folder, without leading or trailing slashes' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { error: 'path contains invalid characters' }
  const segments = raw.normalize('NFC').split('/')
  for (const s of segments) {
    if (s === '') return { error: 'path must not contain empty segments' }
    if (s === '.' || s === '..') return { error: 'path must not contain . or .. segments' }
    if (s.startsWith('.')) return { error: 'Hidden folders have built-in rules and cannot be given permissions' }
    if (utf8ByteLength(s) > MAX_SCOPE_SEGMENT_BYTES) return { error: 'A folder name in path is too long' }
  }
  if (!isValidFolderName(segments[0])) return { error: 'Invalid folder name in path' }
  return { path: segments.join('/') }
}
