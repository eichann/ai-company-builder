---
paths:
  - "client/electron/agents/**"
  - "client/electron/chat-server.ts"
  - "client/electron/chat-turns.ts"
  - "client/electron/chat-tools.ts"
  - "client/electron/agent-interactions.ts"
  - "client/electron/claude-oneshot.ts"
  - "client/electron/features/chat/**"
  - "client/electron/features/agent-interactions/**"
  - "client/electron/services/claude-cli.ts"
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
---

# Chat agents (Claude Code, Codex)

The chat runs the member's own Claude Code or Codex in their checkout of the company repository.
Pick agents, models and defaults through `client/electron/agents/` and `client/src/lib/aiModels.ts`
rather than branching on vendor names in callers; when an agent registry is introduced, it
becomes the one place to add a vendor. Related: `chat-write-guard.md` (what the AI may write),
`company-files.md` (read-only server files), `chat-ui-and-history.md`. Full text:
`docs/architecture/chat-and-agents.md` (internal).

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
  sends *transient* data parts (`data-rate-limits`, `data-agent-progress`, read in `useChat`
  `onData`, never stored) and keeps the latest usage per agent for `GET /api/rate-limits`.
- Usage meter (`client/shared/rate-limits.ts`, `RateLimitMeter.tsx`): Claude's windows come in
  the undocumented `rate_limit_info.unifiedWindows`, `utilization` as a fraction (0.24 = 24%);
  Codex from `account/rateLimits/read` once per turn plus `account/rateLimits/updated`
  (`usedPercent` 0–100, windows by `windowDurationMins`). No event → "unknown". No cost display
  (owner's decision).
- `agentProgressSummaries: true`: the running subagent row shows the latest
  `task_progress.summary` (`tool_use_id` = the Agent call). Codex has no subagent rows.
- Defaults for members who never chose: Opus 5.5 + effort medium (`DEFAULT_AI_MODEL`,
  `DEFAULT_AI_EFFORT`); only an explicit choice is saved; Codex keeps its own default effort.
- Settings sources are `['user', 'project']`; that is why shared agent config is protected at
  push (`push-check.md`).

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
- The dangerous-command approval banner (`tool-approval-request`) is a separate channel; both can
  show at once. Pending cards survive tab switches; closing the tab cancels them.
- Preview `client/tests/choice-prompt-ui.html` (`?theme=dark`, `?state=answered`); tests
  `client/tests/choice-prompt.test.ts`.

## Instructions while the AI works (steering)

`client/shared/steer.ts`, `agents/steering.ts`, `chat-turns.ts`.

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
- Fallback (api-key mode, attachments, slash commands, no attached turn yet, `unavailable` /
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
