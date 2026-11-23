// The HTML viewer's document views (doc-frame.md):
//   docView:open   (filePath) → the id of a view showing the document, or why not (plain Japanese)
//   docView:close  (viewId, keepPlace?) → the view closes and its grant is revoked; `true` (left for
//                  中身): main keeps where its document was scrolled for its next open in this window
//   docView:setBounds (viewId, bounds | null) → placed over the tab and shown, or hidden (and muted)
//   docView:setZoom (viewId, factor) / docView:reload (viewId) → the document's zoom; load it again
// (main → window: `docView:event`, sent by main.ts: a link the member pressed, a view that went, an
// app shortcut pressed in it, the internet parts its page wanted — hosts and a count only.)
// Only the main window's own page may ask (not a consultation window, not a frame inside the page),
// and that is decided before anything is read from the disk. The path goes through the allowed roots.
// The document's address stays in main: the renderer only ever holds a view id.
import type { DocViewOpenResult } from '../../../shared/doc-frame'
import type { IpcInvokeEvent, IpcRegistrar } from '../../ipc/registrar'
import { refuseDoc, type DocFrames } from './protocol'
import type { DocViews } from './views'

export interface DocViewsIpcDeps<E> {
  frames: Pick<DocFrames, 'check'>
  views: Pick<DocViews, 'begin' | 'open' | 'close' | 'place' | 'zoom' | 'reload'>
  /** The event came from the main window's main frame. */
  fromMainWindow: (event: E) => boolean
}

export function registerDocViewsIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E>, deps: DocViewsIpcDeps<E>): void {
  const { frames, views, fromMainWindow } = deps
  ipc.handle('docView:open', async (event, filePath): Promise<DocViewOpenResult> => {
    if (!fromMainWindow(event)) return refuseDoc('not_allowed')
    // The page as it is now: if it reloads or crashes while the file is checked or the view made,
    // nothing is registered for it.
    const ticket = views.begin(event.sender.id)
    const checked = await frames.check(filePath)
    if (!checked.ok) return checked
    const viewId = await views.open(checked.doc, ticket)
    return viewId === null ? refuseDoc('unavailable') : { ok: true, viewId }
  })
  ipc.handle('docView:close', (event, viewId, keepPlace) => {
    if (fromMainWindow(event)) views.close(viewId, event.sender.id, keepPlace)
  })
  ipc.handle('docView:setBounds', (event, viewId, bounds) => {
    if (fromMainWindow(event)) views.place(viewId, event.sender.id, bounds)
  })
  ipc.handle('docView:setZoom', (event, viewId, factor) => {
    if (fromMainWindow(event)) views.zoom(viewId, event.sender.id, factor)
  })
  ipc.handle('docView:reload', (event, viewId) => {
    if (fromMainWindow(event)) views.reload(viewId, event.sender.id)
  })
}
