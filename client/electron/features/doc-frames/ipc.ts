// The HTML viewer's document views (doc-frame.md):
//   docView:open   (filePath) → the id of a view showing the document, or why not (plain Japanese)
//   docView:close  (viewId)   → the view closes and its grant is revoked
// Only the main window's own page may ask (not a consultation window, not a frame inside the page),
// and that is decided before anything is read from the disk. The path goes through the allowed roots.
// The document's address stays in main: the renderer only ever holds a view id.
import type { DocViewOpenResult } from '../../../shared/doc-frame'
import type { IpcInvokeEvent, IpcRegistrar } from '../../ipc/registrar'
import { refuseDoc, type DocFrames } from './protocol'
import type { DocViews } from './views'

export interface DocViewsIpcDeps<E> {
  frames: Pick<DocFrames, 'check'>
  views: Pick<DocViews, 'open' | 'close'>
  /** The event came from the main window's main frame. */
  fromMainWindow: (event: E) => boolean
}

export function registerDocViewsIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E>, deps: DocViewsIpcDeps<E>): void {
  const { frames, views, fromMainWindow } = deps
  ipc.handle('docView:open', async (event, filePath): Promise<DocViewOpenResult> => {
    if (!fromMainWindow(event)) return refuseDoc('not_allowed')
    const checked = await frames.check(filePath)
    if (!checked.ok) return checked
    const viewId = await views.open(checked.doc, event.sender.id)
    return viewId === null ? refuseDoc('unavailable') : { ok: true, viewId }
  })
  ipc.handle('docView:close', (event, viewId) => {
    if (fromMainWindow(event)) views.close(viewId, event.sender.id)
  })
}
