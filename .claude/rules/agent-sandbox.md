---
paths:
  - "shared/core/agent-sandbox.ts"
  - "client/shared/agents/sandbox-policy.ts"
  - "client/shared/agents/cli-version.ts"
  - "client/electron/agents/codex-version.ts"
  - "client/tests/sandbox-policy.test.ts"
  - "shared/types/agent-sandbox.ts"
  - "server/src/routes/agent-sandbox.ts"
  - "server/src/services/agent-sandbox.ts"
  - "server/src/ports/agent-sandbox.ts"
  - "server/src/adapters/sqlite/agent-sandbox.ts"
  - "server/tests/integration/agent-sandbox.test.ts"
  - "admin/src/app/companies/*/agent-sandbox/**"
  - "admin/src/lib/agent-sandbox.ts"
  - "admin/tests/agent-sandbox.test.tsx"
---

# AI sandbox (「AI の囲い」): the company's policy, handed to the agents' own sandboxes

The chat AI runs commands on the member's computer. With the sandbox on, those commands reach
only hosts the company allows and cannot read secret places (SSH / cloud credentials, keychains,
browser profiles, password managers, the app's own data). Owner decisions (2026-10-25): **no
OS sandbox of our own** — the app hands the policy to Claude Code's and Codex's built-in
sandboxes (「公式の部品で外から包む」; `srt` later if needed); roll out owner's PC → one
department → everyone (a week each) through a per-member override; a computer that cannot
start the sandbox runs "record only" at first; Windows is record only; the default host list
is below, editable per company in the admin. Background: `docs/sandbox-web-broker-findings.md`
(internal).

## Pieces

- `shared/core/agent-sandbox.ts` (pure, server + admin + app): `AgentSandboxSettings` (`mode`
  off / observe / enforce, `allowedDomains`, `deniedReadPaths`, `onUnavailable` record-only /
  stop), `DEFAULT_SANDBOX_ALLOWED_DOMAINS` (Gemini / Vertex / Google APIs, Apps Script, R2,
  GitHub, npm, PyPI, HubSpot), validation (`normalizeSandboxDomain`: lower case, ≥ 2 labels,
  optional `*.` = subdomains; refuses `*`, IPs, localhost, schemes, ports, paths;
  `normalizeDeniedReadPath`: `/abs` or `~/x`, no `~` alone, `..`, globs, control characters),
  `sandboxAllowsHost`.
- `client/shared/agents/sandbox-policy.ts` (pure): `resolveSandbox(settings, host)` → absolute
  `denyRead` = `SECRET_READ_PATHS` (the Jamf managed list + `~/.aws`, `~/.azure`) + the
  company's paths + the app's userData; `allowRead` = the company folder / tool folders only
  when a company-denied folder contains them, never one inside a secret place or one containing
  a denied place (Claude: allowRead beats denyRead); `allowWrite` = package caches
  (`CACHE_WRITE_PATHS`, else `npm/pip install` fail); `allowedDomains` = company list + the ACB
  server. `claudeSandboxOptions` → the SDK `sandbox` (`enabled`, `failIfUnavailable`,
  `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`, `strictAllowlist: true`) +
  `permissionsDeny` (`WebFetch`, `WebSearch` — they bypass the host list —, `Read(//p)` and
  `Read(//p/**)` per denied place, since the sandbox covers only Bash). `codexSandboxConfig` →
  thread config `default_permissions = "acb"`, `features.network_proxy = true`,
  `permissions.acb` (extends `:workspace`, caches `write`, denied places `deny` — except one that
  contains the company folder: in Codex a deny wins over everything —, network enabled with only
  the allowed hosts).
- Why these flags (verified on CLI 2.1.304): with `strictAllowlist` + `allowUnsandboxedCommands:
  false` in the flag settings, the company repository's `.claude/settings.json` cannot switch
  the sandbox off, add hosts or re-open paths; bypassPermissions and `dangerouslyDisableSandbox`
  stay inside. Codex: a legacy `sandbox` / `sandbox_mode` in any layer switches profiles off.
- Codex version floor: registry `minCliVersion` (`0.153.4`, the version profiles + the network
  proxy were verified on). `electron/agents/codex-version.ts` runs `codex --version` before a
  chat turn and in the settings check (`getCodexStatus`); too old or unreadable →
  `codexVersionMessage` (「お使いの Codex（x）は古いため…npm install -g @openai/codex@latest…」), the
  CLI is not started. A passing CLI is remembered per path for the app run.

## Server and admin (S1)

- Tables `agent_sandbox_settings` (company → JSON setting; no row = `DEFAULT_AGENT_SANDBOX_SETTINGS`:
  `off`, the default hosts, record-only), `agent_sandbox_overrides` (company, user → mode),
  `agent_sandbox_history` (who, when, the change as JSON). A stored setting that no longer
  validates falls back to the defaults (logged).
- `routes/agent-sandbox.ts` → `services/agent-sandbox.ts` → `AgentSandboxRepository`:
  `GET|PUT /agent-sandbox` (owner/admin; PUT takes the whole setting, validated by
  `parseAgentSandboxSettings`; an unchanged save writes no history), `PUT
  /agent-sandbox/overrides/:userId { mode | null }` (owner/admin; the user must be a member;
  null = follow the company), `GET /me/agent-policy` (any member) → `{ version, sandbox: {
  ...setting, mode: their override or the company's, source: 'member' | 'company' } }`, ETag =
  version, `If-None-Match` → 304. This is the endpoint M2 (emergency stop) extends — one policy
  fetch for the app, not one per feature. Overrides of people who left are not shown and do
  not apply (nobody else asks for their policy).
- Admin 「AI の囲い」 (`admin/src/app/companies/[id]/agent-sandbox/page.tsx`, nav entry for
  owner/admin): company mode (使わない / 記録だけ / 囲う), what a PC that cannot start the sandbox
  does (記録だけで続ける / AI を使えなくする), the host list and extra denied places as one-per-line
  text (invalid lines shown and saving blocked; 「初期の一覧に戻す」), 「メンバーごとの動作」 (one
  select per member: 会社と同じ / a mode), and the change history. Words:
  `admin/src/lib/agent-sandbox.ts`. Types: `shared/types/agent-sandbox.ts` re-exported from
  `admin/src/lib/api.ts`, pinned by `admin-contract.test.ts`.

Tests: `server/tests/integration/agent-sandbox.test.ts` (who may read / change, refusals of `*`
/ `~`, a save reaches every member's policy, an override changes only that member, ETag),
`admin/tests/agent-sandbox.test.tsx` (menu and page for owner/admin only, an open-everything
list cannot be saved, what a save sends, an override changes one member),
`client/tests/sandbox-policy.test.ts` (no loosening flags, secret places for Bash / Read /
Codex, company folder and tools stay readable without re-opening a secret, exact host list,
validation refusals, the version floor and that a too-old Codex never starts).
