/**
 * One HTML document shown in the middle panel (doc-frame.md "The viewer (A2)"):
 * the one owner of its native view — opened when the tab's area appears,
 * closed when it goes (another tab, 中身, the tab closed: hidden tabs never
 * keep a document running), placed over the area while nothing of the app
 * covers it, reloaded when its files change, zoomed, stopped, full screen.
 * React reads it through `subscribe` / `getSnapshot` (useSyncExternalStore)
 * and attaches the area with a callback ref, so no effect is needed.
 */
import { DOC_ZOOM_STEPS, type DocViewBounds, type DocViewEvent } from '../../../shared/doc-frame'
import { subscribeFileChanges } from '../../shared/lib/fileEvents'
import type { DocLinkOutbound, DocViewControls } from './api'
import { changeShowsIn, nextZoom, placementOf, sameBounds } from './htmlViewer'

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
}

/** Several file events of one write (temp file, rename, its styles) reload once. */
const RELOAD_DELAY_MS = 250
const REFRESHED_SHOWN_MS = 2500
/** DOM changes (a chat answer streaming) trigger a check at once, then at most this often. */
const MUTATION_CHECK_MS = 100
const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'aria-hidden', 'data-state']

export class DocViewSession {
  private snapshot: DocViewSnapshot = { status: { kind: 'opening' }, zoom: 1, fullScreen: false, refreshed: false, link: null }
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
    private readonly filePath: string,
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
    const offFiles = subscribeFileChanges(changes => {
      if (changes.some(change => changeShowsIn(this.filePath, change.path))) this.reloadSoon()
    })
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
    this.closeView()
    if (this.snapshot.fullScreen) this.setFullScreen(false)
    this.area = null
  }

  private closeView() {
    if (this.viewId !== null) void this.views.closeDocView(this.viewId).catch(() => {})
    this.viewId = null
    this.placed = null
  }

  private async open() {
    const generation = ++this.generation
    this.set({ status: { kind: 'opening' }, link: null })
    const result = await this.views.openDocView(this.filePath).catch(() => null)
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
    if (event.kind === 'gone') {
      this.viewId = null
      this.placed = null
      this.set({ status: { kind: 'gone' }, link: null })
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

  /** ［止める］: the document's view closes (its scripts stop); ［もう一度表示する］ opens it again. */
  stop() {
    this.generation++
    this.closeView()
    if (this.snapshot.fullScreen) this.setFullScreen(false)
    this.set({ status: { kind: 'stopped' }, link: null })
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
