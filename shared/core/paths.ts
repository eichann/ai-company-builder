/**
 * Path normalisation and comparison — the one implementation the server, the
 * desktop app (main process and renderer) and the admin console share.
 *
 * Repository paths are company-relative, '/'-separated, Unicode NFC, without
 * leading or trailing slashes; '' is the company root. Two paths name the
 * same thing when their KEYS are equal: NFC with ASCII A–Z folded to a–z and
 * nothing else (not full-width Ａ, not É, not Σ) — the default macOS and
 * Windows file systems check "Sales/x" out into an existing "sales/", and
 * git's own `core.ignorecase` folds ASCII only.
 *
 * Relationship with the push checker (server/src/lib/push-check/rules.ts
 * foldAsciiCase): it folds the same A–Z range, but over git's raw bytes read
 * as latin1 under LC_ALL=C and without NFC (git hands it the bytes as
 * pushed). UTF-8 multi-byte sequences never contain 0x41–0x5A, so on NFC
 * input both give the same key; it stays a separate copy on purpose
 * (bytewise, locale-independent; client/tests/rule-parity-names.test.ts pins
 * the equivalence and the NFD difference).
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */

/** A–Z → a–z only. */
export function foldAsciiCase(s: string): string {
  return s.replace(/[A-Z]+/g, m => m.toLowerCase())
}

/**
 * Normalise a repo-relative path: NFC, '\\' → '/', no empty segments (so no
 * leading, trailing or repeated slashes). null when a '.' / '..' segment is
 * left (the path escapes or is ambiguous). '' is the company root.
 */
export function normalizeRepoPath(raw: string): string | null {
  const segments = raw.normalize('NFC').replace(/\\/g, '/').split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '.' || s === '..')) return null
  return segments.join('/')
}

/**
 * Comparison key of a path as git spells it: '/'-separated segments, empty
 * ones dropped, NFC, A–Z folded. A backslash is an ordinary character here
 * (git never produces one as a separator); '.' / '..' are kept.
 */
export function pathKey(path: string): string {
  return foldAsciiCase(path.normalize('NFC').split('/').filter(s => s.length > 0).join('/'))
}

/**
 * Comparison key of a string that is already a clean path (or one name):
 * NFC + A–Z folded, nothing else touched.
 */
export function nameKey(s: string): string {
  return foldAsciiCase(s.normalize('NFC'))
}

/**
 * The paths/check contract's key (shared/types/private-folders.ts): like
 * pathKey, but '\\' is a separator too (a path typed on Windows).
 */
export function normalizeReservedPath(path: string): string {
  return path
    .normalize('NFC')
    .split(/[/\\]/)
    .filter(s => s.length > 0)
    .map(foldAsciiCase)
    .join('/')
}

/** True when `ancestor` is `path` itself or one of its parent folders ('' is everyone's ancestor). */
export function isSameOrAncestorPath(ancestor: string, path: string): boolean {
  if (ancestor === '') return true
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/** Parents before children, siblings by name (UTF-16 code unit order). */
export function compareScopePaths(a: string, b: string): number {
  const as = a === '' ? [] : a.split('/')
  const bs = b === '' ? [] : b.split('/')
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1
  }
  return as.length - bs.length
}
