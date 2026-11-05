/**
 * Security Test: where sign-in is trusted from, in production (server.md "Sign-in (Better Auth)").
 *
 * - The production origin list is exactly PUBLIC_URL and the desktop app (`app://`, what every
 *   released app sends): no localhost dev server, no compose-network name.
 * - Production does not start without PUBLIC_URL (Better Auth would otherwise take its base URL
 *   from each request's Host header).
 * - The real Better Auth instance applies them: a cookie-carrying request from a dev origin is
 *   refused, PUBLIC_URL and the app are let through, and sign-in attempts are limited per address.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { authSettingsFrom, SIGN_IN_RATE_LIMIT } from '../../src/lib/auth-settings'

const PUBLIC = 'https://acb.example.com'

describe('authSettingsFrom', () => {
  it('pins the production origin list to PUBLIC_URL and the desktop app', () => {
    const r = authSettingsFrom({ NODE_ENV: 'production', PUBLIC_URL: `${PUBLIC}/` })
    expect(r).toEqual({ ok: true, settings: { production: true, baseURL: PUBLIC, trustedOrigins: [PUBLIC, 'app://'] } })
  })

  it('refuses to start production without PUBLIC_URL, or with one that is not an http(s) URL', () => {
    expect(authSettingsFrom({ NODE_ENV: 'production' }).ok).toBe(false)
    expect(authSettingsFrom({ NODE_ENV: 'production', PUBLIC_URL: '  ' }).ok).toBe(false)
    expect(authSettingsFrom({ NODE_ENV: 'production', PUBLIC_URL: 'acb.example.com' }).ok).toBe(false)
    expect(authSettingsFrom({ NODE_ENV: 'production', PUBLIC_URL: 'ftp://acb.example.com' }).ok).toBe(false)
  })

  it('keeps development working without PUBLIC_URL, with the dev servers trusted', () => {
    const r = authSettingsFrom({ NODE_ENV: 'development' })
    expect(r.ok && r.settings.baseURL).toBeUndefined()
    expect(r.ok && r.settings.trustedOrigins).toEqual(expect.arrayContaining(['app://', 'http://localhost:5173', 'http://localhost:3100']))
  })
})

describe('Better Auth with the production settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function productionAuth() {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_URL', PUBLIC)
    vi.stubEnv('AUTH_SECRET', 'test-secret-for-auth-origins-0123456789abcdef')
    const { auth } = await import('../../src/lib/auth')
    return auth
  }

  function signOut(origin: string) {
    return new Request('http://127.0.0.1:3001/api/auth/sign-out', {
      method: 'POST',
      headers: { origin, cookie: '__Secure-better-auth.session_token=none', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: '{}',
    })
  }

  it('refuses a dev origin and accepts PUBLIC_URL and the desktop app', async () => {
    const auth = await productionAuth()
    expect((await auth.handler(signOut('http://localhost:5173'))).status).toBe(403)
    expect((await auth.handler(signOut('http://admin:3100'))).status).toBe(403)
    expect((await auth.handler(signOut(PUBLIC))).status).not.toBe(403)
    expect((await auth.handler(signOut('app://'))).status).not.toBe(403)
  })

  it('takes its base URL from PUBLIC_URL, not from the request', async () => {
    const auth = await productionAuth()
    expect((await auth.$context).baseURL).toBe(`${PUBLIC}/api/auth`)
  })

  it('limits sign-in attempts per address, not for everyone', async () => {
    const auth = await productionAuth()
    const signIn = (ip: string) => auth.handler(new Request('http://127.0.0.1:3001/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'app://', 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' }),
    }))
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.max; i++) {
      expect((await signIn('203.0.113.9')).status).not.toBe(429)
    }
    expect((await signIn('203.0.113.9')).status).toBe(429)
    expect((await signIn('203.0.113.10')).status).not.toBe(429)
  })
})
