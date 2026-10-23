/**
 * One file watcher per company folder (CLAUDE.md "File watching").
 *
 * A single native recursive `fs.watch` on the company root (FSEvents on macOS,
 * ReadDirectoryChangesW on Windows, inotify on Linux with Node ≥ 20), opened
 * when the company opens and closed when it closes or the app quits — never
 * on a department switch. chokidar 5 (the previous implementation, one
 * watcher per department) opens one `fs.watch` per directory and file
 * (~14k for a 6.7k-entry company) and closes them synchronously on the main
 * thread: 33–40 s for the whole company, during which every IPC call waited.
 * The native recursive watcher opens in a few milliseconds and closes in
 * under one.
 *
 * `fs.watch` reports only 'rename' (created, deleted or renamed — ambiguous)
 * or 'change' (content) with a path relative to the root. Raw events are
 * collected per path for a short window and then classified by `lstat` into
 * the event shape the renderer already understood from chokidar:
 * add / addDir / unlink / unlinkDir / change. A file replaced by
 * write-temp-then-rename therefore arrives as one 'add' (it exists) — the
 * renderer treats 'add' of an open file like 'change'.
 *
 * Nothing here imports Electron: main.ts injects the sender and, where
 * recursive watching is unavailable, a fallback watcher.
 */
import fs from 'node:fs'
import path from 'node:path'

export type FileChangeType = 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'
export interface FileChange { type: FileChangeType; path: string }
export type RawEventType = 'rename' | 'change'

/**
 * Directories whose contents never reach the renderer: git internals (the
 * company's and every private folder clone's, at any depth), dependencies,
 * the AI's scratch space and sync's backups. The directory entry itself
 * still passes (the tree lists it); only what is inside is dropped.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.workspace', '.backups'])
/** Files nobody looks at in the tree (Finder writes these constantly). */
const IGNORED_FILES: ReadonlySet<string> = new Set(['.ds_store'])

/** Events are collected this long after the first one, then sent together. */
export const DEFAULT_WINDOW_MS = 100
/** At most this many paths are classified and sent per batch; the rest follow in the next one. */
export const DEFAULT_MAX_BATCH = 2000
/** Parallel lstat calls while classifying a batch. */
const STAT_CONCURRENCY = 32
/** Directories remembered (to report unlinkDir rather than unlink); bounded. */
const MAX_KNOWN_DIRS = 20000

/**
 * True when a path (relative to the watched root, either separator) lies
 * inside an ignored directory, or is an ignored file. Case-insensitive: macOS
 * and Windows treat `.GIT` as `.git`.
 */
export function isIgnoredRelative(rel: string): boolean {
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return false
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRECTORIES.has(segments[i].toLowerCase())) return true
  }
  return IGNORED_FILES.has(segments[segments.length - 1].toLowerCase())
}

export interface RawFlags { rename: boolean; change: boolean }
export interface StatResult { isDirectory: boolean }

/**
 * The event to report for one path, from what fs.watch said during the
 * window and what is on disk now. null = nothing worth reporting (a
 * directory's own metadata changed).
 */
export function classifyChange(raw: RawFlags, stat: StatResult | null, knownDirectory: boolean): FileChangeType | null {
  if (!stat) return knownDirectory ? 'unlinkDir' : 'unlink'
  if (stat.isDirectory) return raw.rename ? 'addDir' : null
  return raw.rename ? 'add' : 'change'
}

export interface WatchHandle { close(): void }

export interface CompanyWatcherOptions {
  root: string
  onChanges: (changes: FileChange[]) => void
  windowMs?: number
  maxBatch?: number
  logger?: { warn: (...args: unknown[]) => void; log: (...args: unknown[]) => void }
  /** Injected for tests; defaults to `fs.watch` with `{ recursive: true }`. */
  watchRecursive?: (root: string, onRaw: (type: RawEventType, rel: string | null) => void, onError: (error: unknown) => void) => WatchHandle
  /**
   * Used when recursive `fs.watch` is not available on this platform/runtime
   * (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM). Reports paths relative to the root.
   */
  fallback?: (root: string, onRaw: (type: RawEventType, rel: string) => void, onError: (error: unknown) => void) => WatchHandle
  /** Injected for tests; defaults to `fs.promises.lstat`. */
  lstat?: (absPath: string) => Promise<StatResult | null>
}

function defaultWatchRecursive(root: string, onRaw: (type: RawEventType, rel: string | null) => void, onError: (error: unknown) => void): WatchHandle {
  const watcher = fs.watch(root, { recursive: true, persistent: true, encoding: 'utf8' }, (eventType, filename) => {
    onRaw(eventType === 'change' ? 'change' : 'rename', filename ?? null)
  })
  watcher.on('error', onError)
  return watcher
}

async function defaultLstat(absPath: string): Promise<StatResult | null> {
  try {
    const st = await fs.promises.lstat(absPath)
    return { isDirectory: st.isDirectory() }
  } catch {
    return null
  }
}

export function isRecursiveUnsupported(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: string }).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
}

export class CompanyWatcher {
  readonly root: string
  private readonly opts: CompanyWatcherOptions
  private handle: WatchHandle | null = null
  private pending = new Map<string, RawFlags>()
  private knownDirs = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 1000
  /** 'recursive' | 'fallback' once started; for logs and tests. */
  mode: 'recursive' | 'fallback' | null = null

  constructor(opts: CompanyWatcherOptions) {
    this.root = path.resolve(opts.root)
    this.opts = opts
  }

  private get log() { return this.opts.logger ?? console }

  start(): void {
    if (this.closed || this.handle) return
    const onError = (error: unknown) => this.handleError(error)
    const watchRecursive = this.opts.watchRecursive ?? defaultWatchRecursive
    try {
      this.handle = watchRecursive(this.root, (type, rel) => this.raw(type, rel), onError)
      this.mode = 'recursive'
    } catch (error) {
      if (isRecursiveUnsupported(error) && this.opts.fallback) {
        this.log.warn('[fs-watch] recursive fs.watch unavailable here; using the fallback watcher')
        this.handle = this.opts.fallback(this.root, (type, rel) => this.raw(type, rel), onError)
        this.mode = 'fallback'
      } else {
        this.handleError(error)
        return
      }
    }
    this.retryDelay = 1000
  }

  /** One raw event from the platform watcher. Public for tests. */
  raw(type: RawEventType, rel: string | null): void {
    if (this.closed) return
    // Some platforms omit the name when the event queue overflowed: refresh
    // the root's listing then (an 'add' of the root re-reads it).
    const relative = rel ?? ''
    if (relative && isIgnoredRelative(relative)) return
    const flags = this.pending.get(relative) ?? { rename: false, change: false }
    if (type === 'rename') flags.rename = true
    else flags.change = true
    this.pending.set(relative, flags)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.flushing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.opts.windowMs ?? DEFAULT_WINDOW_MS)
  }

  /** Classify and send what has been collected. Public for tests. */
  async flush(): Promise<void> {
    if (this.flushing || this.closed) return
    this.flushing = true
    try {
      const max = this.opts.maxBatch ?? DEFAULT_MAX_BATCH
      const batch: Array<[string, RawFlags]> = []
      for (const entry of this.pending) {
        batch.push(entry)
        if (batch.length >= max) break
      }
      for (const [rel] of batch) this.pending.delete(rel)
      if (batch.length === 0) return
      const lstat = this.opts.lstat ?? defaultLstat
      const changes: FileChange[] = []
      for (let i = 0; i < batch.length; i += STAT_CONCURRENCY) {
        const slice = batch.slice(i, i + STAT_CONCURRENCY)
        const stats = await Promise.all(slice.map(([rel]) => lstat(path.join(this.root, rel))))
        if (this.closed) return
        slice.forEach(([rel, flags], j) => {
          const st = stats[j]
          const abs = rel ? path.join(this.root, rel) : this.root
          // An event without a name: report the root as added so its listing is re-read.
          const type = rel ? classifyChange(flags, st, this.knownDirs.has(rel)) : (st ? 'addDir' : 'unlinkDir')
          if (st?.isDirectory) {
            if (this.knownDirs.size < MAX_KNOWN_DIRS) this.knownDirs.add(rel)
          } else if (!st) {
            this.knownDirs.delete(rel)
          }
          if (type) changes.push({ type, path: abs })
        })
      }
      if (changes.length > 0) {
        try {
          this.opts.onChanges(changes)
        } catch (error) {
          this.log.warn('[fs-watch] change handler failed:', error instanceof Error ? error.message : error)
        }
      }
    } finally {
      this.flushing = false
      if (this.pending.size > 0 && !this.closed) this.schedule()
    }
  }

  private handleError(error: unknown): void {
    this.log.warn('[fs-watch] watcher error:', error instanceof Error ? error.message : error)
    if (this.closed) return
    try { this.handle?.close() } catch { /* already closed */ }
    this.handle = null
    // Reopen after a pause (the root may be back, e.g. after a move) — and
    // re-read the root once it is, so nothing that changed meanwhile is missed.
    if (this.retryTimer) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 30000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.closed) return
      this.start()
      if (this.handle) this.raw('rename', null)
    }, delay)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = null
    this.retryTimer = null
    this.pending.clear()
    try { this.handle?.close() } catch { /* already closed */ }
    this.handle = null
  }
}

/** The watched roots that cover `target` (the root itself or an ancestor). */
export function coveringRoot(roots: Iterable<string>, target: string): string | null {
  const resolved = path.resolve(target)
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return root
  }
  return null
}
