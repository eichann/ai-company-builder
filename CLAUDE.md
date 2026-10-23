# CLAUDE.md - AI Company Builder

This file provides project-specific guidance for Claude Code.

---

## Project Structure

```
ai-company-builder/
├── server/     # Hono API (port 3001)
├── admin/      # Next.js admin panel (port 3100)
├── client/     # Electron desktop app (port 5173)
├── shared/     # Shared type definitions
└── data/       # SQLite databases (gitignored)
```

---

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+

### Quick Start

```bash
# Install dependencies
pnpm install

# Start the server (development)
cd server && pnpm dev

# Start the client (development)
cd client && pnpm dev

# Start the admin panel (development)
cd admin && pnpm dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `AUTH_SECRET` — Secret key for session signing (generate with `openssl rand -base64 32`)
- `PUBLIC_URL` — Public URL of the server (e.g., `https://your-domain.com`)

---

## Deployment

See `docs/self-hosting/` for full self-hosting guides (English and Japanese).

### Docker Compose

```bash
docker compose up -d
```

### Docker Volume Mounts

The docker-compose.yml mounts the following:
- `./server/src:/app/src`
- `./shared:/app/shared`
- `./data:/app/data`

When adding new directories, update docker-compose.yml accordingly.

The admin image is a production build (`next build`, standalone server) with
no source mount: rebuild it after admin changes (`docker compose up -d --build
admin`), or use `pnpm dev:admin` on the host for hot reload. `/api/*` is
forwarded by `admin/src/proxy.ts`, which reads `API_PROXY_URL` at runtime.

---

## Technical Notes

### Import Paths

Server references shared types via:
```typescript
import { ... } from '../../shared/types'  // Path inside container
```

### Database

- SQLite (`data/app.sqlite` for app, `data/auth.sqlite` for auth)
- Migrations use `CREATE TABLE IF NOT EXISTS` (auto-applied)

### Accounts and roles (server)

- **Only owners grant owner/admin**: `PUT /companies/:id/members/:userId/role`,
  `POST /companies/:id/members` with role owner/admin, and admin invitations
  are owner-only (an admin adding a second account of their own as owner
  could take the company over). `POST …/members` also requires the account
  to exist (404 otherwise).
- **Rules follow the membership**: removing a member deletes every rule
  naming them in that company (`deleteUserRules`, private folders
  included), so re-adding them starts from nothing; a promotion to
  owner/admin deletes them too (moot while they have full access, stale
  after a demotion). `everyone` rules are untouched, so nothing starts
  inheriting.
- **Invitations are single-use** (`lib/invitation-signup.ts`): a sign-up
  with `X-Invitation-Token` claims the invitation atomically
  (`signup_claimed_at`, released if the sign-up fails) and records the new
  account (`signup_user_id`); a second sign-up with the link is refused;
  accepting is a compare-and-set on `used_by` and, for a claimed link, only
  by that account. `expiresInDays`: integer 1–30 (default 7).
- **`/api/git`** has only `GET /repos/:companyId` (members of that company;
  others 404) → `{ companyId, httpsUrl }` — no server path, no legacy
  `sshUrl`. Repository administration is not an API: companies create their
  repository, startup configures every repository and hook.

### Claude Code agent stack (client)

- `@anthropic-ai/claude-agent-sdk` 0.3.304 (its `claudeCodeVersion` is CLI
  2.1.304) under `ai-sdk-provider-claude-code` 3.6.1 — the AI SDK v6 line
  (npm tag `ai-sdk-v6`); provider 4.x needs AI SDK 7 (`@ai-sdk/provider` ^4).
  The provider pins its own SDK exactly, so root `package.json`
  `pnpm.overrides` keeps one SDK copy at the app's version: bump both together.
  The provider accepts `auto` natively (the old 3.4.2 patch is gone).
- The SDK peers on `@modelcontextprotocol/sdk` ^1.29 (in-process MCP servers)
  and `@anthropic-ai/sdk` (types only, auto-installed).
- The app never runs the SDK's bundled CLI: every `query` / `claudeCode(...)`
  passes `pathToClaudeCodeExecutable` (the member's own `claude`), and
  `vite build` bundles the SDK into `dist-electron`. The SDK's per-platform
  native binaries (`@anthropic-ai/claude-agent-sdk-<platform>`, ~250 MB) are
  excluded from the packaged app in `client/package.json` `build.files`.
- The SDK prints `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` process warnings for
  the app's `allowedTools` MCP tools and for bypassPermissions. They are
  informational: AskUserQuestion still reaches `canUseTool` in bypass.
- The provider drops `rate_limit_event` and `system/task_progress`, so
  `claude.ts` wraps the SDK Query's iterator in `onQueryCreated`
  (`tapSdkMessages`) to see them. Agents report them through the
  `onEvent` callback; the chat server sends them to the renderer as
  *transient* data parts (`data-rate-limits`, `data-agent-progress`, read in
  `useChat` `onData`, never stored in history) and keeps the latest usage per
  agent for `GET /api/rate-limits`.
- Header usage meter (`shared/rate-limits.ts`, `RateLimitMeter.tsx`): Claude's
  real payload carries both windows in the undocumented
  `rate_limit_info.unifiedWindows` with `utilization` as a fraction (0.24 =
  24%); Codex comes from `account/rateLimits/read` once per turn plus sparse
  `account/rateLimits/updated` (`usedPercent` 0–100, windows by
  `windowDurationMins`). No event (API-key login, older CLI) → "unknown".
  No cost display (owner's decision).
- `agentProgressSummaries: true`: the running subagent row shows the latest
  `task_progress.summary` (`tool_use_id` = the Agent call). Codex has no
  subagent rows, so nothing is shown there.
- Defaults for members who never chose: Opus 5.5 + effort medium
  (`src/lib/aiModels.ts`); only an explicit choice is saved.

### Search, Cmd+P and folder history (client)

`client/electron/git-search.ts` (main.ts `git:grep` / `git:listFiles` /
`git:log`; tests `client/tests/git-search.test.ts`):

- Content search is a fixed string, A–Z case-insensitive (`LC_ALL=C -F -i`),
  ≤20 matches per file, **≤500 in all** — git's output is streamed and the
  process killed there (`truncated` → 「結果が多いため最初の500件を表示しています」),
  15 s timeout, lines cut to ~300 chars around the match. Uncapped, 「の」 in
  one department was 168,856 lines / 53 MB through IPC and froze the window.
- What is searched: the worktree (tracked + untracked, never ignored), never
  `.backups/` / `.workspace/` or a not-downloaded folder (exclude pathspecs),
  readable private folders in their own clone (paths company-relative). Every
  read runs with `GIT_NO_LAZY_FETCH=1` + `GIT_OPTIONAL_LOCKS=0`: a search must
  never download a blob. `''` = the whole company (pathspec `.`, never `/`).
- Folder history uses `git log -- :(literal)<folder>/` — no `--follow`
  (simple-git's `file` option added it: 0.9 s instead of 0.02 s, same commits).
  `invalidateCommitCache()` also makes the visible history panel re-fetch.
- The review diff (`src/lib/line-diff.ts`) is Myers O((N+M)·D) in linear
  space with a work budget; past it the view says the diff is too large
  instead of building the old O(m·n) table (25M cells for 5,000 lines).

### File Naming Rules

- Department folder names allow Japanese characters (hiragana, katakana, kanji) and ASCII
- Skill folder/file names remain ASCII only: `/^[a-z0-9][a-z0-9_-]*$/`
- Department folder pattern: `/^[\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF][\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF._-]*$/`

---

## API Endpoints

```
GET    /api/companies/:companyId/departments       # List departments
POST   /api/companies/:companyId/departments       # Create department
PUT    /api/companies/:companyId/departments/:id   # Update department
DELETE /api/companies/:companyId/departments/:id   # Delete department
POST   /api/companies/:companyId/departments/reorder    # Reorder
GET    /api/companies/:companyId/folder-sizes?path=&measure=  # Folder sizes (download settings)
```

---

## Architecture: Department Management

### Principles

```
File system = Source of Truth
DB = Display settings (order, icon, color, display name)
Admin UI = Can also perform file operations
```

### Data Flow

1. **List departments** (and folder stats, `POST /sync`): `git ls-tree` the
   shared branch (`main`, else `master`) of the company's bare repo — the
   non-hidden root directories — then return the DB rows (by `sort_order`)
   whose folder is among them. Read-only requests never pull or clone the
   server's working clone: a synchronous `git pull` there on every list call
   froze the whole process (all API and git-http traffic) for 42 s on a
   7.7 GB clone.
2. **Create department**: mkdir → git add → commit → push → save to DB
3. **Edit department**: git mv (if renamed) → commit → push → update DB
4. **Delete department**: Confirm → rm -rf + git add -A → commit → push → delete from DB

Mutations work in the working clone (`data/workdirs/<companyId>`, pulled
first) under a per-company promise-chain lock (`withCompanyLock`), and all
git there is async (`execFile`) — no `execFileSync` in request handlers.

---

## Architecture: Client Sync (git:sync)

### Value Proposition

Uses Git behind the scenes so non-engineers can **share files, folders, and AI skills across the entire team instantly**.

Users only need to remember **one rule**:

> **"When you've made changes you want to share, press the sync button."**

That single rule is the whole contract, and it is why this handler carries so
much defensive code: the user has no terminal, no Git vocabulary, and no way to
recover a repository by hand. Anything the handler cannot resolve on its own
must either stop safely with the local work intact, or ask the user a question
phrased in their words — never leave the repository half-rebased.

### Sync Flow

Implemented in `client/electron/sync/git-sync.ts` (`createGitSync`), which
imports nothing from Electron: git (`sync/git-factory.ts` — the one place the
app's git options live), the dialogs (`SyncDialog`, rendered as message boxes
by `sync/message-box-dialog.ts`), the server API (`sync/server-api.ts`), the
clock and the logger are injected (`sync/types.ts`). `client/electron/main.ts`
only wires the real implementations into `ipcMain.handle('git:sync', ...)`.
Helpers: `sync/conflicts.ts`, `sync/nested-repos.ts`, `sync/sparse.ts`,
`sync/first-setup.ts` (first setup, below), `sync/outside-checkout.ts`, `sync/not-downloaded.ts`, `protected-config.ts`,
and for private folders `sync/private-folders.ts`, `sync/private-sync.ts`,
`sync/reserved-path.ts` (see "Private Folders (client sync, stage 3b)" below).
Every change to sync runs through the multi-member harness — see "Testing
Sync" below.

One press syncs several repositories: the company repository first (steps
0–13 below), then every private folder the member may read — its own scope
repository, cloned at its path inside the company folder — with the same
steps, its own `syncLocks` entry and its own `PENDING_PUSH`:

```
P1. GET /me/scopes (cached in .git/acb-private-scopes.json; offline → the
    cached answer, and nothing is deleted or handed over)
    ├─ no longer listed and the company repository has it → made public:
    │    back up unsynced edits, drop the inner .git and the scope's files
    │    (the company sync then checks the public version out)
    ├─ no longer listed and POST …/paths/check says "not usable" (or the
    │    server says "not a member") → access lost: delete the clone WITHOUT
    │    a backup (Q1) + notice
    └─ anything undecided (fetch / check failed) → wait, nothing deleted
P2. Write every readable private path into the company's .git/info/exclude
[company repository: steps 0–13; 4 and 5 skip the private clones, 6.6 holds
 back new files under a reserved name]
P3. Each readable private folder: excluded in settings → sync it one last
    time and remove the clone; otherwise clone it when missing (a folder
    already at the path goes to the private backups first; every segment of
    the path must be a real directory inside the company folder, and the
    clone URL must be the company server's own), then steps 0–13 in the
    clone (read-only viewer: fetch + offer local edits back, never push).
    A failure in one repository does not stop the others.
```

```
0. Serialize per repository (syncLocks)
1. Restore a partial clone's lost promisor config (sync/remote.ts);
   recover from stale rebase / merge / cherry-pick state; declare
   `.gitignore merge=union` in `.git/info/attributes` (idempotent)
2. Retry a PENDING_PUSH left by a previous failed sync
3. Ensure .gitignore essentials (.backups/, .workspace/, node_modules/, .env*,
   **/.personal/* with !**/.personal/.gitignore)
4. Scan for >100MB files → append to .gitignore (`sync/large-files.ts`): only
   what git lists is stat'ed — `ls-files --cached` + `--others
   --exclude-standard` (no blob read, nothing downloaded in a partial clone),
   plus the contents of nested repositories / gitlinks; never .git,
   node_modules, .backups/.workspace (any depth) or a private folder. Tracked
   files over the limit still get their line (they stay tracked, as before).
   "Already ignored" = `git check-ignore --no-index` (never a substring of the
   file: that skipped whole departments); the line is the path as a literal
   pattern (glob characters, leading `#`/`!`, trailing spaces escaped; a root
   file anchored as `/name`). Threshold injectable (`SyncDeps.largeFileThreshold`)
5. Detect nested Git repositories → ask the user BEFORE modifying anything
6. git fetch --progress origin
6.5 Hold back files created inside excluded (not downloaded) folders, at any
    depth → .backups/<ts>_outside_checkout/ (never staged, never shared)
6.3 Company repository: stop before anything changes when the server turned
    an ancestor of a readable private folder (or the folder) into a file or
    symlink (the pull would delete the clone with its unsynced work)
6.6 Company repository: new files at or under a folder name the member may
    not use (POST …/paths/check, cached; unknown never blocks) →
    .backups/<ts>_reserved_path/ (never staged, never shared)
7. Reconcile sparse checkout against the user's persisted exclusions:
   non-cone patterns `/*` + `!/<folder>/` (a repository still on the old cone
   mode switches here, downloading nothing); exclusions of folders that exist
   neither on origin/main nor in HEAD are dropped (ignored files in excluded
   folders are kept out of git's reach meanwhile)
8. Warn if files were deleted locally (sync / restore / cancel)
9. git add --sparse . → unstage anything under .backups/, .workspace/ or a
   private folder (a shared .gitignore negation can re-include them; index
   only) → git commit → record localHash
10. git pull --rebase --progress origin main
    ├─ Success → step 12
    └─ Stopped mid-rebase → step 11
11. Conflict loop (repeat until the rebase finishes):
      a. Back up the local version of newly conflicted files
      b. Classify the unmerged index entries by whether stage 2 exists
         ├─ stage 2 present → git checkout --ours → git add (server version)
         └─ stage 2 absent  → git rm --force (the server deleted it)
      c. git rebase --continue
11.5 If commits were replayed: drop the duplicate lines union merging left
     in the .gitignore files about to be pushed → commit
12. Department folder protection (restore folders deleted locally)
13. git push --set-upstream --progress (also when only earlier unpushed
    commits are left) → on failure, unless the server rejected it: fetch, and
    if origin/main already contains HEAD treat it as pushed; else write
    PENDING_PUSH
    ├─ Rejected with PERSONAL_PATH → reset --soft origin/main →
    │    git rm --cached those paths (files stay on disk) → commit → push again
    ├─ Rejected with LOCAL_ONLY_PATH (.backups/ or .workspace/ content, any
    │    depth) → the PERSONAL_PATH recovery: squash, untrack (kept on disk),
    │    push once more; a second rejection → errorType 'local_only_path'
    ├─ Rejected with RESERVED_PATH → squash (ancestor check) → back the
    │    listed files up to .backups/<ts>_reserved_path/, remove them from the
    │    commit AND the disk, put an exact move back → commit → push again,
    │    once (no dialog; the server's reason line is shown verbatim)
    ├─ Rejected with SECRET_DETECTED → squash the unpushed commits (no file
    │    changed) → push once more; with one commit (or still rejected) the
    │    secret is in the files: report them, no PENDING_PUSH
    └─ Rejected with PROTECTED_CONFIG and/or WRITE_DENIED → ask the member
         (one dialog per section, both before anything changes); on "restore":
         first squash the unpushed commits (no file changed) → push;
         only if still rejected: back up their version → reset --soft
         origin/main → put the still-listed paths back to the server
         version (protected first, then write-denied; an exact move into a
         denied folder is moved back) → commit → push again, once
```

**Commit message (step 9)**: written by the AI the member signs in with
(`client/electron/commit-message.ts`, wired in `main.ts`): the chosen auth
mode first — Claude Code as an isolated one-shot `claude -p --model haiku`
(the voice polisher's flags, shared `electron/claude-oneshot.ts`), Codex
(`generateCodexText`), or the API key (`claude-haiku-5-5`) — then whichever
other is ready. Input is only `git diff --cached --name-status` + `--stat`
(`core.quotePath=false`, capped), sent as JSON data; only the answer's
`<commit_message>` block is used, sanitised (72-char subject, ≤ 20 body lines,
≤ 2,000 chars). Nothing available, a failure, no tagged block or 30 s → the
fixed 「Sync from AI Company Builder」; the message itself is never logged. A
private folder's clone (`kind: 'scope'`) uses the API key only, as before —
its file names never go to a CLI sign-in (Codex is another vendor).

### First Setup: Download Only the Picked Departments (partial clone)

A member setting up a company in a **fresh folder** (no local commits) picks
their departments first (`CompanySelector` →
「所属する部署を選んでください。他の部署はあとから設定でダウンロードできます」);
`git:setupCompanyRemote` then runs `checkoutSelectedDepartments`
(`client/electron/sync/first-setup.ts`): `fetch --filter=blob:none` (commits
and trees only) → persist the sparse exclusions (the departments *not*
picked) and set the patterns → check out, which downloads just the
checked-out blobs in one batch. The checkout is the usual exclusion model
(next section): everything (dotfolders such as `.claude` included) minus the
unpicked departments. Nothing picked → full clone as before. Existing clones
are never converted to partial clones.

- Both selector paths (「既存のフォルダを開く」 = the folder itself,
  「新しく作成」 = `<folder>/<company>`) first ask `git:inspectCompanyFolder`
  (`client/electron/sync/company-folder.ts`, read-only; renderer side
  `src/lib/company-folder-plan.ts`): empty folder (OS files such as
  `.DS_Store` ignored, or this company's origin with nothing checked out
  yet) → picker + partial setup; clone of this company with commits → opens
  as before; clone of another remote (origin compared by path,
  `/api/git-http/<id>`, so a moved server address still matches) → refused;
  member's own files, or a repo with its own history, while the company has
  content → refused (checkout would stop on a shared name or mix unrelated
  files into what sync shares; nothing is deleted). Company without content
  yet → the folder becomes its first commit (owner), as before.
  `git:setupCompanyRemote` repeats the check as a backstop (`refused: true`)
  and inits a repository at the folder itself, never re-pointing a parent
  repository's origin. Offline only a clone of this company opens.
- The setup screen shows bytes received (`setup:progress`, the same
  pack-size watcher as `sparse:progress`); reopening a clone does not say
  「初回」.
- After login the remembered company (`localStorage lastCompany:<userId>`,
  per `--user-data-dir`) opens directly: `src/lib/restore-company.ts`
  registers its folder **before** `fs:exists` — main answers file questions
  only for registered roots, so checking first always said "missing", forgot
  the company and sent every login through the selector and setup screen.

- Server: `configureBareRepo` sets `uploadpack.allowFilter` and
  `uploadpack.allowReachableSHA1InWant` (`server/src/lib/git-server/repo-config.ts`).
  git-http does not forward `Git-Protocol`, so upload-pack speaks v0, which
  refuses every lazy fetch (a want that is not a ref tip) without the latter;
  "reachable" is what a full clone already serves, `allowAnySHA1InWant` is
  not needed.
- Later fetches keep the filter (`remote.origin.promisor` /
  `partialclonefilter`; never remove origin to change its URL, and a clone
  that lost these keys is repaired — see the guards table). A blob outside the cone that git needs — a rebase
  replaying over a teammate's rename, restoring a server version, adding a
  department in settings, `git log -p` — is fetched lazily by git itself,
  authenticated through the environment `createGit` sets (`GIT_ASKPASS` +
  `GIT_TOKEN`, inherited by git's own `fetch` child). The token is still
  never written to disk, so git run **outside the app** (a terminal, or the
  chat agent running `git log -p` / `git show` over another department) cannot
  authenticate a lazy fetch: that command fails with an auth error and
  changes nothing; files and git commands inside the downloaded departments
  are unaffected.
- Adding a department (or folder) in settings (`setSparseExclusions`)
  downloads it. Offline, `sparse-checkout set` fails and rolls its patterns
  back, and `applySparseSelection` writes the previous exclusions back, so
  patterns, worktree and config stay as they were and the panel shows
  「インターネットにつながっているときにダウンロードできます」. Sync offline
  fails exactly as for a full clone (commit stays local, `PENDING_PUSH`).
- A department a teammate creates later appears automatically, as for every
  sparse checkout (everything − exclusions).

### Folder-Level Download Choices (sparse exclusions at any depth)

A member can leave out any folder, not only a whole department (request from
the コンテンツ group, 2026-10-22). Model and code: `client/shared/sparse-paths.ts`
(pure: normalisation, `excludedFolderOf`, patterns), `client/electron/sync/sparse.ts`
(apply / reconcile), `client/electron/sync/not-downloaded.ts` (main-process
reader for the guards).

- **Exclusion list, everything else downloaded.** `.git/acb-sparse-config.json`
  `{ excluded: ['営業部', 'コンテンツ/動画'] }` — repository-relative folders at
  any depth, as the tree spells them. Applied as a **non-cone** sparse
  checkout: `/*` then one `!/<folder>/` per exclusion (wildcards escaped; a
  Japanese name is also written in NFC and NFD, since git matches the index
  bytes). A folder a teammate creates anywhere outside an excluded folder
  downloads automatically, and a folder the member creates is always inside
  the checkout. Cone mode was rejected: it can only say "everything except
  コンテンツ/動画" by listing every sibling at every level, which goes stale
  as soon as a teammate adds a folder (until the next reconcile it would not
  download, and a member-created folder would lie outside the cone).
  Performance is not a concern at this size (~6.5k files, a handful of
  patterns); the sparse index (cone-only) is not used. Non-cone `set` does
  not delete ignored files (that clean-up is cone-only), and `git add
  --sparse` / partial clone behave the same in both modes.
- **No re-including inside an excluded folder.** An exclusion covers its
  whole subtree; `normalizeExclusions` folds an entry below another into it,
  and the settings tree disables the children of an unchecked folder. A
  re-include would make "where may I write" and "what does a new folder do"
  depend on pattern order, and the outside-checkout / write guards would have
  to reason about holes inside holes — for no request anyone made.
- **Migration.** Existing members are on cone mode with department
  exclusions. The same list as non-cone patterns selects exactly the same
  files, so sync's reconcile runs `sparse-checkout set --no-cone …` once: no
  download, no deletion, ignored files untouched (harness: `migration (full
  clone | partial clone)`). Until then the readers understand the cone file
  (`appliedExclusions`, `notDownloadedFolders`).
- **Stale exclusions** (the folder exists neither on origin/main nor in HEAD:
  a teammate deleted or renamed it) are dropped at the reconcile, so a folder
  the member creates at that path later is shared normally instead of being
  held back forever.
- **Not downloaded = applied.** Every guard asks for the folders that are in
  the list *and* excluded by the applied patterns (`appliedExclusions` with
  git, `notDownloadedFolders` from the files under `.git/` alone — git writes
  `core.sparseCheckout` to `config.worktree`). Paths compare in NFC with A–Z
  folded, like the push check and the chat write guard.
- **Writes into a not-downloaded folder are blocked in three layers**:
  1. the app's file operations (`fs:writeFile`, `fs:createDirectory`,
     `fs:rename` / `fs:move` / `fs:moveFromExternal` / `fs:copy` targets)
     refuse in the main process (`notDownloadedRefusal`), and the renderer
     disables those actions with the same explanation;
  2. the chat's PreToolUse write guard (see Chat Write Guard below);
  3. sync's outside-checkout hold-back (guards table), now for any excluded
     path, not only root folders.
- Leaving out a folder with uncommitted changes (`uncommittedChangesIn`,
  IPC `git:sparseUncommittedChanges`) is confirmed first in the settings
  panel: git leaves edited / new files on disk, and the next sync moves them
  to `.backups/<ts>_outside_checkout/` (not shared, not lost).
- **Folder sizes** for the settings tree come from the server,
  `GET /api/companies/:companyId/folder-sizes?path=<folder>&measure=<folder>…`
  (`server/src/lib/folder-sizes.ts`: one `ls-tree -r -l` of the shared
  branch per commit, cached; any member). They cannot be computed in a
  partial clone: tree entries carry no sizes, and `git ls-tree -l` there
  lazily downloads every missing blob just to report its size. IPC
  `git:folderSizes` (`client/electron/sync/folder-sizes.ts`) falls back to
  the local trees (names only, `offline: true`) when the server cannot be
  reached. `git:sparseSetExclusions` reports the bytes arriving in
  `.git/objects/pack` as `sparse:progress` events while it runs.
- **Settings UI** (`client/src/components/settings/DownloadFoldersSection.tsx`,
  logic in `client/src/lib/download-selection.ts`): a tree of tri-state
  checkboxes (department → sub-folders, one level loaded per expand) with
  sizes, a summary (「6.5 GB をダウンロード済み（全体 10.4 GB）」 + usage bar,
  and the size after applying), search over the loaded folders, and a sticky
  footer: changes are a draft until 適用 (取り消す drops it). Applying checks
  `git:sparseUncommittedChanges` for the folders being left out and asks
  first; while it runs the footer shows the bytes received against the
  folders' size. Children of an unchecked folder are shown unchecked and
  disabled. Offline: sizes are 「—」 and a download fails with
  「インターネットにつながっているときにダウンロードできます」, draft kept. The
  settings panel has a left section nav and shares its building blocks
  (`settings/ui.tsx`: neutral zinc, one indigo accent, light and dark).
- **File tree** (`FileTreePanel`): a not-downloaded folder stays visible as a
  muted placeholder (dashed folder icon, 「未ダウンロード」; on hover / focus
  「ダウンロード」, also in its context menu) — so nobody thinks it does not
  exist and recreates it. It does not expand and is not a drop target; new
  file / folder / rename into it is refused with `notDownloadedUserMessage`.
  `useSparseCheckout` instances refresh each other through the
  `acb:sparse-changed` window event. Preview page with the preload API
  mocked: `client/tests/download-folders-ui.html?view=settings|filetree&theme=light|dark&state=normal|offline|slow|confirm|applyOffline`
  (serve with a renderer-only Vite config, without the Electron plugin).

### Conflict Resolution Strategy

- Server version wins for conflicted files — except `.gitignore` files (any
  depth), which merge with git's `union` driver: both sides' lines survive and
  the file never stops the rebase (see the guards table)
- A file the server **deleted** follows the deletion — that is the same
  "server wins" rule applied to a file that no longer has a server version
- Local version is automatically backed up to `.backups/` before being replaced
  *or* removed, so the member's edits survive either outcome
- Non-conflicting changes are preserved via Git's native 3-way merge
- Uses `rebase --continue` (not `--abort`) to preserve auto-merged files
- `--ours` during a rebase means **upstream / server**, the inverse of its
  meaning during a merge. Do not "fix" this to `--theirs`.
- The server version is staged with `git add -f`: when the member's pick had
  just excluded the folder (a shared folder with a stray `.git`, answered
  "exclude"), a plain `add` refuses the path as ignored and the same pick
  failed on every sync (found by the sync harness soak). Taking the server
  version tracks the teammate's file inside the excluded folder again, so
  after the rebase sync untracks excluded nested repos once more (`rm
  --cached`, one extra commit) — the exclusion holds within the same sync.
- Every index update sync makes on a path it did not just check out (`add -f`
  / `rm` in conflict resolution, the nested-repo and `.personal` untracking,
  the protected-config restore) passes `--sparse`: in a sparse checkout a
  root folder the member created before the server had it lies outside the
  cone, and git refuses to touch it otherwise — the pick failed on every
  sync (found by the partial-clone soak). No effect on a full checkout.
- The success message reports the two outcomes separately (overwritten vs.
  deleted) and the result carries `deletedConflictFiles` alongside
  `conflictFiles`. A file that simply vanishes reads as data loss.
- Backups are extracted with `git cat-file -p <localHash>:<file>` into a Buffer
  (`binaryCatFile` on the configured git, so a partial clone could fetch a
  missing object with auth and the watchdog — the local versions are always
  local in practice).
  `git show` returns a string and corrupts binaries (pptx, png, …), which are
  exactly the files that conflict most often. When the file no longer exists
  at `localHash` (a later unpushed commit renamed or deleted it), the backup
  falls back to `:3:<file>` — the local side of the pick being replayed. And
  when a pick replaces an *earlier* local version that the saved one does not
  match (the path was renamed away and reused, or edited in several unpushed
  commits), that version goes to `.backups/<timestamp>_<round>/` with its own
  `_metadata.json`. Without these the conflicted edit was replaced by the
  server version and saved nowhere, while the message claimed it was in
  `.backups/` (found by the sync harness soak).

### Non-Negotiable Guards

Every item below exists because of a production failure. Removing one
reintroduces a specific, observed way for a non-engineer to lose work.

| Guard | Why it exists |
|---|---|
| `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true` on every git invocation | `rebase --continue` opens an editor to confirm the commit message. In a GUI-launched Electron app that editor is `vi` with no TTY, so it blocks forever. This froze one member's sync button on every press for ~2 months (~143MB of commits stranded locally, 2026-07-29). Git always invokes editors through its own `sh`, so `true` works on Windows too. |
| `timeout: { block: 5 * 60 * 1000 }` | Watchdog: kill any git process that produces no output for 5 minutes, so a process waiting on input that will never arrive cannot hang `await` forever. Long network transfers survive it because fetch/pull/push all pass `--progress`. |
| `http.postBuffer=524288000` | Old system git (e.g. Apple Git 2.39, still reachable via the system-git fallback) has a broken chunked HTTP push that fails even against github.com. Buffering past the 1MiB default keeps git off chunked transfer regardless of which binary resolved. |
| The mac app's bundled git is **universal** (arm64 + x86_64): electron-builder's `beforePack` hook (`client/scripts/universal-git.mjs`) downloads both darwin dugite-native archives pinned in dugite's `embedded-git.json` (sha256 verified), `lipo -create`s every Mach-O, requires every other file to be byte-identical (else the build fails), keeps symlinks/permissions, and replaces `node_modules/dugite/git` with the result. Git Credential Manager (.NET, per-arch assemblies, ~110MB) is left out — the app clears `credential.helper` and never runs it. CI job "Universal bundled git (macOS)" runs the merge and both slices (`arch -x86_64`) | dugite downloads git for the build machine only, so the universal app built on Apple Silicon shipped an arm64-only git: on Intel Macs `resolveGitBinaryWithFallback` (`main.ts`) dropped to `/usr/bin/git` (Apple Git 2.39, known CVEs) and pushes failed (2026-10-21). `@electron/universal` does not merge anything under `app.asar.unpacked`, it just keeps the x64 slice's copy, so the merge has to happen before packing. The system-git fallback stays as a last resort and logs which binary and arch are in use. |
| The member's own git hooks and templates never run: `core.hooksPath` and `GIT_TEMPLATE_DIR` point at app-owned empty directories (`<userData>/git/hooks`, `<userData>/git/templates`; `appGitDirs` in `client/electron/sync/git-factory.ts`), for the bundled git and the system-git fallback alike. Every app git goes through that factory (main.ts `createGit`; the only other spawn is the `--version` probe) | A developer machine had a global `init.templateDir` (git-secrets) that installs `.git/hooks/pre-commit` into every new repository. In a partial clone that hook lazily fetched thousands of blobs one by one and a commit hung for 10+ minutes (2026-10-22) — the watchdog would have killed sync. Global config applies to the bundled git too, and `GIT_TEMPLATE_DIR` outranks `init.templateDir`. A real directory instead of `/dev/null`, which is not a path on Windows; because the app owns it, hooks the app itself needs later (git-lfs's `pre-push`) can be installed there deliberately. `tests/sync/user-hooks.test.ts` sets a failing global template / `core.hooksPath` / `.git/hooks`. |
| `merge.stat=false` | A pull that fast-forwards prints a diffstat, which reads every file the teammates changed. In a partial clone those blobs were never downloaded, so every sync silently fetched the teammates' changes in departments the member did not pick (found by the partial-clone harness). Nothing reads the diffstat. |
| Sparse changes use one `sparse-checkout set --no-cone /* !/<folder>/…` (never `init` + `set`), and a failed change writes the previous exclusions back (`applySparseSelection`) | In a partial clone, widening the checkout is a download. `init --cone` alone narrows the worktree to the root files; if the following `set` then failed offline the member's folders vanished from disk. A single `set` rolls its own patterns back on failure, and restoring the config keeps the next sync from retrying a choice that was never applied. |
| `origin` is never removed and re-added: its URL changes only through `git remote set-url` (`setRemoteUrl` / `configureOrigin` in `client/electron/sync/remote.ts`, used by `git:setupCompanyRemote`, `git:addRemote` and sync's SSH→HTTPS migration), leaving every other `remote.origin.*` key alone. Self-heal: before sync, before every sparse change (`applySparseSelection`) and on every company setup/reopen, a repository with promisor packs (`objects/pack/pack-*.promisor`) and an origin URL but no `remote.origin.promisor` / `partialclonefilter` gets back exactly what `fetch --filter=blob:none` writes — `remote.origin.promisor=true`, `remote.origin.partialclonefilter=blob:none` (git 2.53 writes no `extensions.partialClone`) — with one warning log line; a full clone is never touched. The download button in a not-downloaded department shows why it failed (`role="alert"` under the button, offline wording as in settings) | `git:setupCompanyRemote` runs again whenever a company is reopened, and it did `remote remove origin` + `remote add`. `remote remove` deletes the whole `[remote "origin"]` section — in a partial clone that is the promisor config — plus `refs/remotes/origin/*`. Missing blobs could no longer be fetched lazily: 「ダウンロードして同期を開始」 on an excluded department failed with `unable to read sha1 file of 社長直下/…` and the button silently came back (found by the owner against staging, 2026-10-22). `tests/sync-remote.test.ts`; partial-clone scenarios "reopening the company…" and "…heals itself". |
| Files created inside a folder that is **not checked out** (in the persisted sparse exclusions and excluded by the applied patterns — a department or any folder inside one, excluded in settings, or not picked at first setup; paths compared with A–Z folded, `:(literal,icase)` pathspecs) are never staged: before the sparse reconcile and before `git add --sparse .`, every non-ignored file there that is new or differs from its index entry is moved to `.backups/<ts>_outside_checkout/` (`_metadata.json`: reason `outside_checkout`, `folders`, `files`, `serverFiles` = those the server has), the skip-worktree bit of tracked paths is set again (`update-index --skip-worktree`, so they never read as deleted) and the emptied folders are removed (`holdBackOutsideCheckout`, `client/electron/sync/outside-checkout.ts`). The result carries `outsideCheckoutFiles` / `outsideCheckoutBackupPath` and the message 「ダウンロードしていないフォルダ（コンテンツ/動画）にファイルが作られていたため、共有せずに .backups に保存しました（N件）。必要ならそのフォルダをダウンロードしてから保存し直してください。」. If the check itself fails, sync stops before staging with every file in place. Paths the server does not have are held back too, and so is an edit made before the member excluded the folder (git leaves a modified file behind; it cannot be told apart) | The folder is absent on disk, so the member — and the chat AI working in their checkout — cannot see the teammates' files there. A file written at `営業部/提案書.md` landed on a teammate's path the member never had: git clears the skip-worktree bit of a path whose file appears, `git add --sparse .` staged it, and sync silently replaced the teammate's file on the server — no conflict, no backup for anyone (found by the outside-checkout harness, full and partial clones alike). A new path was shared, and at the next sync the reconcile removed it from the member's disk (tracked, clean, outside the cone): the file vanished right after being "saved". Sync cannot tell whether a teammate has, or is about to push, the same path, so nothing is shared from there; inside the checkout nothing changed. It runs before the reconcile because `sparse-checkout set` with a changed file on a not-checked-out path downloads the teammate's version in a partial clone. |
| Every `sparse-checkout set` the app runs (`applySparseSelection` → `keepIgnoredInExcluded` in `client/electron/sync/sparse.ts`) first moves the ignored files inside every folder it leaves excluded (`ls-files --others --ignored --exclude-standard --directory`, outermost entries only) to `.git/acb-sparse-keep/` and puts them back afterwards, also when `set` fails; a leftover from a crash is restored before the next `set`, and an entry whose path is occupied again stays there rather than being overwritten | In cone mode `sparse-checkout set` deletes every ignored file in a tracked directory that leaves the cone (documented git behaviour), and sync runs it on every press: a member's `.personal/` notes, `.env` files and auto-ignored large files inside an excluded department — local only, never on the server — were deleted when the department was excluded in settings and at every later sync (found by the outside-checkout harness). The non-cone patterns used since folder-level choices do not trigger that clean-up; the move stays as a guard against any git that does. With a folder below one that is untracked and ignored as a whole, `ls-files --directory` fails ("directory entry not superset of prefix", found by the mixed soak): the listing is retried without `--directory`, and if that fails too the `set` runs without the move rather than failing. |
| The sync preview (`git:preview`, `client/electron/sync/preview.ts`) never stages: it reads `git --no-optional-locks status --porcelain=v1 -z -uall --no-renames` (untracked → added); the AI summary stages into a throwaway copy of the index (`withScratchIndex`, `GIT_INDEX_FILE`); the diff / revert buttons read the disk against HEAD. Because older apps did stage, the outside-checkout hold-back first puts every index entry inside a not-downloaded folder back to HEAD (`unstageToHead`: staged additions `rm --cached`, the rest `update-index --cacheinfo`, skip-worktree restored for absent files), and the reserved-path hold-back counts staged additions (`diff --cached --diff-filter=A HEAD`) as new paths | Preview ran `git add --sparse .`. A file created inside a not-downloaded folder was then in the index, so the hold-back — which compares the disk with the index — saw nothing new or changed, and the next sync shared it with the whole company, over a teammate's file the member never had (found by an audit, 2026-10-23; `outside-checkout.test.ts` / `private-folders.test.ts` "…staged by an older app's preview…"). Staged new paths at a private folder's name likewise skipped the pre-check and only stopped at `[RESERVED_PATH]`. |
| Conflict resolution is a **loop**, not a single round | A rebase replays commits one at a time and pauses on *every* conflicting pick. The original single-round code fell back to `rebase --skip`, which silently discarded a whole commit the moment a second pick conflicted. |
| Conflicts are classified by stage-2 presence before anything is resolved (`classifyConflicts` in `client/electron/sync/conflicts.ts`) | `git checkout --ours` reads stage 2 of the index, which a modify/delete conflict (server deleted a file the member had edited, status `DU`) does not have — and the command fails **atomically**, so every other path in the same call stays unresolved too. The exception escaped both the conflict loop and its `catch (pullError)`, so sync returned an `unknown` error with the rebase still in progress; every retry aborted the stale rebase and died at the same pick. A pilot user was left permanently unable to sync — commits safe locally, but nothing reaching the team. Triggered whenever the server deletes a file, or moves one while also rewriting it (rename detection misses below the similarity threshold). |
| `rebase --skip` only when the pick is genuinely empty | Taking the server version can leave a pick with no content of its own — that is the only case where skipping is correct. For any other stall, abort and surface the error. Guessing with `--skip` destroys user commits. |
| Rebase detection uses the `rebase-merge` / `rebase-apply` directories | `REBASE_HEAD` is just a ref and can linger after a rebase has finished, so it reports in-progress rebases that do not exist and misses recovery. |
| `syncLocks` registers the run **before** awaiting the previous one | Registering afterwards let two queued clicks wake together and run concurrently against the same repository. |
| Nested-repo handling asks the user **before** any mutation | The pre-consent version ran `git rm --cached -rf` and appended to `.gitignore` first, untracking an entire shared folder and surfacing as a "653 files deleted" warning even though nothing had left the disk — and cancelling did not roll it back. A folder that is already shared offers "remove the inner .git and keep sharing" as the default. |
| Server bare repos set `receive.denyNonFastForwards` and `receive.denyDeletes` (`configureBareRepo` in `server/src/routes/git.ts`, applied at creation and on startup to all repos) | Shared history is the team's only copy. Without these, one client's force push erases everyone's work. This was a near miss — only an auth failure stopped a `push --force-with-lease` from a diverged client. |
| `.gitignore` files merge with git's built-in `union` driver: sync writes `.gitignore merge=union` into the repository-local `.git/info/attributes` (idempotently, before any rebase; `client/electron/sync/gitignore-merge.ts`). After a rebase that replayed commits, the duplicate lines the merge added to the `.gitignore` files about to be pushed are removed in one extra commit — only copies beyond what either side had, and never a pattern with an opposite (`!`) line between it and the copy kept | Sync appends lines to `.gitignore` itself (nested-repo and large-file exclusions, the essential patterns). When two members changed `.gitignore` concurrently the rebase conflicted on it and "server wins" dropped the member's side, sync's own lines included: the member was asked about the same nested repo again and concurrent syncs did not converge (found by the sync harness soak). `.git/info/attributes` is never committed (nothing is changed in the company repository on the member's behalf), does not depend on global git config, outranks any committed `.gitattributes`, is read by every pick of `pull --rebase` / `rebase --continue`, and a slash-less pattern covers `.gitignore` at any depth. Trade-off: union keeps both sides of an overlapping hunk, so a line one side deleted right next to the other side's change comes back — a path stays ignored that someone wanted shared, which loses nothing and can be removed again. Every other file keeps "server wins". |
| Every push decision lives in one TypeScript module, `server/src/lib/push-check/` (rules in `rules.ts`, messages in `report.ts`, write policy in `policy.ts`). `server/src/templates/pre-receive-hook.sh` is a thin caller: it pins `export LC_ALL=C`, runs `entry.ts` with the server's node and tsx loader (absolute paths baked in by `lib/git-server/hook.ts`, re-rendered at every API startup, so a change needs a restart) and **fails closed**: any exit other than accept/reject, including the checker not starting, rejects with `[HOOK_ERROR]` (the client retries via `PENDING_PUSH`). The checker handles git output as byte strings (latin1) so matching stays bytewise with A–Z-only case folding, exactly like the shell tools under `LC_ALL=C`. The old shell hook is kept at `server/tests/fixtures/pre-receive-hook.legacy.sh`; `push-check-differential.test.ts` feeds a corpus through both and requires identical stdout/stderr/exit status — except the one intended change since, a secret only in an intermediate commit (see the secret-scan row) | The shell hook's "paths that differ only by case" check (`tr \| sort \| uniq -d`) followed the locale it inherited: under `LANG=en_US.UTF-8` on macOS, sort/uniq treat distinct Japanese names as equal and ordinary pushes were rejected with `WINPATH_DETECTED`. Bytewise, every host behaves like the production container: A–Z folds, non-ASCII case pairs (`Ａ`/`ａ`, `É`/`é`) do not — as production never did (`hook-locale.test.ts` pushes under UTF-8 locales). Old clients parse the messages, so the port changed no byte of them. |
| Only owner/admin may change agent-execution config: the pre-receive hook rejects with `PROTECTED_CONFIG` any push in which some commit adds, modifies, deletes or renames `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, anything under `.claude/hooks/`, or a file/symlink named `.claude` — at any depth, case-insensitively. The role comes from `memberships` via `ACB_PUSHER_ROLE`, set server-side in `git-http.ts`; a missing role fails closed for these paths only | The chat runs Claude Code in the shared checkout with `settingSources: ['user', 'project']`, and in non-interactive mode it runs a project `UserPromptSubmit` hook and starts a `.mcp.json` stdio server **without any prompt** (verified with the real CLI). `settings.json` also carries `statusLine`, `apiKeyHelper`, `env` and permission rules. Sync shares nearly everything, so any member could run arbitrary commands on every teammate's machine at their next chat message. Distribution itself is legitimate (an MCP server shared via `.mcp.json` is in production use), so the rule restricts *who*, not *what*. Skills (`.claude/skills/`) are not path-protected — sharing them is the core feature; only their auto-run parts are (next row). |
| Skills, subagents and slash commands (`.md` under `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, any depth, case-insensitive) may be added or changed by anyone **unless the new blob contains an auto-run part**: frontmatter key `hooks`, `mcpServers` (or the plugin-style `lspServers` / `monitors`) in any YAML spelling (quoted, flow, escaped, anchored, nested), a body `!` + backtick opener where the `!` starts a line or follows whitespace, or a ```` ```! ```` block — or the entry is a symlink. Then only owner/admin may push it, with the same range logic, role source and fail-closed rules as the row above, reported in the same `PROTECTED_CONFIG` section (path line, then a reason line that does not start with `- `). Deletions are always allowed. The content check runs inside the push checker; if the contents cannot be read — or `ACB_NODE` (set in `git-http.ts`) names a runtime that cannot run — every changed path in those folders is rejected for non-admins | Claude Code executes these without the model choosing to: a skill's or command's frontmatter `hooks` are registered when it loads, a subagent's inline `mcpServers` are spawned when it runs, and `` !`cmd` `` / ```` ```! ```` are run while the skill or command is expanded — inside fenced code too (only single-line inline code is masked, and substituted arguments can re-pair those backticks, so the hook does not mask at all). Skills can also auto-load by `paths`, and their own `allowed-tools` pre-approve those commands. Text that is not the syntax (`` `!` ``, `!important`, `if ! grep`, prose mentioning hooks) passes. A symlink's target is outside what the hook inspects, and Claude Code follows symlinked skill folders. |
| A `PROTECTED_CONFIG` or `WRITE_DENIED` (no write permission for the folder) rejection is resolved by **rewriting the unpushed commits**, never by a retry or a revert commit (`client/electron/protected-config.ts`) | The rejected change is already committed and the hook checks *every* commit in the range, so a retry or a revert on top fails at the same step forever — the "permanently unable to sync" shape again. The dialog backs up the member's version, squashes the unpushed commits with `reset --soft origin/main` (refused unless `origin/main` is an ancestor of `HEAD`, or it would revert teammates' work), restores just those paths to the server's version (or removes them), and commits the rest. Before restoring, sync first pushes the unpushed commits squashed into one with every file as the member has it: a change they already undid (e.g. took the `hooks` out of a skill after the first rejection) blocks only through its intermediate commit, and restoring would discard — or, for a new skill, remove — an acceptable final version. Push is also attempted whenever commits are still unpushed, because a rejected push writes no `PENDING_PUSH` and a sync with no new edits used to report success while the commits never left the machine. |
| `.personal/` content is never shared, for anyone (owner/admin included): the pre-receive hook rejects with `PERSONAL_PATH` any push in which a commit (or the net `old..new` diff) adds or modifies a file inside a directory named `.personal` at any depth, case-insensitively. Exceptions: the `.gitignore` directly inside a `.personal/` (the server writes it when creating a company or department, and its own local-transport push must keep working), and deletions (how an already-shared file gets unshared). Sync also adds `**/.personal/*` + `!**/.personal/.gitignore` to the root `.gitignore` (`**/` because a pattern with a slash is anchored to the `.gitignore`'s directory) | Department `.personal/` folders were protected only by the `.gitignore` inside them, so a `.personal/` created by hand anywhere else synced like a normal folder and its files were shared with the whole company. Recovery differs from `PROTECTED_CONFIG`: the file is the member's private file, so sync untracks it (`git rm --cached`, kept on disk) instead of restoring a server version, after squashing the unpushed commits for the same every-commit reason. No dialog — nothing is lost. A file the server already had is deleted from the server by that commit. |
| The secret scan reads every commit new to the server, not only the net `old..new` diff: added lines of each commit in `rev-list <new> --not --all` (against its first parent; merges as combined diffs counting only lines added relative to every parent; root commits against the empty tree) plus the net diff, in one `diff-tree --stdin -p` stream, deduplicated per file × pattern. A single commit on top of `old` is read once. New branches keep the old rule (whole content of the tip commit's files). Sync recovers like the first step of `PROTECTED_CONFIG`: on `SECRET_DETECTED` it squashes the unpushed commits (`squashUnpushedCommits`, same ancestor check) and pushes once more; if the files still hold the secret it reports them (`secretDetected`, no `PENDING_PUSH`). The secret is never removed for the member | A secret added in one commit and removed in a later one passed the net-diff scan, yet the intermediate commit — secret included — landed in shared history on every member's machine. Scanning every commit alone would have made "remove the secret and sync again" fail forever (the rejected commit is still in the range), so the client squashes it away; the secret never reaches the server. 200 commits / 50,000 lines check in under a second (`push-check-performance.test.ts`). |
| Write permission is enforced on push: for every path a push changes (adds, edits, deletes, both sides of a rename; every new commit plus the net diff, as above) the checker evaluates `resolveAccess(pusher, path).write` (`lib/permissions.ts`; owner/admin always pass; also checked with A–Z case folded, since macOS/Windows check `Sales/x` out into `sales/`). Denied paths reject the push with `[WRITE_DENIED]` + `  - <path>` lines (same shape as `PERSONAL_PATH`). The rules reach the checker as a **snapshot** git-http writes per receive-pack request (pusher + the company's scopes and rules, 0600 temp file, path in `ACB_PUSH_POLICY`, removed when the request ends; `lib/git-server` `preparePushCheck`). A snapshot is always enforced; an unreadable one rejects with `[HOOK_ERROR]`; no resolvable pusher denies every changed path unless writing is open to everyone. The server's own pushes (department folders, company creation) carry `ACB_INTERNAL_PUSH=1` (`internalGitEnv`) and skip only the write check; git-http strips both variables from what it inherits, so a client cannot select either. A push with neither (local transport on the server host: tests, an operator) is not write-checked | The checker runs as a child of `git receive-pack` and also in the client's sync harness, where no API or database exists, so it reads no database: git-http — the code that authenticated the pusher — decides who is pushing and what the rules were at that moment. With the default seed (`everyone: read + write` on the company scope) nothing changes and no paths are even listed. Rejections are recorded in `push_rejections` from the response like every other marker (`lib/push-rejections.ts`). |
| A private folder's path is **reserved** in the company repository, for everyone (owner/admin included): the push checker rejects with `[RESERVED_PATH]` any push in which a commit (or the net diff) adds or modifies a path at or under a private folder's path — compared NFC + A–Z folded, so `sales/secret/` hits `sales/Secret`, an NFD `人事/評価` hits the NFC one, a rename into it counts on its new side, a file named exactly like the folder counts. So does a **non-folder above it**: a file, symlink or gitlink at any ancestor path of a private folder (`人事` as a symlink when `人事/評価` is private) is listed with the pusher's own path as the folder. Deletions are never refused. The reservation cannot be raced: git-http registers every company receive-pack (`beginCompanyPush`) *before* taking its snapshot, and creating a private folder — after writing its rows — waits for every push registered before them to end (60 s, else 503 `BUSY` and nothing is created), then re-checks the company repository and rolls back if one of them landed at the path; pushes registered later carry the reservation in their snapshot. Same shape as `PERSONAL_PATH` (`  - <path>` lines), each path followed by a reason line `      （『<prefix as the pusher spelled it>』というフォルダ名は使えません。別の名前にしてください。）`. The reserved paths reach the checker only through the git-http snapshot (`reservedPathsFor`, private scopes = `repo_id` set); pushes without one (the server's own, local transport) are not checked — the server validates its own operations (department create/rename refuse a reserved name). The company repository's write check ignores private scopes, so a non-reader sees only this marker, never `[WRITE_DENIED]` there | Without it a member who cannot see `人事/評価` (or their chat AI) creates that folder: with the client's exclusion their files would silently never sync; without it they would be shared with the whole company inside a folder its owners believe private — and a reader's next sync could stage the private checkout into the company repository if the exclusion were ever lost (plan §1.3 D1/D2). The message names only what the pusher typed: by the owner's decision (option B) a private folder's name, its existence as *private* and its viewers are never revealed to someone who cannot read it. A symlink or file above the folder would put a reader's private checkout under — or through — something else on their disk. The race: a push whose snapshot predated the reservation was checked without it, and the creation's re-check only saw pushes that had already landed (reproduced with a proxy delaying the push body; `private-folders.test.ts` "a push racing the creation"). |
| The company's **first** private folder is refused (409 `OUTDATED_CLIENTS`, the #119 shape: `members`, `canForce`) while any member's app is not known to handle private folders (`supportsPrivateFolders` in `server/src/lib/client-version.ts`: build commit date ≥ `PRIVATE_FOLDERS_CLIENT_COMMIT_DATE`; unknown/never-seen = not ready). The constant is the committer date of stage 3b's merge commit (b8c5a8e, #137: `20261022085300`); while it was `null` **no** private folder could be created at all (409 `PRIVATE_FOLDERS_UNAVAILABLE`, `force` included). Afterwards an owner/admin's `force: true` overrides the first-folder check; a manager sending `force` gets 403 `FORCE_NOT_ALLOWED` | An app older than 3b syncs only the company repository: a reader never receives the folder, and the `[RESERVED_PATH]` rejection is a generic push failure it retries on every sync forever — the "permanently unable to sync" shape again. Later private folders do not re-check: by then the owner has accepted the risk once. Before any released app can sync one, `force` would only create a folder nobody's app can receive. |
| AI instruction files — `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at any depth, case-insensitive — may be added, changed or deleted by owner/admin anywhere and by a **department manager inside a department folder they manage** (any depth; root-level ones owner/admin only; owner decision 案B). Anyone else is rejected inside the existing `[PROTECTED_CONFIG]` section (its own sub-list, plain `  - <path>` lines), so current apps already recover (dialog → restore the server's version). The managed folders reach the checker in the git-http snapshot (`managedFolders`); in a scope repository the path is judged as `<scopePath>/<path>`. Pushes without a snapshot (local transport) know no managers. `CLAUDE.local.md` is personal by convention but, once committed, is loaded like `CLAUDE.md` for everyone — so it is protected the same way rather than refused outright (which no current app could recover from). The chat's write guard (`client/electron/write-guard.ts`) refuses the same edits up front | Claude Code / Codex load these into every chat in or below their folder, so whoever writes one steers every teammate's AI there — a prompt injection that runs with each member's permissions, while the files themselves look like harmless Markdown. |
| `.backups/` and `.workspace/` content is never shared, for anyone: the checker rejects with `[LOCAL_ONLY_PATH]` (`  - <path>` lines, the `PERSONAL_PATH` shape) any push in which a commit (or the net diff) adds or modifies a path inside a directory named `.backups` or `.workspace` at any depth, case-insensitively. Deletions are allowed (how an already-shared file gets unshared). A new marker rather than `PERSONAL_PATH`: current apps' `PERSONAL_PATH` recovery refuses any path that is not under `.personal/`, so reusing it would not let them recover either. Current apps show it as a plain push failure; sync never commits these folders (both are essential `.gitignore` patterns), so only a commit made by hand or by another tool hits it — the fix is `git rm --cached` | `.backups/` holds the versions a member lost a conflict with, `.workspace/` the AI's scratch files and cloned repositories. Shared, they would reach the whole company (and the secret scan sees only text). |
| The company repository never tracks private content: sync writes every readable private folder's path into the company's `.git/info/exclude` (a managed block, NFC and NFD, `writePrivateExcludes` in `client/electron/sync/private-folders.ts`) — never into the shared `.gitignore` — and after every `git add` in the company repository unstages (index only) anything under a private folder, `.backups/` or `.workspace/` before committing. Private folders' backups live in `.git/acb-private-backups/`, never in the working tree | `.git/info/exclude` alone is not enough: a shared `.gitignore` negation (`!評価/`, `!*`) outranks it, staged the clone as a gitlink, the push was rejected with `[RESERVED_PATH]` and the reader's company sync was stuck for good; one `!.backups/` line in the shared `.gitignore` would have shared every backup — private conflict copies included — with the whole company (security review of 3b, reproduced in the harness). Exclusion pathspecs cannot be used (git refuses an `add` whose pathspec names an ignored path). A shared line would also show the name to people who may not see it (decision B). `[RESERVED_PATH]` stays the last line of defence on the server. |
| Nested-repository detection (step 5) and the large-file scan (step 4) skip the readable private folders' paths (and a nested repository at a folder name the member may not use is moved to `.backups/<ts>_reserved_path/` whole instead of being offered for exclusion); at placement (P3) a folder at that path that is not a clone of the scope's URL (same URL, or same server path) is moved to the private backups before cloning | Step 5 would ask "exclude this external repository?" and write `/<path>/` into the shared `.gitignore` — the private name — and the scan would name large private files there (plan §1.3 D3). A large file inside a private folder is ignored in that scope repository's own `.gitignore` (its own run), shared only with the folder's readers. |
| Every place, delete or clone of a private folder first checks that each existing segment of its path is a real directory whose real path stays inside the company folder (`safeScopeDir`); before the company pull, sync stops (`errorType: 'conflict'`, nothing changed) when `origin/main` has a file or symlink at a readable private folder or one of its ancestors. A clone URL must be the company server's (same scheme/host, the server's clone path; never `-…` or `ext::`) and is passed after `--` | A teammate could replace `営業部/顧客` with a symlink in the company repository: the reader's pull silently deleted the ignored clone (unsynced private work lost, no backup) and the next placement followed the link and cloned the private folder outside the company folder (security review of 3b, reproduced). A forged /me/scopes answer must not send the app's credentials elsewhere. |
| `[RESERVED_PATH]` (a folder named like a private folder the member cannot read) is resolved without a dialog and **the files leave their place**: before staging (`holdBackReservedPaths`: every new folder prefix of a new path — one the company repository does not have — is sent to `POST …/paths/check`, cached 5 minutes, at most 50 per sync (the server allows 60 per member per minute); unknown answers hold nothing back) or after the rejection (`untrackReservedPaths`: squash with the ancestor check, back up from the commit, `rm --cached` + delete, an exact move put back, commit, push once) they go to `.backups/<ts>_reserved_path/` with `_metadata.json`, and the member sees 「『<what they typed>』というフォルダ名は使えません。別の名前にしてください。」 (the server's reason lines verbatim). A second rejection is reported (`errorType: 'reserved_path'`), never retried in a loop, no `PENDING_PUSH` | Left in place, the file is staged again at the next sync and rejected again — the "permanently unable to sync" shape; ignored instead, the member's files would silently never reach anyone (plan §1.3 C). The app's file operations, the file tree's dialogs and the chat guard ask the same checker up front. Salted hashes of every private path were dropped: names were brute-forceable. |
| Access lost (the folder disappears from `/me/scopes`, the company repository does not have it, and `paths/check` answers "not usable" for it — or `/me/scopes` says "not a member" (404 `Company not found or access denied`) while `/api/me` confirms the session): the clone is deleted **without a backup**, copies in the private backups too, with 「このフォルダを見る権限がなくなったため、手元から削除しました（『…』）。同期していなかった変更も削除されています。」. Only on a fresh, definite answer — offline, a failed fetch or path check, or a transient auth error delete nothing (the folder waits in `pendingPublic`) | Owner decision Q1: someone who may no longer read the folder must not keep it, and nothing can be pushed from there any more (the scope repository answers 404). Unsynced edits are lost by that decision, and the notice says so. |
| Made public (gone from `/me/scopes`, and the company repository has it): handed over only once `origin/main` of the company has the folder (fetched first); until then it stays excluded (`pendingPublic`). Unsynced edits go to the private backups (`<ts>_made_public`), then the inner `.git` and the scope's files are removed so the company pull checks out the public version | Removing the clone before the company repository has the folder would delete its files with nowhere to get them from; checking the company version out over a nested repository or the member's edits fails or overwrites them. |

### Backup Structure

```
{company-folder}/
├── .backups/                    ← in .gitignore, local only
│   └── 2026-02-21_14-30-00.000/
│       ├── sales/proposal.md    ← local version of a conflicted file
│       └── _metadata.json       ← timestamp, reason, cumulative conflict list
│                                  (`conflictFiles` + `deletedConflictFiles`)
│   └── 2026-02-21T14-31-00-000_protected/
│       ├── .mcp.json            ← member's version of a protected file that
│       │                          sync put back to the server's version
│       └── _metadata.json       ← reason `protected_config`, restored/removed paths
│   └── 2026-02-21T14-31-00-000_outside_checkout/
│       ├── 営業部/提案書.md      ← a file created in a folder not downloaded on
│       │                          this computer, never shared
│       └── _metadata.json       ← reason `outside_checkout`, `folders`, `files`,
│                                  `serverFiles` (paths the server already had)
│   └── 2026-02-21T14-31-00-000_reserved_path/
│       ├── 人事/評価/メモ.md     ← a file in a folder named like a private folder
│       │                          the member cannot read; never shared
│       └── _metadata.json       ← reason `reserved_path`, `folders`, `files`
│                                  (+ `reasons`, the server's lines, after a rejection)
│   └── 2026-02-21T14-31-00-000_write_denied/
│       ├── 経理部/予算.md        ← member's version of a file in a folder they
│       │                          may not edit, put back to the server's version
│       └── _metadata.json       ← reason `write_denied`, `writeDeniedFiles`,
│                                  restored/removed paths
│   └── 2026-02-21T14-31-00-000_editor_overwrite/
│       ├── 営業部/提案書.md      ← disk version (the AI's / a teammate's edit) the
│       │                          member chose to overwrite from an editor tab
│       └── _metadata.json       ← reason `editor_overwrite`, `files`, `privateFolder`
└── .git/
    └── acb-private-backups/         ← private folders' backups: never in the working
        │                              tree, so no .gitignore edit can share them
        ├── 2026-02-21T14-30-00-000_private/人事/評価/評価表.md  ← conflict backup
        │                              (also _protected / _write_denied), paths
        │                              company-relative
        ├── …_editor_overwrite/       ← editor overwrite of a file in a private folder
        │                              (private per the cached /me/scopes, or a
        │                              nested .git between file and root)
        ├── …_made_public/            ← unsynced edits of a folder made public
        ├── …_private_folder_existing/ ← what sat at a private folder's path before
        │                              it was downloaded
        └── …_outside_checkout/       ← found at a private folder the member left out
```

The app's backup list (`backup:list`) shows both places; ids of the private
ones start with `private:`.

Backups older than 30 days are pruned at the start of each sync.

### Failure Handling

- Push failure writes `.git/PENDING_PUSH`; the next sync retries it first. The
  local commit is never rolled back — the user's work stays committed.
- A push that throws is not necessarily a failure: the watchdog can kill it
  while the server is still running the pre-receive hook, or the connection
  can die after the pack was accepted (production, 2026-10-21: a ~7-minute
  hook, the push landed, the member was told it failed). Every push site goes
  through `pushToServer` → `pushLandedDespiteError`
  (`client/electron/sync/push-landed.ts`): unless the error is a recognised
  rejection (hook markers, `[rejected]` / non-fast-forward, auth), sync
  fetches and, if `origin/main..HEAD` is empty, reports success and clears
  `PENDING_PUSH`. A failed fetch keeps the failure. A push the server is still
  checking when that fetch runs is not visible yet — the next sync's
  `PENDING_PUSH` retry then finds it up to date.
- Results carry an `errorType` (`network` / `auth` / `conflict` / `locked` /
  `push_failed` / `protected_config` / `write_denied` / `personal_path` /
  `unknown`) so the UI can explain the failure in plain terms.
- A pre-receive hook on the server rejects pushes containing secrets — in any
  commit of the push, not only the final state; the client detects
  `SECRET_DETECTED` in the push error. With several unpushed commits sync
  squashes them into one (the files as they are now) and pushes once more, so
  a secret the member already removed is never shared and does not block the
  next sync; the success message says so. Otherwise it lists the files
  (`secretDetected: true`, no `PENDING_PUSH`) and asks the member to remove
  the secret; the next sync then squashes and pushes.
- The same hook rejects protected agent config — and skills/agents/commands
  with auto-run parts — changed by a non-admin with a
  `[PROTECTED_CONFIG]` section listing the paths. Sync shows
  「このファイルは管理者だけが変更できます」 with the list and offers to put
  those files back to the server's version and sync the rest; cancelling (or
  no window) returns `errorType: 'protected_config'` with `protectedFiles`,
  and the next sync offers the same choice again. Successful recovery reports
  `restoredProtectedFiles` and `protectedBackupPath`.
- `[WRITE_DENIED]` (a member changed paths their permission rules do not let
  them write) lists those paths as `  - <path>` lines between the marker and
  the second separator after it; the explanation lines never start with
  `- `. Format (do not change — clients parse it):
  `[WRITE_DENIED] 変更する権限のないファイルが含まれています`, then the paths.
- `[HOOK_ERROR]` means the server could not run its checks (checker crashed,
  permission snapshot unreadable): nothing was accepted; the next sync retries.
- Sync resolves `[WRITE_DENIED]` with the protected-config recovery
  (`restoreProtectedPaths` with reason `write_denied`; an exact move into a
  denied folder is moved back): 「編集できないファイルがあります」 lists
  the paths and offers 「元に戻して残りを同期」 (default) / 「キャンセル」;
  cancel or no window → `errorType: 'write_denied'` with `writeDeniedFiles`
  (no `PENDING_PUSH`, offered again next sync); success reports
  `restoredWriteDeniedFiles` and `writeDeniedBackupPath`. Both sections in one
  push are resolved in one pass.
- Private folders: the result carries `privateFolders` (one report per
  readable folder: `path`, `success`, `message` / `error`, `cloned`,
  `removed`), `newPrivateFolders`, `lostPrivateFolders`, `madePublicFolders`
  (+ `madePublicBackupPath`) and `reservedPathFiles` / `reservedPathBackupPath`.
  A failed private folder makes the whole result `success: false` with
  「非公開フォルダ『…』を同期できませんでした。…その他のフォルダは同期しました」,
  its `errorType`, and the company's own message kept.
- `[LOCAL_ONLY_PATH]` (`.backups/` / `.workspace/` content, any depth — only
  reachable through a commit made outside sync, since sync unstages such paths
  after every add) is untracked like `.personal/` (kept on disk, no dialog,
  pushed once more); if that fails, `errorType: 'local_only_path'` with
  `localOnlyFiles`, no `PENDING_PUSH`.
- `[PERSONAL_PATH]` (any pusher, `.personal/` content) is handled first and
  without a dialog: the listed paths are untracked and the push retried; the
  result carries `untrackedPersonalFiles`. If that fails it returns
  `errorType: 'personal_path'` with `personalFiles` (no `PENDING_PUSH`).
- `[PROTECTED_CONFIG]` also lists AI instruction files (`CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md`) the pusher may not change — the same
  dialog and restore-the-server-version recovery.
- `[LOCAL_ONLY_PATH]` (`.backups/` / `.workspace/` content, any pusher) has
  no automatic recovery yet: the app reports a push failure. Sync itself
  never commits these folders; the way out is untracking the listed paths
  (the `PERSONAL_PATH` recovery generalised — left to the client).
- On Windows, a transient file lock during rebase (skill tool, editor, or AV
  scanner holding a file) is retried twice before being treated as a failure.

### Testing Sync

Sync is tested end to end by a multi-member harness (`client/tests/sync-harness/`,
tests in `client/tests/sync/`, CI job "Sync harness (macOS)"):

```bash
cd client
npx tsx --test tests/sync/*.test.ts                   # everything CI runs
npx tsx --test tests/sync/scenarios.test.ts           # just the scenarios
SYNC_SOAK_SEEDS=1,2,3,4,5,6,7,8 SYNC_SOAK_MEMBERS=5 SYNC_SOAK_ROUNDS=15 \
  npx tsx --test tests/sync/soak.test.ts              # a bigger soak
```

- A `World` is one company: a bare server repo configured like
  `configureBareRepo` (`BARE_REPO_CONFIG`: deny non-fast-forwards / deletes,
  partial clone; the real hook
  rendered by `server/src/lib/git-server/hook.ts`, i.e. the real push
  checker) and N member clones. Pushes use the local file transport, so the
  hook runs as a child of the member's git; the harness sets
  `ACB_PUSHER_ROLE` / `ACB_PUSHER_ID` / `ACB_PUSHER_EMAIL` / `ACB_NODE` and
  `ACB_PUSH_POLICY` (a per-member permission snapshot, default
  `everyone: read + write`; `world.setScopes(...)` changes the rules) there,
  exactly what `git-http.ts` sets from the session. The HTTP layer itself is not covered here.
- Each member runs the real `createGitSync` with the real git factory, the
  real message-box dialog adapter (answers scripted with `willAnswer`, else
  the default button) and the real server-API adapter over a fake `fetch`.
  Members `write` / `append` / `remove` / `rename` / `initNestedRepo`, go
  `offline()`, let a teammate push first (`beforeNextPush`), or have a push
  call fail before or after the server accepted it (`failNextPush`).
  `await world.addPartialMember(name, { departments })` adds a member set up
  by the real first setup (partial clone over `file://`, only those
  departments); `addDepartment` / `removeDepartment` are the settings panel,
  `reopen(url?)` is opening the company again (`git:setupCompanyRemote` on an
  existing clone: `configureOrigin`, fetch, pull), `missingObjects()` what it
  never downloaded. The harness's own reads in a
  member's clone set `GIT_NO_LAZY_FETCH` (`NO_LAZY_FETCH`); sync's git never.
- Invariants (`invariants.ts`): every sync terminates and leaves no
  rebase / merge / cherry-pick in progress; no committed work is lost (on the
  server, or in `.backups/` with metadata, or kept locally at an ignored
  path); after everyone syncs twice all members are at the server's commit
  with a clean tree; rejected pushes are recoverable by the next sync.
- `scenarios.test.ts` maps to the guards table above; `soak.test.ts` is a
  seeded random soak (`SYNC_SOAK_SEEDS` / `_MEMBERS` / `_ROUNDS`; a failure
  prints its seed and operation log), plus a mixed world with partial-clone
  members (`SYNC_SOAK_MIXED_SEEDS`, `SYNC_SOAK_PARTIAL`);
  `partial-clone.test.ts` runs every guard for a partial member and checks it
  never downloads the departments it did not pick; `outside-checkout.test.ts`
  covers files created inside excluded departments (full and partial clones);
  `folder-exclusions.test.ts` covers folder-level choices (a sub-folder left
  out, teammates' changes inside it, new sibling folders, writes into it,
  local edits when leaving it out, downloading it again, ignored files,
  nested choices, migration from the cone mode, first setup, stale and
  case-variant exclusions; full and partial clones). The mixed soak also
  leaves sub-folders out, downloads them again and writes into them.
  `Member.excludeFolder` / `includeFolder` are the settings panel;
  `characterization.test.ts` holds sync
  to a transcript recorded from the pre-extraction handler (re-record with
  `UPDATE_SYNC_GOLDEN=1` only for an intended behaviour change, and review the
  JSON diff); `findings.test.ts` holds regressions for bugs the harness found;
  `harness-selftest.test.ts` proves each invariant fails when sync misbehaves.
- Private folders (`private-folders.test.ts`): `world.createPrivateFolder(path,
  { viewers, editors?, files? })` creates a bare scope repository configured
  like the company's (real hook) and its scope (`everyone: none` + one user rule
  per viewer); each member's `/me/scopes` comes from `world.myScopes` and
  `POST /paths/check` from `world.pathsUsable` (both 404 until the first
  private folder, like an older server; `member.pathCheckDown`, `pathChecks`);
  a push from a clone gets a snapshot with `scopePath`. `grantPrivate` /
  `revokePrivate` / `makePublic` are the owner's actions (the retired scope
  repository is kept for no-lost-work); `member.scopesApiDown` makes
  `/me/scopes` fail. `assertPrivacy` (part of `settleAndCheck`): nothing at a
  private path and no private content (`privateMarker`) in the company
  repository, and no company commit message or `.gitignore` names a private
  folder; none on a non-reader's disk or in their `.git`; every reader has
  a clean clone at the scope server's commit (unless left out). The soak has
  a private-folder world (`SYNC_SOAK_PRIVATE_SEEDS`, default 201,202).
- New sync behaviour (more repositories, adoption, new rejection types) gets
  a scenario here, ending with `settleAndCheck(world)`.
  `SYNC_HARNESS_VERBOSE=1` prints every sync log line; `SYNC_HARNESS_KEEP=1`
  keeps the temporary worlds.

---

## Architecture: File watching and the file tree (client)

The owner's requirement: anything that creates, changes, deletes or replaces
a file (the AI above all) shows in the app at once, without the member doing
anything.

- **One recursive watcher per company** (`client/electron/company-watcher.ts`):
  a native `fs.watch(root, { recursive: true })` (FSEvents / ReadDirectoryChangesW /
  inotify with Node ≥ 20 — Electron 31 is Node 20), opened by
  `SkillCentricLayout` when the company opens (`watchCompany`) and closed
  when it closes or the app quits — never on a department or tab switch.
  chokidar per department was dropped: chokidar 5 opens one `fs.watch` per
  directory *and* file (~14k for a 6.7k-entry company) and closes them on the
  main thread — measured 30 s (全社) / 27 s (コンテンツ) per close; a
  department switch took 33 s and quit 37 s, every IPC call waiting
  meanwhile. The native watcher opens in ~1 ms and closes in < 1 ms. chokidar
  remains only as the fallback when recursive watching is unavailable
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).
- Raw events (`rename` is ambiguous) are collected per path for 100 ms from
  the first one, then classified by `lstat` into the shape the renderer always
  had: `add` / `addDir` / `unlink` / `unlinkDir` / `change` (≤ 2000 paths per
  batch, the rest in the next). A file replaced by write-temp-then-rename
  arrives as `add`; a removed folder the watcher never saw as a folder arrives
  as `unlink` — consumers treat `unlink` as "this path and everything under
  it". Contents of `.git` (any depth: private folder clones too),
  `node_modules`, `.workspace` and `.backups`, and `.DS_Store`, are dropped.
  The `disableWatchers` perf switch skips opening the watcher.
- Renderer: one IPC subscription (`src/lib/fileEvents.ts`
  `subscribeFileChanges`); consumers filter by path prefix.
- **File tree** (`src/lib/fileTreeModel.ts`, `FileTreePanel`): one model per
  shown folder in a module-level registry (switching back is instant), all
  fed by the watcher. First view reads two levels (`readDirectoryTree(…, 1)`,
  first-level folders open, as before); deeper folders load on expand. An
  event re-reads only the changed path's parent, if it is on screen (root or
  expanded); a collapsed or off-screen folder is marked stale and re-read when
  shown; `change` re-reads nothing (`planTreeRefresh`, unit-tested). Rows are
  memoised (`TreeRow`, actions behind one ref). The not-downloaded department
  prompt is an overlay (the tree stays mounted) and the "folder exists" check
  is keyed per folder (`src/lib/folderExists.ts`); left tabs stay mounted once
  opened (history follows the department only while shown — it runs git log).
- **Previews never show a stale file**: `src/lib/fileVersions.ts` bumps a
  per-path counter on every event; images (tab and markdown) and PDFs use it
  — `local-file://<path>?v=<n>` (`shared/local-file-url.ts`). The protocol
  handler drops the query (`electron/local-file-protocol.ts`, same
  allowed-roots check as before) and answers `Cache-Control: no-store`. An
  open file that is deleted shows a notice; one replaced (`add`) reloads.
- Tests: `tests/company-watcher.test.ts` (incl. a live test on a temp
  folder), `tests/file-tree-model.test.ts`, `tests/local-file-url.test.ts`.
  Preview: `tests/download-folders-ui.html?view=filetree` exposes
  `__acbAddFile(dirRel, name)` to simulate a file the AI writes.
- **Skills list freshness** (`shared/skills-refresh.ts`): `skills:list`
  caches one scan per root + department folder (`''` = company-wide) for 5 s,
  for plain tab switches only. A scan is stale after any event at/under a
  `.claude/skills/` it reads (root one → company-wide; any depth inside a
  department → that department), the `.claude` folder itself, the root
  `.gitignore` (private marks → every scan), or a folder added/removed inside
  the department (it may carry skills). The main process drops stale scans in
  `sendFileChanges`; the renderer (`SkillCentricLayout`) rescans the shown
  list and the company-wide skills behind the slash commands with
  `{ force: true }` (coalesced 120 ms, deferred ≤ 1 s while typing in chat),
  and after every successful sync. A forced rescan keeps the list on screen
  (no loading flash). `.claude/commands` / `.claude/agents` are not listed.
- **External changes to open files** (`shared/editor-disk-state.ts`,
  `TabbedEditorPanel`): a tab remembers the disk version it loaded/saved
  (`originalContent`). No edits → it follows the disk. With edits, a disk
  change shows 「このファイルは外部で変更されました」 (ディスクの内容を読み込む
  after a confirm / 差分を見る — `MarkdownDiffView`, disk − vs. edits + /
  自分の編集を残す) and **pauses autosave**; deleted → 「ファイルは削除されました。
  保存すると作り直します」. Every save first re-reads the disk: if it is no
  longer the loaded version, autosave stops (banner) and ⌘S / closing the tab
  asks 「外部の変更を上書きして保存」 / 「キャンセル」 (Enter does not confirm);
  overwriting first backs the disk version up (`editor:backupBeforeOverwrite`,
  see Backup Structure). Closing a tab whose save was cancelled asks before
  discarding. Preview: `tests/editor-tabs-ui.html?view=external`.

---

## Architecture: Chat Write Guard (read-only folders)

The in-app chat runs Claude Code in the member's checkout. Per-folder write
rules are enforced at push (`[WRITE_DENIED]`), so an AI edit in a folder the
member may only read used to be rejected at sync and moved to `.backups/`
("the AI's work vanished"). The chat now refuses such edits before they run:

- Server: `GET /api/companies/:companyId/me/write-access` →
  `{ version, role, all, scopes: [{ path, write }] }` (`writeAccessSummary` in
  `server/src/lib/permissions.ts`; ETag = version, `If-None-Match` → 304).
  `all: true` for owner/admin or when nothing restricts the member.
- Client: `client/shared/write-access.ts` evaluates a path exactly like
  `resolveAccess` + the push gate (NFC, deepest listed scope decides, A–Z
  folded spelling must be writable too). `client/electron/write-access-store.ts`
  caches it per company — fetched when the renderer opens a company, after
  every successful sync, and at each chat turn (3 s budget, cached answer on
  failure).
- `client/electron/write-guard.ts` + the PreToolUse hook in
  `client/electron/agents/claude.ts` deny `Write` / `Edit` / `MultiEdit` /
  `NotebookEdit` (and best-effort Bash `>` / `>>` / `&>` / `tee` to a literal
  path) whose target resolves inside the company root to a read-only folder,
  with a Japanese reason telling the AI to ask the member instead of retrying.
  Hooks run in every permission mode (bypass included) and for subagents. The
  api-key mode's `writeFile` / `executeCommand` use the same check.
- The same hook refuses a write into a folder that is **not downloaded** on
  this computer (`WriteGuard.getNotDownloaded` → `notDownloadedFolders`,
  checked first and regardless of write access, which may be unknown):
  「このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。」
  Same Bash best-effort limits; sync's outside-checkout hold-back is the
  safety net there.
- Private folders (`WriteGuard.getPrivateFolders`): a write that would
  create something at a folder name the member may not use (`decideReservedWrite`,
  asking `POST …/paths/check` through sync's cached checker; unknown allows)
  is refused with the server's sentence 「『<what the AI typed>』というフォルダ名は使えません。別の名前にしてください。」;
  a write into a private folder the member may only read (`canWrite: false`,
  from the cached `/me/scopes` answer) with the read-only message. Writes into a readable, writable private folder
  follow `/me/write-access` like everywhere else.
- Deliberately NOT done: Claude Code permission deny rules
  (`disallowedTools: ['Edit(...)']`). Deny beats allow, so a writable folder
  inside a read-only one cannot be expressed; matching is case/NFD-sensitive;
  and the provider ignores `disallowedTools` whenever `allowedTools` is set
  (the consultation MCP tools).
- Limits: other Bash writes (`cp`, `mv`, `sed -i`, scripts, `cd x && … > y`)
  and Codex are not covered; unknown access (offline, server error) blocks
  nothing and is logged. The server check and the `[WRITE_DENIED]` recovery
  stay the safety net. Paths are judged lexically (no symlink resolution).
- Renderer: `useWriteAccess` + `ReadOnlyBadge` (Phosphor `Lock`, 閲覧のみ) in
  the file tree (where read-only starts) and above the open file.

---

## Architecture: Private Folders (server, stage 3a)

Read restriction is real only for **private folders**, which are private from
the start (no carve-out of existing folders: move files into a new private
folder instead). Each one is its own bare repository ("scope repository");
its path inside the company tree is reserved in the company repository.
Client sync (3b) and the UIs (3c) build on the contract in
`shared/types/private-folders.ts`.

- **Data**: a private folder = a `scopes` row (`kind 'folder'`) whose
  `repo_id` points at `scope_repos.id` (company, scope, created_at/by).
  Rules on it: `everyone: no read, no write` + one user rule per viewer
  (`read`, `write` for editors). Owners/admins always read and write. A
  private scope never inherits (clearing / removing its last rule is
  refused); a rule deeper inside can only narrow it (`resolveAccess`: inside a
  private folder, read/write also need read of the folder itself; a private
  scope without rules denies). `read: false` is accepted on a private folder
  itself only. `company_path_salts` holds the per-company salt for hashes.
- **Repositories** (`server/src/lib/git-server/scope-repo.ts`):
  `<REPOS_DIR>/<companyId>.scopes/<repoId>.git`, configured exactly like the
  company repository (`BARE_REPO_CONFIG` + the same hook; startup
  re-configures them too), created with one commit holding a `.gitignore`
  with sync's essential patterns. The `.scopes` directory is not `*.git`, so
  the company route can never reach it.
- **git-http**: `/api/git-http/<companyId>/scopes/<scopeId>.git` (scope id,
  not repo id). Fetch/clone need READ of the folder, push needs WRITE
  somewhere in it (403 otherwise); a non-member, a non-reader, an unknown or
  non-private scope all get the same 404. The push snapshot carries
  `scopePath`: every pushed path is write-checked as `<scopePath>/<path>`, and
  every other rule (secrets, protected config, skills, `.personal`, Windows
  paths, gitlinks) runs as in the company repository. The company repository
  stays readable by every member.
- **API** (`server/src/routes/private-folders.ts`, under
  `/api/companies/:companyId`):
  - `POST /private-folders` `{ parentPath, name, viewers?, editors?, force? }`
    → 201 `PrivateFolderDetail`. Owner/admin anywhere (root included); a
    department manager only inside their department (Q9); others 403. Name:
    department folder-name rule. Default viewers: creator + that department's
    managers; the creator is always added; owners/admins are implicit.
    A taken path — a file/folder in the company repository (any case/NFC) or a
    private folder at, above or below it — answers 409
    `FOLDER_NAME_UNAVAILABLE` with exactly
    「『<path>』というフォルダ名は使えません。別の名前にしてください。」; a parent inside a
    private folder the caller cannot read answers like a missing parent
    (`PARENT_NOT_FOUND`), one they can read `ALREADY_PRIVATE`. Under the
    company lock; the company repository is re-checked after the rows are
    written and everything is rolled back if a push landed at the path.
    **Closed until 3b shipped**: while `PRIVATE_FOLDERS_CLIENT_COMMIT_DATE`
    (`lib/client-version.ts`) was null (now 3b's merge date), every create answered 409
    `PRIVATE_FOLDERS_UNAVAILABLE`
    「非公開フォルダは、全員のアプリが対応版になってから作成できます」 — `force`
    included (no released app could sync one). Tests use
    `setPrivateFoldersClientCutoffForTests`.
  - `GET /private-folders` (owner/admin: all; managers: their
    departments'), `GET /private-folders/:scopeId`, `PUT …/members`
    `{ viewers, editors? }` (owner/admin, the department's managers — Q2;
    anyone else 404). Viewer/editor counts include owners/admins.
  - `POST /private-folders/:scopeId/make-public` (owner/admin, 公開に戻す):
    refuses new pushes to the scope repository and waits for running ones,
    archives it (below), writes its current tree into the company repository's `main` at the same
    path as ONE commit (no scope history) with a compare-and-swap
    `update-ref` (retried if a member pushed meanwhile; idempotent if the tree
    is already there), then in one transaction makes every rule there
    readable (write unchanged: nobody gains write) and clears `repo_id`, then
    deletes the scope repository.
  - `DELETE /private-folders/:scopeId?confirm=<folder name>` (owner/admin;
    `confirm` = the last path segment, NFC, else 400
    `CONFIRMATION_REQUIRED`): stops pushes like make-public, archives the
    scope repository, then in one transaction removes the rules and scopes at
    and under its path and the `scope_repos` row (= the reservation), then
    the repository. Readers lose it like losing access (Q1). → `{ path,
    archived: true }`.
  - **Archive** (`archivePrivateFolder`, before delete and make-public; if it
    fails nothing is removed): `git bundle create --all` of the scope
    repository into `PRIVATE_FOLDER_ARCHIVE_DIR` (default
    `<DATA_DIR>/backups/private-folders`) `/<companyId>/<time>_<action>_<scopeId>.bundle`
    + a `.json` sidecar (path, rules, head, who/when); directories 0700,
    files 0600; one `private_folder_archives` row per archive. Never served
    by any route, never named in a response; restore = `git clone <bundle>`.
  - `GET /me/scopes` (any member, ETag/304) → `{ version, scopes:
    [{ scopeId, path, cloneUrl, clonePath, canWrite }] }`: only the folders
    the caller may read. Since 2026-10-22 (owner decision) nothing about the
    others — the salted hashes (`reserved`) are no longer sent: short
    Japanese folder names are cheap to brute-force against a known salt.
    `company_path_salts` is left in the schema, unused.
  - `POST /paths/check` `{ paths: string[] }` (any member, ≤50 paths,
    ≤60 paths per member per minute → 429 `RATE_LIMITED` + `Retry-After`)
    → `{ results: [{ path, usable }] }`: `usable: false` exactly when the path
    (any case/NFC — `normalizeReservedPath`) is at or under a private folder
    the caller cannot read, i.e. where a push would get `[RESERVED_PATH]`; a
    reader's paths inside it are usable. Same shape and work for every path,
    never says which folder or why; paths are not logged. The app checks a
    path and its prefixes to name the folder it shows in
    `reservedPathMessage`. The push-time `[RESERVED_PATH]` check stays the
    enforcement.
  - The permission editor (`PUT /permissions/scopes/by-path` etc.) accepts
    `read: false` on a private folder — and on the folder ITSELF requires it:
    `everyone` / role rules there must be `read: false, write: false`
    (400 `PRIVATE_FOLDER_RULE`; also POST rules / PATCH a rule), only user
    rules grant access (and an editor must also read) — the same set
    `PUT …/members` stores, so a department manager cannot open their
    private folder to the company. Rules deeper inside need no check:
    `resolveAccess` gives them nothing for anyone who cannot read the
    folder itself (narrow only). It edits inside one against its scope
    repository, skips the outdated-app guard there (only new apps receive
    them) and refuses moving rules into/out of one; `GET
    /permissions/folders` lists private folders only to those who may edit
    them (`private: true`).
- **Names never leak** to a member who cannot read a private folder:
  departments/stats/folder-sizes read the company repository (which never
  holds private content); `/me/write-access` omits unreadable private
  folders; `/permissions*`, `/overview`, `/push-rejections`,
  `/private-folders*` are owner/admin/manager-only and managers see only their
  departments'; orphan warnings never consider private folders or rules
  inside them (they are not in the company repository by design).
- Departments containing a private folder cannot be deleted or renamed (409
  `PRIVATE_FOLDERS_INSIDE`); a department cannot take a reserved name.
- There is deliberately no MCP/tool to create private folders: only humans,
  through the admin panel or the app's dialog.
- Tests: `server/tests/unit/private-folders.test.ts`,
  `server/tests/integration/private-folders.test.ts` (real git-http).

## Architecture: Read-only company files for the AI

The chat AI can search, list and read company files the member has **not
downloaded** (folder exclusions, partial clone) — read-only, from the shared
branch on the server (permission plan §11). Editing stays local.

- **Server** (`server/src/routes/company-files.ts`, logic
  `server/src/lib/company-files.ts`, contract `shared/types/company-files.ts`),
  any member, under `/api/companies/:companyId/files`:
  `GET /tree?path=&depth=` (≤10 levels, ≤2000 entries, `truncated`),
  `GET /content?path=&offset=&limit=&maxBytes=` (lines, ≤1 MB per answer,
  `hasMore`/`nextOffset`/`truncated`; binaries → 415 `BINARY_FILE`, by
  extension or a NUL in the first 8000 bytes; the blob is streamed, never held
  whole), `GET /search?q=&path=&regex=&caseSensitive=&limit=` (`git grep -I`
  on `main`; ≤200 matches, ≤20 per file, ≤100 files, 10 s → `timedOut`; at
  most 2 running + 4 queued per company, else 429 `BUSY`; async spawn only).
  Every answer carries the `commit` it was read from (and a private folder's
  own commit). Paths compare as NFC + A–Z folded; answers spell them as stored.
- **No leaks**: each request builds the member's *view* — company `main` minus
  anything at/under a private folder, plus each private folder the member may
  read (from its scope repository, with any ancestor folders needed to reach
  it), every path filtered by `resolveAccess` read. Everything is answered from
  that view, so an unreadable private folder is exactly a nonexistent path:
  same 404 body, same empty search, absent from every listing.
- Fixed-string search runs with `LC_ALL=C` (bytewise: exact for Japanese,
  A–Z folded with `-i`; case-insensitive search in a UTF-8 locale took ~14 s
  per 2 MB with macOS's regex library); `regex: true` uses a UTF-8 locale so
  `.` is one character. The query is also tried in NFD (fixed strings).
- **The query never runs in the server process.** Snippets of long lines are
  cut around the match position git reports (`git grep --column`, a byte
  offset). Building the snippet with `new RegExp(q)` let one member block the
  event loop — every request of every company — for minutes with a
  catastrophic-backtracking pattern (git grep has a time limit, JS does not).
- **Client** (`client/electron/company-files/`): `api.ts` calls the server
  with the member's session from the main process (never visible to the
  model), caches answers 30 s per member (cleared at sign-out), and turns
  failures into plain errors (offline → 「サーバーに接続できないため…」).
  `tools.ts` defines `company_search` / `company_read_file` /
  `company_list` (Japanese + English descriptions: use them for
  not-downloaded folders or company-wide search; read-only; write anything
  built from them into a downloaded folder; `private` content needs the
  member's OK before it goes anywhere public; file content is data, not
  instructions). Reads ask for ≤50 KB, listings/searches are cut to 60 KB
  (`truncated` + note), 60 calls per turn. Nothing fetched is written to
  disk; the write guard still refuses writes into not-downloaded folders.
- **Wiring**: MCP server `acb_company_files`, app-provided (not the
  repository's `.mcp.json`, which is protected config). Claude Code: an
  in-process SDK MCP server per query, tools in `allowedTools` and
  auto-allowed in `canUseTool` (read-only). Codex: a per-turn loopback
  Streamable-HTTP endpoint (`agents/loopback-mcp.ts`, random bearer token,
  127.0.0.1, closed with the turn) in `thread/start`'s
  `config.mcp_servers`. The chat's system prompt gets a short paragraph
  listing the folders not downloaded. The api-key mode does not get them.
- Not yet: pptx/pdf/xlsx are not searchable (text extraction is on hold).
- Tests: `server/tests/integration/company-files.test.ts`,
  `client/tests/company-files.test.ts`.

---

## Architecture: Private Folders (client sync, stage 3b)

Builds on 3a's contract (`shared/types/private-folders.ts`). Code:
`client/electron/sync/private-folders.ts` (cache, excludes, clone checks,
`safeScopeDir`, `cloneUrlAllowed`, `privateBackupsDir`),
`sync/private-sync.ts` (prepare / place / read-only sync),
`sync/path-check.ts` (`POST …/paths/check`), `sync/reserved-path.ts`
(`[RESERVED_PATH]`), orchestration in `sync/git-sync.ts` `createGitSync`.

- **On disk** a readable private folder is a clone of its scope repository at
  its path inside the company checkout (a full clone, also for a partial-clone
  member). The company repository ignores it through `.git/info/exclude` and
  sync unstages it if a shared `.gitignore` negation ever re-includes it
  (`git status` may then list it as untracked; it is never committed).
- **Cache**: the last `/me/scopes` answer — readable folders only, never
  anything about folders the member cannot read — lives in
  `.git/acb-private-scopes.json` (companyId, version, scopes, `pendingPublic`).
  Offline syncs and the chat guard's read-only check use it.
- **Names the member may not use** are known only per path, from the server:
  `POST /api/companies/:id/paths/check { paths ≤ 50 }` → `{ results: [{ path,
  usable }] }` (60 paths per member per minute, 429 beyond; `usable: false` at or under a private folder the caller cannot
  read). One checker per app (`gitSync.pathChecker`, 5-minute cache) serves
  sync's hold-back, the app's file operations (`fs:*` backstop for paths that
  do not exist yet; `privateFolders:reservedPathRefusal` IPC for the file
  tree's new file / 新しいフォルダ… (公開) / rename / move) and the chat guard
  (`decideReservedWrite`, after the synchronous checks). All of them ask for
  every prefix of the path; the first one answered "not usable" is the name
  shown: 「『<prefix as typed>』というフォルダ名は使えません。別の名前にしてください。」.
  Unknown answers (offline, error, older server) never block — the server's
  `[RESERVED_PATH]` and sync's recovery stay the safety net.
- **Access gained** (a new scope in the answer): cloned at the next sync (the
  3c dialog starts one right after creating a folder). An empty folder at the
  path (OS files only) is reused; anything else there goes to the private
  backups (`<ts>_private_folder_existing`) first — never overwritten.
- **Access lost / made public**: see the guards table. Q1: deleted without a
  backup; make-public: unsynced edits saved to the private backups. A folder
  whose fate is not known yet (fetch or path check failed, or the company
  repository does not show it yet) waits in `pendingPublic`, still excluded.
- **Read-only viewer** (`canWrite: false`; git-http answers its push with 403):
  sync never commits there — it fetches, offers local edits back with the
  WRITE_DENIED dialog (member's version to the private backups,
  `<ts>_write_denied`), and resets the clone to the server's version. Cancel →
  `errorType: 'write_denied'`, nothing changed.
- **Download choices** (#124): a private folder is downloaded or not as a
  whole (no exclusions inside it). It is excluded when it lies at or under an
  excluded folder (a department not picked at first setup included). The
  settings tree lists readable private folders under their parent (lock,
  「非公開」, no size: `git:folderSizes` adds them); applying runs
  `applyPrivateFolderChoices` at once: an excluded clone is synced one last
  time and removed only when nothing is left unpushed; an included one is
  cloned. Their exclusions are never dropped as stale (they are not in the
  company tree).
- **Backups** of a private folder go to `.git/acb-private-backups/` (see
  Backup Structure) with the folder's path as prefix, metadata listing
  company-relative paths; dialogs list company-relative paths too; messages
  say 「非公開フォルダのバックアップ」.
- **Names never reach the company repository.** Nothing sync commits there
  can name a private folder: the large-file scan and nested-repository
  detection skip readable private paths (a large file inside a private folder
  is ignored in *that scope repository's* `.gitignore` by the scope's own run
  — shared only with the folder's readers), a nested repository at a name the
  member may not use is moved to `.backups/` instead of being offered for
  exclusion, and the company commit (and its AI-generated message, from the
  staged `--name-status`) never contains a private path (unstaged after every
  add + the hold-back). The harness checks every company commit message and
  `.gitignore` (`assertPrivacy`). Private paths appear only in the member's
  local console log, which is not sent anywhere.
- **Without an answer from /me/scopes** (offline, server error) the last
  cached answer applies: its readable paths stay excluded and nothing is
  deleted or handed over. With no cache at all (never synced since 3b) a new
  path at a private folder's name is still checked by `paths/check` when the
  server answers, and otherwise refused by the server (`[RESERVED_PATH]`) and
  recovered — it never lands in the company repository. A reader's existing
  `info/exclude` block is kept when the cache is missing.
- `shared/package.json` is `"type": "module"`: the client imports the
  contract (`../../../shared/types/private-folders`) directly, and tsx
  (harness) could not see named exports of a CommonJS-typed TypeScript file.
- **Version gate**: `PRIVATE_FOLDERS_CLIENT_COMMIT_DATE` in
  `server/src/lib/client-version.ts` is the committer date (UTC) of this
  stage's merge commit on main.
- Deferred: partial clone / folder exclusions *inside* a private folder;
  moving a private folder; nested-repository exclusions in
  `.git/info/exclude` instead of the shared `.gitignore` (owner decision
  pending — it changes behaviour for every member and the characterization
  transcript, so it gets its own change).

---

## Architecture: Choice prompts (the AI asks, the member picks)

The chat can ask the member a multiple-choice question and continue with the
answer, for both agents. Shared types and the answer mapping:
`client/shared/choice-prompt.ts`; agent glue: `client/electron/agents/choice-tools.ts`.

- **Claude Code**: the built-in `AskUserQuestion` (input `questions[]` of
  `{ question, header, options[{ label, description }], multiSelect }`). The
  CLI routes it through `canUseTool` in **every** permission mode —
  bypassPermissions too (`requiresUserInteraction`), even after a PreToolUse
  allow — so `claude.ts` installs `canUseTool` whenever the turn can show a
  card (in bypass it refuses everything else, as before). Answer = `allow`
  with `updatedInput: { ...input, answers }`, `answers` keyed by **question
  text**, multiSelect labels and 「その他」 text joined with `", "` (verified
  against CLI 2.1.304). No answer = `deny` with a message telling the model not
  to guess or re-ask.
- **Codex**: no native equivalent we can drive, so the app serves `ask_user`
  (same input shape) from a request-scoped loopback MCP server `acb_ask`
  (`tool_timeout_sec` 660), and the developer instructions tell Codex to use
  it. The turn's 15-minute limit is paused while the member answers.
  (Codex's own `item/tool/requestUserInput` keeps its older card.)
- Flow: `chat-server.ts` `createAskUser` → `requestInteraction`
  (`AgentInteractions`, kind `choices`, per renderer + conversation; 10-minute
  timeout; a stopped turn or closed window → cancelled with a reason) → the
  card above the composer (`ChoicePrompt.tsx`: radio / checkboxes, 「その他」
  with text, 「回答する」, ⌘/Ctrl+Enter). The outcome is also pushed into the
  response as a `data-choice-prompt` part (`createChunkInjector`): the
  transcript renders it collapsed with the answer as the member's bubble, chat
  history stores it as `choicePrompts` (with `at`, the offset in `content`, so
  it is restored in place), and `agentInputMessages` turns it into text when
  the conversation moves to another agent.
- The D5 / dangerous-command approval banner (`tool-approval-request`) is a
  separate channel; both can be on screen at once. Pending cards survive tab
  switches (all tabs stay mounted); closing the tab cancels them.
- Preview: `client/tests/choice-prompt-ui.html` (`?theme=dark`,
  `?state=answered`); tests: `client/tests/choice-prompt.test.ts`.

---

## Architecture: Composer — instructions while the AI works, next-prompt suggestions

**Extra instructions while the AI works (steering)** — `client/shared/steer.ts`,
`client/electron/agents/steering.ts`, `client/electron/chat-turns.ts`:

- While a turn runs the input stays enabled and sending no longer stops the
  AI. The renderer posts `POST /api/steer { appSessionId, text }`; the chat
  server hands it to the turn's `TurnSteering`, the agent takes it, and the
  instruction is shown at that point of the reply as the member's bubble
  labelled 「作業中に追加した指示」 (`data-steer` part; history
  `steerInstructions` with `at`; `agentInputMessages` turns it into text).
- **Claude Code**: the app already runs with `streamingInput: 'always'`;
  `onQueryCreated` gives the SDK `Query`, and each instruction is a streamed
  user message with its own uuid (`query.streamInput`, started lazily — when
  that iterable ends the SDK closes the CLI's stdin, so it ends only with the
  query). The CLI folds it in at the next step boundary. Whether it was read
  comes from `command_lifecycle` frames (`started`) and `result.user_message_uuids`
  (CLI advertises `msg_lifecycle_v1` in init `capabilities`; without it the
  instruction counts as delivered). The provider stops at the first `result`,
  so a too-late instruction is `not-delivered`: `cancelAsyncMessage`, and when
  the CLI already started it as its own turn (it does, right after the
  result) that unseen turn is `interrupt`ed so it runs no tools; the renderer
  removes the bubble and sends the text as the next normal message (the CLI
  transcript then holds it twice — harmless). The SDK `Query` is observed by
  `tapQuery` (wraps `[Symbol.asyncIterator]`, the provider's own iteration),
  composed with the usage/progress tap (`tapSdkMessages`) in one
  `onQueryCreated` — never let one replace the other.
- **Codex**: `turn/steer { threadId, expectedTurnId, input }` while the turn
  is active; an error = `not-delivered`.
- **Fallback**: api-key mode, attachments/images, slash commands (`/…`), no
  attached turn yet, or `unavailable`/`not-delivered` → the message waits
  (「応答が終わったら送ります：…」 above the input, 取り消す puts it back in
  the input) and all waiting messages go out together as one message when the
  turn ends. After a stop or an error they go back into the input instead.
- Choice prompts, D5 approvals, the write guard and the private-read guard
  are unchanged (they already ran under streaming input); verified live with
  CLI 2.1.304 (AskUserQuestion round-trip, Write approval through
  `canUseTool`, hooks).

**Next-prompt suggestions** (Claude Code only) — `client/shared/prompt-suggestion.ts`,
`client/src/components/chat/promptSuggestion.ts` (rules) + `ghostSuggestion.ts` (CodeMirror):

- `promptSuggestions: true` + the provider's `onPromptSuggestion`. The CLI
  sends `prompt_suggestion` ~1 s *after* the result — after the UI stream has
  closed — so the renderer asks `GET /api/prompt-suggestion/:appSessionId`
  after a finished (not stopped/failed) turn; it waits up to 15 s. The CLI
  stays silent on a conversation's first reply without tool use (it needs two
  assistant messages), when nothing is obvious, after errors, or when the
  member set `promptSuggestionEnabled: false` (user settings apply). The app
  spawns it with `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true`: otherwise it
  also stops near the plan's usage limit (`allowed_warning`), which made
  suggestions never appear for a heavy user. The terminal CLI's "unused
  streak" back-off does not apply to SDK sessions. The chat server logs
  whether a suggestion came (`[chat-server] Prompt suggestion: …`, never its
  text).
  The session-recovery wrapper (`agents/recovery.ts`) must not abort the
  native model when its stream ends normally: the provider keeps reading
  after closing the stream, and that abort killed the CLI before the
  suggestion — every resumed turn (2nd reply on) silently had none.
- Settings → 入力候補 「次の質問の候補を表示する」 (`src/lib/promptSuggestionSetting.ts`,
  localStorage, on by default): off → the renderer sends
  `promptSuggestions: false` with each chat request, the chat server opens
  the turn without a suggestion slot, and the CLI is not asked to make one
  (no extra request against the plan's usage).
- Shown as light ghost text in the empty input (it replaces the placeholder),
  only while idle with no card/approval waiting. → or Tab (caret at the end,
  no modifiers) puts it into the input; Enter stays a new line and ⌘+Enter
  sends. Typing along the suggestion keeps the rest visible; anything else, or
  Esc, dismisses it for good. One suggestion per turn (the CLI sends at most
  one), so no cycling. Screen readers get it through `aria-describedby` + a
  polite live region.
- Preview: `client/tests/chat-composer-ui.html` (`?theme=dark`,
  `?suggestion=…`); tests: `client/tests/prompt-suggestion.test.ts`,
  `client/tests/steering.test.ts`.

---

## Architecture: Chat history store and rendering performance

**History store** (`client/electron/chat-history-store.ts`, main process): one
JSON file per company (`<userData>/chat-history/<companyId>.json`, the same
`{ sessions, deletedSessionIds }` format as always, now written compact;
unknown top-level keys are kept, so older app versions still read it).

- Reads come from an in-memory copy, loaded once and reloaded only when the
  file's identity (inode, size, mtime) changes while nothing is pending.
  Sessions are replaced, never edited in place (callers may hold them).
- Writes are coalesced (250 ms) and asynchronous: the new version is written
  and fsynced as a temporary file off the main thread, then on the main thread
  the current file becomes `.bak` by a hard link (copy where links fail — no
  re-read) and the temporary file is renamed over it. A deletion writes at
  once and replaces `.bak` with the new content (deleted conversations never
  linger there). A failed write is retried every 5 s and the next save/patch
  retries synchronously and reports the error. `flushSync()` runs on
  `will-quit`. A save is acknowledged before it is on disk; the file on disk
  is always a complete version. Measured on an 8.3 MB history: a save blocked
  the main process 124 ms, now 0.2 ms.
- IPC: `chatHistory:getSummaries` (no message bodies — the sidebar and the
  tabs' title check; 8.1 MB → 31 KB), `chatHistory:search` (body search in the
  main process, NFKC), `getSession`; save/flush return a receipt
  (`ChatSaveReceipt`: status + revision), not the stored conversation.
  `chatHistory:changed` carries `{ sessionId, kind: save | patch | delete }`:
  a tab re-reads only a `patch` of its own conversation.
- Autosave runs every 4 s (unload and leaving a tab still flush
  synchronously) and skips building the session when nothing it is made of
  changed; converted messages are cached per UIMessage object.
- Attached images: the AI gets the full image; the bubble and history keep a
  ≤320 px WebP thumbnail (`historyThumbnail.ts`). Old full-size data URLs load
  as before.
- Tests: `client/tests/chat-history-store.test.ts`.

**Rendering** (`client/src/components/chat/`):

- `MessageList` renders the latest 50 messages (`messageWindow.ts`, anchored
  by message id so streaming messages append); 「以前のメッセージを表示」 adds
  50 more and keeps the scroll position. Messages older than the latest 20
  use `content-visibility: auto`. Hidden tabs use `content-visibility:
  hidden`; `ChatPanelChat` is memoised with stable props.
- Markdown is rendered per top-level block (`markdownBlocks.ts`; split only
  at blank lines outside fences before a non-indented, non-list line; the
  whole reply stays one block if it has link/footnote definitions), so a
  streaming reply re-parses only its last block; an unclosed code fence is
  shown plain until it closes. The stream throttle is 150 ms once a reply
  passes 8,000 characters.
- Syntax highlighting is PrismLight with a curated language set
  (`codeHighlighter.tsx`: ts/tsx/js/jsx, python, bash/sh/zsh, json, yaml,
  markdown, html/xml, css/scss, sql, diff, go, rust, java, kotlin, swift,
  c/cpp/csharp, ruby, php, powershell, toml, ini, docker, graphql); other
  languages render plain. Renderer bundle 2.48 MB → 1.97 MB.
- Per-turn tool payload cap (`electron/ui-stream-limits.ts` `turnBudget`):
  after 2 MB of tool inputs/outputs in one turn (api-key mode 8 MB), later
  payloads are cut to 1 KB and input deltas stop; rows, states, errors, the
  answer text and data parts are untouched.
- Preview: `client/tests/chat-header-ui.html?history=long` (a restored
  240-message conversation); tests: `client/tests/chat-rendering.test.ts`.
