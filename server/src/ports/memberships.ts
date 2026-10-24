/** A `memberships` row (who belongs to a company, with which role). */
export type MembershipRow = {
  id: string
  user_id: string
  company_id: string
  role: string
  created_at: string
}

export interface NewMembership {
  id: string
  userId: string
  companyId: string
  role: string
  createdAt: string
}

export interface MembershipRepository {
  /** The user's role in the company, or null when they are not a member. */
  roleOf(companyId: string, userId: string): string | null
  /** Every member of the company, oldest membership first. */
  listByCompany(companyId: string): MembershipRow[]
  countOwners(companyId: string): number
  insert(membership: NewMembership): void
  updateRole(companyId: string, userId: string, role: string, updatedAt: string): void
  delete(companyId: string, userId: string): void
}
