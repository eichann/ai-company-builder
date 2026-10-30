// Sign-in's access to the main process (the server setup screen, the login
// screen, authStore, the start-up in App.tsx), as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts). Every function takes its port as
// the last parameter, defaulting to window.electronAPI.
// The session (cookies) stays in the main process; these ports never return it.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** Reading this computer's setting: which company server the app talks to (null when none). */
export type ServerUrlReads = ElectronPort<'getServerUrl'>
/** Changing that setting: where sign-in sends the member's password from now on. */
export type ServerUrlWrites = ElectronPort<'setServerUrl'>
/** Checking a typed address: main contacts that server, so what the member typed leaves the computer. */
export type ServerUrlOutbound = ElectronPort<'validateServerUrl'>

/** Signing in: the email and password are sent to the company server. */
export type SignInOutbound = ElectronPort<'signIn'>
/** Signing up: the email, password and name are sent and the server creates an account. */
export type SignUpOutbound = ElectronPort<'signUp'>
/**
 * Who is signed in: main asks the company server with the stored session and
 * sends nothing of the member's but who they are (then resumes sending the
 * activity records already waiting for that account).
 */
export type SessionReads = ElectronPort<'getSession'>
/**
 * Signing out: main tells the company server to end the session, then
 * forgets it on this computer even when the server cannot be reached.
 */
export type SignOutOutbound = ElectronPort<'signOut'>

export function getServerUrl(reads: ServerUrlReads = window.electronAPI) {
  return reads.getServerUrl()
}

export function setServerUrl(url: string, writes: ServerUrlWrites = window.electronAPI) {
  return writes.setServerUrl(url)
}

export function validateServerUrl(url: string, outbound: ServerUrlOutbound = window.electronAPI) {
  return outbound.validateServerUrl(url)
}

export function signIn(email: string, password: string, outbound: SignInOutbound = window.electronAPI) {
  return outbound.signIn(email, password)
}

export function signUp(email: string, password: string, name?: string, outbound: SignUpOutbound = window.electronAPI) {
  return outbound.signUp(email, password, name)
}

export function getSession(reads: SessionReads = window.electronAPI) {
  return reads.getSession()
}

export function signOut(outbound: SignOutOutbound = window.electronAPI) {
  return outbound.signOut()
}
