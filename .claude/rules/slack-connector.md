---
paths:
  - "server/src/services/slack-client.ts"
  - "server/src/services/slack-connector.ts"
  - "server/src/services/slack-events.ts"
  - "server/src/routes/slack.ts"
  - "server/src/ports/slack.ts"
  - "server/src/adapters/sqlite/slack.ts"
  - "server/src/adapters/hmac.ts"
  - "server/src/db/schema/slack.ts"
  - "server/tests/fakes/slack/**"
  - "server/tests/integration/slack-connector.test.ts"
  - "admin/src/app/companies/*/integrations/slack.tsx"
  - "client/src/features/settings/components/SlackSection.tsx"
  - "client/electron/features/slack/**"
---

# The Slack connection (stage 3, lane A: A2 / A3)

Slack is a core connector serving the `chat` role (`connector-roles.md`). Two permissions (plan
§5-6): reading a member's DMs and mentions (and replying as them) uses **that member's own user
grant** (`member-oauth.md`, provider `slack`); **notice DMs are sent by the company's bot**. Each
company creates its own internal Slack app in its own workspace. Spec: 統合版 §6-3, §7-1.

**A2 (done) is new files only and not wired**: nothing in `composition.ts`, `app.ts` or
`db/index.ts` yet; no admin or app screen. A3 wires it (composition/connectors.ts, the routes
below, `slackSchema` into the schema below the lane A marker, `PUBLIC_ENDPOINTS` and matrix rows,
`ACB_FAKE_SLACK_URL`, screens, the `chat` role registration, notice DMs from the server clock).

## Storage (`db/schema/slack.ts`, `ports/slack.ts`, `adapters/sqlite/slack.ts`; every statement binds the company)

- `slack_apps` (one per company): workspace `team_id` (`T…`), `client_id`, the **client secret,
  signing secret and bot token sealed** (vault purpose `acb-slack-app`, id `client-secret` /
  `signing-secret` / `bot-token`, bound to the company: `slackAppSealContext`), client secret's
  last 4, the bot's user id, `enabled`.
- `slack_accounts`: which Slack user signed in with which address (written in `identify`). It
  serves only together with an **active grant whose account is that address**, so a row left by
  a refused sign-in serves nobody.
- `slack_events_seen`: event ids (Slack retries), kept a day. `slack_history`: app changes (JSON,
  no secret). Grants and pending starts: `connector_grants` / `oauth_pending` (`slack`).
- **No message body is stored anywhere** (test: a marked text is in no table, signal or log).

## `slack-client.ts`: the one place that talks to Slack (`slack.com`, through the `UpstreamClient`)

`exchangeCode` (`oauth.v2.access`, client secret; the PKCE verifier is not sent), `identify`
(`auth.test` + `users.info`: workspace, user, address), `revoke` (`auth.revoke`), `userCall`
(member's token: operator stop (`slack` or `*`) → app present → on → vault → member → grant
active → scope granted → call), `botCall` (switches → bot token), `verifySignature`. Slack's
`{ ok: false, error }` → `refused` with the short `slackError` only. No retries; a write lost
after sending is `unknown` (never re-sent). One AI-action-log line per call (`record`), never
content. **Token rotation must be off** in the company's Slack app: the member's `xoxp-` token
does not expire and is what the vault keeps in the refresh token's place; an answer with a
`refresh_token` is refused (`token-rotation-on`).

Features → user scopes (always with `users:read`, `users:read.email`): `read` 自分あての DM と
メンションを読む = `im:history`, `mpim:history`, `channels:history`, `groups:history`; `reply` 返事を送る
= `chat:write`. A feature counts only when all its scopes are granted (`slackFeaturesOf`).

## `slack-connector.ts`

- Registers Slack with member-oauth. The sign-in URL (`/oauth/v2/authorize`) carries `client_id`,
  `user_scope` (no bot `scope`), `redirect_uri` (`/api/oauth/slack/callback`), `state` and
  `team` (the company's workspace). `identify` refuses **another workspace even with the same
  address** (the token is revoked, nothing stored); member-oauth then requires the address to be
  the member's own ACB email.
- Owner/admin: `adminView`, `saveApp { teamId, clientId, clientSecret?, signingSecret?,
  botToken? }` (secrets required the first time, kept when left out; a bot token is checked
  with `auth.test` and must be of the app's workspace, else `BOT_TOKEN_REJECTED`, nothing saved;
  another workspace or client id ends every grant `revoked` `app-changed`; no vault → 503
  `BROKER_OFF`), `setEnabled`, `stopGrant` (revoked at Slack too). Member: `my`, `connect
  { features }`, `disconnect`.
- `roleConnector()`: Slack serving `chat` (receive, reply), usable while the app is set up, on,
  the vault on and no operator stop (A3 registers it with `connector-roles`).
- `sendNoticeDm(companyId, userId, text)`: only to a current member with an active grant, to the
  Slack user remembered for the grant's address, by the company's bot (`conversations.open`,
  `chat.postMessage`); the text is never stored or logged.

## Events (`routes/slack.ts` `createSlackRoute`, `services/slack-events.ts`)

`POST /api/slack/events/:companyId` (public; **the URL never changes**: each company registers
it). Order: company id shape → **signature** `v0=` HMAC-SHA256 of `v0:<ts>:<raw body>` with
**that company's** signing secret, within 5 minutes (unsigned, wrong secret, stale, changed body,
unknown company → the same empty 401) → JSON → `url_verification` (answer the challenge) → the
envelope's `team_id` must be the company's (else ignored) → app on, operator stop, vault (a stop
answers 200 and drops: Slack would retry otherwise) → event id once → signals. Body ≤ 1 MB.

A **signal** (`SlackSignal`: member, kind `dm` / `mention` / `broadcast`, channel, ts, thread,
sender's Slack id, `external` for Slack Connect or a sender of another workspace) goes to
`onSignal` (B2). The text is read only in memory: `<@U…>` mentions, `<!channel|here|everyone>`.
DMs and broadcasts go to the event's `authorizations` (non-bot, same workspace); mentions to the
mentioned users. Left out: bots (`bot_id`), edits and other subtypes, the sender themselves,
members without an active grant that reads (`read` granted and not in `features_off`) or no
longer members. Slack lists only one authorization per event; reaching every member of a
broadcast needs `apps.event.authorizations.list` (B2 / A3).

## Tests

`server/tests/integration/slack-connector.test.ts` against `tests/fakes/slack/fake-slack.ts`
(practice values only: `fake-slack-secret-`, `fake-slack-signing-`, `xoxp-fake-`, `xoxb-fake-`):
grant only for one's own address in the company's workspace (another account / workspace /
rotation → nothing, token revoked), scope per feature, admin-only management, every stop from
the next call (admin, switch, operator, 「許可をやめる」, stop-all, removed member), never crossing
companies (grants, admins, signatures, workspaces, Slack accounts, bot), the signature rules, what
becomes a signal, **no secret or message text in any table, answer or log**. Mutation-checked:
signature, freshness, workspace check (events and sign-in), event-once, grant status, `read`
feature, sender skip, bot skip, switches, membership, scope, rotation refusal, bot workspace,
admin role.
