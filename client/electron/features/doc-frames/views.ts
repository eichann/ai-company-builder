/**
 * The HTML viewer's document views (`.claude/rules/doc-frame.md`): which views
 * are open, in which window, and their grants. A view is the only holder of
 * its grant: the grant is made for the view and revoked when the view goes —
 * closed by its window, destroyed, its page crashed, or its window reloaded,
 * crashed or closed (the shell's `onWindowReset`). No Electron here: the
 * shell (`electron/doc-view.ts`) makes the views on the document session.
 *
 * Opening takes time (the file check, making the view), so it is two steps:
 * `begin` notes the window's page as it is when the member asked (its reset
 * count, and the shell starts watching it then), and `open` registers a view
 * only if that page is still the same one when the view is ready — a view
 * finished for a page that reloaded or crashed meanwhile is destroyed, with no
 * grant. The cap is applied when a view is registered, so opens running at
 * the same time cannot pass it.
 */
import { createHash } from 'node:crypto'
import { docQuoteFoundOf, docReviewSelectionOf, docViewReviewOf, type CheckedReview, type DocQuoteFound } from '../../../shared/doc-review-frame'
import { drawQuotesCode, findQuoteCode, READ_SELECTION_CODE } from './review-world'
import { blockedWebHost, docViewBounds, parseDocFrameUrl, docZoomFactor, DOC_BLOCKED_HOSTS_MAX, DOC_BLOCKED_PARTS_MAX, type DocViewBounds, type DocViewEvent } from '../../../shared/doc-frame'
import { driveVideoIdsOf, driveVideoViewUrl } from '../../../shared/doc-drive-videos'
import { webLinkForBrowser } from '../../external-url'
import type { KeyInput } from '../../../shared/commands/define'
import type { DocFrames, OpenableDocument } from './protocol'

export interface DocViewHandle {
  /** The view's own id (its page's webContents id): the grant's owner. */
  readonly id: number
  /**
   * Load the document's address (main keeps it; the renderer never sees it), scrolled to `at` once
   * loaded when given (where the member was reading when they left for 中身).
   */
  show(url: string, at?: DocScroll | null): void
  /** Close the view and its page. `onGone` follows. */
  destroy(): void
  /**
   * Hide the view at once, read where its document is scrolled (a time limit: a page that does not
   * answer gives nothing), then close it as `destroy` does. Main keeps the answer; it never leaves main.
   */
  closeKeepingPlace(): Promise<DocScroll | null>
  /**
   * Place the view over the tab's content area and show it (unmuted), or
   * hide it (`null`: 0×0, hidden, muted; the keyboard goes back to the app's
   * page if the document had it).
   */
  place(bounds: DocViewBounds | null): void
  /** The document's own zoom (not the app's). */
  zoom(factor: number): void
  /** Load the document again (its file changed on disk). */
  reload(): void
  /**
   * Run one of the review piece's calls (`review-world.ts`) in the page's isolated world and answer
   * its value (untrusted: the caller checks it), or null when the page could not answer.
   */
  inReviewWorld(code: string): Promise<unknown>
  /** The keyboard back to the app's page if the document has it (the comment box wants it). */
  releaseKeyboard(): void
}

/** What the shell tells the registry about one view. */
export interface DocViewHooks {
  /** The view went, for any reason (once). */
  onGone(viewId: number): void
  /** The member pressed a link to somewhere outside the document (the shell refused the navigation). */
  onLink(viewId: number, url: string): void
  /** The member pressed one of the app's shortcuts in it (a real key press: the shell took it from the document). */
  onShortcut(viewId: number, key: KeyInput): void
  /**
   * Its page wanted something that was not loaded: refused by its CSP (as Chromium reports it) or
   * cancelled by the session's request hook. The whole address, in main only: the registry keeps
   * the host for the window and drops the rest.
   */
  onBlocked(viewId: number, url: string): void
  /** Its page (re)loaded (`url`: the address it went to): a new page, a new tally of blocked parts. */
  onPageStart(viewId: number, url: string): void
  /** Its page finished loading (the review's marks are drawn again). */
  onPageLoaded(viewId: number): void
  /**
   * The member let go of the mouse, or of a key with Shift, in the shown view: a real input (a
   * page's synthetic events never come here), so a selection may have been made.
   */
  onReviewInput(viewId: number): void
}

export interface DocViewPort {
  /** Start telling `onWindowReset` about this window's page, at once (before any view is made). */
  watch(windowId: number): void
  /**
   * A new empty view in window `windowId`, on the document session with its
   * guards; null when it cannot be made (the window is gone, the session could
   * not be prepared). `hooks.onGone` runs once when the view goes, for any reason.
   */
  create(windowId: number, hooks: DocViewHooks): Promise<DocViewHandle | null>
  /** Tell `listener` when a watched window reloads its page, its page crashes or it closes. */
  onWindowReset(listener: (windowId: number) => void): void
}

/** Where a document was scrolled (x, y): read and put back by main only. */
export type DocScroll = readonly [number, number]

/** The window's page as it was when an open began. */
export interface DocViewTicket {
  readonly windowId: number
  readonly generation: number
}

/** At most this many document views per window; one more closes the oldest. */
export const MAX_VIEWS_PER_WINDOW = 32

/** A view asks the member about a link at most once in this long (a page cannot queue confirmations). */
export const LINK_INTERVAL_MS = 1000

/** A view's blocked parts are told at most once in this long (a page asking in a loop sends no flood). */
export const BLOCKED_INTERVAL_MS = 500

export interface DocViewsDeps {
  /** `onDocumentServed`: the bytes of each view's own document as served (its Drive videos). */
  frames: Pick<DocFrames, 'grant' | 'revoke'> & Partial<Pick<DocFrames, 'onDocumentServed'>>
  /** How a document's Drive videos are read (default `driveVideoIdsOf`; a test counts the reads). */
  readDriveVideos?: (html: string) => { ids: string[]; total: number }
  shell: DocViewPort
  /** Tell the window about one of its views (`docView:event`). */
  notify?: (windowId: number, event: DocViewEvent) => void
  now?: () => number
  /** Run `fn` after `ms` (default setTimeout); returns how to cancel it. */
  later?: (fn: () => void, ms: number) => () => void
}

/** After the member's input, the selection is read this much later (the page settles it first). */
export const SELECTION_READ_DELAY_MS = 40
/** A selection read waits at most this long (a page spinning its CPU never answers; the next input reads again). */
export const SELECTION_READ_LIMIT_MS = 1000

/** Which page of a grant an address shows (its path under the grant's folder), or null. */
const pageOf = (url: string) => parseDocFrameUrl(url)?.segments.join('/') ?? null

/** What one view's page wanted from the internet so far (main only; the window gets hosts and a count). */
interface BlockedTally {
  /** Different addresses (never sent): what `count` counts, each kept as its SHA-256 (44 characters, however long the address). */
  urls: Set<string>
  /** Every different host (never more than the addresses counted); `hosts` is the first ones of it. */
  allHosts: Set<string>
  hosts: string[]
  /** Something changed since the window was last told. */
  dirty: boolean
  /** The window was told something since the page started (a new page then tells it `count: 0`). */
  told: boolean
  /** A send is waiting for `BLOCKED_INTERVAL_MS` to pass. */
  cancel: (() => void) | null
}

/** Different Drive videos remembered per view (for `seen`); past it a new one no longer brings a dismissed band back. */
export const DRIVE_VIDEOS_SEEN_MAX = 1000

/**
 * The Google Drive videos of one view's own document (main only; the window gets counts). The list read
 * is kept apart from whether it is offered: only while the view's main frame shows that document.
 */
interface DriveVideos {
  /** The ids, in the order written, at most `DOC_DRIVE_VIDEOS_MAX`: a row's index names one. */
  ids: string[]
  total: number
  /** Every different id this view has had since it opened. */
  seen: Set<string>
  /** What the window was last told. */
  told: { count: number; total: number; seen: number }
  /** The file identity (`version`) of the bytes read last, or being read: the same file is not read again. */
  version: string | null
  /** A read is under way (one at a time per view). */
  reading: boolean
  /** The newest bytes served meanwhile, read when the one under way ends (only the newest is kept). */
  next: { bytes: Uint8Array; version: string } | null
}

/** The same document for a kept place: its folder and name (main's own; never sent). */
const placeKey = (doc: OpenableDocument) => `${doc.root}\0${doc.folder}\0${doc.name}`

export function createDocViews(deps: DocViewsDeps) {
  const now = deps.now ?? Date.now
  const later = deps.later ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) })
  /** View id → when it last asked about a link. */
  const lastLink = new Map<number, number>()
  /** View id → what its page wanted from the internet. */
  const blocked = new Map<number, BlockedTally>()
  /** View id → its window and handle, in the order registered. */
  const views = new Map<number, { windowId: number; handle: DocViewHandle; place: string }>()
  /**
   * Window → the document (`placeKey`) → where it was scrolled when the member left it for 中身,
   * until it is opened again in that window (once). The newest `MAX_VIEWS_PER_WINDOW` per window;
   * gone with the window's page. Never sent anywhere: only put back into the same document.
   */
  const places = new Map<number, Map<string, Promise<DocScroll | null>>>()
  /** Window → how many times its page reset (reloaded, crashed, closed). */
  const generations = new Map<number, number>()
  const generationOf = (windowId: number) => generations.get(windowId) ?? 0
  /**
   * View id → what its window asked the view to do for the review (report selections, draw marks).
   * Kept here so a reload or the page's own next page draws the marks again.
   */
  const reviews = new Map<number, CheckedReview>()
  /**
   * View id → the page it opened (the reviewed document), whether its main frame shows that page now,
   * and how many pages it has loaded. A link or a script can take the view to another page of the same
   * folder: the review is paused there (no selection read, no marks), so nothing of that page lands in
   * this document's review.
   */
  const pages = new Map<number, { doc: string | null; own: boolean; seq: number }>()
  const onOwnPage = (viewId: number) => pages.get(viewId)?.own !== false
  /** Views whose selection is being read (one read at a time per view). */
  const reading = new Set<number>()
  /** View id → the Drive videos its own document embeds, as last served. */
  const videos = new Map<number, DriveVideos>()
  /**
   * Tell the window the view's videos when what is offered changed: the list only while its main frame
   * shows the document (`onOwnPage`), else none; a reload serving the same file says nothing.
   */
  const tellVideos = (viewId: number, list: DriveVideos) => {
    const view = views.get(viewId)
    const offered = onOwnPage(viewId)
    const counts = { count: offered ? list.ids.length : 0, total: offered ? list.total : 0, seen: list.seen.size }
    if (!view || (counts.count === list.told.count && counts.total === list.told.total && counts.seen === list.told.seen)) return
    list.told = counts
    deps.notify?.(view.windowId, { viewId, kind: 'driveVideos', ...counts })
  }
  const drawMarks = (viewId: number) => {
    const view = views.get(viewId)
    const review = reviews.get(viewId)
    if (view && review && onOwnPage(viewId)) void view.handle.inReviewWorld(drawQuotesCode(review.quotes.map(({ text, nth, resolved }) => ({ text, nth, resolved })))).catch(() => {})
  }

  const forget = (viewId: number) => {
    views.delete(viewId)
    lastLink.delete(viewId)
    reviews.delete(viewId)
    reading.delete(viewId)
    pages.delete(viewId)
    videos.delete(viewId)
    blocked.get(viewId)?.cancel?.()
    blocked.delete(viewId)
    deps.frames.revoke(viewId)
  }
  /** Tell the window the view's tally now, then at most once per `BLOCKED_INTERVAL_MS`. */
  const tellBlocked = (viewId: number) => {
    const tally = blocked.get(viewId)
    const view = views.get(viewId)
    if (!tally || !view || tally.cancel || !tally.dirty) return
    tally.dirty = false
    tally.told = tally.urls.size > 0
    deps.notify?.(view.windowId, { viewId, kind: 'blocked', count: tally.urls.size, hosts: [...tally.hosts], hostCount: tally.allHosts.size })
    tally.cancel = later(() => {
      tally.cancel = null
      tellBlocked(viewId)
    }, BLOCKED_INTERVAL_MS)
  }
  // The shell's word that a view went. Still registered = nobody here closed it (its page
  // crashed, it was destroyed): its window is told, so the tab does not show an empty area.
  const hooks: DocViewHooks = {
    onGone(viewId) {
      const view = views.get(viewId)
      forget(viewId)
      if (view) deps.notify?.(view.windowId, { viewId, kind: 'gone' })
    },
    onLink(viewId, url) {
      const view = views.get(viewId)
      // Only the web goes to the member's browser (never file:, javascript:, a custom scheme).
      const link = webLinkForBrowser(url)
      if (!view || !link) return
      const at = now()
      const last = lastLink.get(viewId)
      if (last !== undefined && at - last < LINK_INTERVAL_MS) return
      lastLink.set(viewId, at)
      deps.notify?.(view.windowId, { viewId, kind: 'link', url: link })
    },
    onShortcut(viewId, key) {
      const view = views.get(viewId)
      if (view) deps.notify?.(view.windowId, { viewId, kind: 'shortcut', key })
    },
    onBlocked(viewId, url) {
      // A full tally takes nothing more: a page refusing in a tight loop costs a lookup.
      if (!views.has(viewId) || (blocked.get(viewId)?.urls.size ?? 0) >= DOC_BLOCKED_PARTS_MAX) return
      // Only internet addresses, and only their host ever leaves main.
      const host = blockedWebHost(url)
      if (!host) return
      let tally = blocked.get(viewId)
      if (!tally) blocked.set(viewId, tally = { urls: new Set(), allHosts: new Set(), hosts: [], dirty: false, told: false, cancel: null })
      const key = createHash('sha256').update(url).digest('base64')
      if (tally.urls.has(key)) return
      tally.urls.add(key)
      tally.allHosts.add(host)
      if (!tally.hosts.includes(host) && tally.hosts.length < DOC_BLOCKED_HOSTS_MAX) tally.hosts.push(host)
      tally.dirty = true
      tellBlocked(viewId)
    },
    onPageStart(viewId, url) {
      const view = views.get(viewId)
      const page = pages.get(viewId)
      if (view && page) {
        page.seq++
        const own = pageOf(url) === page.doc
        if (own !== page.own) {
          page.own = own
          deps.notify?.(view.windowId, { viewId, kind: 'page', own })
        }
      }
      // Another page of the folder: the document's videos are not offered over it; back on the document they are.
      const list = videos.get(viewId)
      if (list) tellVideos(viewId, list)
      const tally = blocked.get(viewId)
      if (!tally || !views.has(viewId)) return
      // A new page: its own tally. The window hears `count: 0` only if it was told something before.
      tally.urls.clear()
      tally.allHosts.clear()
      tally.hosts = []
      tally.dirty = tally.told
      tellBlocked(viewId)
    },
    onPageLoaded(viewId) {
      drawMarks(viewId)
    },
    onReviewInput(viewId) {
      const view = views.get(viewId)
      const review = reviews.get(viewId)
      if (!view || !review || !onOwnPage(viewId)) return
      // A page that rewrites itself (its tabs, a chart) dropped the marks of what it replaced.
      if (review.quotes.length > 0) later(() => drawMarks(viewId), SELECTION_READ_DELAY_MS)
      if (!review.selecting || reading.has(viewId)) return
      reading.add(viewId)
      const pageSeq = pages.get(viewId)?.seq
      later(() => {
        // One read at a time, and at most SELECTION_READ_LIMIT_MS: a page that never answers does not stop the next one.
        let settled = false
        const settle = () => {
          if (settled) return false
          settled = true
          if (views.get(viewId) === view) reading.delete(viewId)
          return true
        }
        const cancel = later(() => { settle() }, SELECTION_READ_LIMIT_MS)
        void view.handle.inReviewWorld(READ_SELECTION_CODE).then(value => {
          if (!settle()) return
          cancel()
          // Still this view, still reviewing, still the same page of the reviewed document: the window gets the checked text only.
          if (views.get(viewId) !== view || !reviews.get(viewId)?.selecting || !onOwnPage(viewId) || pages.get(viewId)?.seq !== pageSeq) return
          const quote = docReviewSelectionOf(value)
          if (!quote) return
          deps.notify?.(view.windowId, { viewId, kind: 'selection', quote })
          view.handle.releaseKeyboard()
        }, () => { if (settle()) cancel() })
      }, SELECTION_READ_DELAY_MS)
    },
  }
  /** The view, when `windowId` holds it. */
  const own = (viewId: unknown, windowId: number) =>
    typeof viewId === 'number' && views.get(viewId)?.windowId === windowId ? views.get(viewId)! : null
  const close = (viewId: number) => {
    const view = views.get(viewId)
    forget(viewId)
    view?.handle.destroy()
  }
  const readDriveVideos = deps.readDriveVideos ?? driveVideoIdsOf
  /** Read `bytes` after the answer went (never on the request's path), then the newest served meanwhile. */
  const readVideos = (viewId: number, list: DriveVideos, bytes: Uint8Array, version: string) => {
    list.reading = true
    list.version = version
    later(() => {
      if (videos.get(viewId) !== list) return
      const { ids, total } = readDriveVideos(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'))
      list.ids = ids
      list.total = total
      for (const id of ids) if (list.seen.size < DRIVE_VIDEOS_SEEN_MAX) list.seen.add(id)
      list.reading = false
      tellVideos(viewId, list)
      const next = list.next
      list.next = null
      if (next && next.version !== list.version) readVideos(viewId, list, next.bytes, next.version)
    }, 0)
  }
  // Each answer for the view's own document (its loads, and the page asking for itself as an image or a
  // frame, also from another page of the folder): its Drive videos, read from those exact bytes — once
  // per file version, one read at a time. Whether they are offered is `onOwnPage`'s (`tellVideos`).
  deps.frames.onDocumentServed?.((viewId, bytes, version) => {
    if (!views.has(viewId)) return
    let list = videos.get(viewId)
    if (!list) videos.set(viewId, list = { ids: [], total: 0, seen: new Set(), told: { count: 0, total: 0, seen: 0 }, version: null, reading: false, next: null })
    if (list.reading) {
      if (version !== list.version) list.next = { bytes, version }
      else list.next = null
      return
    }
    if (version !== list.version) readVideos(viewId, list, bytes, version)
  })
  // The window reloaded, crashed or closed: every view it holds closes and its grant is revoked,
  // and an open still under way for the page that is gone registers nothing.
  deps.shell.onWindowReset(windowId => {
    generations.set(windowId, generationOf(windowId) + 1)
    places.delete(windowId)
    for (const [viewId, v] of [...views]) if (v.windowId === windowId) close(viewId)
  })
  const stale = (ticket: DocViewTicket) => generationOf(ticket.windowId) !== ticket.generation

  return {
    /** Note the window's page now, when the member asks (before anything is read or made). */
    begin(windowId: number): DocViewTicket {
      deps.shell.watch(windowId)
      return { windowId, generation: generationOf(windowId) }
    },

    /**
     * A view of a checked document for the page `ticket` names, with a grant of its own; its id, or
     * null. `fragment` (`#…`, main's own: the manual's heading) is added to the address it loads.
     */
    async open(doc: OpenableDocument, ticket: DocViewTicket, fragment = ''): Promise<number | null> {
      if (stale(ticket)) return null
      // Left for 中身 earlier in this window: opened where the member was reading (taken once).
      const place = placeKey(doc)
      const kept = places.get(ticket.windowId)?.get(place) ?? null
      places.get(ticket.windowId)?.delete(place)
      const [handle, at] = await Promise.all([deps.shell.create(ticket.windowId, hooks), kept])
      if (!handle) return null
      if (stale(ticket)) {
        handle.destroy()
        return null
      }
      views.set(handle.id, { windowId: ticket.windowId, handle, place })
      const ofWindow = [...views].filter(([, v]) => v.windowId === ticket.windowId)
      for (const [viewId] of ofWindow.slice(0, Math.max(0, ofWindow.length - MAX_VIEWS_PER_WINDOW))) {
        close(viewId)
        deps.notify?.(ticket.windowId, { viewId, kind: 'gone' })
      }
      const address = deps.frames.grant(doc, handle.id)
      pages.set(handle.id, { doc: pageOf(address), own: true, seq: 0 })
      handle.show(address + (fragment.startsWith('#') ? fragment : ''), at)
      return handle.id
    },

    /**
     * Close a view; only its own window may (anything else is ignored). `keepPlace` (the member left
     * it for 中身): where its document was scrolled is kept for its next open in this window. Its
     * grant goes at once either way.
     */
    close(viewId: unknown, windowId: number, keepPlace?: unknown): void {
      const view = own(viewId, windowId)
      if (!view) return
      if (keepPlace !== true) {
        close(viewId as number)
        return
      }
      forget(viewId as number)
      let ofWindow = places.get(windowId)
      if (!ofWindow) places.set(windowId, ofWindow = new Map())
      ofWindow.delete(view.place)
      ofWindow.set(view.place, view.handle.closeKeepingPlace())
      for (const old of [...ofWindow.keys()].slice(0, Math.max(0, ofWindow.size - MAX_VIEWS_PER_WINDOW))) ofWindow.delete(old)
    },

    /**
     * Place and show a view, or hide it (`null`, or a placement that is not
     * four sane numbers); only its own window may (anything else is ignored).
     */
    place(viewId: unknown, windowId: number, bounds: unknown): void {
      own(viewId, windowId)?.handle.place(bounds === null ? null : docViewBounds(bounds))
    },

    /** The document's zoom, within the steps' range; only its own window may. */
    zoom(viewId: unknown, windowId: number, factor: unknown): void {
      const value = docZoomFactor(factor)
      if (value !== null) own(viewId, windowId)?.handle.zoom(value)
    },

    /** Load the document again; only its own window may. */
    reload(viewId: unknown, windowId: number): void {
      own(viewId, windowId)?.handle.reload()
    },

    /**
     * What the view does for the review (`null`: nothing, its marks cleared); only its own window may,
     * and only in the checked shape (`docViewReviewOf`; anything else is ignored).
     */
    review(viewId: unknown, windowId: number, review: unknown): void {
      const view = own(viewId, windowId)
      if (!view) return
      const id = viewId as number
      if (review === null) {
        if (reviews.has(id)) void view.handle.inReviewWorld(drawQuotesCode([])).catch(() => {})
        reviews.delete(id)
        return
      }
      const checked = docViewReviewOf(review)
      if (!checked) return
      reviews.set(id, checked)
      drawMarks(id)
    },

    /**
     * The address to open in the member's browser for the view's `index`-th Drive video (its canonical
     * Drive page, built from the id main read), or null: only its own window, only while its main frame
     * shows the document (as offered: `tellVideos`), an index of the list last read.
     */
    driveVideoUrl(viewId: unknown, windowId: number, index: unknown): string | null {
      if (!own(viewId, windowId) || typeof index !== 'number' || !Number.isInteger(index) || !onOwnPage(viewId as number)) return null
      const id = videos.get(viewId as number)?.ids[index]
      return id === undefined ? null : driveVideoViewUrl(id)
    },

    /**
     * Scroll to the mark the window sent at `index` (as last set) and make it flash; only its own window
     * may, and only while the view shows the reviewed document.
     */
    async findQuote(viewId: unknown, windowId: number, index: unknown): Promise<DocQuoteFound> {
      const view = own(viewId, windowId)
      const found = view && typeof index === 'number' && onOwnPage(viewId as number) ? reviews.get(viewId as number)?.quotes.find(q => q.index === index) : undefined
      if (!view || !found) return 'missing'
      const { text, nth, resolved } = found
      return docQuoteFoundOf(await view.handle.inReviewWorld(findQuoteCode({ text, nth, resolved })).catch(() => null))
    },
  }
}

export type DocViews = ReturnType<typeof createDocViews>
