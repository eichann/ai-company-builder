/**
 * Business roles (役割, plan C3, stage 4a; `.claude/rules/plugin-roles.md`):
 * the one copy of their names and of how a holder is found, for the server
 * (engine `who`, approvers, the admin's assignment) and the admin console.
 *
 * - A business plugin (contract 2) **declares** the roles its work needs
 *   (`roles: { sales_manager: { label: 営業の責任者 } }`), referred to as
 *   `role:<name>` in a `who` (an operation's or a type's action) and in a
 *   mapping's `approval_by`.
 * - The **company's default assignment** (who holds each role) is set on the
 *   FDE's admin screen; a **まとまり** (bundle: a 案件, a 企画) may override it
 *   for its own work (`holdersOf`: the bundle's override wins, else the
 *   company's; never merged). A role nobody holds matches no one (fails
 *   closed); an approval falls back to an owner / admin.
 * - The **core roles** stay built in, not assignable here: 本人 (`self`),
 *   部署の管理役 (`dept_manager`, the department managers), 管理者 (`admin`,
 *   owners and admins).
 */
import { ROLE_WHO_PREFIX } from './plugin-declaration'

export { ROLE_WHO_PREFIX } from './plugin-declaration'

/** A declared role's name (the same rule as the declaration's keys). */
export const ROLE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/

/** At most this many members hold one role (company or one bundle). */
export const ROLE_HOLDERS_MAX = 20

/** The core roles, built in (not assigned per company here). */
export const CORE_ROLE_LABELS: Readonly<Record<'self' | 'dept_manager' | 'admin', string>> = {
  self: '本人',
  dept_manager: '部署の管理役',
  admin: '管理者',
}

/** `role:<name>` → `<name>` when the name is well formed, else null. */
export function roleRefName(who: string): string | null {
  if (typeof who !== 'string' || !who.startsWith(ROLE_WHO_PREFIX)) return null
  const name = who.slice(ROLE_WHO_PREFIX.length)
  return ROLE_NAME_RE.test(name) ? name : null
}

/** Who holds a role for a piece of work: the bundle's override when it has one, else the company's assignment. */
export function holdersOf(company: readonly string[] | null, bundleOverride: readonly string[] | null): string[] {
  return [...(bundleOverride ?? company ?? [])]
}

/** A body's `userIds` for an assignment: unique ids, 0–ROLE_HOLDERS_MAX; null when malformed. */
export function parseRoleHolders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ROLE_HOLDERS_MAX) return null
  if (!value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 100)) return null
  const ids = [...new Set(value as string[])]
  return ids.length === value.length ? ids : null
}
