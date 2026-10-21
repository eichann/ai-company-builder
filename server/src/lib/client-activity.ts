/**
 * Per-member record of which desktop-app build they last used and when they
 * last talked to / fetched from / pushed to a company (table client_activity).
 *
 * Two consumers:
 * - the admin panel ("last successful sync" per member — a member's sync can
 *   fail silently for weeks without anyone noticing);
 * - the permission system, which must know every active member runs a build
 *   new enough to understand an operation before allowing it
 *   (activeMembersBuildCheck).
 *
 * Sources of a record:
 * - API requests under a company (/api/companies/:id/..., /api/git/repos/:id)
 *   that carry X-ACB-Client-Version: build, platform, last_seen_at. API
 *   requests WITHOUT the header (old apps, the admin panel in a browser) record
 *   nothing, so an owner using the admin panel never blanks their app build.
 * - Every authorized git-http request: build, platform, last_seen_at. Here a
 *   missing header is recorded as unknown (NULL): only git clients reach that
 *   route, and a client that does not identify itself must not keep a build
 *   recorded earlier by another of that user's devices.
 *   + upload-pack (advertisement or negotiation) that the CGI completed:
 *     last_fetch_at.
 *   + receive-pack whose report-status accepted every ref: last_push_at.
 *
 * Writes are throttled per (kind, user, company) to one per THROTTLE_MS unless
 * the reported build/platform changed, so a sync storm costs at most a few
 * SQLite writes per member per minute.
 */
import { db, now } from '../db'
import { compareClientVersions, parseClientVersion, type ParsedClientVersion } from './client-version'

export const CLIENT_VERSION_HEADER = 'X-ACB-Client-Version'
export const CLIENT_PLATFORM_HEADER = 'X-ACB-Client-Platform'

export const THROTTLE_MS = 60_000

/** seen: any identified request; fetch: upload-pack completed; push: push accepted. */
export type ActivityKind = 'seen' | 'fetch' | 'push'

export interface ClientActivityRow {
  user_id: string
  company_id: string
  client_version: string | null
  client_platform: string | null
  last_seen_at: string | null
  last_fetch_at: string | null
  last_push_at: string | null
  updated_at: string
}

/**
 * Header values are client-controlled: keep them short and printable. Returns
 * null for absent/empty values.
 */
export function sanitizeClientHeader(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max)
  return cleaned || null
}

export function clientIdentityFromHeaders(header: (name: string) => string | undefined): { version: string | null; platform: string | null } {
  return {
    version: sanitizeClientHeader(header(CLIENT_VERSION_HEADER), 128),
    platform: sanitizeClientHeader(header(CLIENT_PLATFORM_HEADER), 64),
  }
}

const lastWrites = new Map<string, { at: number; version: string | null; platform: string | null }>()

/** Test hook: forget throttle state. */
export function resetClientActivityThrottle(): void {
  lastWrites.clear()
}

/**
 * Record activity. Returns true when a row was written, false when throttled.
 * Never throws: tracking must not break the request it observes.
 */
export function recordClientActivity(input: {
  userId: string
  companyId: string
  kind: ActivityKind
  version: string | null
  platform: string | null
  nowMs?: number
}): boolean {
  const { userId, companyId, kind, version, platform } = input
  const nowMs = input.nowMs ?? Date.now()
  const key = `${kind}\u0000${userId}\u0000${companyId}`
  const prev = lastWrites.get(key)
  if (prev && nowMs - prev.at < THROTTLE_MS && prev.version === version && prev.platform === platform) {
    return false
  }
  try {
    const at = input.nowMs !== undefined ? new Date(nowMs).toISOString() : now()
    db.prepare(`
      INSERT INTO client_activity (
        user_id, company_id, client_version, client_platform,
        last_seen_at, last_fetch_at, last_push_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, company_id) DO UPDATE SET
        client_version = excluded.client_version,
        client_platform = excluded.client_platform,
        last_seen_at = excluded.last_seen_at,
        last_fetch_at = COALESCE(excluded.last_fetch_at, client_activity.last_fetch_at),
        last_push_at = COALESCE(excluded.last_push_at, client_activity.last_push_at),
        updated_at = excluded.updated_at
    `).run(
      userId, companyId, version, platform,
      at,
      kind === 'fetch' ? at : null,
      kind === 'push' ? at : null,
      at,
    )
    lastWrites.set(key, { at: nowMs, version, platform })
    return true
  } catch (err) {
    console.error('[client-activity] Failed to record activity:', err)
    return false
  }
}

export function getClientActivityForCompany(companyId: string): Map<string, ClientActivityRow> {
  const rows = db.prepare('SELECT * FROM client_activity WHERE company_id = ?').all(companyId) as ClientActivityRow[]
  return new Map(rows.map(r => [r.user_id, r]))
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
export function activeMembersBuildCheck(
  companyId: string,
  minimum: string,
  options: { activeWithinDays?: number; now?: Date } = {},
): ActiveMembersBuildCheck {
  const min: ParsedClientVersion | null = parseClientVersion(minimum)
  if (!min) throw new Error(`Invalid minimum client version: ${minimum}`)
  const days = options.activeWithinDays ?? 14
  const nowDate = options.now ?? new Date()
  const activeSince = new Date(nowDate.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  const members = db.prepare('SELECT user_id, role FROM memberships WHERE company_id = ?')
    .all(companyId) as Array<{ user_id: string; role: string }>
  const activity = getClientActivityForCompany(companyId)

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

/** Boolean shorthand for activeMembersBuildCheck(...).ok. */
export function areActiveMembersOnBuild(
  companyId: string,
  minimum: string,
  options: { activeWithinDays?: number; now?: Date } = {},
): boolean {
  return activeMembersBuildCheck(companyId, minimum, options).ok
}

// ----------------------------------------------------------------------------
// receive-pack result
// ----------------------------------------------------------------------------

/** Split a pkt-line stream into payloads (flush/delim packets skipped). */
function pktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('latin1')
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
    const len = parseInt(hex, 16)
    if (len < 4) { pos += 4; continue } // 0000 flush, 0001 delim, 0002 response-end
    if (pos + len > buf.length) break
    out.push(buf.subarray(pos + 4, pos + len))
    pos += len
  }
  return out
}

/**
 * Did a receive-pack response report every ref as accepted?
 *
 * The body is git's report-status: `unpack ok`, then `ok <ref>` or
 * `ng <ref> <reason>` per ref — wrapped in side-band channel 1 when the client
 * negotiated side-band(-64k), which git always does. A pre-receive rejection
 * (secret scan, protected config, ...) or a non-fast-forward shows up as `ng`;
 * a failed unpack as `unpack <error>`. Returns false when no report is found
 * (e.g. a client that did not ask for report-status): unproven is not success.
 */
export function receivePackSucceeded(body: Buffer): boolean {
  const outer = pktLines(body)
  const lines: string[] = []
  const band1: Buffer[] = []
  for (const p of outer) {
    if (p.length > 0 && p[0] === 1) band1.push(p.subarray(1))
    else if (p.length > 0 && p[0] > 3) lines.push(p.toString('utf8'))
  }
  if (band1.length > 0) {
    for (const p of pktLines(Buffer.concat(band1))) lines.push(p.toString('utf8'))
  }
  let unpackOk = false
  let ok = 0
  let ng = 0
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '')
    if (line.startsWith('unpack ')) unpackOk = line === 'unpack ok'
    else if (line.startsWith('ok ')) ok++
    else if (line.startsWith('ng ')) ng++
  }
  return unpackOk && ok > 0 && ng === 0
}
