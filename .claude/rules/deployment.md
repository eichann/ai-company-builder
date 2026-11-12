---
paths:
  - "docker-compose.yml"
  - "server/Dockerfile"
  - "admin/Dockerfile"
  - ".dockerignore"
  - "deploy/**"
  - "docs/self-hosting/**"
  - ".github/**"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "pnpm-lock.yaml"
  - "patches/**"
  - "client/package.json"
  - "admin/package.json"
  - "server/package.json"
  - "admin/next.config.*"
  - "admin/src/proxy.ts"
  - "client/scripts/universal-git.mjs"
  - "server/src/cli/company-archive.ts"
  - "server/src/adapters/company-archive.ts"
  - "server/src/adapters/sqlite/company-archive.ts"
  - "server/tests/integration/company-archive.test.ts"
  - ".env.example"
  - "staging/**"
  - "server/tests/unit/staging-kit.test.ts"
  - "server/tsconfig.staging.json"
---

# Deployment, CI and the workspace

Self-hosting guides (English and Japanese, published): `docs/self-hosting/`. Full text:
`docs/architecture/deployment.md` (internal).

## Docker Compose (`docker-compose.yml`)

- `docker compose up -d` runs `api` (port 3001), `admin` (3100), `autoheal` and its
  `docker-api-proxy`. Ports bind to
  loopback by default (`BIND_ADDR`, 127.0.0.1); use a reverse proxy (Caddy) for external access.
  OrbStack ≤ 2.2.0 cannot forward loopback-bound ports when host and container ports match —
  set `BIND_ADDR=0.0.0.0` in `.env` there.
- `api` runs the code baked into its image (`server/Dockerfile`: `server/src` + `shared`,
  `node --import tsx src/index.ts`, no watch) with a read-only root filesystem; it mounts only
  `./data:/app/data` and a `/tmp` volume. Server changes need `docker compose up -d --build api`
  (a `restart` runs the old code); hot reload is `pnpm dev:server` on the host. Why: the server
  will hold members' API keys (key broker), so whoever can write the checkout must not change
  what it runs. A new place the server writes at run time goes under `DATA_DIR`, or `/tmp` for
  scratch; anything else fails on the read-only filesystem. The image stays TypeScript + tsx on
  purpose: the pre-receive hook runs `push-check/entry.ts` with the server's node and tsx loader.
- **No root, no capabilities** (both compose files and `staging/compose.yml`): `api` runs as
  `user: ${ACB_UID:-1000}:${ACB_GID:-1000}` (the image itself ends with `USER node`, uid 1000),
  `admin` as the image's `node`; both `cap_drop: [ALL]`, `no-new-privileges:true`, read-only
  root filesystem (admin: tmpfs `/tmp` and `/app/admin/.next/cache`, `mode=1777` — compose's
  default tmpfs is root 0755). The host's `./data` and the KEK file must belong to
  `ACB_UID:ACB_GID` (`sudo chown -R`); a root-owned leftover fails with `EACCES` /
  `SQLITE_READONLY`. git's settings (`safe.directory '*'`, identity, `init.defaultBranch`) are in
  `/etc/gitconfig` (`git config --system`), because the run-time uid may have no home. Don't
  add a capability or `user: root` back without a measured need; a new image or service gets the
  same three lines. CI ("API and admin run unprivileged", "Members push and pull over smart
  HTTP") checks uid ≠ 0, `CapEff` 0, `NoNewPrivs` 1, file owners, a push + clone and the push
  checker's refusal.
- `autoheal` (restarts a container whose healthcheck fails; label `autoheal=true`) never gets the
  Docker socket — that is root on the host. It talks to `docker-api-proxy` (official haproxy,
  `deploy/docker-api-proxy.cfg`), which passes only `GET /containers/json` and
  `POST /containers/<id>/restart` and answers 403 to everything else (inspect would show
  `AUTH_SECRET`, archive the KEK, create/start = root); both sit alone on the `internal`
  network `docker-api`. Generic socket proxies (tecnativa) cannot do this: "containers + POST"
  includes create and start. Both images are pinned by digest
  (`docker buildx imagetools inspect <image>:<tag>` for a new one). CI step "Docker API proxy
  lets autoheal list and restart, nothing else".
- `admin` is a production build (`next build`, standalone server) with no source mount, because
  it is internet-facing and must not run `next dev`. Rebuild after admin changes
  (`docker compose up -d --build admin`), or use `pnpm dev:admin` on the host for hot reload.
  `/api/*` is forwarded by `admin/src/proxy.ts`, which reads `API_PROXY_URL` at run time
  (`http://api:3001` on the compose network). The admin Dockerfile copies `shared/` into its
  build stage.
- Optional key broker KEK: `BROKER_KEK_HOST_FILE` (host path, owned by `ACB_UID`, mode `0600`
  — `kek-file.ts` refuses any group/other bit, so a group-readable root file is no option —
  in a root-only folder, outside the checkout and `./data`; generated with
  `docker compose run --user 0:0 …` then `chown`, see `.env.example`) is mounted read-only at `/run/secrets/broker-kek`
  (`BROKER_KEK_FILE`); unset → `/dev/null` is mounted and the broker stays off
  (`key-broker.md`). Same in `docs/self-hosting/docker-compose.production.yml`.
  `BROKER_TOKEN_TTL_MINUTES` (15–60, default 30) sets the tokens' lifetime;
  `BROKER_MAX_REQUEST_MB` (100) and `BROKER_UPSTREAM_TIMEOUT_SECONDS` (600) bound the relay;
  `BROKER_DAY_UTC_OFFSET_MINUTES` (540, Japan) is where the daily caps' day begins;
  `BROKER_KEY_CHECK` (on; `off` for a server without internet access, and in the server tests)
  checks a key once when it is saved.
  Staging only: `ACB_ALLOW_FAKE_UPSTREAMS=1` + `ACB_FAKE_HUBSPOT_URL` (loopback, `localhost` or
  `host.docker.internal`, port only) send the broker's HubSpot requests to the practice HubSpot,
  `ACB_FAKE_GOOGLE_URL` every Google request to the practice Google and `ACB_FAKE_SLACK_URL`
  every Slack request to the practice Slack — per service, each variable redirects only its own
  (`google-connector.md`, `slack-connector.md`). `ACB_FAKE_PORTAL_URL` + `ACB_FAKE_PORTAL_HOST` (+
  `ACB_FAKE_PORTAL_SERVICE`) do the same for a contract-3 connector: a real service's host and
  service are given, never written here, and a built-in service cannot be named (`pnpm fake:portal`);
  passed through by `docker-compose.yml` only — **never add them to the production compose
  file**. The server ignores them under `NODE_ENV=production` or a non-local `PUBLIC_URL`
  (`lib/config.ts` `practiceUpstreamsFrom`, `key-broker.md`).
  The relay (`/api/broker/…`) needs outbound HTTPS from the api container. The request log
  never prints a URL or query (`lib/request-log.ts`, `server.md` "Request log"), so no relay
  token in `?key=` either.
- Plugin packages (`PLUGINS_DIR`, read-only for the api, outside `DATA_DIR`; the compose files do not
  mount it yet) come from private repositories through `server/src/cli/collect-plugins.ts`, run on
  the host or the operator's machine with `gh` signed in, against the operator's `plugins.lock`
  (fingerprint v2 per package; refuses on any mismatch). Then restart the api. Details: `plugins.md`
  "Where packages come from".
- `OPERATOR_USER_IDS` (comma-separated user ids; a signed-in operator sees theirs at
  `/api/me`) and `COMPANY_CREATION_POLICY` (`operator`) decide who creates companies after the
  first one (`server.md` "Accounts and roles"); passed through by both compose files.
- Required env (`.env`, from `.env.example`): `AUTH_SECRET` (`openssl rand -base64 32`),
  `PUBLIC_URL`. Node heap is capped (`NODE_OPTIONS=--max-old-space-size`, 2048 api / 1024 admin)
  so a slow leak restarts cleanly.
- The self-hosting production compose file is `docs/self-hosting/docker-compose.production.yml`
  (built and smoke-tested by the Docker images workflow).

## Staging kit (`staging/`, README in Japanese there)

A local staging on an FDE's Mac, one command: `pnpm staging:setup|up|down|reset|app|status|remove`
(after setup also `~/acb-staging-kit/acb-staging <command>`).

- `staging/bootstrap.mjs` keeps the kit's **own checkout** (`~/acb-staging-kit/app`, never the person's
  working copy) at the version to test, then runs that checkout's `staging/kit.mjs` (so the kit's
  scripts follow too). With the person's one local setting (`ACB_KIT_PRIVATE=<owner>/<repo>:<path>`
  or `file:<path>`, env or `~/.acb-staging-kit/config`), the **private kit config** names the main
  commit production runs (`production <sha>`) and production's `plugins.lock` (inline lines or
  `plugins-lock <path>`); without it: the public `main`, no plugins, 「追加の部品（非公開）は読み込んでいません」.
  **Nothing in this repository names a private location or carries a lock line / fingerprint**
  (owner, 2026-11-03). On every setup / up / app / reset: moved → stop, back up the databases
  (`backups/`), check out, rebuild images / app, start with the data kept, one line
  「検証環境を本番と同じ版（M/D）に更新しました」; unreadable / offline → start what is there and say so.
- **After each production deploy** the operator runs `node staging/mark-production.mjs <commit>`
  (writes only the `production` line of the private kit config, through `gh`; part of the deploy
  procedure).
- `staging/compose.yml` mirrors this compose file (read-only api image, production admin build, no
  source mounts) plus a Caddy front door on `127.0.0.1:14001` (`/api/*` → api, rest → admin: one
  origin = `PUBLIC_URL`, so auth needs no extra trusted origin), the practice HubSpot / Google /
  Slack / portal (`staging/fakes.ts`, on the host, 14010–14013, `ACB_FAKE_*_URL` via `host.docker.internal`;
  the portal stands in for what the private kit config's `portal` line names, else the public fixture's host),
  the kit's data, shelf (read-only) and KEK under `~/acb-staging-kit`; project `acb-staging-kit`.
  Ports / project / home are `ACB_STAGING_*` settings.
- Secrets (AUTH_SECRET, KEK, the practice HubSpot key, test passwords) are made once, 0600 under
  `~/acb-staging-kit`, never logged (redacting logger); passwords are shown once after setup.
  `staging/seed.mjs` makes 検証A社 through the API only (first account = owner, invitations,
  departments, private folder, records, sample tasks, practice key and Google, plugins + import).
  **Each seed step runs once** (`state.json` `done`): up / an update never re-applies it, so what
  the person changed later (a department, a switch, a plugin version) stands; `reset` starts over.
  An update moves to the target only when it carries `staging/kit.mjs` (checked before anything
  stops) and warns when the target is older. `reset` / `remove` delete only a folder holding the
  kit's marker (`secrets/compose.env` or `built.json`), never `/`, the home folder or a parent;
  compose projects must start with `acb-staging`; `remove` drops only the kit's built images.
  `staging/compose.yml` repeats the root file on purpose (ports and mounts cannot be removed by an
  override; the `ACB_FAKE_*` redirects must never be in the root file) — keep the api settings in
  step. `staging/*.ts` are typechecked with the server (`server/tsconfig.staging.json`).
  The shelf is filled by the server's collector (`staging/shelf.ts`) per repository; one without
  access is skipped by package name.
- Test: `server/tests/unit/staging-kit.test.ts` (secrets never printed and never overwritten,
  ports, private config, the follow-production hook against a local bare repository).

## One company: export and restore (`server/src/cli/company-archive.ts`)

Owner gate 「1社だけ戻す・渡す」 (multi-tenant foundation 案 A). Code:
`adapters/company-archive.ts` (files, git bundles) and `adapters/sqlite/company-archive.ts` (rows,
through the company handle). Test: `server/tests/integration/company-archive.test.ts`.

```bash
# export (reads the server's DATA_DIR / REPOS_DIR; the archive dir must not exist yet)
docker compose run --rm --no-deps -v /srv/acb-archives:/archives api \
  node --import tsx src/cli/company-archive.ts export <companyId> /archives/<name>
# restore into a scratch / empty server (refuses if the company or its repositories exist there)
DATA_DIR=/tmp/acb-scratch node --import tsx src/cli/company-archive.ts restore <archive dir>
```

- The archive (dirs 0700, files 0600) holds:
  - `manifest.json`: format/version, company id, created at, columns per table, row counts per
    table, repositories, sha256 of every file, notes;
  - `rows/<table>.json`: the company's row of `companies` and its rows of every table with
    `company_id`, read in one transaction;
  - `repos/company.bundle` and `repos/scopes/<repoId>.bundle`: `git bundle --all` of the
    company repository and each private folder's scope repository (an empty one is recorded
    as `empty`).

  Kept private-folder archives under `PRIVATE_FOLDER_ARCHIVE_DIR/<company>/` are listed in the
  manifest, not copied. Nothing of another company is in it.
- Secrets:
  - Key broker keys stay sealed. They open only on a server with the same KEK (`kekIds` in the
    manifest; the KEK is per server today), so restoring elsewhere means keys must be
    re-entered unless that KEK is installed.
  - Relay tokens (`broker_tokens`) are left out.
  - Invitation link tokens are replaced (`redacted:<id>`): old links stop working, send new ones.
  - Better Auth accounts (`auth.sqlite`) are shared by all companies and not moved; memberships
    keep the user ids, so members need accounts on the target server (same ids) to sign in.
- Restore refuses, writing nothing, when:
  - a file's sha256 differs from the manifest;
  - a row belongs to another company;
  - a table or column is unknown to this schema;
  - the company or one of its repositories already exists.

  Rows go in one transaction, parents first, with foreign keys checked at the end. Repositories
  created before a failure are removed. `agent_events.seq` is renumbered (in order), so a
  restore next to other companies cannot collide. Start the server once afterwards: startup
  configures the restored repositories and their hook.
- Export while the server runs is consistent for the rows (one read transaction). A push that
  lands between the rows and the bundles is in the bundle but not in the rows' view; for an
  exact copy, export during maintenance.
- An archive (like any backup) taken before an erasure of content still holds that text: after a
  restore, re-apply the erasure log (`records.md` "Erasing: the operator's runbook").
- Deleting a company is designed but not a command (needs the retention promise first); the
  steps are in the CLI's header comment.

## CI

- `.github/workflows/ci.yml`: job `changes` runs `.github/scripts/changed-areas.sh`, which emits
  `sync`, `client`, `clientmac`, `ui`, `perf`, `universal`, `server`, `admin` = true/false for
  pull requests (push to main: the Linux areas only — `client`, `ui`, `server`, `admin` — since its
  PR ran the macOS ones; nightly at 18:17 UTC and manual runs: everything). A path in `COMMON`
  (manifests, lockfile, `patches/`, the workflow, `.github/actions/`, the script itself) runs
  every job. A job skipped by its `if` reports success, so required checks pass for PRs that do
  not touch them. `check-areas.mjs` (step in "Lint (changed files)") follows each area's test
  imports with esbuild and fails, naming the files, when a list misses one: extend the list.
- macOS runners are scarce (all PRs share a few), so only what needs a Mac runs on one. Jobs:
  Typecheck (all packages, ubuntu), Lint (changed files, `lint-changed.sh`, + `check-areas.mjs`),
  Client tests 1/2 (Linux) + 2/2 (macOS) + the aggregate required "Client tests (macOS)"
  (ubuntu; `client-tests.mjs`, `testing.md`), Renderer UI tests (Linux), Renderer bundle size
  (Linux), Sync harness 1–4/4 (macOS) + the aggregate "Sync harness (macOS)", Performance
  baselines (macOS), Universal bundled git (macOS), Server tests (ubuntu, vitest), Admin tests
  (ubuntu, vitest + jsdom). Required: Typecheck, Lint (changed files), Server tests, Client tests
  (macOS), Sync harness (macOS) — keep those names (branch protection), or change protection with
  them.
- Every macOS job's `runs-on` is `needs.changes.outputs.mac-runner`: the repository variable
  `MAC_RUNNER` (a self-hosted Mac's label) for pushes, nightly/manual runs and PRs from branches of
  this repository; `macos-latest` when the variable is unset and **always for a fork's PR**. See
  "Self-hosted Mac runner".
- `.github/workflows/docker-images.yml` builds and smoke-tests both images on PRs that touch the
  Dockerfiles, compose files, manifests, lockfile, `shared/`, the server's source or the admin's
  source and build config (`admin/src`, `public`, `next.config.ts`, `tsconfig.json`, …) (both
  Dockerfiles once went unbuildable on main unnoticed). Nothing is pushed.
- The token is read-only and fork PRs must work without secrets; keep new jobs that way.

## Self-hosted Mac runner (optional)

A spare Mac can take the macOS jobs: set the repository variable `MAC_RUNNER` (Settings →
Secrets and variables → Actions → Variables) to its runner label, e.g. `acb-mac`. This repository
is public, so anyone can open a PR; code from a fork must never run on that Mac.

- Two walls: the workflow sends fork PRs to `macos-latest` (`mac-runner` in job `changes`), but
  a fork PR runs its own copy of `ci.yml` and could name the label itself, so the runner refuses
  them too — its job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED`) fails any job that is not a
  push, schedule, manual run or same-repository PR. Also set Actions → "Approval for running fork
  pull request workflows" to **all external contributors**, and read a fork's `.github/` diff
  before approving.
- The Mac: a dedicated standard (non-admin) macOS user that runs only the runner, with no
  production keys, SSH keys, cloud credentials, `gh` login, keychain items or personal files;
  FileVault on; Xcode Command Line Tools, Rosetta and nothing else installed by hand. Register a
  repository runner with only the custom label (`./config.sh --labels acb-mac`); the owner
  creates the registration token in the GitHub UI (Settings → Actions → Runners → New), never an
  agent. Each job starts clean: the job-completed hook deletes `_work`, the runner user's
  `$TMPDIR` and caches outside the tool cache (or use `--ephemeral` with re-registration).
- Several runner instances on one Mac let the four sync shards run in parallel; one instance
  runs them one after another.
- Stopping: delete the `MAC_RUNNER` variable (new runs go back to `macos-latest` at once; queued
  jobs keep waiting for the Mac, so re-run them), then `./svc.sh stop` / `./svc.sh uninstall` and
  remove the runner in Settings → Actions → Runners. If the Mac is offline while the variable is
  set, macOS jobs wait for it — delete the variable.

## Desktop app runtime (Electron)

- Electron 45 (supported until 2027-04-27 per releases.electronjs.org/schedule; the Electron
  team supports the latest three stable majors, so plan the next bump before then) with
  electron-builder 26. Electron 45 runs on **macOS 13 (Ventura) or later** (Electron 44 dropped
  macOS 12); Windows 10+. Voice input additionally needs macOS 26 (`voice-input.ts`).
- Platforms (`client/package.json` `build`): **macOS** (dmg + zip) is the shipped, CI-verified
  app — the sync harness, the macOS-dependent client tests (spawn wrappers, FSEvents,
  case/NFD-insensitive volume, Swift), the perf baselines and universal git run on macOS; the
  other client tests, the UI tests and the bundle size run on Linux (nothing in them depends on
  the OS).
  **Windows** (nsis) is built but not CI-verified: its code paths are deliberate (Claude Code
  spawn through cmd.exe, `taskkill` trees, `core.longpaths`, sandbox record-only, Codex not
  offered) and only typecheck covers them; check it by hand before handing a Windows build to
  anyone. **Linux** has no packaging target: the POSIX spawn wrappers' `exec N>&-` fails under
  dash (`/bin/sh` on Debian/Ubuntu; see the `test-client-macos` comment in `ci.yml`), so the
  tests that spawn through them stay on macOS. Code that is already cross-platform (e.g. `sandboxPlatform` naming
  linux) stays; add a Linux target only together with that fix and a Linux CI job.
- Since Electron 42 the `electron` package downloads its binary on first use (`npx electron`,
  `require('electron')`, `pnpm dev`), not in `postinstall`; `npx install-electron` fetches it
  ahead of time, and `ELECTRON_SKIP_BINARY_DOWNLOAD` no longer exists. The package wants Node
  22.12+ for that download; CI never launches Electron and stays on Node 20. A checkout's binary
  lands in `node_modules/.pnpm/electron@<version>/node_modules/electron/dist/`.
- Electron 45's sandboxed preload has no Node shims (`Buffer`, `events`, `timers`, `url`,
  `setImmediate`): `preload.ts` may require only `electron`. The preload (`preload.js`) must be
  emitted as CommonJS — an ES-module preload does not load in a sandboxed window (release-20261109's
  former Picker-window preload; `vite.config.ts` `commonJsPreload`; `pnpm build` runs
  `scripts/check-preloads.mjs` before electron-builder, so a release cannot pack a broken one).
  When checking a release by hand, open 「Google Drive から選ぶ」 once: the member's browser must
  open the Picker page and, after choosing, say 「選びました。アプリに戻ってください。」
  (`google-drive.md`). `safeStorage`'s synchronous
  methods (`secretBox` in `electron-adapter.ts`) are deprecated in 45 and removed in 46: move to
  the async ones before that bump.

## Universal bundled git (macOS app)

electron-builder's `beforePack` hook (`client/scripts/universal-git.mjs`) downloads both darwin
dugite-native archives pinned in dugite's `embedded-git.json` (sha256 verified), `lipo -create`s
every Mach-O, requires all other files to be byte-identical (else the build fails), keeps
symlinks/permissions and replaces `node_modules/dugite/git`. Git Credential Manager (~110 MB,
per-arch .NET) is left out — the app clears `credential.helper`. `@electron/universal` does not
merge `app.asar.unpacked`, so the merge must happen before packing. CI job "Universal bundled git
(macOS)" runs the merge and both slices (`arch -x86_64`). Why: see `sync-guards.md`.

## Workspace and dependencies

- pnpm only (`pnpm-workspace.yaml`); Node ≥ 20, pnpm ≥ 9 (`engines`).
- `pnpm.overrides` pins `@anthropic-ai/claude-agent-sdk` to the app's version; bump it together
  with `client/package.json` (`chat-and-agents.md`). The other overrides are security floors
  for transitive packages (`pnpm audit`: body-parser, nanoid, postcss, minimatch, ...), each kept
  inside its major (`pkg@N` keys); drop one when `pnpm audit` is clean without it. What stays
  open after that is dev tooling or a major bump (vite dev server, `@hono/node-server` under the
  agent SDK's MCP SDK, electron-builder's minimatch).
- GitHub Actions are pinned by commit SHA with the tag in a trailing comment
  (`uses: actions/checkout@<sha> # v7`); Dependabot updates both.
- Two React lines: client is on React 18 (`@types/react` 18), admin on React 19. A library whose
  `.d.ts` imports `react` without declaring `@types/react` as a peer finds the types through
  pnpm's hidden hoist, which holds whichever version pnpm hoisted — admin's typecheck then failed
  intermittently with two `ReactNode` types. Root `package.json` `pnpm.packageExtensions`
  declares the missing optional `@types/react` (/`-dom`) peer for those libraries (next,
  @phosphor-icons/react, @dnd-kit/*, cmdk, next-themes, react-i18next). When adding a React
  library like that, add it there too (`tsc --traceResolution` ending in
  `.pnpm/node_modules/@types/react` is the sign).
- The client's packaged files exclude the SDK's per-platform native binaries
  (`!node_modules/@anthropic-ai/claude-agent-sdk-*/**` in `client/package.json` `build.files`).
