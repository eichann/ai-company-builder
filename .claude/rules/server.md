---
paths:
  - "server/src/**"
  - "server/tests/**"
  - "server/package.json"
---

# Server (Hono API): routes, accounts, departments, database

Push checking is in `push-check.md`, private folders in `private-folders.md`, read-only file
access in `company-files.md`. Full text and incidents: `docs/architecture/server.md` (internal).

## Route map (mounted in `server/src/index.ts`)

```
GET  /api/config                                  setup state (no auth)
*    /api/auth/**                                 Better Auth; sign-up after the first user
                                                  needs X-Invitation-Token
/api/me                       GET, PATCH          me.ts
/api/companies                GET /, GET /:id, POST /, PATCH /:id,
                              GET /:id/members, POST /:id/members,
                              PUT /:id/members/:userId/role, DELETE /:id/members/:userId,
                              GET /:id/client-activity                       companies.ts
/api/companies/:companyId/departments
                              GET /, GET /:id, POST /, PUT /:id, DELETE /:id, GET /:id/stats,
                              POST /reorder, POST /sync, GET|PUT /:id/managers  departments.ts
/api/companies/:companyId/folder-sizes  GET ?path=&measure=                  folder-sizes.ts
/api/companies/:companyId/files         GET /tree, /content, /search          company-files.ts
/api/companies/:companyId     GET /overview, /permissions, /me/capabilities, /me/write-access
                                                                             permissions.ts
                              PUT /permissions/scopes/by-path, POST /permissions/rules,
                              PATCH|DELETE /permissions/rules/:ruleId,
                              DELETE /permissions/scopes/:scopeId/rules,
                              POST /permissions/scopes/:scopeId/move,
                              GET /permissions/effective, /permissions/folders,
                              GET /push-rejections                            permission-rules.ts
                              /private-folders…, /me/private-folders, /me/scopes,
                              POST /paths/check                               private-folders.ts
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
  `POST …/members` requires the account to exist (404 otherwise).
- Rules follow the membership: removing a member deletes every rule naming them in that company
  (`deleteUserRules`, private folders included), so re-adding them starts from nothing; a
  promotion to owner/admin deletes them too. `everyone` rules are untouched, so nothing starts
  inheriting.
- Invitations are single-use (`lib/invitation-signup.ts`): a sign-up with `X-Invitation-Token`
  claims the invitation atomically (`signup_claimed_at`, released if the sign-up fails) and
  records the account (`signup_user_id`); a second sign-up with the link is refused; accepting is
  a compare-and-set on `used_by` and, for a claimed link, only by that account.
  `expiresInDays`: integer 1–30 (default 7).
- Permission model: `resolveAccess` / `writeAccessSummary` / `canReadPrivateScope` live in
  `shared/core/permissions.ts` (moved from `server/src/lib/permissions.ts` in R2); storage in
  `lib/permission-store.ts`. With the default seed (`everyone: read + write` on the company
  scope) nothing is restricted. Managers (`departments/:id/managers`) may manage their
  departments' private folders and instruction files.

## Departments (`routes/departments.ts`)

- The file system is the source of truth; the DB holds display settings (order, icon, color,
  display name); the admin UI can also perform file operations.
- Listing (and `POST /sync`, stats): `git ls-tree` the shared branch (`main`, else `master`) of
  the company's bare repo — the non-hidden root directories — then return the DB rows (by
  `sort_order`) whose folder is among them. Read-only requests never pull or clone the server's
  working clone: a synchronous `git pull` on every list call once froze the whole process (all
  API and git-http traffic) for 42 s on a 7.7 GB clone.
- Create: mkdir → git add → commit → push → save to DB. Edit: git mv (if renamed) → commit → push
  → update DB. Delete: confirm → rm -rf + git add -A → commit → push → delete from DB.
  Departments containing a private folder cannot be deleted or renamed; a reserved name is refused.
- Mutations work in the working clone (`data/workdirs/<companyId>`, pulled first) under a
  per-company promise-chain lock (`withCompanyLock`, `lib/company-lock.ts`). Company creation
  seeds the default department folders the same way (async, under the lock, before the 201;
  `gitAsync` with `timeoutMs`: 60 s per local step, 300 s for the push, which kills git's whole
  process group, hook included, and fails the seeding while the company is still created).

## Async only

All git in request handlers is async (`execFile`, `lib/git-exec.ts`).
`tests/security/no-exec-sync.test.ts` refuses `execFileSync` / `spawnSync` / `execSync` anywhere
in `server/src` outside an allow-list (today only startup-time `configureBareRepo` in
`lib/git-server/index.ts`). Spawned searches are queued and bounded (`company-files.md`).

## Database and data

- SQLite through better-sqlite3 (no ORM): `data/app.sqlite` (app) and `data/auth.sqlite`
  (Better Auth). Schema in `server/src/db/index.ts`: `CREATE TABLE IF NOT EXISTS` at startup;
  columns added later get an idempotent check-then-`ALTER TABLE` (e.g. `migrateInvitationClaims`).
- Paths: `lib/config.ts` is the one place reading `DATA_DIR` (default `<cwd>/data`), `REPOS_DIR`
  (`<DATA_DIR>/repos`) and the working clones (`<DATA_DIR>/workdirs`).
- Imports from `shared/` go through the `server/shared` symlink (`/app/shared` in the image):
  `import … from '../../shared/types'`, `'../../shared/core/permissions'`.

## Tests

`cd server && npx vitest run tests/<path>` for what you touched; `tests/unit`, `tests/integration`
(real git-http and hooks), `tests/security` (auth guards, authorization, input validation, path
traversal, no-exec-sync). CI runs the whole suite on ubuntu ("Server tests").
