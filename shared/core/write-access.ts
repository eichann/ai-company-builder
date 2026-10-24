/**
 * Where a member may write, as the server sends it (GET /me/write-access,
 * writeAccessSummary in ./permissions.ts), and how to evaluate it for one
 * path — the same answer the push check gives for that member's push
 * (server/src/lib/push-check/policy.ts writeGateFor):
 *
 * - the path is NFC-normalised, '/'-separated, '' = company root;
 * - inside a private folder the member can read (`private: true`), the
 *   private folder's part of the path is taken in its stored spelling: on a
 *   case-insensitive disk "評価/CAFé/x" lands in the clone of "評価/café" and
 *   is pushed to its repository as <stored path>/<rest>;
 * - the DEEPEST listed scope at or above the path decides; none → no write;
 * - it must be writable both as spelled and with A–Z folded on both sides
 *   (macOS/Windows check "Sales/x" out into an existing "sales/"). When
 *   folding makes two scopes equally deep ("Café" and "café"), the one whose
 *   stored path sorts first (compareScopePaths) decides — the server's
 *   foldScopePaths, so both sides pick the same rules.
 *
 * Pure: used by the server (the summary), the desktop app's chat guard (main
 * process) and its 閲覧のみ badges (renderer).
 */
import { compareScopePaths, foldAsciiCase, isSameOrAncestorPath, normalizeRepoPath, pathKey } from './paths'

export interface WriteAccessScope {
  path: string
  write: boolean
  /** A private folder the member can read (its own repository). Absent from older servers. */
  private?: boolean
}

export interface WriteAccess {
  /** Changes whenever the answer changes (also the HTTP ETag). */
  version: string
  role: string
  /** true → the member may write everywhere (owner/admin, or no restriction applies). */
  all: boolean
  /** Scopes that have rules, parents first. */
  scopes: WriteAccessScope[]
}

export function isWriteAccess(value: unknown): value is WriteAccess {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.version === 'string' && typeof v.role === 'string' && typeof v.all === 'boolean'
    && Array.isArray(v.scopes)
    && v.scopes.every((s) => {
      if (!s || typeof s !== 'object') return false
      const scope = s as { path?: unknown; write?: unknown; private?: unknown }
      return typeof scope.path === 'string' && typeof scope.write === 'boolean'
        && (scope.private === undefined || typeof scope.private === 'boolean')
    })
}

/**
 * The deepest of `scopes` at or above `path` (paths compared as given).
 * Equally deep candidates — only possible after folding — go to the first
 * one in the order given; callers pass scopes sorted by compareScopePaths.
 */
export function deepestScope<T extends { path: string }>(scopes: readonly T[], path: string): T | null {
  let best: T | null = null
  for (const s of scopes) {
    if (!isSameOrAncestorPath(s.path, path)) continue
    if (!best || s.path.length > best.path.length) best = s
  }
  return best
}

/**
 * Scopes for the A–Z-folded pass: sorted by their stored paths
 * (compareScopePaths), then with folded paths — so that of two scopes whose
 * paths differ only in A–Z case the one that sorts first decides, whatever
 * order they arrived in (the database returns rows in no promised order).
 */
export function foldScopePaths<T extends { path: string }>(scopes: readonly T[]): T[] {
  return [...scopes]
    .sort((a, b) => compareScopePaths(a.path, b.path))
    .map(s => ({ ...s, path: foldAsciiCase(s.path) }))
}

/**
 * `path` (normalised) with the part inside a readable private folder's path
 * put in the folder's stored spelling, when they differ only in A–Z case or
 * Unicode normalisation.
 */
export function canonicalPrivatePath(scopes: readonly WriteAccessScope[], path: string): string {
  const key = pathKey(path)
  for (const s of scopes) {
    if (!s.private || s.path === '') continue
    const folder = normalizeRepoPath(s.path) ?? s.path
    if (!isSameOrAncestorPath(pathKey(folder), key)) continue
    const depth = folder.split('/').length
    return [folder, ...path.split('/').slice(depth)].join('/')
  }
  return path
}

export interface WriteDecision {
  write: boolean
  /** The scope whose rules decided ('' = company root), null when none / all. */
  scopePath: string | null
}

/** May the member write `repoPath` (relative to the company root)? */
export function evaluateWrite(access: WriteAccess, repoPath: string): WriteDecision {
  if (access.all) return { write: true, scopePath: null }
  const normalized = normalizeRepoPath(repoPath)
  if (normalized === null) return { write: false, scopePath: null }
  const scopes = access.scopes
    .map(s => ({ path: normalizeRepoPath(s.path) ?? s.path, write: s.write, private: s.private }))
    .sort((a, b) => compareScopePaths(a.path, b.path))
  const path = canonicalPrivatePath(scopes, normalized)
  const exact = deepestScope(scopes, path)
  const folded = deepestScope(foldScopePaths(scopes), foldAsciiCase(path))
  if (!exact || !exact.write) return { write: false, scopePath: exact?.path ?? null }
  if (!folded || !folded.write) return { write: false, scopePath: folded?.path ?? null }
  return { write: true, scopePath: exact.path }
}
