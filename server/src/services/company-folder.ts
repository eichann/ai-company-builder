/**
 * Does a company have the shared company folder (its repository)? (owner decision 2026-11-07,
 * shared/core/company-folder.ts; server.md "Companies without a shared folder").
 *
 * A capability the services ask, never a stand-in: for a `none` company nothing pretends a
 * repository exists — what needs one answers NO_COMPANY_FOLDER, and what has a meaning without
 * one (departments, the places of records) is answered from the database rows.
 */
import { hasCompanyFolder, NO_COMPANY_FOLDER, storedCompanyFolderKind, type CompanyFolderKind } from '../../shared/core/company-folder'
import { pathKey } from '../../shared/core/paths'
import type { CompanyRepository } from '../ports/companies'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export interface CompanyFolders {
  kindOf(companyId: string): CompanyFolderKind
  /** The company has its repository (kind `git`). */
  has(companyId: string): boolean
  /** ok for a company with the folder; 409 NO_COMPANY_FOLDER for one without. */
  require(member: Member): Outcome<void>
  /**
   * For a company without the folder: the department folder (as stored) that `path` is, or is
   * inside, or null. '' is the company itself. Its places are its departments' rows.
   */
  departmentPlaceOf(companyId: string, path: string): { department: string | null } | null
}

export function createCompanyFolders(deps: { companies: Pick<CompanyRepository, 'findById'>; companyData: CompanyDataSource }): CompanyFolders {
  const kindOf = (companyId: string) => storedCompanyFolderKind(deps.companies.findById(companyId)?.folder_kind)
  const has = (companyId: string) => hasCompanyFolder(kindOf(companyId))
  return {
    kindOf,
    has,
    require: member => (has(member.companyId) ? ok(undefined) : refuse('conflict', NO_COMPANY_FOLDER.error, { code: NO_COMPANY_FOLDER.code })),
    departmentPlaceOf(companyId, path) {
      if (path === '') return { department: null }
      const key = pathKey(path)
      const dept = deps.companyData.forCompany(companyId).departments.listUnordered()
        .find(d => key === pathKey(d.folder) || key.startsWith(`${pathKey(d.folder)}/`))
      return dept ? { department: dept.folder } : null
    },
  }
}
