---
paths:
  - "client/electron/sync/**"
  - "client/tests/sync/**"
  - "client/tests/sync-harness/**"
  - ".github/scripts/sync-shard.mjs"
  - ".github/scripts/changed-areas.sh"
---

# Testing sync: the multi-member harness

Every sync change runs through the harness (`client/tests/sync-harness/`, tests in
`client/tests/sync/`), because sync bugs show up only when several members interleave. New sync
behaviour (another repository kind, a new rejection type, adoption) gets a scenario that ends
with `settleAndCheck(world)`. Full reference: `docs/architecture/sync-testing.md` (internal).

## Running it

```bash
cd client
npx tsx --test tests/sync/scenarios.test.ts            # one file (run the ones you touched)
SYNC_HARNESS_PART=1/2 npx tsx --test tests/sync/private-folders.test.ts   # every 2nd scenario
SYNC_SOAK_SEEDS=1 SYNC_SOAK_MEMBERS=3 SYNC_SOAK_ROUNDS=6 npx tsx --test tests/sync/soak.test.ts
node ../.github/scripts/sync-shard.mjs 2 --list         # files of CI shard 2 (without --list: runs them)
```

`SYNC_HARNESS_VERBOSE=1` prints every sync log line; `SYNC_HARNESS_KEEP=1` keeps the temporary
worlds (delete them afterwards). Locally run the files you touched; the whole harness is long and
the machine is shared — CI runs all of it.

## CI

- 4 macOS shards ("Sync harness N/4 (macOS)"), files balanced by duration in
  `.github/scripts/sync-shard.mjs`; the last shard also runs every unlisted file, so a new test
  file needs no CI change (list it in a group if it is long). `private-folders.test.ts` is split
  over two shards with `SYNC_HARNESS_PART=k/n` (`<file>#k/n` in the groups), and the soak worlds
  are split with `soak.test.ts@<worlds>` (the other worlds' seeds set to `none`): shard 2 runs
  `soak.test.ts@plain`, shard 4 `soak.test.ts@mixed,private`. The script fails if a soak world is
  in zero or two shards, or a listed file no longer exists. The required check "Sync harness (macOS)" is green
  only when every shard passed (or all were skipped).
- Soak on PRs: one seed per world (`SYNC_SOAK_SEEDS=1`, `SYNC_SOAK_MIXED_SEEDS=101`,
  `SYNC_SOAK_PRIVATE_SEEDS=201`, 3 members × 6 rounds). Nightly (18:17 UTC) and manual runs
  (a push to main skips the macOS jobs since 2026-10-31; its PR ran them): seeds `1,2,3` / `101,102` / `201,202`, 3 members × 8 rounds. A failing seed prints
  its seed and operation log and reproduces locally with the same variables.
- PRs run the harness only when sync's inputs change (`.github/scripts/changed-areas.sh`, list
  `SYNC`): `client/electron/sync/`, `protected-config.ts`, `write-guard.ts`, `client/shared/`,
  the harness and tests, `server/src/lib/{push-check,git-server}/`, `git-exec.ts`,
  `server/src/templates/`, `shared/` (permission rules live in `shared/core` since R2; the list
  still names the removed `server/src/lib/permissions.ts`, harmless), package manifests, the
  lockfile and the workflow. When sync code starts importing a file outside those lists, add it.

## The world

- A `World` is one company: a bare repo configured like `configureBareRepo` (`BARE_REPO_CONFIG`:
  deny non-fast-forwards / deletes, partial clone) with the real hook rendered by
  `server/src/lib/git-server/hook.ts` (the real push checker), plus N member clones. Pushes use
  the local file transport, so the hook runs as a child of the member's git, with the
  `ACB_PUSHER_ROLE` / `_ID` / `_EMAIL`, `ACB_NODE` and `ACB_PUSH_POLICY` that `git-http.ts` sets
  from the session (default policy `everyone: read + write`; `world.setScopes(...)`). The HTTP
  layer itself is not covered.
- Each member runs the real `createGitSync`, the real git factory, the real message-box dialog
  adapter (answers via `willAnswer`, else the default button) and the real server-API adapter
  over a fake `fetch`. Members `write` / `append` / `remove` / `rename` / `initNestedRepo`, go
  `offline()`, let a teammate push first (`beforeNextPush`), or fail a push before or after the
  server accepted it (`failNextPush`).
- Partial members: `await world.addPartialMember(name, { departments })` (real first setup over
  `file://`); `addDepartment` / `removeDepartment` and `excludeFolder` / `includeFolder` are the
  settings panel; `reopen(url?)` is opening the company again; `missingObjects()` lists what was
  never downloaded. The harness's own reads set `GIT_NO_LAZY_FETCH` (`NO_LAZY_FETCH`); sync's
  git never does.
- Private folders: `world.createPrivateFolder(path, { viewers, editors?, files? })` creates a
  scope repository with the real hook; `/me/scopes` comes from `world.myScopes`,
  `POST /paths/check` from `world.pathsUsable` (both 404 until the first private folder, like an
  older server; `member.pathCheckDown`, `pathChecks`, `member.scopesApiDown`). `grantPrivate` /
  `revokePrivate` / `makePublic` are the owner's actions (retired scope repos are kept).

## Invariants (`invariants.ts`, checked by `settleAndCheck`)

- Every sync terminates and leaves no rebase / merge / cherry-pick in progress.
- No committed work is lost: it is on the server, in `.backups/` with metadata, or kept locally
  at an ignored path.
- After everyone syncs twice, all members are at the server's commit with a clean tree; rejected
  pushes are recoverable by the next sync.
- `assertPrivacy`: nothing at a private path and no private content (`privateMarker`) in the
  company repository; no company commit message or `.gitignore` names a private folder; nothing
  private on a non-reader's disk or in their `.git`; every reader has a clean clone at the scope
  server's commit (unless left out).

## Files

- `scenarios.test.ts` — maps to the guards (`sync-guards.md`); `findings.test.ts` — regressions
  for bugs the harness found; `harness-selftest.test.ts` — proves each invariant fails when sync
  misbehaves.
- `soak.test.ts` — seeded random soak (`SYNC_SOAK_SEEDS` / `_MEMBERS` / `_ROUNDS`), a mixed world
  with partial members (`SYNC_SOAK_MIXED_SEEDS`, `SYNC_SOAK_PARTIAL`) that also leaves sub-folders
  out and writes into them, and a private-folder world (`SYNC_SOAK_PRIVATE_SEEDS`).
- `partial-clone.test.ts` (every guard for a partial member; it never downloads unpicked
  departments), `outside-checkout.test.ts`, `folder-exclusions.test.ts` (sub-folders, nested
  choices, cone-mode migration, stale and case-variant exclusions), `large-files.test.ts`,
  `user-hooks.test.ts`, `write-denied.test.ts`, `private-folders.test.ts`, `auto-sync.test.ts`
  (automatic receive / send through `member.autoSync(mode, conditions)`, the same decision as
  `git:autoSync`).
- `characterization.test.ts` holds sync to a transcript recorded from the pre-extraction handler
  (`characterization.golden.json`). Re-record with `UPDATE_SYNC_GOLDEN=1` only for an intended
  behaviour change, and review the JSON diff in the PR.
