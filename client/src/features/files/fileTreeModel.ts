// Over 300 lines on purpose: one model class and its registry share the cache and refresh rules.
/**
 * The file tree's data, outside React: one model per folder the tree shows
 * (a department, or the whole company), kept in a module-level registry so
 * switching departments and back is instant, and fed by the company's file
 * watcher so a model that is not on screen still learns which folders
 * changed (they are re-read when it is shown again).
 *
 * Loading is lazy: the first view reads the folder and its first-level
 * sub-folders (one IPC call); deeper folders are read when expanded. A
 * watcher event re-reads only the parent folder of the changed path, and
 * only when that folder is on screen (the root or expanded); otherwise the
 * cached listing is marked stale and re-read when it is expanded. Content
 * changes ('change') never re-read anything: a listing shows names only.
 */
import { normalizePathSeparators } from '../../utils/path'

export interface RawDirEntry {
  name: string
  isDirectory: boolean
  path: string
  children?: RawDirEntry[]
}

/** What a tree row shows. */
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  /** A folder this computer does not download (sparse exclusion): shown as a placeholder. */
  notDownloaded?: boolean
}

export interface FileTreeIO {
  readDirectory(dir: string): Promise<RawDirEntry[]>
  readDirectoryTree(dir: string, maxDepth: number): Promise<RawDirEntry[]>
}

export interface ChangeEvent { type: string; path: string }

export type ReviewStatus = Map<string, { hasReview: boolean; hasRequest: boolean; reviewFileNames: string[] }>

/** Comparable form of a path: forward slashes, no trailing slash. */
export function treeKey(p: string): string {
  const k = normalizePathSeparators(p)
  return k.length > 1 ? k.replace(/\/+$/, '') : k
}

function parentOf(key: string): string | null {
  const i = key.lastIndexOf('/')
  return i > 0 ? key.slice(0, i) : null
}

function isWithin(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`)
}

export interface RefreshPlan {
  /** Folders to read again now (on screen). */
  reread: string[]
  /** Folders whose cached listing is out of date (read again when shown). */
  stale: string[]
  /** Paths that were removed: forget their listings and everything below. */
  drop: string[]
}

/**
 * Which folders a batch of watcher events affects. Pure (keys only), so the
 * rules are unit-tested: a path's parent is re-read when it is loaded and on
 * screen (the root, or expanded, in an active tree), marked stale when it is
 * loaded but not on screen, and ignored when it was never read.
 */
export interface KeySet { has(key: string): boolean }

export function planTreeRefresh(
  events: ReadonlyArray<ChangeEvent>,
  state: { root: string; loaded: KeySet; expanded: KeySet; active: boolean },
): RefreshPlan {
  const root = treeKey(state.root)
  const reread = new Set<string>()
  const stale = new Set<string>()
  const drop = new Set<string>()
  const touch = (dir: string) => {
    if (!state.loaded.has(dir)) return
    if (state.active && (dir === root || state.expanded.has(dir))) reread.add(dir)
    else stale.add(dir)
  }
  for (const event of events) {
    // A content change does not change any listing.
    if (event.type === 'change') continue
    const key = treeKey(event.path)
    if (!isWithin(key, root)) continue
    if (event.type === 'unlink' || event.type === 'unlinkDir') {
      if (key !== root) drop.add(key)
    }
    if (key === root) {
      touch(root)
      continue
    }
    const parent = parentOf(key)
    if (parent !== null) touch(parent)
  }
  for (const d of drop) {
    reread.delete(d)
    stale.delete(d)
    for (const r of [...reread]) if (r.startsWith(`${d}/`)) reread.delete(r)
    for (const s of [...stale]) if (s.startsWith(`${d}/`)) stale.delete(s)
  }
  for (const r of reread) stale.delete(r)
  return { reread: [...reread], stale: [...stale], drop: [...drop] }
}

// Sort: folders first, then by name.
function sortEntries<T extends { isDirectory: boolean; name: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })
}

interface ListingView {
  withDots?: FileEntry[]
  withoutDots?: FileEntry[]
  review?: ReviewStatus
}
const listingViews = new WeakMap<RawDirEntry[], ListingView>()

function viewCache(raw: RawDirEntry[]): ListingView {
  let v = listingViews.get(raw)
  if (!v) { v = {}; listingViews.set(raw, v) }
  return v
}

/**
 * The rows of one listing: sorted, without node_modules / .DS_Store / review
 * sidecars, dot-files only when shown. Memoised per listing, so an unchanged
 * folder keeps the same entry objects (rows can skip re-rendering).
 */
export function viewOfListing(raw: RawDirEntry[], includeDotFiles: boolean, isSidecar: (name: string) => boolean = () => false): FileEntry[] {
  const cache = viewCache(raw)
  const hit = includeDotFiles ? cache.withDots : cache.withoutDots
  if (hit) return hit
  const out: FileEntry[] = []
  for (const entry of raw) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue
    if (entry.name.startsWith('.') && !includeDotFiles) continue
    if (!entry.isDirectory && isSidecar(entry.name)) continue
    out.push({ name: entry.name, path: entry.path, isDirectory: entry.isDirectory })
  }
  sortEntries(out)
  if (includeDotFiles) cache.withDots = out
  else cache.withoutDots = out
  return out
}

/** Review badges of the files in one listing (from every name, sidecars included). */
export function reviewStatusOfListing(raw: RawDirEntry[], detect: (names: string[]) => ReviewStatus): ReviewStatus {
  const cache = viewCache(raw)
  if (!cache.review) cache.review = detect(raw.map(e => e.name))
  return cache.review
}

export class FileTreeModel {
  readonly rootPath: string
  readonly root: string
  private readonly io: FileTreeIO
  private listings = new Map<string, RawDirEntry[]>()
  /** Keys of every directory seen in a listing: O(1) "is this a folder?". */
  private dirKeys = new Set<string>()
  private expandedKeys = new Set<string>()
  private staleKeys = new Set<string>()
  private loadingKeys = new Set<string>()
  private generation = new Map<string, number>()
  private inflight = new Map<string, Promise<void>>()
  private rerun = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0
  private active = false
  private initPromise: Promise<void> | null = null
  private eventsDuringInit = false
  /** True until the first listing of the root has arrived. */
  initialLoading = false
  /** Number of directory reads issued (for tests and diagnostics). */
  reads = 0

  constructor(rootPath: string, io: FileTreeIO) {
    this.rootPath = rootPath
    this.root = treeKey(rootPath)
    this.io = io
  }

  // ── reading state ──────────────────────────────────────────────────────
  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  listing(dir: string): RawDirEntry[] | undefined { return this.listings.get(treeKey(dir)) }
  isLoaded(dir: string): boolean { return this.listings.has(treeKey(dir)) }
  isLoading(dir: string): boolean { return this.loadingKeys.has(treeKey(dir)) }
  isExpanded(dir: string): boolean { return this.expandedKeys.has(treeKey(dir)) }
  isStale(dir: string): boolean { return this.staleKeys.has(treeKey(dir)) }
  isDirectory(p: string): boolean {
    const k = treeKey(p)
    return k === this.root || this.dirKeys.has(k) || this.expandedKeys.has(k)
  }
  get expanded(): ReadonlySet<string> { return this.expandedKeys }
  get loaded(): ReadonlySet<string> { return new Set(this.listings.keys()) }

  private emit(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  private bumpGeneration(key: string): void {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1)
  }

  private onScreen(key: string): boolean {
    return key === this.root || this.expandedKeys.has(key)
  }

  // ── listings ───────────────────────────────────────────────────────────
  private setListing(key: string, entries: RawDirEntry[]): void {
    const shallow = entries.map(e => (e.children ? { name: e.name, isDirectory: e.isDirectory, path: e.path } : e))
    const old = this.listings.get(key)
    const newDirs = new Set<string>()
    for (const e of shallow) if (e.isDirectory) newDirs.add(treeKey(e.path))
    if (old) {
      for (const e of old) {
        if (!e.isDirectory) continue
        const k = treeKey(e.path)
        if (!newDirs.has(k)) {
          this.dirKeys.delete(k)
          this.dropSubtree(k)
        }
      }
    }
    for (const k of newDirs) this.dirKeys.add(k)
    this.listings.set(key, shallow)
  }

  private dropSubtree(key: string): void {
    const prefix = `${key}/`
    for (const k of [...this.listings.keys()]) {
      if (k === key || k.startsWith(prefix)) {
        this.listings.delete(k)
        this.bumpGeneration(k)
      }
    }
    for (const set of [this.expandedKeys, this.staleKeys, this.dirKeys]) {
      for (const k of [...set]) if (k.startsWith(prefix) || (set !== this.dirKeys && k === key)) set.delete(k)
    }
  }

  /** Read one folder (coalesced: a read requested while one runs runs again after it). */
  private readDir(key: string): Promise<void> {
    const running = this.inflight.get(key)
    if (running) {
      this.rerun.add(key)
      return running
    }
    const gen = this.generation.get(key) ?? 0
    if (!this.listings.has(key)) {
      this.loadingKeys.add(key)
      this.emit()
    }
    this.reads++
    const ioPath = key === this.root ? this.rootPath : key
    const run = (async () => {
      try {
        const entries = await this.io.readDirectory(ioPath)
        this.setListing(key, Array.isArray(entries) ? entries : [])
        if ((this.generation.get(key) ?? 0) === gen) this.staleKeys.delete(key)
        else this.staleKeys.add(key)
      } catch {
        this.staleKeys.add(key)
      } finally {
        this.loadingKeys.delete(key)
        this.inflight.delete(key)
        this.emit()
        const again = this.rerun.delete(key)
        if (again || (this.staleKeys.has(key) && this.active && this.onScreen(key) && (this.generation.get(key) ?? 0) !== gen)) {
          void this.readDir(key)
        }
      }
    })()
    this.inflight.set(key, run)
    return run
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  /**
   * Show this tree. The first time, read the folder and its first-level
   * sub-folders (expanded, as before); later, show the cached tree at once
   * and re-read only what changed meanwhile (plus the root: one cheap read,
   * in case an event was missed).
   */
  activate(): Promise<void> {
    this.active = true
    if (this.listings.has(this.root) && !this.initPromise) {
      const reads: Promise<void>[] = [this.readDir(this.root)]
      for (const k of this.staleKeys) if (k !== this.root && this.onScreen(k)) reads.push(this.readDir(k))
      return Promise.all(reads).then(() => undefined)
    }
    if (this.initPromise) return this.initPromise
    this.initialLoading = true
    this.eventsDuringInit = false
    this.emit()
    this.reads++
    this.initPromise = (async () => {
      try {
        const raw = await this.io.readDirectoryTree(this.rootPath, 1)
        const entries = Array.isArray(raw) ? raw : []
        this.setListing(this.root, entries)
        const firstLevel: string[] = []
        for (const e of entries) {
          if (e.isDirectory && e.children) {
            const k = treeKey(e.path)
            this.setListing(k, e.children)
            firstLevel.push(k)
          }
        }
        // Like before: the first view opens every first-level folder.
        if (this.expandedKeys.size === 0) for (const k of firstLevel) this.expandedKeys.add(k)
      } catch {
        this.setListing(this.root, [])
      } finally {
        this.initialLoading = false
        this.initPromise = null
        this.emit()
      }
      if (this.eventsDuringInit) {
        this.eventsDuringInit = false
        await this.revalidateVisible()
      }
    })()
    return this.initPromise
  }

  deactivate(): void {
    this.active = false
  }

  /** Re-read the root and every expanded folder; everything else is read again when expanded. */
  revalidateVisible(): Promise<void> {
    const reads: Promise<void>[] = []
    for (const k of this.listings.keys()) {
      if (this.onScreen(k)) {
        this.bumpGeneration(k)
        reads.push(this.readDir(k))
      } else {
        this.staleKeys.add(k)
      }
    }
    if (!this.listings.has(this.root)) reads.push(this.readDir(this.root))
    return Promise.all(reads).then(() => undefined)
  }

  /** A folder's listing changed because of something this app did (new file, rename…). */
  invalidate(dir: string): Promise<void> {
    const key = treeKey(dir)
    if (!isWithin(key, this.root)) return Promise.resolve()
    this.bumpGeneration(key)
    if (!this.listings.has(key) && key !== this.root) return Promise.resolve()
    if (this.active && this.onScreen(key)) return this.readDir(key)
    this.staleKeys.add(key)
    return Promise.resolve()
  }

  /** Open or close a folder; opening reads it when it was never read or is stale. */
  toggle(dir: string): Promise<void> {
    const key = treeKey(dir)
    if (this.expandedKeys.has(key)) {
      this.expandedKeys.delete(key)
      this.emit()
      return Promise.resolve()
    }
    return this.expand(dir)
  }

  expand(dir: string): Promise<void> {
    const key = treeKey(dir)
    const wasExpanded = this.expandedKeys.has(key)
    if (!wasExpanded && key !== this.root) {
      this.expandedKeys.add(key)
      this.emit()
    }
    if (!this.listings.has(key) || this.staleKeys.has(key)) return this.readDir(key)
    return Promise.resolve()
  }

  /** Apply a batch of watcher events. */
  applyEvents(events: ReadonlyArray<ChangeEvent>): RefreshPlan | null {
    if (this.initPromise) {
      if (events.some(e => e.type !== 'change' && isWithin(treeKey(e.path), this.root))) this.eventsDuringInit = true
      return null
    }
    const plan = planTreeRefresh(events, {
      root: this.root,
      loaded: this.listings,
      expanded: this.expandedKeys,
      active: this.active,
    })
    if (plan.reread.length === 0 && plan.stale.length === 0 && plan.drop.length === 0) return plan
    for (const d of plan.drop) this.dropSubtree(d)
    for (const s of plan.stale) {
      this.bumpGeneration(s)
      this.staleKeys.add(s)
    }
    for (const r of plan.reread) {
      this.bumpGeneration(r)
      void this.readDir(r)
    }
    this.emit()
    return plan
  }
}

// ── registry ───────────────────────────────────────────────────────────────
const models = new Map<string, FileTreeModel>()

/** The model for a folder (created on first use, kept for instant switches). */
export function getFileTreeModel(rootPath: string, io: FileTreeIO): FileTreeModel {
  const key = treeKey(rootPath)
  let model = models.get(key)
  if (!model) {
    model = new FileTreeModel(rootPath, io)
    models.set(key, model)
  }
  return model
}

/** Forget the models outside a company folder (another company was opened). */
export function retainFileTreeModels(companyRoot: string): void {
  const root = treeKey(companyRoot)
  for (const key of [...models.keys()]) if (!isWithin(key, root)) models.delete(key)
}

/** Deliver watcher events to every model (on screen or not). */
export function applyEventsToFileTreeModels(events: ReadonlyArray<ChangeEvent>): void {
  for (const model of models.values()) model.applyEvents(events)
}

/** For tests. */
export function clearFileTreeModels(): void {
  models.clear()
}
