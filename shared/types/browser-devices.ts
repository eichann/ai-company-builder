/**
 * API shapes of the PCs used for 「ブラウザ操作」 (agent-browser.md "This PC's registration"; design memo 「ブラウザ操作を担当者の
 * PC で使う」 v2 §8-1). Read by the app (this PC's state, D4) and the admin console (the PCs page, PR A). No shape holds
 * the PC's key or its hash.
 */
import type { BrowserDeviceRevokeReason, BrowserDeviceState } from '../core/browser-device'

export type { BrowserDeviceRevokeReason, BrowserDeviceState }

/** One registration (company × member × PC). */
export interface BrowserDeviceView {
  id: string
  userId: string
  label: string
  state: BrowserDeviceState
  revokeReason: BrowserDeviceRevokeReason | null
  requestedAt: string
  enabledAt: string | null
  enabledBy: string | null
  revokedAt: string | null
  revokedBy: string | null
  /** The last day a gated step passed on it (updated at most once a day). */
  lastUsedAt: string | null
}

/** GET / DELETE /browser-devices-me, POST /browser-devices: this PC's registration for the signed-in member, if any. */
export type BrowserDeviceMine = { state: 'none' } | (BrowserDeviceView & { created?: boolean })

/** GET /browser-devices (owner/admin): every registration of the company, newest first, and the history. */
export interface BrowserDevicesList {
  items: Array<BrowserDeviceView & { name: string | null }>
  /** True when older registrations exist beyond the list. */
  more: boolean
  /** Who changed which registration, newest first (at most `BROWSER_DEVICE_HISTORY_LIMIT`). */
  history: Array<{
    deviceId: string
    userId: string
    actorId: string
    action: 'request' | 'enable' | 'revoke'
    reason: BrowserDeviceRevokeReason | null
    at: string
  }>
}

/** GET /browser-lines-mine: the approved opened lines the member holds a grant in force for (names only). */
export interface BrowserLinesMine {
  lines: Array<{ site: string; line: string; version: string; mapVersion: string; meaningHash: string; mechanicsHash: string; label: string; writes: boolean }>
}
