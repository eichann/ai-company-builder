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
  - "server/tests/integration/google-one-consent.test.ts"
  - "client/src/features/settings/connectTools*.ts"
  - "client/src/features/settings/components/ConnectToolsScreen.tsx"
  - "client/src/features/settings/hooks/useConnectTools.ts"
  - "client/tests/ui/connect-tools.spec.ts"
  - "admin/tests/integrations.test.tsx"
  - "shared/core/google-relay.ts"
  - "server/src/services/google-relay.ts"
  - "server/tests/integration/google-relay.test.ts"
  - "admin/src/components/key-broker/google-relay.tsx"
  - "client/src/features/settings/components/GoogleRelayCard.tsx"
  - "client/src/features/settings/hooks/useGoogleRelay.ts"
---

# The Google connection (milestone 4 G3: 「Google で許可」)

A member allows ACB to use part of their Google account (read their calendar and the Meet
minutes; send mail they confirmed; read their received mail, 受信を読む); the server holds that permission like a key and is the only
place that talks to Google. The member's grant, the pending start, the callback and the stops
are the provider-neutral `services/member-oauth.ts` (`member-oauth.md`); Google is its first
provider (`createGoogleConnector` registers the descriptor). Design: 節目4 設計案 §2-2 N1, §3-2, §3-8, §4-5, §4-6, §5-2, §9 q10.
Owner decisions: the member allows it themselves; the Google account must be **the member's own
ACB email** (case-insensitive), verified, in the company's Workspace domain (no private Gmail);
ask only for the features the company turned on — all of them in one consent (「仕事の道具をつなぐ」,
owner decision 2026-11-02, "One consent" below), a feature turned on later once more or when first
used; never `drive`, `drive.readonly`,
`gmail.compose`, `gmail.metadata`, `gmail.modify`, `https://mail.google.com/` or domain-wide
delegation (`GOOGLE_NEVER_SCOPES`). `gmail.readonly` is allowed only as the `inbox` feature,
off for a company until its admin turns it on (owner decisions 2026-11-01 / 11-02, spec §7-1; each company registers its own internal app, so no
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
- Every refused Google call logs its operation, status and Google's short reason (`[google] call
  refused`, never the message): `minutes.md` "When Google refuses the text".
- Nothing secret is ever answered, logged or stored in plain text (test below). Seals use the
  broker's KEK; without one (`vault-off`) nothing can be registered or used. `rewrapAll` (KEK
  rotation) does not yet re-wrap these rows — `envelopeSecretCipher(current, previous)` keeps
  opening them while the old KEK is loaded.

## Scopes (`shared/core/google.ts`)

`minutes` (予定と議事録を読む) = `calendar.events.readonly`, `meetings.space.readonly`,
`drive.meet.readonly`; `mail` (メールを送る) = `gmail.send`; `drive` (Drive で選んだものを読む・置く)
= `drive.file` (`google-drive.md`); `inbox` (受信を読む) = `gmail.readonly`; `sheets`
(スプレッドシートを中継で使う) = `spreadsheets` (the relay, below); each with `openid email`.
`googleScopesFor`, `googleFeaturesOf` (a feature counts only when all its scopes are granted),
`normalizeGrantedScopes` (Google's report → allowed long forms only), `googleFeatureOfScope`
(each feature scope belongs to one feature), `googleFeaturesOff`.

## One consent (「仕事の道具をつなぐ」, owner decision 2026-11-02)

- **Company features**: the admin's per-feature switch (`PUT /google/features`, history
  `features`) over each feature's default: 予定と議事録 and メールを送る are on until turned off
  (`GOOGLE_COMPANY_DEFAULT_OFF` is empty). Stored as `google_oauth_clients.features_off`
  (default-on features turned off) and `features_on` (default-off features turned on), both JSON
  default `[]` (`migrateGoogleCompanyFeatures`, lane A), so a company that never chose keeps the
  defaults (`googleCompanyFeatureOn`, `googleCompanySwitched`).
- **受信を読む (`inbox`) is not a Google switch** (owner decision 2026-11-02, `tasks.md` "Each
  member's switches"): the company's switch is the task settings' `readIncoming.allowed`
  (default allowed; `PUT /google/features { feature: 'inbox' }` writes it, history line kept —
  the same switch also covers Slack's reading), and each member has their own (default off;
  `PUT /me/google/features { feature: 'inbox' }` writes it). Before 2026-11-02 the company
  switch was Google's own and off until the admin turned it on; a stored `features_on: ['inbox']`
  is no longer read.
- What the company offers = `googleCompanyFeatures` (every feature on, Drive only with the
  Picker registered); what **a member** is offered = `googleMemberFeatures`: 受信を読む only while
  their own 受信を読む is on (`MyGoogle.companyFeatures`, `{ all }`, 「あとで」). The admin
  view's `featuresOff` lists every feature off for the company, the defaults included. A feature off is **never asked** (also not one the member
  allowed before: `googleFeaturesToAsk` = asked ∩ offered ∪ granted ∩ offered — granted ∩ the
  company's offer, so a member's 受信を読む switched off keeps its scope over a re-consent) and its calls are
  refused from the next one (`google-client.ts` `scopeStop` → `off`, before anything leaves);
  members' grants keep the scope until they re-consent or stop. Asking 受信を読む by name
  (`{ features: ['inbox'] }`, an older app's 「受信を読む許可も足す」) is the member's own choice: their
  受信を読む turns on.
- `POST /me/google/connect { all: true }` asks the union of what the company offers in one
  consent (incremental, `include_granted_scopes`) and marks it **seen**; `{ features }` (asked when
  first used: Drive's Picker, a mail card) still works for offered features only (409
  `GOOGLE_FEATURE_COMPANY_OFF`).
- **Seen** (`connector_setup_seen`, per company, member, provider; `ConnectorRepository.setupSeen`
  / `addSetupSeen`): the features the app's screen already showed — connected, unticked on
  Google's page or 「あとで」 (`PUT /me/google/seen`, Slack: `PUT /me/slack/seen`). Kept across
  「許可をやめる」. `MyGoogle.companyFeatures` / `seen` carry both; the screen opens by itself only
  for an offered feature neither granted nor seen, so a member who unticks scopes is told once
  and never asked in a loop.
- App: `ConnectToolsScreen.tsx` (first run from `app/AppDialogs.tsx`, and 設定 →「仕事の道具をつなぐ」),
  rules in `features/settings/connectTools.ts` (`connectToolsOffer` decided once at load and kept
  while the member connects; `connectToolsView`; `googleDeclinedText`), `hooks/useConnectTools.ts`.
  IPC (lane A): `google:connectAll`, `google:markSeen`, `slack:markSeen`; Slack's button reuses
  `slack:connect` with `SLACK_SETUP_FEATURES` (`read`, `notices`) and shows only when the company
  registered Slack. Words: what each connection lets the member do (`TOOL_GOOGLE_TEXT`), no
  OAuth / scope / token.

## The relay with the member's own permission (「本人の許可で中継する」, owner decision 2026-11-04)

A script on the member's PC (anken-sync's coefficient table, …) calls
`$ACB_GOOGLE_BASE_URL/sheets/v4/spreadsheets/…` with `Authorization: Bearer $ACB_GOOGLE_API_KEY` —
the key broker's short-lived token (K6, `key-broker.md`: `google` is a granted service once the
company offers the relay, so released apps already set both variables). The key broker's relay
(`services/broker-relay.ts`, `personRelays`) takes the token's member (`brokerTokens.holder`: live,
a member, `google` in the token — nothing the request names) and hands the call to
`services/google-relay.ts`, which sends it through `googleClient.request` **with that member's own
grant** — never a key, never a service account — so every switch above applies from the next call.

- **Scope / feature** `sheets` = `spreadsheets`: no per-file designation (any sheet the member can
  edit; Google refuses the rest). Default off for a company (`GOOGLE_COMPANY_DEFAULT_OFF`): the
  admin turns it on as a relay service (`PUT /google/relay { services: { sheets } }` writes the
  company feature switch, history `features`). Never in the one consent (`GOOGLE_ASKED_BY_NAME_ONLY`,
  `googleMemberFeatures`): asked only when the member names it (`POST /me/google/connect
  { features: ['sheets'] }`); 「やめる」 = `PUT /me/google/features { feature: 'sheets', on: false }`.
  The 「会社で使うもの」 list on 「つなぎ先 → Google」 leaves it out (it lives under 「API キー」).
- **What passes** (`shared/core/google-relay.ts`, the one copy): only `/sheets/…` (else
  `ACB_NOT_RELAYED`); `parseSheetsCall` — `GET spreadsheets/<id>`, values `get` / `batchGet` /
  `update` (PUT) / `batchUpdate` / `append`, `POST spreadsheets/<id>:batchUpdate`; **never a
  deletion**: `values/<range>:clear`, `values:batchClear(ByDataFilter)` and a batchUpdate with any
  `delete…` / `clear…` request → 403 `ACB_DELETE_REFUSED`; other batchUpdate kinds only from
  `SHEETS_BATCH_UPDATE_ALLOWED` (insertDimension, insertRange, appendDimension, appendCells,
  addSheet, autoResizeDimensions, updateDimensionProperties, updateBorders, unmergeCells, and
  copyPaste only with exactly one paste type `PASTE_FORMULA` — anken-sync's write_keisu.py copies
  the formula columns into the row it inserted), one camelCase kind per request, ≤ 500 — any other
  kind → `ACB_NOT_RELAYED`. Left out because they wipe like a deletion (review of #580):
  updateCells (`fields: *` without rows), repeatCell (an empty cell), mergeCells (keeps only the
  top-left value), updateSheetProperties (a smaller `gridProperties.rowCount` / `columnCount`
  deletes rows / columns), copyPaste of values, cutPaste, sortRange, findReplace. Query parameters
  only from `SHEETS_QUERY_ALLOWED` (`key` dropped; `access_token` & co. refused). Method-override
  headers refused. Nothing of the client's headers is forwarded (the Google client builds its
  own). The path sent on is the raw path without its first segment.
  Overwriting cells with values (also empty ones) is an edit and passes.
- **Order, all before anything leaves ACB**: token → the company's AI stop (M2) → path → the
  company-wide relay stop → this member's relay stop → the company's service switch → the call →
  query → body (JSON ≤ 10 MB; batchUpdate kinds) → the AI stop, both relay stops and the service
  switch again (a stop pressed while the body arrived applies) → the member's daily cap (default 500, admin
  1–10000; counted in `broker_usage` under the key id `person-relay:google`, before sending, like
  the key caps) → `googleClient.request` (operator stop, client on, vault, member, grant, scope,
  company feature, the member's own 「やめる」). No person is asked (auto + ledger).
- **Answers**: Google's JSON as is; Google's refusal (403: no edit permission on that sheet, 404)
  with Google's status in Google's error shape `{ error: { code, status, message } }` (Japanese
  message, never Google's text); ACB's own refusals in the broker's error shape
  (`ACB_DELETE_REFUSED`, `ACB_NOT_RELAYED`, `ACB_GOOGLE_NOT_ALLOWED` — 「設定 → Google で…［許可する］」,
  `ACB_GOOGLE_OFF`, `ACB_STOPPED`, `ACB_OVER_CAP`). A write is never retried; a lost answer → 504.
- **Records**: one AI-action-log line per call, filed by the broker relay (tool `broker:google`,
  target `{ kind: 'broker', service: 'google', host: 'sheets.googleapis.com', path: <decoded path,
  spreadsheet id and range>, operation, status, bytesIn, bytesOut }`, the conversation and
  department of the token; `googleClient` adds none: `recordedByCaller`). Refusals: deletion →
  guard-denied `no-deletion`, unlisted → `destination-not-allowed`, no permission →
  `key-not-available`, cap → `over-cap`, stops / Google off → `stopped`. Never a cell's content.
  Refusals do not count against the cap; past `GOOGLE_RELAY_REFUSALS_PER_DAY` (200) refused calls
  of one member in a day they are still refused but not recorded (a looping script cannot flood
  the log; counted in `broker_usage` under `person-relay:google:refused`).
- **Accepted residual risks** (owner): a formula written into a sheet (`=IMPORTDATA()`, `=IMAGE()`)
  makes Google fetch outside URLs; a sheet the member can edit can be overwritten with values (no
  per-file designation, decision §2-7).
- **Admin** (owner/admin): `GET /google/relay` (`GoogleRelayAdminView`: available, services,
  `capPerMemberPerDay`, `stopped`, members who allowed / were stopped with today's count, the latest
  100 records); `PUT /google/relay { services?, capPerMemberPerDay?, stopped? }` (history `relay`);
  `PUT /google/relay/members/:userId { stopped }` (history `relay-member`; another company's member
  → 404 like an unknown one). Stored as `google_oauth_clients.relay` JSON (`migrateGoogleRelay`).
  A member stop survives the member's re-consent (it is not on the grant).
- **Member**: `GET /me/google/relay` (`MyGoogleRelay`: offered / allowed / turned off per service,
  `stopped: company | member | null`, cap and today's count, their own latest 50 records only).
- **Screens**: admin 「API キー」→ card 「本人の許可で中継する」
  (`admin/src/components/key-broker/google-relay.tsx`, owners / admins): the services as
  checkboxes (スプレッドシート; 「あとから足せるもの」 lists `GOOGLE_RELAY_LATER`), 1人あたりの上限,
  全員の中継を止める / 再開 (asks first), 許可しているメンバー with today's count and
  この人の中継を止める / 再開 (asks first), the records (filter by person). App 設定 → Google →
  「スプレッドシートを中継で使う」 (`GoogleRelayCard.tsx`, `hooks/useGoogleRelay.ts`, shown only
  while the company offers it, `googleRelayCardView`): ［許可する］ = 「Google で許可」 for `sheets`
  (consent), or, when the member only turned it off, back on without a consent; ［やめる］ (asks
  first) = the member's own switch; the admin's stop; the member's own records. IPC (lane A):
  `google:relay`, `google:setRelay(companyId, on)` (main sends only `{ feature: 'sheets', on }`;
  answers the server's `MyGoogleRelay` or a status sentence). Record words:
  `googleRelayRecordWords` (shared/core). Tests: `client/tests/google-relay-card.test.ts`,
  `client/tests/google-connect.test.ts` (setRelay), `admin/tests/google-relay.test.tsx`.
- The name `google` is reserved in the key broker (`PERSON_RELAY_SERVICES`): no company key
  (400 `SERVICE_RESERVED`), no generic service id.
- Token lifetime: the app renews per chat turn (≥ 10 minutes left, `REFRESH_MARGIN_MS`); one turn
  longer than what is left gets `ACB_TOKEN_INVALID` (a gap shared with every broker service).
- Test: `tests/integration/google-relay.test.ts` (each deletion form and unlisted call refused with
  nothing sent and the sheet unchanged; no permission / 「やめる」 / service off / Google off /
  company stop / member stop / cap refused with nothing sent; another member's token acts as that
  member (Google refuses their write to Sato's sheet); another company never reaches a grant here;
  records for admins and the member's own only; no cell content, broker token or Google token in
  any table, answer or log line; asked only by name), mutation-checked: the batchUpdate check, its
  delete and allow-list rules, one kind per request, `values:clear` / `batchClear`, both stops, the
  cap, the query allow-list, never in the one consent, the records' result.

## Routes (`routes/google.ts` → `services/google-connector.ts`; `routes/oauth.ts` → `services/member-oauth.ts`)

- Owner/admin, `/api/companies/:id`: `GET /google` (`GoogleAdminView`: configured, client id,
  secret last 4, domain, enabled, the **redirect URI** `<PUBLIC_URL>/api/oauth/google/callback`
  (`lib/config.ts` `publicUrl`), `practice`, `operatorStopped`, vault on, members' grants, the
  latest 50 history lines); `PUT /google/client { clientId, clientSecret?, domain }` (secret
  required the first time; left out = kept; who → body → vault (503 `BROKER_OFF`) → practice
  (400 `REAL_KEY_ON_PRACTICE`); a changed client id or domain ends every grant as `revoked`
  `client-changed`); `PUT /google/enabled { enabled }` (404 `NOT_CONFIGURED` before a client);
  `PUT /google/features { feature, on }` (company-level switch, "One consent");
  `DELETE /google/grants/:userId` (revoke at Google, then `stopped` `admin`; another company's
  member → 404 like a missing one, `CROSS` row). Errors other than the role check are Japanese.
- Owner/admin and any member: the relay's routes (`/google/relay…`, `/me/google/relay`), above.
- Any member: `GET /me/google` (`MyGoogle`: available + reason `not-configured` / `off` /
  `vault-off` / `operator-stopped`, connected, status, Google email, features, `featuresOff`, domain, practice);
  `PUT /me/google/features { feature, on }` — the member turns one allowed feature off / on (400
  bad body; 409 `GOOGLE_NOT_CONNECTED` without an active grant, `GOOGLE_FEATURE_NOT_GRANTED` for a
  feature not allowed);
  `POST /me/google/connect { features } | { all: true }` → `{ authorizeUrl, expiresAt }` (409
  `GOOGLE_UNAVAILABLE` + reason, `GOOGLE_FEATURE_COMPANY_OFF`); `PUT /me/google/seen` (「あとで」); `DELETE /me/google` 「許可をやめる」 (revoke at Google — best
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
(`feature-off`, `connector_grants.features_off`; also for the Picker's token; for `gmail.readonly`
the company's 受信を読む → `off` and the member's own → `feature-off`, `readIncoming` dep) → access token (refresh; `invalid_grant` → the grant becomes
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

- **Read** (`inbox`, `gmail.readonly`, off for a company until its admin turns it on; `MailReader`): `listMessages(companyId, userId, { afterMs,
  pageToken?, max? ≤ 50, label? })` → `users/me/messages?q=after:<seconds>&labelIds=INBOX` (`label: 'sent'`
  → `labelIds=SENT`: what the member sent, from any device — the inbox's poll lists both, owner FB
  #19, `inbox.md` "The member's own reply"), then each
  message's `format=metadata` (From, Sender, To, Cc, Subject, Date, Message-ID, In-Reply-To, References, List-Id,
  List-Unsubscribe, Precedence, Auto-Submitted, X-Autoreply) → `MailSummary` (addresses lower
  case, RFC 2047 subjects decoded, `bulk` = a list / newsletter or the promotions / social /
  forums category, `automated`, `sender` — handed to the inbox as `senderAddress` only to tell a
  connected service's notification mail, `inbox.md`); `getMessage` → `format=full`, the first text/plain part (else
  the HTML's text), decoded by its charset (ISO-2022-JP too), NFC, at most 20,000 characters;
  `getThread` → `users/me/threads/<id>?format=full` (the card's 元のスレッド: the newest 20, 8,000
  characters each).
  Only `users/me`. **Nothing stored, nothing of a message logged** (the client's action-log line
  names `gmail.messages.list` / `.get` only). Failures: `not-connected`, `turned-off`, `stopped`,
  `not-found`, `unavailable`.
- **Send** (`mail`, `gmail.send`; `MailSender`): `senderAccount` (the active grant with
  `gmail.send` and `mail` not off → the Google email; else `consent-needed` / `turned-off`) and
  `send` (`POST users/me/messages/send`, never retried; a reply adds `threadId`).

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
`index.ts` logs it. The fake: `server/tests/fakes/google/` (`pnpm fake:google`, 127.0.0.1:4011);
its Sheets (`sheets.googleapis.com` is in `GOOGLE_HOSTS`) honour the token's scopes and each
spreadsheet's editors / readers; the seed (and so the staging kit) has 「練習用 係数表」 and a
read-only budget, and the kit's seed turns the relay on (`once('google-relay')`).

## Screens

- Admin 「つなぎ先」→「Google」 (`admin/src/app/companies/[id]/integrations/google.tsx`, owners /
  admins): the redirect URI with 「コピー」, クライアント ID, クライアント シークレット (password
  field, sent once, placeholder shows the last 4; empty = keep), 社内のドメイン, 「Google の設定を
  保存」, 「オンにする / オフにする」, the practice / operator / vault notices, 「会社で使うもの」 (one 「オフにする / オンにする」 per feature; Drive notes it needs the Picker), 「メンバーの許可（読む
  もの・送るもの）」 with 「止める」 (confirmation). Words: 「Google で許可」, 予定と議事録を読む /
  メールを送る — no OAuth, scope, token or plugin on screen.
- App 設定 →「Google」 (tab after 「自分の鍵」 in 「AI と連携」:
  `client/src/features/settings/components/GoogleSection.tsx`, `hooks/useGoogle.ts`, ports
  `GoogleReads` / `GoogleOutbound` in `features/settings/api.ts`, whose status and 「許可をやめる」
  answers also go to `src/shared/lib/googlePermission.ts` so the task list re-reads today's
  calendar when the permission changed (`tasks-ui.md`); words and the view in
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
  「Google で許可」 (minutes), 「メールを送る許可も足す」 (mail), 「受信を読む許可も足す」 (inbox; both only when the company offers them),
  「許可をやめる」 (confirmation); after opening the browser 「ブラウザで Google の画面を開きました。
  許可したらこの画面に戻ってください。」 and a check every 3 s for up to 2 minutes. The first status
  load runs from a callback ref (the `useEffect` cap of `architecture-boundaries.test.ts`). Test:
  `client/tests/google-connect.test.ts` (exactly the server's URL opened and never answered; a
  lookalike host, other scheme or path never opened — mutation-checked; refusals / offline →
  status-built sentences only).

## Tests

`server/tests/integration/google-one-consent.test.ts` (「仕事の道具をつなぐ」: 受信を読む allowed by
default and the company's one switch (task settings), off and on again; offered to a member only
with their own on; `{ all }` asks exactly
the company's features, Drive only with the Picker; a company-off feature never asked — by name or
as one granted before — and its calls refused before anything leaves; scopes unticked on Google's
page kept out, seen, not asked again; 「あとで」; a company without Google records nothing),
mutation-checked: the company check in `scopeStop`, `googleFeaturesToAsk`'s company filter, the
Picker condition. App: `client/src/features/settings/connectTools.test.ts` (opens only for what is
new, never again once shown, only the new ones later, declined text; mutation-checked: the seen
filter), `client/tests/ui/connect-tools.spec.ts` (preview `tests/connect-tools-ui.html?state=
first|new|seen|noslack|settings`), `client/tests/google-connect.test.ts` (connectAll opens only
the sign-in page). Also `admin/tests/integrations.test.tsx` 「会社で使うもの」.
`server/tests/integration/google-inbox.test.ts` (受信を読む asked only when first needed (turning
the member's own on), never in the one consent while it is off, never while the company does not
allow it, and nothing wider; only the member's own mailbox, Japanese mail decoded, nothing stored or logged;
the member's switch refuses the next call before anything leaves while the rest works, survives
a re-consent; メールを送る off; 「つないでいるサービス」; a reply sent from the phone — the member's Sent
mail with In-Reply-To — is listed from the SENT label, read as metadata only, and moves the 返事のお願い,
its text never stored), mutation-checked: the `feature-off` check, the Sent listing.
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
