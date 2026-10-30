// Closing the main window: main holds the close and asks the renderer first
// (electron/services/close-guard.ts), so unsaved tabs can be saved. Answer
// `ack` at once, then `close` or `stay`.
import type { ElectronPort } from './electron-api'

export type WindowCloseRequests = ElectronPort<'onCloseRequested' | 'answerCloseRequest'>

/** Subscribe to close requests; returns the unsubscribe function (a no-op where nothing asks: preview pages). */
export function onWindowCloseRequested(callback: () => void, port: Partial<WindowCloseRequests> | undefined = window.electronAPI): () => void {
  return port?.onCloseRequested ? port.onCloseRequested(callback) : () => {}
}

export function answerWindowClose(answer: 'ack' | 'close' | 'stay', port: WindowCloseRequests = window.electronAPI) {
  return port.answerCloseRequest(answer)
}
