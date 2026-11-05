/**
 * 「気になる動き」 (security-alerts.md): what the server noticed that an owner / admin should
 * look at soon — many wrong passwords on one account, one member downloading far more than
 * usual, many refused syncs, a burst of plugin reads or key use, someone made owner / admin,
 * a company key added, 「全員が直せる」 turned on, an internal-host exception added.
 *
 * - `GET /api/companies/:companyId/security-alerts` (owner/admin): `SecurityAlertsView`.
 * - `PUT /api/companies/:companyId/security-alerts/settings` (owner/admin): `{ slackDm: boolean }`.
 * - The admin home's `attention.securityAlerts`: the last 7 days' items (owner/admin; else []).
 *
 * The text is built by the server when read; nothing but counts and fixed words is stored.
 */
export const SECURITY_ALERT_KINDS = [
  'sign_in_failures',
  'sign_in_after_failures',
  'bulk_download',
  'push_probing',
  'plugin_reads',
  'plugin_paced',
  'key_use',
  'role_raised',
  'company_key_added',
  'skill_editing_opened',
  'internal_hosts_added',
] as const
export type SecurityAlertKind = (typeof SECURITY_ALERT_KINDS)[number]

export interface SecurityAlertView {
  id: string
  kind: SecurityAlertKind
  /** What happened, in one sentence (plain Japanese). */
  title: string
  /** The numbers behind it, or why it may matter. */
  detail: string
  /** What to do. */
  action: string
  /** The member it is about (null: the company as a whole). */
  userId: string | null
  name: string | null
  createdAt: string
}

export interface SecurityAlertSettings {
  /** Also send each new alert to owners / admins as a Slack DM (off by default). */
  slackDm: boolean
  updatedAt: string | null
}

export interface SecurityAlertsView {
  items: SecurityAlertView[]
  settings: SecurityAlertSettings
}
