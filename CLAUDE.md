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
- `./admin/src:/app/admin/src`

When adding new directories, update docker-compose.yml accordingly.

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

1. **List departments**: Read folders from filesystem, merge DB settings
2. **Create department**: mkdir → git add → save to DB
3. **Edit department**: git mv (if renamed) → update DB
4. **Delete department**: Confirm → rm -rf + git rm -r → delete from DB

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

Implemented in `client/electron/main.ts` (`ipcMain.handle('git:sync', ...)`).

```
0. Serialize per repository (syncLocks)
1. Recover from stale rebase / merge / cherry-pick state
2. Retry a PENDING_PUSH left by a previous failed sync
3. Ensure .gitignore essentials (.backups/, .workspace/, node_modules/, .env*)
4. Scan for >100MB files → append to .gitignore
5. Detect nested Git repositories → ask the user BEFORE modifying anything
6. git fetch --progress origin
7. Reconcile sparse checkout against the user's persisted exclusions
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
12. Department folder protection (restore folders deleted locally)
13. git push --set-upstream --progress → on failure write PENDING_PUSH
```

### Conflict Resolution Strategy

- Server version wins for conflicted files
- A file the server **deleted** follows the deletion — that is the same
  "server wins" rule applied to a file that no longer has a server version
- Local version is automatically backed up to `.backups/` before being replaced
  *or* removed, so the member's edits survive either outcome
- Non-conflicting changes are preserved via Git's native 3-way merge
- Uses `rebase --continue` (not `--abort`) to preserve auto-merged files
- `--ours` during a rebase means **upstream / server**, the inverse of its
  meaning during a merge. Do not "fix" this to `--theirs`.
- The success message reports the two outcomes separately (overwritten vs.
  deleted) and the result carries `deletedConflictFiles` alongside
  `conflictFiles`. A file that simply vanishes reads as data loss.
- Backups are extracted with `git cat-file -p <localHash>:<file>` into a Buffer.
  `git show` returns a string and corrupts binaries (pptx, png, …), which are
  exactly the files that conflict most often.

### Non-Negotiable Guards

Every item below exists because of a production failure. Removing one
reintroduces a specific, observed way for a non-engineer to lose work.

| Guard | Why it exists |
|---|---|
| `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true` on every git invocation | `rebase --continue` opens an editor to confirm the commit message. In a GUI-launched Electron app that editor is `vi` with no TTY, so it blocks forever. This froze one member's sync button on every press for ~2 months (~143MB of commits stranded locally, 2026-07-29). Git always invokes editors through its own `sh`, so `true` works on Windows too. |
| `timeout: { block: 5 * 60 * 1000 }` | Watchdog: kill any git process that produces no output for 5 minutes, so a process waiting on input that will never arrive cannot hang `await` forever. Long network transfers survive it because fetch/pull/push all pass `--progress`. |
| `http.postBuffer=524288000` | Old system git (e.g. Apple Git 2.39, still reachable via the system-git fallback) has a broken chunked HTTP push that fails even against github.com. Buffering past the 1MiB default keeps git off chunked transfer regardless of which binary resolved. |
| Conflict resolution is a **loop**, not a single round | A rebase replays commits one at a time and pauses on *every* conflicting pick. The original single-round code fell back to `rebase --skip`, which silently discarded a whole commit the moment a second pick conflicted. |
| Conflicts are classified by stage-2 presence before anything is resolved (`classifyConflicts` in `client/electron/main.ts`) | `git checkout --ours` reads stage 2 of the index, which a modify/delete conflict (server deleted a file the member had edited, status `DU`) does not have — and the command fails **atomically**, so every other path in the same call stays unresolved too. The exception escaped both the conflict loop and its `catch (pullError)`, so sync returned an `unknown` error with the rebase still in progress; every retry aborted the stale rebase and died at the same pick. A pilot user was left permanently unable to sync — commits safe locally, but nothing reaching the team. Triggered whenever the server deletes a file, or moves one while also rewriting it (rename detection misses below the similarity threshold). |
| `rebase --skip` only when the pick is genuinely empty | Taking the server version can leave a pick with no content of its own — that is the only case where skipping is correct. For any other stall, abort and surface the error. Guessing with `--skip` destroys user commits. |
| Rebase detection uses the `rebase-merge` / `rebase-apply` directories | `REBASE_HEAD` is just a ref and can linger after a rebase has finished, so it reports in-progress rebases that do not exist and misses recovery. |
| `syncLocks` registers the run **before** awaiting the previous one | Registering afterwards let two queued clicks wake together and run concurrently against the same repository. |
| Nested-repo handling asks the user **before** any mutation | The pre-consent version ran `git rm --cached -rf` and appended to `.gitignore` first, untracking an entire shared folder and surfacing as a "653 files deleted" warning even though nothing had left the disk — and cancelling did not roll it back. A folder that is already shared offers "remove the inner .git and keep sharing" as the default. |
| Server bare repos set `receive.denyNonFastForwards` and `receive.denyDeletes` (`configureBareRepo` in `server/src/routes/git.ts`, applied at creation and on startup to all repos) | Shared history is the team's only copy. Without these, one client's force push erases everyone's work. This was a near miss — only an auth failure stopped a `push --force-with-lease` from a diverged client. |

### Backup Structure

```
{company-folder}/
├── .backups/                    ← in .gitignore, local only
│   └── 2026-02-21_14-30-00.000/
│       ├── sales/proposal.md    ← local version of a conflicted file
│       └── _metadata.json       ← timestamp, reason, cumulative conflict list
│                                  (`conflictFiles` + `deletedConflictFiles`)
└── .git/
```

Backups older than 30 days are pruned at the start of each sync.

### Failure Handling

- Push failure writes `.git/PENDING_PUSH`; the next sync retries it first. The
  local commit is never rolled back — the user's work stays committed.
- Results carry an `errorType` (`network` / `auth` / `conflict` / `locked` /
  `push_failed` / `unknown`) so the UI can explain the failure in plain terms.
- A pre-receive hook on the server rejects pushes containing secrets; the
  client detects `SECRET_DETECTED` in the push error and lists the files.
- On Windows, a transient file lock during rebase (skill tool, editor, or AV
  scanner holding a file) is retried twice before being treated as a failure.
