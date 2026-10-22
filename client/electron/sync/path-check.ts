// "May this name be used in the company folder?" —
// POST /api/companies/:companyId/paths/check (shared/types/private-folders.ts).
//
// A private folder the member cannot read is never named to them (decision
// B): the app only learns, for paths it is about to create, whether each is
// usable. A path is refused (`usable: false`) when it lies at or under such a
// folder. The app asks for every prefix of a path at once: the first prefix
// that is not usable is the folder name to show, in the member's own spelling.
//
// Answers are cached per company for a few minutes (the endpoint allows 50
// paths per request and 60 per member per minute). Unknown (offline, server
// error, 429, an older server) never
// blocks anything: the push check's [RESERVED_PATH] and sync's recovery
// (./reserved-path.ts) remain the safety net.

import { pathKey } from '../../shared/sparse-paths'

/** At most this many paths per request (server: PATHS_CHECK_MAX_PATHS). */
export const PATH_CHECK_MAX_PATHS = 50

/** One answer of POST …/paths/check (`{ success, data: { results: PathCheckResult[] } }`). */
export interface PathCheckResult {
  path: string
  usable: boolean
}

/** Answers for the given paths; null when the server could not answer (throws or returns null). */
export type CheckPaths = (companyId: string, paths: string[]) => Promise<PathCheckResult[] | null>

export interface PathChecker {
  /**
   * usable per path (same spelling as given); a path missing from the map is
   * unknown. Batches of PATH_CHECK_MAX_PATHS; stops asking after a failure.
   */
  usable(companyId: string, paths: string[], options?: { max?: number }): Promise<Map<string, boolean>>
  /** The folder (prefix of `relPath`, member's spelling) that cannot be used, or null (usable or unknown). */
  reservedFolderOf(companyId: string, relPath: string): Promise<string | null>
  clear(): void
}

const TTL_MS = 5 * 60 * 1000

/** The prefixes of a path, shortest first ('a/b/c' → 'a', 'a/b', 'a/b/c'). NFC, '/'-separated. */
export function pathPrefixes(relPath: string): string[] {
  const segments = relPath.normalize('NFC').split(/[/\\]/).filter(s => s.length > 0 && s !== '.')
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

export function createPathChecker(check: CheckPaths, options: { now?: () => number; log?: Pick<Console, 'warn'> } = {}): PathChecker {
  const now = options.now ?? Date.now
  const cache = new Map<string, Map<string, { usable: boolean; at: number }>>()

  const usable: PathChecker['usable'] = async (companyId, paths, opts) => {
    const out = new Map<string, boolean>()
    let byKey = cache.get(companyId)
    if (!byKey) { byKey = new Map(); cache.set(companyId, byKey) }
    const missing: string[] = []
    const seen = new Set<string>()
    for (const p of paths) {
      const key = pathKey(p.normalize('NFC'))
      const hit = byKey.get(key)
      if (hit && now() - hit.at < TTL_MS) out.set(p, hit.usable)
      else if (!seen.has(key)) { seen.add(key); missing.push(p) }
    }
    const max = opts?.max ?? Infinity
    for (let i = 0; i < missing.length && i < max; i += PATH_CHECK_MAX_PATHS) {
      const batch = missing.slice(i, Math.min(i + PATH_CHECK_MAX_PATHS, max))
      let answers: PathCheckResult[] | null = null
      try {
        answers = await check(companyId, batch.map(p => p.normalize('NFC')))
      } catch (error) {
        options.log?.warn('[path-check] unavailable:', error instanceof Error ? error.message : error)
      }
      if (!answers || answers.length !== batch.length) break
      answers.forEach((a, j) => byKey!.set(pathKey(batch[j].normalize("NFC")), { usable: a.usable !== false, at: now() }))
    }
    for (const p of paths) {
      const hit = byKey.get(pathKey(p.normalize('NFC')))
      if (hit && !out.has(p)) out.set(p, hit.usable)
    }
    return out
  }

  return {
    usable,
    async reservedFolderOf(companyId, relPath) {
      const prefixes = pathPrefixes(relPath)
      if (prefixes.length === 0) return null
      const answers = await usable(companyId, prefixes)
      return prefixes.find(p => answers.get(p) === false) ?? null
    },
    clear() { cache.clear() },
  }
}

/** CheckPaths over fetch with the session cookies (main.ts and the harness). */
export function fetchCheckPaths(options: { baseUrl: () => string; cookies: () => string[]; fetch?: typeof fetch; timeoutMs?: number }): CheckPaths {
  return async (companyId, paths) => {
    const base = options.baseUrl()
    if (!base) return null
    const cookies = options.cookies()
    const res = await (options.fetch ?? fetch)(`${base}/api/companies/${encodeURIComponent(companyId)}/paths/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}) },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    })
    if (!res.ok) return null
    const body = await res.json() as { data?: { results?: unknown } }
    const results = body?.data?.results
    if (!Array.isArray(results)) return null
    return (results as unknown[]).map(x => {
      const r = x as { path?: unknown; usable?: unknown }
      return { path: typeof r.path === "string" ? r.path : "", usable: r.usable !== false }
    })
  }
}
