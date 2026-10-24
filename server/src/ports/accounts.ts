/** A user account as the API shows it next to a membership, invitation, rule… */
export interface AccountSummary {
  email: string
  name: string | null
}

/** A signed-in account (the session's user). */
export interface SessionUser {
  id: string
  email: string
  name: string | null
  image: string | null
  emailVerified: boolean
}

/** The accounts (Better Auth's database). Read-only for the server's own code. */
export interface AccountDirectory {
  /** The accounts that exist among `userIds`, by id. */
  byIds(userIds: string[]): Map<string, AccountSummary>
  /**
   * The user of an unexpired session token. Repository clients over HTTP send
   * the token as the Basic-auth password; Better Auth signs its cookies, so
   * its getSession cannot take a raw token.
   */
  bySessionToken(token: string): SessionUser | null
}
