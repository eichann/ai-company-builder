// Sign-in's access to the main process, as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts). Only signing out is here so far: the
// sign-in screens and authStore still call window.electronAPI directly.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/**
 * Signing out: main tells the company server to end the session, then
 * forgets it on this computer even when the server cannot be reached.
 */
export type SignOutOutbound = ElectronPort<'signOut'>

export function signOut(outbound: SignOutOutbound = window.electronAPI) {
  return outbound.signOut()
}
