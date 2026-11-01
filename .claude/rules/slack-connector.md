---
paths:
  - "server/src/services/slack-client.ts"
  - "server/src/services/slack-connector.ts"
  - "server/src/services/slack-events.ts"
  - "server/src/services/slack-notices.ts"
  - "server/src/services/slack-chat.ts"
  - "server/src/routes/slack.ts"
  - "server/src/routes/slack-connection.ts"
  - "shared/core/slack.ts"
  - "shared/types/slack.ts"
  - "server/src/ports/slack.ts"
  - "server/src/adapters/sqlite/slack.ts"
  - "server/src/adapters/hmac.ts"
  - "server/src/db/schema/slack.ts"
  - "server/tests/fakes/slack/**"
  - "server/tests/integration/slack-connector.test.ts"
  - "server/tests/integration/slack-notices.test.ts"
  - "server/tests/integration/slack-wiring.test.ts"
  - "admin/src/app/companies/*/integrations/slack.tsx"
  - "client/src/features/settings/components/SlackSection.tsx"
  - "client/src/features/settings/hooks/useSlack.ts"
  - "client/shared/slack.ts"
  - "client/tests/slack-connect.test.ts"
  - "client/electron/features/slack/**"
---

# The Slack connection (stage 3, lane A: A2 / A3)

Slack is a core connector serving the `chat` role (`connector-roles.md`). Two permissions (plan
§5-6): reading a member's DMs and mentions (and replying as them) uses **that member's own user
grant** (`member-oauth.md`, provider `slack`); **notice DMs are sent by the company's bot**. Each
company creates its own internal Slack app in its own workspace. Spec: 統合版 §6-3, §7-1.

**Wiring (A3)**: `composition/connectors.ts` `wireConnectorsLane` builds the client, the
connector (registered with member-oauth and, from the declaration `BUILTIN_CONNECTORS.slack` in
`shared/core/builtin-connectors.ts`, as the `chat` role's connector), the events receiver and the
notice DMs, and 「つないでいるサービス」 with Slack's switch (its app's `enabled`, the operator's stop
file naming `slack` or `*`). `slackSchema` is in `db/index.ts` below the lane A marker. Routes:
`routes/slack-connection.ts` (`slackRoute` at `/api/companies/:companyId`, `slackEventsRoute` at
`/api/slack`), listed in `auth-guards.test.ts` `PUBLIC_ENDPOINTS` (events) and the permission
matrix. Lane B consumes the signals (`services.onSlackSignal` → the inbox, `inbox.md`).

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

Features (`shared/core/slack.ts` `SLACK_FEATURES`) → user scopes (always with `users:read`,
`users:read.email`): `read` 自分あての DM とメンションを読む = `im:history`, `mpim:history`,
`channels:history`, `groups:history`; `reply` 返事を送る = `chat:write`; `notices` 大事な知らせを DM で
受け取る = none more (the bot sends; on with any grant until the member turns it off). A feature
counts only when all its scopes are granted (`slackFeaturesOf`).

## `slack-connector.ts`

- Registers Slack with member-oauth. The sign-in URL (`/oauth/v2/authorize`) carries `client_id`,
  `user_scope` (no bot `scope`), `redirect_uri` (`/api/oauth/slack/callback`), `state` and
  `team` (the company's workspace). `identify` refuses **another workspace even with the same
  address** (the token is revoked, nothing stored); member-oauth then requires the address to be
  the member's own ACB email.
- Routes (`routes/slack-connection.ts`, shapes `shared/types/slack.ts`): owner/admin `GET /slack`,
  `PUT /slack/app`, `PUT /slack/enabled`, `DELETE /slack/grants/:userId`; any member
  `GET /me/slack`, `POST /me/slack/connect { features }`, `PUT /me/slack/features { feature, on }`
  (`features_off`, `member-oauth.md`; 409 `SLACK_NOT_CONNECTED` / `SLACK_FEATURE_NOT_GRANTED`),
  `DELETE /me/slack`. Errors other than the role check are Japanese.
- Owner/admin: `adminView`, `saveApp { teamId, clientId, clientSecret?, signingSecret?,
  botToken? }` (secrets required the first time, kept when left out; a bot token is checked
  with `auth.test` and must be of the app's workspace, else `BOT_TOKEN_REJECTED`, nothing saved;
  another workspace or client id ends every grant `revoked` `app-changed`; no vault → 503
  `BROKER_OFF`), `setEnabled`, `stopGrant` (revoked at Slack too). Member: `my`, `connect
  { features }`, `disconnect`.
- `roleConnector()`: Slack serving `chat` (receive, reply), usable while the app is set up, on,
  the vault on and no operator stop (A3 registers it with `connector-roles`).
- `sendNoticeDm(companyId, userId, text)`: only to a current member with an active grant whose
  `notices` is not off (`feature-off`), to the Slack user remembered for the grant's address, by
  the company's bot (`conversations.open`, `chat.postMessage`); the text is never stored or logged.

## Threads and replies (A4, `services/slack-chat.ts`: the `chat` role's implementation)

Registered in `wireConnectorsLane` (`roleProviders.provide('slack', …)`). `thread`: only with
`read` granted and not off; `conversations.replies` (the history scope of the channel kind), the
newest 30, each ≤ 8,000 characters, names through `users.info` (≤ 10 per thread), `mine` = the
Slack user remembered for the grant's address. `reply`: only with `reply` granted and not off;
`chat.postMessage { channel, thread_ts, text }` (≤ 4,000), a write: never re-sent. Nothing stored
or logged (`outbound-mail.md` "Replies").

## Notice DMs (大事な知らせを Slack の DM で, E-26; `services/slack-notices.ts`)

The notices service's `outside` hook (`notifications.md`, bound in `composition.ts`) hands every
notice it just wrote (engine changes and the server clock's) to `slackNotices.outside` (fire and
forget). A DM is sent only when the notice's record **now waits for that member** —「あなたの番」,
the same rule as `/records/my-turn`: a request type, not final, not an AI turn, `next_actor`
(else `assignee`) is the member or the absentee a delegate's copy is for — one per member and
record, at most 20 per batch. So: handed a task / an approval request / 受けられない back to the
requester / a wait that is over (`wait_over` → the assignee) → a DM; results, due changes and
overdue told to a requester → the bell only. Like the Mac notification it does not follow the
bell's kind switches (being handed a task is the bell's `others`, off by default); the member's
switch is `notices`. The text (`noticeDmText`) is 「ACB：あなたの番です。「<title>」」 (+ 「（不在の人の
代わりとして）」) and 「ACB のアプリで開いてください。」 — **the title only**, never a field, note or
body. Failures are logged as reason codes only (the usual "no grant / off" quietly).

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
mentioned users. The member's **own** message in a DM or a thread reply is a signal `own` for them
(their reply: the inbox ends what it answered, B4). Signals go to the listeners registered with
`services.onSlackSignal` (lane B's 来た連絡). Left out: bots (`bot_id`), edits and other subtypes,
the sender themselves (except `own` above),
members without an active grant that reads (`read` granted and not in `features_off`) or no
longer members. Slack lists only one authorization per event; reaching every member of a
broadcast needs `apps.event.authorizations.list`, which takes an **app-level token** (`xapp-`,
`authorizations:read`) — a third secret the admin would register — and one call per broadcast
(paged). Not done in A3 (not cheap): an @channel reaches only the one authorized member today.

## Screens

- Admin 「つなぎ先」→「Slack」 (`admin/src/app/companies/[id]/integrations/slack.tsx`, owners /
  admins; `slackApi` in `admin/src/lib/api.ts`, pinned by `admin-contract.test.ts`): ワークスペースの
  ID, クライアント ID / シークレット, 署名のシークレット, ボットの鍵 (password fields, sent once and
  emptied, never shown; left empty = kept), 「Slack の設定を保存」, 「オンにする / オフにする」, the
  戻り先 and the fixed 知らせの届け先 with 「コピー」, the note that Token Rotation stays off, the
  practice / operator / vault notices, 「メンバーの許可」 with 「止める」 (confirmation). Test:
  `admin/tests/integrations.test.tsx` 「つなぎ先 → Slack」.
- App 設定 →「Slack」 (tab after 「Google」 in 「AI と連携」: `SlackSection.tsx`, `hooks/useSlack.ts`,
  ports `SlackReads` / `SlackOutbound` in `features/settings/api.ts`; words and the view in
  `client/shared/slack.ts`). Main: `client/electron/features/slack/ipc.ts` (registered under
  lane A in `main.ts`) — `slack:status`, `slack:connect(companyId, features)`,
  `slack:disconnect`, `slack:setFeature(companyId, feature, on)`; the session stays in main;
  answers are the server's `MySlack` or a sentence built from the status and codes only
  (`slackErrorText`); `slack:connect` opens the sign-in URL in the system browser only when it is
  `https://slack.com/oauth/v2/authorize` (or the practice Slack on `127.0.0.1` / `localhost` /
  `[::1]`, same path: `isSlackSignInUrl`) and never returns it. Shows what is allowed,
  「Slack で許可」 (read + notices), 「返事を送る許可も足す」, the checkbox 「「あなたの番」になったら
  Slack の DM で知らせてもらう」 (`notices`), 「許可をやめる」 (confirmation), the browser wait (3 s,
  2 min) like Google. Test: `client/tests/slack-connect.test.ts` (exactly the server's URL opened
  and never answered; lookalike hosts / other schemes / paths never opened; refusals as
  sentences from codes; the switch sends `{ feature, on }` to the member's own permission).

## Practice Slack (staging)

`ACB_FAKE_SLACK_URL` (`lib/config.ts` `practiceUpstreamsFrom`, same gates as `ACB_FAKE_GOOGLE_URL`;
per service) redirects `slack.com` to the fake (`pnpm fake:slack`, `tests/fakes/slack/serve.ts`,
127.0.0.1:4012; `FAKE_SLACK_MEMBER_EMAIL` adds a user with your ACB address; it prints the app
values to register). On: the sign-in URL is the fake's origin; only practice values are saved
(`fake-slack-secret-`, `fake-slack-signing-`, `xoxb-fake-`; else 400 `REAL_KEY_ON_PRACTICE`) or
sent (a bearer token not `xoxp-fake-` / `xoxb-fake-` → `practice-real-secret` in
`adapters/upstream-practice.ts`; a client secret saved before the redirect was on is not sent at
the exchange); the admin view and `MySlack` say `practice`.

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
`server/tests/integration/slack-notices.test.ts` (real engine, notices and connector): a DM only
when the record now waits for the member, title only, not for results / final states / an AI turn,
the member's `notices` switch, no grant, Slack off — mutation-checked (the turn check, the final /
AI check, the switch). `server/tests/integration/slack-wiring.test.ts` (`createServices`, the fake
served on a port): the practice redirect and its refusals (mutation-checked), 「つないでいるサービス」
and the `chat` role, the events receiver's signature per company.
