---
paths:
  - "server/src/services/member-oauth.ts"
  - "server/src/routes/oauth.ts"
  - "server/src/ports/connectors.ts"
  - "server/src/adapters/sqlite/connectors.ts"
  - "server/tests/unit/member-oauth.test.ts"
---

# Members' own OAuth permissions, every provider (stage 3 C1)

A member allows ACB to act with part of their own account at an outside provider (Google today,
Slack next). `services/member-oauth.ts` is the provider-neutral part: the grant vault
(`connector_grants`), the pending starts (`oauth_pending`), sealing with the company's key, the
public callback, the stops and the history (`connector_history`). A provider plugs in with an
`OAuthProviderDescriptor` (`memberOAuth.register`): `id`, `label`, `features`, `unavailable`
(its switches: operator stop, client, on/off, vault), `authorizeUrl`, `exchangeCode`, `identify`
(which account; its own checks, e.g. Google's verified + Workspace domain), `revoke`,
`normalizeScopes`, `featuresOf`, `forget` / `forgetCompany` (cached access tokens) and the
callback page's sentences. The provider's own module keeps its client registration, views and
API calls (Google: `google-connector.md`, `services/google-connector.ts` registers it).

## What holds for every provider

- **Provider-bound.** Grants and pending starts are always read under their provider (every
  `ConnectorRepository` grant / pending method takes it). The refresh token is sealed under
  `acb-<provider>-grant` (`grantSealContext`), bound to the company and the grant id: a token
  moved into another provider's row or another company does not open. A start of one provider
  at another provider's callback is refused (the row is consumed, nothing stored).
- **The callback** `GET /api/oauth/:provider/callback` (public; `auth-guards.test.ts`, matrix
  row, `NOT_OBJECT_IDS`): the state is `<companyId>.<64 hex>`, the pending row is taken (single
  use, 10 minutes) by the sha256 of the whole state inside that company only. Then: provider
  matches → the provider's `error` → code present → `unavailable` → still a member → verifier
  opened → code exchanged → `identify` → **the account's email is the member's own ACB email**
  (`sameEmail`) → grant stored (new refresh token: new `grant_id`; none: only the scopes, when an
  active grant holds a token). Any refusal after the exchange revokes the issued tokens and stores
  nothing. An unknown provider answers 404. `/api/oauth/google/callback` is the redirect URI
  every company registered in Google Cloud: it must stay exactly that.
- **Stops**, each from the next call: admin 「止める」 one member (`stopGrant`, revoked at the
  provider too), the member's 「許可をやめる」 (`disconnect`: revoked, row deleted, pending
  removed), 「すべての鍵を止める」 (`stopAll`: every active grant of **every registered provider**,
  wired as the key broker's `onStopAll` in `composition.ts`), the provider's own switches via
  `unavailable` and its client's per-call checks.
- **History**: `grant` (`consent` new / replaced / added), `grant-revoked`, `grant-stopped`,
  `stop-all`, with `revokedAt<Label>` (Google's rows: `revokedAtGoogle`), never a secret.
- **Seen by the app's 「仕事の道具をつなぐ」** (`connector_setup_seen`, per provider; `setupSeen` /
  `addSetupSeen`): which features the screen already showed the member, so it opens by itself only
  for new ones (google-connector.md "One consent"). Kept across 「許可をやめる」.
- **Feature toggles inside a grant** (owner decision 2026-11-01, e.g. Google 予定と議事録を読む /
  メールを送る; not 受信を読む since 2026-11-02 — that is the member's own switch in 自分の設定,
  `tasks.md` "Each member's switches", which Google's toggle writes): `connector_grants.features_off` (JSON list, default `[]`, kept across a
  re-consent, gone with 「許可をやめる」). The member sets it (`memberOAuth.setFeatureOff(provider,
  member, feature, off)`: only the descriptor's features, only their own grant; history
  `grant-features`; Google's route `PUT /me/google/features`), and the provider's client refuses
  a call whose feature is off like a scope not granted (Google: `feature-off`,
  `google-connector.md`). The app's switch needs an IPC channel (after stage 2's screens merge);
  until then the server and the admin view carry it.

## Adding a provider

Add it to `CONNECTOR_PROVIDERS` (`ports/connectors.ts`) **and** to the `provider IN (...)` CHECK
of `connector_grants` / `oauth_pending` (`db/schema/connectors.ts`, with a rebuild like
`migrateConnectorProviders`), add the purpose to nothing else (it is derived), write its
descriptor and register it, and list its callback URL (`oauthCallbackPath`) for the admin.
`slack` is allowed by the schema; `services/slack-connector.ts` registers it (`slack-connector.md`; wired in `composition/connectors.ts`).

## Tests

`server/tests/unit/member-oauth.test.ts` (real schema and vault, two stand-in providers),
mutation-checked: another provider's grant / sealed token / start, another company's state, one
member's start with another account, a stopped grant, stop-all over every provider, another
company's use or stop. Google end to end: `tests/integration/google-connector.test.ts`.
