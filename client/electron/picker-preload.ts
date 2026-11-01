// Google Picker's window only (google-drive.md "The Picker"; shell layer, like
// preload.ts). The page is the server's static Picker page; this preload gives
// it exactly two calls on its own window's IPC (`webContents.ipc`, nothing
// global): the config — once, handed by main only to that page — and the
// person's choice. No other API of the app exists in this window.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('acbPicker', {
  config: (): Promise<unknown> => ipcRenderer.invoke('drivePicker:config'),
  done: (result: unknown): void => ipcRenderer.send('drivePicker:done', result),
})
