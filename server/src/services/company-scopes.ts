/**
 * A member's company scopes for git over HTTP (routes/git-http.ts): the push
 * permission snapshot, private-folder lookups, and the orphan check after an
 * accepted push. Routes never hold a company handle; they pass the Member
 * that `services.access` looked up for the signed-in account, and the handle
 * is opened for that membership's company (ports/company-data.ts).
 */
import type { ScopeWithRules } from '../../shared/core/permissions'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'

export interface CompanyScopeServiceDeps {
  companyData: CompanyDataSource
}

export function createCompanyScopeService({ companyData }: CompanyScopeServiceDeps) {
  const scopesOf = (member: Member) => companyData.forCompany(member.companyId).scopes
  return {
    /** Every scope of the member's company with its rules. */
    listWithRules: (member: Member): ScopeWithRules[] => scopesOf(member).listWithRules(),
    /** The company scope (`everyone: read + write` the first time), for companies older than the permission tables. */
    ensureCompanyScope: (member: Member): void => {
      scopesOf(member).ensureCompanyScope(null)
    },
    /** After an accepted push: check for rules whose folder disappeared (deferred, never throws). */
    scheduleOrphanCheck: (member: Member): void => companyData.forCompany(member.companyId).orphanedScopes.scheduleCheck(),
  }
}

export type CompanyScopeService = ReturnType<typeof createCompanyScopeService>
