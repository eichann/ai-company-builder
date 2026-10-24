/** A user account as the API shows it next to a membership, invitation, rule… */
export interface AccountSummary {
  email: string
  name: string | null
}

/** The accounts (Better Auth's database). Read-only for the services. */
export interface AccountDirectory {
  /** The accounts that exist among `userIds`, by id. */
  byIds(userIds: string[]): Map<string, AccountSummary>
}
