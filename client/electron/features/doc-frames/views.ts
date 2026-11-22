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
import type { DocFrames, OpenableDocument } from './protocol'

export interface DocViewHandle {
  /** The view's own id (its page's webContents id): the grant's owner. */
  readonly id: number
  /** Load the document's address (main keeps it; the renderer never sees it). */
  show(url: string): void
  /** Close the view and its page. `onGone` follows. */
  destroy(): void
}

export interface DocViewPort {
  /** Start telling `onWindowReset` about this window's page, at once (before any view is made). */
  watch(windowId: number): void
  /**
   * A new empty view in window `windowId`, on the document session with its
   * guards; null when it cannot be made (the window is gone, the session could
   * not be prepared). `onGone` runs once when the view goes, for any reason.
   */
  create(windowId: number, onGone: (viewId: number) => void): Promise<DocViewHandle | null>
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

export function createDocViews(deps: { frames: Pick<DocFrames, 'grant' | 'revoke'>; shell: DocViewPort }) {
  /** View id → its window and handle, in the order registered. */
  const views = new Map<number, { windowId: number; handle: DocViewHandle }>()
  /** Window → how many times its page reset (reloaded, crashed, closed). */
  const generations = new Map<number, number>()
  const generationOf = (windowId: number) => generations.get(windowId) ?? 0

  const forget = (viewId: number) => {
    views.delete(viewId)
    deps.frames.revoke(viewId)
  }
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
      const handle = await deps.shell.create(ticket.windowId, forget)
      if (!handle) return null
      if (stale(ticket)) {
        handle.destroy()
        return null
      }
      views.set(handle.id, { windowId: ticket.windowId, handle })
      const own = [...views].filter(([, v]) => v.windowId === ticket.windowId)
      for (const [viewId] of own.slice(0, Math.max(0, own.length - MAX_VIEWS_PER_WINDOW))) close(viewId)
      handle.show(deps.frames.grant(doc, handle.id))
      return handle.id
    },

    /** Close a view; only its own window may (anything else is ignored). */
    close(viewId: unknown, windowId: number): void {
      if (typeof viewId === 'number' && views.get(viewId)?.windowId === windowId) close(viewId)
    },
  }
}

export type DocViews = ReturnType<typeof createDocViews>
