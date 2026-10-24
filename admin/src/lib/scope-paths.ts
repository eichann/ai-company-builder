// Folder-path helpers ('' = company root). The comparisons are the server's
// own (shared/core/paths.ts); the rest are display helpers.
import { compareScopePaths, isSameOrAncestorPath } from '../../../shared/core/paths'

export { compareScopePaths, isSameOrAncestorPath }

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function parentPath(path: string): string {
  return pathSegments(path).slice(0, -1).join('/')
}

/** The deepest of `paths` that is `path` or above it (the scope that governs it). */
export function deepestAncestor(paths: string[], path: string): string | null {
  let best: string | null = null
  for (const p of paths) {
    if (!isSameOrAncestorPath(p, path)) continue
    if (best === null || p.length > best.length) best = p
  }
  return best
}
