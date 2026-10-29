// Electron's implementations of the ports feature modules depend on
// (electron/features/ports.ts). Shell layer: with main.ts, preload.ts and
// voice-input.ts, the only code that imports Electron.

import { pathToFileURL } from 'url'
import { dialog, nativeImage, net, protocol, safeStorage, shell, type BrowserWindow, type WebContents } from 'electron'
import type { AllowedRoots } from './allowed-roots'
import { localFileTarget } from './local-file-protocol'
import type { DesktopShell, WindowPort } from './features/ports'
import type { MessageBoxHost } from './sync/message-box-dialog'
import type { SecretBox } from './services/api-key-store'

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
