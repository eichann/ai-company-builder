---
paths:
  - "client/electron/sync/private-*.ts"
  - "client/electron/sync/path-check.ts"
  - "client/electron/sync/reserved-path.ts"
  - "client/electron/private-folders-api.ts"
  - "client/electron/private-read-guard.ts"
  - "client/electron/features/private-folders/**"
  - "client/shared/private-folder-*.ts"
  - "client/src/hooks/usePrivateFolders.ts"
  - "client/src/components/skill-ui/PrivateFolderHelp.tsx"
  - "client/src/components/skill-ui/NewFolderDialog.tsx"
  - "client/src/features/files/api.ts"
  - "client/tests/private-folder*"
  - "client/tests/sync/private-folders.test.ts"
---

# Private folders in the app (client sync, stage 3b)

Builds on the server contract in `private-folders.md` / `shared/types/private-folders.ts`.
Names never leak (owner decision B) applies here too: nothing the app commits to the company
repository, and nothing it shows to a non-reader, may name a private folder. Full text:
`docs/architecture/private-folders.md` (internal).

## Code

`sync/private-folders.ts` (scope cache, `.git/info/exclude` block, clone checks, `safeScopeDir`,
`cloneUrlAllowed`, `privateBackupsDir`), `sync/private-sync.ts` (prepare / place / read-only
sync), `sync/path-check.ts` (`POST …/paths/check`), `sync/reserved-path.ts` (`[RESERVED_PATH]`),
orchestration in `sync/git-sync.ts`; IPC `features/private-folders/` (`guards.ts` serves the
chat guards and the file-operation refusal). The renderer reaches them through
`src/features/files/api.ts`: `PrivateFolderReads` (the member's readable folders, who may
create where) and `PrivateFolderOutbound` (create one: the server makes its repository; only
people, never the chat).

## Model

- On disk a readable private folder is a full clone of its scope repository at its path inside
  the company checkout (also for a partial-clone member). The company repo ignores it through
  its own `.git/info/exclude` (managed block, NFC and NFD, `writePrivateExcludes`) — never the
  shared `.gitignore`, which would show the name to everyone.
- Cache: the last `/me/scopes` answer (readable folders only) in `.git/acb-private-scopes.json`
  (companyId, version, scopes, `pendingPublic`). Offline syncs and the chat's read-only check use
  it. Without any answer the cached one applies: nothing is deleted or handed over, and an
  existing `info/exclude` block is kept when the cache is missing.
- A private folder is downloaded or not as a whole (no exclusions inside). It is excluded when it
  lies at or under an excluded folder. The settings tree lists readable ones under their parent
  (lock, 「非公開」, no size). Applying runs `applyPrivateFolderChoices` at once: an excluded
  clone is synced one last time and removed only when nothing is left unpushed.
- Backups go to `.git/acb-private-backups/` with the folder's path as prefix; dialogs and
  metadata use company-relative paths; messages say 「非公開フォルダのバックアップ」.

## Names the member may not use

Known only per path, from `POST /paths/check` (≤ 50 paths per request, 60 per minute). One
checker per app (`gitSync.pathChecker`, 5-minute cache) serves sync's hold-back, the app's file
operations (`fs:*` backstop; `privateFolders:reservedPathRefusal` for the file tree's new file /
新しいフォルダ… / rename / move) and the chat guard (`decideReservedWrite`). All ask for every
prefix; the first "not usable" one is named: 「『<prefix as typed>』というフォルダ名は使えません。別の名前にしてください。」.
`reservedFolderOf(companyId, rel, { file: true })` also asks the last segment as a file (only
the chat guard does today). Unknown answers (offline, error, older server) never block — the
server's `[RESERVED_PATH]` and sync's recovery are the safety net.

## Guards (keep them; tests in `client/tests/sync/private-folders.test.ts` unless noted)

- The company repo never tracks private content: after every `git add` there, anything under a
  private folder, `.backups/` or `.workspace/` is unstaged (index only) before committing. A
  shared `.gitignore` negation (`!評価/`, `!*`) outranks `info/exclude`, once staged the clone as
  a gitlink and blocked the reader's sync for good. Exclusion pathspecs cannot be used (git
  refuses an `add` naming an ignored path). `assertPrivacy` checks this in every harness world.
- Large-file scan and nested-repository detection skip readable private paths (the scan would
  name a file in the shared `.gitignore`, detection would ask about the clone); a nested repository at a reserved name moves whole to
  `.backups/<ts>_reserved_path/`. A large file inside a private folder is ignored in that scope
  repository's own `.gitignore`.
- `[RESERVED_PATH]` is resolved without a dialog and the files leave their place: before staging
  (`holdBackReservedPaths`: new folder prefixes of new paths, ≤ 50 per sync) or after a rejection
  (`untrackReservedPaths`: squash with the ancestor check, back up from the commit, `rm --cached`
  + delete, an exact move put back, commit, push once) → `.backups/<ts>_reserved_path/` with
  `_metadata.json`; the server's reason lines are shown verbatim. A second rejection →
  `errorType: 'reserved_path'`, no loop, no PENDING_PUSH. Left in place, the file would be
  rejected on every sync; ignored, it would silently never reach anyone.
- Placing, deleting or cloning a private folder first checks that every existing segment of its
  path is a real directory whose real path stays inside the company folder (`safeScopeDir`).
  Before the company pull, sync stops (`errorType: 'conflict'`, nothing changed) when
  `origin/main` has a file or symlink at a readable private folder or an ancestor. A teammate's
  symlink once made the pull delete the clone and the next placement clone outside the company.
- A clone URL must be the company server's (same scheme/host and clone path; never `-…` or
  `ext::`) and is passed after `--`: a forged `/me/scopes` must not send credentials elsewhere.
- At placement a folder at the path that is not a clone of the scope's URL (same URL or same
  server path) moves to the private backups (`<ts>_private_folder_existing`) first; an empty
  folder (OS files only) is reused. Never overwritten.

## Access changes

- **Gained** (new in `/me/scopes`): cloned at the next sync (the create dialog starts one).
- **Lost**: gone from `/me/scopes`, the company repo does not have it, and `paths/check` says
  "not usable" — or `/me/scopes` says "not a member" (404) while `/api/me` confirms the session.
  The clone is deleted **without a backup** (owner decision Q1), private backups included, with
  「このフォルダを見る権限がなくなったため、手元から削除しました（『…』）。同期していなかった変更も削除されています。」.
  Only on a fresh, definite answer; offline, failed checks or transient auth errors delete
  nothing (the folder waits in `pendingPublic`).
- **Made public** (gone from `/me/scopes`, the company repo has it): handed over only once
  company `origin/main` has the folder (fetched first). Unsynced edits go to the private backups
  (`<ts>_made_public`), then the inner `.git` and the scope's files are removed so the company
  pull checks the public version out.
- **Read-only viewer** (`canWrite: false`; pushes get 403): sync never commits there — it
  fetches, offers local edits back with the WRITE_DENIED dialog (member's version to the private
  backups, `<ts>_write_denied`) and resets the clone. Cancel → `errorType: 'write_denied'`.

## Notes

- `shared/package.json` is `"type": "module"` so tsx (harness) sees named exports of the shared
  contract the client imports directly.
- Private paths may appear in the member's local console log only; it is not sent anywhere.
- Deferred: exclusions / partial clone inside a private folder; moving a private folder.
- Nested-repository exclusions live in `.git/info/exclude` since 2026-10-24 (`sync-guards.md`),
  in their own managed block next to this one; neither writer touches the other's block. Inside
  a private folder's clone they go into the clone's own `.git/info/exclude`.
