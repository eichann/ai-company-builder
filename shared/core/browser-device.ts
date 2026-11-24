/**
 * 「ブラウザ操作」 on a member's own PC: the words of a PC's registration (design memo 「ブラウザ操作を担当者の PC で使う」
 * v2, §3–§5, §14-1; agent-browser.md "This PC's registration"). Pure: the server, the app and the admin console read
 * this one copy.
 *
 * - A PC is registered per company × member × PC: the member asks (`pending`), an owner / admin presses once
 *   (`enabled`), an owner / admin, the member or leaving the company stops it (`revoked`, final). Registering again is a
 *   new registration (a new id); a plan made on the old one never moves again.
 * - **The PC's key**: 32 random bytes the app keeps on the PC; it sends `X-ACB-Browser-Device: v1.<base64url>`. The
 *   server keeps only a hash of it. The key never reaches the AI, the screen, a log or the company folder.
 * - **The gate** (`browserDeviceDecision`): every step of a plan that the server gates (making a plan, approving,
 *   claiming, each permit, on the old and the new path) needs an `enabled` registration of that member for that key,
 *   and a plan goes on only on the registration that made it. During the transition (§10) a request **without** the
 *   header passes for an owner only (`BROWSER_DEVICE_OWNER_TRANSITION`): the owner's PC keeps working on its hand-placed
 *   file until the app that sends the header is everywhere; D5 sets the constant to false.
 */

/** The header carrying the PC's key (never a URL: it would reach logs). */
export const BROWSER_DEVICE_HEADER = 'X-ACB-Browser-Device'

/**
 * `v1.` + the 32 bytes in unpadded base64url (43 characters). The last character carries 2 unused bits, which must be
 * zero, so every key has exactly one spelling (two spellings of one key would hash apart).
 */
const KEY_RE = /^v1\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

/** The header's value when it is exactly one well-formed key, else null. */
export function parseBrowserDeviceKey(value: unknown): string | null {
  return typeof value === 'string' && KEY_RE.test(value) ? value : null
}

/**
 * The transition exception (§10, owner decision 2026-11-24, question 1): a request without the header passes the gate
 * for an owner only (never an admin or a member). Set to false by D5, once the app that sends the header has reached
 * every PC and the owner's PC is registered.
 */
export const BROWSER_DEVICE_OWNER_TRANSITION = true

export const BROWSER_DEVICE_STATES = ['pending', 'enabled', 'revoked'] as const
export type BrowserDeviceState = typeof BROWSER_DEVICE_STATES[number]

/** Why a registration was stopped (more words may be added: `idle` when an expiry comes, §14-3). */
export const BROWSER_DEVICE_REVOKE_REASONS = ['admin', 'self', 'left'] as const
export type BrowserDeviceRevokeReason = typeof BROWSER_DEVICE_REVOKE_REASONS[number]

/** The moves a registration may make; `revoked` is final (registering again makes a new one). */
export function browserDeviceMoveAllowed(from: BrowserDeviceState, to: BrowserDeviceState): boolean {
  return (from === 'pending' && (to === 'enabled' || to === 'revoked')) || (from === 'enabled' && to === 'revoked')
}

export const BROWSER_DEVICE_LIMITS = {
  /** A PC's name (the Mac's name at first; the member may change it before registering). */
  label: 60,
  /** Registrations not stopped, per member and company (pending or enabled). */
  livePerMember: 10,
} as const

const LABEL_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/

/** The PC's name as kept (NFC, trimmed), or null when it is empty, too long or holds a control / direction character. */
export function normalizeBrowserDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.normalize('NFC').trim()
  if (label.length === 0 || label.length > BROWSER_DEVICE_LIMITS.label || LABEL_UNSAFE_RE.test(label)) return null
  return label
}

export const BROWSER_DEVICE_REFUSALS = ['BROWSER_DEVICE_NOT_REGISTERED', 'BROWSER_DEVICE_PENDING', 'BROWSER_DEVICE_REVOKED', 'BROWSER_DEVICE_ELSEWHERE'] as const
export type BrowserDeviceRefusal = typeof BROWSER_DEVICE_REFUSALS[number]

/** What people see (plain Japanese: 「PC」, never 「デバイス」). Released apps show a refusal's `error` as is. */
export const BROWSER_DEVICE_WORDS = {
  states: { pending: '確認待ち', enabled: '使える', revoked: '止めた' } satisfies Record<BrowserDeviceState, string>,
  refusals: {
    BROWSER_DEVICE_NOT_REGISTERED: 'この PC は、ブラウザ操作に使う PC として登録されていません。設定 › ブラウザ操作 から登録できます',
    BROWSER_DEVICE_PENDING: 'この PC は、管理者の確認を待っています。管理者に「登録しました」と伝えてください',
    BROWSER_DEVICE_REVOKED: 'この PC でのブラウザ操作は止まっています。もう一度使うには、登録し直してください',
    BROWSER_DEVICE_ELSEWHERE: '別の PC で作った計画です。その PC で開いてください（ここでは［やめる］だけできます）',
  } satisfies Record<BrowserDeviceRefusal, string>,
  badKey: 'この PC の印が正しくありません。アプリを新しくしてください',
  badLabel: 'PC の名前を 60 文字までで入れてください',
  tooMany: '登録できる PC の数を超えています。使わない PC の登録をやめてから、もう一度登録してください',
  notFound: 'PC の登録が見つかりません',
  stateChanged: '状態が変わりました。画面を開き直してください',
  manageForbidden: 'ブラウザ操作に使う PC を確かめられるのは、オーナーと管理者だけです',
} as const

/**
 * The gate's one rule (§4 I1, I5, I8). `key`: whether the request carried the header, and whether it was a well-formed
 * key. `registration`: this member's registration for that key in this company — the one not stopped, else the newest
 * stopped one, else none. `plan`: the step's plan and the registration it was made on (`null` when made under the
 * transition exception or before this rule), or null when the step makes the plan.
 */
export function browserDeviceDecision(input: {
  key: 'absent' | 'malformed' | 'present'
  registration: { id: string; state: BrowserDeviceState } | null
  role: string
  plan: { boundTo: string | null } | null
  ownerTransition?: boolean
}): { ok: true; deviceId: string | null } | { ok: false; code: BrowserDeviceRefusal } {
  let deviceId: string | null
  if (input.key === 'absent') {
    if (!(input.ownerTransition ?? BROWSER_DEVICE_OWNER_TRANSITION) || input.role !== 'owner') return { ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' }
    deviceId = null
  } else if (input.key === 'malformed' || !input.registration) {
    return { ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' }
  } else if (input.registration.state === 'pending') {
    return { ok: false, code: 'BROWSER_DEVICE_PENDING' }
  } else if (input.registration.state !== 'enabled') {
    return { ok: false, code: 'BROWSER_DEVICE_REVOKED' }
  } else {
    deviceId = input.registration.id
  }
  // A plan goes on only on the registration that made it (another PC, or this PC registered again: only 「やめる」).
  if (input.plan && input.plan.boundTo !== deviceId) return { ok: false, code: 'BROWSER_DEVICE_ELSEWHERE' }
  return { ok: true, deviceId }
}
