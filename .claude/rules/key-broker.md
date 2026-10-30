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
---

# API key broker (「API キー」): the vault, the admin page, short-lived tokens

The server holds the company's API keys; the AI only ever gets a short-lived token, and the
relay (K4, planned) swaps it for the real key on the way upstream. Owner decisions
(2026-10-22 … 10-30): keys are never returned in plain text; a **company key** (owner/admin
registers it; departments or everyone + per-person exceptions) and a member's **own key**
(that member only); skills ask for a **service**, and per service the company picks
「会社の鍵だけ／自分の鍵だけ／会社優先」 (defaults: a service that acts as a person → own key
only; a tool or company system → company key only); members may register own keys (default
on) for destinations the admin allowed. Stage 1 has **no KMS** and **no issuer-side IP
restriction**; it covers every API call the app makes (chat skills, tools started from the
app). Order: K1 vault → K2 admin page → K3 tokens → K4 relay (Gemini → OpenAI → Anthropic)
→ K5 log and stop → K6 app → K9 generic relay → K7 migration → K8 own keys.

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
  `audience` {everyone, departmentIds, addUserIds, removeUserIds}, JSON `caps`
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
  quote the value), `companyKeyEligibility`, `chooseBrokerKeySource`.

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

- **Who may use a company key** (`usableBy`, and what tokens will use): removed by name →
  never; added by name; everyone; or a member of one of its departments. **A member belongs to a
  department when the permission rules let them read its folder** (`resolveAccess`; owners and
  admins read everything) — ACB has no other department membership. With the default seed
  (everyone reads everything) a department key is usable by everyone; the page's 「今使える人」
  shows the effect.
- Admin page 「API キー」 (`admin/src/app/companies/[id]/api-keys/page.tsx`, menu `api-keys`,
  owners/admins): company keys and members' own keys (last 4, destinations, who, caps,
  「非公開の内容を送ってよい」, status, 「今使える人」), register / edit settings / replace /
  stop・resume / delete, the members' own-key switch, per-service 種類・決め方・自分の鍵の送り先,
  the history. The value is a password field sent once in the POST (or the replace PUT); editing
  never sends it. Without a KEK the page explains why and offers no registration
  (`BROKER_OFF_TEXT`). Words and draft parsing: `admin/src/lib/key-broker.ts`.

## Tests

`tests/unit/local-secret-cipher.test.ts` (envelope, context, tampering, re-wrap keeps the
ciphertext), `tests/unit/broker-kek.test.ts` (which KEK files are refused; the generator never
overwrites or prints a KEK), `tests/unit/broker-vault.test.ts` (no table holds a value, the
listing carries no secret, a copied row does not open, rewrap, off without a KEK),
`tests/integration/key-broker.test.ts` (**no plaintext key in any answer, error, log line or
table** across every admin call, success and error; who may manage; audience rules; history;
503 without a KEK), `admin/tests/key-broker.test.tsx` (menu for admins only, the value is
sent once and never shown, editing never sends it, a non-exact host cannot be saved, the
off message). Tests use
obviously fake values (`fake-test-key-NOT-REAL…`) and KEKs made in temp dirs.
