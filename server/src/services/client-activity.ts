/**
 * Which desktop-app build each member last used and when they last talked to /
 * fetched from / pushed to a company (lib/client-activity.ts explains the
 * sources). Recording is throttled per (kind, user, company) to one write per
 * THROTTLE_MS unless the reported build/platform changed, so a sync storm
 * costs at most a few SQLite writes per member per minute.
 */
import type { Clock } from '../ports/clock'
import type { ActivityKind, ClientActivityRepository } from '../ports/client-activity'
import type { MembershipRepository } from '../ports/memberships'
import { compareClientVersions, parseClientVersion, type ParsedClientVersion } from '../lib/client-version'

export const THROTTLE_MS = 60_000

export interface ActivityInput {
  userId: string
  companyId: string
  kind: ActivityKind
  version: string | null
  platform: string | null
  /** The instant to record (tests); the clock's otherwise. */
  nowMs?: number
}

function latest(...values: Array<string | null>): string | null {
  let best: string | null = null
  for (const v of values) if (v && (!best || v > best)) best = v
  return best
}

export interface MemberBuildStatus {
  userId: string
  role: string
  clientVersion: string | null
  clientPlatform: string | null
  /** Most recent of last_seen_at / last_fetch_at / last_push_at. */
  lastActiveAt: string | null
}

export interface ActiveMembersBuildCheck {
  /** True when no active member is outdated or on an unknown build. */
  ok: boolean
  minimum: string
  /** Members active at or after this instant count as active. */
  activeSince: string
  /** Active, on a parseable build older than `minimum`. */
  outdated: MemberBuildStatus[]
  /** Active, but the build is unknown (no header, or unparseable). Blocks. */
  unknown: MemberBuildStatus[]
  /** Active and on `minimum` or newer. */
  current: MemberBuildStatus[]
  /**
   * Members with no activity within the window (including never recorded).
   * They do NOT block: someone who has not synced for N days is treated as
   * inactive. Note that right after this table was introduced every member is
   * "never recorded"; a caller gating a dangerous operation should not rely on
   * this check until tracking has run for at least `activeWithinDays`.
   */
  inactive: MemberBuildStatus[]
}

export interface BuildCheckOptions {
  activeWithinDays?: number
  now?: Date
}

export function createClientActivityService(deps: {
  clientActivity: ClientActivityRepository
  memberships: MembershipRepository
  clock: Clock
}) {
  const { clientActivity, memberships, clock } = deps
  const lastWrites = new Map<string, { at: number; version: string | null; platform: string | null }>()

  /**
   * Are all active members of `companyId` on build `minimum` or newer?
   *
   * "Active" = any recorded activity (API, fetch or push) within the last
   * `activeWithinDays` days. Only current members count (removed members' rows
   * are ignored). Builds compare per compareClientVersions in client-version.ts
   * (semver first, commit date as tiebreak). Fails closed: an active member whose
   * build is unknown makes `ok` false.
   *
   * Limitation: rows are keyed by user + company, so a member with two devices is
   * represented by whichever device was heard from last.
   */
  function activeMembersBuildCheck(companyId: string, minimum: string, options: BuildCheckOptions = {}): ActiveMembersBuildCheck {
    const min: ParsedClientVersion | null = parseClientVersion(minimum)
    if (!min) throw new Error(`Invalid minimum client version: ${minimum}`)
    const days = options.activeWithinDays ?? 14
    const nowDate = options.now ?? new Date(clock.nowMs())
    const activeSince = new Date(nowDate.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

    const members = memberships.listByCompany(companyId)
    const activity = clientActivity.forCompany(companyId)

    const result: ActiveMembersBuildCheck = {
      ok: true, minimum, activeSince, outdated: [], unknown: [], current: [], inactive: [],
    }
    for (const m of members) {
      const row = activity.get(m.user_id)
      const status: MemberBuildStatus = {
        userId: m.user_id,
        role: m.role,
        clientVersion: row?.client_version ?? null,
        clientPlatform: row?.client_platform ?? null,
        lastActiveAt: row ? latest(row.last_seen_at, row.last_fetch_at, row.last_push_at) : null,
      }
      if (!status.lastActiveAt || status.lastActiveAt < activeSince) {
        result.inactive.push(status)
        continue
      }
      const parsed = parseClientVersion(status.clientVersion)
      if (!parsed) result.unknown.push(status)
      else if (compareClientVersions(parsed, min) < 0) result.outdated.push(status)
      else result.current.push(status)
    }
    result.ok = result.outdated.length === 0 && result.unknown.length === 0
    return result
  }

  return {
    /**
     * Record activity. Returns true when a row was written, false when throttled.
     * Never throws: tracking must not break the request it observes.
     */
    record(input: ActivityInput): boolean {
      const { userId, companyId, kind, version, platform } = input
      const nowMs = input.nowMs ?? clock.nowMs()
      const key = `${kind}\u0000${userId}\u0000${companyId}`
      const prev = lastWrites.get(key)
      if (prev && nowMs - prev.at < THROTTLE_MS && prev.version === version && prev.platform === platform) {
        return false
      }
      try {
        const at = input.nowMs !== undefined ? new Date(nowMs).toISOString() : clock.now()
        clientActivity.record({ userId, companyId, kind, version, platform, at })
        lastWrites.set(key, { at: nowMs, version, platform })
        return true
      } catch (err) {
        console.error('[client-activity] Failed to record activity:', err)
        return false
      }
    },

    /** Test hook: forget throttle state. */
    resetThrottleForTests(): void {
      lastWrites.clear()
    },

    activeMembersBuildCheck,

    /** Boolean shorthand for activeMembersBuildCheck(...).ok. */
    areActiveMembersOnBuild(companyId: string, minimum: string, options: BuildCheckOptions = {}): boolean {
      return activeMembersBuildCheck(companyId, minimum, options).ok
    },
  }
}

export type ClientActivityService = ReturnType<typeof createClientActivityService>
