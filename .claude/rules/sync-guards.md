---
paths:
  - "client/electron/sync/**"
  - "client/electron/protected-config.ts"
  - "client/electron/services/app-git.ts"
  - "client/electron/features/sync/**"
  - "client/electron/features/company-setup/**"
  - "client/electron/features/download-choices/**"
  - "client/scripts/universal-git.mjs"
  - "client/tests/sync/**"
  - "client/tests/sync-harness/**"
  - "client/tests/sync-*.test.ts"
  - "client/tests/client-identity.test.ts"
---

# Sync guards (client git)

Each guard below was added after a member lost work, or could not sync for weeks, in a specific
observed way. Keep them; each names the test that fails without it. If one seems to block a
change, describe the conflict to the owner instead of removing it. Server-side push guards are
in `push-check.md`, private-folder guards in `private-folders-client.md`, renderer-path guards in
`ipc-and-main-process.md`. Incident details: `docs/architecture/sync.md` (internal).

## Git configuration (`sync/git-factory.ts`, used by every app git via `services/app-git.ts`)

Test for the first group: `client/tests/client-identity.test.ts` ("createGit passes …") checks
what git actually sees through the app's `createGit`.

- `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true` on every invocation — `rebase --continue`
  otherwise opens `vi` with no TTY in a GUI app and blocks forever (one member's sync froze for
  ~2 months). Git runs editors through its own `sh`, so `true` also works on Windows. Test:
  "sync never opens an editor when continuing a rebase…" in `client-identity.test.ts` (every
  editor variable and `core.editor` point at an editor that records itself and fails, so the
  test does not depend on the environment it runs in).
- Watchdog `timeout: { block: 5 * 60 * 1000 }` — kills a git process that prints nothing for
  5 minutes. Long transfers survive because fetch / pull / push all pass `--progress`; keep that
  flag on any new network command.
- `http.postBuffer=524288000` — old system git (Apple Git 2.39 via the fallback) has a broken
  chunked HTTP push; buffering keeps git off chunked transfer whichever binary resolved.
- `merge.stat=false` — a fast-forward diffstat reads every changed blob, which in a partial
  clone silently downloads teammates' departments the member did not pick.
- `credential.helper` cleared; the bundled Git Credential Manager is never run.
- The member's own hooks and templates never run: `core.hooksPath` and `GIT_TEMPLATE_DIR` point
  at app-owned empty directories (`<userData>/git/{hooks,templates}`, `appGitDirs`), for bundled
  and system git alike. A global git-secrets template once made a partial-clone commit hang
  10+ minutes. They are real directories (`/dev/null` is not a path on Windows), so hooks the app
  needs later can be installed there deliberately. Test: `client/tests/sync/user-hooks.test.ts`.
- Every app git goes through this factory (`createGit` in `services/app-git.ts`); the only
  other spawn is the `--version` probe. Add new git calls through it.
- The mac app's bundled git is universal (arm64 + x86_64): electron-builder's `beforePack`
  (`client/scripts/universal-git.mjs`) merges both pinned dugite-native archives with `lipo`
  (sha256 verified; non-Mach-O files must be byte-identical; GCM left out), because dugite only
  downloads the build machine's arch and Intel Macs fell back to Apple Git 2.39. CI job
  "Universal bundled git (macOS)". The system-git fallback stays as a logged last resort.

## Repository state and concurrency

- `syncLocks` registers a run **before** awaiting the previous one, so two queued clicks cannot
  wake together. Scenario: "concurrent sync clicks are serialized…".
- Rebase detection uses the `rebase-merge` / `rebase-apply` directories, not `REBASE_HEAD`
  (a ref that lingers after a finished rebase). Scenario: "stale rebase and stale merge…".
- Conflict resolution is a loop: a rebase pauses on every conflicting pick; the old single
  round fell back to `rebase --skip` and dropped commits. Scenario: "several conflicting picks
  in one rebase are all resolved, no commit is dropped".
- `rebase --skip` only for a genuinely empty pick; otherwise abort and report. Scenario: "a pick
  left empty by taking the server version is skipped, later picks survive".
- Conflicts are classified by stage-2 presence before anything is resolved (`classifyConflicts`,
  `sync/conflicts.ts`): `checkout --ours` fails atomically on a modify/delete (`DU`) entry, which
  once left a pilot member permanently unable to sync. Scenario: "modify/delete conflict (DU)…".
- Binary-safe backups via `cat-file` into a Buffer, with the `:3:` and earlier-version fallbacks
  (`sync.md`). Scenarios: "binary conflict…", "a conflicted edit is backed up even when a later
  unpushed commit renamed the file", "an earlier conflicted version is backed up…".

- Automatic sync never acts for the member (`sync.md` "Automatic sync"). 「受け取る」 is a
  fast-forward only and is held back — nothing changed — when any path the server changed is
  changed locally, a path the server adds exists on disk (git overwrites ignored files, e.g. a
  private clone or a file the member keeps ignored, silently), there are unpushed commits or a
  git operation is in progress. 「送る」 cancels every question (`askLaterDialog`, `canAsk` true so
  deletions are never synced unasked) and stops with `needs_member`. Every automatic run waits
  while the editor has unsaved edits, an AI turn runs, a sync / download-choice change /
  private-folder creation runs, or the last sync needs the member. Scenarios in
  `client/tests/sync/auto-sync.test.ts`: "…never overwrites a file the member keeps ignored…",
  "a run that must wait changes nothing…", "自動で送る never answers a question…" (each fails
  with its guard removed); "…holds back when the member edited a file…" and "…commits the server
  does not have yet" are also covered by `merge --ff-only`'s own refusal (two lines on purpose).

## Shared files

- Nested repositories: ask **before** any mutation; cancelling changes nothing (the
  pre-consent version untracked a whole folder: a "653 files deleted" warning). Owner decision
  2026-10-24: the default, for a new repository and for a shared folder with a stray `.git`, is
  "don't share" — **this computer only**, a managed block of `.git/info/exclude` (NFC + NFD,
  `sync/nested-repos.ts` on `sync/local-excludes.ts`, which the private-folder block shares
  without either clobbering the other), never the shared `.gitignore`. A line there applied
  one member's choice to every teammate (a teammate's folder at that path stopped syncing),
  showed the name to everyone, and the old default for a shared folder (remove the `.git`,
  share everything) could upload someone's clone, secrets included. Removing the `.git` and
  sharing stays as a non-default button; the old "exclude for everyone" option is gone; the
  no-window path also excludes locally. Only gitlinks are untracked: teammates' files at the
  same path stay shared, and before the pull this computer's differing (ignored) files there
  are copied to `.backups/<ts>_nested_repo/` — git would overwrite them silently. A local
  exclusion is dropped when its folder is gone (not when only its `.git` is). Dialogs end
  with 「会社として管理したい場合は、管理者に『外部リポジトリ』として登録してもらってください。」.
- Legacy: `/<path>/` lines older apps wrote into the shared `.gitignore` (under "# Auto-ignored:
  nested Git repositories") are **never removed automatically** — that would start sharing
  those folders for everyone — and still count as "already excluded". An owner can delete such
  a line by hand once nobody needs it (each member's next sync then asks again and keeps the
  repository local). Scenarios: "nested repo inside a shared folder → …", "new nested repo …",
  "a folder one member keeps local still syncs for a teammate…", "a nested-repo line an older
  app wrote…", "no window…", "deleting the nested repository…"; partial-clone "…stays excluded
  across settings changes and reopening"; findings "concurrent nested-repo exclusions converge…".
- Ignore lines the app writes for one member — large files (step 4) and a skill kept private
  while it is written (`skills:makePrivate`) — go to managed blocks of that member's
  `.git/info/exclude` (`sync/local-ignores.ts`), never the shared `.gitignore`: a line there
  stopped a teammate's file at the same path from syncing, and kept the shared `.gitignore`
  something every member's app writes. Lines older apps wrote there (`# Auto-ignored: Large
  files (>100MB)` sections, `<folder>/.claude/skills/<name>/`) move at the member's own sync,
  before anything is staged, only when they are this member's: the file is here and over the
  limit / the skill folder is here and neither tracked nor on `origin/main`. Local line first,
  then the shared one goes, so nothing stops being ignored. A teammate with a file at the same
  path still has the line when their sync starts (the move runs before their pull) and keeps
  their own copy. Two removals of neighbouring lines meet in the union merge, which can bring a
  line back; its member moves it again right after the pull (after step 11.5), so the file converges.
  A large file kept here whose path a teammate now shares is copied to
  `.backups/<ts>_large_file/` before the pull (as for nested repositories). Not moved: lines
  for files this computer does not have (someone else's, or nobody's any more — an owner may
  delete them). Known gap: an OLDER app does not move anything, so if it keeps a private skill
  at exactly the path of a teammate's moved one, that skill starts syncing once the line is
  gone (both made one with the same name in the same department). Scenarios:
  `large-files.test.ts` 「a large-file line an older app wrote…」, 「a teammate who has a large
  file at the same path…」, 「…the pull does not lose this computer's version」;
  `private-skills.test.ts`. Unit: `ipc-app.test.ts` 「skills: the scan…」.
  **Making the shared root `.gitignore` owner/admin-only in the push checker** is the next
  step and is not done yet. Condition: no app version that still writes it is in use — every
  active member's build includes this change (check `client_activity` builds), since older
  apps append large-file and private-skill lines and would hit `[PROTECTED_CONFIG]` on every
  sync (a private skill would be shared after the restore). Sync's essentials (step 3), the
  `.env` lines (`electron/features/env/ipc.ts`) and the union tidy (11.5) still write the shared
  file from every app and must be allowed for members (or moved) at that point too.
- The app's temporary save files (`.<name>.acb-tmp-<random>`: the document review writes one
  next to a sidecar and renames it over, `client/shared/temp-save-file.ts`) are never shared. A
  sync in that moment would commit a half-written file, and the next one its removal. Every
  sync (company repository and each private clone) keeps the pattern `.*.acb-tmp-*` in its own
  managed block of `.git/info/exclude` (`writeExcludeLines`, `sync/local-excludes.ts`), never
  the shared `.gitignore`; one that still reached the index (a shared `!.*` outranks
  `info/exclude`) is unstaged after the `git add`, like `.backups/`. The file stays on disk
  untouched. Tests: `client/tests/sync/temp-save-files.test.ts`, `client/tests/temp-save-file.test.ts`.
- Who may change the shared root `.gitignore` — **still an open hole on the server**. The
  settings page's editor (「同期しないファイル」) is offered to owners / admins only
  (`download-choices.md`), and this version of the app no longer writes large-file or
  private-skill lines there (they are on each member's computer: "Ignore lines the app writes
  for one member" above). But the push
  checker does **not** restrict the file yet, so any member (a hand edit, the AI, an older app)
  can still push a line such as `*.xlsx` that stops new files syncing for everyone. What still
  has to happen before the server can make it owner/admin-only is at the end of that bullet
  ("Making the shared root `.gitignore` owner/admin-only…"): older apps out of use, and sync's own
  remaining writes (essentials, `.env` lines, the union tidy) allowed for members or moved. A
  `[PROTECTED_CONFIG]` rejection of an older app's automatic line would restore the server's
  version — a private skill would be shared on the next sync, a large-file line re-added and
  refused every sync.
- `.gitignore` merges with the `union` driver, declared in the repository-local
  `.git/info/attributes` (never committed, outranks `.gitattributes`, any depth;
  `sync/gitignore-merge.ts`). After replayed commits, duplicate lines the merge added are removed
  in one commit (only copies beyond either side, never across an opposite `!` line). Without it
  "server wins" dropped sync's own exclusion lines and concurrent syncs did not converge.
  Trade-off accepted: a line one side deleted next to the other side's change can come back.
  Scenarios: "concurrent .gitignore changes keep both sides", "a line both members added is not
  duplicated…", "concurrent .gitignore exclusions converge…"; unit `client/tests/gitignore-merge.test.ts`.
- Push failures are never rolled back; `PENDING_PUSH` is retried first; a push that landed
  despite an error counts as pushed (`push-landed.ts`). Scenarios: "push failure while offline…",
  "push accepted by the server but the push call fails…", "push that never reached the server…".
- Rejection recovery rewrites unpushed commits, never retries or reverts on top (the hook checks
  every commit). `client/tests/protected-config.test.ts`, `client/tests/sync/write-denied.test.ts`,
  scenarios "PROTECTED_CONFIG …" (incl. Codex's `.codex/`, same dialog), "PERSONAL_PATH …", "secret …", `private-folders.test.ts`
  "[LOCAL_ONLY_PATH] …". Skill files (scripts, new files, deletions, renames) take the same
  recovery with their own wording when nothing else was refused (`onlySkillFiles`): `client/tests/sync/skill-files.test.ts`.
  The recovery compares mode as well as blob id (`sameEntry`): a `chmod +x` alone is refused by the
  server, and a path taken for unchanged was refused at every sync, holding the member's other work
  back (also for `[WRITE_DENIED]`).
- A pull that fails without a rebase, while origin/main holds commits HEAD lacks, ends the sync with
  `pull_failed` (「サーバーの最新の内容を受け取れなかった…」), nothing moved. It used to go on and report
  「同期が完了しました」, with the member missing the server's changes for good (a look-alike path on a
  Mac did this). No origin/main (a company's first push) still goes on. Scenario: 「a pull that fails…」
  in `skill-files.test.ts`.
- What running a skill leaves in its own folder (`__pycache__/`, `*.pyc`, `node_modules/`, virtual
  environments, `.next/` and the like, `dist/` / `build/` under `tools/`, `package-lock.json`, the
  desktop's files; `client/shared/skill-leftovers.ts`) stays on each
  computer: a managed block of `.git/info/exclude`, unstaged if a shared negation re-included it.
  To the server it is a skill change, which would stop automatic sync at every run. New files only:
  taking a tracked one out of the index would delete it for everyone. A shared lock file that a
  member's `npm install` changes still meets the refusal and its recovery. Scenarios in
  `skill-files.test.ts`.

## Remote, sparse checkout and not-downloaded folders

- `origin` is never removed and re-added. Its URL changes only through `git remote set-url`
  (`setRemoteUrl` / `configureOrigin`, `sync/remote.ts`; used by company setup and sync's
  SSH→HTTPS migration). `remote remove` deletes the partial clone's promisor config, after which
  lazy fetches failed (`unable to read sha1 file …`). Self-heal before sync, before every sparse
  change and on every setup/reopen: a repo with `pack-*.promisor` files and an origin but no
  `remote.origin.promisor` / `partialclonefilter` gets `promisor=true` +
  `partialclonefilter=blob:none` back (one warning); a full clone is untouched. Tests:
  `client/tests/sync-remote.test.ts`; partial-clone scenarios "reopening the company…", "…heals itself".
- Sparse changes are one `sparse-checkout set --no-cone /* !/<folder>/…` (never `init` + `set`);
  a failed change writes the previous exclusions back (`applySparseSelection`). `init` alone
  narrowed the worktree and a failed offline `set` then left folders missing.
- Before every `set`, ignored files inside folders it leaves excluded move to
  `.git/acb-sparse-keep/` and come back afterwards, also on failure (`keepIgnoredInExcluded`,
  `sync/sparse.ts`); a crash leftover is restored first and never overwrites an occupied path.
  Cone-mode `set` deletes such files (`.personal/` notes, `.env`). If `ls-files --directory`
  fails ("directory entry not superset of prefix") retry without `--directory`, else run `set`
  without the move. Tests: `outside-checkout.test.ts`, `folder-exclusions.test.ts`.
- Files created inside a not-checked-out folder are never staged (`holdBackOutsideCheckout`,
  `sync/outside-checkout.ts`): before the reconcile and before `git add`, every non-ignored file
  there that is new or differs from the index moves to `.backups/<ts>_outside_checkout/`,
  skip-worktree is set again, emptied folders are removed; the member sees
  「ダウンロードしていないフォルダ（…）にファイルが作られていたため、共有せずに .backups に保存しました（N件）。…」.
  If the check fails, sync stops before staging. Reason: the member cannot see teammates' files
  there, and a write silently replaced a teammate's file on the server. It runs before the
  reconcile because `set` with a changed file there downloads the teammate's version. Tests:
  `client/tests/sync/outside-checkout.test.ts` (full and partial clones).
- The sync preview never stages (`sync/preview.ts`): `git --no-optional-locks status
  --porcelain=v1 -z -uall --no-renames`; the AI summary stages into a throwaway index
  (`withScratchIndex`, `GIT_INDEX_FILE`). Because older apps' preview did stage, the hold-back
  first resets index entries in not-downloaded folders to HEAD (`unstageToHead`), and the
  reserved-path hold-back counts staged additions as new. Tests: `client/tests/sync-preview.test.ts`,
  "…staged by an older app's preview…" in `outside-checkout.test.ts` / `private-folders.test.ts`.
