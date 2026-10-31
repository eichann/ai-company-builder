/**
 * The company handle (「会社つきの手形」): the one way services reach a
 * company's own rows. A handle is opened for ONE company id; the repositories
 * it carries take no company parameter and every statement they run is
 * limited to that company, so a call with another company's object id finds,
 * changes or deletes nothing. Cross-company access cannot be written through
 * it — not "is checked before", but has no signature to express it.
 *
 * Where the company id comes from: always from the server, never from what a
 * client sent. In a request it is `member.companyId`, the company of a
 * membership `services/access.ts` just looked up for the signed-in account;
 * otherwise the company the service itself just created, the company a key
 * broker token row belongs to, or a startup / retention loop over the
 * companies registry. Routes never see a handle (composition.ts does not hand
 * the source to them).
 *
 * Today every handle reads the one SQLite database (案 A, 2026-10-31). Moving
 * to a database per company (B) or PostgreSQL with row-level security (C)
 * changes only where `forCompany` opens its connection.
 *
 * Tables still reached outside a handle (to be migrated, or the control plane:
 * the companies registry, memberships, accounts) are listed with their reason
 * in tests/unit/company-scoped-sql.test.ts, which fails on any new statement
 * that touches a company's rows without a company condition.
 */
import type { DepartmentRepository } from './departments'
import type { InvitationRepository } from './invitations'
import type { OrphanedScopeReader } from './orphaned-scopes'
import type { PrivateFolderRepository } from './private-folders'
import type { ScopeRepository } from './scopes'

export interface CompanyData {
  /** The company this handle is limited to. */
  readonly companyId: string
  readonly departments: DepartmentRepository
  readonly invitations: InvitationRepository
  /** Permission scopes, rules and department managers. */
  readonly scopes: ScopeRepository
  readonly privateFolders: PrivateFolderRepository
  /** Rules whose folder disappeared from the shared branch (git + orphaned_scopes). */
  readonly orphanedScopes: OrphanedScopeReader
}

export interface CompanyDataSource {
  /** The handle for one company (see above for where `companyId` may come from). */
  forCompany(companyId: string): CompanyData
}
