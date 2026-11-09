---
paths:
  - "client/electron/write-guard.ts"
  - "client/electron/write-access-store.ts"
  - "client/electron/private-read-guard.ts"
  - "client/electron/agents/claude.ts"
  - "client/electron/features/private-folders/guards.ts"
  - "client/shared/write-access.ts"
  - "shared/core/write-access.ts"
  - "client/src/shared/hooks/useWriteAccess.ts"
  - "client/src/shared/ipc/write-access.ts"
  - "client/src/shared/ui/ReadOnlyBadge.tsx"
  - "server/src/routes/permissions.ts"
  - "client/tests/write-guard.test.ts"
  - "client/tests/write-access*.test.ts"
  - "client/tests/private-read-guard.test.ts"
  - "client/tests/rule-parity-write-access.test.ts"
  - "client/tests/step-deliverable-folder.test.ts"
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
  version, `If-None-Match` → 304). The server resolves every rule subject (department rules
  included) into `write` per scope, so the app never evaluates a subject itself: released apps
  follow new subjects and membership changes on their next fetch. `all: true` for owner/admin or when nothing restricts the
  member; `private: true` marks a readable private folder; unreadable ones are omitted.
- Client: `evaluateWrite` (`shared/core/write-access.ts`, the same code the server uses) decides
  exactly like `resolveAccess` + the push gate: NFC, the deepest listed scope decides, and the
  spelling a disk folds it to (`diskKey`) must be writable too. Inside a readable private folder the folder part is
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
- **A business plugin step's run or consultation** (`WriteGuard.writeArea`, owner decision
  2026-11-06; `plugin-steps.md` "The deliverable folder"): checked before everything else, every
  write — outside the company folder too — must land inside `<department>/.personal/<folder>/`
  (`insideDeliverableFolder`, `shared/core/plugin-step-runs.ts`: a visible top folder, `.personal`,
  the step's folder, something inside; NFC, A–Z folded), **both as written and where it resolves on
  disk** (`realpathSync` of the deepest existing part, links followed), so a link cannot lead out.
  Else guard reason `deliverable-folder` 「この手順では、AI がファイルを保存できるのは「（部署のフォルダ）
  /.personal/<folder>/」の中だけです…」. The only line for `.personal` (never synced: no server check
  behind it). Bash: literal redirect / `tee` targets as below; an automatic run has no shell at all.
  Test: `client/tests/step-deliverable-folder.test.ts` (mutation-checked).
- Checked first, regardless of write access: a folder **not downloaded** on this computer
  (`WriteGuard.getNotDownloaded`) →
  「このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。」
- AI instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, and the
  `.md` files of `.claude/rules/`) are refused unless the
  member may change them (owner/admin; a manager inside their department), mirroring the push
  checker (`mayChangeInstructionFile`).
- Agent config (`.mcp.json`, `.claude/settings*.json`, `.claude/hooks/`, `.codex/`, and by default
  everything else in `.claude/` and `.agents/` that is neither a skill nor an instruction file:
  `isAgentConfig`, `shared/core/agent-config.ts`) is refused for anyone but owner/admin (guard
  reason `agent-config`, 「…会社のオーナーと管理者だけが変更できます」); unknown authority never
  blocks. The app's own file operations ask the same (`agentConfigRefusal`). Before 2026-11-05
  these edits ran and were caught at sync by the protected-config dialog. Tests:
  `client/tests/write-guard.test.ts`, `client/tests/skill-file-refusal.test.ts`.
- Skill files (everything under `.claude/skills|agents|commands` and `.agents/skills`, `shared/core/skill-files.ts`) are
  refused unless the member may change them (`mayChangeSkillFile`, guard reason `skill-file`):
  owner/admin; a manager inside their department; 「Skill を直せる人」 (`skillEditing` from
  `/me/capabilities`). Unknown authority or a server without `skillEditing` never blocks; neither
  `.workspace/`, `.personal/` nor a skill this member keeps private (`getPrivateSkills`: the lines of
  `.git/info/exclude`) is judged, since none of them is shared. The app's own file operations ask
  the same rule (`files-and-editor.md`). Tests: `client/tests/write-guard.test.ts`,
  `client/tests/skill-file-refusal.test.ts`.
- The company map (`records.md`): `.acb/types/` (type definitions) only for owners/admins
  (unknown authority never blocks; the push checker's rule), guard reason `type-definition`; and
  `decideRecordEdit` refuses Write / Edit / MultiEdit (and the api-key mode's writeFile) that put
  state & co. into a record file's frontmatter or change an existing record's id / type
  (`recordFileEditProblem`), guard reason `record-file` — the AI changes records only through
  its record tools. Tests: `client/tests/records-tools.test.ts`.
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
  - Not public: private folders, `.workspace/`, `.backups/`, outside the company, and anything
    inside a `.personal/` at any depth (never synced, `[PERSONAL_PATH]`; NFC, A–Z-folded,
    lexical — `..` out of it is public again) except the `.gitignore` directly in it (shared).
    Bash asks nothing only when every literal redirect / `tee` target is such a place and
    nothing opaque is in the command (`cp`/`mv`/scripts/interpreters, `cd … >`, a write after a
    heredoc). The body of one heredoc fed to a data sink (`cat > .personal/x.md <<'EOF'`) is
    text, not commands: its words do not trigger a question.
  - Consent per conversation and kind (`write` = public places, `send` = web / MCP / Web で調べる /
    `curl`…): 許可 (`recordPrivateConsent`, in `PrivateReadState.consented`, main memory) stops
    that kind's questions for the rest of the conversation; the other kind still asks once. The
    member's confirm ends with 「許可すると、この会話ではこれ以降は確認しません。」 (not the AI's
    refusal). A new conversation, or one reopened after a restart / new chat
    (`forgetPrivateReads`), asks again. Tests: `client/tests/private-read-guard.test.ts`.

## Companies without the shared company folder (`WriteGuard.folderKind: 'none'`)

In the working folder of a company without the shared folder (`services/working-folders.ts`;
`sync.md` "Companies without the shared company folder") nothing reaches the push checker, so
`checkWritePath` makes only the app's own checks: the step's deliverable folder, agent config
(owner/admin only, as everywhere: what the AI loads and runs), what the company delivered
(`getShelfPaths`: a delivered Skill folder or rule file, as written or where it resolves, for every
role, even owners — guard reason `skill-file` / `instruction-file`, 「…AI は変更できません…」;
`plugins.md` "The Skill shelf in the app") and — in `decideToolWrite` — record
frontmatter. Bash beyond literal redirects and Codex are not covered, as everywhere: the next fetch
puts a changed file back. Instruction texts have no file to protect. Write access, not downloaded, private folders, the member's own instruction and skill
files, type definitions and the git clone / init rule are not judged there; `features/chat/server-config.ts`
builds that guard (no access, no private-folder view). `.claude/settings.json` / `.mcp.json` in such
a folder are the member's own, never shared. The renderer shows no 閲覧のみ there
(`useWriteAccess`). Git companies keep every check. Test: `client/tests/company-without-folder.test.ts`
(mutation-checked).

## Decisions and limits

- Claude Code permission deny rules (`disallowedTools: ['Edit(...)']`) are deliberately not used:
  deny beats allow, so a writable folder inside a read-only one cannot be expressed; matching is
  case/NFD-sensitive; and the provider ignores `disallowedTools` whenever `allowedTools` is set.
- Not covered: other Bash writes (`cp`, `mv`, `sed -i`, scripts, `cd x && … > y`) and Codex —
  also inside a person's step consultation (its deliverable folder holds the file tools and literal
  redirects; the automatic run has no shell).
  Unknown access (offline, server error) blocks nothing and is logged. Paths are judged
  lexically (no symlink resolution).
- Renderer: `useWriteAccess` + `ReadOnlyBadge` (Phosphor `Lock`, 閲覧のみ) in the file tree
  (where read-only starts) and above the open file. It reads the access through
  `src/shared/ipc/write-access.ts` (`WriteAccessReads`); a window without that API (preview
  pages) shows nothing read-only.
