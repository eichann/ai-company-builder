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
  - "server/src/services/restore-pause.ts"
  - "server/tests/integration/restore-pause.test.ts"
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
  scratch; anything else fails on the read-only filesystem. (The holding place's contents,
  `HOLDING_DIR`, default to `data/holding`, like the private-folder archives in
  `data/backups/private-folders`: inside the data volume and its backups, no compose change; do not
  point it outside `DATA_DIR`.) The image stays TypeScript + tsx on
  purpose: the pre-receive hook runs `push-check/entry.ts` with the server's node and tsx loader.
  The user manual is built in the Dockerfile's `manual` stage from `manual/` (a page that does not
  render fails the image build) and only the built site is copied to `/app/manual-site`, served at
  `/manual/` (`server.md` "The user manual"); the same stage builds the administrator guide from
  `manual-admin/` into `/app/manual-admin-site`, served at `/manual-admin/` to owners and admins
  (`server.md` "The administrator guide"). The Docker images workflow runs on `manual/**` and
  `manual-admin/**` too (its smoke step reads both as the CI owner, and 401 without a session), and
  so does the server job (`changed-areas.sh`: the permission matrix builds both).
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
  (`http://api:3001` on the compose network); so are `/manual`, `/manual/*`, `/manual-admin` and
  `/manual-admin/*` (the user manual and the administrator guide, served by the api: production's
  Caddy sends only `/api/*` there, the rest to the admin). The admin Dockerfile copies `shared/` into its
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
- **Plugin trust documents** (`PLUGINS_DIR/trust/`, `plugin-trust.md` "P2"; nothing enforced yet):
  the signed root, each company's list and its freshness document, read by the api on every
  request (no restart). Filled only by `server/src/cli/plugin-trust.ts install` on the host (not in
  the api container), from two checkouts of the owner's private trust repository (its `main` and
  `freshness` branches; read-only deploy key; never name the repository here). An **hourly timer**
  on the host (cron / systemd / launchd), e.g.:

  ```bash
  git -C /srv/acb-trust/main pull --ff-only -q && git -C /srv/acb-trust/freshness pull --ff-only -q && \
    (cd /srv/acb/server && node --import tsx src/cli/plugin-trust.ts install \
      --main /srv/acb-trust/main --freshness /srv/acb-trust/freshness --dir "$PLUGINS_DIR" --server "$PUBLIC_URL")
  ```

  It swaps the `trust` link in one rename. It refuses (and changes nothing) when a checkout's
  folder is missing or unreadable, when there is no company list (`--allow-empty yes` to hand out
  none on purpose), when a root version already installed is missing, or when no company verifies;
  a single company that does not verify keeps its installed documents (or is left out) and the
  command exits 1, so the timer's failure mail fires. Freshness documents live ≤ 3 days, so a timer stopped for
  that long stops every company's plugin code once P4 enforces (the api logs
  `[plugin-trust] … runs out in N h` from 48 h before). The api's clock must be right (NTP): one
  more than 10 minutes behind withholds fresh documents.
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
# restore into a scratch / empty server (refuses if the company or its repositories exist there);
# leaves the company's jobs and AI stopped ("After a restore" below), so it needs the api's settings
# (AUTH_SECRET …): without them it stops before writing anything
DATA_DIR=/tmp/acb-scratch AUTH_SECRET=… node --import tsx src/cli/company-archive.ts restore <archive dir>
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
  manifest, not copied, and so are the holding place's contents under `HOLDING_DIR/<company>/`
  (`heldContents`, `private-folders.md` "Holding: the member's upload"; its rows are in `rows/`).
  Nothing of another company is in it.
- Secrets:
  - Key broker keys stay sealed. They open only on a server with the same KEK (`kekIds` in the
    manifest; the KEK is per server today), so restoring elsewhere means keys must be
    re-entered unless that KEK is installed.
  - Relay tokens (`broker_tokens`) are left out.
  - 「ブラウザ操作」 recordings (`browser_recordings`, kept 30 days at most) are left out (`agent-browser.md` "Recording").
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
  restore next to other companies cannot collide. The ledger's delivery numbers
  (`record_ledger.delivery_seq`, per company, an ordinary column) and their counter
  (`record_ledger_seq`) come back **unchanged** — never renumbered — and the counter is then set
  above every stored number (`restoreLedgerSequence`, `records.md` "Delivery order"); an archive
  from before has none (NULL: never events). Start the server once afterwards: startup
  configures the restored repositories and their hook.
- Export while the server runs is consistent for the rows (one read transaction). A push that
  lands between the rows and the bundles is in the bundle but not in the rows' view; for an
  exact copy, export during maintenance.
- An archive (like any backup) taken before an erasure of content still holds that text: after a
  restore, re-apply the erasure log (`records.md` "Erasing: the operator's runbook").
- Deleting a company is designed but not a command (needs the retention promise first); the
  steps are in the CLI's header comment.

## After a restore: automatic work stays stopped

A database put back from a copy (an archive, or the whole server's backup) no longer knows what was done outside
after the copy was taken — an occurrence of a scheduled job, an AI run's operation key, a Drive put's receipt, a mail
sent. UNIQUE keys protect only rows that exist, so the same slot or operation could be made and sent again.
Code: `services/restore-pause.ts` (`restorePause.pauseAfterRestore`, the operator's CLI only; no route). For each
restored company, in one transaction:

- 「定期の仕事をすべて止める」 on (`ai_job_settings`, `updated_by` `acb:restore`) and what is due or running held
  (`COMPANY_STOPPED`, `jobs.md` "Held"; a running PC run ended);
- the company-wide emergency stop of the whole AI (`agent_stops`, `stopped_by` `acb:restore`, a reason saying what to
  check; not added again when one is in force): the server refuses AI runs' claims and tokens and the relay
  (`agent-stop.md`). Members cannot use the AI until it is released (owner decision on the safe side, see the PR);
- the notice `company_restored` to every owner / admin (`notifications.md`).

A person's own send is not stopped. Sends and Drive puts the copy holds as `sending` are settled by the server clock
(`outbound-mail.md` "A send left half-done", `google-drive.md` "A put left half-done"). Owners / admins resume after
checking the outside services: 「定期の仕事」 →「動かせるようにする」 and 「AI の緊急停止」 → release (both in the
admin console); lifting the jobs stop holds the slot that passed meanwhile, so nothing from before runs.

- **One company** (`company-archive.ts restore`): done by the command right after the rows and repositories are in.
  Should stopping a company fail after its data is in, the command exits 1 naming the exact
  `pause-after-restore <companyId>` to run before starting the server.
- The admin console's stop page says 「バックアップから戻したとき（自動） が停止」 for such a stop (`admin/src/lib/agent-stop.ts`
  `stopBy`; `admin/tests/agent-stop.test.tsx`).
- **The whole server from a backup** (no startup hook can tell a restored database from a server that was simply
  down, so this is a step of the procedure, never automatic): stop `api` first; put back `data/` (the databases
  **and** `data/repos/` from the same snapshot — a database newer or older than its repositories is not
  supported); then, before starting `api`:

  ```bash
  docker compose run --rm --no-deps api node --import tsx src/cli/company-archive.ts pause-after-restore --all
  ```

  then `docker compose up -d api`, re-apply the erasure log (`records.md`), and tell the owners / admins. The
  command needs the api's settings (`AUTH_SECRET` …), which `docker compose run` gives it. The holding place's
  contents (`data/holding/`, `private-folders.md` "Holding: the member's upload") must come from the same snapshot
  as the database: a stored entry whose file is missing is taken again only while its item is still receiving (`finish`
  refuses until it is back; the
  member's app sends it once more); a waiting item's missing content is lost — the reviewers see its name only.
- Test: `restore-pause.test.ts` (a slot that ran before the copy is never run again, also after the stop is lifted;
  the whole AI stopped once; owners / admins told, members not), `job-runs.test.ts` 「after a restore」 (a running PC
  occurrence held, its run ended), `company-archive.test.ts` 「the restore command…」 (the CLI's restore and
  `pause-after-restore --all`; without the api's settings nothing is written) — each mutation-checked.

## Rolling back production (stage 4b-0.5 is the oldest version to go back to, once shipped)

**Once 4b-0.5 (the rollback floor of event jobs run by the PC's AI, branch `feat/stage4b-05-rollback-floor`, owner memo
「段4b 設計メモ」 第4版 §5, decision D8) is in production, never roll production back below it** — not to 4a, 4-0.1 or
4-0 (the floor is the pinned release that includes 4b-0.2's fix of who sees a stopped chain). Why: 4b-1 writes job
versions of `schema: 3` (an event job the responsible person's PC AI runs), their occurrences, PC runs with Drive puts or
drafts in flight, and watch generations. Only 4b-0.5 and later (a) **freeze** an occurrence of a shape they do not know
— not shown, counted, told, expired, run, claimed, retried or reconciled, left out in SQL before every limit, and only a
pause / the company's stop / a restore holds it and ends its run, telling nobody (`jobs.md` "Shapes this build does not
know"); 4a would expire such an occurrence and tell people about it without 4b's checks, and its clock and runner limits
could be filled by frozen rows; (b) let a held occurrence's unknown outside result be reconciled without resuming
anything (`jobs.md` "「もう一度」" "Reconcile") — a build before leaves a run that a stop ended mid-put with no way to
record what happened; (c) keep **watch generations** (`jobs.md` "Event-triggered jobs"): a build before them lets an
earlier watch's occurrence stop or move a watch chosen again on the same record; (d) announce, in the admin console and
the app, only the shapes their screens show (`ADMIN_JOB_SCHEMAS` / `APP_JOB_SCHEMAS`), so a newer core never hands an old
screen a definition to approve or accept. Rolling back between 4b-0.5 and 4b-1, or forward, works: 4b-0.5 changes
nothing 4b-1 needs except holding what a stop holds (F11: `server/tests/integration/job-rollback-floor.test.ts` on
`server/tests/fixtures/stage4b1-shaped-jobs.sql`); the watch-generation migration only reads cursors that have no
generation, so a cursor 4b-1 wrote is never re-judged. Rolling back the desktop app below 4b-2 is the app's own matter
(memo §7: it never claims an event occurrence and stops renewing; the server's deadline ends the run). Everything below
was the previous floor's reasoning and still holds for builds older than 4b-0.5.

**The floor is pinned and checked across builds** (stage 4b-1, coordinator decision 2026-11-22): `.github/rollback-floor-commit`
holds the floor's merge commit (`6760eef3…`, #720) — the one place it is named; **move it when the floor moves** (the
oldest version production may go back to), in the same PR that says so here. `.github/scripts/rollback-floor-check.sh`,
a step of CI's "Server tests" job (and runnable locally from the repository root), passes one SQLite file through three
steps (`server/tests/cross-build/`, skipped in ordinary runs without `ACB_CROSS_BUILD_DB`): **1-make** — this build writes
what production would hold (schema-3 event jobs, a running PC run with a Drive put done and one in flight and its receipt,
an occurrence with an unknown outside result whose chain stopped and whose notices were written, a watch moved to the
やること a run made and a waiting occurrence of it); **2-floor** — the floor's code (a `git worktree` of the pinned commit,
using this checkout's `node_modules` while the lockfile is the same, else its own install of the server) on that file:
nothing listed, worded, claimed, run or expired (also with the clock two days later), a pause / the company's stop / a
restore hold what waits or runs and end the run (its put in flight unknown), a resume refused there
(`JOB_SCHEMA_UNKNOWN`), nobody told, everything 4b-1 needs unchanged (`snapshot.ts`); **3-return** — this build again:
nothing lost, nothing made twice by the clock, held stays held, the stopped chain worded again, and the unknown results
reconciled on the occurrences by their responsible person without resuming anything. `2-floor.test.ts` is copied into the
floor's worktree, so it uses only what the floor build has (its routes and services); keep it so when the floor moves.
It fails on a build that does not freeze schema 3 (checked: step 2 run with 4b-1's own code fails at the first listing).
Since member proposals (PR A, jobs.md "Member proposals") the three steps also carry **schema-4 jobs** (a proposal waiting,
one withdrawn — its job retired —, one approved; their `job_proposal` notices): the floor (which knows `[1, 2]`) shows only
their names (versions without definition or fingerprints), refuses approve / edit / accept (`JOB_SCHEMA_UNKNOWN`), makes no
occurrence of them and shows no `job_proposal` / `job_proposal_returned` notice (unknown kinds; a returned proposal's notice
to its proposer is checked); `snapshot.ts` keeps `ai_job_proposals` and the
proposals' `ai_jobs` rows as written; back here the withdrawn one stays withdrawn and unapprovable, a resend of the waiting
one answers its first result and adds no job or notice, and it is still approved once.
The older fixture test (`job-rollback-floor.test.ts` F11 on `stage4b1-shaped-jobs.sql`) stays as the floor's own.
Since the set watch's second line (4b-4 A3, `jobs.md` "The set watch (schema 5)" "The second line") the script runs a **second
chain** on a copy of step 1's database: **2-before-line** — the code of `.github/set-watch-line-before-commit` (a build that
knows schema 5 but not that line; the one place it is named — move it only to another build without the line) — reads and runs
nothing of S2 (bob's job of that line), ends its waiting occurrence untold (`SET_WATCH_NOT_OPENED`), refuses its approval and
leaves every mark as written; **3-return-line** — this build again: the ended occurrence stays ended, the meeting read in
between never runs late or gets a mark, and a meeting read now runs once. The floor chain carries S2 too (frozen as S1).

### Browser operation's plans of writes (generalization PR 4)

**Before the first build that makes plans of opened lines with writes (PR 5 or later, once a write line is approved),
the build of `feat/browser-gen-4-server` must be in production; after such a build has run, never roll production back
below it** (owner decision on #813, design memo §15 C13). Why: that build leaves write executions (`running`, `unknown`,
`partial`), one row per write, their reports and the new path's locks (`agent-browser.md` "Plans of opened lines on the
server"). A build before PR 4 knows none of these tables: its old-path claim would not see the new path's locks (two
writes on one object), and nobody could report, confirm or settle those executions. PR 4 serves every such row (no
permit without its line, reports and confirms settle them, locks held until final) and freezes a plan shape it does not
know (`BROWSER_LINE_PLAN_SHAPES`). Guard: `server/tests/unit/browser-lines.test.ts` 「the rollback floor」 (rows a writing
build leaves, served by a build without its line; a frozen shape). The jobs' cross-build check above pins its own floor
commit; the writing PR adds its rows to `server/tests/cross-build/` against this build when it moves that pin (owner's
call). Rolling back to a build between PR 4 and the writing one is fine; before PR 4 is fine only while no plan of
writes was ever made (the new tables are additive and unread there). **PR 5c** (`feat/browser-gen-5c-write-executor`)
is the first build whose server makes plans of writes — but only of an approved line, and none is approved until the
owner's test write (PR 7): deploy it only on top of PR 4 in production, and from the first plan of writes on, never below
PR 4.

### The previous floor (stage 4-0.1)

**Once event-triggered jobs (stage 4a) are in production, never roll production back to a version older than
stage 4-0.1** (`fix/stage4-0-1-hide-event-occurrences`, on top of 4-0 `feat/stage4-0-ledger-seq`; owner decision ⑩,
memo 「出来事で動く定期の仕事」 §10-7). 4-0 alone is no longer enough: it would show 4a's event occurrences (readable only
by people who read their source record) to owners and admins — in the occurrence list, as a job's last occurrence,
with `ev:<n>` printed as the slot — and tell the responsible person and the creator when one expires, without the
reader check. 4-0.1 treats every event occurrence as nonexistent (`jobs.md` "Event occurrences do not exist on this
build"). The rest of this section is why 4-0 itself was needed. Why: 4a writes job
versions of `schema: 2`, event occurrences (`ev:` slots) and reads the ledger by delivery number. 4-0 is the first
build that (a) never runs, claims, retries, approves or edits a definition of a shape it does not know
(`jobs.md` "Shapes this build does not know"), (b) numbers every ledger row in its transaction, and (c) keeps those
numbers through an archive. A build before 4-0 reads a `schema: 2` definition as if it were schema 1 (its clock
treats an unknown trigger as monthly, its admin console fails on `trigger.at`), and writes ledger rows without
numbers that 4a then never sees as events. The admin console is deployed with the server (same compose, same
commit); an admin tab left open from before 4-0 only gets definitions it can read (no header = schema 1). Rolling
back between 4-0.1 and 4a, or forward, works. 4-0.1 does not keep 4a's paused stretches (`ai_job_event_gaps`): a
pause, the company's stop or a restore there holds the event occurrences already waiting (`holdEventOccurrences`) but
records no stretch. 4a finds such a pause or stop when rolled forward (a resume or a lift that closes no gap, or a job /
stop row another build wrote — the cursor's stamps, `jobs.md` "Event-triggered jobs") and treats the event jobs it touched
as having seen everything up to then: nothing from that stretch runs, and a watched やること completed in it shows the
job's chain as stopped (the responsible person chooses the next one). An event occurrence left `due` and not paused
stays as it was on 4-0.1 and 4a settles it (with its reader check) when rolled forward. Rolling back the desktop app is
fine (it claims time occurrences only unless it names `event`; an app before 4a cannot accept an event job and is told
to update itself). 4a's tables (`ai_job_event_cursors`, `ai_job_event_gaps`, the event columns of `ai_job_occurrences`)
are additive and travel in a company archive like every `company_id` table; the stop a restore sets
(`pauseAfterRestore`) opens the company's event gap, so nothing that happens until an owner lifts it runs afterwards.

## CI

- `.github/workflows/ci.yml`: job `changes` runs `.github/scripts/changed-areas.sh`, which emits
  `sync`, `client`, `clientmac`, `ui`, `perf`, `universal`, `server`, `admin`, `model` = true/false for
  pull requests (push to main: the Linux areas only — `client`, `ui`, `server`, `admin`, `model` — since its
  PR ran the macOS ones; nightly at 18:17 UTC and manual runs: everything). A path in `COMMON`
  (manifests, lockfile, `patches/`, the workflow, `.github/actions/`, the script itself) runs
  every job. A job skipped by its `if` reports success, so required checks pass for PRs that do
  not touch them. `check-areas.mjs` (step in "Lint (changed files)") follows each area's test
  imports with esbuild and fails, naming the files, when a list misses one: extend the list
  (for `model`, the code files the browser plan model cites).
- macOS runners are scarce (all PRs share a few), so only what needs a Mac runs on one. Jobs:
  Typecheck (all packages, ubuntu), Lint (changed files, `lint-changed.sh`, + `check-areas.mjs`),
  Client tests 1/2 (Linux) + 2/2 (macOS) + the aggregate required "Client tests (macOS)"
  (ubuntu; `client-tests.mjs`, `testing.md`), Renderer UI tests (Linux), Renderer bundle size
  (Linux), Sync harness 1–4/4 (macOS) + the aggregate "Sync harness (macOS)", Performance
  baselines (macOS), Universal bundled git (macOS), Server tests (ubuntu, vitest), Admin tests
  (ubuntu, vitest + jsdom), Model (browser plan) (ubuntu; `model/browser-plan/check`, its npm
  checker installed with scripts off in that job only; `agent-browser.md` "The plan model"). Required: Typecheck, Lint (changed files), Server tests, Client tests
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
  22.12+ for that download; CI stays on Node 20 and launches Electron in two tests only
  (`client/tests/browser-window-electron.test.ts`, `client/tests/doc-frame-electron.test.ts`,
  "Client tests 2/2 (macOS)", after the step
  "Fetch the Electron binary": `npx --no install-electron`). A checkout's binary
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

- **Cookie encryption fuse** (`client/package.json` `build.electronFuses: { enableCookieEncryption: true }`, the only
  fuse flipped; `agent-browser.md` "Keeping a login on disk"): electron-builder flips it right before signing. One-way: a
  build without it cannot read cookies written after it (nothing the app relies on; a rolled-back build removes kept
  logins at start). A plain store from before is read and encrypted on its next write. Check a release with
  `npx @electron/fuses read --app "<the .app>"` (`EnableCookieEncryption is Enabled`). Test:
  `client/tests/cookie-encryption-electron.test.ts` (macOS: a copy of Electron with the fuse; the shipped config).

## Universal bundled git (macOS app)

electron-builder's `beforePack` hook (`client/scripts/before-pack.mjs`: first the release build's
plugin trust root check — a loud warning until the enforcement switch, `plugin-trust.md` "P2" —, then `client/scripts/universal-git.mjs`) downloads both darwin
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
