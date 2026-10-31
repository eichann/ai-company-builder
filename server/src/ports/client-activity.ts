/** A `client_activity` row: the app build a member last used, and when they last synced. */
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
 * A member listed in a 409 OUTDATED_CLIENTS answer (the permission editor's
 * outdated-app guard, the first private folder): their app cannot handle the
 * change yet.
 */
export interface OutdatedMember {
  userId: string
  name: string | null
  email: string | null
  role: string
  clientVersion: string | null
  /** clientVersion, or 不明 when unknown. */
  version: string
  lastSeenAt: string | null
}

/** seen: any identified request; fetch: upload-pack completed; push: push accepted. */
export type ActivityKind = 'seen' | 'fetch' | 'push'

/** Which app build each member last used, and when they last synced (services/client-activity.ts). */
export interface ClientActivityRepository {
  /** The company's rows, by user id. */
  forCompany(companyId: string): Map<string, ClientActivityRow>
  /**
   * Upsert the member's row: build, platform and last_seen_at = `at`, plus
   * last_fetch_at / last_push_at for those kinds (other columns kept).
   */
  record(input: { userId: string; companyId: string; kind: ActivityKind; version: string | null; platform: string | null; at: string }): void
}
