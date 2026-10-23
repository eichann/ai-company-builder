/**
 * Read-only company files for the chat AI (permission plan §11): list, read
 * and search the shared branch of the company repository — and of the private
 * folders the member may read — without the member having downloaded them.
 * Contract: shared/types/company-files.ts. Route: routes/company-files.ts.
 *
 * One *view* per request: every path the member may read, built from
 *   - the company repository's main (`ls-tree -r -t -l`, cached per commit),
 *     minus anything at or under a private folder (the company repository
 *     never holds private content — RESERVED_PATH — this is defence in depth)
 *     minus paths resolveAccess() does not let the member read;
 *   - for each private folder the member may read: the folder itself, any
 *     ancestor folders it needs to be reachable, and its scope repository's
 *     main, prefixed with the folder's path and filtered by resolveAccess()
 *     too (rules deeper inside may narrow).
 * Everything the API answers comes out of the view, so a private folder the
 * member cannot read is indistinguishable from a path that never existed:
 * same 404, same empty search, nothing in any listing.
 *
 * Paths are matched as pathKey() (NFC, A–Z folded), like the push check;
 * answers spell them as stored.
 *
 * Everything runs asynchronously (spawn / execFile): this process also serves
 * git-http. Searches are bounded (time, matches, files) and limited to a few
 * at a time per company.
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { StringDecoder } from 'string_decoder'
import type Database from 'better-sqlite3'
import { gitAsync } from './git-exec'
import { listScopesWithRules } from './permission-store'
import {
  canReadPrivateScope,
  isSameOrAncestorPath,
  resolveAccess,
  type PermissionRepository,
} from './permissions'
import { companyRepoPath } from './config'
import { pathKey, privateRepoPath } from './private-folders'
import {
  COMPANY_FILES_LIMITS as LIMITS,
  type CompanyFileContent,
  type CompanyFileEntry,
  type CompanyFileMatch,
  type CompanyFilesErrorCode,
  type CompanyFilesSearch,
  type CompanyFilesTree,
} from '../../shared/types/company-files'

type Conn = Database.Database

export class CompanyFilesError extends Error {
  constructor(readonly code: CompanyFilesErrorCode, readonly status: 400 | 404 | 415 | 429 | 504, message: string) {
    super(message)
  }
}

const notFound = () => new CompanyFilesError('NOT_FOUND', 404, 'そのパスは見つかりません（存在しないか、参照できません）。')

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------

const MAX_PATH = 1024

/** Company-relative path → NFC segments; null when it is not a valid path. '' / '/' = the root. */
export function parseRequestPath(raw: string | undefined): string[] | null {
  const value = raw ?? ''
  if (value.length > MAX_PATH || value.includes('\0') || value.includes('\\')) return null
  const segments = value.normalize('NFC').split('/').filter(s => s.length > 0)
  if (segments.some(s => s === '.' || s === '..')) return null
  return segments
}

// ----------------------------------------------------------------------------
// Repository snapshots (shared branch, cached per commit)
// ----------------------------------------------------------------------------

interface RepoEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  mode: string
  oid: string
  size: number
}

interface Snapshot {
  commit: string
  entries: RepoEntry[]
}

const snapshots = new Map<string, Snapshot>()
const SNAPSHOT_CACHE_LIMIT = 32

async function mainCommit(repo: string): Promise<string | null> {
  for (const branch of ['main', 'master']) {
    try {
      const sha = (await gitAsync(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).trim()
      if (sha) return sha
    } catch {
      // next name
    }
  }
  return null
}

async function snapshotOf(repo: string): Promise<Snapshot | null> {
  if (!existsSync(repo)) return null
  const commit = await mainCommit(repo)
  if (!commit) return null
  const key = `${repo}\0${commit}`
  const hit = snapshots.get(key)
  if (hit) {
    snapshots.delete(key)
    snapshots.set(key, hit)
    return hit
  }
  const out = await gitAsync(['-C', repo, 'ls-tree', '-r', '-t', '-l', '-z', commit])
  const entries: RepoEntry[] = []
  for (const record of out.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/)
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue
    entries.push({ path: record.slice(tab + 1), type, mode, oid, size: type === 'blob' ? Number(size) || 0 : 0 })
  }
  const snapshot = { commit, entries }
  snapshots.set(key, snapshot)
  if (snapshots.size > SNAPSHOT_CACHE_LIMIT) snapshots.delete(snapshots.keys().next().value as string)
  return snapshot
}

// ----------------------------------------------------------------------------
// The member's view
// ----------------------------------------------------------------------------

interface Source {
  /** Bare repository the entry is read from. */
  repo: string
  commit: string
  /** Company path of the private folder, or null for the company repository. */
  privateFolder: string | null
}

interface ViewEntry {
  /** Company-relative path as stored ('/'-joined). */
  path: string
  key: string
  type: 'file' | 'folder'
  size?: number
  private?: true
  /** null for a folder that exists only to reach a private folder. */
  source: Source | null
  /** Path inside `source.repo` ('' for a private folder itself). */
  repoPath: string
  mode?: string
  oid?: string
}

export interface CompanyFilesView {
  commit: string
  /** The company's bare repository. */
  companyRepo: string
  entries: ViewEntry[]
  byKey: Map<string, ViewEntry[]>
  /** Private folders the member may read: company path → its source. */
  privateFolders: Array<{ path: string; key: string; source: Source }>
}

/**
 * Everything the member may read on the shared branches. Throws NOT_FOUND
 * when the company repository has no shared branch yet.
 */
export async function buildView(conn: Conn, companyId: string, userId: string, role: string): Promise<CompanyFilesView> {
  const company = await snapshotOf(companyRepoPath(companyId))
  if (!company) throw notFound()
  const scopes = listScopesWithRules(conn, companyId)
  const perms: PermissionRepository = { getMemberRole: () => role, listScopes: () => scopes }
  const readable = (path: string) => resolveAccess(companyId, userId, path, perms).read
  const privateScopes = scopes.filter(s => s.repoId !== null)
  const privateKeys = privateScopes.map(s => pathKey(s.path))
  const underPrivate = (key: string) => privateKeys.some(pk => isSameOrAncestorPath(pk, key))

  const entries: ViewEntry[] = []
  const byKey = new Map<string, ViewEntry[]>()
  const add = (e: ViewEntry) => {
    entries.push(e)
    const list = byKey.get(e.key)
    if (list) list.push(e)
    else byKey.set(e.key, [e])
  }

  const companySource: Source = { repo: companyRepoPath(companyId), commit: company.commit, privateFolder: null }
  for (const e of company.entries) {
    if (e.type === 'commit') continue // gitlinks: nothing to read
    const key = pathKey(e.path)
    if (underPrivate(key) || !readable(e.path)) continue
    add({
      path: e.path,
      key,
      type: e.type === 'tree' ? 'folder' : 'file',
      ...(e.type === 'blob' ? { size: e.size } : {}),
      source: companySource,
      repoPath: e.path,
      mode: e.mode,
      oid: e.oid,
    })
  }

  const privateFolders: CompanyFilesView['privateFolders'] = []
  for (const scope of privateScopes) {
    if (!canReadPrivateScope(scope, userId, role) || !readable(scope.path)) continue
    const repo = privateRepoPath(companyId, scope.repoId as string)
    const snap = await snapshotOf(repo)
    if (!snap) continue
    const source: Source = { repo, commit: snap.commit, privateFolder: scope.path }
    const segments = scope.path.split('/').filter(Boolean)
    // Ancestors: reachable even when nothing else of them is in the company repository.
    for (let i = 1; i < segments.length; i++) {
      const path = segments.slice(0, i).join('/')
      const key = pathKey(path)
      if (!byKey.has(key)) add({ path, key, type: 'folder', source: null, repoPath: '' })
    }
    const folderKey = pathKey(scope.path)
    add({ path: scope.path, key: folderKey, type: 'folder', private: true, source, repoPath: '' })
    privateFolders.push({ path: scope.path, key: folderKey, source })
    for (const e of snap.entries) {
      if (e.type === 'commit') continue
      const path = `${scope.path}/${e.path}`
      if (!readable(path)) continue
      add({
        path,
        key: pathKey(path),
        type: e.type === 'tree' ? 'folder' : 'file',
        ...(e.type === 'blob' ? { size: e.size } : {}),
        source,
        repoPath: e.path,
        mode: e.mode,
        oid: e.oid,
      })
    }
  }
  return { commit: company.commit, companyRepo: companySource.repo, entries, byKey, privateFolders }
}

/** The entry at `segments` (NFC spelling preferred over another case), or null for the root. Throws NOT_FOUND. */
function find(view: CompanyFilesView, segments: string[]): ViewEntry | null {
  if (segments.length === 0) return null
  const wanted = segments.join('/')
  const hits = view.byKey.get(pathKey(wanted))
  if (!hits || hits.length === 0) throw notFound()
  return hits.find(h => h.path.normalize('NFC') === wanted) ?? hits[0]
}

function privateFolderOf(view: CompanyFilesView, key: string) {
  return view.privateFolders.find(p => isSameOrAncestorPath(p.key, key)) ?? null
}

function compareSegments(a: string, b: string): number {
  const as = a.normalize('NFC').split('/')
  const bs = b.normalize('NFC').split('/')
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return as[i].localeCompare(bs[i], 'ja')
  }
  return as.length - bs.length
}

const depthOf = (key: string) => (key === '' ? 0 : key.split('/').length)

// ----------------------------------------------------------------------------
// tree
// ----------------------------------------------------------------------------

export function listTree(view: CompanyFilesView, segments: string[], depth: number): CompanyFilesTree {
  const base = find(view, segments)
  if (base && base.type !== 'folder') throw new CompanyFilesError('NOT_A_FOLDER', 400, 'フォルダではありません。ファイルは company_read_file で読んでください。')
  const baseKey = base?.key ?? ''
  const baseDepth = depthOf(baseKey)
  const seen = new Set<string>()
  const within = view.entries
    .filter(e => e.key !== baseKey && isSameOrAncestorPath(baseKey, e.key) && depthOf(e.key) - baseDepth <= depth)
    // a name stored twice (case variants in two repositories) is listed once
    .filter(e => {
      const id = `${e.type}\0${e.path}`
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => compareSegments(a.path, b.path))
  const truncated = within.length > LIMITS.treeMaxEntries
  const entries: CompanyFileEntry[] = within.slice(0, LIMITS.treeMaxEntries).map(e => ({
    name: e.path.split('/').pop() as string,
    path: e.path,
    type: e.type,
    ...(e.size !== undefined ? { size: e.size } : {}),
    ...(e.private ? { private: true as const } : {}),
  }))
  const priv = base ? privateFolderOf(view, base.key) : null
  return {
    commit: view.commit,
    path: base?.path ?? '',
    depth,
    entries,
    truncated,
    ...(priv ? { privateFolder: { path: priv.path, commit: priv.source.commit } } : {}),
  }
}

// ----------------------------------------------------------------------------
// content
// ----------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'key', 'numbers', 'pages',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tif', 'tiff', 'ico', 'psd', 'ai', 'sketch', 'fig',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'exe', 'dll', 'so', 'dylib', 'bin',
  'ttf', 'otf', 'woff', 'woff2', 'sqlite', 'db',
])

const binaryError = () => new CompanyFilesError('BINARY_FILE', 415,
  'バイナリファイル（PDF・PowerPoint・Excel・Word・画像・動画など）は読めません。読めるのはテキストのファイルだけです。')

export interface ReadOptions {
  /** First line to return, 1-based. */
  offset: number
  limit: number
  maxBytes: number
}

interface BlobLines {
  binary: boolean
  lines: string[]
  lastLine: number
  totalLines?: number
  hasMore: boolean
  truncated: boolean
}

/** Stream a blob and keep only the requested lines (never the whole file in memory). */
export function readBlobLines(repo: string, oid: string, opts: ReadOptions, timeoutMs = 15_000): Promise<BlobLines> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', 'blob', oid], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const decoder = new StringDecoder('utf8')
    const lines: string[] = []
    let bytes = 0
    let lineNo = 0 // lines completed so far
    let pending = '' // the current line, only while it is being collected
    let pendingTooLong = false
    let partial = false // characters after the last newline (a last line without one)
    let sniffed = 0
    let done = false
    let truncated = false
    let hasMore = false
    let stderr = ''
    const lastWanted = opts.offset + opts.limit - 1

    const finish = (result: BlobLines | Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      if (!child.killed && child.exitCode === null) child.kill()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const result = (end: boolean): BlobLines => ({
      binary: false,
      lines,
      lastLine: opts.offset + lines.length - 1,
      ...(end ? { totalLines: lineNo } : {}),
      hasMore,
      truncated,
    })
    const timer = setTimeout(() => finish(new CompanyFilesError('TIMEOUT', 504, 'ファイルの読み取りが時間内に終わりませんでした。')), timeoutMs)

    /** A line (without its newline) is complete. Returns false to stop reading. */
    const completeLine = (text: string): boolean => {
      lineNo++
      if (lineNo < opts.offset) return true
      if (lineNo > lastWanted) {
        hasMore = true
        return false
      }
      const clean = text.endsWith('\r') ? text.slice(0, -1) : text
      const size = Buffer.byteLength(clean) + 1
      if (bytes + size > opts.maxBytes) {
        truncated = true
        if (lines.length === 0) lines.push(cutToBytes(clean, opts.maxBytes))
        hasMore = true
        return false
      }
      lines.push(clean)
      bytes += size
      return true
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return
      if (sniffed < 8000) {
        const head = chunk.subarray(0, 8000 - sniffed)
        sniffed += head.length
        if (head.includes(0)) {
          finish({ binary: true, lines: [], lastLine: 0, hasMore: false, truncated: false })
          return
        }
      }
      const text = decoder.write(chunk)
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        const collecting = lineNo + 1 >= opts.offset
        if (nl === -1) {
          if (start < text.length) partial = true
          if (collecting && !pendingTooLong) {
            pending += text.slice(start)
            // A line longer than the cap: keep what fits, the rest is cut anyway.
            if (pending.length > opts.maxBytes) {
              pending = pending.slice(0, opts.maxBytes)
              pendingTooLong = true
            }
          }
          break
        }
        const line = collecting ? pending + (pendingTooLong ? '' : text.slice(start, nl)) : ''
        pending = ''
        pendingTooLong = false
        partial = false
        if (!completeLine(line)) {
          finish(result(false))
          return
        }
        start = nl + 1
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', err => finish(err))
    child.on('close', code => {
      if (done) return
      if (code !== 0) {
        finish(new Error(`git cat-file failed: ${stderr.trim()}`))
        return
      }
      const tail = decoder.end()
      const rest = pending + (pendingTooLong ? '' : tail)
      if (partial || tail.length > 0) {
        if (!completeLine(rest)) {
          finish(result(false))
          return
        }
      }
      finish(result(true))
    })
  })
}

function cutToBytes(text: string, maxBytes: number): string {
  let out = ''
  let size = 0
  for (const ch of text) {
    size += Buffer.byteLength(ch)
    if (size > maxBytes) break
    out += ch
  }
  return out
}

export async function readContent(view: CompanyFilesView, segments: string[], opts: ReadOptions): Promise<CompanyFileContent> {
  const entry = find(view, segments)
  if (!entry || entry.type === 'folder') throw new CompanyFilesError('IS_A_FOLDER', 400, 'フォルダです。中身の一覧は company_list で見てください。')
  if (!entry.source || !entry.oid) throw notFound()
  if (entry.mode === '120000') throw new CompanyFilesError('NOT_A_REGULAR_FILE', 400, 'シンボリックリンクは読めません。')
  const ext = entry.path.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase()
  if (ext && BINARY_EXTENSIONS.has(ext)) throw binaryError()
  const read = await readBlobLines(entry.source.repo, entry.oid, opts)
  if (read.binary) throw binaryError()
  const endLine = read.lastLine
  return {
    commit: entry.source.commit,
    path: entry.path,
    size: entry.size ?? 0,
    startLine: opts.offset,
    endLine,
    ...(read.totalLines !== undefined ? { totalLines: read.totalLines } : {}),
    hasMore: read.hasMore,
    ...(read.hasMore ? { nextOffset: endLine + 1 } : {}),
    truncated: read.truncated,
    content: read.lines.join('\n'),
    ...(entry.source.privateFolder ? { privateFolder: entry.source.privateFolder } : {}),
  }
}

// ----------------------------------------------------------------------------
// search
// ----------------------------------------------------------------------------

export interface SearchOptions {
  query: string
  regex: boolean
  caseSensitive: boolean
  limit: number
  timeoutMs?: number
  /**
   * Also search the private folders below the searched path (default false).
   * A search whose path is itself inside a private folder names it
   * explicitly and is served either way. Owners/admins can read every
   * private folder, so without this a company-wide search pulled private
   * content into the chat by accident.
   */
  includePrivate?: boolean
}

interface GrepTarget {
  repo: string
  commit: string
  /** Company path the repository's paths are relative to ('' for the company repository). */
  prefix: string
  pathspec: string | null
}

/**
 * Locale of git grep. A fixed string is matched bytewise (LC_ALL=C): exact
 * for Japanese, A–Z folded with -i, and fast — case-insensitive matching in
 * a UTF-8 locale took ~14 s for a 2 MB file with macOS's regex library. A
 * regular expression needs a UTF-8 locale so that `.` and `[…]` match whole
 * characters (a locale that is not installed falls back to C); the time
 * limit bounds it.
 */
const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'

const busy = () => new CompanyFilesError('BUSY', 429, '検索が混み合っています。少し待ってからもう一度試してください。')

const MAX_CONCURRENT_SEARCHES = 2
const MAX_QUEUED_SEARCHES = 4
const QUEUE_WAIT_MS = 10_000
const searchSlots = new Map<string, { running: number; queue: Array<() => void> }>()

/** Run `fn` holding one of the company's search slots (FIFO queue, bounded wait). */
export async function withSearchSlot<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  let slot = searchSlots.get(companyId)
  if (!slot) {
    slot = { running: 0, queue: [] }
    searchSlots.set(companyId, slot)
  }
  const s = slot
  if (s.running >= MAX_CONCURRENT_SEARCHES) {
    if (s.queue.length >= MAX_QUEUED_SEARCHES) throw busy()
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const i = s.queue.indexOf(go)
        if (i !== -1) s.queue.splice(i, 1)
        reject(busy())
      }, QUEUE_WAIT_MS)
      s.queue.push(go)
    })
  }
  s.running++
  try {
    return await fn()
  } finally {
    s.running--
    const next = s.queue.shift()
    if (next) next()
    else if (s.running === 0) searchSlots.delete(companyId)
  }
}

/**
 * Cut a long matching line around the match. `column` is the 1-based BYTE
 * offset of the first match, as `git grep --column` reports it. The query is
 * never evaluated here: a member's regular expression run in this process
 * (no time limit, unlike git grep's) could block the event loop — every
 * request of every company — for minutes on a pathological pattern.
 */
export function snippet(text: string, column: number): string {
  const max = LIMITS.snippetMaxChars
  if (text.length <= max) return text
  let at = -1
  if (Number.isInteger(column) && column >= 1) {
    const bytes = Buffer.from(text, 'utf8')
    if (column - 1 <= bytes.length) at = bytes.subarray(0, column - 1).toString('utf8').length
  }
  const start = Math.max(0, Math.min(at === -1 ? 0 : at - Math.floor(max / 3), text.length - max))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`
}

interface GrepState {
  matches: CompanyFileMatch[]
  files: Set<string>
  truncated: boolean
  timedOut: boolean
  deadline: number
}

function grepTarget(view: CompanyFilesView, target: GrepTarget, opts: SearchOptions, state: GrepState): Promise<void> {
  return new Promise((resolve, reject) => {
    const remaining = state.deadline - Date.now()
    if (remaining <= 0) {
      state.timedOut = true
      resolve()
      return
    }
    const patterns = ['-e', opts.query]
    // A Mac may have saved the text in NFD.
    const nfd = opts.query.normalize('NFD')
    if (!opts.regex && nfd !== opts.query) patterns.push('-e', nfd)
    const args = [
      '-C', target.repo,
      '-c', 'grep.threads=2',
      '-c', 'grep.fallbackToNoIndex=false',
      'grep', '-I', '-n', '--column', '-z', '--no-color',
      '-m', String(LIMITS.searchMaxMatchesPerFile),
      ...(opts.caseSensitive ? [] : ['-i']),
      opts.regex ? '-E' : '-F',
      ...patterns,
      target.commit,
      '--',
      ...(target.pathspec ? [`:(literal)${target.pathspec}`] : []),
    ]
    const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: opts.regex ? UTF8_LOCALE : 'C' } })
    const decoder = new StringDecoder('utf8')
    const revPrefix = `${target.commit}:`
    let buffer = ''
    let stderr = ''
    let done = false
    const stop = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      if (child.exitCode === null) child.kill()
      resolve()
    }
    const timer = setTimeout(() => {
      state.timedOut = true
      stop()
    }, remaining)
    const record = (line: string): boolean => {
      const a = line.indexOf('\0')
      const b = a === -1 ? -1 : line.indexOf('\0', a + 1)
      // <rev>:<path> NUL <line> NUL <column> NUL <text>
      const col = b === -1 ? -1 : line.indexOf('\0', b + 1)
      if (a === -1 || b === -1 || col === -1) return true
      let name = line.slice(0, a)
      if (name.startsWith(revPrefix)) name = name.slice(revPrefix.length)
      const path = target.prefix ? `${target.prefix}/${name}` : name
      // Only what the view holds: never a private path through the company
      // repository, never a path the member may not read.
      const key = pathKey(path)
      if (!view.byKey.get(key)?.some(e => e.type === 'file')) return true
      if (target.prefix === '' && view.privateFolders.some(p => isSameOrAncestorPath(p.key, key))) return true
      if (!state.files.has(path)) {
        if (state.files.size >= LIMITS.searchMaxFiles) {
          state.truncated = true
          return false
        }
        state.files.add(path)
      }
      let text = line.slice(col + 1)
      if (text.endsWith('\r')) text = text.slice(0, -1)
      state.matches.push({ path, line: Number(line.slice(a + 1, b)), text: snippet(text, Number(line.slice(b + 1, col))) })
      if (state.matches.length >= opts.limit) {
        state.truncated = true
        return false
      }
      return true
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return
      buffer += decoder.write(chunk)
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!record(line)) {
          // One more match may exist beyond the limit; that is what truncated says.
          stop()
          return
        }
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', err => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      if (done) return
      if (buffer.length > 0) record(buffer)
      if (code !== 0 && code !== 1) {
        done = true
        clearTimeout(timer)
        if (/regex|regcomp|Invalid|Unmatched|brace|parenthes/i.test(stderr)) {
          reject(new CompanyFilesError('INVALID_QUERY', 400, `正規表現が正しくありません: ${stderr.trim().split('\n')[0]}`))
        } else {
          reject(new Error(`git grep failed (${code}): ${stderr.trim()}`))
        }
        return
      }
      stop()
    })
  })
}

export async function searchFiles(view: CompanyFilesView, segments: string[], opts: SearchOptions): Promise<CompanyFilesSearch> {
  const base = find(view, segments)
  const baseKey = base?.key ?? ''
  const targets: GrepTarget[] = []
  const inside = privateFolderOf(view, baseKey)
  if (inside) {
    targets.push({ repo: inside.source.repo, commit: inside.source.commit, prefix: inside.path, pathspec: base && base.repoPath ? base.repoPath : null })
  } else {
    // The company repository (a folder that exists only to reach a private
    // folder has no company path: nothing to search there), then every
    // readable private folder below the base.
    if (!base || base.source) {
      targets.push({ repo: view.companyRepo, commit: view.commit, prefix: '', pathspec: base ? base.repoPath : null })
    }
    for (const p of opts.includePrivate ? view.privateFolders : []) {
      if (p.key !== baseKey && isSameOrAncestorPath(baseKey, p.key)) {
        targets.push({ repo: p.source.repo, commit: p.source.commit, prefix: p.path, pathspec: null })
      }
    }
  }
  const state: GrepState = { matches: [], files: new Set(), truncated: false, timedOut: false, deadline: Date.now() + (opts.timeoutMs ?? LIMITS.searchTimeoutMs) }
  const searchedPrivate: Record<string, string> = {}
  for (const t of targets) {
    if (state.truncated || state.timedOut) break
    if (t.prefix) searchedPrivate[t.prefix] = t.commit
    await grepTarget(view, t, opts, state)
  }
  return {
    commit: view.commit,
    path: base?.path ?? '',
    query: opts.query,
    regex: opts.regex,
    caseSensitive: opts.caseSensitive,
    matches: state.matches,
    files: state.files.size,
    truncated: state.truncated,
    timedOut: state.timedOut,
    ...(Object.keys(searchedPrivate).length > 0 ? { privateFolders: searchedPrivate } : {}),
  }
}

