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
`sync/first-setup.ts` (first setup, below), `sync/outside-checkout.ts`, `protected-config.ts`. Every change to sync runs through the multi-member
harness — see "Testing Sync" below.

```
0. Serialize per repository (syncLocks)
1. Recover from stale rebase / merge / cherry-pick state; declare
   `.gitignore merge=union` in `.git/info/attributes` (idempotent)
2. Retry a PENDING_PUSH left by a previous failed sync
3. Ensure .gitignore essentials (.backups/, .workspace/, node_modules/, .env*,
   **/.personal/* with !**/.personal/.gitignore)
4. Scan for >100MB files → append to .gitignore
5. Detect nested Git repositories → ask the user BEFORE modifying anything
6. git fetch --progress origin
6.5 Hold back files created inside excluded (not checked out) folders →
    .backups/<ts>_outside_checkout/ (never staged, never shared)
7. Reconcile sparse checkout against the user's persisted exclusions
   (ignored files in excluded folders are kept out of git's reach meanwhile)
8. Warn if files were deleted locally (sync / restore / cancel)
9. git add --sparse . → git commit → record localHash
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
    └─ Rejected with PROTECTED_CONFIG and/or WRITE_DENIED → ask the member
         (one dialog per section, both before anything changes); on "restore":
         first squash the unpushed commits (no file changed) → push;
         only if still rejected: back up their version → reset --soft
         origin/main → put the still-listed paths back to the server
         version (protected first, then write-denied; an exact move into a
         denied folder is moved back) → commit → push again, once
```

### First Setup: Download Only the Picked Departments (partial clone)

A member setting up a company in a **fresh folder** (no local commits) picks
their departments first (`CompanySelector` →
「所属する部署を選んでください。他の部署はあとから設定でダウンロードできます」);
`git:setupCompanyRemote` then runs `checkoutSelectedDepartments`
(`client/electron/sync/first-setup.ts`): `fetch --filter=blob:none` (commits
and trees only) → persist the sparse exclusions (the departments *not*
picked) and set the cone → check out, which downloads just the cone's blobs
in one batch. The cone is the usual exclusion model: every root folder
(dotfolders such as `.claude` included) and root file, minus the unpicked
departments. Nothing picked → full clone as before. Existing clones are
never converted (no migration).

- Server: `configureBareRepo` sets `uploadpack.allowFilter` and
  `uploadpack.allowReachableSHA1InWant` (`server/src/lib/git-server/repo-config.ts`).
  git-http does not forward `Git-Protocol`, so upload-pack speaks v0, which
  refuses every lazy fetch (a want that is not a ref tip) without the latter;
  "reachable" is what a full clone already serves, `allowAnySHA1InWant` is
  not needed.
- Later fetches keep the filter (`remote.origin.promisor` /
  `partialclonefilter`). A blob outside the cone that git needs — a rebase
  replaying over a teammate's rename, restoring a server version, adding a
  department in settings, `git log -p` — is fetched lazily by git itself,
  authenticated through the environment `createGit` sets (`GIT_ASKPASS` +
  `GIT_TOKEN`, inherited by git's own `fetch` child). The token is still
  never written to disk, so git run **outside the app** (a terminal, or the
  chat agent running `git log -p` / `git show` over another department) cannot
  authenticate a lazy fetch: that command fails with an auth error and
  changes nothing; files and git commands inside the downloaded departments
  are unaffected.
- Adding a department in settings (`setSparseExclusions`) downloads it.
  Offline, `sparse-checkout set` fails and rolls its patterns back, and
  `applySparseSelection` writes the previous exclusions back, so cone,
  worktree and config stay as they were and the panel shows
  「インターネットにつながっているときにダウンロードできます」. Sync offline
  fails exactly as for a full clone (commit stays local, `PENDING_PUSH`).
- A department a teammate creates later appears automatically, as for every
  sparse checkout (cone = all root folders − exclusions).

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
| `merge.stat=false` | A pull that fast-forwards prints a diffstat, which reads every file the teammates changed. In a partial clone those blobs were never downloaded, so every sync silently fetched the teammates' changes in departments the member did not pick (found by the partial-clone harness). Nothing reads the diffstat. |
| Sparse cone changes use one `sparse-checkout set --cone <dirs>` (never `init --cone` + `set`), and a failed change writes the previous exclusions back (`applySparseSelection`) | In a partial clone, widening the cone is a download. `init --cone` alone narrows the worktree to the root files; if the following `set` then failed offline the member's folders vanished from disk. A single `set` rolls its own patterns back on failure, and restoring the config keeps the next sync from retrying a choice that was never applied. |
| Files created inside a folder that is **not checked out** (in the persisted sparse exclusions and outside the applied cone — excluded in settings, or not picked at first setup) are never staged: before the sparse reconcile and before `git add --sparse .`, every non-ignored file there that is new or differs from its index entry is moved to `.backups/<ts>_outside_checkout/` (`_metadata.json`: reason `outside_checkout`, `folders`, `files`, `serverFiles` = those the server has), the skip-worktree bit of tracked paths is set again (`update-index --skip-worktree`, so they never read as deleted) and the emptied folders are removed (`holdBackOutsideCheckout`, `client/electron/sync/outside-checkout.ts`). The result carries `outsideCheckoutFiles` / `outsideCheckoutBackupPath` and the message 「ダウンロードしていないフォルダ（営業部）にファイルが作られていたため、共有せずに .backups に保存しました（N件）。必要ならその部署をダウンロードしてから保存し直してください。」. If the check itself fails, sync stops before staging with every file in place. Paths the server does not have are held back too, and so is an edit made before the member excluded the folder (git leaves a modified file behind; it cannot be told apart) | The folder is absent on disk, so the member — and the chat AI working in their checkout — cannot see the teammates' files there. A file written at `営業部/提案書.md` landed on a teammate's path the member never had: git clears the skip-worktree bit of a path whose file appears, `git add --sparse .` staged it, and sync silently replaced the teammate's file on the server — no conflict, no backup for anyone (found by the outside-checkout harness, full and partial clones alike). A new path was shared, and at the next sync the reconcile removed it from the member's disk (tracked, clean, outside the cone): the file vanished right after being "saved". Sync cannot tell whether a teammate has, or is about to push, the same path, so nothing is shared from there; inside the checkout nothing changed. It runs before the reconcile because `sparse-checkout set` with a changed file on a not-checked-out path downloads the teammate's version in a partial clone. |
| Every `sparse-checkout set` the app runs (`applySparseSelection` → `keepIgnoredOutsideCone` in `client/electron/sync/sparse.ts`) first moves the ignored files of each tracked root folder outside the new cone (`ls-files --others --ignored --exclude-standard --directory`, outermost entries only) to `.git/acb-sparse-keep/` and puts them back afterwards, also when `set` fails; a leftover from a crash is restored before the next `set`, and an entry whose path is occupied again stays there rather than being overwritten | In cone mode `sparse-checkout set` deletes every ignored file in a tracked directory that leaves the cone (documented git behaviour), and sync runs it on every press: a member's `.personal/` notes, `.env` files and auto-ignored large files inside an excluded department — local only, never on the server — were deleted when the department was excluded in settings and at every later sync (found by the outside-checkout harness). |
| Conflict resolution is a **loop**, not a single round | A rebase replays commits one at a time and pauses on *every* conflicting pick. The original single-round code fell back to `rebase --skip`, which silently discarded a whole commit the moment a second pick conflicted. |
| Conflicts are classified by stage-2 presence before anything is resolved (`classifyConflicts` in `client/electron/sync/conflicts.ts`) | `git checkout --ours` reads stage 2 of the index, which a modify/delete conflict (server deleted a file the member had edited, status `DU`) does not have — and the command fails **atomically**, so every other path in the same call stays unresolved too. The exception escaped both the conflict loop and its `catch (pullError)`, so sync returned an `unknown` error with the rebase still in progress; every retry aborted the stale rebase and died at the same pick. A pilot user was left permanently unable to sync — commits safe locally, but nothing reaching the team. Triggered whenever the server deletes a file, or moves one while also rewriting it (rename detection misses below the similarity threshold). |
| `rebase --skip` only when the pick is genuinely empty | Taking the server version can leave a pick with no content of its own — that is the only case where skipping is correct. For any other stall, abort and surface the error. Guessing with `--skip` destroys user commits. |
| Rebase detection uses the `rebase-merge` / `rebase-apply` directories | `REBASE_HEAD` is just a ref and can linger after a rebase has finished, so it reports in-progress rebases that do not exist and misses recovery. |
| `syncLocks` registers the run **before** awaiting the previous one | Registering afterwards let two queued clicks wake together and run concurrently against the same repository. |
| Nested-repo handling asks the user **before** any mutation | The pre-consent version ran `git rm --cached -rf` and appended to `.gitignore` first, untracking an entire shared folder and surfacing as a "653 files deleted" warning even though nothing had left the disk — and cancelling did not roll it back. A folder that is already shared offers "remove the inner .git and keep sharing" as the default. |
| Server bare repos set `receive.denyNonFastForwards` and `receive.denyDeletes` (`configureBareRepo` in `server/src/routes/git.ts`, applied at creation and on startup to all repos) | Shared history is the team's only copy. Without these, one client's force push erases everyone's work. This was a near miss — only an auth failure stopped a `push --force-with-lease` from a diverged client. |
| `.gitignore` files merge with git's built-in `union` driver: sync writes `.gitignore merge=union` into the repository-local `.git/info/attributes` (idempotently, before any rebase; `client/electron/sync/gitignore-merge.ts`). After a rebase that replayed commits, the duplicate lines the merge added to the `.gitignore` files about to be pushed are removed in one extra commit — only copies beyond what either side had, and never a pattern with an opposite (`!`) line between it and the copy kept | Sync appends lines to `.gitignore` itself (nested-repo and large-file exclusions, the essential patterns). When two members changed `.gitignore` concurrently the rebase conflicted on it and "server wins" dropped the member's side, sync's own lines included: the member was asked about the same nested repo again and concurrent syncs did not converge (found by the sync harness soak). `.git/info/attributes` is never committed (nothing is changed in the company repository on the member's behalf), does not depend on global git config, outranks any committed `.gitattributes`, is read by every pick of `pull --rebase` / `rebase --continue`, and a slash-less pattern covers `.gitignore` at any depth. Trade-off: union keeps both sides of an overlapping hunk, so a line one side deleted right next to the other side's change comes back — a path stays ignored that someone wanted shared, which loses nothing and can be removed again. Every other file keeps "server wins". |
| Every push decision lives in one TypeScript module, `server/src/lib/push-check/` (rules in `rules.ts`, messages in `report.ts`, write policy in `policy.ts`). `server/src/templates/pre-receive-hook.sh` is a thin caller: it pins `export LC_ALL=C`, runs `entry.ts` with the server's node and tsx loader (absolute paths baked in by `lib/git-server/hook.ts`, re-rendered at every API startup, so a change needs a restart) and **fails closed**: any exit other than accept/reject, including the checker not starting, rejects with `[HOOK_ERROR]` (the client retries via `PENDING_PUSH`). The checker handles git output as byte strings (latin1) so matching stays bytewise with A–Z-only case folding, exactly like the shell tools under `LC_ALL=C`. The old shell hook is kept at `server/tests/fixtures/pre-receive-hook.legacy.sh`; `push-check-differential.test.ts` feeds a corpus through both and requires identical stdout/stderr/exit status | The shell hook's "paths that differ only by case" check (`tr \| sort \| uniq -d`) followed the locale it inherited: under `LANG=en_US.UTF-8` on macOS, sort/uniq treat distinct Japanese names as equal and ordinary pushes were rejected with `WINPATH_DETECTED`. Bytewise, every host behaves like the production container: A–Z folds, non-ASCII case pairs (`Ａ`/`ａ`, `É`/`é`) do not — as production never did (`hook-locale.test.ts` pushes under UTF-8 locales). Old clients parse the messages, so the port changed no byte of them. |
| Only owner/admin may change agent-execution config: the pre-receive hook rejects with `PROTECTED_CONFIG` any push in which some commit adds, modifies, deletes or renames `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, anything under `.claude/hooks/`, or a file/symlink named `.claude` — at any depth, case-insensitively. The role comes from `memberships` via `ACB_PUSHER_ROLE`, set server-side in `git-http.ts`; a missing role fails closed for these paths only | The chat runs Claude Code in the shared checkout with `settingSources: ['user', 'project']`, and in non-interactive mode it runs a project `UserPromptSubmit` hook and starts a `.mcp.json` stdio server **without any prompt** (verified with the real CLI). `settings.json` also carries `statusLine`, `apiKeyHelper`, `env` and permission rules. Sync shares nearly everything, so any member could run arbitrary commands on every teammate's machine at their next chat message. Distribution itself is legitimate (an MCP server shared via `.mcp.json` is in production use), so the rule restricts *who*, not *what*. Skills (`.claude/skills/`) are not path-protected — sharing them is the core feature; only their auto-run parts are (next row). |
| Skills, subagents and slash commands (`.md` under `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, any depth, case-insensitive) may be added or changed by anyone **unless the new blob contains an auto-run part**: frontmatter key `hooks`, `mcpServers` (or the plugin-style `lspServers` / `monitors`) in any YAML spelling (quoted, flow, escaped, anchored, nested), a body `!` + backtick opener where the `!` starts a line or follows whitespace, or a ```` ```! ```` block — or the entry is a symlink. Then only owner/admin may push it, with the same range logic, role source and fail-closed rules as the row above, reported in the same `PROTECTED_CONFIG` section (path line, then a reason line that does not start with `- `). Deletions are always allowed. The content check runs inside the push checker; if the contents cannot be read — or `ACB_NODE` (set in `git-http.ts`) names a runtime that cannot run — every changed path in those folders is rejected for non-admins | Claude Code executes these without the model choosing to: a skill's or command's frontmatter `hooks` are registered when it loads, a subagent's inline `mcpServers` are spawned when it runs, and `` !`cmd` `` / ```` ```! ```` are run while the skill or command is expanded — inside fenced code too (only single-line inline code is masked, and substituted arguments can re-pair those backticks, so the hook does not mask at all). Skills can also auto-load by `paths`, and their own `allowed-tools` pre-approve those commands. Text that is not the syntax (`` `!` ``, `!important`, `if ! grep`, prose mentioning hooks) passes. A symlink's target is outside what the hook inspects, and Claude Code follows symlinked skill folders. |
| A `PROTECTED_CONFIG` or `WRITE_DENIED` (no write permission for the folder) rejection is resolved by **rewriting the unpushed commits**, never by a retry or a revert commit (`client/electron/protected-config.ts`) | The rejected change is already committed and the hook checks *every* commit in the range, so a retry or a revert on top fails at the same step forever — the "permanently unable to sync" shape again. The dialog backs up the member's version, squashes the unpushed commits with `reset --soft origin/main` (refused unless `origin/main` is an ancestor of `HEAD`, or it would revert teammates' work), restores just those paths to the server's version (or removes them), and commits the rest. Before restoring, sync first pushes the unpushed commits squashed into one with every file as the member has it: a change they already undid (e.g. took the `hooks` out of a skill after the first rejection) blocks only through its intermediate commit, and restoring would discard — or, for a new skill, remove — an acceptable final version. Push is also attempted whenever commits are still unpushed, because a rejected push writes no `PENDING_PUSH` and a sync with no new edits used to report success while the commits never left the machine. |
| `.personal/` content is never shared, for anyone (owner/admin included): the pre-receive hook rejects with `PERSONAL_PATH` any push in which a commit (or the net `old..new` diff) adds or modifies a file inside a directory named `.personal` at any depth, case-insensitively. Exceptions: the `.gitignore` directly inside a `.personal/` (the server writes it when creating a company or department, and its own local-transport push must keep working), and deletions (how an already-shared file gets unshared). Sync also adds `**/.personal/*` + `!**/.personal/.gitignore` to the root `.gitignore` (`**/` because a pattern with a slash is anchored to the `.gitignore`'s directory) | Department `.personal/` folders were protected only by the `.gitignore` inside them, so a `.personal/` created by hand anywhere else synced like a normal folder and its files were shared with the whole company. Recovery differs from `PROTECTED_CONFIG`: the file is the member's private file, so sync untracks it (`git rm --cached`, kept on disk) instead of restoring a server version, after squashing the unpushed commits for the same every-commit reason. No dialog — nothing is lost. A file the server already had is deleted from the server by that commit. |
| Write permission is enforced on push: for every path a push changes (adds, edits, deletes, both sides of a rename; every new commit plus the net diff, as above) the checker evaluates `resolveAccess(pusher, path).write` (`lib/permissions.ts`; owner/admin always pass; also checked with A–Z case folded, since macOS/Windows check `Sales/x` out into `sales/`). Denied paths reject the push with `[WRITE_DENIED]` + `  - <path>` lines (same shape as `PERSONAL_PATH`). The rules reach the checker as a **snapshot** git-http writes per receive-pack request (pusher + the company's scopes and rules, 0600 temp file, path in `ACB_PUSH_POLICY`, removed when the request ends; `lib/git-server` `preparePushCheck`). A snapshot is always enforced; an unreadable one rejects with `[HOOK_ERROR]`; no resolvable pusher denies every changed path unless writing is open to everyone. The server's own pushes (department folders, company creation) carry `ACB_INTERNAL_PUSH=1` (`internalGitEnv`) and skip only the write check; git-http strips both variables from what it inherits, so a client cannot select either. A push with neither (local transport on the server host: tests, an operator) is not write-checked | The checker runs as a child of `git receive-pack` and also in the client's sync harness, where no API or database exists, so it reads no database: git-http — the code that authenticated the pusher — decides who is pushing and what the rules were at that moment. With the default seed (`everyone: read + write` on the company scope) nothing changes and no paths are even listed. Rejections are recorded in `push_rejections` from the response like every other marker (`lib/push-rejections.ts`). |

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
│   └── 2026-02-21T14-31-00-000_write_denied/
│       ├── 経理部/予算.md        ← member's version of a file in a folder they
│       │                          may not edit, put back to the server's version
│       └── _metadata.json       ← reason `write_denied`, `writeDeniedFiles`,
│                                  restored/removed paths
└── .git/
```

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
- A pre-receive hook on the server rejects pushes containing secrets; the
  client detects `SECRET_DETECTED` in the push error and lists the files.
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
- `[PERSONAL_PATH]` (any pusher, `.personal/` content) is handled first and
  without a dialog: the listed paths are untracked and the push retried; the
  result carries `untrackedPersonalFiles`. If that fails it returns
  `errorType: 'personal_path'` with `personalFiles` (no `PENDING_PUSH`).
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
  `missingObjects()` what it never downloaded. The harness's own reads in a
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
  covers files created inside excluded departments (full and partial clones); `characterization.test.ts` holds sync
  to a transcript recorded from the pre-extraction handler (re-record with
  `UPDATE_SYNC_GOLDEN=1` only for an intended behaviour change, and review the
  JSON diff); `findings.test.ts` holds regressions for bugs the harness found;
  `harness-selftest.test.ts` proves each invariant fails when sync misbehaves.
- New sync behaviour (more repositories, adoption, new rejection types) gets
  a scenario here, ending with `settleAndCheck(world)`.
  `SYNC_HARNESS_VERBOSE=1` prints every sync log line; `SYNC_HARNESS_KEEP=1`
  keeps the temporary worlds.

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
