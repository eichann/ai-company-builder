// Electron's implementations of the ports feature modules depend on
// (electron/features/ports.ts). Shell layer: with main.ts, preload.ts and
// voice-input.ts, the only code that imports Electron. Over 300 lines on
// purpose: everything another desktop shell must re-implement is in one file.

import path from 'path'
import { pathToFileURL } from 'url'
import { app, BrowserWindow, dialog, nativeImage, net, protocol, safeStorage, screen, shell, type WebContents, type WebPreferences } from 'electron'
import type { AllowedRoots } from './allowed-roots'
import { localFileTarget } from './local-file-protocol'
import type { DesktopShell, WindowPort } from './features/ports'
import type { ChatWindowHost } from './features/chat-windows/ipc'
import type { MessageBoxHost } from './sync/message-box-dialog'
import type { SecretBox } from './services/api-key-store'
import { createCloseGuard, type CloseAnswer, type CloseGuard } from './services/close-guard'

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
 * `?window=chat`; no other page, no popups. The last bounds are remembered.
 */
export function createChatWindowHost(options: {
  webPreferences: () => WebPreferences
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
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
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
  load: (win: BrowserWindow) => void
  askClose: (window: WindowPort) => void
  /** Sent with requests to image.docbase.io (its images answer 403 otherwise). */
  docbaseCookie: () => string | undefined
  onClosed: () => void
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
        webPreferences: options.webPreferences(),
      })
      current = win
      win.on('closed', options.onClosed)
      const winGuard = createCloseGuard({
        ask: () => options.askClose(port),
        close: () => { if (!win.isDestroyed()) win.close() },
        quit: () => app.quit(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
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

/** Register the local-file:// scheme (must run before app.whenReady()). */
export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } },
  ])
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
