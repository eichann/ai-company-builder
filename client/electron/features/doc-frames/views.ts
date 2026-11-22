/**
 * The HTML viewer's document views (`.claude/rules/doc-frame.md`): which views
 * are open, in which window, and their grants. A view is the only holder of
 * its grant: the grant is made for the view and revoked when the view goes —
 * closed by its window, destroyed, its page crashed, or its window reloaded,
 * crashed or closed (the shell's `onWindowReset`). No Electron here: the
 * shell (`electron/doc-view.ts`) makes the views on the document session.
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
  /**
   * A new empty view in window `windowId`, on the document session with its
   * guards; null when it cannot be made (the window is gone, the session could
   * not be prepared). `onGone` runs once when the view goes, for any reason.
   */
  create(windowId: number, onGone: (viewId: number) => void): Promise<DocViewHandle | null>
  /** Tell `listener` when a window holding views reloads its page, its page crashes or it closes. */
  onWindowReset(listener: (windowId: number) => void): void
}

/** At most this many document views per window; opening one more closes the oldest. */
export const MAX_VIEWS_PER_WINDOW = 32

export function createDocViews(deps: { frames: Pick<DocFrames, 'grant' | 'revoke'>; shell: DocViewPort }) {
  /** View id → its window and handle, in the order opened. */
  const views = new Map<number, { windowId: number; handle: DocViewHandle }>()

  const forget = (viewId: number) => {
    views.delete(viewId)
    deps.frames.revoke(viewId)
  }
  const close = (viewId: number) => {
    const view = views.get(viewId)
    forget(viewId)
    view?.handle.destroy()
  }
  // The window reloaded, crashed or closed: every view it holds closes and its grant is revoked.
  deps.shell.onWindowReset(windowId => {
    for (const [viewId, v] of [...views]) if (v.windowId === windowId) close(viewId)
  })

  return {
    /** A view of a checked document in window `windowId`, with a grant of its own; its id, or null. */
    async open(doc: OpenableDocument, windowId: number): Promise<number | null> {
      const own = [...views].filter(([, v]) => v.windowId === windowId)
      for (const [viewId] of own.slice(0, Math.max(0, own.length - MAX_VIEWS_PER_WINDOW + 1))) close(viewId)
      const handle = await deps.shell.create(windowId, forget)
      if (!handle) return null
      views.set(handle.id, { windowId, handle })
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
