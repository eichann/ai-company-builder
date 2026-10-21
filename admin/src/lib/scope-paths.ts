// Folder-path helpers mirroring server/src/lib/permissions.ts ('' = company root).

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** Parents before children, siblings by name (same order the server returns scopes in). */
export function compareScopePaths(a: string, b: string): number {
  const as = pathSegments(a)
  const bs = pathSegments(b)
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1
  }
  return as.length - bs.length
}

/** True when `ancestor` is `path` itself or one of its parent folders. */
export function isSameOrAncestorPath(ancestor: string, path: string): boolean {
  if (ancestor === '') return true
  return path === ancestor || path.startsWith(`${ancestor}/`)
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
