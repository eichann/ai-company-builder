/**
 * `pnpm fake:google`: the fake Google for the staging environment (milestone
 * 4 design N13). Listens on 127.0.0.1 only (default port 4011,
 * `FAKE_GOOGLE_PORT`) with the `/__fake/*` control routes (who signs in,
 * faults, outside changes, sent mail). Registers one OAuth client and prints
 * its id and secret to register in the admin page — made-up values, never
 * real ones (the secret must start with `fake-google-secret-`).
 *
 * `FAKE_GOOGLE_REDIRECT_URIS` (comma-separated) lists the redirect URIs the
 * client accepts; `FAKE_GOOGLE_INTERNAL_DOMAIN` makes it an internal app.
 *
 * Refuses to start under NODE_ENV=production: this is not part of the
 * production image (server/Dockerfile copies only server/src and shared).
 */
import { serve } from '@hono/node-server'
import { createFakeGoogle, FAKE_GOOGLE_SECRET_PREFIX } from './fake-google'

if (process.env.NODE_ENV === 'production') {
  console.error('[fake-google] refusing to start with NODE_ENV=production')
  process.exit(1)
}

const port = Number(process.env.FAKE_GOOGLE_PORT ?? 4011)
const clientId = process.env.FAKE_GOOGLE_CLIENT_ID ?? '000000000000-staging-fake.apps.googleusercontent.com'
const clientSecret = process.env.FAKE_GOOGLE_CLIENT_SECRET ?? `${FAKE_GOOGLE_SECRET_PREFIX}staging-0000-0000`
if (!clientSecret.startsWith(FAKE_GOOGLE_SECRET_PREFIX)) {
  console.error(`[fake-google] FAKE_GOOGLE_CLIENT_SECRET must start with ${FAKE_GOOGLE_SECRET_PREFIX}`)
  process.exit(1)
}
const redirectUris = (process.env.FAKE_GOOGLE_REDIRECT_URIS ?? 'http://localhost:3001/api/oauth/google/callback,http://127.0.0.1:3001/api/oauth/google/callback')
  .split(',').map(s => s.trim()).filter(Boolean)

const fake = createFakeGoogle({ controlRoutes: true })
fake.addClient({ clientId, clientSecret, redirectUris, internalDomain: process.env.FAKE_GOOGLE_INTERNAL_DOMAIN || undefined })

const server = serve({ fetch: fake.app.fetch, port, hostname: '127.0.0.1' }, info => {
  console.log(`[fake-google] listening on http://127.0.0.1:${info.port}`)
  console.log(`[fake-google] fake OAuth client id: ${clientId}`)
  console.log(`[fake-google] fake OAuth client secret: ${clientSecret}`)
  console.log(`[fake-google] redirect URIs: ${redirectUris.join(', ')}`)
})

const stop = () => { fake.close(); server.close(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
