// The consultation AI running one of the app's commands in this window (commands.md "Handed to
// the AI"; client/shared/app-commands.ts): main asks, the window answers. Nothing else is sent.
import type { AppCommandAnswer, AppCommandRequest } from '../../../shared/app-commands'
import type { ElectronPort } from './electron-api'

export type AppCommandRequests = ElectronPort<'onAppCommandRequest' | 'answerAppCommand'>

/** Subscribe to the AI's requests; returns the unsubscribe (a no-op where nothing asks: preview pages). */
export function onAppCommandRequest(callback: (request: AppCommandRequest) => void, port: Partial<AppCommandRequests> | undefined = window.electronAPI): () => void {
  return port?.onAppCommandRequest ? port.onAppCommandRequest(callback) : () => {}
}

export function answerAppCommand(requestId: string, answer: AppCommandAnswer, port: AppCommandRequests = window.electronAPI) {
  return port.answerAppCommand(requestId, answer)
}
