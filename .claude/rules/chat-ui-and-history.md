---
paths:
  - "client/src/components/chat/**"
  - "client/src/features/chat/**"
  - "client/electron/chat-history-store.ts"
  - "client/electron/features/chat-history/**"
  - "client/electron/ui-stream-limits.ts"
  - "client/shared/chat-history*.ts"
  - "client/tests/chat-history-store.test.ts"
  - "client/tests/chat-rendering.test.ts"
  - "client/tests/chat-header-ui.*"
  - "client/tests/ui-stream-limits.test.ts"
  - "client/shared/chat-server-api.ts"
  - "client/electron/chat-server.ts"
  - "client/tests/chat-server-client.test.ts"
  - "client/tests/chat-panel-helpers.test.ts"
  - "client/tests/ui/chat-*.spec.ts"
---

# Chat panel, chat history store and chat rendering

Long conversations froze the app before (a subagent's 277 MB of image reads flowed into UI
messages; one history save blocked the main process for 124 ms). These rules keep a 564-message,
~8 MB history responsive; `client/tests/perf/` holds the numbers (`testing.md`). Agent behaviour
is in `chat-and-agents.md`. Full text: `docs/architecture/chat-and-agents.md`, `chat-panel.md`
(internal).

## Chat panel layout (R6)

`src/components/chat/`: `ChatPanel.tsx` (tabs, sidebar, settings overlay) → `ChatConversation.tsx`
(one tab, `ChatPanelChat`, memo: hooks + composition) → `ChatHeader.tsx` (label, usage meter,
per-agent model pickers, buttons; owns its width observer), `ChatMessageList.tsx`
(`MessageList`, `MessageItem`, `UserMessageBubble`), `ChatComposer.tsx` (`ChatInput`, CodeMirror
/ legacy input, image previews), `ToolApprovalBanner.tsx`, `QueuedSendList.tsx`,
`ChatAuthGate.tsx`, `ChatAuthSettings.tsx`. Per-agent UI (sign-in cards, model pickers) is the
one place an added agent brings its own controls; everything else asks the registry (`agentCan`).

- State lives in `hooks/`, one concern each: `useConversation`, `useChatDraft`,
  `useChatRequestContext` + `useChatTransport`, `useMessageAttachments` +
  `useAttachToLatestUserMessage`, `useChatHistory`, `useTitleGeneration`, `useAgentInteractions`
  + `useToolApprovals`, `useSteering` + `useQueuedSendFlush`, `usePromptSuggestion`,
  `useStreamingChat` + `useRateLimitsRefresh`, `useChatAutoScroll`, `useConsultationStatus`, `useAgentModelSelection`,
  `useChatTabs`, `useAgentAuth`, `useChatServer`.
- Order inside `ChatPanelChat` matters: `useConversation`, `useChatDraft`,
  `useChatRequestContext`, `useMessageAttachments`, `useChatTransport`, `usePromptSuggestion`
  and `useSteering` run before `useChat` (the transport and onFinish read their refs or report
  the turn to them); `useChatHistory` / `useTitleGeneration` after it; `useQueuedSendFlush` after
  the send function. Keep that order when moving code.
- The transport is created once (`useChat` keeps its first one), so anything a request needs must
  be a ref the request body reads (`chatRequestBody.ts`), never a value captured at creation.
  Save bookkeeping and the draft stay in refs so timers and typing do not re-render the chat.
- Transient data parts (`data-rate-limits`, `data-agent-progress`) are handled in
  `useStreamingChat`'s `handleTransientDataPart` (`agentStatusStore`), never stored in history.
- The conversation list (`ChatSidebar.tsx`, 「AIへの相談」) shows each open tab's live status.
  `useConsultationStatus` (after the send function) derives it with the pure
  `src/lib/consultationStatus.ts` — needs-you (pending approval or agent question, which wins over
  working; or, once the turn has ended, a 「確認をお願いします」 request in the latest reply — kind
  `review`, eye icon, see `chat-and-agents.md`), working (with a plain-Japanese line for the running tool or the subagent progress
  line; never the command text or message bodies), failed, unseen (a turn ended while the tab was
  not active; cleared when the member leaves the tab after looking, which clears the 新着 mark) or idle — and publishes it to
  `consultationStatusStore` (keyed by tab id) only when it changes, so streaming does not
  re-render the list per chunk. `groupConversationRows` orders the groups あなたの番 › ピン留め ›
  止まっています › AIが作業中 › 開いている相談 (idle open tabs: new ones, unread replies first with a
  「新着」 mark, and ones read and possibly continued) › 終わったもの (closed conversations only — closing ends one; a
  conversation closed with nothing sent and no draft is deleted, and such leftovers are not listed);
  a pinned conversation leaves ピン留め only for あなたの番. Tests:
  `client/tests/consultation-status.test.ts`, `tests/ui/chat-panel.spec.ts`.
- Empty conversations are deleted in two cases, by one rule (`isEmptyConversation`: never sent,
  no draft, not renamed, not pinned): closing one (`closeConversation` in `ChatSidebar.tsx`), and
  leaving one for another conversation (owner, 2026-10-30: a blank new one left behind is in the
  way). The second is `src/features/chat/hooks/useDiscardBlankOnLeave.ts`, called in
  `ChatPanelChat` after `useChatHistory` (its synchronous save on leaving lands first): when a
  mounted tab stops being the active one — which only a switch to another conversation does
  (a row, 「AIに相談する」, opening a conversation); quitting, other panels and company switches
  unmount it or keep it active — and the tab's live state is blank (`features/chat/model.ts`
  `discardWhenLeft`: history restored, no message besides the greeting, no draft text, no
  attached images or files, no running turn, waiting send, approval, question or hand-off
  request) and its stored summary is empty, its tab closes and its stored copy is deleted. It
  re-checks after reading the summaries (the member may have come back), never deletes the last
  tab (`closeTab`), and fails silently like closing. Tests: `src/features/chat/model.test.ts`,
  `tests/ui/chat-panel.spec.ts`.
- Pure helpers with tests (`client/tests/chat-panel-helpers.test.ts`): `chatSessionMessages.ts`
  (UIMessage ↔ history, conversion cache, title transcript), `chatRequestBody.ts` (the
  `/api/chat` body: same fields and order, pending attachments consumed once),
  `chatTabsStorage.ts` (remembered tabs), `queuedSends.ts` (merging waiting messages).
- Editing a message and resending goes through the normal send path (`sendTurn` in
  `ChatConversation.tsx`): a synchronous save of the conversation cut before the edited message +
  the new one, then send. The edited message's file references are sent again; images are not
  (history keeps thumbnails only).

## Talking to the chat server

- The embedded chat server's HTTP contract is `client/shared/chat-server-api.ts`
  (`CHAT_SERVER_PATHS` + request/response types); `electron/chat-server.ts` parses and answers
  with it.
- The renderer talks to it only through `src/components/chat/chatServerClient.ts`
  (`useChatServer()` returns one client per address, memoised by port + token). Build
  `http://127.0.0.1:<port>` URLs and the bearer header only there: add a method and its test in
  `client/tests/chat-server-client.test.ts`. Each method keeps its caller's error behaviour
  (steer → `unavailable`, forget never throws, suggestion / title → `null` on an error status).
  `fetch` is looked up per call (preview pages swap `window.fetch`).
- Everything else the chat asks the main process goes through `src/features/chat/api.ts` too:
  `AgentSetupReads` / `AgentSetupWrites` (chosen AI, permission mode), `ApiKeyWrites` (the
  API key, a secret, on a port of its own), `CodexStatusOutbound` (the check starts Codex,
  which asks the ChatGPT account), `AgentQuestionReads` / `AgentAnswers` (choice prompts and
  approvals; an answer lets the AI go on), `ChatServerReads` (address and token) and
  `ChatOutbound` (opening a URL in the browser).

## History store (`client/electron/chat-history-store.ts`, main process)

- One JSON file per company: `<userData>/chat-history/<companyId>.json`, format
  `{ sessions, deletedSessionIds }` (written compact). Unknown top-level keys are kept, so older
  app versions still read it.
- Reads come from an in-memory copy, loaded once and reloaded only when the file's identity
  (inode, size, mtime) changes while nothing is pending. Sessions are replaced, never edited in
  place, because callers may hold them.
- Writes are coalesced (250 ms) and asynchronous: write + fsync a temporary file off the main
  thread, then on the main thread hard-link the current file to `.bak` (copy where links fail)
  and rename the temporary file over it. A deletion writes at once and also replaces `.bak`, so
  deleted conversations never linger. A failed write retries every 5 s; the next save/patch
  retries synchronously and reports the error. `flushSync()` runs on `will-quit`. A save is
  acknowledged before it is on disk; the file on disk is always a complete version.
- IPC: `chatHistory:getSummaries` (no message bodies; 8.1 MB → 31 KB), `chatHistory:search`
  (body search in main, NFKC), `getSession`; save/flush return a `ChatSaveReceipt` (status +
  revision), not the conversation. `chatHistory:changed` carries `{ sessionId, kind: save |
  patch | delete }`; a tab re-reads only a `patch` of its own conversation.
- The renderer reaches the history and the hand-off memo only through
  `src/features/chat/api.ts`: `ChatHistoryReads` / `ChatHistoryWrites`, `HandoffReads`, and
  `HandoffOutbound` (`handoff:update` / `handoff:complete` start or schedule the member's AI
  on the conversation, so they are not a plain write).
- A message stores its tool calls only as `[Tool: name]` text; what must survive a restart is a
  record next to `content`: `choicePrompts`, `steerInstructions` (both with `at`),
  `consultationReferences`, `reviewRequests` (restored as `data-review-request` parts after the
  text).
- Autosave every 4 s (unload and leaving a tab still flush synchronously); it skips building the
  session when nothing changed; converted messages are cached per UIMessage object.
- Attached images: the AI gets the full image; bubble and history keep a ≤ 320 px WebP thumbnail
  (`components/chat/historyThumbnail.ts`). Old full-size data URLs still load.
- Tests: `client/tests/chat-history-store.test.ts`.

## Rendering (`client/src/components/chat/`)

- `MessageList` renders the latest 50 messages (`messageWindow.ts`, anchored by message id so
  streaming messages append); 「以前のメッセージを表示」 adds 50 and keeps the scroll position.
  Messages older than the latest 20 use `content-visibility: auto`; hidden tabs use
  `content-visibility: hidden`; `ChatPanelChat` (`ChatConversation.tsx`), `MessageList`,
  `MessageItem` and `ChatInput` are memoised with stable props.
- Markdown renders per top-level block (`markdownBlocks.ts`: split only at blank lines outside
  fences before a non-indented, non-list line; a reply with link/footnote definitions stays one
  block), so streaming re-parses only the last block; an unclosed fence shows plain until it
  closes. The stream throttle is 150 ms once a reply passes 8,000 characters.
- Syntax highlighting is PrismLight with a curated language set (`codeHighlighter.tsx`:
  ts/tsx/js/jsx, python, bash/sh/zsh, json, yaml, markdown, html/xml, css/scss, sql, diff, go,
  rust, java, kotlin, swift, c/cpp/csharp, ruby, php, powershell, toml, ini, docker, graphql);
  others render plain. This keeps the renderer bundle under its budget (2.48 MB → 1.97 MB).
- Per-turn tool payload cap (`electron/ui-stream-limits.ts` `turnBudget`): after 2 MB of tool
  inputs/outputs in one turn (api-key mode 8 MB), later payloads are cut to 1 KB and input deltas
  stop; rows, states, errors, answer text and data parts are untouched.
- Preview `client/tests/chat-header-ui.html?history=long` (a restored 240-message conversation);
  tests `client/tests/chat-rendering.test.ts`. UI specs drive replies through `window.__acbChat`
  (`chat-header-ui.html?turn=manual`; see `testing.md`).
