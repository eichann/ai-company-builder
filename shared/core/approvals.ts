/**
 * Approval requests with fixed content (design 節目4 §3-4, N7): the one copy
 * of who may approve and of the content an approval fixes, for the server
 * (approvals service), the app (the core-drawn card) and the admin console.
 *
 * - Approving is a person's act through their session only; an AI, a rule,
 *   an admin-API key or Slack has no way in (design §4-3). That is the
 *   server's routes; this module only says who qualifies.
 * - A reason is required (judgement §3.1: the third tier needs a reason).
 * - The approval fixes a payload (`ApprovalPayload`), hashed by the server
 *   over `canonicalJson` (fixed-content.ts). It is used once.
 */
import { canonicalJson } from './fixed-content'

/** Who approves (design §9 q3): the member the request is for, a manager of the record's department, or an owner / admin. */
export const APPROVER_RULES = ['self', 'dept_manager', 'admin'] as const
export type ApproverRule = typeof APPROVER_RULES[number]

/**
 * Who approves, as a mapping's `approval_by` says it or a request carries it
 * (plan C3): one of the core rules, or `role:<name>` — a role the business
 * plugin declares, held by the members the company assigned
 * (shared/core/plugin-roles.ts). Stored on the approval record as
 * `approver_rule: role` + `approver_role: <name>` (approval version 5).
 */
export type ApproverSpec = ApproverRule | `role:${string}`

const isRole = (s: ApproverSpec): s is `role:${string}` => s.startsWith('role:')
/** self < dept_manager < a plugin role < admin. */
const strictness = (s: ApproverSpec): number => (isRole(s) ? 2 : s === 'admin' ? 3 : s === 'dept_manager' ? 1 : 0)

/**
 * The stricter of two (self < dept_manager < a role < admin); two different
 * roles in one request need an owner / admin (neither role holder alone).
 */
export function stricterApprover(a: ApproverSpec, b: ApproverSpec): ApproverSpec {
  if (isRole(a) && isRole(b) && a !== b) return 'admin'
  return strictness(a) >= strictness(b) ? a : b
}

/**
 * Whether a person qualifies to approve under `rule`. An owner / admin
 * qualifies for anything; a department manager for `dept_manager` and for a
 * `self` request of their department; a role is met only by its holders
 * (`holdsRole`, resolved by the server for the request's plugin and bundle),
 * not by a department manager. The caller must already have established that
 * this is a person (session), not an AI.
 */
export function mayApprove(rule: ApproverSpec, who: { isRequester: boolean; isDeptManager: boolean; isAdmin: boolean; holdsRole?: boolean }): boolean {
  if (who.isAdmin) return true
  if (rule === 'admin') return false
  if (isRole(rule)) return who.holdsRole === true
  if (who.isDeptManager) return true
  return rule === 'self' && who.isRequester
}

export const APPROVER_LABELS: Record<ApproverRule, string> = {
  self: '本人',
  dept_manager: '部署の責任者',
  admin: '管理者',
}

export const APPROVAL_REASON_MAX = 2000

/** Why a reason is not acceptable, or null. Approving and sending back both need one. */
export function approvalReasonProblem(reason: unknown): string | null {
  if (typeof reason !== 'string' || reason.trim() === '') return '理由を書いてください'
  if (reason.length > APPROVAL_REASON_MAX) return `理由は ${APPROVAL_REASON_MAX} 文字までです`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) return '理由に使えない文字が入っています'
  return null
}

/** One field of an update the approval fixes: ACB value and the raw outside value, before and after. */
export interface ApprovalFieldChange {
  field: string
  /** The outside property written. */
  property: string
  before: string | number | boolean | null
  after: string | number | boolean | null
  /** Raw outside values (HubSpot: strings); `rawBefore` is what must still be there when the write happens. */
  rawBefore: string | null
  rawAfter: string
}

/**
 * What an approval fixes for a connector plugin's operation (version 1).
 * Everything the write depends on is inside, so a later change of mapping,
 * package, connection or record makes the hash differ or the request stale.
 */
export interface PluginApprovalPayload {
  v: 1
  kind: 'plugin_operation'
  plugin: { id: string; version: string; fingerprint: string }
  mappingVersion: number
  connectionId: string
  accountId: string
  operation: string
  /** The record the operation is on (update) or attached to; null when it creates a record. */
  record: { id: string; version: number } | null
  object: string
  externalId: string | null
  /** update: each field before → after. */
  changes: ApprovalFieldChange[]
  /** create: the title and the raw outside properties to send (create_deal). */
  create: { title: string; properties: Record<string, string> } | null
  /** Where the request came from (a meeting record and the quoted sentence of its minutes), for the card; not authority. */
  basis: { meetingId: string | null; quote: string | null }
}

export type ApprovalPayload = PluginApprovalPayload

/** The canonical text the server hashes for an approval payload. */
export function approvalPayloadCanonical(p: ApprovalPayload): string {
  return canonicalJson(p)
}
