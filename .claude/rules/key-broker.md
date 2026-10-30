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
  - "server/src/services/own-broker-keys.ts"
  - "server/tests/integration/own-broker-keys.test.ts"
  - "client/shared/broker-keys.ts"
  - "client/electron/features/broker/**"
  - "client/src/features/settings/own-keys*"
  - "client/src/features/settings/hooks/useOwnKeys.ts"
  - "client/src/features/settings/components/OwnKeysSection.tsx"
---

# API key broker (「API キー」): the vault, the admin page, short-lived tokens

The server holds the company's API keys; the AI only ever gets a short-lived token, and the
relay (K4, planned) swaps it for the real key on the way upstream. Owner decisions
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
hosts, required otherwise); `PUT /broker/keys/:keyId/secret`; `PATCH /broker/keys/:keyId`
(an own key: `status` only); `DELETE /broker/keys/:keyId`; `PUT /broker/services/:service`
`{ category, rule, ownKeyHosts }`; `PUT /broker/settings` `{ memberKeysAllowed }`. Every change
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
**no token or key value in any log line or table**), `tests/integration/own-broker-keys.test.ts`
(own keys only where allowed (switch, rule, destinations), one per service, an admin's stop
survives a replace, deleting only one's own, a token then uses it, 503 without a KEK, **no key
value in any answer, error, log line or table**), `client/tests/ipc-app.test.ts`
(「brokerKeys:save … never hands it back to the renderer」: refusals and offline answers carry
no part of the key even when the server quotes it; nothing logged), `client/src/features/settings/own-keys.test.ts`
(the page never promises a key the server would not use), `admin/tests/key-broker.test.tsx` (menu for admins only, the value is
sent once and never shown, editing never sends it, a non-exact host cannot be saved, the
off message). Tests use
obviously fake values (`fake-test-key-NOT-REAL…`) and KEKs made in temp dirs.
