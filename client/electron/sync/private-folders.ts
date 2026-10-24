// Private folders on the member's computer (permission plan stage 3b).
//
// A private folder is its own repository on the server (a "scope
// repository", stage 3a). Members who may read it get it from
// GET /api/companies/:id/me/scopes with its path and clone URL; everyone else
// learns nothing about it (the owner's decision B: names are never shown to
// someone who cannot read the folder) — the app can only ask, for paths it
// is about to create, whether they are usable (POST …/paths/check,
// ./path-check.ts). The contract is shared/types/private-folders.ts.
//
// On disk a readable private folder is a clone of its scope repository at its
// path inside the company checkout — a nested repository. This module keeps
// that arrangement safe; git-sync.ts drives it (see
// .claude/rules/private-folders-client.md):
//
//  - the last /me/scopes answer (readable folders only) is cached in the
//    company's .git (acb-private-scopes.json): offline syncs and the chat
//    write guard read it without a network call, and the next answer is
//    compared with it to see access gained, lost, or a folder made public;
//  - every readable private path is written to the company repository's
//    .git/info/exclude (local, never shared), and sync never stages it.

import fs from 'fs'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import type { MyPrivateScope, MyScopesResponse } from '../../../shared/types/private-folders'
import { pathKey } from '../../shared/sparse-paths'

export type { MyPrivateScope, MyScopesResponse }

// ---------------------------------------------------------------------------
// The cached /me/scopes answer
// ---------------------------------------------------------------------------

export interface PrivateScopesCache {
  companyId: string
  version: string
  /** When the server last answered (ISO). */
  fetchedAt: string
  /** Readable private folders. */
  scopes: MyPrivateScope[]
  /**
   * Folders the server stopped listing whose fate is not settled yet (made
   * public but not visible in the company repository yet, or the path check
   * could not answer): still excluded and left alone.
   */
  pendingPublic?: MyPrivateScope[]
}

const CACHE_FILE = 'acb-private-scopes.json'

export function privateScopesCachePath(repoPath: string): string {
  return path.join(repoPath, '.git', CACHE_FILE)
}

function isScope(v: unknown): v is MyPrivateScope {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.scopeId === 'string' && typeof s.path === 'string' && typeof s.cloneUrl === 'string'
    && typeof s.clonePath === 'string' && typeof s.canWrite === 'boolean' && isSafeScopePath(s.path)
}

/** A company-relative folder path the app will create a clone at: no '.', '..', '.git', absolute or empty paths. */
export function isSafeScopePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false
  const segments = p.split('/')
  return segments.every(s => s !== '' && s !== '.' && s !== '..' && pathKey(s) !== '.git' && pathKey(s) !== '.backups' && pathKey(s) !== '.workspace')
}

/** Validate a /me/scopes `data` payload (readable folders; anything else in it is ignored); null when it is anything else. */
export function parseMyScopes(data: unknown): MyScopesResponse | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.version !== 'string' || !Array.isArray(d.scopes)) return null
  const scopes = (d.scopes as unknown[]).filter(isScope).map(s => ({ ...s, path: s.path.normalize('NFC') }))
  return { version: d.version, scopes } as MyScopesResponse
}

interface CacheEntry { stamp: string; cache: PrivateScopesCache | null }
const cacheMemo = new Map<string, CacheEntry>()

function stampOf(file: string): string {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** The cached answer for the company checkout at `repoPath` (null when none). Cheap: memoised by mtime. */
export function readPrivateScopesCache(repoPath: string): PrivateScopesCache | null {
  const file = privateScopesCachePath(repoPath)
  const stamp = stampOf(file)
  const hit = cacheMemo.get(file)
  if (hit && hit.stamp === stamp) return hit.cache
  let cache: PrivateScopesCache | null = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const parsed = parseMyScopes(raw)
    if (parsed && typeof raw.companyId === 'string') {
      cache = {
        companyId: raw.companyId,
        version: parsed.version,
        fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
        scopes: parsed.scopes,
        pendingPublic: Array.isArray(raw.pendingPublic) ? raw.pendingPublic.filter(isScope) : [],
      }
    }
  } catch {
    cache = null
  }
  cacheMemo.set(file, { stamp, cache })
  return cache
}

/** Persist the answer: readable folders only (never anything about folders the member cannot read). */
export function writePrivateScopesCache(repoPath: string, cache: PrivateScopesCache): void {
  const file = privateScopesCachePath(repoPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const { companyId, version, fetchedAt, scopes, pendingPublic } = cache
  fs.writeFileSync(tmp, JSON.stringify({ companyId, version, fetchedAt, scopes, pendingPublic }, null, 2))
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isAtOrUnder(ancestor: string, p: string): boolean {
  const a = pathKey(ancestor)
  const k = pathKey(p)
  return k === a || k.startsWith(`${a}/`)
}

/** The readable private folder `relPath` lies in (or is), or null. Compared NFC + A–Z folded. */
export function readableScopeOf(scopes: readonly MyPrivateScope[], relPath: string): MyPrivateScope | null {
  const p = relPath.normalize('NFC').replace(/\\/g, '/').split('/').filter(Boolean).join('/')
  if (!p) return null
  return scopes.find(s => isAtOrUnder(s.path, p)) ?? null
}

/** The company checkout containing `absPath` that has a private-folder cache, or null. */
export function privateCheckoutRootOf(absPath: string): string | null {
  let dir = path.resolve(absPath)
  for (;;) {
    if (fs.existsSync(privateScopesCachePath(dir))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Where an absolute path lies for the reserved-name check: the company
 * checkout (root, companyId) and the company-relative path — or null when it
 * is outside any company checkout, or inside a private folder the member can
 * read (that folder's own rules apply there).
 */
export function companyPathOf(absPath: string): { root: string; companyId: string; rel: string } | null {
  const root = privateCheckoutRootOf(path.dirname(path.resolve(absPath)))
  if (!root) return null
  const rel = path.relative(root, path.resolve(absPath)).split(path.sep).join('/')
  if (!rel || rel.startsWith('..')) return null
  const cache = readPrivateScopesCache(root)
  if (!cache) return null
  if (readableScopeOf([...cache.scopes, ...(cache.pendingPublic ?? [])], rel)) return null
  return { root, companyId: cache.companyId, rel }
}

/** The readable private folder an absolute path lies in, with its company root — or null. */
export function privateFolderFor(absPath: string): { root: string; scope: MyPrivateScope } | null {
  const root = privateCheckoutRootOf(path.dirname(path.resolve(absPath)))
  if (!root) return null
  const rel = path.relative(root, path.resolve(absPath)).split(path.sep).join('/')
  if (!rel || rel.startsWith('..')) return null
  const cache = readPrivateScopesCache(root)
  const scope = cache ? readableScopeOf(cache.scopes, rel) : null
  return scope ? { root, scope } : null
}

// ---------------------------------------------------------------------------
// .git/info/exclude
// ---------------------------------------------------------------------------

const EXCLUDE_BEGIN = '# >>> ACB private folders (managed by the app, local only) >>>'
const EXCLUDE_END = '# <<< ACB private folders <<<'

function escapePattern(p: string): string {
  return p.replace(/[\\*?[\]!#]/g, c => `\\${c}`)
}

/** The exclude lines for these folders: each anchored, in NFC and NFD (git matches the bytes it reads from disk). */
export function privateExcludeLines(paths: readonly string[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    for (const variant of [p, p.normalize('NFC'), p.normalize('NFD')]) {
      const line = `/${escapePattern(variant)}/`
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

/**
 * Write the managed block of the company repository's .git/info/exclude so
 * it lists exactly `paths`. Lines outside the block are the member's (or
 * git's template) and are kept. Returns true when the file changed.
 */
export function writePrivateExcludes(repoPath: string, paths: readonly string[]): boolean {
  const file = path.join(repoPath, '.git', 'info', 'exclude')
  let text = ''
  try { text = fs.readFileSync(file, 'utf-8') } catch { /* none yet */ }
  const lines = text.split('\n')
  const begin = lines.indexOf(EXCLUDE_BEGIN)
  const end = begin >= 0 ? lines.indexOf(EXCLUDE_END, begin) : -1
  const outside = begin >= 0 && end >= 0 ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines
  while (outside.length > 0 && outside[outside.length - 1] === '') outside.pop()
  const block = paths.length > 0 ? [EXCLUDE_BEGIN, ...privateExcludeLines(paths), EXCLUDE_END] : []
  const next = [...outside, ...block].join('\n') + (outside.length + block.length > 0 ? '\n' : '')
  if (next === text) return false
  if (paths.length === 0 && begin < 0) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  return true
}

/** The folders listed in the managed block (NFC, deduplicated). */
export function readPrivateExcludes(repoPath: string): string[] {
  let text = ''
  try { text = fs.readFileSync(path.join(repoPath, '.git', 'info', 'exclude'), 'utf-8') } catch { return [] }
  const lines = text.split('\n')
  const begin = lines.indexOf(EXCLUDE_BEGIN)
  const end = begin >= 0 ? lines.indexOf(EXCLUDE_END, begin) : -1
  if (begin < 0 || end < 0) return []
  const out = new Set<string>()
  for (const line of lines.slice(begin + 1, end)) {
    const m = /^\/(.+)\/$/.exec(line)
    if (m) out.add(m[1].replace(/\\(.)/g, '$1').normalize('NFC'))
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Clones of scope repositories
// ---------------------------------------------------------------------------

/** URL path of a git remote (for http(s)/file URLs), else the string itself. */
function urlPath(url: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '')
  } catch { /* not a URL */ }
  return url.replace(/\/+$/, '')
}

/** Whether a clone's origin URL points at this scope repository (same URL, or same server path — a moved server address still matches). */
export function sameScopeRemote(originUrl: string, scope: Pick<MyPrivateScope, 'cloneUrl' | 'clonePath'>): boolean {
  if (!originUrl) return false
  if (originUrl === scope.cloneUrl) return true
  const p = urlPath(originUrl)
  return p === urlPath(scope.cloneUrl) || (!!scope.clonePath && p === urlPath(scope.clonePath))
}

export type CloneState =
  /** Nothing at the path. */
  | 'absent'
  /** An empty folder (OS files such as .DS_Store ignored). */
  | 'empty'
  /** A clone of this scope repository. */
  | 'clone'
  /** Something else: the member's files, or another repository. */
  | 'other'

const OS_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** What is at a private folder's path in the company checkout. */
export async function cloneStateOf(createGit: (dir: string) => SimpleGit, dir: string, scope: MyPrivateScope): Promise<CloneState> {
  let st: fs.Stats
  try { st = fs.lstatSync(dir) } catch { return 'absent' }
  if (!st.isDirectory()) return 'other'
  const entries = fs.readdirSync(dir).filter(e => !OS_FILES.has(e))
  if (entries.length === 0) return 'empty'
  if (!entries.includes('.git') || !fs.statSync(path.join(dir, '.git')).isDirectory()) return 'other'
  const url = (await createGit(dir).raw(['config', '--get', 'remote.origin.url']).catch(() => '')).trim()
  return sameScopeRemote(url, scope) ? 'clone' : 'other'
}

/** Move whatever is at `src` into `dest` (created), falling back to copy + remove across devices. */
export function moveInto(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(src, dest)
  } catch {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

/** Remove empty folders from `dir` up to (not including) `stopAt`. */
export function pruneEmptyUp(dir: string, stopAt: string): void {
  let d = path.resolve(dir)
  const stop = path.resolve(stopAt)
  while (d.startsWith(stop + path.sep)) {
    try {
      const entries = fs.readdirSync(d).filter(e => !OS_FILES.has(e))
      if (entries.length > 0) return
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      return
    }
    d = path.dirname(d)
  }
}

/**
 * Files the member changed in a clone relative to what its server last had
 * (origin/main): edited, new (not ignored) and committed-but-unpushed —
 * those that exist on disk now. Repository-relative, sorted.
 */
export async function localChangesInClone(git: SimpleGit, dir: string): Promise<string[]> {
  const files = new Set<string>()
  const status = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => '')
  const records = status.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.length < 4) continue
    const xy = rec.slice(0, 2)
    files.add(rec.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
  const hasUpstream = (await git.raw(['rev-parse', '--verify', '--quiet', 'origin/main']).catch(() => '')).trim()
  if (hasUpstream) {
    const diff = await git.raw(['diff', '--name-only', '-z', '--no-renames', 'origin/main', 'HEAD']).catch(() => '')
    for (const f of diff.split('\0')) if (f) files.add(f)
  }
  return [...files].filter(f => {
    try { return fs.lstatSync(path.join(dir, f)).isFile() || fs.lstatSync(path.join(dir, f)).isSymbolicLink() } catch { return false }
  }).sort()
}

// ---------------------------------------------------------------------------
// Safety checks (security review of 3b)
// ---------------------------------------------------------------------------

/**
 * Where everything sync saves FROM a private folder goes: conflict and
 * restore backups, unsynced edits of a folder made public, whatever sat at a
 * private folder's path. Inside the company's .git — never in the working
 * tree, so no .gitignore edit (`!.backups/`) can ever stage it into the
 * company repository. Copies under one folder are deleted with it when the
 * member loses access.
 */
export function privateBackupsDir(repoPath: string): string {
  return path.join(repoPath, '.git', 'acb-private-backups')
}

/**
 * The absolute directory of a private folder's clone, or null when it is not
 * safe to create, sync or delete anything there: an existing ancestor (or the
 * folder itself) is a symlink or not a directory, or the real path leaves the
 * company folder. A teammate can turn an ancestor into a symlink in the
 * company repository; following it would clone private content (or delete
 * files) outside the company folder.
 */
export function safeScopeDir(repoPath: string, scopePath: string): string | null {
  if (!isSafeScopePath(scopePath)) return null
  let root: string
  try { root = fs.realpathSync(repoPath) } catch { return null }
  let dir = path.resolve(repoPath)
  for (const segment of scopePath.split('/')) {
    dir = path.join(dir, segment)
    let st: fs.Stats
    try { st = fs.lstatSync(dir) } catch { break } // absent from here on: created by sync, inside
    if (st.isSymbolicLink() || !st.isDirectory()) return null
    let real: string
    try { real = fs.realpathSync(dir) } catch { return null }
    if (real !== root && !real.startsWith(root + path.sep)) return null
  }
  return path.join(path.resolve(repoPath), ...scopePath.split('/'))
}

/**
 * Whether sync may clone `cloneUrl`: never an option-looking string or a
 * remote-helper URL (`ext::`), and when the company repository is served over
 * http(s), only the same scheme, host and port with the server's own clone
 * path — a /me/scopes answer cannot point the app's credentials elsewhere.
 */
export function cloneUrlAllowed(scope: Pick<MyPrivateScope, 'cloneUrl' | 'clonePath'>, companyOriginUrl: string): boolean {
  const url = scope.cloneUrl
  // eslint-disable-next-line no-control-regex
  if (!url || url.startsWith('-') || url.includes('::') || /[\s\u0000]/.test(url)) return false
  if (/^https?:\/\//i.test(companyOriginUrl)) {
    let company: URL
    let target: URL
    try { company = new URL(companyOriginUrl); target = new URL(url) } catch { return false }
    if (target.protocol !== company.protocol || target.host !== company.host) return false
    return !!scope.clonePath && urlPath(target.href) === urlPath(scope.clonePath)
  }
  // A local or file:// company remote (tests, a server on the same machine):
  // only local paths / file URLs for the scopes too.
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^file:\/\//i.test(url)
}

// ---------------------------------------------------------------------------
// Messages (Japanese UI)
// ---------------------------------------------------------------------------

/** Q1 (owner decision): the folder is deleted without a backup, and the member is told so. */
export function accessLostMessage(folders: readonly string[]): string {
  return `このフォルダを見る権限がなくなったため、手元から削除しました（${folders.map(f => `『${f}』`).join('、')}）。同期していなかった変更も削除されています。`
}

export function madePublicMessage(folders: readonly string[], backedUp: number): string {
  const base = `${folders.map(f => `『${f}』`).join('、')}は全員に公開されたため、会社のフォルダとして同期しました。`
  return backedUp > 0 ? `${base}同期していなかった変更（${backedUp}件）は非公開フォルダのバックアップに保存しました（バックアップの一覧から戻せます）。` : base
}

export function newPrivateFolderMessage(folders: readonly string[]): string {
  return `非公開フォルダ${folders.map(f => `『${f}』`).join('、')}をダウンロードしました。`
}

export function existingFolderMovedMessage(folders: readonly string[]): string {
  return `非公開フォルダと同じ場所にあったファイルは、非公開フォルダのバックアップに移しました（${folders.map(f => `『${f}』`).join('、')}）。`
}
