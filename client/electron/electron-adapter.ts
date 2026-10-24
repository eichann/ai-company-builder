// Electron's implementations of the ports feature modules depend on
// (electron/features/ports.ts). Shell layer: with main.ts, preload.ts and
// voice-input.ts, the only code that imports Electron.

import { dialog, nativeImage, shell, type BrowserWindow, type WebContents } from 'electron'
import type { DesktopShell, WindowPort } from './features/ports'

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

/** Events to the app's window; dropped while it does not exist or is destroyed. */
export function createWindowPort(getWindow: () => BrowserWindow | null): WindowPort {
  return {
    send(channel, ...payload) {
      const win = getWindow()
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...payload)
    },
  }
}
