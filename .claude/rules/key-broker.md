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

## Tests

`tests/unit/local-secret-cipher.test.ts` (envelope, context, tampering, re-wrap keeps the
ciphertext), `tests/unit/broker-kek.test.ts` (which KEK files are refused; the generator never
overwrites or prints a KEK), `tests/unit/broker-vault.test.ts` (no table holds a value, the
listing carries no secret, a copied row does not open, rewrap, off without a KEK). Tests use
obviously fake values (`fake-test-key-NOT-REAL…`) and KEKs made in temp dirs.
