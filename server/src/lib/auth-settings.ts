/**
 * Where sign-in is trusted from: Better Auth's base URL and trusted origins, and the API's CORS
 * origins (server.md "Sign-in (Better Auth)"). Pure: read from the environment it is given, so
 * tests pin the production list without opening auth.sqlite.
 *
 * Who sends which Origin:
 *   - the desktop app (every released build): `Origin: app://` on sign-in, sign-up and sign-out,
 *     from the main process (client/electron/features/auth/ipc.ts); other requests carry no
 *     Origin and never reach Better Auth's origin check (only /api/auth/** does).
 *   - the admin console: the browser's own origin. In production Caddy serves /api/* and the
 *     admin on one origin, PUBLIC_URL; without Caddy the admin's /api/* proxy (admin/src/proxy.ts,
 *     a transparent rewrite) passes the browser's Origin through unchanged — it never sends
 *     http://admin:3100 or http://api:3001.
 *   - `pnpm dev` / `pnpm dev:admin`: http://localhost:5173 and http://localhost:3100.
 */

/** What every released desktop app sends as Origin on /api/auth/** (main process). */
export const DESKTOP_APP_ORIGIN = 'app://'

/** Origins trusted only outside production: the dev servers and the compose network's names. */
export const DEV_ONLY_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:3100',
  'http://api:3001',
  'http://admin:3100',
]

/**
 * Sign-in attempts per client address (Better Auth's rate limiter, memory storage: one server
 * process). Better Auth's own default is 3 per 10 s; a minute's window of 10 is stricter over
 * time (10 rather than 18 a minute) while letting an office behind one address sign in a few
 * people at once.
 */
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 10 } as const

export interface AuthSettings {
  production: boolean
  /** PUBLIC_URL's origin; undefined outside production without PUBLIC_URL (taken from each request, as before). */
  baseURL: string | undefined
  /** Better Auth's trustedOrigins and the API's CORS origins. */
  trustedOrigins: string[]
}

export type AuthSettingsResult = { ok: true; settings: AuthSettings } | { ok: false; error: string }

export function authSettingsFrom(env: Readonly<Record<string, string | undefined>>): AuthSettingsResult {
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production'
  const raw = env.PUBLIC_URL?.trim() ?? ''
  let origin: string | undefined
  if (raw) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { ok: false, error: 'PUBLIC_URL is not a URL (e.g. https://your-domain.com).' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'PUBLIC_URL must start with https:// (or http:// on this machine).' }
    }
    origin = url.origin
  } else if (production) {
    // Without it Better Auth takes the address from each request's Host header.
    return { ok: false, error: 'PUBLIC_URL environment variable is not set (e.g. https://your-domain.com).' }
  }
  const trustedOrigins = [
    ...(origin ? [origin] : []),
    DESKTOP_APP_ORIGIN,
    ...(production ? [] : DEV_ONLY_ORIGINS),
  ]
  return { ok: true, settings: { production, baseURL: origin, trustedOrigins } }
}

let processSettings: AuthSettings | undefined

/**
 * This process's settings (read once; lib/auth.ts and the API's CORS in app.ts). A server that
 * cannot start says why and stops, like a missing AUTH_SECRET.
 */
export function serverAuthSettings(): AuthSettings {
  if (processSettings) return processSettings
  const result = authSettingsFrom(process.env)
  if (!result.ok) {
    console.error(`FATAL: ${result.error}`)
    process.exit(1)
  }
  processSettings = result.settings
  return processSettings
}
