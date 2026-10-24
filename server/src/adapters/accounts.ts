import type { AccountDirectory } from '../ports/accounts'
import { getUsersByIds } from '../lib/auth'

/** Better Auth's user table (lib/auth.ts). Looked up at call time, so tests that mock lib/auth see their mock. */
export function betterAuthAccountDirectory(): AccountDirectory {
  return {
    byIds: userIds => getUsersByIds(userIds),
  }
}
