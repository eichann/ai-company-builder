---
paths:
  - "client/electron/agents/**"
  - "client/shared/agents/**"
  - "client/shared/agent.ts"
  - "client/tests/agent-registry*.test.ts"
  - "client/electron/handoff/**"
  - "client/electron/voice-formatter.ts"
  - "client/electron/chat-server.ts"
  - "client/electron/chat-turns.ts"
  - "client/electron/chat-tools.ts"
  - "client/electron/agent-interactions.ts"
  - "client/electron/claude-oneshot.ts"
  - "client/electron/features/chat/**"
  - "client/electron/features/agent-interactions/**"
  - "client/electron/services/claude-cli.ts"
  - "client/electron/services/agent-events.ts"
  - "client/tests/agent-events.test.ts"
  - "client/tests/agent-tool-events.test.ts"
  - "client/shared/choice-prompt.ts"
  - "client/shared/steer.ts"
  - "client/shared/prompt-suggestion.ts"
  - "client/shared/rate-limits.ts"
  - "client/shared/agent*.ts"
  - "client/src/lib/aiModels.ts"
  - "client/src/components/chat/ChoicePrompt.tsx"
  - "client/src/components/chat/RateLimitMeter.tsx"
  - "client/src/components/chat/promptSuggestion.ts"
  - "client/src/components/chat/ghostSuggestion.ts"
  - "client/src/components/chat/SteerInstruction.tsx"
  - "client/tests/choice-prompt*"
  - "client/tests/steering.test.ts"
  - "client/tests/prompt-suggestion.test.ts"
  - "client/tests/chat-composer-ui.*"
  - "client/electron/review/**"
  - "client/shared/review-request.ts"
  - "client/src/components/chat/ReviewRequestCard.tsx"
  - "client/tests/review-request.test.ts"
---

# Chat agents (Claude Code, Codex)

The chat runs the member's own Claude Code or Codex (or the API key) in their checkout of the
company repository. Agents, models and what each agent can do come from the agent registry;
callers ask capabilities instead of branching on agent ids. Related: `chat-write-guard.md` (what the AI may write),
`company-files.md` (read-only server files), `chat-ui-and-history.md`. Full text:
`docs/architecture/chat-and-agents.md`, `agent-registry.md` (internal).

## Agent registry (R4)

- `client/shared/agents/registry.ts` (pure; main, renderer and tests import it): per agent id
  (`claude-code` / `codex` / `api-key`; `AuthMode` is an alias of `AgentId`) → labels, models
  (id, label, efforts, context, exact CLI string), defaults (Opus 5.5 + medium), the model per
  job (`tasks`: chat / title / commitMessage / voice / handoff / webReader) and `capabilities`
  (ownsConversation, steering, promptSuggestions, choicePrompts, subagentProgress, rateLimits,
  imageInput, companyFilesMcp, references, writeGuard, privateReadGuard, handoff, oneShotText,
  webReader, commitMessageFallback, privateFolderCommitMessages, liveModelCatalog).
- **Every model id lives there.** `client/tests/agent-registry.test.ts` pins today's strings and
  fails on a model id literal anywhere under `client/electron`, `client/src`, `client/shared`.
  A model generation update is a registry-only change. (The API-key mode deliberately uses
  `claude-haiku-5-5` for commit messages but `claude-haiku-4-5-20251001` for voice and titles.)
- `client/electron/agents/registry.ts` is how each agent starts: `createAgentConnection(id,
  host, profile?)`, `runOneShotText(id, request)` (commit messages, voice formatting),
  `oneShotUnavailable(id, host)`, `writeAgentHandoff(id, request, host)`, `runWebReader(id,
  request)` (「Web で調べる」's reader, `web-research.md`).
  `client/tests/agent-registry-factories.test.ts`: every capability-gated factory an agent claims
  exists, and none it does not.
- Role profiles (`AgentProfile`: role, allowedTools, settingSources, sandbox, cwd) on a chat
  connection: no agent implements one, so any set field throws — a caller can never believe a
  restriction is in force when it is not. Implement a profile inside the agent's factory;
  callers stay agent-agnostic. The Web reader is not a profile: it is a one-shot job with its
  restrictions built in (`runWebReader`, `agents/web-reader.ts`).
- Commit messages: the member's agent, then `commitMessageFallback` agents in registry order
  (Claude Code, API key — Codex is never picked on the member's behalf); a private folder's clone
  only `privateFolderCommitMessages` (the API key). Voice formatting: the member's agent only.
- Renderer: `agentCan(id, cap)`, `hasRateLimits(id)`, `agentShortLabel(id)`; subagent rows read
  `parentToolCallId` from any provider's metadata. Per-agent UI stays per agent on purpose: the
  sign-in cards (`ChatAuthSettings.tsx`) and header model pickers (`ChatHeader.tsx`).
- Adding an agent: (1) its id in `AuthMode` (`client/shared/agent.ts`); (2) its descriptor in
  `shared/agents/registry.ts` (`AGENT_IDS` + `AGENTS`); (3) its connection in
  `electron/agents/<agent>.ts` (`AgentConnection`, plus one-shot / hand-off writers for the
  capabilities it claims); (4) its factories in `electron/agents/registry.ts`; (5) its sign-in
  card in `ChatAuthSettings.tsx` (and a header picker if its models are neither a static list nor
  a live catalog). Then fix what `tsc` flags (the literal `setAuthMode` param types in
  `preload.ts` / `features/settings/ipc.ts`; regenerate `ipc-inventory.json` with
  `UPDATE_IPC_INVENTORY=1`) and run `agent-registry*.test.ts`.

## The AI's environment (allowlist)

`client/electron/agents/agent-env.ts`; tests `client/tests/agent-env.test.ts`.

- AI processes never get the member's whole shell environment (a secret exported there —
  `AWS_*`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, database URLs — would be readable by the AI and every
  command / MCP server it starts). `agentEnv()` keeps an allowlist: PATH, HOME, USER, LOGNAME,
  SHELL, TMPDIR/TEMP/TMP, LANG/LANGUAGE/`LC_*`, TERM/COLORTERM, TZ, `XDG_*`, SSH_AUTH_SOCK,
  GIT_SSH(_COMMAND), the proxy variables (either case), NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
  SSL_CERT_DIR / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE, CLAUDE_CONFIG_DIR, CODEX_HOME,
  `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `ACB_*`, FORCE_COLOR, and the Windows essentials
  (SystemRoot, ComSpec, PATHEXT, APPDATA, LOCALAPPDATA, USERPROFILE, ProgramFiles*, WINDIR, …).
  Names compare case-insensitively. The CLIs sign in with their own stored login, not env.
- Precedence: `ACB_SET_KEYS` (what the app / SDK set) always kept → deny always dropped (`TOKEN`,
  `SECRET`, `PASSWORD`, `PASSPHRASE`, `CREDENTIAL`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`,
  `COOKIE`, `DATABASE_URL`, … anywhere; `_KEY` / `_DSN` / `_PAT` endings; `AWS_`, `AZURE_`,
  `GOOGLE_APPLICATION_`; CLAUDECODE, REDIS_URL, …) → allowlist or the member's pass-through
  names kept → the rest dropped. A key the app starts setting that a deny rule matches goes into
  `ACB_SET_KEYS`.
- One place: `spawnAgentProcess` (`agents/process.ts`) filters the final env — after the provider
  (which merges `ANTHROPIC_*` / `AWS_*` / `GOOGLE_*` from `process.env`) and the SDK — so Claude
  Code (chat, titles, prompt suggestions, hand-off) and Codex (chat, one-shots, status) are covered.
  `runClaudeOneShot` (commit messages, voice) spawns with `inheritEnv: false` through the same
  function, and so do the API-key mode's commands (`chat-tools.ts`). Sync's git env is separate.
- Escape hatch: Settings → AIに渡す環境変数 (`config.json` `agentEnvPassthrough`, this computer
  only; `config:get/setAgentEnvPassthrough`): exact names, ≤ 50, deny still wins; empty by
  default; the page says these become visible to the AI.
- Dropped names (never values) are logged once each per app start: `[agent-env] not passed to AI
  processes: …`.

## Project config the agents load from the company folder

- Claude Code: `settingSources: ['user', 'project']` — `.claude/settings*.json`, `.mcp.json`,
  `.claude/hooks/`, skills / agents / commands. Codex: every `.codex/` between the project root
  and `cwd` (`config.toml`, `hooks.json`, `rules/`), but only when the member has trusted the
  folder in Codex (`[projects."<path>"] trust_level` in their `~/.codex/config.toml`); the app
  never sets trust, and `thread/start` passes `sandbox` / `approvalPolicy` / `mcp_servers` but
  nothing that turns the project layer off. Codex documents no key or flag that ignores a trusted
  project's `.codex/` (`project_root_markers` only changes root detection), so the app leaves it
  loading; shared config is legitimate when an owner/admin writes it.
- The enforcement is the push checker: these paths are `[PROTECTED_CONFIG]` (owner/admin only,
  `push-check.md`). The chat write guard does not refuse AI edits to them (only instruction
  files); a member's AI edit is caught at sync by the protected-config dialog. `AGENTS.md` /
  `AGENTS.override.md` are instruction files (`chat-write-guard.md`).

## Claude Code agent stack

- `@anthropic-ai/claude-agent-sdk` 0.3.304 (its `claudeCodeVersion` is CLI 2.1.304) under
  `ai-sdk-provider-claude-code` 3.6.1, the AI SDK v6 line (npm tag `ai-sdk-v6`); provider 4.x
  needs AI SDK 7. The provider pins its own SDK exactly, so root `package.json` `pnpm.overrides`
  keeps one SDK copy at the app's version: bump both together. The provider accepts `auto`
  natively.
- The SDK peers on `@modelcontextprotocol/sdk` ^1.29 (in-process MCP servers) and
  `@anthropic-ai/sdk` (types only).
- The app never runs the SDK's bundled CLI: every `query` / `claudeCode(...)` passes
  `pathToClaudeCodeExecutable` (the member's own `claude`, `services/claude-cli.ts`). `vite build`
  bundles the SDK into `dist-electron`; its per-platform native binaries (~250 MB) are excluded
  in `client/package.json` `build.files`.
- `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` warnings (for `allowedTools` MCP tools and bypass mode)
  are informational: AskUserQuestion still reaches `canUseTool` in bypass.
- The provider drops `rate_limit_event` and `system/task_progress`, so `claude.ts` taps the SDK
  Query in `onQueryCreated` (`tapSdkMessages`), composed with the steering tap (`tapQuery`) in the
  same callback — keep both when editing it. Agents report through `onEvent`; the chat server
  sends *transient* data parts (`data-rate-limits`, `data-agent-progress`, handled in the
  renderer's `useStreamingChat`, never stored) and keeps the latest usage per agent for `GET /api/rate-limits`
  (agents with `capabilities.rateLimits`). Choice prompts, steering, suggestions, rate limits and
  subagent progress are gated by capabilities in `chat-server.ts`.
- Usage meter (`client/shared/rate-limits.ts`, `RateLimitMeter.tsx`): Claude's windows come in
  the undocumented `rate_limit_info.unifiedWindows`, `utilization` as a fraction (0.24 = 24%);
  Codex from `account/rateLimits/read` once per turn plus `account/rateLimits/updated`
  (`usedPercent` 0–100, windows by `windowDurationMins`). No event → "unknown". No cost display
  (owner's decision).
- `agentProgressSummaries: true`: the running subagent row shows the latest
  `task_progress.summary` (`tool_use_id` = the Agent call). Codex has no subagent rows.
- Defaults for members who never chose come from the registry (Opus 5.5 + effort medium;
  `src/lib/aiModels.ts` is a view of the Claude Code entry); only an explicit choice is saved;
  Codex keeps its own default effort.
- Settings sources are `['user', 'project']`; that is why shared agent config is protected at
  push (`push-check.md`).
- 「Web で調べる」 (`web-research.md`): agents with `webReader` get the app tool `web_research`
  (`acb_web`) and lose their own web tools — Claude through flag `settings: { permissions: {
  deny: ['WebFetch', 'WebSearch'] } }` (whole session, subagents too), Codex through
  `web_search: 'disabled'` in the thread config. A separate reader (the member's agent on its
  strong chat model, web tools only, no settings, empty temp folder) reads the web and digs into
  linked pages.

## Choice prompts (the AI asks, the member picks)

Types and answer mapping: `client/shared/choice-prompt.ts`; glue: `agents/choice-tools.ts`.

- Claude Code: built-in `AskUserQuestion` (`questions[]` of `{ question, header,
  options[{ label, description }], multiSelect }`). The CLI routes it through `canUseTool` in
  every permission mode, bypass included, so `claude.ts` installs `canUseTool` whenever the turn
  can show a card (in bypass it refuses everything else). Answer = `allow` with
  `updatedInput: { ...input, answers }`, keyed by **question text**, multiSelect labels and
  「その他」 text joined with `", "` (verified against CLI 2.1.304). No answer = `deny` with a
  message telling the model not to guess or re-ask.
- Codex: the app serves `ask_user` (same shape) from a request-scoped loopback MCP server
  `acb_ask` (`tool_timeout_sec` 660); developer instructions tell Codex to use it; the turn's
  15-minute limit pauses while the member answers. Codex's own `item/tool/requestUserInput`
  keeps its older card.
- Flow: `chat-server.ts` `createAskUser` → `requestInteraction` (`AgentInteractions`, kind
  `choices`, per renderer + conversation, 10-minute timeout; a stopped turn or closed window
  cancels with a reason) → `ChoicePrompt.tsx` above the composer (radio / checkboxes, 「その他」,
  「回答する」, ⌘/Ctrl+Enter). The outcome is injected as a `data-choice-prompt` part
  (`createChunkInjector`), stored as `choicePrompts` (with `at`, the offset in `content`), and
  `agentInputMessages` turns it into text when the conversation moves to another agent.
- History records of choice prompts and extra instructions carry `at` (offset in `content`) and
  `seq` (their place among the reply's questions and instructions, live order). At the same `at`,
  `seq` decides; records without `seq` (older history) keep the stored order.
- The dangerous-command approval banner (`tool-approval-request`) is a separate channel; both can
  show at once. Pending cards survive tab switches; closing the tab cancels them.
- Preview `client/tests/choice-prompt-ui.html` (`?theme=dark`, `?state=answered`); tests
  `client/tests/choice-prompt.test.ts`.

## 「確認をお願いする」 (the AI hands its work to the member and stops)

`client/shared/review-request.ts` (limits, paths, the record), `electron/review/tools.ts` (the
tool), renderer `ReviewRequestCard.tsx`, `src/lib/reviewRequest.ts`.

- The app tool `request_review` on MCP server `acb_review` (`mcp__acb_review__request_review`):
  Claude Code gets it as an in-process SDK MCP server (in `allowedTools`, auto-allowed in
  `canUseTool`, never asks), Codex as a request-scoped loopback endpoint closed with the turn.
  Only when `connection.ownsConversation` and there is a working folder; `REVIEW_INSTRUCTIONS`
  is appended to the system prompt. M1 logs it as an app tool (server + tool name, never text).
- Input: `title` (required, ≤ 120), `files` (≤ 10, company-relative; an absolute path is
  accepted only inside the company folder, `..` / `~` / outside → refused), `points` (≤ 5),
  `message`. **Non-blocking (owner decision 2026-10-29):** the call checks its input and returns
  at once, telling the AI to stop and end its reply; nothing is written anywhere.
- When the AI should call it: a skill says to get the member's confirmation before going on
  (the main use: e.g. 「骨子ができたら request_review で確認を頼んで止まる」, with the tool in
  the skill's allowed tools), the member asked to see something first, or a document others will
  read is complete and involves a judgement. Not otherwise — 「あなたの番」 must stay meaningful.
  Following it is up to the model; a skill that needs a hard stop must not rely on it alone.
- An accepted request is injected as a `data-review-request` part (`createChunkInjector`) and
  stored with the reply as `reviewRequests`, so the card and 「あなたの番」 survive a restart.
  The latest reply's request is pending until the member sends anything: 「この内容で進めて」
  sends `REVIEW_CONFIRM_MESSAGE`, 「直してほしい」 focuses the composer, a file opens in the
  editor (`OpenFileContext`, the main screen's opener). Tests: `client/tests/review-request.test.ts`,
  `tests/ui/chat-panel.spec.ts`.

## Instructions while the AI works (steering)

`client/shared/steer.ts`, `agents/steering.ts`, `chat-turns.ts`; renderer side `useSteering` /
`useQueuedSendFlush` (`chat-ui-and-history.md`).

- During a turn the input stays enabled; sending does not stop the AI. The renderer posts
  `POST /api/steer { appSessionId, text }`; the turn's `TurnSteering` hands it to the agent; it is
  shown as the member's bubble 「作業中に追加した指示」 (`data-steer`, history `steerInstructions`
  with `at`).
- Claude Code runs with `streamingInput: 'always'`; each instruction is a streamed user message
  with its own uuid (`query.streamInput`, started lazily; ending that iterable closes the CLI's
  stdin, so it ends only with the query). Delivery is read from `command_lifecycle` (`started`)
  and `result.user_message_uuids` (when the CLI advertises `msg_lifecycle_v1`; otherwise it counts
  as delivered). The provider stops at the first `result`, so a late instruction is
  `not-delivered`: `cancelAsyncMessage`, and if the CLI already started it as its own turn, that
  turn is `interrupt`ed before it runs tools; the renderer then sends the text as the next message.
- Codex: `turn/steer { threadId, expectedTurnId, input }` while the turn is active; an error =
  `not-delivered`.
- Fallback (an agent without `capabilities.steering` — the api-key mode —, attachments, slash commands, no attached turn yet, `unavailable` /
  `not-delivered`): the message waits (「応答が終わったら送ります：…」, 取り消す puts it back) and
  all waiting messages go out as one when the turn ends; after a stop or error they return to the
  input. Choice prompts, approvals and both write guards work unchanged under streaming input.

## Next-prompt suggestions (Claude Code only)

`client/shared/prompt-suggestion.ts`; rules `src/components/chat/promptSuggestion.ts`; ghost text
`ghostSuggestion.ts` (CodeMirror).

- `promptSuggestions: true` + the provider's `onPromptSuggestion`. The CLI sends
  `prompt_suggestion` ~1 s after the result, after the UI stream closed, so the renderer asks
  `GET /api/prompt-suggestion/:appSessionId` after a finished turn (waits ≤ 15 s). The CLI stays
  silent on a first reply without tool use, when nothing is obvious, after errors, or with the
  member's `promptSuggestionEnabled: false`. The app spawns it with
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true`, otherwise it also stops near the plan's usage limit.
  The chat server logs only whether a suggestion came, never its text.
- `agents/recovery.ts` lets the native model finish when its stream ends normally: the provider
  keeps reading after closing the stream, and aborting there killed the CLI before the suggestion.
- Settings → 入力候補 「次の質問の候補を表示する」 (`src/lib/promptSuggestionSetting.ts`, on by
  default): off → requests send `promptSuggestions: false` and the CLI is not asked.
- Shown as ghost text in the empty, idle input with no card/approval waiting. → or Tab (caret at
  the end) accepts; Enter stays a newline, ⌘+Enter sends; typing along keeps the rest; anything
  else or Esc dismisses. One per turn. Screen readers: `aria-describedby` + a polite live region.
- Preview `client/tests/chat-composer-ui.html` (`?theme=dark`, `?suggestion=…`); tests
  `client/tests/prompt-suggestion.test.ts`, `client/tests/steering.test.ts`.

## AI action log (monitoring M1) and turn abort handles (M2)

Tracker and target rules `client/shared/agent-events.ts` (pure); the event shape itself is the
wire contract in `shared/types/agent-events.ts`, re-exported (the server's side:
`agent-events.md`); tests `client/tests/agent-events.test.ts` (every tracker event passes the
server's `parseAgentToolEvent` unchanged), `client/tests/agent-tool-events.test.ts`. Sending to
the server: `agent-events.md` ("Sending from the app").

- **One event per tool call** (`AgentToolEvent`, `version: 1`): id, callId (tool_use_id / Codex
  item id), at, durationMs, conversationId (appSessionId), turnId, companyId, department (the
  chat's active department folder), agent, model,
  subagentType, tool, category (read / write / command / web / mcp-external / app-tool /
  subagent / question / other), target, decision (auto-allowed / member-allowed / member-denied /
  guard-denied / policy-default / policy-denied / stopped), guardReason (a code such as
  `read-only-folder`, `not-downloaded`, `reserved-path`, `private-read`, `dangerous-command` —
  never the message), outcome (ok / error / unfinished). Emitted once the call is over: a refusal
  at once (no outcome), an allowed call with its result, anything still open when the turn ends
  as `unfinished`.
- **Metadata only.** `describeTarget` is the only reader of a tool input: company-relative NFC
  paths (outside the company only `{ kind: 'outside' }`, plus `sensitive`: ssh / env-file /
  keychain / credentials / app-data — never the path), program name + subcommand for a short
  allowlist (git, npm, pnpm, yarn, bun, pip, uv, brew, docker, gh, cargo, go; `python -m <module>`;
  `npx <package>`; `sh -c '…'` is read inside), `redirect: true` for `>` / `>>` / `&>` / `tee`,
  ≤ 5 programs per compound command, the web host, the MCP server + tool, the subagent type.
  No prompt, content, argument, URL path/query or message — a test feeds secrets and checks the
  serialized events. Categories need no agent id (tool names do not collide); app MCP servers
  (`APP_MCP_SERVERS`) are `app-tool`, `ask_user` / `AskUserQuestion` are `question`, the app's
  `mcp__acb_web__web_research` is `web` (target: the first given URL's host, never the question).
- **Where it is reported.** The host's `onToolEvent` (`AgentHostConfig`, plus `toolEventPaths`
  for home / userData); the chat server only adds `toolEventContext` (company, root, turn id, department) to
  the request. Each turn builds a tracker with `agents/tool-events.ts` `turnToolEvents`; every
  emission is wrapped (a failing recorder never reaches the agent). Translation per agent:
  - Claude (`agents/claude-tool-events.ts`): the PreToolUse hook and canUseTool return a
    `ToolVerdict` (the unchanged CLI answer + its decision) and are recorded at one point each;
    PostToolUse / PostToolUseFailure (outcome, the CLI's `duration_ms`) and PermissionDenied
    (`policy-denied`) are installed when a recorder is set; the query's end closes the turn.
  - Codex (`agents/codex-tool-events.ts`): command / file-change approvals (member's answer,
    paired by `itemId`), `item/started` / `item/completed` (Codex's own policy otherwise;
    `declined` = `policy-denied`; an MCP call's arguments reach only `describeTarget`);
    `finish()` closes the turn.
  - API key (`chat-tools.ts` `logCall`): inside the five tools.
- Limits: a call Claude's auto-mode classifier refuses without the PermissionDenied hook ends as
  `unfinished` (decision `policy-default`); Codex's sandbox decisions are not visible beyond the
  item status; titles, one-shots and hand-off are not logged.
- Recorder `electron/services/agent-events.ts` (created in `main.ts`, injected into
  `features/chat/server-config.ts`): a bounded ring (500) and one `[agent-events]` console line
  per event; its sink `services/agent-event-sender.ts` sends to the server (`agent-events.md`).
- **Turn abort handles** (`chat-turns.ts` `track` / `abort(filter, reason)` / `abortAll`, returned
  by `startChatServer` as `turns`): every response runs under an AbortController that follows the
  request's signal (the renderer's stop) and goes into streamText, so each agent stops its usual
  way. A main-process stop first pushes a transient `data-turn-stopped` part `{ reason }`
  (`stopped-by-admin` / `app-quit`), cancels the conversation's tool approvals
  (`ToolApprovals.cancel`) and choice cards (`AgentInteractions.cancelConversation`), then aborts
  with the reason; the stream ends with an `abort` chunk carrying it (no error shown). Nothing
  calls it in production yet.
