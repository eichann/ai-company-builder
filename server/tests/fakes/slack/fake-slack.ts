/**
 * The fake Slack (「練習用の Slack」, stage 3 A2): a small Hono app with the
 * data in memory that answers the OAuth v2 and Web API calls the server
 * makes, in the shapes of Slack's public reference pages, plus helpers that
 * play Slack's side of events (`signEvent`). Used by the server tests (passed
 * straight in through `tests/helpers/fake-upstream.ts`); a staging server
 * (`pnpm fake:slack`, tests/fakes/slack/serve.ts) serves it on this machine.
 *
 * Test code only: under `server/tests/`, which the production image never
 * copies, and nothing in `server/src` may import it (layering test).
 *
 *   slack.com  GET  /oauth/v2/authorize        (sign-in: redirects back with a code; `as=<U…>` picks the account)
 *              POST /api/oauth.v2.access       code → the member's user token (`authed_user`)
 *              POST /api/auth.test, /api/users.info, /api/auth.revoke
 *              POST /api/conversations.open, /api/chat.postMessage, /api/conversations.replies
 *
 * Practice values only: client secrets `fake-slack-secret-…`, signing secrets
 * `fake-slack-signing-…`, user tokens `xoxp-fake-…`, bot tokens `xoxb-fake-…`,
 * codes `fake-slack-code-…`. Slack answers 200 with `{ ok: false, error }` for
 * most refusals; so does this fake.
 */
import { createHmac } from 'crypto'
import { Hono, type Context } from 'hono'

/** `name`: the display name `users.info` answers (none: an empty profile, like a user who set none). */
export interface FakeSlackUser { id: string; email: string; teamId: string; name?: string }
export interface FakeSlackApp { clientId: string; clientSecret: string; signingSecret: string; teamId: string; botToken: string; botUserId: string; rotation?: boolean }

/** A thread's messages in a channel of a workspace (conversations.replies); the root is the one whose ts is the thread's. */
export interface FakeSlackThread { teamId: string; channel: string; ts: string; messages: Array<{ ts: string; user: string; text: string }> }
export interface FakeSlackSeed { users: FakeSlackUser[]; apps: FakeSlackApp[]; threads?: FakeSlackThread[] }

export function defaultSlackSeed(): FakeSlackSeed {
  return {
    users: [
      { id: 'U0ONE', email: 'one@div.example', teamId: 'T0DIV', name: '一ノ瀬 一' },
      { id: 'U0TWO', email: 'two@div.example', teamId: 'T0DIV', name: '二宮 二郎' },
      { id: 'U0OUT', email: 'stranger@div.example', teamId: 'T0DIV' },
      { id: 'U0THREE', email: 'three@other.example', teamId: 'T0OTHER' },
      // The same address as U0ONE, in another workspace.
      { id: 'U0ONEX', email: 'one@div.example', teamId: 'T0OTHER' },
    ],
    apps: [
      { clientId: '1111.2222', clientSecret: 'fake-slack-secret-div-0001', signingSecret: 'fake-slack-signing-div-0001', teamId: 'T0DIV', botToken: 'xoxb-fake-div-bot', botUserId: 'U0BOTDIV' },
      { clientId: '3333.4444', clientSecret: 'fake-slack-secret-other-01', signingSecret: 'fake-slack-signing-other-1', teamId: 'T0OTHER', botToken: 'xoxb-fake-other-bot', botUserId: 'U0BOTOTHER' },
    ],
  }
}

interface UserToken { token: string; userId: string; teamId: string; scopes: string[]; revoked: boolean }
interface Code { clientId: string; userId: string; scopes: string[]; redirectUri: string; used: boolean }

/** Slack's request signature for an event body (what Slack sends in X-Slack-Signature). */
export function signEvent(signingSecret: string, timestamp: number, body: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

export function createFakeSlack(seed: FakeSlackSeed = defaultSlackSeed()) {
  const codes = new Map<string, Code>()
  const tokens = new Map<string, UserToken>()
  let counter = 0
  /** What the bots and members posted (test assertions only). */
  const posted: Array<{ teamId: string; by: string; channel: string; text: string; threadTs?: string }> = []
  const revokedTokens: string[] = []

  const appByClient = (clientId: string) => seed.apps.find(a => a.clientId === clientId)
  const userById = (id: string) => seed.users.find(u => u.id === id)

  /** A code as Slack's sign-in page would issue it, for this app and account. */
  function issueCode(p: { clientId: string; userId: string; scopes: string[]; redirectUri: string }): string {
    const code = `fake-slack-code-${++counter}`
    codes.set(code, { ...p, used: false })
    return code
  }

  const fail = (c: Context, error: string) => c.json({ ok: false, error })

  async function form(c: Context): Promise<Record<string, string>> {
    const text = await c.req.text()
    return Object.fromEntries(new URLSearchParams(text))
  }

  /** The caller of a Web API method: a user token or a bot token. */
  function caller(c: Context): { kind: 'user'; t: UserToken } | { kind: 'bot'; app: FakeSlackApp } | { error: string } {
    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) return { error: 'not_authed' }
    const bot = seed.apps.find(a => a.botToken === token)
    if (bot) return { kind: 'bot', app: bot }
    const t = tokens.get(token)
    if (!t) return { error: 'invalid_auth' }
    if (t.revoked) return { error: 'token_revoked' }
    return { kind: 'user', t }
  }

  const app = new Hono()

  app.get('/oauth/v2/authorize', c => {
    const q = c.req.query()
    const a = appByClient(q.client_id ?? '')
    if (!a || !q.state || !q.redirect_uri || !q.user_scope) return c.text('bad request', 400)
    const userId = q.as ?? seed.users.find(u => u.teamId === (q.team ?? a.teamId))?.id ?? ''
    const code = issueCode({ clientId: a.clientId, userId, scopes: q.user_scope.split(','), redirectUri: q.redirect_uri })
    return c.redirect(`${q.redirect_uri}?${new URLSearchParams({ code, state: q.state })}`, 302)
  })

  app.post('/api/oauth.v2.access', async c => {
    const f = await form(c)
    const a = appByClient(f.client_id ?? '')
    if (!a || f.client_secret !== a.clientSecret) return fail(c, 'invalid_client')
    const code = codes.get(f.code ?? '')
    if (!code || code.used || code.clientId !== a.clientId) return fail(c, 'invalid_code')
    if (code.redirectUri !== f.redirect_uri) return fail(c, 'bad_redirect_uri')
    code.used = true
    const user = userById(code.userId)
    if (!user) return fail(c, 'invalid_code')
    const token = `xoxp-fake-${++counter}`
    tokens.set(token, { token, userId: user.id, teamId: user.teamId, scopes: code.scopes, revoked: false })
    return c.json({
      ok: true, app_id: 'A0FAKE',
      authed_user: { id: user.id, scope: code.scopes.join(','), access_token: token, token_type: 'user', ...(a.rotation ? { refresh_token: `xoxe-1-fake-${counter}`, expires_in: 43200 } : {}) },
      team: { id: user.teamId },
    })
  })

  app.post('/api/auth.test', c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    if (who.kind === 'bot') return c.json({ ok: true, team_id: who.app.teamId, user_id: who.app.botUserId, bot_id: 'B0FAKE' })
    return c.json({ ok: true, team_id: who.t.teamId, user_id: who.t.userId })
  })

  app.post('/api/users.info', async c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    const f = await form(c)
    const team = who.kind === 'bot' ? who.app.teamId : who.t.teamId
    if (who.kind === 'user' && !who.t.scopes.includes('users:read')) return fail(c, 'missing_scope')
    if (who.kind === 'bot' && f.user === who.app.botUserId) return c.json({ ok: true, user: { id: f.user, is_bot: true, profile: {} } })
    const u = userById(f.user ?? '')
    if (!u || u.teamId !== team) return fail(c, 'user_not_found')
    const showEmail = who.kind === 'bot' || who.t.scopes.includes('users:read.email')
    return c.json({ ok: true, user: { id: u.id, profile: { ...(showEmail ? { email: u.email } : {}), ...(u.name ? { display_name: u.name } : {}) } } })
  })

  app.post('/api/auth.revoke', c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    if (who.kind === 'user') { who.t.revoked = true; revokedTokens.push(who.t.token) }
    return c.json({ ok: true, revoked: true })
  })

  app.post('/api/conversations.open', async c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    const f = await form(c)
    const team = who.kind === 'bot' ? who.app.teamId : who.t.teamId
    const u = userById(f.users ?? '')
    if (!u || u.teamId !== team) return fail(c, 'user_not_found')
    return c.json({ ok: true, channel: { id: `D${u.id.slice(1)}` } })
  })

  app.post('/api/chat.postMessage', async c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    if (who.kind === 'user' && !who.t.scopes.includes('chat:write')) return fail(c, 'missing_scope')
    const f = await form(c)
    if (!f.channel || !f.text) return fail(c, 'no_text')
    const teamId = who.kind === 'bot' ? who.app.teamId : who.t.teamId
    const by = who.kind === 'bot' ? who.app.botUserId : who.t.userId
    const ts = `${1_793_500_000 + counter++}.000100`
    posted.push({ teamId, by, channel: f.channel, text: f.text, ...(f.thread_ts ? { threadTs: f.thread_ts } : {}) })
    // A reply joins its thread (what conversations.replies answers next).
    const thread = f.thread_ts ? (seed.threads ?? []).find(t => t.teamId === teamId && t.channel === f.channel && t.ts === f.thread_ts) : undefined
    thread?.messages.push({ ts, user: by, text: f.text })
    return c.json({ ok: true, channel: f.channel, ts })
  })

  app.post('/api/conversations.replies', async c => {
    const who = caller(c)
    if ('error' in who) return fail(c, who.error)
    if (who.kind === 'user' && !who.t.scopes.some(s => s.endsWith(':history'))) return fail(c, 'missing_scope')
    const f = await form(c)
    if (!f.channel || !f.ts) return fail(c, 'invalid_arguments')
    const team = who.kind === 'bot' ? who.app.teamId : who.t.teamId
    const thread = (seed.threads ?? []).find(t => t.teamId === team && t.channel === f.channel && t.ts === f.ts)
    // A thread nobody seeded reads as empty (the connector's switch tests only need the call to pass).
    if (!thread) return c.json({ ok: true, messages: [] })
    return c.json({ ok: true, messages: thread.messages.map(m => ({ type: 'message', ...m, thread_ts: thread.ts })), has_more: false })
  })

  return { app, seed, issueCode, posted, revokedTokens, tokens }
}

export type FakeSlack = ReturnType<typeof createFakeSlack>
