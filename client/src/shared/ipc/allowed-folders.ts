// Opening a company folder lets the app's file operations reach it (appStore
// when a company is chosen, App.tsx when the last one is restored), as one
// small port over the IPC contract (src/shared/ipc/electron-api.ts).
import type { ElectronPort } from './electron-api'

/**
 * Registering a folder on this computer as one the app's file operations may
 * read and write: main answers nothing about a folder until it is registered.
 */
export type AllowedFolderWrites = ElectronPort<'registerAllowedRoot'>

/** False in a window without a main process behind it (preview pages): there is nothing to register with. */
export function canRegisterCompanyFolder(writes: Partial<AllowedFolderWrites> | undefined = window.electronAPI) {
  return !!writes?.registerAllowedRoot
}

export function registerCompanyFolder(folder: string, writes: AllowedFolderWrites = window.electronAPI) {
  return writes.registerAllowedRoot(folder)
}
