// Settings › 「ブラウザ操作」 › 「この PC」 (agent-browser.md "This PC's registration", the app's half):
//   browserDevice:get       this PC's state in the company and the member's usable combinations
//   browserDevice:register  「この PC を登録する」 / 「登録し直す」 with the PC's name
//   browserDevice:withdraw  「取り下げる」 / 「この PC での利用をやめる」
// Only the main window's main frame may ask. Every answer is a `BrowserPcResult` / `BrowserPcView`: a state, a name and
// the combinations' names — never the PC's key, its hash or the registration's id (device.ts keeps the key in main).
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import { BROWSER_PC_WORDS, type BrowserPcResult } from '../../../shared/browser-device'
import type { BrowserDevice } from './device'

export interface BrowserDeviceIpcDeps<E> {
  device: Pick<BrowserDevice, 'view' | 'register' | 'withdraw'>
  fromMainWindow: (event: E) => boolean
}

const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const notMain: BrowserPcResult = { ok: false, message: BROWSER_PC_WORDS.notMainWindow }

export function registerBrowserDeviceIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserDeviceIpcDeps<E>): void {
  ipc.handle('browserDevice:get', async (event, companyId): Promise<BrowserPcResult> => {
    if (!deps.fromMainWindow(event) || !id(companyId)) return notMain
    return { ok: true, view: await deps.device.view(companyId) }
  })
  ipc.handle('browserDevice:register', async (event, companyId, label) =>
    deps.fromMainWindow(event) && id(companyId) ? deps.device.register(companyId, label) : notMain)
  ipc.handle('browserDevice:withdraw', async (event, companyId) =>
    deps.fromMainWindow(event) && id(companyId) ? deps.device.withdraw(companyId) : notMain)
}
