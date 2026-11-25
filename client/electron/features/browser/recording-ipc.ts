// Settings › 「ブラウザ操作」 › 「記録する」 (agent-browser.md "Recording"):
//   browserRecording:get         the member's recording in this company (none / recording / waiting to be sent)
//   browserRecording:start       「記録する」 on a site of the current policy
//   browserRecording:stop        「記録を止める」
//   browserRecording:removeLine  ［消す］ on one line before sending
//   browserRecording:send        ［送る］
//   browserRecording:discard     ［捨てる］
// Only the main window's main frame may ask; the host is only a name (main records only a site its current policy lists).
// Every answer is a view of lines in the recording's kept form — never a value.
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import type { BrowserRecordingResult } from '../../../shared/browser-recorder'
import { BROWSER_RECORDING_MAIN_WORDS, type BrowserRecordings } from './recording'

export interface BrowserRecordingIpcDeps<E> {
  recordings: Pick<BrowserRecordings, 'view' | 'start' | 'stop' | 'removeLine' | 'send' | 'discard'>
  fromMainWindow: (event: E) => boolean
}

const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const notMain: BrowserRecordingResult = { ok: false, message: BROWSER_RECORDING_MAIN_WORDS.notMainWindow }

export function registerBrowserRecordingIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserRecordingIpcDeps<E>): void {
  const { recordings, fromMainWindow } = deps
  ipc.handle('browserRecording:get', (event, companyId): BrowserRecordingResult =>
    fromMainWindow(event) && id(companyId) ? { ok: true, view: recordings.view(companyId) } : notMain)
  ipc.handle('browserRecording:start', async (event, companyId, host) =>
    fromMainWindow(event) && id(companyId) && id(host) ? recordings.start(companyId, host) : notMain)
  ipc.handle('browserRecording:stop', async (event, companyId) =>
    fromMainWindow(event) && id(companyId) ? recordings.stop(companyId) : notMain)
  ipc.handle('browserRecording:removeLine', (event, companyId, lineId) =>
    fromMainWindow(event) && id(companyId) && typeof lineId === 'number' ? recordings.removeLine(companyId, lineId) : notMain)
  ipc.handle('browserRecording:send', async (event, companyId) =>
    fromMainWindow(event) && id(companyId) ? recordings.send(companyId) : notMain)
  ipc.handle('browserRecording:discard', async (event, companyId) =>
    fromMainWindow(event) && id(companyId) ? recordings.discard(companyId) : notMain)
}
