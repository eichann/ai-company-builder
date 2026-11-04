// Electron's implementations of the ports feature modules depend on
// (electron/features/ports.ts). Shell layer: with main.ts, preload.ts and
// voice-input.ts, the only code that imports Electron. Over 300 lines on
// purpose: everything another desktop shell must re-implement is in one file.

import path from 'path'
import { pathToFileURL } from 'url'
import { app, BrowserWindow, dialog, nativeImage, net, Notification, protocol, safeStorage, screen, session, shell, type Session, type WebContents, type WebPreferences } from 'electron'
import type { AllowedRoots } from './allowed-roots'
import { localFileTarget } from './local-file-protocol'
import { isPluginAddress, PLUGIN_SCHEME, pluginFrameNavigationAllowed } from '../shared/plugin-bridge'
import type { PluginFileServer } from './features/plugins/protocol'
import { allowPermission, isAppPage, type AppPage } from './permission-policy'
import { webLinkForBrowser } from './external-url'
import type { DesktopShell, DrivePickerOutcome, DrivePickerWindow, WindowPort } from './features/ports'
import { isDrivePickerPage, readDrivePickerResult } from './features/google/drive'
import type { ChatWindowHost } from './features/chat-windows/ipc'
import type { MessageBoxHost } from './sync/message-box-dialog'
import type { SecretBox } from './services/api-key-store'
import { CLOSE_DURING_SYNC_CHOICES, CLOSE_DURING_SYNC_QUESTION, createCloseGuard, type CloseAnswer, type CloseGuard } from './services/close-guard'

/** Desktop notifications still on screen (one that is garbage-collected loses its click). */
const liveNotifications = new Set<Notification>()

export const desktopShell: DesktopShell = {
  openPath: (target) => shell.openPath(target),
  openExternal: (url) => shell.openExternal(url),
  async selectDirectory() {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.filePaths[0] || null
  },
  // Native drag to external apps (browser, Finder, Slack, etc.)
  startDrag(sender, file) {
    (sender as WebContents).startDrag({
      file,
      icon: nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
      ),
    })
  },
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return
    const shown = new Notification({ title, body })
    liveNotifications.add(shown)
    shown.on('click', () => { liveNotifications.delete(shown); onClick?.() })
    shown.on('close', () => liveNotifications.delete(shown))
    shown.show()
  },
}

/**
 * The OS keychain-backed encryption for secrets in config.json (the API key).
 * On Linux, safeStorage's 'basic_text' backend (no keyring) only obfuscates
 * with a fixed password, so it counts as unavailable. Before app ready it is
 * unavailable too (the key store retries later).
 */
export const secretBox: SecretBox = {
  available() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend()
        if (backend === 'basic_text' || backend === 'unknown') return false
      }
      return true
    } catch {
      return false
    }
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
}

/** Events to the app's window; dropped while it does not exist or is destroyed. */
export function createWindowPort(getWindow: () => BrowserWindow | null): WindowPort {
  return {
    send(channel, ...payload) {
      const win = getWindow()
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...payload)
    },
  }
}

/** Events to several windows at once (the main window and the consultation windows); dead ones are skipped. */
export function createBroadcastPort(getWindows: () => Array<BrowserWindow | null | undefined>): WindowPort {
  return {
    send(channel, ...payload) {
      for (const win of getWindows()) {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...payload)
      }
    },
  }
}

export interface WindowBounds { x?: number; y?: number; width: number; height: number }

/**
 * Every app window shows only the app's page: a link that would open a new
 * window (`target="_blank"` in a chat answer or a markdown preview,
 * window.open) or navigate the window away from the app opens in the member's
 * own browser instead (http / https only; anything else is just refused).
 * Without this, Electron opened such links in a new app window. Only the main
 * frame: the PDF preview's iframe is Chromium's viewer and navigates itself.
 */
export function keepAppPageInWindow(contents: WebContents, page: AppPage): void {
  const openInBrowser = (url: string) => {
    const link = webLinkForBrowser(url)
    if (link) void shell.openExternal(link).catch(() => { /* no browser: nothing to do */ })
  }
  contents.setWindowOpenHandler(({ url, referrer }) => {
    // A plugin's screen opens nothing, not even in the browser (its sandbox refuses popups too).
    if (!isPluginAddress(url) && !isPluginAddress(referrer?.url)) openInBrowser(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', event => {
    if (isAppPage(event.url, page)) return
    event.preventDefault()
    if (!isPluginAddress(event.url)) openInBrowser(event.url)
  })
  // A frame showing a plugin's page navigates nowhere; only the app's own frames load one (plugin-frame.md).
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame) return
    if (!pluginFrameNavigationAllowed(event.frame?.url, event.url)) event.preventDefault()
  })
}

/** Saved bounds only when they still lie on a connected display (a monitor may be gone); else only the size. */
function usableBounds(saved: WindowBounds | undefined, fallback: WindowBounds): WindowBounds {
  if (!saved || !(saved.width >= 420) || !(saved.height >= 480)) return fallback
  const size = { width: Math.round(saved.width), height: Math.round(saved.height) }
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return size
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x! < a.x + a.width - 80 && saved.x! + size.width > a.x + 80 && saved.y! >= a.y - 10 && saved.y! < a.y + a.height - 80)
  return onScreen ? { ...size, x: Math.round(saved.x), y: Math.round(saved.y) } : size
}

/**
 * Consultation windows (「別ウィンドウで開く」, features/chat-windows): the
 * same page, preload and web preferences as the main window (`webPreferences`
 * is the main window's, so the hardening is one copy), loaded with
 * `?window=chat`; no other page, no popups (`keepAppPageInWindow`). The last
 * bounds are remembered.
 */
export function createChatWindowHost(options: {
  webPreferences: () => WebPreferences
  page: () => AppPage
  load: (win: BrowserWindow) => void
  bounds: { load(): WindowBounds | undefined; save(bounds: WindowBounds): void }
}) {
  const windows = new Map<number, BrowserWindow>()
  // Closes the app asks for (quitting, sign-out, the main window closed) do not ask the member.
  let quitting = false
  const forced = new Set<number>()
  const host: ChatWindowHost = {
    open({ title, confirmClose, onClosed }) {
      const remembered = usableBounds(options.bounds.load(), { width: 760, height: 860 })
      // Another window already sits where the last one was: step aside so both show.
      const offset = windows.size * 28
      const win = new BrowserWindow({
        ...remembered,
        ...(remembered.x !== undefined && remembered.y !== undefined ? { x: remembered.x + offset, y: remembered.y + offset } : {}),
        minWidth: 420,
        minHeight: 480,
        title,
        titleBarStyle: 'default',
        show: false,
        webPreferences: options.webPreferences(),
      })
      const id = win.webContents.id
      windows.set(id, win)
      keepAppPageInWindow(win.webContents, options.page())
      win.once('ready-to-show', () => win.show())
      let confirmed = false
      win.on('close', event => {
        try { options.bounds.save(win.getNormalBounds()) } catch { /* bounds are a convenience */ }
        if (confirmed || quitting || forced.has(id)) return
        const question = confirmClose()
        if (!question) return
        event.preventDefault()
        void dialog.showMessageBox(win, {
          type: 'warning', message: question.message, detail: question.detail,
          buttons: ['閉じる', 'キャンセル'], defaultId: 1, cancelId: 1,
        }).then(({ response }) => {
          if (response !== 0 || win.isDestroyed()) return
          confirmed = true
          win.close()
        })
      })
      win.on('closed', () => { windows.delete(id); forced.delete(id); onClosed() })
      options.load(win)
      return id
    },
    focus(windowId) {
      const win = windows.get(windowId)
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    close(windowId) {
      const win = windows.get(windowId)
      if (!win || win.isDestroyed()) return
      forced.add(windowId)
      win.close()
    },
  }
  return {
    host,
    /** The app is quitting: windows close without asking. */
    quitting() { quitting = true },
    webContents: (windowId: number): WebContents | undefined => {
      const win = windows.get(windowId)
      return win && !win.isDestroyed() ? win.webContents : undefined
    },
    windows: () => [...windows.values()],
  }
}

/**
 * The app's page in every window. `appDir` holds preload.js; the page is
 * ../dist/index.html, or the Vite dev server. `?window=chat` shows only one
 * consultation (src/main.tsx).
 */
export function createAppPages(appDir: string) {
  return {
    /**
     * The web preferences of every app window: the main one and the consultation
     * windows (「別ウィンドウで開く」) share this one copy — isolated, sandboxed, no
     * Node, the one preload; the page's CSP comes with index.html.
     */
    webPreferences(): WebPreferences {
      const disableElectronSpellcheck =
        process.env.ELECTRON_DISABLE_SPELLCHECK === '1' ||
        process.env.ELECTRON_DISABLE_SPELL_CHECKING === '1'
      return {
        preload: path.join(appDir, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Reversible A/B test switch for input lag diagnosis.
        spellcheck: !disableElectronSpellcheck,
        // Required for the in-iframe Chromium PDF Viewer to render `blob:` PDFs in
        // packaged builds. Without this, dev (HTTP origin) happens to work but the
        // production file:// origin blocks the embedded PDF viewer.
        plugins: true,
      }
    },
    /** Where the page comes from: what counts as the app's own page for web permissions (permission-policy.ts). */
    page(): AppPage {
      return { file: pathToFileURL(path.join(appDir, '../dist/index.html')).href, devServerUrl: process.env.VITE_DEV_SERVER_URL || undefined }
    },
    load(win: BrowserWindow, query?: Record<string, string>) {
      if (process.env.VITE_DEV_SERVER_URL) {
        const url = new URL(process.env.VITE_DEV_SERVER_URL)
        for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
        void win.loadURL(url.toString())
      } else {
        void win.loadFile(path.join(appDir, '../dist/index.html'), query ? { query } : undefined)
      }
    },
  }
}

/**
 * The main window. Closing it (or quitting) first lets the renderer save every
 * open tab (services/close-guard.ts); `askClose` sends it app:closeRequested.
 */
export function createMainWindowHost(options: {
  webPreferences: () => WebPreferences
  page: () => AppPage
  load: (win: BrowserWindow) => void
  askClose: (window: WindowPort) => void
  /** Sent with requests to image.docbase.io (its images answer 403 otherwise). */
  docbaseCookie: () => string | undefined
  onClosed: () => void
  /** The running app's sync (null until it is wired): closing waits for it. */
  sync: () => { isRunning(): boolean; whenIdle(): Promise<void>; resumeAutomaticRuns(): void } | null
}) {
  let current: BrowserWindow | null = null
  let guard: CloseGuard | null = null
  let quitRequested = false
  const live = () => (current && !current.isDestroyed() ? current : null)
  const port = createWindowPort(() => current)
  return {
    window: () => current,
    /** Events to the main window. */
    port,
    open() {
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        titleBarStyle: 'hiddenInset',
        // AI turns run in this window while it is open, also behind other apps or minimized (ai-turns.md).
        webPreferences: { ...options.webPreferences(), backgroundThrottling: false },
      })
      current = win
      win.on('closed', options.onClosed)
      keepAppPageInWindow(win.webContents, options.page())
      const winGuard = createCloseGuard({
        ask: () => options.askClose(port),
        close: () => { if (!win.isDestroyed()) win.close() },
        quit: () => app.quit(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
        sync: {
          running: () => options.sync()?.isRunning() ?? false,
          done: () => options.sync()?.whenIdle() ?? Promise.resolve(),
          resume: () => options.sync()?.resumeAutomaticRuns(),
          confirm: async () => {
            const { response } = await dialog.showMessageBox(win, { type: 'warning', ...CLOSE_DURING_SYNC_QUESTION })
            const choice = CLOSE_DURING_SYNC_CHOICES[response] ?? 'stay'
            if (choice === 'stay') quitRequested = false
            return choice
          },
        },
      })
      if (quitRequested) winGuard.onQuitRequested()
      guard = winGuard
      win.on('close', event => { if (!winGuard.onClose()) event.preventDefault() })
      // Fully disable spell checker to prevent dictionary loading overhead (especially for Japanese IME)
      win.webContents.session.setSpellCheckerLanguages([])
      const docbaseCookie = options.docbaseCookie()
      if (docbaseCookie) {
        win.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['https://image.docbase.io/*'] }, (details, callback) => {
          details.requestHeaders['Cookie'] = docbaseCookie
          callback({ requestHeaders: details.requestHeaders })
        })
      }
      // DevTools disabled for performance testing: win.webContents.openDevTools() to enable.
      options.load(win)
    },
    /** `before-quit`: once the renderer says close, quit instead of only closing. */
    quitting() { quitRequested = true; guard?.onQuitRequested() },
    /** The renderer's answer to app:closeRequested; only the main window may answer. */
    answerClose(senderId: number, answer: CloseAnswer) {
      const win = live()
      if (!win || senderId !== win.webContents.id) return
      if (answer === 'ack' || answer === 'close' || answer === 'stay') guard?.answer(answer)
      if (answer === 'stay') quitRequested = false
    },
    isWindow: (webContentsId: number) => live()?.webContents.id === webContentsId,
    /** Brings it to the front; false when there is none. */
    focus() {
      const win = live()
      if (!win) return false
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return true
    },
  }
}

/** Sync's questions as native message boxes, on the window when there is one. */
export function createMessageBoxHost(getWindow: () => BrowserWindow | null): MessageBoxHost {
  return {
    hasWindow: () => { const win = getWindow(); return !!win && !win.isDestroyed() },
    showMessageBox: (options) => {
      const current = getWindow()
      const win = current && !current.isDestroyed() ? current : null
      return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    },
  }
}

/**
 * Google Picker in a window of its own (google-drive.md "The Picker"): the
 * server's static Picker page with its own preload (`picker-preload.js`:
 * two calls, nothing else of the app), isolated and sandboxed, its own
 * session partition (Google's sign-in cookies stay out of the app's), no
 * popups, no navigation away. The config — the drive.file token — is handed
 * once, on this window's own IPC (`webContents.ipc`), only to its main frame
 * while it shows the Picker page; the token is dropped when the window closes.
 */
export function createDrivePickerWindow(appDir: string): DrivePickerWindow {
  return {
    open({ pageUrl, config, timeoutMs }) {
      return new Promise<DrivePickerOutcome>(resolve => {
        const win = new BrowserWindow({
          width: 1060, height: 720, title: 'Google Drive から選ぶ', autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(appDir, 'picker-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
            partition: 'persist:acb-google-picker', spellcheck: false,
          },
        })
        let handed: typeof config | null = config
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (outcome: DrivePickerOutcome) => {
          if (settled) return
          settled = true
          handed = null
          clearTimeout(timer)
          resolve(outcome)
          if (!win.isDestroyed()) win.close()
        }
        timer = setTimeout(() => finish({ action: 'timeout' }), timeoutMs)
        const fromPickerPage = (frame: Electron.WebFrameMain | null | undefined) =>
          !!frame && !win.isDestroyed() && frame === win.webContents.mainFrame && isDrivePickerPage(frame.url, pageUrl)
        win.webContents.ipc.handle('drivePicker:config', event => {
          if (!fromPickerPage(event.senderFrame)) return null
          const once = handed
          handed = null
          return once
        })
        win.webContents.ipc.on('drivePicker:done', (event, result: unknown) => {
          if (fromPickerPage(event.senderFrame)) finish(readDrivePickerResult(result, config.maxItems))
        })
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        win.webContents.on('will-navigate', event => { if (!isDrivePickerPage(event.url, pageUrl)) event.preventDefault() })
        win.on('closed', () => finish({ action: 'closed' }))
        void win.loadURL(pageUrl).catch(() => finish({ action: 'error' }))
      })
    },
  }
}

/**
 * Web permissions (camera / microphone, notifications, clipboard, …) on one
 * session: only what the app's own page uses, nothing for any other page
 * (permission-policy.ts). Without a handler Electron grants every request.
 */
export function denyUnexpectedPermissions(ses: Session, page: AppPage): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const allowed = allowPermission(permission, details.requestingUrl, page)
    // The permission's name only: the URL may name a file of the company folder.
    if (!allowed) console.warn(`[permissions] refused a request for ${permission}`)
    callback(allowed)
  })
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    allowPermission(permission, details.requestingUrl ?? requestingOrigin, page))
}

/**
 * Every session gets `denyUnexpectedPermissions`: the default one once the app
 * is ready, and each one created later (a partition). Call before app ready.
 */
export function guardEverySession(page: AppPage): void {
  app.on('session-created', ses => denyUnexpectedPermissions(ses, page))
  void app.whenReady().then(() => denyUnexpectedPermissions(session.defaultSession, page))
}

/**
 * Register the app's schemes (must run before app.whenReady(); Electron takes
 * one list): local-file:// and acb-plugin:// (a plugin's screen,
 * plugin-frame.md). acb-plugin is `standard` (relative paths resolve inside
 * the package) and `secure`; `corsEnabled` only so the frame's module scripts
 * load (its origin is opaque). Never `bypassCSP`, `supportFetchAPI`,
 * `allowServiceWorkers` or `stream`: the frame's CSP must hold.
 */
export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } },
    { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, corsEnabled: true } },
  ])
}

/**
 * The invitation page's 「アプリを開く」 (`ai-company-builder://open?server=…`): every link the
 * OS hands the app — macOS `open-url` (also before ready), and the arguments of the first
 * launch or a second instance (Windows) — goes to `onLink` (features/app-link: it only offers
 * an https address for the member to confirm). The packaged app registers the scheme through
 * `build.protocols`; a development run registers its own command.
 */
export function receiveAppLinks(scheme: string, onLink: (raw: string) => void, findInArgs: (argv: readonly string[]) => string | null): void {
  void app.whenReady().then(() => {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(scheme)
    }
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    onLink(url)
  })
  app.on('second-instance', (_event, argv) => {
    const link = findInArgs(argv)
    if (link) onLink(link)
  })
  const atLaunch = findInArgs(process.argv)
  if (atLaunch) onLink(atLaunch)
}

/** Serve acb-plugin:// from the verified packages only (`features/plugins/protocol.ts`), once the app is ready. */
export function servePluginFiles(files: PluginFileServer): void {
  void app.whenReady().then(() => {
    protocol.handle(PLUGIN_SCHEME, request => files.serve({ url: request.url, method: request.method }))
  })
}

/**
 * Serve local-file:// from inside the allowed roots only (by name, then by
 * real location: a link must not lead out of the company folder).
 * `?v=<n>` (a per-path version the renderer bumps on file events) is dropped
 * before resolving; responses are never cached, so a replaced file shows.
 */
export function serveLocalFiles(roots: AllowedRoots): void {
  protocol.handle('local-file', async (request) => {
    const target = localFileTarget(request.url, roots)
    if (!target.ok) {
      return new Response(target.status === 403 ? 'Forbidden: path is outside allowed directories' : 'Bad request', { status: target.status })
    }
    // Inside by name; a link there must not lead out of the company folder.
    let resolved: string
    try {
      resolved = roots.validate(target.path)
    } catch {
      return new Response('Forbidden: path is outside allowed directories', { status: 403 })
    }
    const response = await net.fetch(pathToFileURL(resolved).toString())
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
}
