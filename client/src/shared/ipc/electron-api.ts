// The renderer's view of window.electronAPI. The contract (channels, arguments,
// results) is client/shared/ipc-contract.ts; electron/preload.ts implements it
// and exposes it. The renderer owns the typing of `window.electronAPI` here, so
// it no longer depends on the preload file.
//
// Data access is split into small ports, never one client object: each
// feature's api.ts names the few methods it uses, grouped by what they can do
// (read on this computer, write on this computer, send outside), so a later
// plugin bridge can be handed exactly one of those (renderer-structure.md).
import type { ElectronAPI } from '../../../shared/ipc-contract'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export type { ElectronAPI }

/** Only the named methods of the API: what one data-access unit may use. */
export type ElectronPort<K extends keyof ElectronAPI> = Pick<ElectronAPI, K>
