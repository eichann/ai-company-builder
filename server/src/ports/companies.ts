/**
 * A `companies` row, column names as stored. The API returns every column
 * (camelCased in the route), so rows are passed through whole.
 */
export type CompanyRow = {
  id: string
  name: string
  slug: string
  owner_id: string
  repo_path: string | null
  created_at: string
  updated_at: string
}

export interface NewCompany {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  createdAt: string
}

export interface CompanyRepository {
  /** The user's companies with their role there, newest first. */
  listForUser(userId: string): Array<CompanyRow & { role: string }>
  findById(companyId: string): CompanyRow | undefined
  isSlugTaken(slug: string): boolean
  /** Whether the server holds any company at all (the first one may be created by its first account). */
  anyExists(): boolean
  insert(company: NewCompany): void
  rename(companyId: string, name: string, updatedAt: string): void
}
