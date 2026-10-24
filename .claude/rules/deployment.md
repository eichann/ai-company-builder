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
- `api` mounts `./server/src:/app/src`, `./shared:/app/shared` and `./data:/app/data` and runs
  `tsx watch`. When you add a directory the server needs at run time, add its mount here too.
- `admin` is a production build (`next build`, standalone server) with no source mount, because
  it is internet-facing and must not run `next dev`. Rebuild after admin changes
  (`docker compose up -d --build admin`), or use `pnpm dev:admin` on the host for hot reload.
  `/api/*` is forwarded by `admin/src/proxy.ts`, which reads `API_PROXY_URL` at run time
  (`http://api:3001` on the compose network). The admin Dockerfile copies `shared/` into its
  build stage.
- Required env (`.env`, from `.env.example`): `AUTH_SECRET` (`openssl rand -base64 32`),
  `PUBLIC_URL`. Node heap is capped (`NODE_OPTIONS=--max-old-space-size`, 2048 api / 1024 admin)
  so a slow leak restarts cleanly.
- The self-hosting production compose file is `docs/self-hosting/docker-compose.production.yml`
  (built and smoke-tested by the Docker images workflow).

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
