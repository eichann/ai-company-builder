# CLAUDE.md - AI Company Builder

AI Company Builder (ACB) lets non-engineers share files, folders and AI skills across a company.
Git runs behind the scenes; members press one sync button. The desktop app embeds Claude Code /
Codex as a chat that works in the member's checkout of the company repository.

<!--
Maintainer note (stripped before it reaches Claude's context):
- This file holds only what every session needs. Area rules live in `.claude/rules/*.md` with
  `paths:` frontmatter and load only when Claude reads or edits a matching file. Keep each file
  under 200 lines; put long rationale and incident history in docs/architecture/ (internal,
  untracked, owner's machine only).
- The 2026-10-24 restructuring (PR #186) moved the old 1,663-line file; the PR body has the
  section-by-section mapping, and docs/architecture/README.md keeps a copy.
-->

## Project map

```
server/   Hono API + git smart-HTTP server (port 3001). SQLite via better-sqlite3.
  src/routes → services → ports ← adapters, wired in src/composition.ts; lib/ (git, push-check)
admin/    Next.js admin console (port 3100), production build in Docker.
client/   Electron desktop app (renderer on Vite, port 5173).
  electron/            main process: main.ts (composition root), features/<domain>/ipc.ts,
                       services/, sync/ (git:sync), agents/ (Claude Code, Codex), guards
  shared/              types + pure helpers used by main, preload and renderer
  src/                 React renderer; moving to features/<name>/ (components/, hooks/, lib/ are
                       legacy: renderer-structure rule)
  tests/               node tests (*.test.ts), sync-harness/ + sync/, ui/ (Playwright), perf/
shared/   core/ = the one copy of path, name and permission rules; types/ = API contracts
data/     SQLite databases and repositories at runtime (gitignored)
```

Area rules (load automatically when you touch matching files):
sync, sync-guards, sync-testing, download-choices, push-check, private-folders,
private-folders-client, chat-and-agents, chat-ui-and-history, chat-write-guard, company-files, approvals,
web-research, agent-sandbox, plugins, agent-events, agent-stop, ipc-and-main-process, files-and-editor, renderer-structure,
commands, server, records, google-connector, minutes,
shared-core, testing, deployment
(all in `.claude/rules/`). If you change an area without having opened its files yet, read the
matching rule file first.

Long-form background (incidents, measurements, rejected alternatives) is in
`docs/architecture/*.md`. That folder is internal and exists only on the owner's machine; when it
is missing, the rule files are the complete working instructions.

## Vocabulary

- **Company repository** — one bare repo per company on the server (`data/repos/<id>.git`); each
  member's company folder is a clone of it. **Department** — a root folder of it (DB rows add
  display settings only). **Skill** — `.claude/skills/<name>/SKILL.md` (+ tools), shared by sync.
- **Sync** — the app's one button (`git:sync`): commit, `pull --rebase`, push, with automatic
  conflict handling; the server's version wins and the member's is saved to `.backups/`.
- **Private folder** — a folder only some members can read; its own "scope repository", cloned
  inside the company folder for readers, its path reserved in the company repository.
- **Not downloaded** — a folder the member left out (sparse checkout, possibly a partial clone):
  visible in the app, not on disk, and nothing may be written there.
- **Push checker** — the server's pre-receive hook (`server/src/lib/push-check/`); its rejection
  markers (`[WRITE_DENIED]`, `[PROTECTED_CONFIG]`, …) drive the app's automatic recoveries.
- **Roles** — `owner` and `admin` have full access; `member` follows per-folder rules (scopes)
  for read/write. Any member can also be a **department manager** (`department_managers`), which
  allows managing that department's private folders and AI instruction files.

## Commands

```bash
pnpm install                 # Node 20+, pnpm 9+ (pnpm only: the lockfile and overrides are pnpm's)
pnpm dev                     # Electron client
pnpm dev:server              # API on :3001 (or: cd server && pnpm dev)
pnpm dev:admin               # admin on :3100 with hot reload
pnpm typecheck               # all packages (CI runs this on every PR)
pnpm lint                    # all packages; CI lints changed files only

cd client && npx tsx --test tests/<name>.test.ts          # one client test file
cd client && npx tsx --test src/features/<f>/<name>.test.ts  # one renderer test (next to its code)
cd client && npx tsx --test tests/sync/<name>.test.ts     # one sync-harness file
cd client && npx playwright test <spec>                   # one renderer UI spec
cd server && npx vitest run tests/<path>                  # one server test file
cd admin && npx vitest run                                # admin tests (seconds)
```

Run the tests for the files you touched, not whole suites. The development machine is shared and
the full client, sync-harness and UI suites take many minutes; CI runs them on every PR (macOS
runners for the client). If you start a dev server, Vite preview or watcher, stop it when done.

Environment: copy `.env.example` to `.env`; `AUTH_SECRET` (`openssl rand -base64 32`) and
`PUBLIC_URL` are required. `docker compose up -d` runs the full stack (see the deployment rule).

## Principles that hold everywhere

- **Sync must never lose a member's work.** Members have no terminal and no Git vocabulary, so
  anything sync cannot resolve stops with the local work intact, or asks in plain Japanese.
  Every sync change gets a harness scenario. → `.claude/rules/sync.md`, `sync-guards.md`
- **The server is the authority.** Client checks (chat write guard, file-operation refusals,
  path checks) exist for a good experience; the push checker and API decide. A client check may
  allow when unsure (offline), the server must not. → `push-check.md`, `chat-write-guard.md`
- **Private folder names never leak** to someone who cannot read the folder (owner decision B):
  not in API answers, error messages, the company repository, commit messages or `.gitignore`.
  → `private-folders.md`, `private-folders-client.md`
- **`shared/core` depends on nothing** (no Node built-ins, packages, Electron, React, Hono,
  database or git), so the server, app and admin apply one copy of each rule. A rule change is
  made there. → `shared-core.md`
- **Electron is imported only in the shell layer** (`main.ts`, `preload.ts`,
  `electron-adapter.ts`, `voice-input.ts`); features and services get ports injected, so another
  desktop shell can replace it. ESLint enforces this. → `ipc-and-main-process.md`
- **App modules point one way too** (`client/tests/architecture-boundaries.test.ts`, over the
  whole tree): `client/shared` is pure (imports only itself and `shared/`; `client/shared/commands/` also
  zod); `electron/agents/`
  never imports the shell, `chat-server.ts`, features, services or sync — the host injects what
  an agent needs (`AgentHostConfig`); one agent's implementation (`agents/claude`, `codex*`,
  `anthropic-api`) is reached through `agents/registry.ts` (exceptions: `main.ts`, that agent's
  `handoff/` module); agent ids are compared only inside the agent modules (the per-agent UI
  and a few named legacy spots are listed exceptions, each with its reason). New code goes where
  its layer is; widen an exception only with a reason the owner would accept.
- **Agents and models come from the registry** (`client/shared/agents/registry.ts`, factories
  in `client/electron/agents/registry.ts`): callers ask `capabilities` instead of branching on an
  agent id, and every model id lives there (a test fails on a literal elsewhere), so adding a
  vendor or a model generation touches a handful of files. → `chat-and-agents.md`
- **Security guards are tested; keep them.** Each guard in the rule files names the test that
  fails without it. If a guard seems to be in the way, raise it with the owner rather than
  weakening it — each one exists because of an observed failure.
- **A test must guard something** (all packages): it protects a behaviour you can name, fails
  when that code is removed, survives a behaviour-preserving refactor, and is not already
  guaranteed by types or another test. No tests of pass-throughs or of fakes returning what they
  were given. → `testing.md` ("What a test is for")
- **Server layers point one way**: routes (HTTP) → services (rules) → ports ← adapters; only
  `src/composition.ts` imports adapters (`tests/unit/layering.test.ts`). → `server.md`
- **Server request handlers stay async.** No `execFileSync` / `spawnSync` in `server/src`
  (`tests/security/no-exec-sync.test.ts`): one synchronous git call froze every company's
  requests for 42 s. → `server.md`
- **Wire formats are contracts.** Push rejection markers (`[WRITE_DENIED]`, …), their line
  shapes, and the IPC contract are parsed by released apps; change them only together with a
  compatible client path. → `push-check.md`, `ipc-and-main-process.md`

## Conventions

- TypeScript everywhere. User-facing text is Japanese, written for non-engineers (no Git terms);
  code, comments, identifiers and commit messages are English.
- Department folder names may contain Japanese; skill folder/file names are ASCII
  `^[a-z0-9][a-z0-9_-]*$`. Both rules live in `shared/core/names.ts`.
- Paths are compared as NFC with only A–Z case-folded (`pathKey` in `shared/core/paths.ts`),
  matching what the push checker does bytewise; use the core helpers rather than ad-hoc
  `toLowerCase()`.
- Log through the existing tagged loggers (`log.warn('Git sync: …')`, `[chat-server] …`), not
  bare `console.log`. Never log session tokens, file contents, the AI-generated commit message, a
  prompt suggestion's text, or (on the server) the paths a member sends to `paths/check`.
- Prefer dependency injection over module state (sync's `SyncDeps`, the features' ports): it is
  what lets the sync harness and IPC harness run the real code under plain Node.

## Workflow

- Branch from the latest `origin/main`; one topic per PR. Commit subjects follow the history's
  style: `type(scope): summary` (`fix(client): …`, `refactor(shared): …`, `ci: …`).
- Open a PR and wait for **all** CI checks (`gh pr checks <n>`; make sure checks exist before
  reading them as green). The owner merges; don't enable auto-merge.
- CI (`.github/workflows/ci.yml`): typecheck and changed-file lint always run; on PRs the other
  jobs run only when their inputs change (`.github/scripts/changed-areas.sh`; a skipped job
  reports success). Required for merge: Typecheck, Lint (changed files), Server tests, Client
  tests (macOS), Sync harness (macOS); the UI, perf, universal-git and admin jobs should be green
  too. The nightly run (and a manual run) execute everything; a push to main runs the
  Linux jobs only (typecheck, lint, server, admin) because its PR already ran the macOS ones.
- `docs/` holds internal notes and stays uncommitted: this is a public (AGPL) repository, and
  `.git/info/exclude` ignores `/docs/*` except the published `docs/self-hosting/` and
  `docs/images/` (a few older notes are still tracked; leave them, add no new ones). Durable
  knowledge goes into these rule files (or the owner's memory notes), not into new tracked docs.
- Use the commit / PR attribution lines the harness provides; this file adds none of its own.
- `.claude/settings.json` runs `.claude/hooks/check-edited-file.sh` after every Edit / Write:
  ESLint on that file and, for app code, the boundary test (a few seconds). When it reports a
  problem, fix the code rather than the check.
- When you change behaviour described in a rule file, update the rule in the same PR, and keep
  the code comments that point to a rule file accurate.

Before calling a change done: run the tests of the files you touched, typecheck the packages
you touched (`pnpm --filter <client|server|admin|shared> typecheck`), make sure anything you
started (dev servers, Vite preview, watchers, temp harness worlds) is stopped, and check that
the rule files you relied on still describe the code.
