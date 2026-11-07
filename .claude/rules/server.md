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
routes/    HTTP only: a guard (routes/guards.ts), parsed input, call a service, map the answer
  → services/   business rules; authorization through services/access.ts (shared/core roles)
    → ports/    interfaces (CompanyDataSource = company handles, repositories, RepoStore, CompanyLock, Clock/IdGenerator,
                AccountDirectory, SecretCipher, UpstreamClient, Transactions)
        ↑ adapters/   sqlite/* repositories, git-repo-store.ts, accounts.ts, system.ts,
                      company-files.ts, orphaned-scopes.ts (git + orphaned_scopes table),
                      private-folders.ts (scope repositories + their rows),
                      local-secret-cipher.ts, kek-file.ts, upstream-https.ts
src/composition.ts — the only module that imports adapters (with its lane parts composition/*.ts); routes take `services` from it
src/cli/           operator commands (generate-broker-kek.ts, company-archive.ts, erase-content.ts), each its own composition root
```

- `server/tests/unit/layering.test.ts` enforces the direction: ports import only ports (and
  shared/core types), services only ports / services / shared / pure lib, only the composition
  root imports adapters (and `db/index.ts`, whose startup seeding runs
  `adapters/sqlite/permission-store.ts` and the content-store move on the connection it migrates;
  the `db/schema/*` modules import no adapter), no route runs SQL or
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

## Route guards (2026-11-02, required before the next release)

Every endpoint names, as its first handler, a guard from `src/routes/guards.ts`, so a forgotten
sign-in or membership check cannot be written:

```ts
route.get('/things', companyMember, (c) => things.list(c.var.member))          // session + member of :companyId
route.put('/things', companyMember, serviceBody, (c) => things.save(c.var.member, c.var.body))
route.post('/x', companyMember, body(XInput), (c) => …c.var.body…)            // zod; bad input → 400 fixed text
route.get('/', signedIn, (c) => …c.var.user…)                                   // session, no company
route.post('/hook', publicRoute('what proves the caller'), (c) => …)            // + PUBLIC_ENDPOINTS
```

Also: `companyAdmin(error)` (owner/admin only; members and non-members alike get 403 `{ error }` —
the endpoints that always answered so: invitations, adding / removing members),
`companyMemberNotFound(body)` (the endpoint's own 404 body for a non-member: `/api/git`),
`signedInOr(error)` (the endpoint's own 401 text), `aiReads` / `aiActs` (a record token on
/api/records-ai, `c.var.holder`; records.md), `ownCredential(reason)` (git-http's Basic auth, the
key broker's relay token; still 401 without it). Company routes always name the company
`:companyId` (companies.ts too). Where a role check must answer before the body (403 before 400),
take `serviceBody` and parse it with a zod schema in the handler after that check.

- `companyMember`: 401 `{ error: 'Unauthorized' }` without a session; 404 `Company not found or
  access denied` for a non-member (same as a company that does not exist). The handler uses
  `c.var.member` (company, user, role from the server) and never reads `companyId` from the URL.
  Role checks stay in the services (their 403 texts are part of the API).
- `body(schema, error?)` / `query(schema, error?)` (zod): the 400 answer is a fixed text, never
  the request's values or zod's message. They run before the handler, so use them only where the
  endpoint answered 400 before any role check; a service that checks the role first and then its
  own `unknown` input gets `serviceBody` (null when not JSON), keeping who → body → rules.
- Enforcement: `tests/security/auth-guards.test.ts` fails for an endpoint whose first handler is
  not a guard, and for `publicRoute` outside `PUBLIC_ENDPOINTS`; `eslint.config.mjs` forbids
  `getUserFromRequest`, `c.req.json()` and `c.req.param('companyId')` in `src/routes`
  (`guards.ts` and the app-wide `client-activity-middleware.ts` excepted) — errors, no
  exceptions list (every route was moved by 2026-11-02).
- `guard-tags.ts` holds the guard registry and `publicRoute` without the session or composition
  imports, so a public route factory (`slack.ts`) stays light.

## Lane markers (parallel lanes A connectors, B inbox, C plugins)

Three lanes add server code in parallel; these spots are where they would collide, so each has
markers `// lane A ▼` … `// lane C ▲` (the ▲ lines keep the blocks apart for git):

- `src/composition/{connectors,inbox,plugins}.ts` — each lane wires its services in its own file;
  `createServices` calls each once on its own line (between the markers) and spreads the result
  into `services`. These files may import adapters like `composition.ts` (layering test).
- `src/app.ts` (route imports and `app.route` lines), `src/db/index.ts` (imports, `SCHEMA`,
  migration calls), `ports/company-data.ts` and `adapters/sqlite/company-data.ts` (imports and
  handle fields), `tests/unit/company-scoped-sql.test.ts` (`HANDLE_TABLES`, `HANDLE_FACTORIES`),
  `tests/integration/permission-matrix.test.ts` (`MATRIX`, `CROSS`, `NOT_OBJECT_IDS`).

A lane adds lines only right under its own `▼`, never moves or removes a marker, and keeps its
tables in its own `db/schema/<lane file>.ts` (idempotent migrations, no numbers).

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
  members' grants, pending starts, history, `adapters/sqlite/connectors.ts`, `google-connector.md`)
  and `outbound` (mail drafts, their recipients per version, typed addresses, send attempts,
  `adapters/sqlite/outbound-mail.ts`, `outbound-mail.md`) and `tasks` (the task settings and
  department membership 所属する部署, `adapters/sqlite/task-settings.ts`, `tasks.md`) and `aiRuns`
  (execution runs of 「AI の番」 and their operations by idempotency key, `adapters/sqlite/ai-runs.ts`,
  `records.md` "Execution runs") and `securityAlerts` (「気になる動き」: alerts, their Slack setting,
  members' hourly download counts, the rules' read-only queries; `security-alerts.md`).
  Every company table has `company_id`, and handle statements filter by it directly. New tables
  (stage 4: types, company map, state engine…) are created behind the handle from the start,
  with `company_id`.
- `scope_rules` / `department_managers` got `company_id` later (2026-10-31,
  `db/schema/permissions.ts` `migrateRuleAndManagerCompanies`, every startup, idempotent): added nullable
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
- The rule subject `department` (2026-11-06, `migrateDepartmentRuleSubject`, after the above):
  `scope_rules`' CHECK listed only everyone / role / user, which SQLite cannot alter, so the
  table is rebuilt once (rows with their rowid, ids and company kept; indexes and the company
  triggers made again) and triggers `scope_rules_department_insert|update` keep a department
  rule naming a department of its own company. An older build keeps working on the database
  (it never writes such a rule; its push checker refuses a snapshot holding one: `[HOOK_ERROR]`,
  never a wrong allow). Test: `tests/unit/department-rule-subject-migration.test.ts`.
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
/api/companies                GET /, GET /:companyId, POST /, PATCH /:companyId,
                              GET /:companyId/members, POST /:companyId/members,
                              PUT /:companyId/members/:userId/role, DELETE /:companyId/members/:userId,
                              GET /:companyId/client-activity                companies.ts
/api/companies/:companyId/departments
                              GET /, GET /:id, POST /, PUT /:id, DELETE /:id, GET /:id/stats,
                              POST /reorder, POST /sync, GET|PUT /:id/managers,
                              GET|PUT /:id/members (所属する部署: tasks.md)     departments.ts
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
                              GET|PUT /skill-editors, PUT /skill-editors/everyone (owner/admin)
                                                                             skill-editors.ts
                              /private-folders…, /me/private-folders, /me/scopes,
                              POST /paths/check                               private-folders.ts
                              POST|GET /agent-events, /agent-events/summary,
                              GET|PUT /agent-events/settings (+ /retention-preview),
                              GET /agent-events/viewers                       agent-events.ts
                                                                (AI action log: agent-events.md)
                              GET|PUT /agent-sandbox, PUT /agent-sandbox/overrides/:userId,
                              GET /me/agent-policy                            agent-sandbox.ts
                                                                (「AI の囲い」: agent-sandbox.md)
                              GET|PUT /second-opinion                         second-opinion.ts
                                                                (もう一方の AI に聞く: chat-and-agents.md)
                              GET /security-alerts, PUT /security-alerts/settings (owner/admin)
                                                                             security-alerts.ts
                                                                (気になる動き: security-alerts.md)
                              GET|PUT /task-settings, GET|PUT /me/work-switches task-settings.ts
                              GET /home, PUT /home/holidays-checked           admin-home.ts
                                                                (管理画面のホーム: "Admin home" below)
                              POST /viewers (見られる人)                      viewers.ts
                                                                (やることの一覧の設定: tasks.md)
                              GET|POST /agent-stops, DELETE /agent-stops/:stopId,
                              GET /me/events (SSE push channel)               agent-stops.ts
                                                                (緊急停止: agent-stop.md)
                              GET|POST /absences, DELETE /absences/:absenceId
                                                                (代わりの人: records.md)   absences.ts
                              GET /broker, POST /broker/keys,
                              PUT /broker/keys/:keyId/secret, PATCH|DELETE /broker/keys/:keyId,
                              PUT /broker/services/:service (+ /own-keys, /read-only, /default-key),
                              PUT|DELETE /broker/relay-services/:service,
                              PUT /broker/settings, POST /broker/stop-all,
                              POST /me/broker-tokens, DELETE /me/broker-tokens/:tokenId,
                              GET /me/broker-keys, PUT|DELETE /me/broker-keys/:service
                                                                              key-broker.ts
                                                                (「API キー」: key-broker.md)
                              GET /me/notifications, POST /me/notifications/read,
                              GET|PUT /me/notifications/settings              notifications.ts
                                                                (知らせ: notifications.md)
                              GET|PUT /records/settings, GET /records/problems,
                              POST /records/reindex, GET /records/types,
                              POST /records/query, GET /records/item/:recordId,
                              GET /records/my-turn, POST /records/item,
                              POST /records/item/:recordId/actions/:action,
                              POST /records/item/:recordId/file-links (+ /remove),
                              POST …/undo, GET …/history, GET …/versions/:version,
                              POST /me/record-tokens, DELETE /me/record-tokens/:tokenId   records.ts
                              GET /ai-runs, POST /ai-run-claims, GET /ai-runs/:runId,
                              POST /ai-runs/:runId/renew | finish | retry,
                              POST /ai-runs/:runId/operations/:key/reconcile   ai-runs.ts
                                                                (実行の管理, S10b: records.md "Execution runs")
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
                              POST /outbound-recipients, POST /outbound,
                              GET|PUT /outbound/:messageId, GET|POST …/recipients,
                              POST …/attachments, GET|DELETE …/attachments/:sha256,
                              POST …/send, POST …/resolve, POST …/discard  outbound-mail.ts
                                                                (送るもの: outbound-mail.md)
/api/oauth                    GET /google/callback — public: Google sends the browser back;
                              the state finds the company (google-connector.md)  oauth.ts
                              GET|PUT /google/minutes-folder, POST /me/minutes/check,
                              GET /me/minutes/item/:recordId/text,
                              POST /me/minutes/item/:recordId/bundle             minutes.ts
                                                                (議事録の取り込み: minutes.md)
                              GET /me/calendar/today                          calendar.ts
                                                                (今日の予定: calendar.md)
/api/records-ai               GET /types, /my-turn, /item/:recordId(/history), POST /query,
                              POST /item, POST /item/:recordId/actions/:action,
                              POST /item/:recordId/file-links (+ /remove),
                              GET /minutes/:recordId/text, POST /minutes/:recordId/bundle,
                              POST /plugins/:pluginId/records/:recordId/operations/:operation,
                              GET /plugins/:pluginId/operations/:operationId,
                              POST /outbound-recipients, POST /outbound, GET|PUT /outbound/:messageId,
                              POST /outbound/:messageId/attachments, DELETE …/attachments/:sha256
                              (drafts only: no send, no download) — the AI's
                              routes (record token instead of a session; records.md) records-ai.ts
                                                                (company map: records.md)
/api/broker                   GET|POST|PUT|PATCH|DELETE /:service/* — the key broker's relay
                              (token instead of a session; key-broker.md)      broker-relay.ts
/api/git                      GET /repos/:companyId → { companyId, httpsUrl }  git.ts
/api/git-http                 smart HTTP for /<companyId>.git and
                              /<companyId>/scopes/<scopeId>.git               git-http.ts
/api/companies/:companyId     GET /approvals, GET /approvals/:approvalId,
                              POST /approvals/:approvalId/approve | send-back | withdraw
                              (session only; approvals.md)                    approvals.ts
/api                          GET|POST /companies/:companyId/invitations,
                              DELETE …/invitations/:id, GET /invitations/:token,
                              POST /invitations/:token/accept                 invitations.ts
```

`/api/git` has only the repo URL (members of that company; others 404) — no server path, no
legacy `sshUrl`. Repository administration is not an API: creating a company creates its
repository, and startup configures every repository and hook. The SSH-key and `/api/sync` routes
were removed in R1 (the `ssh_keys` table is still created by `db/schema/company.ts` but nothing uses it).
The admin console's calls are pinned by `server/tests/integration/admin-contract.test.ts`
(`shared-core.md`).

## Sign-in (Better Auth, `lib/auth.ts` + `lib/auth-settings.ts`)

- **Base URL = `PUBLIC_URL`'s origin**, never a request's Host header. Production
  (`NODE_ENV=production`) refuses to start without a valid http(s) `PUBLIC_URL`, like a missing
  `AUTH_SECRET`; outside production it may be unset (then taken from each request, as before).
- **Trusted origins** (Better Auth and the API's CORS, one list): `PUBLIC_URL` and `app://`
  (what every released desktop app sends on sign-in / sign-up / sign-out, from the main
  process); the dev servers (`localhost:5173`, `localhost:3100`) and the compose names
  (`api:3001`, `admin:3100`) only outside production. The admin console reaches the API on
  `PUBLIC_URL` (Caddy: `/api/*` → api); its own `/api/*` proxy passes the browser's Origin through.
  A new origin needs a reason a released app or the admin actually sends it.
- The origin check is stated on (`disableOriginCheck: false`), so it also runs under
  `NODE_ENV=test`. Sign-in attempts are rate-limited in production per client address
  (`X-Forwarded-For`, set by Caddy; memory storage): `SIGN_IN_RATE_LIMIT`, 10 a minute.
  Cookies in production: `__Secure-`, Secure, HttpOnly, SameSite=Lax.
- `tests/security/auth-origins.test.ts` (the production list, the start refusal, a dev origin
  refused by the real instance, the base URL, the per-address limit).

## Accounts and roles

- Only owners grant owner/admin: `PUT /companies/:companyId/members/:userId/role`,
  `POST /companies/:companyId/members` with role owner/admin, and admin invitations are owner-only (an
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
  `GET /api/me` answers the same check as `canCreateCompany` (`mayCreate(user.id).ok`, this
  account only; nothing about who the operators are), and the admin console and desktop app show
  「会社を作成」 only when it is not `false` (absent from an older server: shown, still refused;
  owner decision 2026-11-02). A non-operator with no company is told to open their invitation
  link. Same test file; `admin/tests/company-creation.test.tsx`, `client/tests/ui/company-selector.spec.ts`.
- Company slugs are unique across the server, so a new one never depends on whether another
  company has a slug (2026-10-31; before, `abe` taken → `abe-2` told the creator so): always the
  sanitized requested slug or name (or `company`) + `-` + the first 8 characters of the new
  company's own id (the whole id in the unlikely case those collide). Existing slugs are never
  changed; nothing routes by slug. `tests/integration/company-slug.test.ts`.
- Creating a company is all or nothing (2026-11, `services/companies.ts` `tryCreate`): for a
  company with the shared folder ("Companies without a shared folder" below), the
  repository and its seeded department folders first (async), then the company, owner
  membership, default departments and permission scopes in one `transactions.run`. Any failure
  rolls the rows back, removes the repository (`RepoStore.removeCompanyRepo`) and answers 503
  `COMPANY_CREATION_FAILED` (Japanese `error`, shown as is by the admin console). Before, a
  company without its repository, departments or scopes was created and reported as success.
  `tests/integration/company-seeding.test.ts`.
- `GET …/departments` and `GET …/departments/:id/stats` answer 500 when git cannot read them,
  never `success: true` with `[]` / "0 files, no folder" (a broken company looked like one
  without departments; a full folder looked empty in the delete warning).
  `departments-list.test.ts`, `department-stats.test.ts`.
- Rules follow the membership: removing a member deletes every rule naming them in that company
  (`deleteUserRules`, private folders included) and takes them off every members-only record's
  list (`RecordRepository.forgetMember`, `records.md` "Members-only records"), so re-adding them starts from nothing; a
  promotion to owner/admin deletes them too. `everyone` rules are untouched, so nothing starts
  inheriting.
- Invitations are single-use (`services/invitations.ts` `signUp`): a sign-up with `X-Invitation-Token`
  claims the invitation atomically (`signup_claimed_at`, released if the sign-up fails) and
  records the account (`signup_user_id`); a second sign-up with the link is refused; accepting is
  a compare-and-set on `used_by` and, for a claimed link, only by that account.
  `expiresInDays`: integer 1–30 (default 7).
- An invitation may carry 所属 (`departmentIds`, 2026-11-02, 管理画面の見直し 2-2): unique ids of
  the inviting company's departments (owner / admin, as for invitations; another company's id
  answers 400 like an unknown one, nothing created; `invitations.department_ids`, JSON). Accepting
  adds those `department_members` rows (created by the inviter) in the accept transaction,
  skipping a department deleted since; the app's first setup downloads exactly them
  (`download-choices.md`). The public `GET /invitations/:token` answers `inviterName` and
  `departmentNames` for the page (「〇〇さんが、（会社名）に招待しています」); `/api/config` answers
  `appDownloadUrl` (`APP_DOWNLOAD_URL`, https only, `lib/config.ts`). The page's 「アプリを開く」
  is `ai-company-builder://open?server=<origin>` (`admin/src/lib/app-link.ts`): the origin only,
  never the token. `account-security.test.ts` 「所属 on the link」, `admin/tests/invite.test.tsx`.
- Permission model: `resolveAccess` / `writeAccessSummary` / `canReadPrivateScope` live in
  `shared/core/permissions.ts` (moved from `server/src/lib/permissions.ts` in R2); storage in
  `adapters/sqlite/permission-store.ts` behind `ScopeRepository`. Reads: `services/permission-views.ts`
  (`/overview`, `/permissions`, `/me/capabilities`, `/me/write-access`, `managedFolders` for
  git-http's snapshot). Editor: `services/permission-editor.ts` (`canEditPath`, subjects, the
  outdated-app guard `guardWrite` — mutation + write-loss check in one `transactions.run`,
  rolled back by throwing, 409 `OUTDATED_CLIENTS`; also run by `PUT …/departments/:id/members`,
  since who belongs decides who writes under a department rule). With the default seed
  (`everyone: read + write` on the company scope) nothing is restricted. Rule subjects:
  `everyone`, `role`, `department` (the people who belong to it, 所属; `parseSubject` takes only
  a department of the actor's company — another company's id answers 400 `Unknown department`
  like one that exists nowhere — and a trigger refuses a row naming another company's
  department or none; who belongs is read from `department_members` with the rules as
  `memberIds`, never stored on the rule; deleting the department deletes the rules naming it;
  labelled 「〇〇に所属する人」), `user`. Managers (`departments/:id/managers`) may manage their
  departments' private folders and instruction files, and the skill files in their departments.
- 「Skill を直せる人」 (`skill_editors`, `department_id` NULL = the whole company; `ScopeRepository`,
  `departments.replaceSkillEditors`, `permissionViews.skillEditing`): who else may change skill
  files (`push-check.md`). Owner/admin keep the lists (`GET|PUT /skill-editors`, admin 「フォルダ」);
  they reach the push snapshot and `/me/capabilities` as `skillEditing { everywhere, folders }`.
  No folder access by itself. 「全員が直せる」 (`skill_editing_settings`, owner decision 2026-11-05,
  off by default) answers `everywhere` for every member; the lists are kept. A department's rows follow its id through a rename and go with it;
  leaving the company removes the person's rows.
- Words (owner decision 2026-11-02): a department manager (`department_managers`) is
  **「部署の管理役」** on every screen, message and server sentence (admin console, app, push-check
  report, errors). 「責任者」 means only the owner of a 案件・プロジェクト (a type's `owner` field), and a
  business plugin's own role labels (e.g. 営業の責任者) stay as the plugin declares them. Identifiers
  (`department_managers`, `dept_manager`, `managerIds`) and wire markers do not change.

## Departments

Code: `routes/departments.ts` (HTTP) → `services/departments.ts` (rules) → the company handle's
`DepartmentRepository` (`companyData.forCompany(member.companyId).departments`)
/ the handle's `ScopeRepository` (SQLite) and `RepoStore` (`adapters/git-repo-store.ts`: shared-branch reads
from the bare repo via `lib/repo-folders.ts`, commits built in the bare repo by
`lib/bare-commit.ts` under `withCompanyLock`).

- (A company without the shared folder: the rows are the departments, below "Companies without a
  shared folder".) The file system is the source of truth; the DB holds display settings (order, icon, color,
  display name); the admin UI can also perform file operations.
- Listing (and `POST /sync`, stats): `git ls-tree` the shared branch (`main`, else `master`) of
  the company's bare repo — the non-hidden root directories — then return the DB rows (by
  `sort_order`) whose folder is among them. Nothing is ever pulled or checked out: a synchronous
  `git pull` of the old working clone on every list call once froze the whole process (all API
  and git-http traffic) for 42 s on a 7.7 GB clone.
- Access of a department created through `POST /departments` (owner decision 2026-11-06):
  its scope gets `everyone: read` + `department <id>: read + write` in the same transaction as
  the row (`seedDepartmentMemberWriting`, only when the scope has no rules yet): everyone reads,
  only the people who belong (`tasks.md` "Department membership") and owner/admin write; nobody
  belongs at first. Older departments and the company's default departments keep inheriting
  `everyone: read + write`; nothing is migrated. Test:
  `tests/integration/department-member-writing.test.ts`.
- Mutations have no working tree (`lib/bare-commit.ts`): a department folder is one entry of the
  shared branch's root tree, so create adds an entry (`.gitkeep`, `.personal/.gitignore` blobs,
  `mktree`), rename relabels it (its tree is reused), delete drops it; `commit-tree` (parent = the
  tip read, author/committer "AI Company Builder"), then a push from the bare repo to itself with
  `internalGitEnv()` — receive-pack runs the pre-receive checker (`push-check.md`). A member's
  push in between (the ref update loses) → the edit is redone on the new tip, up to 5 times.
  Then the DB is updated (a rename moves the department's scopes and its records — server
  records' folder, links to files under it: `records.md` "Links to files"). Why: the old working clone (`data/workdirs/<companyId>`: pull,
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
  process group, hook included, and fails the change (a seeding failure fails the whole
  company creation, below).

## Companies without a shared folder (owner decision 2026-11-07)

A company is made with the shared company folder (`folderKind: git`, the repository + sync, as
every company before; the default) or without (`none`: each member works in a folder of their own
PC). Side by side; an existing company is `git` (`companies.folder_kind`, `migrateCompanyFolderKind`,
default `'git'`, CHECK git / none). Chosen at `POST /api/companies { folderKind }` (operators, as
creating at all; anything else 400 `INVALID_FOLDER_KIND`), **not changeable later**. Answered as
`folderKind` by `GET /api/companies` and `GET /api/companies/:companyId` (old apps ignore it).
Rule and words: `shared/core/company-folder.ts` (only an exact stored `git` has a folder:
`storedCompanyFolderKind`). The services ask `services/company-folder.ts` (`CompanyFolders`: `has`,
`require` → 409 `NO_COMPANY_FOLDER` with a Japanese `error`, `departmentPlaceOf`) — a capability,
never a stand-in that pretends a repository exists. For `none`:

- Creation makes no repository (repo_path NULL); its records are indexed at once (core types).
- Departments are the rows (list, create, rename, delete change rows only; a folder name is taken
  once by `nameKey`; stats `{0, 0, exists: false}`); `POST /departments/sync` 409.
- 409 `NO_COMPANY_FOLDER`: `POST /private-folders`, `/files/*`, `/folder-sizes`,
  `/api/git/repos/:companyId`. git-http answers 404 for the company and its scope repositories
  (like a missing repository, before the membership check), whatever is on disk.
- Permission rules take the company and its departments only (`/permissions/folders` lists the
  departments, nothing inside them). Record places: departments; file links refused (`records.md`).
- Company Skills (plugin steps' `company_skill`) are none (`STEP_SKILL_MISSING`); company types from
  `.acb/types/` none.
- **Gap today**: read restriction exists only through private folders, so nothing can restrict who
  reads a `none` company's department records (`POST /permissions/rules` with `canRead: false`
  → 400 `READ_RESTRICTION_UNAVAILABLE`); only owner-only and members-only records are narrower. A
  read-restricted place without git (per department / place, people or groups) and the department
  visibility editor are the next work, before a `none` company is used for real (owner 2026-11-07).
  File links on records will be a Drive (later OneDrive) file id + revision + fingerprint, or an
  owner-only local link — no general upload.
- Admin console: 「会社を作成」 asks 「全社フォルダ」 (使う（今までどおり）／使わない; `admin/src/lib/company-folder.ts`);
  for `none` the menu has no 「フォルダ」 (the page, reached by URL, says why) and 「部署」 no
  「フォルダを取り込む」. Texts that speak of files being synced or downloaded have a `none` version
  (`NO_FOLDER_WORDS`, owner 2026-11-07): the invitation's 「所属する部署」 (the department is for
  affiliation, where records are placed and whom requests go to), the member role, removing a
  member, leaving the company, the home's 部署 step hint and its empty state; the members table has
  no 「最終同期」 and the home no 「しばらく同期していません」 (nobody syncs): `GET /home` answers
  `notSyncedRecently: []` for a `none` company (owner and manager views; `admin-home.ts`
  `syncAttention`, test `tests/integration/admin-home.test.ts`) and the admin ignores it there too. The desktop app's side:
  `sync.md` "Companies without the shared company folder".
- Test: `tests/integration/company-without-folder.test.ts`, `tests/unit/company-folder-kind-migration.test.ts`,
  `admin/tests/company-without-folder.test.tsx`.

## Admin home

`GET /api/companies/:companyId/home` (`routes/admin-home.ts` → `services/admin-home.ts`) is the
admin console's home (管理画面の見直し 2-1): 「最初にやること」 and 「対応が必要なこと」 in one answer.

- Owner / admin: six steps, each judged from the company's own data — a department exists; two
  or more members; every department has someone who belongs to it (所属; a 部署の管理役 is only
  counted as a hint); Google usable (`byOperator`: the operator registers it, owner decision
  2026-11-02); a minutes folder chosen; 「会社の休みを確かめた」. The last is the one mark set by
  hand (`PUT /home/holidays-checked { checked: true }`, owner/admin; table `admin_setup_marks`
  behind the handle's `tasks`; the first time is kept). Attention: the overview's lists
  (`permission-views.ts`) plus the count of one meeting's outputs made twice, the plugins that
  are on but cannot run, and 「気になる動き」 of the last 7 days (`securityAlerts`, `security-alerts.md`).
- A department manager who is not an owner / admin: no steps; only the sync and app state of the
  members who belong to the departments they manage. Blocked syncs and orphaned rules are left
  out (their paths may name a private folder the manager does not read). Anyone else 403.
  Test: `tests/integration/admin-home.test.ts`.

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
`tests/integration/request-log.test.ts` (a git failure naming a private folder in three routes).
An error no route handled reaches `app.onError` (`app.ts`): it is logged the same way
(`[http] Unhandled error in a request: <kind> request=<id>`) and answered with the fixed
500 `{ error: 'サーバーでエラーが起きました', code: 'INTERNAL' }` (no message, no stack; an
`HTTPException` keeps its own answer); an unknown path answers 404
`{ error: 'Not found', code: 'NOT_FOUND' }`. Routes still answer their own errors first. Test:
`tests/integration/unhandled-errors.test.ts`. Test: `tests/integration/request-log.test.ts` (captures
every console output while sending paths, search terms, a relay `?key=` token and an invitation
token).

## Async only

All git in request handlers is async (`execFile`, `lib/git-exec.ts`).
`tests/security/no-exec-sync.test.ts` refuses `execFileSync` / `spawnSync` / `execSync` anywhere
in `server/src` outside an allow-list (today only startup-time `configureBareRepo` in
`lib/git-server/index.ts`). Spawned searches are queued and bounded (`company-files.md`).

## Jobs on a timer

Started once per process by `index.ts` (never by `composition.ts`, which tests import), timers
unref'd: the AI action log's retention (daily), outbound mail bodies' retention (daily) and the
**server clock** (`services/server-clock.ts`, every 5 minutes; `notifications.md` "The server
clock"; it also runs 「気になる動き」's sweep, `security-alerts.md`). A new time-based job goes into the server clock rather than a timer of its own, and
keeps its rules: never runs the AI, writes records only through the engine's writers, takes
each company through its own handle with a per-company limit and a yield between companies,
refuses to overlap itself, and derives everything from stored rows (a restart or a second run
changes nothing more).

## Database and data

- SQLite through better-sqlite3 (no ORM): `data/app.sqlite` (app) and `data/auth.sqlite`
  (Better Auth; one WAL connection for the process, `lib/auth.ts` `authDb`, also used by
  `/api/config` and the sign-up check — `tests/unit/auth-db.test.ts`). Schema: one module per area in `server/src/db/schema/` (company, permissions, agents,
  broker, records, plugins, connectors, fixed-payloads, tasks, content-store, outbound-mail,
  notifications, ai-runs), each with its tables, indexes and migrations; `server/src/db/index.ts`
  `initDatabase` is the one ordered entry point: every area's `CREATE TABLE IF NOT EXISTS` in one
  batch at startup (a new area goes in its `SCHEMA` list), then the migrations in a fixed order,
  then the permission seeding. Columns added later get an idempotent check-then-`ALTER TABLE`
  (e.g. `migrateInvitationClaims`). A migration that runs an adapter stays in `db/index.ts`
  (`migrateRecordContents`); tests import every migration from `src/db`.
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
  Gmail `messages.send` and its media upload `/upload/gmail/…/messages/send?uploadType=media`
  (stored decoded in `fake.sent` with `via`, the raw message and its attachments; a From that is
  not the token's account is refused), and Sheets v4 (spreadsheets.get / batchUpdate, values get / batchGet / update /
  batchUpdate / append / clear / batchClear; scopes per token, each spreadsheet's editors and
  readers → 403 PERMISSION_DENIED; `fake.spreadsheet(id)`). Google's paths on one origin, so a practice redirect maps Google's hosts by path
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
