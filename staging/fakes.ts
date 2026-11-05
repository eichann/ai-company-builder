/**
 * The staging kit's practice services (練習用の HubSpot・Google・Slack・ポータル) in one process on this
 * Mac, listening on 127.0.0.1 only. The kit's api container reaches them through
 * host.docker.internal (ACB_FAKE_*_URL, staging only; `.claude/rules/deployment.md`).
 *
 * Started and stopped by `staging/kit.mjs` (`node --import tsx staging/fakes.ts` from server/,
 * whose node_modules hold tsx and @hono/node-server). Built on the repository's fakes
 * (server/tests/fakes/**) with a staging seed:
 *   - HubSpot: the default seed (made-up deals of 株式会社サンプル), the kit's practice key
 *     (read from FAKE_HUBSPOT_KEY_FILE, `pat-fake-…`, never printed);
 *   - Google: the seed's two staff become 検証A社's a-member / a-manager, the Workspace domain
 *     example.invalid, the meetings moved to today so 「議事録を確かめる」 finds them, and the practice
 *     spreadsheets for the relay (「練習用 係数表」 a-member edits, a budget they may only read);
 *   - Slack: the seed, plus a-member@example.invalid as a member of the workspace;
 *   - portal: the seed, the kit's practice key (FAKE_PORTAL_KEY_FILE), under the path and with the
 *     aliases the private kit config names (FAKE_PORTAL_BASE_PATH, FAKE_PORTAL_ALIASES).
 * Made-up people and values only. Refuses NODE_ENV=production.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createFakeHubSpot, ALL_FAKE_SCOPES, FAKE_HUBSPOT_KEY_PREFIX } from '../server/tests/fakes/hubspot/fake-hubspot'
import { createFakeGoogle } from '../server/tests/fakes/google/fake-google'
import { defaultGoogleSeed, GOOGLE_SEED } from '../server/tests/fakes/google/seed'
import { createFakeSlack, defaultSlackSeed } from '../server/tests/fakes/slack/fake-slack'
import { createFakePortal, FAKE_PORTAL_KEY_PREFIX, parsePortalAliases, PORTAL_SCOPES } from '../server/tests/fakes/portal/fake-portal'

if (process.env.NODE_ENV === 'production') {
  console.error('[fakes] refusing to start with NODE_ENV=production')
  process.exit(1)
}

// staging/ is not a package: take the server's copy (pnpm does not hoist it to the root).
const { serve } = createRequire(new URL('../server/package.json', import.meta.url))('@hono/node-server') as typeof import('@hono/node-server')

/** Values the kit registers in 検証A社 (made up; the secret must start with fake-google-secret-). */
export const STAGING_GOOGLE_CLIENT_ID = '000000000000-acb-staging-kit.apps.googleusercontent.com'
export const STAGING_GOOGLE_CLIENT_SECRET = 'fake-google-secret-acb-staging-kit-0001'
export const STAGING_DOMAIN = 'example.invalid'

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback)
const hubspotPort = num('FAKE_HUBSPOT_PORT', 14010)
const googlePort = num('FAKE_GOOGLE_PORT', 14011)
const slackPort = num('FAKE_SLACK_PORT', 14012)
const portalPort = num('FAKE_PORTAL_PORT', 14013)
const publicUrl = (process.env.ACB_PUBLIC_URL ?? 'http://localhost:14001').replace(/\/+$/, '')
const keyFile = process.env.FAKE_HUBSPOT_KEY_FILE
if (!keyFile) { console.error('[fakes] FAKE_HUBSPOT_KEY_FILE is not set'); process.exit(1) }
const hubspotKey = readFileSync(keyFile, 'utf8').trim()
if (!hubspotKey.startsWith(FAKE_HUBSPOT_KEY_PREFIX)) { console.error('[fakes] the practice HubSpot key must start with ' + FAKE_HUBSPOT_KEY_PREFIX); process.exit(1) }

const portalKeyFile = process.env.FAKE_PORTAL_KEY_FILE
if (!portalKeyFile) { console.error('[fakes] FAKE_PORTAL_KEY_FILE is not set'); process.exit(1) }
const portalKey = readFileSync(portalKeyFile, 'utf8').trim()
if (!portalKey.startsWith(FAKE_PORTAL_KEY_PREFIX)) { console.error('[fakes] the practice portal key must start with ' + FAKE_PORTAL_KEY_PREFIX); process.exit(1) }

// HubSpot
const hubspot = createFakeHubSpot({ rateLimits: true, controlRoutes: true })
hubspot.addKey(hubspotKey, ALL_FAKE_SCOPES)

// Google: people → the kit's accounts, meetings → today.
let text = JSON.stringify(defaultGoogleSeed())
text = text.split(GOOGLE_SEED.member).join('a-member@example.invalid')
text = text.split(GOOGLE_SEED.colleague).join('a-manager@example.invalid')
text = text.split(`"hd":"${GOOGLE_SEED.internalDomain}"`).join(`"hd":"${STAGING_DOMAIN}"`)
const googleSeed = JSON.parse(text)
const now = Date.now()
const endsAgoMin: Record<string, number> = { [GOOGLE_SEED.salesEvent]: 60, [GOOGLE_SEED.internalEvent]: 300, [GOOGLE_SEED.followUpEvent]: 180 }
for (const e of googleSeed.events) {
  const len = Date.parse(e.end) - Date.parse(e.start)
  const end = now - (endsAgoMin[e.id] ?? 120) * 60_000
  e.start = new Date(end - len).toISOString()
  e.end = new Date(end).toISOString()
}
for (const c of googleSeed.conferences) {
  const e = googleSeed.events.find((x: { meetingCode?: string }) => x.meetingCode === c.meetingCode)
  if (!e) continue
  c.startTime = new Date(Date.parse(e.start) + 30_000).toISOString()
  c.endTime = new Date(Date.parse(e.end) - 60_000).toISOString()
}
for (const d of googleSeed.docs) d.modifiedTime = new Date(now - 30 * 60_000).toISOString()
const google = createFakeGoogle({ seed: googleSeed, controlRoutes: true })
google.addClient({
  clientId: STAGING_GOOGLE_CLIENT_ID,
  clientSecret: STAGING_GOOGLE_CLIENT_SECRET,
  redirectUris: [`${publicUrl}/api/oauth/google/callback`],
  internalDomain: STAGING_DOMAIN,
})

// Slack
const slackSeed = defaultSlackSeed()
slackSeed.users.unshift({ id: 'U0STAGING', email: 'a-member@example.invalid', teamId: slackSeed.apps[0].teamId })
const slack = createFakeSlack(slackSeed)
const slackApp = slackSeed.apps[0]

// Portal
const portal = createFakePortal({ controlRoutes: true, rateLimit: true, basePath: process.env.FAKE_PORTAL_BASE_PATH, aliases: parsePortalAliases(process.env.FAKE_PORTAL_ALIASES) })
portal.addKey(portalKey, Object.values(PORTAL_SCOPES))

const servers = [
  serve({ fetch: hubspot.app.fetch, port: hubspotPort, hostname: '127.0.0.1' }),
  serve({ fetch: google.app.fetch, port: googlePort, hostname: '127.0.0.1' }),
  serve({ fetch: slack.app.fetch, port: slackPort, hostname: '127.0.0.1' }),
  serve({ fetch: portal.fetch, port: portalPort, hostname: '127.0.0.1' }),
]
console.log(`[fakes] practice HubSpot http://127.0.0.1:${hubspotPort} (key: secrets/fake-hubspot-key)`)
console.log(`[fakes] practice Google  http://127.0.0.1:${googlePort} (client id ${STAGING_GOOGLE_CLIENT_ID}, domain ${STAGING_DOMAIN}, signs in as a-member@example.invalid)`)
console.log(`[fakes] practice Slack   http://127.0.0.1:${slackPort} (team ${slackApp.teamId}; client id ${slackApp.clientId}; client secret ${slackApp.clientSecret}; signing secret ${slackApp.signingSecret}; bot token ${slackApp.botToken} — made-up values)`)

console.log(`[fakes] practice portal http://127.0.0.1:${portalPort} (key: secrets/fake-portal-key)`)

const stop = () => {
  hubspot.close()
  google.close()
  let open = servers.length
  for (const s of servers) s.close(() => { if (--open === 0) process.exit(0) })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
