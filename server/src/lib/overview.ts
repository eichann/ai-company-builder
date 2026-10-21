/**
 * "Needs attention" lists for the admin panel's company overview.
 *
 * Pure: takes members with their client_activity, returns the lists.
 *
 * - recent:            any activity (seen / fetch / push) in the last 30 days.
 *                      Only recent members are judged — someone who has not
 *                      opened the app for a month is not "outdated".
 * - outdatedClients:   recent, on a parseable build older than the newest
 *                      build any recent member runs (compareClientVersions).
 * - unknownClients:    recent, but the build is unknown (old app without the
 *                      X-ACB-Client-Version header, or unparseable).
 * - notSyncedRecently: recent, but no successful fetch or push in 7 days —
 *                      the app is being opened while sync keeps failing.
 */
import { compareClientVersions, parseClientVersion, type ParsedClientVersion } from './client-version'

export const RECENT_DAYS = 30
export const SYNC_STALE_DAYS = 7

export interface OverviewMember {
  userId: string
  name: string | null
  email: string | null
  role: string
  clientVersion: string | null
  lastSeenAt: string | null
  lastFetchAt: string | null
  lastPushAt: string | null
}

export interface OverviewAttention {
  outdatedClients: OverviewMember[]
  unknownClients: OverviewMember[]
  notSyncedRecently: OverviewMember[]
}

function latest(...values: Array<string | null>): string | null {
  let best: string | null = null
  for (const v of values) if (v && (!best || v > best)) best = v
  return best
}

export function computeAttention(members: OverviewMember[], now: Date = new Date()): OverviewAttention {
  const day = 24 * 60 * 60 * 1000
  const recentSince = new Date(now.getTime() - RECENT_DAYS * day).toISOString()
  const syncSince = new Date(now.getTime() - SYNC_STALE_DAYS * day).toISOString()

  const recent = members.filter(m => {
    const last = latest(m.lastSeenAt, m.lastFetchAt, m.lastPushAt)
    return last !== null && last >= recentSince
  })

  let newest: ParsedClientVersion | null = null
  for (const m of recent) {
    const v = parseClientVersion(m.clientVersion)
    if (v && (!newest || compareClientVersions(v, newest) > 0)) newest = v
  }

  const outdatedClients: OverviewMember[] = []
  const unknownClients: OverviewMember[] = []
  const notSyncedRecently: OverviewMember[] = []
  for (const m of recent) {
    const v = parseClientVersion(m.clientVersion)
    if (!v) unknownClients.push(m)
    else if (newest && compareClientVersions(v, newest) < 0) outdatedClients.push(m)
    const lastSync = latest(m.lastFetchAt, m.lastPushAt)
    if (!lastSync || lastSync < syncSince) notSyncedRecently.push(m)
  }
  return { outdatedClients, unknownClients, notSyncedRecently }
}
