---
paths:
  - "docker-compose.yml"
  - "server/Dockerfile"
  - "admin/Dockerfile"
  - ".dockerignore"
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
---

# Deployment, CI and the workspace

Self-hosting guides (English and Japanese, published): `docs/self-hosting/`. Full text:
`docs/architecture/deployment.md` (internal).

## Docker Compose (`docker-compose.yml`)

- `docker compose up -d` runs `api` (port 3001), `admin` (3100) and `autoheal`. Ports bind to
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
- `admin` is a production build (`next build`, standalone server) with no source mount, because
  it is internet-facing and must not run `next dev`. Rebuild after admin changes
  (`docker compose up -d --build admin`), or use `pnpm dev:admin` on the host for hot reload.
  `/api/*` is forwarded by `admin/src/proxy.ts`, which reads `API_PROXY_URL` at run time
  (`http://api:3001` on the compose network). The admin Dockerfile copies `shared/` into its
  build stage.
- Optional key broker KEK: `BROKER_KEK_HOST_FILE` (host path, root-owned `0600`, outside the
  checkout and `./data`) is mounted read-only at `/run/secrets/broker-kek`
  (`BROKER_KEK_FILE`); unset → `/dev/null` is mounted and the broker stays off
  (`key-broker.md`). Same in `docs/self-hosting/docker-compose.production.yml`.
  `BROKER_TOKEN_TTL_MINUTES` (15–60, default 30) sets the tokens' lifetime;
  `BROKER_MAX_REQUEST_MB` (100) and `BROKER_UPSTREAM_TIMEOUT_SECONDS` (600) bound the relay;
  `BROKER_DAY_UTC_OFFSET_MINUTES` (540, Japan) is where the daily caps' day begins;
  `BROKER_KEY_CHECK` (on; `off` for a server without internet access, and in the server tests)
  checks a key once when it is saved.
  Staging only: `ACB_ALLOW_FAKE_UPSTREAMS=1` + `ACB_FAKE_HUBSPOT_URL` (loopback, `localhost` or
  `host.docker.internal`, port only) send the broker's HubSpot requests to the practice HubSpot,
  and `ACB_FAKE_GOOGLE_URL` every Google request to the practice Google — per service, each
  variable redirects only its own (`google-connector.md`);
  passed through by `docker-compose.yml` only — **never add them to the production compose
  file**. The server ignores them under `NODE_ENV=production` or a non-local `PUBLIC_URL`
  (`lib/config.ts` `practiceUpstreamsFrom`, `key-broker.md`).
  The relay (`/api/broker/…`) needs outbound HTTPS from the api container. The request log
  never prints a URL or query (`lib/request-log.ts`, `server.md` "Request log"), so no relay
  token in `?key=` either.
- `OPERATOR_USER_IDS` (comma-separated user ids; a signed-in operator sees theirs at
  `/api/me`) and `COMPANY_CREATION_POLICY` (`operator`) decide who creates companies after the
  first one (`server.md` "Accounts and roles"); passed through by both compose files.
- Required env (`.env`, from `.env.example`): `AUTH_SECRET` (`openssl rand -base64 32`),
  `PUBLIC_URL`. Node heap is capped (`NODE_OPTIONS=--max-old-space-size`, 2048 api / 1024 admin)
  so a slow leak restarts cleanly.
- The self-hosting production compose file is `docs/self-hosting/docker-compose.production.yml`
  (built and smoke-tested by the Docker images workflow).

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
- Deleting a company is designed but not a command (needs the retention promise first); the
  steps are in the CLI's header comment.

## CI

- `.github/workflows/ci.yml`: job `changes` runs `.github/scripts/changed-areas.sh`, which emits
  `sync`, `client`, `ui`, `perf`, `universal`, `server`, `admin` = true/false for pull requests
  (everything true on push to main, nightly at 18:17 UTC, and manual runs). A path in `COMMON`
  (manifests, lockfile, `patches/`, the workflow, `.github/actions/`, the script itself) runs
  every job. A job skipped by its `if` reports success, so required checks pass for PRs that do
  not touch them. When a test starts loading files outside its area's list, extend the list.
- Jobs: Typecheck (all packages, ubuntu), Lint (changed files, `lint-changed.sh`), Client tests
  (macOS), Renderer UI tests (macOS), Sync harness 1–4/4 + the aggregate "Sync harness (macOS)",
  Performance baselines (macOS), Universal bundled git (macOS), Server tests (ubuntu, vitest),
  Admin tests (ubuntu, vitest + jsdom).
- `.github/workflows/docker-images.yml` builds and smoke-tests both images on PRs that touch the
  Dockerfiles, compose files, manifests or lockfile (both Dockerfiles once went unbuildable on
  main unnoticed). Nothing is pushed.
- The token is read-only and fork PRs must work without secrets; keep new jobs that way.

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
  with `client/package.json` (`chat-and-agents.md`).
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
