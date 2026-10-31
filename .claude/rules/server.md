---
paths:
  - "server/src/**"
  - "server/tests/**"
  - "server/package.json"
---

# Server (Hono API): layers, routes, accounts, departments, database

Push checking is in `push-check.md`, private folders in `private-folders.md`, read-only file
access in `company-files.md`. Full text and incidents: `docs/architecture/server.md`,
`server-layers.md` (internal).

## Layers (R5)

```
routes/    HTTP only: auth (getUserFromRequest), parse/validate, call a service, map the answer
  → services/   business rules; authorization through services/access.ts (shared/core roles)
    → ports/    interfaces (CompanyDataSource = company handles, repositories, RepoStore, CompanyLock, Clock/IdGenerator,
                AccountDirectory, SecretCipher, UpstreamClient, Transactions)
        ↑ adapters/   sqlite/* repositories, git-repo-store.ts, accounts.ts, system.ts,
                      company-files.ts, orphaned-scopes.ts (git + orphaned_scopes table),
                      private-folders.ts (scope repositories + their rows),
                      local-secret-cipher.ts, kek-file.ts, upstream-https.ts
src/composition.ts — the only module that imports adapters; routes take `services` from it
src/cli/           operator commands (generate-broker-kek.ts, company-archive.ts), each its own composition root
```

- `server/tests/unit/layering.test.ts` enforces the direction: ports import only ports (and
  shared/core types), services only ports / services / shared / pure lib, only the composition
  root imports adapters (and `db/index.ts`, whose startup seeding runs
  `adapters/sqlite/permission-store.ts` on the connection it migrates), no route runs SQL or
  imports `db` (git-http's push snapshot, private-folder lookups and orphan checks use
  `services.access` / `services.companyScopes` with the Member), and `lib/` does not import the database except the modules listed in
  `LIB_WITH_DATABASE` with their reason (only `lib/auth.ts`: Better Auth's own connection, next
  to every route's sign-in check). Storage goes in `adapters/*` behind a port; a module that only
  computes or runs git / files stays in `lib/` (`lib/push-rejections.ts` parses,
  `lib/client-activity.ts` reads headers and receive-pack results, `lib/private-folders.ts` keeps
  paths, archives and the pushes in flight).
- Client activity (`client_activity`): `services/client-activity.ts` records it (throttled,
  never throws) from `routes/client-activity-middleware.ts` (API) and git-http, and holds the
  active-members build check; table in `adapters/sqlite/client-activity.ts`.
- Repository ports are synchronous on purpose (better-sqlite3): a check followed by a write in
  one handler cannot interleave with another request. Keep check-then-write sequences inside one
  synchronous stretch or a `transactions.run(...)`. A move to Postgres would turn these
  signatures into Promises at this one seam.
- Services return `Outcome<T>` (`services/outcome.ts`): a value or a refusal (`bad-request` /
  `forbidden` / `not-found` / `conflict` / `gone` / `unavailable`) carrying the exact API error
  body; `routes/respond.ts` maps it to the status code. Keep each endpoint's check order
  (who → body → rules) when moving code, so the same request keeps the same status.
- Moving SQL into a repository: copy the statement unchanged (columns, `ORDER BY` tie-breaks,
  transaction boundaries). Statements are prepared per call, so building repositories before
  `initDatabase()` is safe.
- `AccountDirectory.bySessionToken` (`adapters/accounts.ts`) is the one place that reads Better
  Auth's session table directly (git over HTTP sends the token as the Basic-auth password).
- `SecretCipher` (`ports/secret-cipher.ts`): the key broker's envelope encryption (a data key
  per secret, wrapped by the KEK; `KeyWrapper` is where a KMS plugs in), bound to a context;
  `adapters/local-secret-cipher.ts` with the KEK file from `adapters/kek-file.ts`. Used only by
  `services/broker-vault.ts` (`key-broker.md`); no route reaches its `reveal`.
- Sign-in and role checks are tested by calling the routes: `tests/security/auth-guards.test.ts`
  finds every handler of every file in `src/routes` at run time and expects 401 without a
  session (public endpoints are listed there with their reason); the 403 checks live in
  `tests/integration/authorization.test.ts`. Do not add tests that search route source for the
  name of a check.
- The permission matrix (`tests/integration/permission-matrix.test.ts`) walks every route of
  `src/app.ts` and states the status code for owner, admin, member, department manager (inside
  and outside their department), a signed-in outsider and a signed-out caller; server
  operators (`OPERATOR_USER_IDS`) only on rows that name them (`operators`). A route missing
  from the matrix fails it: a new endpoint gets its row(s) in the same PR. Requests are chosen
  so an allowed caller passes the guard without changing state (invalid body → 400, missing
  target → 404 after the role check); keep it that way when adding rows. A changed row is a
  changed permission — say so in the PR.
- Cross-company axis (same file, `CROSS`): every route whose URL takes an object id (department,
  rule, scope, private folder incl. its git routes, member, sandbox override, emergency stop,
  key, relay service, token, invitation) is called by this company's owner with ANOTHER
  company's object in this company's URL; the status and body must equal those for an id that
  exists nowhere, and every row of the other company (all tables with `company_id`) and its
  private folder's repository must be unchanged afterwards. A route with an object parameter
  and no `CROSS` row fails the test, unless it is in `NOT_OBJECT_IDS` with its reason (invitation
  link tokens, the relay, service names that set this company's own row). A new endpoint that
  takes an id gets its `CROSS` row in the same PR.

## Company handle (「会社つきの手形」, multi-tenant foundation 案 A, 2026-10-31)

One SQLite database holds every company; cross-company access is made impossible by
construction, not by remembering a check (owner plan 0.13–0.14).

- A company's own rows are reached through its **handle**: `CompanyDataSource.forCompany(companyId)`
  (`ports/company-data.ts`, `adapters/sqlite/company-data.ts`) returns repositories whose
  methods take **no company parameter** and whose every statement is limited to that company, so
  another company's object id finds, changes and deletes nothing. Behind it: `departments`,
  `invitations`, `scopes` (permission scopes, rules, department managers:
  `adapters/sqlite/scopes.ts` over `permission-store.ts`), `privateFolders`
  (`adapters/private-folders.ts`), `orphanedScopes` (`adapters/orphaned-scopes.ts`) and `records`
  (the company map of the light ontology, `adapters/sqlite/records.ts`, `records.md`) and
  `plugins` (connector plugins' installs, mapping versions, history, `adapters/sqlite/plugins.ts`,
  `plugins.md`; triggers keep a mapping under its own company's install and an install's key a
  company key of the same company) and `connectors` (the Google connection: OAuth client,
  members' grants, pending starts, history, `adapters/sqlite/connectors.ts`, `google-connector.md`).
  Every company table has `company_id`, and handle statements filter by it directly. New tables
  (stage 4: types, company map, state engine…) are created behind the handle from the start,
  with `company_id`.
- `scope_rules` / `department_managers` got `company_id` later (2026-10-31,
  `db/index.ts` `migrateRuleAndManagerCompanies`, every startup, idempotent): added nullable
  (additive: an older build still inserts without it) + index; rows still without it get the
  company of their scope / department, rows whose parent is gone are removed (they belong to no
  company; counts are logged, nothing named). Triggers keep it non-null and correct: an INSERT
  naming a company other than the parent's is refused (`… must be the company of its scope /
  department`), one leaving it out gets the parent's (older builds), no UPDATE may clear it or
  move a row under another company's parent. So adding a rule or manager under another
  company's scope / department through a handle throws. Startup repair of managers whose
  department is gone now runs per company (`syncCompanyScopes`). Test:
  `tests/unit/rule-manager-company-migration.test.ts` on `tests/fixtures/app-schema-before-rule-companies.sql`
  (the schema before, frozen): per-company counts equal before and after.
- The company id given to `forCompany` comes from the server: `member.companyId` (the membership
  `services/access.ts` looked up for the signed-in account), a company the service just created,
  a key-broker token row, or a job looping over the companies registry — never a value taken
  from a request as is. Only services get the source (`composition.ts` passes it in `shared`,
  never in the `services` routes see); git-http passes a Member to `services.companyScopes`.
  Handle repositories are built only by `company-data.ts`.
- The control plane outside handles: the companies registry, memberships, accounts, and lookups
  that find the company — an invitation by token (`InvitationTokenLookup`:
  `findByToken`, `claimForSignup`, which returns the company; everything after uses that
  company's handle) and a key-broker token by hash.
- Do not add a repository method that reads or writes a company's rows without its company
  (`findById(id)`, `delete(id)`…); "the service checked first" is the old pattern this replaces.
- `tests/unit/company-scoped-sql.test.ts` reads every SQL string in `server/src` and fails when a
  statement touches a company-owned table without a bound company (`company_id = ?` /
  `company_id IN (…)`, also in a subquery; a join such as `i.company_id = c.id` does not count;
  an INSERT names `company_id`), unless listed in `UNSCOPED` with a lasting reason: invitation /
  broker token lookups that find the company, the operator's KEK re-wrap, retention's list of
  companies, server-wide cleanup of expired broker tokens and old usage counters, the startup
  backfill of rows from before `company_id` (only `company_id IS NULL` rows), WHERE built by a
  helper starting with `company_id = ?`. The list only shrinks. It also checks that every table
  outside `CONTROL_PLANE_TABLES` (`companies`, `memberships`, unused `ssh_keys`) has a
  `company_id` column, that a handle table is written only
  by its handle modules (`HANDLE_TABLES`), and that handle repository factories are used only by
  the source, in src and tests. Isolation per handle (A cannot read or write B's departments,
  invitations, scopes, rules, managers, private folders): `tests/unit/company-data.test.ts`.
- Later moves — a database per company (B) or PostgreSQL with row-level security (C) — change
  only where `forCompany` opens its connection.

## Route map (mounted in `server/src/app.ts`; `index.ts` starts it)

```
GET  /api/config                                  setup state (no auth)
*    /api/auth/**                                 Better Auth; sign-up after the first user
                                                  needs X-Invitation-Token
/api/me                       GET                 me.ts (no PATCH: it never saved)
/api/companies                GET /, GET /:id, POST /, PATCH /:id,
                              GET /:id/members, POST /:id/members,
                              PUT /:id/members/:userId/role, DELETE /:id/members/:userId,
                              GET /:id/client-activity                       companies.ts
/api/companies/:companyId/departments
                              GET /, GET /:id, POST /, PUT /:id, DELETE /:id, GET /:id/stats,
                              POST /reorder, POST /sync, GET|PUT /:id/managers  departments.ts
/api/companies/:companyId/folder-sizes  GET ?path=&measure=                  folder-sizes.ts
/api/companies/:companyId/files         GET /tree, /content, /search          company-files.ts
/api/companies/:companyId     GET /overview, /permissions, /me/capabilities (+ canViewAgentEvents), /me/write-access
                                                                             permissions.ts
                              PUT /permissions/scopes/by-path, POST /permissions/rules,
                              PATCH|DELETE /permissions/rules/:ruleId,
                              DELETE /permissions/scopes/:scopeId/rules,
                              POST /permissions/scopes/:scopeId/move,
                              GET /permissions/effective, /permissions/folders,
                              GET /push-rejections                            permission-rules.ts
                              /private-folders…, /me/private-folders, /me/scopes,
                              POST /paths/check                               private-folders.ts
                              POST|GET /agent-events, /agent-events/summary,
                              GET|PUT /agent-events/settings (+ /retention-preview),
                              GET /agent-events/viewers                       agent-events.ts
                                                                (AI action log: agent-events.md)
                              GET|PUT /agent-sandbox, PUT /agent-sandbox/overrides/:userId,
                              GET /me/agent-policy                            agent-sandbox.ts
                                                                (「AI の囲い」: agent-sandbox.md)
                              GET|POST /agent-stops, DELETE /agent-stops/:stopId,
                              GET /me/events (SSE push channel)               agent-stops.ts
                                                                (緊急停止: agent-stop.md)
                              GET /broker, POST /broker/keys,
                              PUT /broker/keys/:keyId/secret, PATCH|DELETE /broker/keys/:keyId,
                              PUT /broker/services/:service (+ /own-keys, /read-only),
                              PUT|DELETE /broker/relay-services/:service,
                              PUT /broker/settings, POST /broker/stop-all,
                              POST /me/broker-tokens, DELETE /me/broker-tokens/:tokenId,
                              GET /me/broker-keys, PUT|DELETE /me/broker-keys/:service
                                                                              key-broker.ts
                                                                (「API キー」: key-broker.md)
                              GET|PUT /records/settings, GET /records/problems,
                              POST /records/reindex, GET /records/types,
                              POST /records/query, GET /records/item/:recordId,
                              GET /records/my-turn, POST /records/item,
                              POST /records/item/:recordId/actions/:action,
                              POST …/undo, GET …/history, GET …/versions/:version,
                              POST /me/record-tokens, DELETE /me/record-tokens/:tokenId   records.ts
                              GET /plugins, GET|PUT /plugins/:pluginId, PUT …/enabled,
                              PUT …/mapping, POST …/mapping/restore, POST …/mapping/check, POST …/import,
                              POST …/connection/renew,
                              POST …/records/:recordId/operations/:operation,
                              GET …/operations/:operationId (+ POST /undo, /reconcile)  plugins.ts
                                                                (つなぎ先のプラグイン: plugins.md)
                              GET /google, PUT /google/client, PUT /google/enabled,
                              DELETE /google/grants/:userId,
                              GET|DELETE /me/google, POST /me/google/connect    google.ts
                                                                (Google: google-connector.md)
/api/oauth                    GET /google/callback — public: Google sends the browser back;
                              the state finds the company (google-connector.md)  oauth.ts
/api/records-ai               GET /types, /my-turn, /item/:recordId(/history), POST /query,
                              POST /item, POST /item/:recordId/actions/:action,
                              POST /plugins/:pluginId/records/:recordId/operations/:operation,
                              GET /plugins/:pluginId/operations/:operationId — the AI's
                              routes (record token instead of a session; records.md) records-ai.ts
                                                                (company map: records.md)
/api/broker                   GET|POST|PUT|PATCH|DELETE /:service/* — the key broker's relay
                              (token instead of a session; key-broker.md)      broker-relay.ts
/api/git                      GET /repos/:companyId → { companyId, httpsUrl }  git.ts
/api/git-http                 smart HTTP for /<companyId>.git and
                              /<companyId>/scopes/<scopeId>.git               git-http.ts
/api                          GET|POST /companies/:companyId/invitations,
                              DELETE …/invitations/:id, GET /invitations/:token,
                              POST /invitations/:token/accept                 invitations.ts
```

`/api/git` has only the repo URL (members of that company; others 404) — no server path, no
legacy `sshUrl`. Repository administration is not an API: creating a company creates its
repository, and startup configures every repository and hook. The SSH-key and `/api/sync` routes
were removed in R1 (the `ssh_keys` table is still created by `db/index.ts` but nothing uses it).
The admin console's calls are pinned by `server/tests/integration/admin-contract.test.ts`
(`shared-core.md`).

## Accounts and roles

- Only owners grant owner/admin: `PUT /companies/:id/members/:userId/role`,
  `POST /companies/:id/members` with role owner/admin, and admin invitations are owner-only (an
  admin adding a second account of their own as owner could take the company over).
- Nobody is put into a company without agreeing (2026-10-31): people join by accepting an
  invitation (existing accounts of other companies too). `POST …/members` adds only an account
  that once accepted an invitation to this company (`invitations.used_by`, e.g. a removed member
  coming back); any other id — unknown or existing — gets the same 403 `INVITATION_REQUIRED`, so
  the answer never tells whether an account exists. `tests/integration/account-security.test.ts`.
- Creating a company (`POST /api/companies`) follows `COMPANY_CREATION_POLICY`
  (`services/company-creation-policy.ts`; `operator`, the default and only implemented mode;
  `approved` / `self_serve` are named for later and refused at startup). Under `operator`: the
  accounts in `OPERATOR_USER_IDS` (user ids, not emails: invitation sign-ups do not verify an
  address), plus the first account of a fresh server while no company exists; anyone else 403
  `COMPANY_CREATION_RESTRICTED` (Japanese `error`: released apps show it as is). Checked before
  the body. `tests/integration/company-creation.test.ts`, `tests/unit/company-creation-policy.test.ts`.
- Company slugs are unique across the server, so a new one never depends on whether another
  company has a slug (2026-10-31; before, `abe` taken → `abe-2` told the creator so): always the
  sanitized requested slug or name (or `company`) + `-` + the first 8 characters of the new
  company's own id (the whole id in the unlikely case those collide). Existing slugs are never
  changed; nothing routes by slug. `tests/integration/company-slug.test.ts`.
- Rules follow the membership: removing a member deletes every rule naming them in that company
  (`deleteUserRules`, private folders included), so re-adding them starts from nothing; a
  promotion to owner/admin deletes them too. `everyone` rules are untouched, so nothing starts
  inheriting.
- Invitations are single-use (`services/invitations.ts` `signUp`): a sign-up with `X-Invitation-Token`
  claims the invitation atomically (`signup_claimed_at`, released if the sign-up fails) and
  records the account (`signup_user_id`); a second sign-up with the link is refused; accepting is
  a compare-and-set on `used_by` and, for a claimed link, only by that account.
  `expiresInDays`: integer 1–30 (default 7).
- Permission model: `resolveAccess` / `writeAccessSummary` / `canReadPrivateScope` live in
  `shared/core/permissions.ts` (moved from `server/src/lib/permissions.ts` in R2); storage in
  `adapters/sqlite/permission-store.ts` behind `ScopeRepository`. Reads: `services/permission-views.ts`
  (`/overview`, `/permissions`, `/me/capabilities`, `/me/write-access`, `managedFolders` for
  git-http's snapshot). Editor: `services/permission-editor.ts` (`canEditPath`, subjects, the
  outdated-app guard `guardWrite` — mutation + write-loss check in one `transactions.run`,
  rolled back by throwing, 409 `OUTDATED_CLIENTS`). With the default seed (`everyone: read + write` on the company
  scope) nothing is restricted. Managers (`departments/:id/managers`) may manage their
  departments' private folders and instruction files.

## Departments

Code: `routes/departments.ts` (HTTP) → `services/departments.ts` (rules) → the company handle's
`DepartmentRepository` (`companyData.forCompany(member.companyId).departments`)
/ the handle's `ScopeRepository` (SQLite) and `RepoStore` (`adapters/git-repo-store.ts`: shared-branch reads
from the bare repo via `lib/repo-folders.ts`, commits built in the bare repo by
`lib/bare-commit.ts` under `withCompanyLock`).

- The file system is the source of truth; the DB holds display settings (order, icon, color,
  display name); the admin UI can also perform file operations.
- Listing (and `POST /sync`, stats): `git ls-tree` the shared branch (`main`, else `master`) of
  the company's bare repo — the non-hidden root directories — then return the DB rows (by
  `sort_order`) whose folder is among them. Nothing is ever pulled or checked out: a synchronous
  `git pull` of the old working clone on every list call once froze the whole process (all API
  and git-http traffic) for 42 s on a 7.7 GB clone.
- Mutations have no working tree (`lib/bare-commit.ts`): a department folder is one entry of the
  shared branch's root tree, so create adds an entry (`.gitkeep`, `.personal/.gitignore` blobs,
  `mktree`), rename relabels it (its tree is reused), delete drops it; `commit-tree` (parent = the
  tip read, author/committer "AI Company Builder"), then a push from the bare repo to itself with
  `internalGitEnv()` — receive-pack runs the pre-receive checker (`push-check.md`). A member's
  push in between (the ref update loses) → the edit is redone on the new tip, up to 5 times.
  Then the DB is updated. Why: the old working clone (`data/workdirs/<companyId>`: pull,
  `git mv`, `git add -A`) took 119 s for a 1 MB rename in a 13 GB company; now ~1 s, mostly the
  checker's start-up (`tests/integration/department-commits.test.ts`).
- A target name is taken when a root entry (folder or file) has the same `nameKey` (NFC, A–Z
  folded); a case-only rename is allowed. The source is found by exact name, then NFC (a Mac
  commits NFD). Delete reports the files / folders under the folder, hidden entries skipped
  (`countFilesInTree`, the count the old on-disk walk made). Missing source: rename and delete
  change nothing (true / 0, 0). Departments containing a private folder cannot be deleted or
  renamed; a reserved name is refused.
- All of it runs under a per-company promise-chain lock (`withCompanyLock`,
  `lib/company-lock.ts`, port `CompanyLock`). Company creation (`services/companies.ts` →
  `adapters/git-repo-store.ts`) seeds the default department folders the same way (root commit;
  async, under the lock, before the 201). `gitAsync` with `timeoutMs` (adjustable with
  `setRepoGitTimeoutsForTests`): 60 s per local step, 300 s for the push, which kills git's whole
  process group, hook included, and fails the change (a seeding failure still creates the
  company).

## Request log

stdout is shared by every company on the server, so the request log (`lib/request-log.ts`,
mounted first in `app.ts`; it replaced `hono/logger`, which printed URLs with their query) holds
only what troubleshooting needs: `[http] <request id> <METHOD> <route pattern> <status> <ms>ms`
plus `company=` / `user=` (opaque ids, never names or emails) and route parameters listed in
`OPAQUE_PARAMS` whose value looks like an id. Never the URL, a query string, a file path, folder
or private-folder name, search term or token (an invitation `:token` is not printed). The request
id is returned in `X-Request-Id` (also on responses a handler built itself, e.g. git-http) so
support can find a member's request. The user id is noted by whoever authenticated the request
(`getUserFromRequest`, git-http's token check: `noteRequestUser`). Detailed per-company history
belongs in the per-company, access-controlled records (`agent_events`, `broker_history`,
`push_rejections`…), not in this log.

Errors are logged with `logError(tag, fixed sentence, err, ids)` (`lib/error-log.ts`), never
`console.error(…, err)`: a git error's message is its command line and stderr (paths, private
folder names, the push checker's rejections). The line holds the sentence, the error's kind
(`name`, id-shaped `code`, git's exit code / signal), `request=<id>` (the same id as the request
line and `X-Request-Id`, carried by `AsyncLocalStorage` in `lib/request-log.ts`) and the stack's
code locations — not the message. git-http drains `git http-backend`'s stderr without logging
it, and no longer logs the member's email or `PATH_INFO`. Services may import `lib/error-log`
(listed in `layering.test.ts` with that reason). Tests: `tests/unit/error-log.test.ts`, and
`tests/integration/request-log.test.ts` (a git failure naming a private folder in three routes). Test: `tests/integration/request-log.test.ts` (captures
every console output while sending paths, search terms, a relay `?key=` token and an invitation
token).

## Async only

All git in request handlers is async (`execFile`, `lib/git-exec.ts`).
`tests/security/no-exec-sync.test.ts` refuses `execFileSync` / `spawnSync` / `execSync` anywhere
in `server/src` outside an allow-list (today only startup-time `configureBareRepo` in
`lib/git-server/index.ts`). Spawned searches are queued and bounded (`company-files.md`).

## Database and data

- SQLite through better-sqlite3 (no ORM): `data/app.sqlite` (app) and `data/auth.sqlite`
  (Better Auth; one WAL connection for the process, `lib/auth.ts` `authDb`, also used by
  `/api/config` and the sign-up check — `tests/unit/auth-db.test.ts`). Schema in `server/src/db/index.ts`: `CREATE TABLE IF NOT EXISTS` at startup;
  columns added later get an idempotent check-then-`ALTER TABLE` (e.g. `migrateInvitationClaims`).
- Paths: `lib/config.ts` is the one place reading `DATA_DIR` (default `<cwd>/data`), `REPOS_DIR`
  (`<DATA_DIR>/repos`), the key broker's `BROKER_KEK_FILE` (outside `DATA_DIR`,
  `key-broker.md`), the plugin shelf's `PLUGINS_DIR` (outside `DATA_DIR`, `plugins.md`), `COMPANY_CREATION_POLICY` and `OPERATOR_USER_IDS` (read per call). `<DATA_DIR>/workdirs` (the old working clones) is no longer used; a
  leftover one can be deleted.
- Imports from `shared/` go through the `server/shared` symlink (`/app/shared` in the image):
  `import … from '../../shared/types'`, `'../../shared/core/permissions'`.

## Tests

`cd server && npx vitest run tests/<path>` for what you touched; `tests/unit`, `tests/integration`
(real git-http and hooks), `tests/security` (auth guards, path traversal,
no-exec-sync). CI runs the whole suite on ubuntu ("Server tests").

- **Fake HubSpot** (`tests/fakes/hubspot/`, milestone 3 P2): an in-memory Hono app answering the
  CRM calls the HubSpot plugin makes in HubSpot's documented shapes (v3 and dated
  `/crm/<api>/<YYYY-MM>/…` paths; deals get / list / search / update, deal properties and
  pipelines, companies, owners, notes with the 214 note → deal association, account details
  with a `portalId` per fake — another fake is another account; milestone 4: deals create /
  archive, meetings create / get / search / archive with the 212 meeting → deal association,
  contacts and deal → contact associations, the unique-value custom property
  `acb_operation_id` on deals and meetings — a duplicate is 409 `CONFLICT`, `?idProperty=`
  finds it at once while search misses new objects for `searchIndexDelayMs` —, and the
  meeting scopes as a setting, `meetingScopes`, because HubSpot does not document them),
  `pat-fake-…` keys
  with per-key scopes (403 `MISSING_SCOPES`), read-only values (400), rate limits (429) and
  faults (delay, 500, a write applied whose answer never arrives, a change made "in HubSpot").
  Tests pass `createFakeHubSpot().app` in; staging runs `pnpm fake:hubspot` (127.0.0.1:4010,
  `/__fake/*` control routes, refuses `NODE_ENV=production`). Never in the image (the Dockerfile
  copies `src/` and `shared/` only) and never imported from `src/` (`layering.test.ts`). Test:
  `tests/unit/fake-hubspot.test.ts`.
- **Fake Google** (`tests/fakes/google/`, milestone 4 G2): the same kind of app for the Google
  connector — OAuth 2.0 (`/o/oauth2/v2/auth` with a chosen "signed-in" account, deny, or
  withheld scopes; `state` and an S256 PKCE challenge required; `/token` for code + verifier
  and refresh; `/revoke`; `/oauth2/v3/userinfo`), Calendar v3 events, Meet v2 conference
  records / smartNotes / transcripts (`docsDestination`), Drive v3 file metadata
  (`version`, `modifiedTime`) and text export (BOM + CRLF, 10 MB → 403
  `exportSizeLimitExceeded`; with only `drive.meet.readonly` a file Meet did not create is 404),
  and Gmail `messages.send` (stored decoded in `fake.sent`; a From that is not the token's account
  is refused). Google's paths on one origin, so a practice redirect maps Google's hosts by path
  (the table is in `fake-google.ts`). Practice values: secrets `fake-google-secret-…`, tokens
  `ya29.fake-…` / `1//fake-…`; scopes enforced per token (403 `PERMISSION_DENIED`). Faults:
  delay, 500 / 429, a send stored whose answer never arrives, revoked access (`invalid_grant`),
  oldest refresh token dropped past the per-account limit, an event or a minutes document
  changed. Seed (`seed.ts`, `GOOGLE_SEED`): `sato@div.example` with a sales meeting
  (`suzuki@` / `yamaguchi@a-corp.example`, the fake HubSpot's deal 1000000001 contacts), an
  internal-only meeting and a follow-up whose notes hold an instruction-like line. Staging runs
  `pnpm fake:google` (127.0.0.1:4011, `/__fake/*`, refuses `NODE_ENV=production`). Same rules
  as the fake HubSpot (not in the image, not imported from `src/`). Test:
  `tests/unit/fake-google.test.ts`.

- Who reaches a company repository over git HTTP (members with a live session; others 401 /
  403 / 404 on info/refs, upload-pack and receive-pack, repository unchanged; only the two smart
  services): `tests/integration/git-http-access.test.ts`. `..%2F` company ids and repository
  names sent to every route that builds a repository path, against a sentinel repository next to
  `REPOS_DIR`: `tests/security/path-traversal.test.ts`.
