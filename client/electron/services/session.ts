// The signed-in member's session with the ACB server: the cookies from
// sign-in, kept in memory only (never written to disk, never sent to the
// renderer). Every server client (sync, write access, private folders,
// company files, git's credentials) reads them from here.

export interface Session {
  /** The session cookies as the server set them ([] when signed out). */
  cookies(): string[]
  /** After sign-in / sign-up: the response's Set-Cookie values (ignored when there are none). */
  update(cookies: string[]): void
  clear(): void
  /** The Better Auth session token for git's HTTPS credentials ('' when none). */
  gitToken(): string
}

/**
 * Extract the Better Auth session token from the session cookies.
 */
export function extractSessionToken(cookies: string[]): string {
  for (const cookie of cookies) {
    // Better Auth session cookie (with or without __Secure- prefix)
    const match = cookie.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/)
    if (match) {
      let token = match[1]
      try {
        token = decodeURIComponent(token)
      } catch { /* use as-is */ }
      // Better Auth signed cookies: "token.signature" — extract token part only
      const dotIndex = token.indexOf('.')
      if (dotIndex > 0) {
        token = token.slice(0, dotIndex)
      }
      return token
    }
  }
  return ''
}

export function createSession(): Session {
  // Session cookie storage (in-memory for the session)
  let authCookies: string[] = []
  return {
    cookies: () => authCookies,
    update(cookies) {
      if (cookies.length > 0) authCookies = cookies
    },
    clear() {
      authCookies = []
    },
    gitToken: () => extractSessionToken(authCookies),
  }
}
