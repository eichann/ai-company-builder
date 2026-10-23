// Content search, file-name listing and folder history for the app's search
// tab, Cmd+P and history panel (main.ts git:grep / git:listFiles / git:log).
// No Electron import: tests/git-search.test.ts runs it against scratch repos.
//
// Why the limits (measured on a ~6.5k-file company, 2026-10-23): searching
// 「の」 in one department returned 168,856 lines (53 MB) from git in ~2 s;
// main buffered it, sent it over IPC and the renderer drew every row → the
// window froze or crashed. Now git's output is streamed, every file stops
// after GREP_MAX_PER_FILE matches, the whole search after GREP_MAX_TOTAL
// (the git process is killed there) and each line is cut to
// GREP_LINE_CHARS around the match; the answer says `truncated`.
//
// What is searched — the files on this computer, never git's history:
//  - the worktree, tracked files and untracked ones (a file the AI just
//    created is found before it is synced), ignored files never;
//  - never a folder that is not downloaded (sparse exclusions, partial
//    clone): those paths are excluded by pathspec, and every command runs
//    with GIT_NO_LAZY_FETCH=1, so even a git that searched a skip-worktree
//    entry from the index would fail instead of downloading the blob;
//  - never `.backups/` / `.workspace/` (any depth; normally ignored anyway,
//    but a shared `.gitignore` negation could re-include them);
//  - readable private folders (their clones sit in the checkout and the file
//    tree shows them) are searched in their own repository, paths reported
//    company-relative. git never descends into a nested repository from the
//    company one, so a private folder the member cannot read — never on disk
//    — and stray repositories are not searched.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { notDownloadedFolders } from './sync/not-downloaded'
import { readPrivateScopesCache, safeScopeDir } from './sync/private-folders'

export const GREP_MAX_PER_FILE = 20
export const GREP_MAX_TOTAL = 500
export const GREP_LINE_CHARS = 300
export const GREP_TIMEOUT_MS = 15_000
export const LIST_MAX_FILES = 50_000
/** A record (one matched line) longer than this is cut while it streams. */
const MAX_RECORD_BYTES = 256 * 1024

export interface GitCommand {
  binary: string
  /** `-c key=value` arguments placed before the subcommand. */
  configArgs: string[]
  env: NodeJS.ProcessEnv
}

export interface GrepMatch {
  /** Company-relative path. */
  file: string
  line: number
  /** The matched line, cut to about GREP_LINE_CHARS around the match. */
  text: string
  /** Where the match starts in `text` (UTF-16 index), when known. */
  column?: number
}

export interface GrepResult {
  matches: GrepMatch[]
  /** Stopped at GREP_MAX_TOTAL (or the timeout): there are more matches. */
  truncated: boolean
  timedOut: boolean
}

/** A readable private folder's clone inside the checkout. */
export interface PrivateClone {
  /** Company-relative path of the folder. */
  path: string
  /** Absolute directory of its clone. */
  dir: string
}

export interface SearchScope {
  repoPath: string
  /** Company-relative folder to search; '' (or '/', '.') = the whole company. */
  folder: string
  /** Folders not downloaded on this computer (company-relative). */
  notDownloaded: readonly string[]
  /** Readable private folders that are on disk. */
  privateClones: readonly PrivateClone[]
}

/**
 * The scope of a search in the company checkout at `repoPath`: its
 * not-downloaded folders (read from .git, no git process) and the readable
 * private folders whose clone is on disk (from the cached /me/scopes answer).
 */
export function companySearchScope(repoPath: string, folder: string): SearchScope {
  const scopes = readPrivateScopesCache(repoPath)?.scopes ?? []
  const privateClones: PrivateClone[] = []
  for (const s of scopes) {
    const dir = safeScopeDir(repoPath, s.path)
    if (!dir) continue
    try {
      if (!fs.statSync(path.join(dir, '.git')).isDirectory()) continue
    } catch {
      continue
    }
    privateClones.push({ path: s.path, dir })
  }
  return { repoPath, folder, notDownloaded: notDownloadedFolders(repoPath), privateClones }
}

/** '' / '/' / '.' / 'a/b/' → '' / '' / '' / 'a/b'. Throws on '..' or an absolute path. */
export function normalizeSearchFolder(folder: string | undefined | null): string {
  const f = (folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (f === '' || f === '.') return ''
  const segments = f.split('/')
  if (segments.some(s => s === '..' || s === '.') || /^[A-Za-z]:/.test(f)) {
    throw new Error(`Invalid folder: ${folder}`)
  }
  return f
}

function nfcNfd(p: string): string[] {
  const nfc = p.normalize('NFC')
  const nfd = p.normalize('NFD')
  return nfc === nfd ? [nfc] : [nfc, nfd]
}

/** Exclusion pathspecs: local-only folders at any depth, plus the given folders (repository-relative). */
export function excludePathspecs(folders: readonly string[]): string[] {
  const specs = [
    ':(exclude,glob,icase)**/.backups/**',
    ':(exclude,glob,icase)**/.workspace/**',
  ]
  for (const f of folders) {
    for (const v of nfcNfd(f.replace(/\/+$/, ''))) specs.push(`:(exclude,literal,icase)${v}`)
  }
  return specs
}

/** The pathspec for a (normalized) folder: everything when ''. */
function folderPathspec(folder: string): string {
  return folder === '' ? '.' : `:(literal)${folder}`
}

function isAtOrUnder(ancestor: string, p: string): boolean {
  if (ancestor === '') return true
  const a = ancestor.normalize('NFC').toLowerCase()
  const k = p.normalize('NFC').toLowerCase()
  return k === a || k.startsWith(`${a}/`)
}

/**
 * Where to run git for a search of `folder`: the company repository, plus
 * each private clone at or under the folder (searched whole), or the one
 * clone the folder lies inside (searched below it).
 */
export function searchTargets(scope: SearchScope): Array<{ cwd: string; prefix: string; folder: string; exclude: string[] }> {
  const folder = normalizeSearchFolder(scope.folder)
  const inside = scope.privateClones.find(c => isAtOrUnder(c.path, folder) && folder !== '')
  if (inside) {
    const rel = folder.slice(inside.path.length).replace(/^\//, '')
    return [{ cwd: inside.dir, prefix: inside.path, folder: rel, exclude: [] }]
  }
  const targets = [{
    cwd: scope.repoPath,
    prefix: '',
    folder,
    // Not-downloaded folders, and the private clones themselves (git does not
    // descend into a nested repository anyway; this keeps it that way even
    // for a clone that lost its .git).
    exclude: [...scope.notDownloaded, ...scope.privateClones.map(c => c.path)],
  }]
  for (const clone of scope.privateClones) {
    if (!isAtOrUnder(folder, clone.path)) continue
    // A private folder inside a not-downloaded folder is not on disk either.
    if (scope.notDownloaded.some(n => isAtOrUnder(n, clone.path))) continue
    targets.push({ cwd: clone.dir, prefix: clone.path, folder: '', exclude: [] })
  }
  return targets
}

/** The `git grep` arguments (after the config arguments). Fixed-string, A–Z case-insensitive. */
export function grepArgs(query: string, folder: string, exclude: readonly string[]): string[] {
  const patterns = nfcNfd(query).flatMap(q => ['-e', q])
  return [
    'grep', '-z', '-n', '--column', '-I', '-F', '-i',
    `--max-count=${GREP_MAX_PER_FILE}`,
    '--untracked',
    ...patterns,
    '--', folderPathspec(folder), ...excludePathspecs(exclude),
  ]
}

/**
 * Cut `line` to about `max` characters around the match that starts at byte
 * `byteColumn` (1-based, as `git grep --column` reports it under LC_ALL=C).
 */
export function trimMatchLine(line: Buffer, byteColumn: number, max = GREP_LINE_CHARS): { text: string; column?: number } {
  const full = line.toString('utf8').replace(/\r$/, '')
  const col = byteColumn > 0 && byteColumn <= line.length ? line.subarray(0, byteColumn - 1).toString('utf8').length : undefined
  if (full.length <= max) return { text: full, column: col }
  const at = col ?? 0
  let start = Math.max(0, Math.min(at - Math.floor(max / 3), full.length - max))
  let end = Math.min(full.length, start + max)
  // Never split a surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(full[start])) start++
  if (end < full.length && /[\uD800-\uDBFF]/.test(full[end - 1])) end--
  const head = start > 0 ? '…' : ''
  const tail = end < full.length ? '…' : ''
  return { text: `${head}${full.slice(start, end)}${tail}`, column: col === undefined ? undefined : col - start + head.length }
}

/** Parse one `-z -n --column` record (`file\0line\0col\0text`). */
export function parseGrepRecord(record: Buffer): { file: string; line: number; byteColumn: number; text: Buffer } | null {
  const a = record.indexOf(0)
  if (a < 0) return null
  const b = record.indexOf(0, a + 1)
  if (b < 0) return null
  const c = record.indexOf(0, b + 1)
  if (c < 0) return null
  const line = parseInt(record.subarray(a + 1, b).toString('latin1'), 10)
  const byteColumn = parseInt(record.subarray(b + 1, c).toString('latin1'), 10)
  if (!Number.isFinite(line)) return null
  return { file: record.subarray(0, a).toString('utf8'), line, byteColumn: Number.isFinite(byteColumn) ? byteColumn : 0, text: record.subarray(c + 1) }
}

interface RunOptions {
  signal?: AbortSignal
  timeoutMs: number
  /** Called per stdout record (split on `sep`); return false to stop git. */
  onRecord: (record: Buffer) => boolean
  sep: number
}

interface RunResult { code: number | null; stderr: string; stopped: boolean; timedOut: boolean }

/** Spawn git, stream its stdout as records, stop it early on demand or after the timeout. */
function runStreaming(cmd: GitCommand, cwd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.binary, [...cmd.configArgs, ...args], {
      cwd,
      env: {
        ...cmd.env,
        // Read commands: never download a missing blob, never take the
        // index lock to refresh stat info.
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        // Bytewise matching: exact for Japanese, A–Z folded with -i, and
        // --column is a byte offset. (A UTF-8 locale made -i very slow with
        // macOS's regex library — see the server's company search.)
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // fork+exec instead of posix_spawn in Electron (see git-factory.ts).
      ...(process.getuid ? { uid: process.getuid() } : {}),
    })
    let stopped = false
    let timedOut = false
    let stderr = ''
    let pending: Buffer[] = []
    let pendingLen = 0
    let skipToSep = false
    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill('SIGTERM')
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, opts.timeoutMs)
    const onAbort = () => stop()
    opts.signal?.addEventListener('abort', onAbort)
    if (opts.signal?.aborted) stop()

    const emit = (record: Buffer) => {
      if (stopped) return
      if (!opts.onRecord(record)) stop()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      let from = 0
      while (from < chunk.length && !stopped) {
        const i = chunk.indexOf(opts.sep, from)
        if (i < 0) {
          if (!skipToSep) {
            pending.push(chunk.subarray(from))
            pendingLen += chunk.length - from
            if (pendingLen > MAX_RECORD_BYTES) {
              // A giant line (minified file): keep its head, drop the rest.
              emit(Buffer.concat(pending).subarray(0, MAX_RECORD_BYTES))
              pending = []
              pendingLen = 0
              skipToSep = true
            }
          }
          break
        }
        if (skipToSep) {
          skipToSep = false
        } else {
          pending.push(chunk.subarray(from, i))
          emit(pending.length === 1 ? pending[0] : Buffer.concat(pending))
        }
        pending = []
        pendingLen = 0
        from = i + 1
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })
    child.on('error', err => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (!stopped && !skipToSep && pendingLen > 0) emit(Buffer.concat(pending))
      resolve({ code, stderr: stderr.trim(), stopped, timedOut })
    })
  })
}

function folderExists(cwd: string, folder: string): boolean {
  if (folder === '') return true
  try { return fs.statSync(path.join(cwd, ...folder.split('/'))).isDirectory() } catch { return false }
}

/**
 * Search the files of `scope.folder` for `query` (fixed string, A–Z
 * case-insensitive). At most GREP_MAX_PER_FILE matches per file and
 * GREP_MAX_TOTAL in all.
 */
export async function grepCompany(cmd: GitCommand, scope: SearchScope, query: string, signal?: AbortSignal, limits?: { maxTotal?: number; timeoutMs?: number }): Promise<GrepResult> {
  const maxTotal = limits?.maxTotal ?? GREP_MAX_TOTAL
  const deadline = Date.now() + (limits?.timeoutMs ?? GREP_TIMEOUT_MS)
  const matches: GrepMatch[] = []
  let truncated = false
  let timedOut = false
  if (!query) return { matches, truncated, timedOut }
  for (const target of searchTargets(scope)) {
    if (matches.length >= maxTotal) { truncated = true; break }
    if (!folderExists(target.cwd, target.folder)) continue
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) { truncated = true; timedOut = true; break }
    const res = await runStreaming(cmd, target.cwd, grepArgs(query, target.folder, target.exclude), {
      signal,
      timeoutMs: remainingMs,
      sep: 0x0a,
      onRecord: record => {
        const parsed = parseGrepRecord(record)
        if (!parsed) return true
        if (matches.length >= maxTotal) { truncated = true; return false }
        const { text, column } = trimMatchLine(parsed.text, parsed.byteColumn)
        const file = target.prefix ? `${target.prefix}/${parsed.file}` : parsed.file
        matches.push({ file, line: parsed.line, text, column })
        return true
      },
    })
    if (res.timedOut) { truncated = true; timedOut = true; break }
    if (signal?.aborted) break
    // 0 = matches, 1 = none; anything else is an error (unless we stopped it).
    if (!res.stopped && res.code !== 0 && res.code !== 1) {
      throw new Error(res.stderr || `git grep exited with ${res.code}`)
    }
  }
  return { matches, truncated, timedOut }
}

/** The `git ls-files` arguments: tracked and untracked, not ignored, NUL-separated. */
export function listFilesArgs(folder: string, exclude: readonly string[]): string[] {
  return ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', folderPathspec(folder), ...excludePathspecs(exclude)]
}

/** Every file (tracked or not, never ignored) in `scope.folder`, company-relative. */
export async function listCompanyFiles(cmd: GitCommand, scope: SearchScope, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const seen = new Set<string>()
  const files: string[] = []
  let truncated = false
  for (const target of searchTargets(scope)) {
    if (files.length >= LIST_MAX_FILES) { truncated = true; break }
    if (!folderExists(target.cwd, target.folder)) continue
    const res = await runStreaming(cmd, target.cwd, listFilesArgs(target.folder, target.exclude), {
      signal,
      timeoutMs: GREP_TIMEOUT_MS,
      sep: 0x00,
      onRecord: record => {
        const rel = record.toString('utf8')
        // A nested repository is listed as `dir/`: not a file.
        if (!rel || rel.endsWith('/')) return true
        const file = target.prefix ? `${target.prefix}/${rel}` : rel
        if (seen.has(file)) return true // an unmerged path is listed once per stage
        if (files.length >= LIST_MAX_FILES) { truncated = true; return false }
        seen.add(file)
        files.push(file)
        return true
      },
    })
    if (res.timedOut) { truncated = true; break }
    if (!res.stopped && res.code !== 0) throw new Error(res.stderr || `git ls-files exited with ${res.code}`)
  }
  return { files, truncated }
}

// ---------------------------------------------------------------------------
// Folder history (git:log)
// ---------------------------------------------------------------------------

export interface LogCommit {
  hash: string
  hashShort: string
  message: string
  author: string
  date: string
}

const FIELD = '\x1f'
const RECORD = '\x1e'

/**
 * `git log` for a folder. No `--follow`: simple-git's `file` option added it,
 * which made git track renames of the *folder* path commit by commit — 0.9 s
 * instead of 0.02 s on a 5k-file department, with the same commits (rename
 * following only works for a single file anyway).
 */
export function gitLogArgs(folder: string, limit: number): string[] {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 50
  const args = ['log', `--max-count=${n}`, `--format=%H${FIELD}%aI${FIELD}%aN${FIELD}%s${FIELD}%b${RECORD}`]
  const f = normalizeSearchFolder(folder)
  if (f) args.push('--', `:(literal)${f}/`)
  return args
}

export function parseGitLog(raw: string): LogCommit[] {
  const commits: LogCommit[] = []
  for (const rec of raw.split(RECORD)) {
    const r = rec.replace(/^\s+/, '')
    if (!r) continue
    const [hash, date, author, subject, body = ''] = r.split(FIELD)
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) continue
    const b = body.trim()
    commits.push({
      hash,
      hashShort: hash.substring(0, 7),
      message: b ? `${subject}\n${b}`.trim() : subject,
      author,
      date,
    })
  }
  return commits
}
