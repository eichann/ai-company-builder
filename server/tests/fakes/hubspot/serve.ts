/**
 * `pnpm fake:hubspot`: the fake HubSpot for the staging environment
 * (design 節目3 §3-2). Listens on 127.0.0.1 only (default port 4010,
 * `FAKE_HUBSPOT_PORT`), with HubSpot's rate limits and the `/__fake/*`
 * control routes (faults, a change made "in HubSpot"). Prints the fake key to
 * register in the admin page's 「API キー」 — a made-up value, never a real one.
 *
 * Refuses to start under NODE_ENV=production: this is not part of the
 * production image (server/Dockerfile copies only server/src and shared).
 */
import { serve } from '@hono/node-server'
import { createFakeHubSpot, ALL_FAKE_SCOPES, FAKE_HUBSPOT_KEY_PREFIX } from './fake-hubspot'

if (process.env.NODE_ENV === 'production') {
  console.error('[fake-hubspot] refusing to start with NODE_ENV=production')
  process.exit(1)
}

const port = Number(process.env.FAKE_HUBSPOT_PORT ?? 4010)
const key = process.env.FAKE_HUBSPOT_KEY ?? `${FAKE_HUBSPOT_KEY_PREFIX}na1-staging-0000-0000`
if (!key.startsWith(FAKE_HUBSPOT_KEY_PREFIX)) {
  console.error(`[fake-hubspot] FAKE_HUBSPOT_KEY must start with ${FAKE_HUBSPOT_KEY_PREFIX}`)
  process.exit(1)
}

const fake = createFakeHubSpot({ rateLimits: true, controlRoutes: true })
fake.addKey(key, ALL_FAKE_SCOPES)

const server = serve({ fetch: fake.app.fetch, port, hostname: '127.0.0.1' }, info => {
  console.log(`[fake-hubspot] listening on http://127.0.0.1:${info.port}`)
  console.log(`[fake-hubspot] fake key (register it as the HubSpot company key): ${key}`)
})

const stop = () => { fake.close(); server.close(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
