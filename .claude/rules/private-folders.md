---
paths:
  - "server/src/routes/private-folders.ts"
  - "server/src/lib/private-folders.ts"
  - "server/src/lib/git-server/scope-repo.ts"
  - "server/src/lib/client-version.ts"
  - "server/src/routes/permission-rules.ts"
  - "server/src/lib/orphaned-scopes.ts"
  - "shared/types/private-folders.ts"
  - "shared/core/reserved-paths.ts"
  - "server/tests/**/private-folders.test.ts"
  - "admin/src/lib/private-folders.ts"
  - "admin/src/lib/private-folder-help.ts"
  - "admin/src/app/**/private*/**"
---

# Private folders (server, stage 3a)

Read restriction exists only for **private folders**, which are private from the start (no
carve-out of existing folders; move files into a new private folder instead). Each one is its own
bare repository (a "scope repository"); its path is reserved in the company repository. The
contract for clients and UIs is `shared/types/private-folders.ts`. Client side:
`private-folders-client.md`. Full text and history: `docs/architecture/private-folders.md`.

## Names never leak (owner decision B)

Someone who cannot read a private folder must not learn its name, that it exists as private,
or who can see it. So:

- Departments, stats and folder sizes read the company repository, which never holds private
  content. `/me/write-access` omits unreadable private folders. `/permissions*`, `/overview`,
  `/push-rejections`, `/private-folders*` are owner/admin/manager-only, and managers see only
  their departments'. Orphan warnings never consider private folders or rules inside them.
- `[RESERVED_PATH]` and 409 messages name only what the caller typed:
  「『<path>』というフォルダ名は使えません。別の名前にしてください。」
- `/me/scopes` sends nothing about unreadable folders (salted hashes were dropped on
  2026-10-22: short Japanese names were brute-forceable). `company_path_salts` stays in the
  schema, unused.
- Company-files views treat an unreadable private folder exactly as a nonexistent path
  (`company-files.md`).

## Data and permissions

- A private folder = a `scopes` row (`kind 'folder'`) whose `repo_id` points at `scope_repos.id`.
  Rules on it: `everyone: no read, no write` + one user rule per viewer (`read`; `write` for
  editors). Owners/admins always read and write.
- A private scope never inherits (clearing / removing its last rule is refused). Rules deeper
  inside only narrow: in `resolveAccess` (`shared/core/permissions.ts`), read/write inside also
  needs read of the folder itself; a private scope without rules denies. `read: false` is
  accepted on a private folder itself only.
- The permission editor (`PUT /permissions/scopes/by-path`, `POST /permissions/rules`, `PATCH
  /permissions/rules/:id`) requires `read: false, write: false` for `everyone` / role rules on
  the folder itself (400 `PRIVATE_FOLDER_RULE`); only user rules grant access, and an editor must
  also read — so a manager cannot open their private folder to the company. Edits inside one go
  against its scope repository, skip the outdated-app guard, and moving rules into/out of one is
  refused. `GET /permissions/folders` lists private folders only to those who may edit them.

## Repositories and git-http

- `server/src/lib/git-server/scope-repo.ts`: `<REPOS_DIR>/<companyId>.scopes/<repoId>.git`,
  configured exactly like the company repo (`BARE_REPO_CONFIG` + the same hook; startup
  re-configures them), created with one commit holding sync's essential `.gitignore`. `.scopes`
  is not `*.git`, so the company route can never reach it.
- `/api/git-http/<companyId>/scopes/<scopeId>.git` (scope id, not repo id). Fetch needs READ of
  the folder, push needs WRITE somewhere in it (403 otherwise). Non-member, non-reader, unknown or
  non-private scope: the same 404. The push snapshot carries `scopePath`; paths are write-checked
  as `<scopePath>/<path>` and every other rule runs as in the company repo.

## Reservation (`[RESERVED_PATH]`, push checker)

- Rejects, for everyone, any commit or net diff that adds/modifies a path at or under a private
  folder (NFC + A–Z folded; a rename into it counts on its new side; a file named like the
  folder counts), and a file, symlink or gitlink at any **ancestor** path of a private folder.
  Deletions are never refused. Each path is followed by the reason line
  `      （『<prefix as the pusher spelled it>』というフォルダ名は使えません。別の名前にしてください。）`.
- Reserved paths reach the checker only via the git-http snapshot (`reservedPathsFor`). The
  server validates its own operations: department create/rename refuse a reserved name.
- No race: git-http registers each company receive-pack (`beginCompanyPush`) before taking its
  snapshot; creating a folder, after writing its rows, waits for pushes registered earlier (60 s,
  else 503 `BUSY`, nothing created), re-checks the company repo and rolls back if one landed at
  the path. Test: `server/tests/integration/private-folders.test.ts` "a push racing the creation".

## API (`server/src/routes/private-folders.ts`, under `/api/companies/:companyId`)

- `POST /private-folders` `{ parentPath, name, viewers?, editors?, force? }` → 201
  `PrivateFolderDetail`. Owner/admin anywhere; a department manager only inside their department;
  others 403. Name: the department folder-name rule. Default viewers: creator + the department's
  managers (creator always added; owners/admins implicit). A taken path (anything in the company
  repo, any case/NFC, or a private folder at, above or below it) → 409 `FOLDER_NAME_UNAVAILABLE`
  with the sentence above. A parent inside an unreadable private folder answers like a missing
  parent (`PARENT_NOT_FOUND`); a readable one `ALREADY_PRIVATE`. Runs under the company lock.
- Version gate: the company's **first** private folder is refused with 409 `OUTDATED_CLIENTS`
  (`members`, `canForce`) while any member's app is not known to support private folders
  (`supportsPrivateFolders`, build commit date ≥ `PRIVATE_FOLDERS_CLIENT_COMMIT_DATE` =
  `20261022085300`, the 3b merge; unknown = not ready). Owner/admin `force: true` overrides; a
  manager's `force` → 403 `FORCE_NOT_ALLOWED`. Why: older apps never receive the folder and retry
  the `[RESERVED_PATH]` rejection forever. Tests use `setPrivateFoldersClientCutoffForTests`.
- `GET /private-folders` (owner/admin: all; managers: their departments'),
  `GET /private-folders/:scopeId`, `PUT /private-folders/:scopeId/members` `{ viewers, editors? }`
  (owner/admin and the department's managers; anyone else 404). Counts include owners/admins.
- `POST /private-folders/:scopeId/make-public` (owner/admin): refuse new pushes to the scope repo
  and wait for running ones, archive, write its tree into company `main` at the same path as ONE
  commit (compare-and-swap `update-ref`, retried; idempotent), then in one transaction make every
  rule there readable (write unchanged) and clear `repo_id`, then delete the scope repo.
- `DELETE /private-folders/:scopeId?confirm=<last path segment, NFC>` (owner/admin; else 400
  `CONFIRMATION_REQUIRED`): stop pushes, archive, remove rules/scopes at and under the path and
  the `scope_repos` row in one transaction, then the repo → `{ path, archived: true }`.
- Archive (`archivePrivateFolder`, before delete and make-public; on failure nothing is removed):
  `git bundle create --all` into `PRIVATE_FOLDER_ARCHIVE_DIR` (default
  `<DATA_DIR>/backups/private-folders`)`/<companyId>/<time>_<action>_<scopeId>.bundle` + `.json`
  sidecar; dirs 0700, files 0600; a `private_folder_archives` row. Never served or named in a
  response; restore = `git clone <bundle>`.
- `GET /me/scopes` (any member, ETag/304) → `{ version, scopes: [{ scopeId, path, cloneUrl,
  clonePath, canWrite }] }`, readable folders only. `GET /me/private-folders`: the readable ones with `canWrite`, viewer count
  and the first viewers (named viewers before owners/admins).
- `POST /paths/check` `{ paths: string[], files?: string[] }` (any member, ≤ 50 paths, ≤ 60 per
  member per minute → 429 `RATE_LIMITED` + `Retry-After`) → `{ results: [{ path, usable }] }`.
  `usable: false` exactly when a push would get `[RESERVED_PATH]`: at or under a private folder
  the caller cannot read, or — for a path also in `files` — a strict ancestor of any private
  folder (`isPathUsable`, `shared/core/reserved-paths.ts`). Same shape and work for every path;
  never says which folder or why; paths are not logged. Older apps omit `files`.
- Departments containing a private folder cannot be deleted or renamed (409
  `PRIVATE_FOLDERS_INSIDE`).
- There is deliberately no MCP tool to create private folders: only people, through the admin
  console or the app's dialog.
- Tests: `server/tests/unit/private-folders.test.ts`, `server/tests/integration/private-folders.test.ts`.
