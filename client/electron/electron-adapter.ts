// Electron's implementations of the ports feature modules depend on
// (electron/features/ports.ts). Shell layer: with main.ts, preload.ts and
// voice-input.ts, the only code that imports Electron.

import { shell, type BrowserWindow } from 'electron'
import type { DesktopShell, WindowPort } from './features/ports'

export const desktopShell: DesktopShell = {
  openPath: (target) => shell.openPath(target),
  openExternal: (url) => shell.openExternal(url),
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
