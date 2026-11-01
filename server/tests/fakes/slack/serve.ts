/**
 * `pnpm fake:slack`: the fake Slack for the staging environment (stage 3 A3,
 * `.claude/rules/slack-connector.md` "Practice Slack"). Listens on 127.0.0.1
 * only (default port 4012, `FAKE_SLACK_PORT`) and prints the made-up app
 * values to register in the admin page (「つなぎ先」→「Slack」) — never real
 * ones: secrets start with `fake-slack-secret-` / `fake-slack-signing-`, the
 * bot token with `xoxb-fake-`. The server must run with
 * `ACB_ALLOW_FAKE_UPSTREAMS=1 ACB_FAKE_SLACK_URL=http://127.0.0.1:4012`.
 *
 * The sign-in page signs in as the workspace's first user unless the URL
 * carries `as=<U…>`; the users and their addresses are the seed's
 * (`defaultSlackSeed`), plus `FAKE_SLACK_MEMBER_EMAIL` (a member of the
 * first workspace with that address — use your ACB account's email).
 *
 * Refuses to start under NODE_ENV=production: this is not part of the
 * production image (server/Dockerfile copies only server/src and shared).
 */
import { serve } from '@hono/node-server'
import { createFakeSlack, defaultSlackSeed } from './fake-slack'

if (process.env.NODE_ENV === 'production') {
  console.error('[fake-slack] refusing to start with NODE_ENV=production')
  process.exit(1)
}

const port = Number(process.env.FAKE_SLACK_PORT ?? 4012)
const seed = defaultSlackSeed()
const memberEmail = process.env.FAKE_SLACK_MEMBER_EMAIL?.trim()
if (memberEmail) seed.users.unshift({ id: 'U0STAGING', email: memberEmail, teamId: seed.apps[0].teamId })
const fake = createFakeSlack(seed)
const app = seed.apps[0]

const server = serve({ fetch: fake.app.fetch, port, hostname: '127.0.0.1' }, info => {
  console.log(`[fake-slack] listening on http://127.0.0.1:${info.port}`)
  console.log(`[fake-slack] workspace (team id): ${app.teamId}`)
  console.log(`[fake-slack] client id: ${app.clientId}`)
  console.log(`[fake-slack] client secret: ${app.clientSecret}`)
  console.log(`[fake-slack] signing secret: ${app.signingSecret}`)
  console.log(`[fake-slack] bot token: ${app.botToken}`)
  if (memberEmail) console.log(`[fake-slack] signs in as ${memberEmail} (U0STAGING)`)
})

const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
