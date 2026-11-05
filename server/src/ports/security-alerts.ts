/**
 * 「気になる動き」 (services/security-alerts.ts, security-alerts.md), behind the company handle:
 * every method is limited to the handle's company. Besides its own rows it reads, never writes,
 * the records the rules look at (push rejections, contract-3 reads, the relay's daily use,
 * memberships, company keys, the skill-editing switch, the key broker's history).
 */
export interface StoredSecurityAlert {
  id: string
  kind: string
  userId: string | null
  /** JSON: counts and fixed words only. */
  facts: string
  createdAt: string
}

export interface NewSecurityAlert extends StoredSecurityAlert {
  dedupeKey: string
}

export interface SecurityAlertRepository {
  /** False when an alert with the same dedupe key exists (nothing written). */
  insert(alert: NewSecurityAlert): boolean
  /** Newest first, created at or after `since`. */
  recent(since: string, limit: number): StoredSecurityAlert[]
  /** Oldest first: alerts the delivery step has not looked at yet. */
  undelivered(limit: number): StoredSecurityAlert[]
  markDelivered(ids: string[], at: string): void
  /** Forget alerts created before `before`, and download hours before `beforeHour`. */
  prune(before: string, beforeHour: string): void

  settings(): { slackDm: boolean; updatedAt: string } | null
  saveSettings(slackDm: boolean, at: string, by: string): void

  /** Add bytes sent to a member in one hour (YYYY-MM-DDTHH). */
  addDownload(userId: string, hour: string, bytes: number): void
  /** Bytes per member from `fromHour` on. */
  downloadsSince(fromHour: string): Array<{ userId: string; bytes: number }>
  /** One member's hours in [fromHour, toHour). */
  downloadHours(userId: string, fromHour: string, toHour: string): Array<{ hour: string; bytes: number }>
  /** The first hour a member was counted (null: never). */
  firstDownloadHour(userId: string): string | null

  /** Refused pushes since `since`, per member: how many, and the paths' JSON of each (newest `perMember`). */
  pushRejectionsSince(since: string, perMember: number): Array<{ userId: string; count: number; paths: string[] }>
  /** Contract-3 reads (plugin_access_log) per member in [from, to). */
  pluginReads(from: string, to: string): Array<{ userId: string; count: number }>
  /** One member's contract-3 reads in [from, to). */
  pluginReadsOf(userId: string, from: string, to: string): number
  /** Reads refused for a member's share of the pace, summed per member from `fromHour` on. */
  pluginPacedSince(fromHour: string): Array<{ userId: string; count: number }>
  /** The relay's requests per member and day in [fromDay, toDay] (refusal counters left out). */
  keyRequests(fromDay: string, toDay: string): Array<{ userId: string; day: string; requests: number }>
  /** Members who became owner / admin at or after `since` (not the company's founding owner). */
  raisedRoles(since: string): Array<{ userId: string; role: string; at: string }>
  /** Company keys (not members' own) created at or after `since`. */
  companyKeysSince(since: string): Array<{ id: string; service: string; at: string; by: string }>
  /** 「全員が直せる」 when it is on and was switched at or after `since`. */
  skillEditingOpenedSince(since: string): { at: string; by: string | null } | null
  /** The key broker's setting changes at or after `since` that added an internal-host exception. */
  internalHostsAddedSince(since: string): Array<{ id: string; at: string; by: string; added: number }>
}
