---
paths:
  - "client/src/components/chat/**"
  - "client/electron/chat-history-store.ts"
  - "client/electron/features/chat-history/**"
  - "client/electron/ui-stream-limits.ts"
  - "client/shared/chat-history*.ts"
  - "client/tests/chat-history-store.test.ts"
  - "client/tests/chat-rendering.test.ts"
  - "client/tests/chat-header-ui.*"
  - "client/tests/ui-stream-limits.test.ts"
---

# Chat history store and chat rendering

Long conversations froze the app before (a subagent's 277 MB of image reads flowed into UI
messages; one history save blocked the main process for 124 ms). These rules keep a 564-message,
~8 MB history responsive; `client/tests/perf/` holds the numbers (`testing.md`). Agent behaviour
is in `chat-and-agents.md`. Full text: `docs/architecture/chat-and-agents.md` (internal).

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
- Autosave every 4 s (unload and leaving a tab still flush synchronously); it skips building the
  session when nothing changed; converted messages are cached per UIMessage object.
- Attached images: the AI gets the full image; bubble and history keep a ≤ 320 px WebP thumbnail
  (`components/chat/historyThumbnail.ts`). Old full-size data URLs still load.
- Tests: `client/tests/chat-history-store.test.ts`.

## Rendering (`client/src/components/chat/`)

- `MessageList` renders the latest 50 messages (`messageWindow.ts`, anchored by message id so
  streaming messages append); 「以前のメッセージを表示」 adds 50 and keeps the scroll position.
  Messages older than the latest 20 use `content-visibility: auto`; hidden tabs use
  `content-visibility: hidden`; `ChatPanelChat` is memoised with stable props.
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
- Data parts that are transient (`data-rate-limits`, `data-agent-progress`) are read in
  `useChat` `onData` and never stored in history.
- Preview `client/tests/chat-header-ui.html?history=long` (a restored 240-message conversation);
  tests `client/tests/chat-rendering.test.ts`. UI specs drive replies through `window.__acbChat`
  (`chat-header-ui.html?turn=manual`; see `testing.md`).
