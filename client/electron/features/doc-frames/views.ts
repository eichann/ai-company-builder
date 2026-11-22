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
import { docViewBounds, docZoomFactor, type DocViewBounds, type DocViewEvent } from '../../../shared/doc-frame'
import { webLinkForBrowser } from '../../external-url'
import type { DocFrames, OpenableDocument } from './protocol'

export interface DocViewHandle {
  /** The view's own id (its page's webContents id): the grant's owner. */
  readonly id: number
  /** Load the document's address (main keeps it; the renderer never sees it). */
  show(url: string): void
  /** Close the view and its page. `onGone` follows. */
  destroy(): void
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
}

/** What the shell tells the registry about one view. */
export interface DocViewHooks {
  /** The view went, for any reason (once). */
  onGone(viewId: number): void
  /** The member pressed a link to somewhere outside the document (the shell refused the navigation). */
  onLink(viewId: number, url: string): void
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

/** The window's page as it was when an open began. */
export interface DocViewTicket {
  readonly windowId: number
  readonly generation: number
}

/** At most this many document views per window; one more closes the oldest. */
export const MAX_VIEWS_PER_WINDOW = 32

/** A view asks the member about a link at most once in this long (a page cannot queue confirmations). */
export const LINK_INTERVAL_MS = 1000

export interface DocViewsDeps {
  frames: Pick<DocFrames, 'grant' | 'revoke'>
  shell: DocViewPort
  /** Tell the window about one of its views (`docView:event`). */
  notify?: (windowId: number, event: DocViewEvent) => void
  now?: () => number
}

export function createDocViews(deps: DocViewsDeps) {
  const now = deps.now ?? Date.now
  /** View id → when it last asked about a link. */
  const lastLink = new Map<number, number>()
  /** View id → its window and handle, in the order registered. */
  const views = new Map<number, { windowId: number; handle: DocViewHandle }>()
  /** Window → how many times its page reset (reloaded, crashed, closed). */
  const generations = new Map<number, number>()
  const generationOf = (windowId: number) => generations.get(windowId) ?? 0

  const forget = (viewId: number) => {
    views.delete(viewId)
    lastLink.delete(viewId)
    deps.frames.revoke(viewId)
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
  }
  /** The view, when `windowId` holds it. */
  const own = (viewId: unknown, windowId: number) =>
    typeof viewId === 'number' && views.get(viewId)?.windowId === windowId ? views.get(viewId)! : null
  const close = (viewId: number) => {
    const view = views.get(viewId)
    forget(viewId)
    view?.handle.destroy()
  }
  // The window reloaded, crashed or closed: every view it holds closes and its grant is revoked,
  // and an open still under way for the page that is gone registers nothing.
  deps.shell.onWindowReset(windowId => {
    generations.set(windowId, generationOf(windowId) + 1)
    for (const [viewId, v] of [...views]) if (v.windowId === windowId) close(viewId)
  })
  const stale = (ticket: DocViewTicket) => generationOf(ticket.windowId) !== ticket.generation

  return {
    /** Note the window's page now, when the member asks (before anything is read or made). */
    begin(windowId: number): DocViewTicket {
      deps.shell.watch(windowId)
      return { windowId, generation: generationOf(windowId) }
    },

    /** A view of a checked document for the page `ticket` names, with a grant of its own; its id, or null. */
    async open(doc: OpenableDocument, ticket: DocViewTicket): Promise<number | null> {
      if (stale(ticket)) return null
      const handle = await deps.shell.create(ticket.windowId, hooks)
      if (!handle) return null
      if (stale(ticket)) {
        handle.destroy()
        return null
      }
      views.set(handle.id, { windowId: ticket.windowId, handle })
      const ofWindow = [...views].filter(([, v]) => v.windowId === ticket.windowId)
      for (const [viewId] of ofWindow.slice(0, Math.max(0, ofWindow.length - MAX_VIEWS_PER_WINDOW))) {
        close(viewId)
        deps.notify?.(ticket.windowId, { viewId, kind: 'gone' })
      }
      handle.show(deps.frames.grant(doc, handle.id))
      return handle.id
    },

    /** Close a view; only its own window may (anything else is ignored). */
    close(viewId: unknown, windowId: number): void {
      if (own(viewId, windowId)) close(viewId as number)
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
  }
}

export type DocViews = ReturnType<typeof createDocViews>
