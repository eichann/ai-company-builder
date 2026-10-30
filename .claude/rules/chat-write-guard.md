---
paths:
  - "client/electron/write-guard.ts"
  - "client/electron/write-access-store.ts"
  - "client/electron/private-read-guard.ts"
  - "client/electron/agents/claude.ts"
  - "client/electron/features/private-folders/guards.ts"
  - "client/shared/write-access.ts"
  - "shared/core/write-access.ts"
  - "client/src/hooks/useWriteAccess.ts"
  - "client/src/shared/ipc/write-access.ts"
  - "client/src/components/skill-ui/ReadOnlyBadge.tsx"
  - "server/src/routes/permissions.ts"
  - "client/tests/write-guard.test.ts"
  - "client/tests/write-access*.test.ts"
  - "client/tests/private-read-guard.test.ts"
  - "client/tests/rule-parity-write-access.test.ts"
---

# Chat write guard (what the AI may write)

The chat runs Claude Code in the member's checkout. Write permission is enforced at push
(`[WRITE_DENIED]`), so an AI edit in a read-only folder used to be rejected at sync and moved to
`.backups/` — "the AI's work vanished". The chat now refuses such edits before they run, and
tells the AI to ask the member instead of retrying. The server check and the sync recovery stay
the safety net. Full text: `docs/architecture/chat-and-agents.md` (internal).

## Where the answer comes from

- Server: `GET /api/companies/:companyId/me/write-access` → `{ version, role, all, scopes: [{
  path, write, private? }] }` (`writeAccessSummary`, `shared/core/permissions.ts`; ETag =
  version, `If-None-Match` → 304). `all: true` for owner/admin or when nothing restricts the
  member; `private: true` marks a readable private folder; unreadable ones are omitted.
- Client: `evaluateWrite` (`shared/core/write-access.ts`, the same code the server uses) decides
  exactly like `resolveAccess` + the push gate: NFC, the deepest listed scope decides, and the
  A–Z-folded spelling must be writable too. Inside a readable private folder the folder part is
  taken in its stored spelling (on a case-insensitive disk `評価/CAFé/x` lands in the clone of
  `評価/café`); of two scopes that differ only in A–Z case, the one sorting first
  (`compareScopePaths`) decides, as the push check does (`foldScopePaths`).
- `client/electron/write-access-store.ts` caches it per company: fetched when a company opens,
  after every successful sync, and at each chat turn (3 s budget, cached answer on failure).
- Parity: `client/tests/rule-parity-write-access.test.ts` (seeded generated companies,
  `RULE_PARITY_SEEDS`, default 600) requires the chat guard's decision from `/me/write-access` +
  `/me/scopes` + `paths/check` to equal the push gate, `[RESERVED_PATH]` and the scope-repository
  gate, independent of scope order.

## The hook (`client/electron/write-guard.ts` + PreToolUse in `agents/claude.ts`)

- Denies `Write` / `Edit` / `MultiEdit` / `NotebookEdit`, and best-effort Bash `>` / `>>` / `&>`
  / `tee` to a literal path, whose target resolves inside the company root to a read-only
  folder, with a Japanese reason. Hooks run in every permission mode (bypass included) and for
  subagents. The api-key mode's `writeFile` / `executeCommand` use the same check.
- Checked first, regardless of write access: a folder **not downloaded** on this computer
  (`WriteGuard.getNotDownloaded`) →
  「このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。」
- AI instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`) are refused unless the
  member may change them (owner/admin; a manager inside their department), mirroring the push
  checker (`mayChangeInstructionFile`).
- External repositories go to `.workspace/` (never shared): Bash `git clone` / `gh repo clone`
  and a new `git init` whose target resolves inside the company folder outside `.workspace/<x>`
  are refused (`checkGitClone`; re-initialising the company folder itself is allowed), with a
  `.workspace/<name>` suggestion. The chat's system prompt says so first
  (`externalRepositoryInstruction`, also in api-key mode). Sync's nested-repository step is the
  safety net: such a repository is kept on that computer by default (`sync-guards.md`).
  Tests: `client/tests/write-guard.test.ts`.
- Private folders (`WriteGuard.getPrivateFolders`): creating something at a name the member may
  not use (`decideReservedWrite`, via sync's cached `paths/check`, the target asked as a file too)
  → 「『<what the AI typed>』というフォルダ名は使えません。別の名前にしてください。」; a write into a
  private folder the member may only read (`canWrite: false` from the cached `/me/scopes`) → the
  read-only message. Writable private folders follow `/me/write-access`.
- Private-read guard (`private-read-guard.ts`, pure; fed by the hooks in `agents/claude.ts` and
  `chat-server.ts`): once a conversation has *read* something inside a private folder (locally or
  via `company_read_file` / `company_search`), the app asks the member before the AI writes into
  a public place of the company or sends anything out (web, MCP, the app's 「Web で調べる」
  `mcp__acb_web__web_research`, whose question goes out — `web-research.md`). Best-effort by design (Bash it
  cannot parse, scripts, a resumed conversation can slip past); the server's `[RESERVED_PATH]`
  keeps private content out of the company repository either way.

## Decisions and limits

- Claude Code permission deny rules (`disallowedTools: ['Edit(...)']`) are deliberately not used:
  deny beats allow, so a writable folder inside a read-only one cannot be expressed; matching is
  case/NFD-sensitive; and the provider ignores `disallowedTools` whenever `allowedTools` is set.
- Not covered: other Bash writes (`cp`, `mv`, `sed -i`, scripts, `cd x && … > y`) and Codex.
  Unknown access (offline, server error) blocks nothing and is logged. Paths are judged
  lexically (no symlink resolution).
- Renderer: `useWriteAccess` + `ReadOnlyBadge` (Phosphor `Lock`, 閲覧のみ) in the file tree
  (where read-only starts) and above the open file. It reads the access through
  `src/shared/ipc/write-access.ts` (`WriteAccessReads`); a window without that API (preview
  pages) shows nothing read-only.
