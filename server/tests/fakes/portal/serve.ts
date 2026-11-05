/**
 * `pnpm fake:portal`: the fake portal for staging. Listens on 127.0.0.1 only
 * (default port 4013, `FAKE_PORTAL_PORT`), with the `/__fake/*` control routes.
 * Prints the fake key to register as the service's company key — a made-up
 * value, never a real one. The server must run with
 * `ACB_ALLOW_FAKE_UPSTREAMS=1 ACB_FAKE_PORTAL_URL=http://127.0.0.1:4013 ACB_FAKE_PORTAL_HOST=<the declared host>`.
 * `FAKE_PORTAL_BASE_PATH` is the declared `base_url`'s path, `FAKE_PORTAL_ALIASES`
 * the declared paths this fake knows by another name, `FAKE_PORTAL_ENVIRONMENT` the
 * environment it reports (`staging`, or `production` for a package stating that).
 *
 * Refuses to start under NODE_ENV=production: this is not part of the
 * production image (server/Dockerfile copies only server/src and shared).
 */
import { serve } from '@hono/node-server'
import { createFakePortal, FAKE_PORTAL_KEY_PREFIX, parsePortalAliases, PORTAL_SCOPES } from './fake-portal'

if (process.env.NODE_ENV === 'production') {
  console.error('[fake-portal] refusing to start with NODE_ENV=production')
  process.exit(1)
}

const port = Number(process.env.FAKE_PORTAL_PORT ?? 4013)
const key = process.env.FAKE_PORTAL_KEY ?? `${FAKE_PORTAL_KEY_PREFIX}portal-staging-0000`
if (!key.startsWith(FAKE_PORTAL_KEY_PREFIX)) {
  console.error(`[fake-portal] FAKE_PORTAL_KEY must start with ${FAKE_PORTAL_KEY_PREFIX}`)
  process.exit(1)
}

const fake = createFakePortal({ controlRoutes: true, rateLimit: true, environment: process.env.FAKE_PORTAL_ENVIRONMENT === 'production' ? 'production' : 'staging', basePath: process.env.FAKE_PORTAL_BASE_PATH, aliases: parsePortalAliases(process.env.FAKE_PORTAL_ALIASES) })
fake.addKey(key, Object.values(PORTAL_SCOPES))

const server = serve({ fetch: fake.fetch, port, hostname: '127.0.0.1' }, info => {
  console.log(`[fake-portal] listening on http://127.0.0.1:${info.port}`)
  console.log(`[fake-portal] fake key (register it as the service's company key): ${key}`)
})

const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
