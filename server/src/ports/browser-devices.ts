/**
 * One company's PCs used for 「ブラウザ操作」 (agent-browser.md "This PC's registration"): registrations, their history and
 * the registration each plan was made on — from its handle (`CompanyData`), every method limited to that company. State
 * changes are compare-and-set (true when the row changed). Rules: services/browser-devices.ts. Nothing here holds the
 * PC's key: only its sha256 (`keyHash`).
 */
import type { BrowserDeviceRevokeReason, BrowserDeviceState } from '../../shared/core/browser-device'

export interface BrowserDeviceRow {
  id: string
  userId: string
  keyHash: string
  label: string
  state: BrowserDeviceState
  revokeReason: BrowserDeviceRevokeReason | null
  requestedAt: string
  enabledAt: string | null
  enabledBy: string | null
  revokedAt: string | null
  revokedBy: string | null
  lastUsedAt: string | null
}

export interface BrowserDeviceHistoryRow {
  id: string
  deviceId: string
  userId: string
  actorId: string
  action: 'request' | 'enable' | 'revoke'
  reason: BrowserDeviceRevokeReason | null
  at: string
}

/** Which path a plan belongs to: the old one (`browser_plans`) or the opened lines (`browser_line_plans`). */
export type BrowserPlanPath = 'type' | 'line'

export interface BrowserDeviceRepository {
  insert(row: BrowserDeviceRow): void
  byId(id: string): BrowserDeviceRow | null
  /** This member's registration for this key hash: the one not stopped, else the newest stopped one, else null. */
  forKey(userId: string, keyHash: string): BrowserDeviceRow | null
  /** How many of this member's registrations are not stopped. */
  liveCountOf(userId: string): number
  /** The newest registrations first, at most `limit`. */
  list(limit: number): BrowserDeviceRow[]
  /** pending → enabled (compare-and-set). */
  enable(id: string, by: string, at: string): boolean
  /** `from` → revoked (compare-and-set; `from` is pending or enabled). */
  revoke(id: string, from: 'pending' | 'enabled', reason: BrowserDeviceRevokeReason, by: string, at: string): boolean
  /** Every registration of this member not stopped yet → revoked; the ids it stopped. */
  revokeAllOf(userId: string, reason: BrowserDeviceRevokeReason, by: string, at: string): string[]
  /** Note a use: `last_used_at` set when it is empty or older than `staleBefore` (at most once a day). */
  touch(id: string, at: string, staleBefore: string): void
  appendHistory(row: BrowserDeviceHistoryRow): void
  /** Newest first, at most `limit`. */
  history(limit: number): BrowserDeviceHistoryRow[]
  /** Bind a plan to the registration that made it (once; a plan made with none has no row). */
  bindPlan(path: BrowserPlanPath, planId: string, deviceId: string, at: string): void
  /** The registration a plan was made on, or null (made with none). */
  planDevice(path: BrowserPlanPath, planId: string): string | null
}
