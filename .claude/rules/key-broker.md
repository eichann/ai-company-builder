---
paths:
  - "shared/core/key-broker.ts"
  - "server/src/ports/secret-cipher.ts"
  - "server/src/ports/key-broker.ts"
  - "server/src/adapters/local-secret-cipher.ts"
  - "server/src/adapters/kek-file.ts"
  - "server/src/adapters/sqlite/key-broker.ts"
  - "server/src/services/broker-vault.ts"
  - "server/src/cli/generate-broker-kek.ts"
  - "server/tests/unit/local-secret-cipher.test.ts"
  - "server/tests/unit/broker-kek.test.ts"
  - "server/tests/unit/broker-vault.test.ts"
  - "shared/types/key-broker.ts"
  - "server/src/services/key-broker.ts"
  - "server/src/routes/key-broker.ts"
  - "server/tests/integration/key-broker.test.ts"
  - "admin/src/app/companies/*/api-keys/**"
  - "admin/src/components/key-broker/**"
  - "admin/src/lib/key-broker.ts"
  - "admin/tests/key-broker.test.tsx"
  - "server/src/services/broker-tokens.ts"
  - "server/tests/integration/broker-tokens.test.ts"
  - "server/src/services/broker-relay.ts"
  - "server/src/routes/broker-relay.ts"
  - "server/src/ports/upstream.ts"
  - "server/src/adapters/upstream-https.ts"
  - "server/src/lib/net-ranges.ts"
  - "server/src/lib/log-redaction.ts"
  - "server/tests/integration/broker-relay*.test.ts"
  - "server/tests/integration/broker-records.test.ts"
  - "server/tests/unit/net-ranges.test.ts"
  - "server/tests/unit/broker-relay-definition.test.ts"
  - "server/src/services/own-broker-keys.ts"
  - "server/tests/integration/own-broker-keys.test.ts"
  - "client/shared/broker-keys.ts"
  - "client/shared/broker-env.ts"
  - "client/electron/services/broker-token-store.ts"
  - "client/tests/broker-*.test.ts"
  - "client/electron/features/broker/**"
  - "client/src/features/settings/own-keys*"
  - "client/src/features/settings/hooks/useOwnKeys.ts"
  - "client/src/features/settings/components/OwnKeysSection.tsx"
---

# API key broker (「API キー」): the vault, the admin page, short-lived tokens

The server holds the company's API keys; the AI only ever gets a short-lived token, and the
relay (K4) swaps it for the real key on the way upstream. Owner decisions
(2026-10-22 … 10-30): keys are never returned in plain text; a **company key** (owner/admin
registers it; two dials: which departments' work × which people, + per-person exceptions) and a
member's **own key**
(that member only); skills ask for a **service**, and per service the company picks
「会社の鍵だけ／自分の鍵だけ／会社優先」 (defaults: a service that acts as a person → own key
only; a tool or company system → company key only); members may register own keys (default
on) for destinations the admin allowed. Stage 1 has **no KMS** and **no issuer-side IP
restriction**; it covers every API call the app makes (chat skills, tools started from the
app). Order: K1 vault → K2 admin page → K3 tokens → K4 relay (Gemini → OpenAI → Anthropic)
→ K5 log and stop → K6 app → K9 generic relay → K7 migration → K8 own keys (K8 was moved
up by the owner, 2026-10-30: right after the two dials).

## Vault (K1)

- **Envelope encryption** (`ports/secret-cipher.ts`, `adapters/local-secret-cipher.ts`): each
  key gets a random 256-bit data key that encrypts the value (AES-256-GCM, 96-bit nonce); the
  data key is wrapped by the key-encryption key (KEK) and stored with the KEK's id
  (`local:<16 hex>`, a one-way fingerprint). Both layers bind the context
  `{ purpose, companyId, keyId }` (`brokerSecretContext`), so a row copied elsewhere does not
  open. A KMS later is a new `KeyWrapper`; `vault.rewrapAll()` re-wraps data keys only (the
  ciphertext never changes, nothing is registered again). `envelopeSecretCipher(current,
  previous)` opens rows of a retiring KEK while they are re-wrapped.
- **KEK source**: `BROKER_KEK_FILE` (`lib/config.ts`), loaded once by `adapters/kek-file.ts`
  in `composition.ts`. The file holds 32 random bytes as base64. Refused (broker off, reason in
  the log, never the value): unset / empty / a character device (compose mounts `/dev/null`
  when `BROKER_KEK_HOST_FILE` is not set) → `not-configured`; unopenable → `kek-unreadable`;
  not 32 bytes of base64 → `kek-invalid`; readable by group/others or inside `DATA_DIR`
  (database backups would carry it) → `kek-insecure`. The server starts either way and logs
  `Key broker: on (key-encryption key local:…)` or `Key broker: off — <reason>`.
  **Nothing generates a KEK automatically.** Operators run `src/cli/generate-broker-kek.ts
  <path>` (new file only, `0600`, prints the path and id, never the key; refuses a path inside
  `DATA_DIR`) — in production through `docker compose run --rm --no-deps -v /etc/acb:/kek api
  node --import tsx src/cli/generate-broker-kek.ts /kek/broker-kek` (`.env.example`,
  `docs/self-hosting/README*.md`). Keep a copy off the server (password manager).
- **Tables** (`db/index.ts`): `broker_keys` (scope `company`|`user` + `owner_user_id`,
  `service`, `display_name`, `last4`, the sealed value `cipher_scheme`/`ciphertext`/`nonce`/
  `tag`/`wrapped_key`/`kek_id`, JSON `destinations` {hosts, pathPrefixes, models}, JSON
  `audience` {allDepartments, departmentIds, everyone, addUserIds, removeUserIds}, JSON `caps`
  {requestsPerDay, tokensPerDay, requestsPerMemberPerDay, tokensPerMemberPerDay},
  `allow_private_content`, `status` active|disabled, created/updated/by, `secret_updated_at`),
  `broker_services` (per company and service: `category` person|tool|system, `rule`,
  `own_key_hosts`), `broker_settings` (`member_keys_allowed`, default on while no row),
  `broker_history` (every change; JSON without any secret).
- **Write-only**: `BrokerKeyRepository.list/find` never return the sealed value; only
  `sealed()` does, and only `services/broker-vault.ts` calls it. `vault.reveal()` is for the
  relay after it has validated a token — no route reaches it, and its result is never returned
  or logged. `vault.seal()` is the only way in.
- Input rules are `shared/core/key-broker.ts`: service names `^[a-z0-9][a-z0-9_-]*$` (≤ 40),
  built-in services (gemini, openai, anthropic with their hosts), destination hosts are exact
  (no wildcard, IP, `localhost`, `.local`, `.internal`), path prefixes, model ids,
  `checkBrokerSecret` (printable ASCII, 8–4096, never an `acb_tok_` token; its errors never
  quote the value), the audience (`parseBrokerAudience`, `upgradeBrokerAudience`,
  `companyKeyEligibility`, `companyKeyCoversDepartment`, `companyKeyUsable`),
  `chooseBrokerKeySource`.

## Admin API and page (K2, owner/admin)

`routes/key-broker.ts` → `services/key-broker.ts`, under `/api/companies/:id`; shapes in
`shared/types/key-broker.ts` (`BrokerView`), pinned by `admin-contract.test.ts`:
`GET /broker`; `POST /broker/keys` (company key; `destinations` default to a built-in service's
hosts or a generic service's host, required otherwise); `PUT /broker/keys/:keyId/secret`; `PATCH /broker/keys/:keyId`
(an own key: `status` only); `DELETE /broker/keys/:keyId`; `PUT /broker/services/:service`
`{ category, rule, ownKeyHosts }`; `PUT /broker/settings` `{ memberKeysAllowed?, internalHosts? }` (the relay's internal-host exception, card 「社内の宛先（例外）」). Every change
answers the whole view (`Cache-Control: no-store`) and writes `broker_history`
(`BrokerChangeDetail`: create / replace (last4 before → after) / update (changed fields) /
delete / service / settings; the GET carries the latest 50). Check order who → body → rules;
registering or replacing without a KEK → 503 `{ code: 'BROKER_OFF' }` (metadata edits,
disable and delete still work). Audience departments must be the company's, people its members.

- **Who may use a company key: two dials** (owner decision 2026-10-30). ① **Which departments'
  work** (`allDepartments` = 全社, or `departmentIds`): matched against the department the
  consultation is in — the folder the app sends with the token (`department`), mapped to a
  department by `pathKey` (NFC, A–Z folded; `departmentIdOfFolder`); a consultation outside any
  department, or in an unknown folder, can use only 全社 keys. ② **Which people** (`everyone`
  = 全員, else only `addUserIds`), with per-person exceptions: `removeUserIds` never (even under
  全員), `addUserIds` always. Not 全社 needs at least one department (400). Reading a
  department's folder no longer decides anything — it replaced the K2 rule "members who can read
  the folder", which with everyone reading everything meant everyone. An audience without
  `allDepartments` (K2 rows, an older admin page) is converted by `upgradeBrokerAudience`:
  departments listed → work in them by everyone (± people); none → 全社, by everyone or the added
  people. `usableBy` (「今使える人」) lists dial ②; dial ① is decided per consultation.
- Admin page 「API キー」 (`admin/src/app/companies/[id]/api-keys/page.tsx`, menu `api-keys`,
  owners/admins): company keys and members' own keys (last 4, destinations, 使える仕事 (dial ①)
  and 使える人 (dial ②), caps,
  「非公開の内容を送ってよい」, status, 「今使える人」), register / edit settings / replace /
  stop・resume / delete, the members' own-key switch, per-service 種類・決め方・自分の鍵の送り先,
  the history. The value is a password field sent once in the POST (or the replace PUT); editing
  never sends it. Without a KEK the page explains why and offers no registration
  (`BROKER_OFF_TEXT`). Words and draft parsing: `admin/src/lib/key-broker.ts`.

## Short-lived tokens (K3)

`services/broker-tokens.ts`, routes in `routes/key-broker.ts` (any member, the desktop app):

- `POST /me/broker-tokens` `{ conversationId (1–200), services? (≤ 20 names; omitted = every
  service with a key), department? (the chat's active department folder), ttlMinutes? }` →
  `BrokerTokenIssued` `{ enabled, token, tokenId, expiresAt, services: [{ service, source }],
  unavailable: [{ service, reason: no-key | unknown-service }] }`. The token is
  `acb_tok_` + 64 hex (256 random bits, `IdGenerator.newToken`); **only its sha256 is stored**
  (`broker_tokens.token_hash`, `TokenDigest` port, `adapters/system.ts`); the value is answered
  once (`Cache-Control: no-store`) and never logged. No usable service → `token: null`; no KEK →
  `{ enabled: false, token: null }` (200, not an error). Lifetime `BROKER_TOKEN_TTL_MINUTES`
  (`lib/config.ts`, compose, default 30, clamped 15–60); the app may ask for less, never under 15.
  At most `BROKER_TOKENS_PER_MEMBER` (50) live tokens per member and company → 429
  `TOO_MANY_TOKENS`. Expired tokens are deleted a day after expiry (on issue).
- `DELETE /me/broker-tokens/:tokenId`: the member's own token only (another's → 404).
- `revokeAll(companyId, userId | null)`: the emergency stop (M2) will call it.
- **`validate(token, service)` (for K4)** → `{ ok, grant }` or a reason (`broker-off`,
  `malformed`, `unknown`, `revoked`, `expired`, `not-member`, `service-not-granted`, `no-key`).
  It **re-decides the key on every call** (`resolveKey`: the service's rule, an active company
  key the member may use now for the token's department (both dials), or their own active key while own keys are allowed and its hosts
  are still in the service's `ownKeyHosts`), so disabling a key, changing who may use it, the
  rule, or removing the member stops the token at once. The grant names the key, its
  destinations, caps and 「非公開」 flag; the relay then calls `vault.reveal(companyId, keyId)`.

## The relay (K4)

`/api/broker/<service>/<upstream path>` (`routes/broker-relay.ts` → `services/broker-relay.ts`
→ port `UpstreamClient` ← `adapters/upstream-https.ts`), for the built-in services (gemini,
openai, anthropic) and the company's generic services (K9, below). No ACB session: the token is
the sign-in.

1. **Token first**: from `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`;
   none → 401 `ACB_NO_TOKEN` (whatever the path). **Anything that is not an `acb_tok_` token →
   401 `ACB_REAL_KEY_REFUSED`, never forwarded** (a script with a hard-coded key). Unknown service
   → 404. `validate(token, service)` refusals → 401 `ACB_TOKEN_INVALID` / 403 `ACB_NOT_MEMBER` /
   403 `ACB_NO_KEY` (「この作業には <サービス> の鍵が必要です。管理者に頼むか、設定の『自分の鍵』から
   登録してください。」) / 503 `ACB_BROKER_OFF`. Error bodies are
   `{ type: 'error', error: { type, code, status, message } }` (read by all three SDKs).
2. **Destinations**: the host is the built-in host when the key allows it, else the key's first
   host. The raw path must start with `/`, have no `//`, `\`, `%2f`, `%5c`, `%00`, control
   characters or `.`/`..` segments (400 `ACB_BAD_PATH`); the URL parser has already resolved
   `%2e%2e`. Key path prefixes and models are enforced (403 `ACB_DESTINATION_NOT_ALLOWED`); the
   model comes from the path (`/models/<m>`, Gemini) or the JSON body's `model`.
3. **Body**: JSON is read (≤ 32 MB) for the model check (and K5's record); anything else
   streams. `BROKER_MAX_REQUEST_MB` (default 100) → 413 `ACB_TOO_LARGE` (declared or counted).
4. **Key swap**: `vault.reveal` → only the service's `credential` header
   (`BrokerServiceInfo.credential`: gemini `x-goog-api-key`, openai `Authorization: Bearer`,
   anthropic `x-api-key`). Dropped upstream: every credential header, `?key=`, cookies,
   `x-forwarded-*`, `forwarded`, `via`, `x-acb-*`, origin, referer, hop-by-hop;
   `accept-encoding: identity` (K5 reads usage).
5. **Way out** (`adapters/upstream-https.ts`): DNS once; **any** answer in a private / internal
   range (`lib/net-ranges.ts`: loopback, RFC 1918, 100.64/10, link-local incl.
   169.254.169.254, ULA, multicast, documentation, reserved; IPv4 inside mapped / NAT64 / 6to4
   IPv6) → 403 `ACB_PRIVATE_ADDRESS` before connecting, unless the host is in the company's
   **`internalHosts`** exception (`PUT /broker/settings { internalHosts }`, exact names, recorded
   in the history; each use logs `[broker] … allowed by the company's exception`). The connection
   goes to the checked address (no DNS-rebinding window), TLS verified against the host name,
   `BROKER_UPSTREAM_TIMEOUT_SECONDS` (600) for the headers. Failures → 502 / 504.
6. **Answer**: streamed as is. Redirects are never followed: a `Location` /
   `x-goog-upload-url` / `content-location` to one of the key's hosts is rewritten to
   `<PUBLIC_URL>/api/broker/<service>/…` (without `key=`); a redirect elsewhere → 502
   `ACB_REDIRECT_REFUSED`. Gemini resumable uploads: the relay remembers which token started an
   `upload_id` (memory, 1 h) so chunks sent without a key header continue. Headers holding the
   key are dropped; error bodies (≥ 400, ≤ 1 MB) have the key and the token replaced by
   `[hidden]`. `set-cookie`, `alt-svc` and hop-by-hop headers are dropped.
- WebSocket (Gemini Live, OpenAI Realtime) is not relayed in stage 1.

## Generic services (K9): a header-type API without code

An owner/admin registers a service by its destination and how the key travels; scripts then
call `/api/broker/<id>/…` with the token like a built-in one. Owner decision left open,
conservative default implemented: **only owners/admins** register, change or remove one
(department managers cannot; no per-department definitions — the key's two dials still decide
who uses it).

- `PUT /broker/relay-services/:service { label, baseUrl, header, format?, category? }`,
  `DELETE /broker/relay-services/:service` (`services/key-broker.ts`
  `setRelayService` / `deleteRelayService`, history action `relay-service` with the definition
  before / after). Stored as `broker_services.relay` (JSON `BrokerRelayDefinition` { label, host,
  basePath, header, format }; additive column, `migrateBrokerSettings`); category / rule /
  own-key hosts are the same row (`PUT /broker/services/:service`). The view's service carries
  `relay` and `defaultHosts: [host]`.
- Rules (`shared/core/key-broker.ts`): id `isValidRelayServiceId` — `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`,
  2–32, never a built-in name, no `_` (so `ACB_<ID>_*` with `-` → `_` is one name per service);
  `parseRelayBaseUrl` — `https://` only, port 443 only, no user / query / fragment, the host by
  the destination rules (exact name: no IP, `localhost`, `.local`, `.internal`, wildcard), a
  plain base path (no `%`, `..`, `//`); `normalizeRelayHeaderName` — a token-character name, not
  host / connection / te / trailer / transfer-encoding / upgrade / expect / cookie / set-cookie /
  forwarded / via / x-real-ip / origin / referer / accept / accept-encoding / user-agent / range /
  location / date nor `proxy-*`, `content-*`, `x-forwarded-*`, `x-acb-*`, `sec-*`,
  `access-control-*`; `normalizeRelayFormat` — printable ASCII with `{key}` exactly once
  (`Bearer {key}`, `Token token={key}`, `{key}`). A stored definition that no longer passes
  (`readBrokerRelayDefinition`) is not used.
- **The host is fixed at registration**: every key for the service (company keys, and own keys
  through `ownKeyHosts`) may name only that host (400 otherwise); the relay sends only there,
  with `basePath` put before the client's path (key path prefixes compare against the client's
  path); the host cannot change, nor the service be removed, while any key for it exists (409
  `SERVICE_HAS_KEYS`); a definition for a name that already has keys elsewhere is refused the
  same way. Redirects / `content-location` are rewritten only for that host and under the base
  path (which is stripped); anything else → 502 `ACB_REDIRECT_REFUSED`.
- **The token**: the company is not known before the token, so for a non-built-in service a
  credential header (`Authorization`, `x-api-key`, `x-goog-api-key`) holding exactly one token
  counts as it (`Token token=acb_tok_…`), and with none there, the one token-shaped value in any
  header. After validation, the service's own header must carry that token in its format or be
  absent, else 401 `ACB_REAL_KEY_REFUSED` (nothing sent). A non-built-in name that is not one of
  the company's generic services → 404 `ACB_UNKNOWN_SERVICE` (also with a valid token).
- **Never upstream**: the client's copy of the configured header, any header whose value
  contains the token, any query parameter containing it (a path containing it → 400
  `ACB_BAD_PATH`), plus everything the built-in relay drops. The key goes only in the configured
  header (`relayCredentialValue`); response headers holding the key or the token are dropped,
  error bodies have both `[hidden]`.
- Admin page: card 「登録したサービス」 (`admin/src/components/key-broker/relay-services.tsx`):
  register / change (label, ベース URL, 鍵の渡し方: `Authorization: Bearer` / `X-API-Key` / その他
  = header + `{key}` format, 種類 for a new one) / delete (disabled while keys exist), with the
  script variable names (`brokerServiceEnvNames`); drafts checked by `relayDraftErrors`
  (`admin/src/lib/key-broker.ts`, the core's rules, Japanese sentences). In the key form a
  generic service's host is read-only and the POST carries only that host. History lines for
  `relay-service` in `brokerChangeLines`.
- Records (`broker:<id>`), stop, caps, private-address refusal with the `internalHosts`
  exception, size / time limits and log redaction are the built-in relay's. Token counts are not
  read from a generic service's answers (`UsageScanner` is for the AI providers), so only request
  caps bite.

## Record, stop and caps (K5)

- **One `agent_events` row per call** once its answer has ended (`relay()` wraps the stream;
  `agentEvents.recordServerEvent`): category `broker`, agent `script`, tool `broker:<service>`,
  the token's member, conversation and department, `model`, and target
  `{ kind: 'broker', service, host, path (no query, ≤ 200), model, status, bytesIn, bytesOut,
  tokensIn, tokensOut, source: company | user }`; outcome ok / error / unfinished (client gone).
  Never a body, header, key or token. Calls refused before a token is known (no / bad token, real
  key sent) have no company and are not recorded. Refusals after it: `ACB_NO_KEY` → guard-denied
  `key-not-available`; path / model / redirect → `destination-not-allowed`; internal address →
  `internal-address`; caps → `over-cap`; stopped key → decision `stopped`. **Apps cannot send
  these**: `parseAgentToolEvent` rejects category `broker`, agent `script` and target `broker`
  (`SERVER_ONLY_CATEGORIES`). Tokens come from the answer as it streams (`UsageScanner`: Gemini
  `usageMetadata` incl. thoughts, OpenAI `usage`, Anthropic `usage`; running totals → largest
  value; a field split across chunks is still read) — this is why the relay asks upstream for
  `accept-encoding: identity`.
- **Stop (M2's 「鍵」 unit, server-side, immediate)**: a stopped key (`status: disabled`) that would
  have applied (no other key to fall back to) → `validate` reason `key-stopped` → 403
  `ACB_STOPPED` 「管理者が <サービス> の鍵を止めています。…」, recorded as `stopped`; token issue
  reports `unavailable: stopped`. `POST /broker/stop-all` (owner/admin; admin button
  「すべての鍵を止める」 with a confirmation) disables every active key, company and own, each in
  the history; resuming is per key. Tokens are not revoked, so the AI gets the "stopped" answer
  (revoking would answer "token expired").
- **Daily caps** (the key's `caps`): `broker_usage` (company, key, member, day: requests,
  tokens); the day is `BROKER_DAY_UTC_OFFSET_MINUTES` (default 540 = Japan, `brokerDayOf`). Before
  forwarding: total or member requests / tokens at or over a cap → 429 `ACB_OVER_CAP`
  「<サービス> の鍵の、今日の上限に達しました。…」, recorded `over-cap`; else one request is counted
  and the answer's tokens are added when it ends (so a call already running may pass a token
  cap once). Kept 40 days. The admin page shows 「今日の利用」 per key (`usageToday`, 「今日の上限
  に達しました」 at a total cap). No money caps in stage 1 (owner): providers' budget alerts.
- Logs: never a header, body, key or token; the request log hides `/api/broker/` queries
  (`lib/log-redaction.ts`).

## The app (K6): tokens into the AI's and tools' environment

- `client/electron/services/broker-token-store.ts` (created in `main.ts`, cleared on sign-out):
  `POST /me/broker-tokens` with the session, one token per (company, consultation or
  `tool:<path>`, department), memory only, never logged or sent to the renderer; reused until
  less than 10 minutes (`REFRESH_MARGIN_MS`) are left, then replaced — every chat turn asks
  (`ChatServerConfig.getBrokerEnv`, `features/chat/server-config.ts`), so a turn starts with a
  token that outlives it. Offline / refused / an older server (404) → no broker variables that
  turn (logged without the token); 3 s budget.
- `client/shared/broker-env.ts` `brokerEnv(serverUrl, issued, reservedServices)`: per service
  the token goes where its SDKs look for a key (gemini `GEMINI_API_KEY` and `GOOGLE_API_KEY` —
  google-genai prefers the latter —, openai `OPENAI_API_KEY`, anthropic `ANTHROPIC_API_KEY`) and
  the relay where they look for a base URL (`GOOGLE_GEMINI_BASE_URL` = `<origin>/api/broker/gemini`,
  `OPENAI_BASE_URL` = …`/openai/v1`, `ANTHROPIC_BASE_URL` = …`/anthropic`), plus always
  `ACB_<SERVICE>_API_KEY` / `ACB_<SERVICE>_BASE_URL` and `ACB_BROKER_URL`. Services the company
  has keys for but this member may not use here (`no-key` / `stopped`) get the placeholder
  `acb_tok_none` (`BROKER_NO_KEY_PLACEHOLDER`): the relay answers it with
  「この作業には <サービス> の鍵が必要です。管理者に頼むか、設定の『自分の鍵』から登録してください。」
  without contacting anyone. Services nobody configured get nothing, so scripts keep their old
  behaviour until K7.
- **Generic services (K9)** have no SDK names: they get only `ACB_<SERVICE>_API_KEY` (the token)
  and `ACB_<SERVICE>_BASE_URL` (`<origin>/api/broker/<id>`; the relay adds the base path), the
  name from `brokerServiceEnvNames` (`shared/core`, `-` → `_`; the admin page shows the same
  names). A script sends the token in the service's header, in `Authorization: Bearer`, or in
  `x-api-key`. `isBrokerEnvName` treats **every** `ACB_*_API_KEY` / `ACB_*_BASE_URL` as a broker
  name (rule 0), so such a variable from the member's shell or pass-through list never reaches
  an AI process — the app does not know the company's services in advance.
- **The agent's own CLI never gets its vendor's standard variables** (registry
  `brokerReservedServices`: Claude Code `anthropic`, Codex `openai`): `ANTHROPIC_API_KEY` /
  `ANTHROPIC_BASE_URL` would switch the Claude Code CLI from the member's login to the company's
  key (and `OPENAI_*` Codex). Scripts in those chats use the `ACB_ANTHROPIC_*` / `ACB_OPENAI_*`
  names (K7 list).
- Where it goes: the chat's AI process (`turnEnv` on the turn request: Claude Code `env`, Codex's
  app-server, the API-key mode's commands) and tools started from the app (`tools:start` takes
  the company id; `tool:<rel path>` token, the skill's department; the shell variables of the same
  names are replaced). A tool running longer than the token (≤ 60 min) must be restarted.
- `agents/agent-env.ts` rule 0: a broker variable passes to an AI process only with a value the
  app sets — an `acb_tok_` token, the placeholder, or a relay URL on the company server's origin
  (`configureAgentEnv({ serverUrl })`) — so a real key, or a base URL that would send the token
  elsewhere, from the member's shell or pass-through setting never does.
- The sandbox (「AI の囲い」) already allows the ACB server's host, so scripts reach the relay
  with nothing else allowed.

## A member's own keys (K8, 「自分の鍵」)

`services/own-broker-keys.ts`, routes in `routes/key-broker.ts` (any member, the desktop app):
`GET /me/broker-keys` → `MyBrokerKeys` (`shared/types/key-broker.ts`): `enabled`,
`memberKeysAllowed`, per service (built-in, configured, or with a key) its category and rule,
`ownKey` (`{ allowed, hosts }` or why not: `member-keys-off` / `company-only` / `no-destinations`),
the active company keys the member may use (dial ②) with their work (dial ①, department names),
and the member's own key (last 4, hosts, status — never the value).
`PUT /me/broker-keys/:service { secret, displayName? }` registers or replaces (one own key per
member and service; `secret` through `checkBrokerSecret` and `vault.seal` like an admin's);
check order: service name → body → service known (404) → own keys allowed (403
`{ code: 'OWN_KEY_NOT_ALLOWED', reason }`) → KEK (503 `BROKER_OFF`). Allowed = the members'
switch on, a rule other than 「会社の鍵だけ」, and at least one `ownKeyHosts`; the key's
destinations are those hosts (refreshed on replace). An admin's stop survives a replace (only an
admin resumes it). `DELETE /me/broker-keys/:service` always works (also with the switch off).
Every change writes `broker_history` with the member as `changedBy`; the admin page lists the
keys and the history. Tokens use the key through `resolveKey` (above).

App: Settings → 「自分の鍵」 (`client/src/features/settings/components/OwnKeysSection.tsx`,
`hooks/useOwnKeys.ts`, `own-keys.ts` = which key the AI will use, following
`chooseBrokerKeySource`; ports `OwnKeyReads` / `OwnKeyOutbound` in `features/settings/api.ts`).
Main: `electron/features/broker/ipc.ts` (`brokerKeys:list|save|delete`; the session cookie stays
in main). The pasted value crosses renderer → main → server once (PUT body), in a password field;
**main's answers are the server's view or a sentence built from status codes only**
(`client/shared/broker-keys.ts` `ownKeysErrorText`), so no server text that might quote the
request reaches the renderer, and nothing is logged but the method and status. The page that
used to be 「APIキー」 (the company folder's `.env` on this computer) is now 「APIキー（このPC）」.

## Tests

`tests/unit/local-secret-cipher.test.ts` (envelope, context, tampering, re-wrap keeps the
ciphertext), `tests/unit/broker-kek.test.ts` (which KEK files are refused; the generator never
overwrites or prints a KEK), `tests/unit/broker-vault.test.ts` (no table holds a value, the
listing carries no secret, a copied row does not open, rewrap, off without a KEK),
`tests/integration/key-broker.test.ts` (**no plaintext key in any answer, error, log line or
table** across every admin call, success and error; who may manage; the two dials and the K2
form's conversion; history;
503 without a KEK), `tests/integration/broker-tokens.test.ts` (tokens only for usable
services, both dials (another department or none → no key; a dial change stops a live token),
rule / own key / switch, every validation refusal, TTL bounds, the per-member bound,
**no token or key value in any log line or table**), `tests/integration/broker-relay.test.ts` (fake upstream: every token form, the key only in
the service's header, a real-looking key refused unforwarded, destinations / models / bad paths,
the Japanese no-key refusal, upload URL rewrite + continuation, redirects, a provider echoing the
key, internal destination, size limit, revoked token, **no key in any answer, log line or table,
no token in any log line**), `client/tests/broker-env.test.ts` (the agent's CLI never gets its vendor's variables; placeholder
vs nothing; a shell key or a foreign relay URL never reaches an AI process),
`client/tests/broker-token-store.test.ts` (one token per consultation and department, refreshed
before expiry, failure → nothing, no token in the log), `tests/integration/broker-records.test.ts` (one record per call with who / department / host
/ path / model / sizes / tokens and nothing secret, tokens split across chunks, refusals filed by
who decided, stop-all → `stopped` on the next call and resume, member and token caps
(mutation-checked), an app cannot forge a relay record), `tests/integration/broker-relay-https.test.ts` (real HTTPS to a
local provider with its own certificate: internal address refused before connecting and allowed
by the exception, one internal answer among several refuses, one DNS lookup, TLS checked against
the name, the whole route end to end — SSRF guard mutation-checked), `tests/unit/net-ranges.test.ts`
(every internal form refused, public ones pass; the request log hides relay queries),
`tests/unit/broker-relay-definition.test.ts` (K9 ids, base URLs, header names and formats that
would open the relay are refused), `tests/integration/broker-relay-generic.test.ts` (K9: owner/admin
only, the host fixed for every key, base path, the key only in the configured header and format,
the token / cookies / hop-by-hop / the client's copy of the header never forwarded, a real-looking
key refused unforwarded, redirects, record / stop-all / caps, own keys, no host change or removal
while keys exist, the additive migration, **no key in any answer, log line or table**),
`tests/integration/own-broker-keys.test.ts`
(own keys only where allowed (switch, rule, destinations), one per service, an admin's stop
survives a replace, deleting only one's own, a token then uses it, 503 without a KEK, **no key
value in any answer, error, log line or table**), `client/tests/ipc-app.test.ts`
(「brokerKeys:save … never hands it back to the renderer」: refusals and offline answers carry
no part of the key even when the server quotes it; nothing logged), `client/src/features/settings/own-keys.test.ts`
(the page never promises a key the server would not use), `admin/tests/key-broker.test.tsx` (menu for admins only, the value is
sent once and never shown, editing never sends it, a non-exact host cannot be saved, the
off message; a generic service is saved only with https to one exact host and a safe header,
and its keys go only there). Tests use
obviously fake values (`fake-test-key-NOT-REAL…`) and KEKs made in temp dirs.
