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

/** Which app build each member last used, and when they last synced (lib/client-activity.ts). */
export interface ClientActivityRepository {
  /** The company's rows, by user id. */
  forCompany(companyId: string): Map<string, ClientActivityRow>
}
