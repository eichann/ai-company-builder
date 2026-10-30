---
paths:
  - "shared/core/agent-sandbox.ts"
  - "client/shared/agents/sandbox-policy.ts"
  - "client/shared/agents/cli-version.ts"
  - "client/electron/agents/codex-version.ts"
  - "client/tests/sandbox-policy.test.ts"
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

Tests: `client/tests/sandbox-policy.test.ts` (no loosening flags, secret places for Bash / Read /
Codex, company folder and tools stay readable without re-opening a secret, exact host list,
validation refusals, the version floor and that a too-old Codex never starts).
