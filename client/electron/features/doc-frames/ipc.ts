// The HTML viewer's grants (doc-frame.md):
//   docFrames:open   (filePath) → the document's `acb-doc://` address, or why not (plain Japanese)
//   docFrames:close  (url)      → the grant is revoked (the view closed)
// Only the main window's own page may ask (not a consultation window, not a frame inside the page:
// a document frame must never open grants). The path goes through the allowed roots.
import { DOC_FRAME_WORDS, type DocFrameRefused } from '../../../shared/doc-frame'
import type { IpcInvokeEvent, IpcRegistrar } from '../../ipc/registrar'
import type { DocFrames } from './protocol'

export interface DocFramesIpcDeps<E> {
  docFrames: Pick<DocFrames, 'check' | 'grant' | 'close'>
  /** The event came from the main window's main frame. */
  fromMainWindow: (event: E) => boolean
}

const NOT_ALLOWED: DocFrameRefused = { ok: false, reason: 'not_allowed', message: DOC_FRAME_WORDS.not_allowed }

export function registerDocFramesIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E>, deps: DocFramesIpcDeps<E>): void {
  const { docFrames, fromMainWindow } = deps
  ipc.handle('docFrames:open', async (event, filePath) => {
    const checked = await docFrames.check(filePath)
    if (!checked.ok) return checked
    if (!fromMainWindow(event)) return NOT_ALLOWED
    return { ok: true, url: docFrames.grant(checked.doc, event.sender.id) }
  })
  ipc.handle('docFrames:close', (event, url) => {
    if (fromMainWindow(event)) docFrames.close(url, event.sender.id)
  })
}
