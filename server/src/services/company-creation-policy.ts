/**
 * Who may create a company (a tenant) on this server: one server-wide policy,
 * COMPANY_CREATION_POLICY (lib/config.ts), checked by services/companies.ts
 * `mayCreate`.
 *
 * - `operator` (default): only server operators (OPERATOR_USER_IDS) create
 *   companies; the first company of a fresh server is the one exception.
 * - `approved` (NOT IMPLEMENTED): anyone may apply, an operator approves, and
 *   the company is created on approval.
 * - `self_serve` (NOT IMPLEMENTED): signed-in accounts create companies,
 *   within per-account limits.
 *
 * The two later modes are named here so they slot in without a redesign; a
 * server configured with one of them refuses to start until it exists.
 */

export const COMPANY_CREATION_POLICIES = ['operator', 'approved', 'self_serve'] as const
export type CompanyCreationPolicy = typeof COMPANY_CREATION_POLICIES[number]

export const DEFAULT_COMPANY_CREATION_POLICY: CompanyCreationPolicy = 'operator'

const IMPLEMENTED: ReadonlySet<CompanyCreationPolicy> = new Set(['operator'])

/** The setting as configured (unset → the default), or why the server cannot start with it. */
export function parseCompanyCreationPolicy(raw: string | null | undefined):
  { ok: true; policy: CompanyCreationPolicy } | { ok: false; error: string } {
  const value = raw?.trim() || DEFAULT_COMPANY_CREATION_POLICY
  if (!(COMPANY_CREATION_POLICIES as readonly string[]).includes(value)) {
    return { ok: false, error: `COMPANY_CREATION_POLICY=${value} is not a known policy (${COMPANY_CREATION_POLICIES.join(', ')})` }
  }
  const policy = value as CompanyCreationPolicy
  if (!IMPLEMENTED.has(policy)) {
    return { ok: false, error: `COMPANY_CREATION_POLICY=${policy} is not implemented yet; use operator (the default)` }
  }
  return { ok: true, policy }
}
