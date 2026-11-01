---
paths:
  - "client/shared/web-research.ts"
  - "client/electron/web-research/**"
  - "client/electron/agents/web-reader.ts"
  - "client/electron/agents/claude-web-reader.ts"
  - "client/electron/agents/codex-web-reader.ts"
  - "client/electron/agents/codex-text.ts"
  - "client/tests/web-research.test.ts"
---

# 「Web で調べる」: a separate reader reads the web

The chat AI works in the member's company folder with file and command tools. Text from a web
page in its context is a prompt-injection path straight to those tools. So the working AI has no
web tools of its own; it calls the app tool `web_research`, and a separate **reader** — the
member's own agent, with only web tools, no settings and an empty folder — reads the web, and
follows links on the same site when the given pages are not enough. The app cleans the reader's answer and hands the working AI plain-text key points
+ source URLs (+ related links it saw but did not read) under a header that says they are data,
not instructions. Owner decisions: the reader is the member's own agent on its strong chat model
(2026-10-29, replacing the light model, which read the given page but did not dig: Claude: the
registry's chat Opus, `tasks.webReader`; Codex: no `tasks.webReader`, the catalog's default at
its default effort); 25 turns (40 for `depth: "deep"`) / 300 s per call; a per-conversation call limit (a deep call counts as one). From a working AI's feedback (2026-10-29): the reader prefers official / primary sources and never answers from search snippets alone; the app counts the pages actually read and says so first. Not now: admin settings for it,
an M2 stop, logging the reader's own fetches separately, rewriting company skills.

## Pieces

- `client/shared/web-research.ts` (pure): ids (`acb_web` / `web_research`,
  `WEB_RESEARCH_TOOL_ID`), limits, `validateWebResearchInput` (question 1–1000 chars; `depth`
  `normal` (default) / `deep`, anything else refused; ≤ 5 URLs,
  http/https, ≤ 2048 chars, no `user:pass@`; refused hosts: localhost / `*.localhost`, `.local`,
  `.internal`, `.lan`, `.home.arpa`, `.intranet`, `.corp`, single-label names, private /
  loopback / link-local / CGNAT / benchmark / multicast IPv4 (WHATWG URL normalizes `2130706433`,
  `0x7f000001`, `127.1`), every IPv6 literal), `sanitizeWebText` (HTML comments, script/style/…
  blocks, tags, common entities, zero-width / bidi / Unicode tag characters / other controls
  except `\n` `\t`, NFC, blank-line runs, 6000 chars + 「（長いため省略しました）」),
  `findInstructionLikeText` (conservative English + Japanese phrase list → flag labels; a flag,
  never a filter; one copy in `shared/core/instruction-like.ts`, re-exported here, also used
  for meeting minutes — `minutes.md`; it flags a line addressed to an AI, 「AI へ：…」), source extraction, `formatWebResearchResult` (fixed header, then the
  app-counted line `countedLine` — 「【調べた量（アプリが数えたもの）】読んだページ：N件／未読の関連リンク：M件（調べ方：ふつう|じっくり）」,
  N = distinct pages the reader actually fetched (Claude WebFetch calls, Codex opened pages —
  never URLs it only cites), with 「⚠ 検索結果だけの要約です。…もう一度呼んでください。」 when N = 0 —, ⚠ line when
  flagged, 【要点】, 【出典】, 【関連リンク（未読）】 when the reader listed any — `splitReaderAnswer`
  reads 「出典:」 and 「関連リンク:」 in either order; `relatedLinksOf`: cleaned like sources,
  refused hosts dropped (`checkWebUrl`), not repeated from the sources, ≤ 10, never counted as
  sources —, fence lines; a fake fence line inside the content is dropped),
  the reader's system prompt (input JSON includes `depth`; prefer official / primary sources
  and open them; never answer from search snippets alone — open ≥ 1–2 pages, ≥ 3 incl. official
  ones for `deep`; say so first when no page could be opened; dig: read the given URLs, follow relevant same-site links —
  pricing, specs, FAQ, docs, news — and search again when needed; ask WebFetch for the relevant
  facts plus the page's relevant links; stop once answered; key points ≤ 3000 chars, then
  「出典:」 and 「関連リンク:」) and the working AI's instruction paragraph (narrow questions,
  pass URLs when known, split broad topics into several calls, `depth: "deep"` when it matters,
  read the 「読んだページ」 line and call again with URLs when it is 0 or the answer matters;
  related links for digging further). The tool description says the same (and up to ~5 minutes). The 6000-char cap on the cleaned key points stays (twice
  the reader's limit).
- Registry: capability `webReader` (Claude Code, Codex; not the API key) and task model
  `webReader`; factory `runWebReader` (`CAPABILITY_FACTORIES`), entry point
  `runWebReader(id, request)` in `electron/agents/registry.ts`, which creates an empty
  `mkdtemp` folder and removes it afterwards. Not an `AgentProfile` (profiles still throw).
- `agents/web-reader.ts`: the contract (`WebReaderRequest` / `Result`, `WebReaderError` codes
  `unavailable` / `timeout` / `cancelled` / `refused-address` / `too-long` / `failed`), 300 s.
- Claude (`agents/claude-web-reader.ts`): `claude -p --model <tasks.webReader> --safe-mode --tools
  WebFetch,WebSearch --allowedTools WebFetch,WebSearch --permission-mode dontAsk
  --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence
  --max-turns 25|40 (`WEB_READER_MAX_TURNS[depth]`) --output-format stream-json --verbose --system-prompt …`, input JSON on stdin,
  env via `agentEnv` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, spawned like the one-shots
  (`spawnVoiceProcess`, `inheritEnv: false`), stderr drained unread. The stream is read line by
  line: an init message listing any other tool, any other tool call, or a WebFetch to a refused
  host stops it (SIGKILL; best effort — the call may already run). Verified on CLI 2.1.304:
  init lists exactly WebFetch + WebSearch and WebFetch works under `--safe-mode`.
- Codex (`agents/codex-web-reader.ts`): `generateCodexText` with a `CodexTextJob` — the
  one-shot overrides with `web_search="live"` instead of `"disabled"` (values: disabled / cached
  / indexed / live, from `codex app-server generate-json-schema`), items allowed: userMessage,
  agentMessage, reasoning, webSearch; any request from Codex stops it; configured MCP servers
  disabled one by one; ephemeral, read-only, approvals `never`. `webSearch` items with
  `action.url` are the pages it opened (a refused host stops it).
- The tool (`electron/web-research/tools.ts`): schema + Japanese/English description;
  `createWebResearchTools` (validate → per-conversation budget → reader → format; failures are
  fixed Japanese sentences `WEB_RESEARCH_MESSAGES`, never a stack; logs carry durations and
  counts only, never the question, answer or URLs); `createWebResearchBudget` (20 per
  `appSessionId`, in memory, ≤ 5000 conversations); `startWebResearchMcp` for Codex (loopback,
  `tool_timeout_sec` 360 (above the reader's 300 s), annotations read-only + open-world — Codex calls it without asking,
  verified with codex-cli 0.153.4).

## Wiring

- `chat-server.ts`: `config.createWebResearch?.({ agent, conversationId, signal })` for agents
  that own the conversation and claim `webReader`; its `instructions` go into the system prompt
  and `webResearch` into `createChatModel`. Built in `features/chat/server-config.ts` (one budget
  per app run; the member's CLI path and environment read per call).
- Claude chat (`agents/claude.ts`): with `webResearch`, an in-process SDK MCP server `acb_web`
  (tool in `allowedTools`, auto-allowed in `canUseTool`) and `settings: { permissions: { deny:
  ['WebFetch', 'WebSearch'] } }` (flag settings: the whole session incl. subagents, every
  permission mode; WebFetch / WebSearch bypass the sandbox network allowlist, so this is the
  only reliable off switch; not `disallowedTools`, which the provider ignores with
  allowedTools). Verified: the session's init tools lose both and list
  `mcp__acb_web__web_research`. Without `webResearch` nothing changes.
- Codex chat (`agents/codex.ts`): with `webResearch`, the loopback server in `mcp_servers` and
  `web_search: 'disabled'` in the thread config (verified: no `webSearch` item, the model says it
  has no web tool). Its `mcpToolCall` rows show as `mcp__acb_web__web_research`.
- Private-read guard: `acb_web` is an outbound tool (not in `APP_MCP_SERVERS`), so after a
  private read the member is asked first (`webResearchMessage`); the approval shows the
  question. The canUseTool auto-allow only applies when that guard did not ask.
- AI action log: `mcp__acb_web__web_research` is category `web`, target = the first given URL's
  host (`{ kind: 'web', host }`, else `{ kind: 'web' }`), never the question. The reader's own
  fetches are not logged (owner decision: not now). Wire contract unchanged.

## Limits

- Bash (`curl`, scripts) can still reach the network; that is the sandbox's job, not this one.
- DNS that resolves a public name to a private address is not checked (the CLI fetches).
- The phrase flags are conservative and incomplete; the header and the reader's own rules are
  the main defence, the flag is a hint for the AI and the member.
- The limit lives in memory (an app restart resets it).

Tests: `client/tests/web-research.test.ts` (validation, SSRF hosts, hidden text, HTML, phrases,
caps, formatting, tool messages and budget, reader flags and stream checks, the Codex endpoint),
`private-read-guard.test.ts` (outbound + Claude wiring), `codex-connection.test.ts` (thread
config), `agent-events.test.ts`, `agent-registry*.test.ts`.
