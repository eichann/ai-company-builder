import type { ScopeRepository } from '../ports/scopes'
import { buildView, type CompanyFilesView } from '../lib/company-files'

/**
 * The member's read-only view of the company files (lib/company-files.ts:
 * company `main` minus private folders, plus the ones they may read, filtered
 * by read access, with the scopes from the ScopeRepository). Reading files from
 * the view is lib/company-files.ts too.
 */
export function companyFileViews(scopes: ScopeRepository) {
  return {
    build: (companyId: string, userId: string, role: string): Promise<CompanyFilesView> =>
      buildView(id => scopes.listWithRules(id), companyId, userId, role),
  }
}
