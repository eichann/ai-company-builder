---
paths:
  - "client/electron/sync/**"
  - "client/electron/protected-config.ts"
  - "client/electron/commit-message.ts"
  - "client/electron/features/sync/**"
  - "client/electron/services/app-git.ts"
  - "client/electron/services/commit-messages.ts"
  - "client/tests/sync/**"
  - "client/tests/sync-harness/**"
  - "client/tests/sync-*.test.ts"
  - "client/tests/protected-config.test.ts"
  - "client/tests/commit-message.test.ts"
  - "client/src/components/common/SyncPreviewDialog.tsx"
  - "client/src/features/sync/**"
  - "client/shared/auto-sync.ts"
  - "client/electron/services/sync-activity.ts"
  - "client/src/shared/lib/autoSyncSettings.ts"
  - "client/src/shared/lib/unsavedEdits.ts"
  - "client/src/features/settings/components/AutoSyncSettings.tsx"
---

# Client sync (`git:sync`)

The member's whole contract is one rule: **"when you've made changes you want to share, press
the sync button."** They have no terminal, no Git vocabulary and no way to repair a repository by
hand. So whatever sync cannot resolve on its own either stops safely with the local work intact,
or asks a question in the member's words. It never leaves a repository half-rebased.

Before changing sync, also read `sync-guards.md` (the guards and their tests) and
`sync-testing.md` (the harness every change runs through). Background, incidents and the full
original text: `docs/architecture/sync.md` (internal; may be absent).

## Code map

- `sync/git-sync.ts` `createGitSync` — the orchestration. It imports nothing from Electron: git
  (`sync/git-factory.ts`, the one place the app's git options live), dialogs (`SyncDialog`,
  rendered by `sync/message-box-dialog.ts`), the server API (`sync/server-api.ts`), clock and
  logger are injected (`sync/types.ts` `SyncDeps`). `features/sync/ipc.ts` wires the real
  implementations into `git:sync`; the app's git comes from `services/app-git.ts`.
- Helpers: `conflicts.ts`, `nested-repos.ts`, `large-files.ts`, `gitignore-merge.ts`,
  `sparse.ts`, `first-setup.ts`, `outside-checkout.ts`, `not-downloaded.ts`, `remote.ts`,
  `push-landed.ts`, `preview.ts`, `../protected-config.ts` (rejection recovery); private folders:
  `private-folders.ts`, `private-sync.ts`, `path-check.ts`, `reserved-path.ts`.
- Renderer: 「サーバーと同期」 / 「変更を確認」 in `src/features/sync/hooks/useSync.ts`; which notice the
  member gets in `model.ts` (anything sync set aside is a warning with its backup that stays until
  dismissed; only a clean sync hides itself — `model.test.ts`); the notice in
  `components/SyncNotification.tsx`.
- Automatic sync: see "Automatic sync" below (`sync/receive.ts`, `sync/auto-sync.ts`,
  `sync/auto-message.ts`; renderer `hooks/useAutoSync.ts`, `autoSyncSchedule.ts`).

## One press, several repositories

1. P1 `GET /me/scopes` (cached in `.git/acb-private-scopes.json`) decides access gained / lost /
   made public for private folders (`private-folders-client.md`).
2. P2 every readable private path goes into the company's `.git/info/exclude`.
3. The company repository runs steps 0–13 below.
4. P3 each readable private folder (its own scope repository, cloned at its path) runs the same
   steps with its own lock and `PENDING_PUSH`. A failure in one repository does not stop the others.

## Steps (per repository)

```
0    serialize per repository (syncLocks)
1    repair a partial clone's lost promisor config (remote.ts); recover stale rebase / merge /
     cherry-pick state; write `.gitignore merge=union` into .git/info/attributes (idempotent)
2    retry a PENDING_PUSH left by a failed sync
3    ensure .gitignore essentials: .backups/, .workspace/, node_modules/, .env*,
     **/.personal/* + !**/.personal/.gitignore
5    nested git repositories → ask the member BEFORE changing anything; "don't share" (default)
     → this computer's .git/info/exclude, never the shared .gitignore (nested-repos.ts)
4    files >100 MB → a literal line in .gitignore (large-files.ts; details below). Runs after 5,
     so a repository kept local is already ignored and never named
6    git fetch --progress origin
6.5  hold back files created in not-downloaded folders → .backups/<ts>_outside_checkout/
6.3  company repo: stop (nothing changed) if origin/main turned a readable private folder or an
     ancestor of it into a file or symlink
6.6  company repo: new files under a name the member may not use → .backups/<ts>_reserved_path/
7    reconcile the sparse checkout with the member's exclusions (download-choices.md)
8    warn about files deleted locally (sync / restore / cancel)
9    keep the app's temporary save files ignored (.git/info/exclude block) → git add --sparse .
     → unstage anything under .backups/, .workspace/ or a private folder, and any temporary
     save file (index only) → commit (AI message, below) → record localHash
9.5  files at paths of a locally excluded nested repo that origin/main now has (a teammate's
     same-path folder) and that differ → copied to .backups/<ts>_nested_repo/ (the pull would
     overwrite them: they are ignored); a failed check stops before the pull
10   git pull --rebase --progress origin main  (stopped mid-rebase → 11)
11   conflict loop until the rebase finishes:
       a back up the local version of newly conflicted files
       b classify unmerged entries by stage 2: present → checkout --ours + add -f;
         absent → rm --force (the server deleted it)
       c rebase --continue
11.5 if commits were replayed: drop duplicate lines union merging left in .gitignore → commit
12   restore department folders deleted locally
13   push --set-upstream --progress (also when only older unpushed commits remain);
     on failure see "Push results" below
```

Large-file scan (step 4): stat only what git lists (`ls-files --cached` + `--others
--exclude-standard`, plus nested repos / gitlinks); never `.git`, `node_modules`,
`.backups`/`.workspace` at any depth, or a private folder. "Already ignored" means
`git check-ignore --no-index`. The line is the path as a literal pattern (glob characters,
leading `#`/`!`, trailing spaces escaped; a root file anchored as `/name`). Tracked files over
the limit still get their line and stay tracked. Threshold: `SyncDeps.largeFileThreshold`.

## Conflict resolution

- The server's version wins for a conflicted file; the member's version is first saved to
  `.backups/`. A file the server deleted follows the deletion (same rule), also backed up.
- `.gitignore` files (any depth) merge with git's `union` driver instead, so both sides' lines
  survive and the file never stops a rebase.
- During a rebase `--ours` is the **upstream / server** side — the inverse of a merge. Keep
  `--ours` here; switching to `--theirs` would keep the member's side and drop the teammate's.
- Use `rebase --continue`, not `--abort`, so auto-merged files are kept. Use `rebase --skip`
  only when the pick is genuinely empty; any other stall aborts and reports the error.
- Stage the server version with `git add -f`, and pass `--sparse` to every index update on a
  path sync did not just check out (conflict `add -f` / `rm`, nested-repo and `.personal`
  untracking, the protected-config restore). Both were found by the harness: without them the
  same pick failed on every sync. After the rebase, gitlinks of excluded nested repos are
  untracked again (one extra commit; a backstop, the server refuses gitlinks anyway).
- Back up with `git cat-file -p <localHash>:<file>` into a Buffer (`binaryCatFile`), never
  `git show` (a string corrupts pptx/png). Fallbacks: `:3:<file>` when the file is gone at
  `localHash`; an *earlier* local version that a pick replaces goes to
  `.backups/<timestamp>_<round>/` with its own `_metadata.json`.
- The success message reports overwritten and deleted files separately; the result carries
  `conflictFiles` and `deletedConflictFiles` — a file that just vanishes reads as data loss.

## Push results (step 13)

- A failed push writes `.git/PENDING_PUSH`; the local commit is never rolled back.
- A push that throws may still have landed (watchdog kill during a long hook, connection lost
  after acceptance). Every push goes through `pushToServer` → `pushLandedDespiteError`
  (`push-landed.ts`): unless the error is a recognised rejection (hook markers, `[rejected]`,
  non-fast-forward, auth), fetch and treat an empty `origin/main..HEAD` as success.
- Rejections, handled in `git-sync.ts` with `protected-config.ts` (markers: `push-check.md`):
  - `[PERSONAL_PATH]` / `[LOCAL_ONLY_PATH]` — no dialog: squash the unpushed commits, untrack
    the listed paths (kept on disk), push once more. Still rejected → `errorType`
    `personal_path` / `local_only_path` with `personalFiles` / `localOnlyFiles`, no PENDING_PUSH.
  - `[RESERVED_PATH]` — no dialog: squash (ancestor check), back up the listed files to
    `.backups/<ts>_reserved_path/`, remove them from commit and disk, put an exact move back,
    push once. Second rejection → `errorType: 'reserved_path'`.
  - `[SECRET_DETECTED]` — squash the unpushed commits (files unchanged), push once more; if the
    files still hold the secret, report them (`secretDetected`, no PENDING_PUSH). The app never
    removes a secret for the member.
  - `[PROTECTED_CONFIG]` and/or `[WRITE_DENIED]` — ask first (one dialog per section, both before
    anything changes): 「このファイルは管理者だけが変更できます」 / 「編集できないファイルがあります」,
    default 「元に戻して残りを同期」. On restore: first push the unpushed commits squashed with
    every file as it is now; only if still rejected, back up the member's version, `reset --soft
    origin/main`, put the listed paths back to the server's version (protected first; an exact
    move into a denied folder is moved back), commit, push once. Cancel / no window →
    `errorType` `protected_config` / `write_denied` with the file list, offered again next sync.
  - `[HOOK_ERROR]` — the server could not run its checks; nothing was accepted; retry later.
- Recovery rewrites the unpushed commits (`reset --soft origin/main`, refused unless
  `origin/main` is an ancestor of `HEAD`) because the server checks every commit in the range: a
  retry or a revert on top would fail forever. Push is attempted whenever commits are unpushed.
- Result fields: `errorType` is one of `network`, `auth`, `conflict`, `locked`, `push_failed`,
  `protected_config`, `write_denied`, `personal_path`, `local_only_path`, `reserved_path`,
  `unknown` (the IPC contract types it as these names or `string`). Private folders add
  `privateFolders` (per folder), `newPrivateFolders`, `lostPrivateFolders`, `madePublicFolders`;
  a failed private folder makes the whole result `success: false` with
  「非公開フォルダ『…』を同期できませんでした。…その他のフォルダは同期しました」.
- On Windows a transient file lock during the rebase is retried twice before it counts as failure.

## Backups

- `.backups/` (gitignored, local only): `<ts>/` conflict copies + `_metadata.json`
  (`conflictFiles`, `deletedConflictFiles`); `<ts>_protected/`, `_write_denied/`,
  `_outside_checkout/` (`folders`, `files`, `serverFiles`), `_reserved_path/` (+ `reasons`),
  `_editor_overwrite/` (disk version an editor tab overwrote), `_nested_repo/` (reason
  `nested_repo_overwrite`, `repos`, `files`: this computer's version of files in a locally
  excluded nested repo that a teammate shared at the same path).
- Private folders' backups live in `.git/acb-private-backups/` (`_private`, `_protected`,
  `_write_denied`, `_editor_overwrite`, `_made_public`, `_private_folder_existing`,
  `_outside_checkout`), never in the working tree, so no `.gitignore` edit can share them.
- `backup:list` shows both places (private ids start with `private:`). Backups older than 30 days
  are pruned at the start of each sync.
- The renderer reaches backups through `src/features/sync/api.ts`: `BackupReads` (list),
  `BackupWrites` (put a file back) and `BackupOutbound` (open the folder in Finder / Explorer:
  main hands it to another app, so it is a port of its own). The sync button uses
  `SyncPreviewReads` (preview, never stages), `SyncRevertWrites` (「元に戻す」 one change),
  `SyncSummaryOutbound` (the member's AI reads the diff) and `SyncOutbound` (`git:sync`).

## Automatic sync (owner decision 2026-10-30)

Two per-member settings (Settings → 同期 → 自動同期, `src/features/settings/components/AutoSyncSettings.tsx`,
stored on this PC in localStorage `acb.autoSync.settings`, `src/shared/lib/autoSyncSettings.ts`),
both only while the app is open:

- **自動で受け取る** — default on, every 15 min (5 / 10 / 15 / 30 / 60). `gitSync.receive`
  (`sync/receive.ts`): fetch, then only `merge --ff-only origin/main`, for the company repository
  and each readable private folder's existing clone (never clones, removes or hands over one).
  It never commits, pushes, stashes, moves or backs up anything. The member's uncommitted work
  stays as it is; the repository is **held back** (unchanged, the next manual sync handles it)
  when a rebase / merge / `index.lock` is present, there are unpushed commits, any path the
  server changed is also changed locally (edited, staged, deleted, new), a path the server adds
  already exists on disk (an ignored file, a private clone, an excluded nested repository — git
  overwrites ignored files silently) or a folder on its way is a file / link, or a changed path in
  a not-downloaded folder exists on disk. Changes that touch none of the member's paths arrive
  even while the member has other local edits. `merge --ff-only` refusing is a second line.
- **自動で送る** — default off; at set times (default 12:00 and 18:00, editable) or every
  30 / 60 / 120 min. The normal sync (`gitSync(…, { auto: true })`, every step above, conflicts
  to `.backups/`) with two differences: the commit message is the template
  「自動同期：N件の変更」 + up to 10 「追加/変更/削除: path」 lines + 「ほか N 件」
  (`sync/auto-message.ts`, never the AI: one model call per scheduled run), and no question is
  answered for the member — the dialog (`askLaterDialog`) cancels every question (deleted files,
  nested repositories, protected config, write denied), keeps `canAsk` true (the no-window path
  would sync deletions unasked), and the result becomes `errorType: 'needs_member'` with
  「自動で送る途中で、確認が必要なことがありました。…「サーバーと同期」ボタンを押して続けてください。」.
- `git:autoSync` (`features/sync/ipc.ts` → `sync/auto-sync.ts` `runAutoSync`) has the last word;
  `autoSyncSkipReason` (`client/shared/auto-sync.ts`) skips silently when the last sync needs the
  member, offline, a sync / receive / private-folder sync holds a lock (`gitSync.isRunning`), a
  download-choice change or private-folder creation runs (`services/sync-activity.ts`), the
  editor has unsaved edits (`src/shared/lib/unsavedEdits.ts`, published by the editor's `features/editor/hooks/useOpenFiles.ts`), or a chat
  turn is running (`chat-turns.ts` `runningCount`). Malformed renderer state counts as "wait".
- Timer: renderer `src/features/sync/hooks/useAutoSync.ts` (first look 60 s after the company
  opens, then every 30 s); when a run is due is pure `autoSyncSchedule.ts`: measured from the
  mode's last run, so runs missed while the app was closed come due **once** (no burst); 「送る」
  never catches up on slots before it was turned on (`enabledAt`); a skipped run retries after
  2 min; a send (and a manual sync) also counts as a receive / restarts 「送る」's clock.
- Per company on this PC (`acb.autoSync.state:<companyId>`, `autoSyncState.ts`): last runs,
  `needsMember` (set by any sync — manual or automatic — that stopped at a question an automatic
  send will not answer, a rejected file, a secret or a conflict stop; cleared by the next
  successful sync; automatic runs wait meanwhile). The member's own キャンセル in a manual sync
  is "not now" (owner, 2026-10-30): it sets no stop and lifts one, so automatic sync resumes at
  its next scheduled run (a send still facing the question stops there again, its notice not
  repeated) and the failure kinds already shown. A failed automatic send shows the
  manual sync's notice once per kind until a sync succeeds; a successful one is silent unless sync
  set something aside (the same warning a manual sync shows). The sync button's tooltip shows
  「最後の自動同期: M/D HH:MM」 or that automatic sync waits for the button.
- Scenarios: `client/tests/sync/auto-sync.test.ts`; schedule: `src/features/sync/autoSyncSchedule.test.ts`;
  settings page: `tests/ui/download-folders.spec.ts` 「自動同期」.

## Commit message (step 9)

Written by the AI the member signs in with (`commit-message.ts`, generator built in
`services/commit-messages.ts`, every agent through the registry's `runOneShotText`): the
member's own agent first, then the `commitMessageFallback` agents in registry order (Claude
Code, then the API key; Codex is never picked on the member's behalf). Models per agent are the
registry's `tasks.commitMessage` (Claude Code: a one-shot `claude -p --model haiku` via
`claude-oneshot.ts`; API key: `claude-haiku-5-5`). Input is only `git diff --cached
--name-status` + `--stat` (`core.quotePath=false`, capped) as JSON data; only the answer's
`<commit_message>` block is used, sanitised (72-char subject, ≤ 20 body lines, ≤ 2,000 chars).
No AI, a failure, no tagged block or 30 s → 「Sync from AI Company Builder」. The message is never
logged. A private folder's clone (`kind: 'scope'`) uses only `privateFolderCommitMessages` agents (the
API key), so its file names never go to a CLI sign-in or another vendor. Log lines name the agent
id (`[commit-message] claude-code failed …`).
