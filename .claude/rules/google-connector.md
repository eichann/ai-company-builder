---
paths:
  - "shared/core/google.ts"
  - "shared/types/google.ts"
  - "server/src/ports/connectors.ts"
  - "server/src/adapters/sqlite/connectors.ts"
  - "server/src/services/google-client.ts"
  - "server/src/services/google-connector.ts"
  - "server/src/services/google-mail.ts"
  - "server/tests/integration/google-inbox.test.ts"
  - "server/src/services/member-oauth.ts"
  - "server/src/routes/google.ts"
  - "server/src/routes/oauth.ts"
  - "server/tests/integration/google-connector.test.ts"
  - "server/tests/fakes/google/**"
  - "admin/src/app/companies/*/integrations/google.tsx"
  - "client/electron/features/google/**"
  - "client/src/features/settings/**/*oogle*"
  - "client/shared/google.ts"
  - "client/tests/google-connect.test.ts"
  - "admin/tests/integrations.test.tsx"
---

# The Google connection (milestone 4 G3: 「Google で許可」)

A member allows ACB to use part of their Google account (read their calendar and the Meet
minutes; send mail they confirmed; read their received mail, 受信を読む); the server holds that permission like a key and is the only
place that talks to Google. The member's grant, the pending start, the callback and the stops
are the provider-neutral `services/member-oauth.ts` (`member-oauth.md`); Google is its first
provider (`createGoogleConnector` registers the descriptor). Design: 節目4 設計案 §2-2 N1, §3-2, §3-8, §4-5, §4-6, §5-2, §9 q10.
Owner decisions: the member allows it themselves; the Google account must be **the member's own
ACB email** (case-insensitive), verified, in the company's Workspace domain (no private Gmail);
ask only for what a feature needs, when first needed; never `drive`, `drive.readonly`,
`gmail.compose`, `gmail.metadata`, `gmail.modify`, `https://mail.google.com/` or domain-wide
delegation (`GOOGLE_NEVER_SCOPES`). `gmail.readonly` is allowed only as the `inbox` feature
(owner decision 2026-11-01, spec §7-1; each company registers its own internal app, so no
Google review). Drive (`drive.file` + Google Picker): `google-drive.md`. Google is a built-in
core connector serving the roles 予定を読む / メールを読む・送る / 会議の記録を読む
(`connector-roles.md`): the core services reach it only through the role ports.

## What is stored where (all behind the company handle, `connectors`)

- `google_oauth_clients` (one per company): client id, the **client secret sealed** by the key
  broker's vault (`vault.sealConnector`, purpose `acb-google-client`, bound to the company), its
  last 4, the Workspace domain (lower case), `enabled`, created/updated/by.
- `connector_grants` (per company, member, provider `google`): `grant_id` (new at every consent),
  the Google account email, granted scopes (JSON, only `GOOGLE_ALLOWED_SCOPES`), `features_off`
  (the member's own switches, enforced by `google-client.ts`: `member-oauth.md`), the **refresh token sealed** (purpose `acb-google-grant` =
  `grantSealContext('google', …)`, bound to the grant id) — `NULL` unless `active`
  (CHECK) —, `status` active / revoked / stopped + reason, created / updated / `last_used_at`.
- `oauth_pending`: a started 「Google で許可」 — only the **sha256 of the state**, the **PKCE
  verifier sealed** (purpose `acb-oauth-pending`), member, requested scopes, 10 minutes, single
  use (`DELETE … RETURNING`); a member's new start removes their earlier ones.
- `connector_history`: every change (client, on/off, grant new / replaced / added, stopped,
  revoked, stop-all) as JSON without any secret.
- `google_oauth_clients.picker_api_key` / `picker_app_id`: Google Picker's registration
  (`google-drive.md`); `google_drive_picks` / `google_drive_puts` (Drive's picks and receipts).
- The **access token** lives only in `google-client.ts`'s memory (per company, member and grant),
  until Google's expiry minus a minute and never more than 1 hour. It is dropped when a grant
  ends, the client or switch changes, or Google answers 401.
- Nothing secret is ever answered, logged or stored in plain text (test below). Seals use the
  broker's KEK; without one (`vault-off`) nothing can be registered or used. `rewrapAll` (KEK
  rotation) does not yet re-wrap these rows — `envelopeSecretCipher(current, previous)` keeps
  opening them while the old KEK is loaded.

## Scopes (`shared/core/google.ts`)

`minutes` (予定と議事録を読む) = `calendar.events.readonly`, `meetings.space.readonly`,
`drive.meet.readonly`; `mail` (メールを送る) = `gmail.send`; `drive` (Drive で選んだものを読む・置く)
= `drive.file` (`google-drive.md`); `inbox` (受信を読む) = `gmail.readonly`; each with `openid email`.
`googleScopesFor`, `googleFeaturesOf` (a feature counts only when all its scopes are granted),
`normalizeGrantedScopes` (Google's report → allowed long forms only), `googleFeatureOfScope`
(each feature scope belongs to one feature), `googleFeaturesOff`.

## Routes (`routes/google.ts` → `services/google-connector.ts`; `routes/oauth.ts` → `services/member-oauth.ts`)

- Owner/admin, `/api/companies/:id`: `GET /google` (`GoogleAdminView`: configured, client id,
  secret last 4, domain, enabled, the **redirect URI** `<PUBLIC_URL>/api/oauth/google/callback`
  (`lib/config.ts` `publicUrl`), `practice`, `operatorStopped`, vault on, members' grants, the
  latest 50 history lines); `PUT /google/client { clientId, clientSecret?, domain }` (secret
  required the first time; left out = kept; who → body → vault (503 `BROKER_OFF`) → practice
  (400 `REAL_KEY_ON_PRACTICE`); a changed client id or domain ends every grant as `revoked`
  `client-changed`); `PUT /google/enabled { enabled }` (404 `NOT_CONFIGURED` before a client);
  `DELETE /google/grants/:userId` (revoke at Google, then `stopped` `admin`; another company's
  member → 404 like a missing one, `CROSS` row). Errors other than the role check are Japanese.
- Any member: `GET /me/google` (`MyGoogle`: available + reason `not-configured` / `off` /
  `vault-off` / `operator-stopped`, connected, status, Google email, features, `featuresOff`, domain, practice);
  `PUT /me/google/features { feature, on }` — the member turns one allowed feature off / on (400
  bad body; 409 `GOOGLE_NOT_CONNECTED` without an active grant, `GOOGLE_FEATURE_NOT_GRANTED` for a
  feature not allowed);
  `POST /me/google/connect { features }` → `{ authorizeUrl, expiresAt }` (409
  `GOOGLE_UNAVAILABLE` + reason); `DELETE /me/google` 「許可をやめる」 (revoke at Google — best
  effort —, then the row is deleted; always 200).
- Public `GET /api/oauth/google/callback?code&state[&error]` — the `google` case of
  `/api/oauth/:provider/callback` (listed in `auth-guards.test.ts`; matrix row: 400 for everyone
  without a state). This exact path is each company's registered redirect URI: never move it. Answers a small Japanese page (one sentence,
  `no-store`, `no-referrer`, a strict CSP), 200 「許可しました。アプリに戻ってください。」 or 400 with
  a plain refusal; never a secret, nobody's email. The request log prints no query.

## The authorization request

`client_id`, `redirect_uri`, `response_type=code`, `scope` (the asked features plus the ones
already allowed), `state = <companyId>.<64 hex>`, PKCE `S256` (verifier 64 hex, challenge
base64url of its sha256), `access_type=offline`, `include_granted_scopes=true`, `hd = domain`,
`login_hint` = the member's ACB email, and `prompt=consent` **only when the member has no active
grant** (a refresh token comes only with a consent).

## The callback (`memberOAuth.callback('google', …)` with Google's descriptor)

1. The state must be `<companyId>.<64 hex>`; the company's handle is opened from it and the
   pending row is taken **inside that company only** by the sha256 of the whole state (the
   company is inside the hashed value too), and must be a `google` start. Another company's state, a forged, reused or expired
   one → 「この許可の手続きは使えません…」, nothing stored. Google's `error` → 「Google で許可され
   ませんでした」.
2. Switches (operator stop file, client present and on, vault) and membership again.
3. The code is exchanged with the verifier (`client_secret_post`); userinfo
   (`www.googleapis.com/oauth2/v3/userinfo`, the descriptor's `identify`): `email_verified`,
   `hd` = domain and the email's domain = domain; then (member-oauth) the email = the member's ACB email (`sameEmail` → `normalizeEmail`). Any
   refusal revokes the tokens Google just issued and stores nothing.
4. A refresh token → a new grant (`putGrant`, new `grant_id`). None (incremental consent) → the
   stored token is kept and only the scopes change; with no active grant → refused.
5. **A re-consent replaces the old refresh token locally but does not revoke it at Google**:
   Google's revoke ends the person's whole consent for the app, which would kill the new token
   too (unverified against real Google; the fake revokes only the one token). The 100-tokens-per-
   account limit makes Google drop the oldest silently, and a member re-consents rarely.

## `google-client.ts`: the one place that talks to Google

`googleClient.request(companyId, userId, { api: 'calendar'|'meet'|'drive'|'gmail', method, path,
query?, body?, rawBody? (Drive's multipart upload), binary? (an answer's bytes), scope, operation })` → `{ ok: true, status, json, text }` (`text` when the answer
is not JSON, e.g. Drive export) or `{ ok: false, kind: 'not-sent'|'refused'|'rate-limited'|
'server-error'|'unknown', reason, status?, googleReason? }`. `googleReason` is Google's short code
only (never its message). Hosts: calendar / drive / userinfo `www.googleapis.com`, meet
`meet.googleapis.com`, gmail `gmail.googleapis.com`, token / revoke `oauth2.googleapis.com`;
through the key broker's `UpstreamClient` (address checks, no redirects). Before every attempt,
in order: operator stop file (`<PLUGINS_DIR>/stopped` with `google` or `*`) → client present →
on → vault → still a member → grant (`no-grant` / `grant-revoked` / `grant-stopped`) → scope
granted (`scope-not-granted`) → the scope's feature not turned off by the member
(`feature-off`, `connector_grants.features_off`; also for the Picker's token) → access token (refresh; `invalid_grant` → the grant becomes
`revoked` `invalid_grant`, only if it is still that grant). A 401 drops the access token and
retries once. Reads (GET) retry 429 / 5xx / failures before sending (1 s, 2 s, Retry-After ≤
10 s; 2 retries); **writes are never retried** — an answer lost after sending is `unknown`
(never re-send a mail blindly). Every sent call touches `last_used_at` and records one AI-action-
log line (`agent_events`: category `broker`, agent `script`, tool `google:<operation>`, target
`{ kind: 'broker', service: 'google', host, path: <operation>, status }` — no content). The AI
emergency stop (M2) is not checked here: callers decide (a person's send passes, design §4-5).

## Stops (each from the next call; test 「every stop works from the next call」)

Company switch off · admin 「止める」 one member · 「すべての鍵を止める」 (`POST /broker/stop-all`
→ `keyBroker` `onStopAll` → `memberOAuth.stopAll`: every active grant of every provider `stopped` at once, tokens cleared, revoked at
Google in the background) · the member's 「許可をやめる」 · the operator's stop file · the member
removed · Google refusing the token. A stopped / revoked grant is resumed only by the member's
「Google で許可」 again.

`pickerToken(companyId, userId)`: the Picker's own `drive.file`-only token (`google-drive.md`),
after the same switches and the grant's `drive.file`.

Users of the grant: the minutes (`minutes.md`), outbound mail (`outbound-mail.md`), Drive
(`google-drive.md`) and
「今日の予定」 (`calendar.md`, `services/google-calendar.ts`: `calendar.events.list` of `primary`
for today; no answer is an error there — a stop becomes an empty list with a reason) — all but
Drive through the role ports (`connector-roles.md`).

## Gmail (`services/google-mail.ts`: the role メールを読む・送る)

- **Read** (`inbox`, `gmail.readonly`; `MailReader`): `listMessages(companyId, userId, { afterMs,
  pageToken?, max? ≤ 50 })` → `users/me/messages?q=after:<seconds>&labelIds=INBOX`, then each
  message's `format=metadata` (From, To, Cc, Subject, Date, Message-ID, In-Reply-To, List-Id,
  List-Unsubscribe, Precedence, Auto-Submitted, X-Autoreply) → `MailSummary` (addresses lower
  case, RFC 2047 subjects decoded, `bulk` = a list / newsletter or the promotions / social /
  forums category, `automated`); `getMessage` → `format=full`, the first text/plain part (else
  the HTML's text), decoded by its charset (ISO-2022-JP too), NFC, at most 20,000 characters.
  Only `users/me`. **Nothing stored, nothing of a message logged** (the client's action-log line
  names `gmail.messages.list` / `.get` only). Failures: `not-connected`, `turned-off`, `stopped`,
  `not-found`, `unavailable`.
- **Send** (`mail`, `gmail.send`; `MailSender`): `senderAccount` (the active grant with
  `gmail.send` and `mail` not off → the Google email; else `consent-needed` / `turned-off`) and
  `send` (`POST users/me/messages/send`, never retried).

## Practice Google (staging)

`ACB_FAKE_GOOGLE_URL` (`lib/config.ts` `practiceUpstreamsFrom`, next to `ACB_FAKE_HUBSPOT_URL`,
same gates: `ACB_ALLOW_FAKE_UPSTREAMS=1`, not production, local `PUBLIC_URL`, a local target with
a port only). **Per service**: it redirects only Google's hosts (`GOOGLE_HOSTS`), HubSpot stays
real unless its own variable is set, and vice versa. On: `adapters/upstream-practice.ts` sends
every Google host to the fake (which keeps Google's paths); the browser's sign-in URL is the
fake's origin (`host.docker.internal` → `localhost` for the browser); only practice values are
saved (client secret `fake-google-secret-…`, 400 `REAL_KEY_ON_PRACTICE`) or sent (`ya29.fake-`,
`1//fake-`, `4/fake-`; anything else → `practice-real-secret`, nothing sent — also a secret saved
before the redirect was on). The admin view says `practice` (「練習用の Google につながっています」);
`index.ts` logs it. The fake: `server/tests/fakes/google/` (`pnpm fake:google`, 127.0.0.1:4011).

## Screens

- Admin 「つなぎ先」→「Google」 (`admin/src/app/companies/[id]/integrations/google.tsx`, owners /
  admins): the redirect URI with 「コピー」, クライアント ID, クライアント シークレット (password
  field, sent once, placeholder shows the last 4; empty = keep), 社内のドメイン, 「Google の設定を
  保存」, 「オンにする / オフにする」, the practice / operator / vault notices, 「メンバーの許可（読む
  もの・送るもの）」 with 「止める」 (confirmation). Words: 「Google で許可」, 予定と議事録を読む /
  メールを送る — no OAuth, scope, token or plugin on screen.
- App 設定 →「Google」 (tab after 「自分の鍵」 in 「AI と連携」:
  `client/src/features/settings/components/GoogleSection.tsx`, `hooks/useGoogle.ts`, ports
  `GoogleReads` / `GoogleOutbound` in `features/settings/api.ts`; words and the view in
  `client/shared/google.ts`). Main: `client/electron/features/google/ipc.ts` —
  `google:status(companyId)`, `google:connect(companyId, features)`, `google:disconnect(companyId)`;
  the session cookie stays in main; answers are the server's `MyGoogle` or a sentence built from
  the status code only (`googleErrorText`); `google:connect` opens the server's sign-in URL in the
  system browser through the shell's `openExternal` only when it is
  `https://accounts.google.com/o/oauth2/v2/auth` (or the practice Google on `127.0.0.1` /
  `localhost` / `[::1]`, same path: `isGoogleSignInUrl`) and **never returns the URL** to the
  renderer. The only Google token on the client is Google Picker's: `drive.file` only, fetched
  by main with the session and handed to the Picker's own window, never stored
  (`google-drive.md`). Shows the account and
  予定と議事録を読む / メールを送る / 受信を読む (「（オフにしています）」 when the member turned one off);
  「Google で許可」 (minutes), 「メールを送る許可も足す」 (mail), 「受信を読む許可も足す」 (inbox),
  「許可をやめる」 (confirmation); after opening the browser 「ブラウザで Google の画面を開きました。
  許可したらこの画面に戻ってください。」 and a check every 3 s for up to 2 minutes. The first status
  load runs from a callback ref (the `useEffect` cap of `architecture-boundaries.test.ts`). Test:
  `client/tests/google-connect.test.ts` (exactly the server's URL opened and never answered; a
  lookalike host, other scheme or path never opened — mutation-checked; refusals / offline →
  status-built sentences only).

## Tests

`server/tests/integration/google-inbox.test.ts` (受信を読む asked only when first needed and
nothing wider; only the member's own mailbox, Japanese mail decoded, nothing stored or logged;
the member's switch refuses the next call before anything leaves while the rest works, survives
a re-consent; メールを送る off; 「つないでいるサービス」), mutation-checked: the `feature-off` check.
`server/tests/integration/google-connector.test.ts` against the fake Google through the practice
redirect: who manages the client; a real secret refused in practice mode and one saved earlier
never sent; the authorization request (PKCE S256, offline, consent only when needed, hd,
login_hint, minutes scopes only); incremental mail; another account / another domain refused
with the issued tokens revoked; another company's / forged / reused / expired / denied state →
nothing stored; a member only their own; every stop on the next call; **no client secret, token,
code or verifier in any answer, log line (all console output, request log mounted) or table**.
Mutation-checked: single use, expiry, the company condition together with the hash, email check,
domain check, revoke of refused tokens, practice refusals (save and use), operator stop, company
switch, membership, grant status, scope, invalid_grant, stop-all hook, the admin role check, a
secret in the view. Also `broker-practice-upstream.test.ts` 「per service: the practice Google
alone leaves HubSpot real」, the permission matrix (+ `CROSS` for `DELETE /google/grants/:userId`),
`auth-guards.test.ts`, `company-scoped-sql.test.ts` (`HANDLE_TABLES`), `admin-contract.test.ts`,
`admin/tests/integrations.test.tsx` 「つなぎ先 → Google」.
