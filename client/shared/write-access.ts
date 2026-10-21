/**
 * Where the signed-in member may write in a company, and how to evaluate it
 * for one path — the same answer the server's push check gives (so the AI is
 * stopped BEFORE it edits a folder whose changes the push would reject with
 * [WRITE_DENIED] and sync would move to .backups/).
 *
 * Data: GET /api/companies/:companyId/me/write-access (server
 * writeAccessSummary in server/src/lib/permissions.ts). Evaluation mirrors
 * resolveAccess() + the push gate (server/src/lib/push-check/policy.ts):
 * - the path is NFC-normalised, '/'-separated, '' = company root;
 * - the DEEPEST listed scope at or above the path decides; none → no write;
 * - it must be writable both as spelled and with A–Z folded on both sides
 *   (macOS/Windows check "Sales/x" out into an existing "sales/").
 *
 * Pure (no Node, no Electron): used by the main process (chat guard) and the
 * renderer (閲覧のみ badges).
 */

export interface WriteAccess {
  /** Changes whenever the answer changes (also the HTTP ETag). */
  version: string
  role: string
  /** true → the member may write everywhere (owner/admin, or no restriction applies). */
  all: boolean
  /** Scopes that have rules, parents first. */
  scopes: Array<{ path: string; write: boolean }>
}

export function isWriteAccess(value: unknown): value is WriteAccess {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.version === 'string' && typeof v.role === 'string' && typeof v.all === 'boolean'
    && Array.isArray(v.scopes)
    && v.scopes.every(s => !!s && typeof s === 'object' && typeof (s as { path?: unknown }).path === 'string' && typeof (s as { write?: unknown }).write === 'boolean')
}

export function foldAsciiCase(s: string): string {
  return s.replace(/[A-Z]+/g, m => m.toLowerCase())
}

/**
 * Normalise a repo-relative path like the server's normalizeScopePath: NFC,
 * forward slashes, no empty segments. null when a '.' / '..' segment is left
 * (the path escapes or is ambiguous).
 */
export function normalizeRepoPath(raw: string): string | null {
  const segments = raw.normalize('NFC').replace(/\\/g, '/').split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '.' || s === '..')) return null
  return segments.join('/')
}

function isSameOrAncestor(ancestor: string, path: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`)
}

function deepest(scopes: Array<{ path: string; write: boolean }>, path: string): { path: string; write: boolean } | null {
  let best: { path: string; write: boolean } | null = null
  for (const s of scopes) {
    if (!isSameOrAncestor(s.path, path)) continue
    if (!best || s.path.length > best.path.length) best = s
  }
  return best
}

export interface WriteDecision {
  write: boolean
  /** The scope whose rules decided ('' = company root), null when none / all. */
  scopePath: string | null
}

/** May the member write `repoPath` (relative to the company root)? */
export function evaluateWrite(access: WriteAccess, repoPath: string): WriteDecision {
  if (access.all) return { write: true, scopePath: null }
  const path = normalizeRepoPath(repoPath)
  if (path === null) return { write: false, scopePath: null }
  const scopes = access.scopes.map(s => ({ path: normalizeRepoPath(s.path) ?? s.path, write: s.write }))
  const exact = deepest(scopes, path)
  const folded = deepest(scopes.map(s => ({ path: foldAsciiCase(s.path), write: s.write })), foldAsciiCase(path))
  if (!exact || !exact.write) return { write: false, scopePath: exact?.path ?? null }
  if (!folded || !folded.write) return { write: false, scopePath: folded?.path ?? null }
  return { write: true, scopePath: exact.path }
}

/**
 * Lexically resolve `target` (absolute, or relative to `cwd`) and express it
 * relative to `root`. No filesystem access, so no symlink resolution: a path
 * is judged by how it is spelled, which is also how the edit reaches git.
 * Returns null when it is outside the root. Accepts '/' and '\\' and Windows
 * drive letters; the root prefix is compared after NFC and, failing that,
 * with A–Z folded (macOS/Windows default filesystems ignore case).
 */
export function repoRelativePath(root: string, target: string, cwd?: string): string | null {
  const isAbs = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
  const joined = isAbs(target) ? target : `${cwd && isAbs(cwd) ? cwd : root}/${target}`
  const resolve = (p: string): string[] | null => {
    const out: string[] = []
    for (const seg of p.normalize('NFC').replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (out.length === 0) return null
        out.pop()
      } else out.push(seg)
    }
    return out
  }
  const r = resolve(root)
  const t = resolve(joined)
  if (!r || !t || t.length < r.length) return null
  const same = (a: string, b: string) => a === b || foldAsciiCase(a) === foldAsciiCase(b)
  for (let i = 0; i < r.length; i++) if (!same(r[i], t[i])) return null
  return t.slice(r.length).join('/')
}

/** The message the AI sees when an edit is refused (it should tell the member, not retry). */
export function readOnlyMessage(folder: string): string {
  const label = folder === '' ? '会社フォルダのトップ' : folder
  return `このフォルダ（${label}）は閲覧のみのため、編集できません。編集が必要な場合はフォルダの管理者に依頼してください。別の場所に保存する場合は、ユーザーに確認してください。`
}
