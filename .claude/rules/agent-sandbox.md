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
  - "admin/src/components/agent-sandbox/**"
  - "client/electron/services/agent-policy-store.ts"
  - "client/tests/sandbox-observe.test.ts"
  - "client/tests/sandbox-claude.test.ts"
  - "client/tests/sandbox-codex.test.ts"
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

## Observe and the log (S2)

- The app reads its policy per chat turn: `services/agent-policy-store.ts` (`GET
  /me/agent-policy`, 3 s budget, ETag; memory only — a failed refresh keeps the last answer, a
  policy never received (or one that does not validate) = off this turn, logged).
  `features/chat/server-config.ts` `getAgentSandbox` adds this computer's facts (home, userData,
  `PATH` folders, the server's host); `chat-server.ts` → `decideTurnSandbox(settings, host,
  capabilities.sandbox)` → the request's `sandbox` (`TurnSandbox`, `agents/connection.ts`).
  `enforce` with an agent that cannot take the sandbox (registry `capabilities.sandbox`) runs as
  observe for that turn (logged).
- `observe` marks events (`sandbox: 'would-block'`) the tracker's `concern` finds
  (`sandboxConcern`): a command naming a URL host outside the list, a denied place spelled in a
  command (absolute, `~/`, `$HOME/`) or a Read-tool path inside one. Best effort: a script can
  reach anything; the marks are for tuning the list, enforcing is the CLI's job.
- `enforce`: a failed command whose error carries Claude Code's `<sandbox_violations>` (`deny
  network-outbound host:port`, verified on 2.1.314) or `Operation not permitted` on a place
  `concern` names is logged `sandbox: 'blocked'`, `guardReason: 'sandbox'`, the refused hosts
  added to the target (`parseSandboxViolation`, `recordToolEnd`).
- Reads refused by Claude Code's permission rules (the company Macs' managed settings, the
  sandbox's `Read(...)` denies) run **no hook** (verified: no PreToolUse / PostToolUse(Failure)
  / PermissionDenied), so M1 missed them. `createDeniedCallWatcher` (`claude-tool-events.ts`)
  reads the message stream: a `tool_use` whose `tool_result` is an error containing 「denied by
  your permission settings」 → `policy-denied` / `guardReason: 'denied-read'`, in every mode.
- Every command event now carries the hosts of URLs it names (`target.hosts`, ≤ 5, host only),
  and every event the skill the turn is running (`skill`: Claude's `Skill` tool, or a path under
  `.claude|.agents|.codex/skills/<name>/`).
- Server: `agent_events.sandbox` / `.skill` (idempotent `ALTER TABLE`), hosts searchable with
  `q`; `GET /agent-events/sandbox?from&to` (owner/admin; default 30 days, ≤ 20,000 newest
  events) → `byHost` / `bySkill` / `byPlace` with would-block / blocked / denied-read counts,
  members, last time. Admin: the 「囲うと止まる操作（直近30日）」 card on 「AI の囲い」
  (`components/agent-sandbox/impact-card.tsx`); log rows show 「囲うと止まる」 / 「囲いで止まった」 +
  the skill, and a command's 宛先.

## Enforce with Claude Code (S3, macOS / Linux)

- Registry `capabilities.sandbox` (Claude Code: true; Codex, API key: false until S4) and
  `sandboxPlatform` (darwin, linux — Windows is record only, owner decision). `chat-server.ts`:
  enforce that cannot run here → `onUnavailable: 'stop'` answers 403
  `SANDBOX_MESSAGES.unavailableStop`, `record-only` runs the turn as observe (logged). Under
  enforce the system prompt gets `SANDBOX_INSTRUCTIONS` (relay the company's sentence, never
  work around the sandbox).
- `agents/claude.ts` with `sandbox.mode === 'enforce'`: provider `sandbox` =
  `claudeSandboxOptions(resolved).sandbox` (the SDK merges it into the CLI's `--settings`
  layer) and flag `settings.permissions.deny` = WebFetch / WebSearch + `Read(//p)` /
  `Read(//p/**)` for every denied place. Observe / off pass neither (unchanged CLI).
- The sandbox cannot start (`failIfUnavailable`; stderr or the stream error matches
  `CLAUDE_SANDBOX_UNAVAILABLE_RE`, from the CLI's strings — not reproducible on a Mac):
  `stop` → the turn ends with 「サンドボックスを開始できませんでした。会社の設定により、この PC では AI
  を使えません。管理者に相談してください。」; `record-only` → the turn re-runs without the sandbox
  and the reply starts with 「※ サンドボックスを開始できませんでした。会社の設定により、今回は記録だけで続けます。」.
  Any other failure surfaces unchanged (never a silent unsandboxed re-run).
- A refused host / read: the PostToolUseFailure hook returns `additionalContext` with
  `blockedHostMessage(host)` = 「会社の設定で、この宛先（host）には接続できません。必要なら管理者に許可を依頼してください。」
  (or the read sentence) for the AI to relay; the event is `blocked` (S2).
- Verified on this Mac (CLI 2.1.314, Haiku, Jamf developer managed settings present, the
  scratch company's `.claude/settings.json` trying to disable the sandbox, allow example.org /
  example.com and re-open `~/.ssh`): api.github.com 200; example.org refused (curl 56, logged
  `blocked` + host); generativelanguage.googleapis.com reached (403 from Google = no key);
  `python3 -c "open('~/.ssh/config')"` → `PermissionError` (logged `blocked`); the Read tool on
  `~/.ssh/config` refused (logged `denied-read`); `~/.aws/config` unreadable; company folder read
  / append / mkdir OK; writing `~/Desktop` refused; observe mode lets example.org through and
  logs `would-block`; the Web reader (its own process, no sandbox) still reads example.com.
- Not covered by Claude's sandbox: the Read tool beyond the `Read(...)` denies, MCP servers and
  hooks (outside the sandbox; `.mcp.json` / hooks are PROTECTED_CONFIG), WebFetch / WebSearch
  (denied; the Web reader is the way to the web). DNS and allowed hosts themselves remain
  possible exfiltration paths. A managed `enabledPlatforms` that leaves macOS out turns the
  sandbox off without an error (seen with a flag setting) — keep it out of the Jamf profile.

## Enforce with Codex (S4, macOS)

- Registry `capabilities.sandbox` = true for Codex (Windows: Codex is not offered there).
  `agents/codex.ts` under enforce (a chat with a working folder, not titles): the thread config
  gets `codexSandboxConfig` (`default_permissions = "acb"`, `features.network_proxy = true`,
  `permissions.acb` = `:workspace` + caches `write` + denied places `deny` + network only the
  allowed hosts) and **no** `sandbox` parameter (a legacy mode in any layer switches profiles
  off). Observe / off: `sandbox: 'workspace-write'` as before.
- Self-check (findings §B.3): `thread/start` and `thread/resume` answer
  `activePermissionProfile` (no experimental API needed, codex-cli 0.153.4). Not `{ id: "acb" }`
  → `stop`: the turn never starts (`SANDBOX_MESSAGES.startFailedStop`); `record-only`: the turn
  runs, the reply starts with the record-only notice. Verified: a `-c sandbox_mode=
  "danger-full-access"` override does not displace the thread's profile; the thread-level
  config wins.
- Logging: a failed `commandExecution` item's `aggregatedOutput` goes through
  `parseSandboxViolation` — Codex's proxy says only `CONNECT tunnel failed, response 403`
  (`proxyRefused`), so the hosts are the ones the command named (`concern === 'host'`); a denied
  place shows as `Operation not permitted`.
- Verified on this Mac (codex-cli 0.153.4, `gpt-5.6-luna`, Jamf developer `requirements.toml`
  present; `command/exec` under the same profile and a real chat turn + resume): api.github.com
  200, generativelanguage.googleapis.com reached (403), example.org refused (curl 56, chat event
  `blocked` + host), `~/.ssh/config` and `~/.aws/config` → `PermissionError`, company folder
  read / append OK, `~/Desktop` write refused, start and resume both report the `acb` profile.
- Not covered by Codex's sandbox: MCP servers, `web_search` (off when the Web reader is on),
  Codex's own traffic. Unverified: the non-developer Jamf `requirements.toml` that bans full
  access (`allowed_sandbox_modes`) together with permission profiles.

Tests: `client/tests/sandbox-codex.test.ts` (enforce sends the profile and never a legacy mode;
observe / off unchanged; a profile not in force stops the turn or runs it with the notice; a
proxy-refused command and a denied read are logged blocked), `client/tests/sandbox-claude.test.ts` (the CLI gets the sandbox and the Read denies
under enforce and nothing under observe / off; start failure → stop sentence or re-run with
the notice; other failures never re-run; the refused host's sentence reaches the AI; Windows
never enforces), `client/tests/sandbox-observe.test.ts` (observe marks hosts and denied places but never
keeps a URL path; nothing without a sandbox; enforce reads the violations, an unrelated
`Operation not permitted` is not the sandbox; a permission-rule refusal with no hook is logged;
the skill; enforce → observe without the capability; the policy store),
`server/tests/integration/agent-events.test.ts` (sandbox / skill / hosts kept, the impact table,
owner/admin only), `server/tests/integration/agent-sandbox.test.ts` (who may read / change, refusals of `*`
/ `~`, a save reaches every member's policy, an override changes only that member, ETag),
`admin/tests/agent-sandbox.test.tsx` (menu and page for owner/admin only, an open-everything
list cannot be saved, what a save sends, an override changes one member),
`client/tests/sandbox-policy.test.ts` (no loosening flags, secret places for Bash / Read /
Codex, company folder and tools stay readable without re-opening a secret, exact host list,
validation refusals, the version floor and that a too-old Codex never starts).
