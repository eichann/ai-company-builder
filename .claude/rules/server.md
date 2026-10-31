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
    → ports/    interfaces (repositories, RepoStore, CompanyLock, Clock/IdGenerator,
                AccountDirectory, SecretCipher, UpstreamClient, Transactions)
        ↑ adapters/   sqlite/* repositories, git-repo-store.ts, accounts.ts, system.ts,
                      company-files.ts, orphaned-scopes.ts (git + orphaned_scopes table),
                      private-folders.ts (scope repositories + their rows),
                      local-secret-cipher.ts, kek-file.ts, upstream-https.ts
src/composition.ts — the only module that imports adapters; routes take `services` from it
src/cli/           operator commands (generate-broker-kek.ts), each its own composition root
```

- `server/tests/unit/layering.test.ts` enforces the direction: ports import only ports (and
  shared/core types), services only ports / services / shared / pure lib, only the composition
  root imports adapters (and `db/index.ts`, whose startup seeding runs
  `adapters/sqlite/permission-store.ts` on the connection it migrates), no route runs SQL or
  imports `db` (git-http's push snapshot and private-folder lookups use `services.access` /
  `services.scopes`), and `lib/` does not import the database except the modules listed in
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
                              PUT /broker/services/:service (+ /own-keys),
                              PUT|DELETE /broker/relay-services/:service,
                              PUT /broker/settings, POST /broker/stop-all,
                              POST /me/broker-tokens, DELETE /me/broker-tokens/:tokenId,
                              GET /me/broker-keys, PUT|DELETE /me/broker-keys/:service
                                                                              key-broker.ts
                                                                (「API キー」: key-broker.md)
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

Code: `routes/departments.ts` (HTTP) → `services/departments.ts` (rules) → `DepartmentRepository`
/ `ScopeRepository` (SQLite) and `RepoStore` (`adapters/git-repo-store.ts`: shared-branch reads
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
  `key-broker.md`), `COMPANY_CREATION_POLICY` and `OPERATOR_USER_IDS` (read per call). `<DATA_DIR>/workdirs` (the old working clones) is no longer used; a
  leftover one can be deleted.
- Imports from `shared/` go through the `server/shared` symlink (`/app/shared` in the image):
  `import … from '../../shared/types'`, `'../../shared/core/permissions'`.

## Tests

`cd server && npx vitest run tests/<path>` for what you touched; `tests/unit`, `tests/integration`
(real git-http and hooks), `tests/security` (auth guards, path traversal,
no-exec-sync). CI runs the whole suite on ubuntu ("Server tests").

- Who reaches a company repository over git HTTP (members with a live session; others 401 /
  403 / 404 on info/refs, upload-pack and receive-pack, repository unchanged; only the two smart
  services): `tests/integration/git-http-access.test.ts`. `..%2F` company ids and repository
  names sent to every route that builds a repository path, against a sentinel repository next to
  `REPOS_DIR`: `tests/security/path-traversal.test.ts`.
