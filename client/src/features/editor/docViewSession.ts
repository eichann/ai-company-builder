/**
 * One HTML document shown in the middle panel (doc-frame.md "The viewer (A2)"):
 * the one owner of its native view — opened when the tab's area appears,
 * closed when it goes (another tab, 中身, the tab closed: hidden tabs never
 * keep a document running), placed over the area while nothing of the app
 * covers it, reloaded when its files change, zoomed, stopped, full screen.
 * React reads it through `subscribe` / `getSnapshot` (useSyncExternalStore)
 * and attaches the area with a callback ref, so no effect is needed.
 */
import { DOC_ZOOM_STEPS, type DocBlockedParts, type DocViewBounds, type DocViewEvent } from '../../../shared/doc-frame'
import type { DocQuoteFound, DocReviewSelection, DocViewReview } from '../../../shared/doc-review-frame'
import { handleKeyAt } from '../../shared/commands/commands'
import { subscribeFileChanges } from '../../shared/lib/fileEvents'
import type { DocLinkOutbound, DocViewControls } from './api'
import { blockedBandShown, changeShowsIn, nextZoom, placementOf, sameBounds, type DismissedParts } from './htmlViewer'

/**
 * What the session shows: an `.html` file of the company folder (`fileDocument`), or the user
 * manual's page (`ManualPane`). Main makes the view either way; only its id comes back.
 */
export interface DocViewSource {
  open(): Promise<{ ok: true; viewId: number } | { ok: false; message: string }>
  /**
   * Asked as the area goes: the member is leaving the document for its 中身, so main keeps where it
   * was scrolled and opens it there next time (main's own: the position never reaches this page).
   */
  keepsPlace?(): boolean
  /** Whether a file change shows in the document (reload it); absent: nothing on disk the member edits. */
  showsChange?(path: string): boolean
}

/** A document of the company folder: opened by its path; its own folder's changes reload it. */
export function fileDocument(filePath: string, views: Pick<DocViewControls, 'openDocView'>, keepsPlace?: () => boolean): DocViewSource {
  return { open: () => views.openDocView(filePath), showsChange: path => changeShowsIn(filePath, path), keepsPlace }
}

export type DocViewStatus =
  | { kind: 'opening' }
  /** `covered`: shown, but hidden while something of the app is over it (a menu, a dialog). */
  | { kind: 'shown'; covered: boolean }
  | { kind: 'refused'; message: string }
  /** The member pressed ［止める］. */
  | { kind: 'stopped' }
  /** The view went by itself (its page crashed). */
  | { kind: 'gone' }

export interface DocViewSnapshot {
  status: DocViewStatus
  zoom: number
  fullScreen: boolean
  /** The document was loaded again after its files changed (shown for a moment). */
  refreshed: boolean
  /** A web link the member pressed inside it, waiting for 「ブラウザで開く」 / 「やめる」. */
  link: string | null
  /** What the shown page wanted from the internet and did not get (hosts and a count), for the band. */
  blocked: DocBlockedParts | null
  /** The band shows: something was blocked and not all of it dismissed (`blockedBandShown`). */
  bandShown: boolean
  /** The text the member selected in it while reviewing (`seq` tells one selection from the next), until used or dropped. */
  selection: (DocReviewSelection & { seq: number }) | null
  /** The view shows another page than its document (a link, the page's script): the review pauses meanwhile. */
  elsewhere: boolean
}

/** Several file events of one write (temp file, rename, its styles) reload once. */
const RELOAD_DELAY_MS = 250
const REFRESHED_SHOWN_MS = 2500
/** DOM changes (a chat answer streaming) trigger a check at once, then at most this often. */
const MUTATION_CHECK_MS = 100
const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'aria-hidden', 'data-state']

export class DocViewSession {
  private snapshot: DocViewSnapshot = { status: { kind: 'opening' }, zoom: 1, fullScreen: false, refreshed: false, link: null, blocked: null, bandShown: false, selection: null, elsewhere: false }
  /** What the view does for the review (reports selections, draws marks): sent again to every new view. */
  private review: DocViewReview | null = null
  private selectionSeq = 0
  /** Hosts the member dismissed the band for (［×］), while this tab shows the document. */
  private dismissed: DismissedParts | null = null
  private listeners = new Set<() => void>()
  private area: HTMLElement | null = null
  private viewId: number | null = null
  /** Bumped on every open and detach: an answer for an earlier one closes its view. */
  private generation = 0
  private placed: DocViewBounds | null = null
  private frame: number | null = null
  private stops: Array<() => void> = []
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private refreshedTimer: ReturnType<typeof setTimeout> | null = null
  private mutationTimer: ReturnType<typeof setTimeout> | null = null
  private mutationPending = false

  /** `zoom` and `onZoom`: the tab's zoom outlives this session (another tab, 中身, and back). */
  constructor(
    private readonly source: DocViewSource,
    private readonly views: DocViewControls,
    private readonly links: DocLinkOutbound,
    zoom = 1,
    private readonly onZoom: (zoom: number) => void = () => {},
  ) {
    this.snapshot = { ...this.snapshot, zoom }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = () => this.snapshot

  private set(patch: Partial<DocViewSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** The callback ref of the area the document covers: open on mount, close on unmount. */
  attachArea = (element: HTMLElement | null) => {
    if (element === this.area) return
    this.detach()
    if (!element) return
    this.area = element
    const schedule = () => this.schedule()
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    // Anything the app draws (a menu, a dialog, ⌘K, a toast) or moves changes the DOM first.
    const mutations = new MutationObserver(() => this.scheduleAfterMutation())
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    document.addEventListener('visibilitychange', schedule)
    const onFullScreen = () => {
      if (!document.fullscreenElement && this.snapshot.fullScreen) this.set({ fullScreen: false })
      schedule()
    }
    document.addEventListener('fullscreenchange', onFullScreen)
    const offEvents = this.views.onDocViewEvent(event => this.onEvent(event))
    const showsChange = this.source.showsChange
    const offFiles = showsChange ? subscribeFileChanges(changes => {
      if (changes.some(change => showsChange(change.path))) this.reloadSoon()
    }) : () => {}
    this.stops = [
      () => resize.disconnect(),
      () => mutations.disconnect(),
      () => window.removeEventListener('resize', schedule),
      () => document.removeEventListener('scroll', schedule, true),
      () => document.removeEventListener('visibilitychange', schedule),
      () => document.removeEventListener('fullscreenchange', onFullScreen),
      offEvents,
      offFiles,
    ]
    if (this.snapshot.status.kind !== 'stopped') void this.open()
  }

  private detach() {
    this.generation++
    for (const stop of this.stops.splice(0)) stop()
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
    if (this.mutationTimer) clearTimeout(this.mutationTimer)
    this.mutationTimer = null
    this.mutationPending = false
    this.closeView(this.source.keepsPlace?.() === true)
    if (this.snapshot.fullScreen) this.setFullScreen(false)
    this.area = null
  }

  /** `keepPlace`: left for 中身, main keeps where the document was scrolled for its next open. */
  private closeView(keepPlace = false) {
    if (this.viewId !== null) void (keepPlace ? this.views.closeDocView(this.viewId, true) : this.views.closeDocView(this.viewId)).catch(() => {})
    this.viewId = null
    this.placed = null
  }

  private async open() {
    const generation = ++this.generation
    // A new view (also ［もう一度表示する］ after ［止める］ or a crash): a new band; ［×］ holds for its reloads only.
    this.dismissed = null
    this.set({ status: { kind: 'opening' }, link: null, blocked: null, bandShown: false, selection: null, elsewhere: false })
    const result = await this.source.open().catch(() => null)
    if (generation !== this.generation) {
      // Another tab, 中身 or ［止める］ came first: this view is nobody's.
      if (result?.ok) void this.views.closeDocView(result.viewId).catch(() => {})
      return
    }
    if (!result) {
      this.set({ status: { kind: 'refused', message: 'いまは表示できません。もう一度お試しください。' } })
      return
    }
    if (!result.ok) {
      this.set({ status: { kind: 'refused', message: result.message } })
      return
    }
    this.viewId = result.viewId
    this.placed = null
    if (this.snapshot.zoom !== 1) void this.views.setDocViewZoom(result.viewId, this.snapshot.zoom).catch(() => {})
    if (this.review) void this.views.setDocViewReview(result.viewId, this.review).catch(() => {})
    this.set({ status: { kind: 'shown', covered: false } })
    this.schedule()
  }

  /** At most one placement check per frame, however many things changed. */
  private schedule() {
    if (this.frame !== null || this.viewId === null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.place()
    })
  }

  /** At once for the first DOM change (a menu, a dialog), then once per `MUTATION_CHECK_MS`. */
  private scheduleAfterMutation() {
    if (this.mutationTimer) {
      this.mutationPending = true
      return
    }
    this.schedule()
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = null
      if (this.mutationPending) {
        this.mutationPending = false
        this.scheduleAfterMutation()
      }
    }, MUTATION_CHECK_MS)
  }

  private place() {
    if (this.viewId === null) return
    const placement = placementOf(this.area, document)
    if (!sameBounds(placement, this.placed)) {
      this.placed = placement
      void this.views.setDocViewBounds(this.viewId, placement).catch(() => {})
    }
    // "Covered" only while the area itself is on screen (another tab hides it without a word).
    const box = this.area?.getBoundingClientRect()
    const covered = placement === null && !!box && box.width >= 1 && box.height >= 1
    const status = this.snapshot.status
    if (status.kind === 'shown' && status.covered !== covered) this.set({ status: { kind: 'shown', covered } })
  }

  private onEvent(event: DocViewEvent) {
    if (event.viewId !== this.viewId) return
    if (event.kind === 'shortcut') {
      // One of the app's shortcuts pressed while the document had the keyboard (main took it from
      // the document): run as if pressed in this tab. An overlay it opens (⌘K) hides the view, and
      // hiding gives the keyboard back to the app.
      handleKeyAt(this.area, event.key)
      return
    }
    if (event.kind === 'blocked') {
      // Hosts and a count only (main keeps the addresses); `count: 0` = the page loaded again.
      const blocked = { count: event.count, hosts: event.hosts, hostCount: event.hostCount }
      this.set({ blocked, bandShown: blockedBandShown(blocked, this.dismissed) })
      return
    }
    if (event.kind === 'selection') {
      if (this.review?.selecting && !this.snapshot.elsewhere) this.set({ selection: { ...event.quote, seq: ++this.selectionSeq } })
      return
    }
    if (event.kind === 'page') {
      // Another page of the folder: a selection made for the reviewed document no longer stands.
      this.set(event.own ? { elsewhere: false } : { elsewhere: true, selection: null })
      return
    }
    if (event.kind === 'gone') {
      this.viewId = null
      this.placed = null
      this.set({ status: { kind: 'gone' }, link: null, blocked: null, bandShown: false, selection: null })
    } else if (this.snapshot.link === null) {
      this.set({ link: event.url })
    }
  }

  private reloadSoon() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      if (this.viewId === null) return
      void this.views.reloadDocView(this.viewId).catch(() => {})
      if (this.refreshedTimer) clearTimeout(this.refreshedTimer)
      this.refreshedTimer = setTimeout(() => this.set({ refreshed: false }), REFRESHED_SHOWN_MS)
      this.set({ refreshed: true })
    }, RELOAD_DELAY_MS)
  }

  /**
   * What the view does for the review: report the member's selections (only while reviewing) and draw
   * these marks. Sent when it changed, and again to each new view (another tab and back, a restart).
   */
  setReview(review: DocViewReview | null) {
    if (JSON.stringify(review) === JSON.stringify(this.review)) return
    this.review = review
    if (!review?.selecting && this.snapshot.selection) this.set({ selection: null })
    if (this.viewId !== null) void this.views.setDocViewReview(this.viewId, review).catch(() => {})
  }

  /** Scroll the document to the review's `index`-th mark: whether it is there now (`missing` with no view). */
  findQuote(index: number): Promise<DocQuoteFound> {
    if (this.viewId === null) return Promise.resolve('missing')
    return this.views.findDocViewQuote(this.viewId, index).catch(() => 'missing' as const)
  }

  /** The selection was used (a comment) or dropped (the box closed). */
  clearSelection() {
    if (this.snapshot.selection) this.set({ selection: null })
  }

  /** ［×］ on the band: hidden until the page wants a host not dismissed yet. */
  dismissBand() {
    const shown = this.snapshot.blocked
    if (shown) this.dismissed = { hosts: new Set([...(this.dismissed?.hosts ?? []), ...shown.hosts]), hostCount: Math.max(this.dismissed?.hostCount ?? 0, shown.hostCount) }
    this.set({ bandShown: false })
  }

  /** ［止める］: the document's view closes (its scripts stop); ［もう一度表示する］ opens it again. */
  stop() {
    this.generation++
    this.closeView()
    if (this.snapshot.fullScreen) this.setFullScreen(false)
    this.set({ status: { kind: 'stopped' }, link: null, blocked: null, bandShown: false, selection: null })
  }

  restart() {
    if (this.area) void this.open()
  }

  zoomBy(direction: 1 | -1) {
    this.setZoom(nextZoom(DOC_ZOOM_STEPS, this.snapshot.zoom, direction))
  }

  setZoom(zoom: number) {
    this.set({ zoom })
    this.onZoom(zoom)
    if (this.viewId !== null) void this.views.setDocViewZoom(this.viewId, zoom).catch(() => {})
  }

  /** 「全画面」: the app's page goes full screen and the viewer covers it (Esc leaves). */
  setFullScreen(on: boolean) {
    this.set({ fullScreen: on })
    if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {})
    if (!on && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {})
    this.schedule()
  }

  /** The member's answer about the link: only 「ブラウザで開く」 hands it to the browser. */
  answerLink(open: boolean) {
    const url = this.snapshot.link
    this.set({ link: null })
    if (open && url) void this.links.openExternal(url).catch(() => {})
  }
}
