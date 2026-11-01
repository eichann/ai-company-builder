/**
 * Which handlers are route guards (routes/guards.ts), and `publicRoute`. Kept
 * apart from guards.ts, which reaches the session and the composition, so a
 * route factory that is public (routes/slack.ts) can be built without either.
 */
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'

export type GuardKind = 'company' | 'signed-in' | 'public'

const GUARDS = new WeakMap<object, GuardKind>()

/** Which guard a handler is, if any (tests/security/auth-guards.test.ts). */
export function guardKind(handler: unknown): GuardKind | null {
  return (typeof handler === 'function' && GUARDS.get(handler)) || null
}

export function tagged<T extends object>(kind: GuardKind, mw: T): T {
  GUARDS.set(mw, kind)
  return mw
}

/**
 * No ACB session on purpose; the handler checks its own proof (a signature, an
 * OAuth state, an invitation token). `reason` is for the reader; the endpoint is
 * also listed in tests/security/auth-guards.test.ts PUBLIC_ENDPOINTS.
 */
export function publicRoute(reason: string): MiddlewareHandler {
  void reason
  return tagged('public', createMiddleware(async (_c, next) => { await next() }))
}
