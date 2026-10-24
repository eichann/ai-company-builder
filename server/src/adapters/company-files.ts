import type Database from 'better-sqlite3'
import { buildView, type CompanyFilesView } from '../lib/company-files'

/**
 * The member's read-only view of the company files (lib/company-files.ts:
 * company `main` minus private folders, plus the ones they may read, filtered
 * by read access). Reading files from the view is lib/company-files.ts too.
 */
export function companyFileViews(conn: Database.Database) {
  return {
    build: (companyId: string, userId: string, role: string): Promise<CompanyFilesView> => buildView(conn, companyId, userId, role),
  }
}
