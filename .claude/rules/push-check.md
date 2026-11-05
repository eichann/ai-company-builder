---
paths:
  - "server/src/lib/push-check/**"
  - "server/src/templates/**"
  - "server/src/lib/git-server/**"
  - "server/src/routes/git-http.ts"
  - "server/src/routes/git.ts"
  - "server/src/lib/push-rejections.ts"
  - "server/src/services/push-rejections.ts"
  - "server/src/lib/git-exec.ts"
  - "server/tests/fixtures/**"
  - "server/tests/integration/*-hook.test.ts"
  - "server/tests/integration/push-check-*.test.ts"
  - "server/tests/integration/hook-locale.test.ts"
  - "server/tests/integration/bare-repo-config.test.ts"
  - "server/tests/unit/push-check.test.ts"
---

# The push checker (pre-receive hook)

Sync shares nearly everything a member writes with the whole company, and the chat runs Claude
Code / Codex inside that shared checkout. The push checker is where the server decides what may
land. Client-side checks only improve the experience; this is the enforcement. Full rationale per
rule (the guards table rows): `docs/architecture/sync.md` (internal).

## Structure

- Every push decision lives in `server/src/lib/push-check/`: rules in `rules.ts`, messages in
  `report.ts`, write policy in `policy.ts`, git plumbing in `git.ts`, `check.ts` / `entry.ts`.
- `server/src/templates/pre-receive-hook.sh` is a thin caller: it pins `export LC_ALL=C` and runs
  `entry.ts` with the server's node + tsx loader (absolute paths baked in by
  `lib/git-server/hook.ts`, re-rendered at every API startup — a hook change needs a restart).
- It **fails closed**: any exit other than accept/reject, including the checker not starting,
  rejects with `[HOOK_ERROR]`; the client retries via `PENDING_PUSH`.
- Git output is handled as byte strings (latin1): matching is bytewise with A–Z-only case
  folding, exactly like the shell tools under `LC_ALL=C`, on every host. The old shell hook
  followed the inherited locale and rejected ordinary Japanese names with `WINPATH_DETECTED` on
  macOS. Non-ASCII case pairs (`Ａ`/`ａ`) do not fold in those bytewise rules, as production never
  did; what a disk folds is the next point.
- **Look-alikes** (2026-11-05, review of B-H2): `.claude/ſkills/x` (U+017F), `.mcp.jſon`,
  `.claude/hooKs/x` (U+212A) are other paths to git and the bytewise rules, and the real ones on a
  Mac: APFS folds them. Two keys in `shared/core/paths.ts`: `lookalikeKey` (NFKC + Unicode case
  folding, default-ignorables gone) for names that are protected — `namesProtected` applies it to
  agent config, instruction files, type definitions, skill files and the auto-run check, the listed
  path staying the pushed spelling; `diskKey` (what APFS does and nothing more: `（1）` / `(1)`, ı / i, ⭐️ / ⭐ and 葛󠄀城 /
  葛城 stay two files; `client/tests/disk-key.test.ts` walks every cased character on a Mac) for the
  write gate's second pass, reserved private paths and `diskCollisions`. Over-folding refuses
  ordinary names and stops a member's sync. `.personal` / `.backups` are not
  folded: nothing is granted there. Test: `skill-files-hook.test.ts`.
  `foldAsciiCase` / `INSTRUCTION_FILE_RE` in `rules.ts` are bytewise twins of `shared/core`
  (`shared-core.md`).
- The legacy shell hook stays at `server/tests/fixtures/pre-receive-hook.legacy.sh`;
  `push-check-differential.test.ts` requires identical stdout / stderr / exit status on a corpus,
  except two intended changes, each with its own expectation helper: secrets in intermediate
  commits (`attemptSecretOnlyInIntermediateCommit`) and Codex's project layer
  (`attemptNewlyProtected`: owner/admin identical, other roles rejected with exactly the listed
  paths; the skill files rule and the default-deny of `.claude/` / `.agents/` below go through
  the same helper). Rules the legacy hook never had (instruction files, `.backups/`, write permission,
  reserved paths) stay out of that corpus and have their own tests. `hook-locale.test.ts` pushes
  under UTF-8 locales.

## Messages are a wire format

Released apps parse the output. Keep markers and line shapes byte-for-byte; add new behaviour
under a new marker together with a client recovery (an unknown marker leaves old apps retrying
forever — the "permanently unable to sync" shape).

- Path sections: the marker line, then `  - <path>` lines up to the second separator after it;
  explanation / reason lines never start with `- `. Example:
  `[WRITE_DENIED] 変更する権限のないファイルが含まれています`, then the paths.
- Markers (`report.ts`): `[SECRET_DETECTED]`, `[PROTECTED_CONFIG]`, `[WRITE_DENIED]`,
  `[PERSONAL_PATH]`, `[LOCAL_ONLY_PATH]`, `[RESERVED_PATH]`, `[WINPATH_DETECTED]`,
  `[GITLINK_DETECTED]`, `[HOOK_ERROR]`. Client recovery for each: `sync.md` "Push results".
- Rejections are recorded in `push_rejections` from the response: parsed by
  `lib/push-rejections.ts` (pure), recorded off the request by `services/push-rejections.ts`
  (`observe`, never throws) through `PushRejectionRepository`.

## Who is pushing, and the snapshot

- The checker reads no database (it also runs in the client's sync harness). git-http — the code
  that authenticated the pusher (session via `AccountDirectory.bySessionToken`, membership via the
  access policy, managed folders via `permission-views`) — sets `ACB_PUSHER_ROLE` / `ACB_PUSHER_ID` / `ACB_PUSHER_EMAIL`,
  `ACB_NODE`, and writes a per-request **snapshot** (pusher, scopes, rules, managed folders,
  `skillEditing` (「Skill を直せる人」: `{ everywhere, folders }`), reserved paths, `scopePath` for a scope repo; 0600 temp file, path in `ACB_PUSH_POLICY`,
  removed when the request ends; `preparePushCheck` in `lib/git-server`).
- A snapshot is always enforced; an unreadable one rejects with `[HOOK_ERROR]`; no resolvable
  pusher denies every changed path unless writing is open to everyone.
- The server's own pushes (department folders, company creation) carry `ACB_INTERNAL_PUSH=1`
  (`internalGitEnv`) and skip the write check and the skill files rule (a department renamed or
  deleted by an owner/admin moves the skills in it; `serverPush` needs the marker and no snapshot,
  so a member's push can never claim it). The other protected rules still see no role: a department
  holding `CLAUDE.md`, `.claude/settings.json` or a skill with auto-run parts cannot be renamed or
  deleted (known gap, not new). They are commits built in the bare
  repository and pushed from it to itself (`lib/bare-commit.ts`), so receive-pack runs this hook
  on them like on any push: every other content rule applies. git-http strips both variables from what it
  inherits, so a client cannot select either. Local-transport pushes (tests, an operator) carry
  neither and are not write-checked.

## Range

Rules look at every commit new to the server plus the net `old..new` diff, so a change undone in
a later commit still blocks through its intermediate commit (clients squash to recover).
Deletions are always allowed except where noted (they are how something gets unshared).

## Rules

- **Protected agent config** (`[PROTECTED_CONFIG]`, owner/admin only): add / modify / delete /
  rename of `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, anything under
  `.claude/hooks/`, a file/symlink named `.claude`, anything under `.codex/`, or a file/symlink
  named `.codex` — any depth, case-insensitive. A missing role fails closed for these paths.
  Why: in non-interactive mode Claude Code runs a project `UserPromptSubmit` hook and starts
  `.mcp.json` stdio servers without a prompt, so any member could run commands on every
  teammate's machine. Codex (0.153) loads every `.codex/` from the project root down to its
  working directory once the member has trusted the folder — `config.toml` (sandbox and
  permission profiles incl. network and file access, MCP servers, inline hooks), `hooks.json`,
  `rules/` — so the whole folder is protected (added 2026-10-25). Sharing an MCP server is
  legitimate, so the rule restricts *who*. Test: `protected-config-hook.test.ts`. The pattern
  is `AGENT_CONFIG_PATTERN` in `shared/core/agent-config.ts` (the app's guards use it too).
- **Default-deny in the agents' folders** (`[PROTECTED_CONFIG]`, their own sub-list, owner/admin
  only; 2026-11-05): everything else in `.claude/` and Codex's `.agents/` (and a file / symlink
  named `.agents`), any depth, A–Z and look-alike folded — except skill files and instruction
  files (below), which keep their wider rules. Why: the named list let new kinds through
  (Codex's repository marketplace `.agents/plugins/marketplace.json`, `.claude/output-styles/`,
  `.claude/agent-memory/` that a subagent's prompt loads, `.claude/launch.json`, a script a
  setting points at such as `.claude/statusline.sh`); a kind a CLI starts to load later is now
  protected the day it appears. Old apps recover from it like any `[PROTECTED_CONFIG]`
  (restore the server's version). Not for the server's own pushes (a department moved by an
  owner/admin carries its `.claude/`). Rollout: a build that says it predates the app's
  leftover handling for these folders (`agentConfigRuleApplies`, `appPredatesAgentConfigRule`
  in the snapshot, `AGENT_CONFIG_RECOVERY_COMMIT_DATE`) is not checked for this part nor for
  `.agents/skills/` (it would share `__pycache__` / `.DS_Store` and be refused at every run);
  no header or an unreadable one is checked. Drop the gate when no such build is left in
  `client_activity`. Rules: `isAgentConfig` (`shared/core/agent-config.ts`), bytewise
  `agentFolderPaths` (`rules.ts`); parity: `client/tests/rule-parity-names.test.ts`. Test:
  `agent-config-hook.test.ts`. Known gap: a setting (`.claude/settings.json`, `.codex/config.toml`)
  that runs a script or plugin directory OUTSIDE these folders makes that file as dangerous as
  the setting; keep what settings run inside `.claude/` / `.codex/`.
- **Skill files** (`[PROTECTED_CONFIG]`, their own sub-list): add / modify / delete / rename of
  anything under `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, and Codex's
  `.agents/skills/` (since the default-deny; the auto-run check reads them too) (any depth, A–Z
  case-insensitive, every file type, a file or link at the folder's own path too): owner/admin
  anywhere; a department manager inside a department they manage; people on
  「Skill を直せる人」 (`skill_editors`: for the whole company, or one department), or everyone with
  write access while the company's one switch 「全員が直せる」 is on (`skill_editing_settings`, off by
  default; the snapshot then says `everywhere`). A department's
  list reaches any depth inside its folder, not root-level skills. In a scope repo the path is
  judged as `<scopePath>/<path>`. Rules: `shared/core/skill-files.ts`. Why (owner decision
  2026-11-04, audit B-H2): a skill's script reaches every member by sync and runs on their
  computer under their account and tokens. Being on a list grants no folder access: the write
  check still applies. Skills already shared keep working; only changes are refused. Rollout: a
  build that says it predates the app's recovery (`skillFileRuleApplies`, `lib/client-version.ts`;
  `appPredatesSkillRule` in the snapshot) is not refused by this rule, since it would loop on a
  `chmod +x` or a `.pyc`. No header or an unreadable one is checked, so a plain `git push` never
  skips it. The hole stays open for such builds until they update; drop the gate when none is left
  in `client_activity`.
  Test: `skill-files-hook.test.ts`; the list: `skill-editors.test.ts`.
- **Auto-run parts of those files**: whoever else may edit the file, a change is owner/admin only
  when the new `.md` blob has frontmatter `hooks`, `mcpServers`, `lspServers` or `monitors` (any YAML spelling: quoted,
  flow, escaped, anchored, nested), a body `!` + backtick where the `!` starts a line or follows
  whitespace, a ```` ```! ```` block — or the entry is a symlink. Then owner/admin only, reported
  in the `[PROTECTED_CONFIG]` section (path line, then a reason line). No masking of fenced code
  (substituted arguments can re-pair backticks). A path listed here is not listed again under
  skill files. Contents unreadable, or `ACB_NODE` unusable →
  every changed path there is rejected for non-admins. The closing advice names who it is for:
  taking the part out helps only someone who may change the file. Text that is not the syntax (`!important`,
  `if ! grep`, prose) passes. Test: `skill-autorun-hook.test.ts`.
- **AI instruction files** (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md` —
  Codex reads it in place of `AGENTS.md` — any depth, case-insensitive; and every `.md` inside
  `.claude/rules/`, which Claude Code loads like CLAUDE.md, since the default-deny): owner/admin anywhere; a department manager inside a department folder they
  manage (`managedFolders` in the snapshot; root-level ones owner/admin only — owner decision
  案B). Others are rejected in their own sub-list of `[PROTECTED_CONFIG]`, which current apps
  already recover from. In a scope repo the path is judged as `<scopePath>/<path>`. Why: these
  files steer every teammate's AI in that folder. `CLAUDE.local.md` is protected the same way
  because once committed it loads for everyone.
- **Type definitions** (`.acb/types/` at the repository root, or a file / symlink named `.acb`
  there; case-insensitive): owner/admin only, in their own sub-list of `[PROTECTED_CONFIG]`
  (existing client recovery). For everyone, owner/admin included, a net change to an
  `.acb/types/<name>.md` that removes or renames something (`compareTypeDefinitions`,
  `shared/core/record-types.ts`) is refused in a further sub-list, a reason line under each path;
  only definitions that parse before and after are compared, a read failure rejects them. Not run
  in private folders' repositories. Why and the rest: `records.md`. Test:
  `tests/integration/records.test.ts`.
- **`.personal/`** (`[PERSONAL_PATH]`, everyone incl. owner/admin): adding or modifying a file
  inside a directory named `.personal` at any depth. Exceptions: the `.gitignore` directly inside
  a `.personal/` (the server writes it), and deletions. Test: `personal-path-hook.test.ts`.
- **`.backups/` / `.workspace/`** (`[LOCAL_ONLY_PATH]`, everyone): adding or modifying anything
  inside them at any depth (conflict copies and the AI's scratch / cloned repos). A separate
  marker because old apps' `PERSONAL_PATH` recovery refuses non-`.personal/` paths.
- **Secrets** (`[SECRET_DETECTED]`): added lines of each commit in `rev-list <new> --not --all`
  (first parent; merges as combined diffs; root commits against the empty tree) plus the net diff,
  one `diff-tree --stdin -p` stream, deduplicated per file × pattern. New branches: whole content
  of the tip's files. 200 commits / 50,000 lines check in under a second
  (`push-check-performance.test.ts`); `secret-scan-hook.test.ts`.
- **Write permission** (`[WRITE_DENIED]`): every changed path (adds, edits, deletes, both sides
  of a rename) must pass `resolveAccess(pusher, path).write` (`shared/core/permissions.ts`), also
  as a disk folds it (`diskKey`: macOS/Windows check `Sales/x` and `ſales/x` out into `sales/`); owner/admin always pass;
  scopes sorted with `foldScopePaths` so row order never matters. The company repo's check
  ignores private scopes. Test: `write-permission-hook.test.ts`.
- **Reserved private paths** (`[RESERVED_PATH]`, everyone): see `private-folders.md`.
- Also checked: Windows-invalid / case-colliding paths (`[WINPATH_DETECTED]`) and gitlinks
  (`[GITLINK_DETECTED]`). The collision check also refuses a path this push adds when a disk folds
  it, at any folder level, onto another spelling in the tree (`diskCollisions`, same entry shape,
  everyone included). Only when the added path itself creates the pair: a pair already in a
  repository stops nobody, a new file inside a folder of one included; two spellings of one NFC path
  (a Mac's NFD) are not a collision. The app names the file (`winPathMessage`, `path_name`).

## Bare repositories (`lib/git-server/index.ts`, `repo-config.ts`)

- `configureBareRepo` (re-exported by `routes/git.ts`) sets `receive.denyNonFastForwards`,
  `receive.denyDeletes`, partial-clone upload-pack options, and installs the hook — at creation
  and for every repository at startup. Shared history is the team's only copy; only an auth
  failure once stopped a diverged client's `push --force-with-lease`. Test:
  `bare-repo-config.test.ts`.
- Startup-time `configureBareRepo` is the one allowed synchronous exec in `server/src`
  (`tests/security/no-exec-sync.test.ts`); request paths use async `execFile` (`git-exec.ts`).
