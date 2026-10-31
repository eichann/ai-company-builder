import type { CompanyDataSource } from '../ports/company-data'
import { buildView, type CompanyFilesView } from '../lib/company-files'

/**
 * The member's read-only view of the company files (lib/company-files.ts:
 * company `main` minus private folders, plus the ones they may read, filtered
 * by read access, with the scopes from the company's handle). Reading files from
 * the view is lib/company-files.ts too.
 */
export function companyFileViews(companyData: CompanyDataSource) {
  return {
    build: (companyId: string, userId: string, role: string): Promise<CompanyFilesView> =>
      buildView(id => companyData.forCompany(id).scopes.listWithRules(), companyId, userId, role),
  }
}
