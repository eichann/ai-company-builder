// Settings → 「ブラウザ操作」 (agent-browser.md "The app's window"):
//   browser:sites       the member's sites now (asks the server first, at most a few seconds)
//   browser:open        「開いてログイン」: the site's window
//   browser:clearLogin  「ログインを消す」
// Only the main window's own page may ask (not a consultation window, not a frame inside the
// page); the host is only a name: main opens it only when the current, valid policy lists it.
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import { BROWSER_WORDS } from '../../../shared/browser-operation'
import type { BrowserController } from './controller'

export interface BrowserIpcDeps<E> {
  browser: Pick<BrowserController, 'sites' | 'open' | 'clearLogin'>
  /** The event came from the main window's main frame. */
  fromMainWindow: (event: E) => boolean
  /** Ask the server for the company's policy now (the controller hears the answer or the failure). */
  refresh: (companyId: string) => Promise<unknown>
  /** Keep the company's push channel (and its 60 s check) running, so a change reaches open windows. */
  watch: (companyId: string) => void
}

const SITES_WAIT_MS = 5_000
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const refused = { ok: false as const, message: BROWSER_WORDS.notAllowed }

export function registerBrowserIpc<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserIpcDeps<E>): void {
  const { browser, fromMainWindow, refresh, watch } = deps
  ipc.handle('browser:sites', async (event, companyId) => {
    if (!fromMainWindow(event) || !id(companyId)) return { sites: [] }
    watch(companyId)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([refresh(companyId).catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, SITES_WAIT_MS) })])
    clearTimeout(timer)
    return browser.sites(companyId)
  })
  ipc.handle('browser:open', (event, companyId, host) =>
    fromMainWindow(event) && id(companyId) && id(host) ? browser.open(companyId, host) : refused)
  ipc.handle('browser:clearLogin', (event, companyId, host) =>
    fromMainWindow(event) && id(companyId) && id(host) ? browser.clearLogin(companyId, host) : refused)
}
