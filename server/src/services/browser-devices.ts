/**
 * The PCs used for 「ブラウザ操作」 (agent-browser.md "This PC's registration"; design memo 「ブラウザ操作を担当者の PC で使う」 v2
 * §3–§8, §14-1). The server decides **from which PC** a plan's steps may come:
 *
 * - **Registering** (a person's session + the PC's key header): the member asks (`pending`); an owner / admin presses once
 *   (`enabled`; their own PC too, no further check — owner decision 2026-11-24); an owner / admin or the member stops it
 *   (`revoked`, final); leaving the company stops every registration of the person in the removal's transaction.
 *   Registering again after a stop is a new registration (a new id). The key itself is never stored: only its sha256.
 * - **The gate** (`check`, asked first by the plan services' own gate at every step they gate: making a plan, approving,
 *   claiming, every permit, on the old path and on the opened lines): an `enabled` registration of this member for the
 *   key in this company, and for a plan, the registration that made it (`BROWSER_DEVICE_ELSEWHERE` otherwise: another PC
 *   can only 「やめる」, which is not gated). The transition exception (`BROWSER_DEVICE_OWNER_TRANSITION`): no header at all
 *   → an owner passes with no registration. The rule itself is the core's `browserDeviceDecision`.
 * - Clean-up never asks it (reports, confirms, cancels, the lists): a stopped PC never keeps a plan from settling.
 */
import {
  BROWSER_DEVICE_LIMITS, BROWSER_DEVICE_WORDS, browserDeviceDecision, normalizeBrowserDeviceLabel, parseBrowserDeviceKey,
  type BrowserDeviceRefusal,
} from '../../shared/core/browser-device'
import type { BrowserDeviceMine, BrowserDevicesList, BrowserDeviceView } from '../../shared/types/browser-devices'
import type { AccountDirectory } from '../ports/accounts'
import type { BrowserDeviceRepository, BrowserDeviceRow, BrowserPlanPath } from '../ports/browser-devices'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { TokenDigest } from '../ports/key-broker'
import type { Transactions } from '../ports/transactions'
import { hasFullAccess, type Member } from './access'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface BrowserDeviceDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  tokenDigest: TokenDigest
  accounts: Pick<AccountDirectory, 'byIds'>
}

/** The plan services' view of the gate (injected; they never see a key's hash or a registration row). */
export interface BrowserDeviceGate {
  /**
   * The device check of one gated step: `plan` null when the step makes the plan, else the plan whose registration must
   * be the one the request comes from. Answers the registration (null under the transition exception) or the refusal.
   */
  check(member: Member, deviceKey: string | undefined, plan: { path: BrowserPlanPath; planId: string } | null): Outcome<{ deviceId: string | null }>
  /** Bind a plan just made to the registration that made it (inside the caller's transaction; nothing for none). */
  bind(member: Member, path: BrowserPlanPath, planId: string, deviceId: string | null): void
}

const W = BROWSER_DEVICE_WORDS
const DEVICE_ID_RE = /^bd_[0-9a-f]{32}$/
/** Registrations listed for owners / admins (newest first; `more` says older ones exist). */
export const BROWSER_DEVICE_LIST_LIMIT = 500
export const BROWSER_DEVICE_HISTORY_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const iso = (ms: number) => new Date(ms).toISOString()

const view = (d: BrowserDeviceRow): BrowserDeviceView => ({
  id: d.id, userId: d.userId, label: d.label, state: d.state, revokeReason: d.revokeReason, requestedAt: d.requestedAt,
  enabledAt: d.enabledAt, enabledBy: d.enabledBy, revokedAt: d.revokedAt, revokedBy: d.revokedBy, lastUsedAt: d.lastUsedAt,
})

const STATUS: Record<BrowserDeviceRefusal, 'forbidden' | 'conflict'> = {
  BROWSER_DEVICE_NOT_REGISTERED: 'forbidden',
  BROWSER_DEVICE_PENDING: 'forbidden',
  BROWSER_DEVICE_REVOKED: 'forbidden',
  BROWSER_DEVICE_ELSEWHERE: 'conflict',
}

export function createBrowserDeviceService(deps: BrowserDeviceDeps) {
  const { companyData, transactions, clock, ids, tokenDigest } = deps
  const repo = (companyId: string): BrowserDeviceRepository => companyData.forCompany(companyId).browserDevices
  /** The stored form of a key: its sha256, never the key. */
  const keyHash = (key: string) => tokenDigest.digest(key)
  const badKey = (): Refusal => refuse('bad-request', W.badKey, { code: 'BROWSER_DEVICE_BAD_KEY' })
  const missing = (): Refusal => refuse('not-found', W.notFound, { code: 'BROWSER_DEVICE_NOT_FOUND' })
  const forbidden = (): Refusal => refuse('forbidden', W.manageForbidden)

  function history(companyId: string, d: BrowserDeviceRow, actorId: string, action: 'request' | 'enable' | 'revoke', at: string) {
    repo(companyId).appendHistory({ id: ids.newId(), deviceId: d.id, userId: d.userId, actorId, action, reason: action === 'revoke' ? (repo(companyId).byId(d.id)?.revokeReason ?? null) : null, at })
  }

  const gate: BrowserDeviceGate = {
    check(member, deviceKey, plan) {
      const key = deviceKey === undefined ? null : parseBrowserDeviceKey(deviceKey)
      const r = repo(member.companyId)
      const registration = key ? r.forKey(member.userId, keyHash(key)) : null
      const decision = browserDeviceDecision({
        key: deviceKey === undefined ? 'absent' : key ? 'present' : 'malformed',
        registration,
        role: member.role,
        plan: plan ? { boundTo: r.planDevice(plan.path, plan.planId) } : null,
      })
      if (!decision.ok) return refuse(STATUS[decision.code], W.refusals[decision.code], { code: decision.code })
      if (decision.deviceId) {
        const now = clock.nowMs()
        r.touch(decision.deviceId, iso(now), iso(now - DAY_MS))
      }
      return ok({ deviceId: decision.deviceId })
    },
    bind(member, path, planId, deviceId) {
      if (deviceId) repo(member.companyId).bindPlan(path, planId, deviceId, iso(clock.nowMs()))
    },
  }

  return {
    gate,

    /**
     * POST /browser-devices { label } with the PC's key header: this member registers this PC (`pending`). A second ask
     * for a PC already registered (pending or enabled) answers that registration; after a stop it is a new one.
     */
    register(member: Member, deviceKey: string | undefined, body: unknown): Outcome<{ created: boolean; device: BrowserDeviceMine }> {
      const key = parseBrowserDeviceKey(deviceKey)
      if (!key) return badKey()
      const label = isMap(body) && Object.keys(body).length === 1 ? normalizeBrowserDeviceLabel(body.label) : null
      if (!label) return refuse('bad-request', W.badLabel, { code: 'BROWSER_DEVICE_BAD_LABEL' })
      return transactions.run(() => {
        const r = repo(member.companyId)
        const found = r.forKey(member.userId, keyHash(key))
        if (found && found.state !== 'revoked') return ok({ created: false, device: view(found) })
        if (r.liveCountOf(member.userId) >= BROWSER_DEVICE_LIMITS.livePerMember) return refuse('conflict', W.tooMany, { code: 'BROWSER_DEVICE_LIMIT' })
        const at = iso(clock.nowMs())
        const row: BrowserDeviceRow = {
          id: `bd_${ids.newToken().slice(0, 32)}`, userId: member.userId, keyHash: keyHash(key), label, state: 'pending', revokeReason: null,
          requestedAt: at, enabledAt: null, enabledBy: null, revokedAt: null, revokedBy: null, lastUsedAt: null,
        }
        r.insert(row)
        history(member.companyId, row, member.userId, 'request', at)
        return ok({ created: true, device: view(row) })
      })
    },

    /** GET /browser-devices-me with the PC's key header: this member's registration of this PC (or `none`). */
    mine(member: Member, deviceKey: string | undefined): Outcome<BrowserDeviceMine> {
      const key = parseBrowserDeviceKey(deviceKey)
      if (!key) return badKey()
      const found = repo(member.companyId).forKey(member.userId, keyHash(key))
      return ok(found ? view(found) : { state: 'none' })
    },

    /** DELETE /browser-devices-me with the PC's key header: 取り下げる / この PC での利用をやめる (stopped, `self`). */
    withdraw(member: Member, deviceKey: string | undefined): Outcome<BrowserDeviceMine> {
      const key = parseBrowserDeviceKey(deviceKey)
      if (!key) return badKey()
      return transactions.run(() => {
        const r = repo(member.companyId)
        const found = r.forKey(member.userId, keyHash(key))
        if (!found) return missing()
        if (found.state === 'revoked') return ok(view(found))
        const at = iso(clock.nowMs())
        if (!r.revoke(found.id, found.state, 'self', member.userId, at)) return refuse('conflict', W.stateChanged, { code: 'BROWSER_DEVICE_STATE_CHANGED' })
        history(member.companyId, found, member.userId, 'revoke', at)
        return ok(view(r.byId(found.id) as BrowserDeviceRow))
      })
    },

    /** GET /browser-devices (owner/admin): the company's registrations, newest first, with names, and the history. */
    list(member: Member): Outcome<BrowserDevicesList> {
      if (!hasFullAccess(member.role)) return forbidden()
      const r = repo(member.companyId)
      const rows = r.list(BROWSER_DEVICE_LIST_LIMIT + 1)
      const shown = rows.slice(0, BROWSER_DEVICE_LIST_LIMIT)
      const people = deps.accounts.byIds([...new Set(shown.map(d => d.userId))])
      return ok({
        items: shown.map(d => ({ ...view(d), name: people.get(d.userId)?.name ?? null })),
        more: rows.length > BROWSER_DEVICE_LIST_LIMIT,
        history: r.history(BROWSER_DEVICE_HISTORY_LIMIT).map(h => ({ deviceId: h.deviceId, userId: h.userId, actorId: h.actorId, action: h.action, reason: h.reason, at: h.at })),
      })
    },

    /** POST /browser-devices/:deviceId/enable (owner/admin): 使えるようにする, from `pending` only. */
    enable(member: Member, deviceId: string): Outcome<BrowserDeviceView> {
      if (!hasFullAccess(member.role)) return forbidden()
      if (!DEVICE_ID_RE.test(deviceId)) return missing()
      return transactions.run(() => {
        const r = repo(member.companyId)
        const found = r.byId(deviceId)
        if (!found) return missing()
        const at = iso(clock.nowMs())
        if (found.state !== 'pending' || !r.enable(found.id, member.userId, at)) return refuse('conflict', W.stateChanged, { code: 'BROWSER_DEVICE_STATE_CHANGED', state: found.state })
        history(member.companyId, found, member.userId, 'enable', at)
        return ok(view(r.byId(found.id) as BrowserDeviceRow))
      })
    },

    /** POST /browser-devices/:deviceId/revoke (owner/admin): 止める. A stopped one stays as it is. */
    revoke(member: Member, deviceId: string): Outcome<BrowserDeviceView> {
      if (!hasFullAccess(member.role)) return forbidden()
      if (!DEVICE_ID_RE.test(deviceId)) return missing()
      return transactions.run(() => {
        const r = repo(member.companyId)
        const found = r.byId(deviceId)
        if (!found) return missing()
        if (found.state === 'revoked') return ok(view(found))
        const at = iso(clock.nowMs())
        if (!r.revoke(found.id, found.state, 'admin', member.userId, at)) return refuse('conflict', W.stateChanged, { code: 'BROWSER_DEVICE_STATE_CHANGED' })
        history(member.companyId, found, member.userId, 'revoke', at)
        return ok(view(r.byId(found.id) as BrowserDeviceRow))
      })
    },

    /** In removeMember's transaction: every registration of the person not stopped yet is stopped (`left`). */
    memberLeft(companyId: string, userId: string, actorId: string): void {
      const r = repo(companyId)
      const at = iso(clock.nowMs())
      for (const id of r.revokeAllOf(userId, 'left', actorId, at)) {
        const d = r.byId(id)
        if (d) history(companyId, d, actorId, 'revoke', at)
      }
    },
  }
}

export type BrowserDeviceService = ReturnType<typeof createBrowserDeviceService>
