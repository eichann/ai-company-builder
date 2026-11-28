---
paths:
  - "client/src/features/chat/**"
  - "client/electron/chat-history-store.ts"
  - "client/electron/features/chat-history/**"
  - "client/electron/ui-stream-limits.ts"
  - "client/shared/chat-history*.ts"
  - "client/tests/chat-history-store.test.ts"
  - "client/src/features/chat/chat-rendering.test.ts"
  - "client/tests/chat-header-ui.*"
  - "client/tests/chat-reply-cleaning-ui.*"
  - "client/tests/chat-rich-reply-ui.*"
  - "client/tests/ui/fixtures/reply-html-traps.ts"
  - "client/tests/ui-stream-limits.test.ts"
  - "client/shared/chat-server-api.ts"
  - "client/electron/chat-server.ts"
  - "client/src/features/chat/chat-server-client.test.ts"
  - "client/tests/chat-panel-helpers.test.ts"
  - "client/tests/ui/chat-*.spec.ts"
  - "client/src/app/ChatWindowApp.tsx"
  - "client/shared/chat-windows.ts"
  - "client/electron/features/chat-windows/**"
  - "client/tests/chat-window*"
  - "client/tests/ipc-chat-windows.test.ts"
  - "client/shared/tool-display.ts"
  - "client/electron/tool-display-stream.ts"
  - "client/tests/tool-display.test.ts"
  - "client/tests/tool-rows-real-path.test.ts"
  - "client/shared/acb-tool-displays.ts"
  - "client/electron/records/tool-providers.ts"
  - "client/shared/record-drop.ts"
  - "client/tests/record-drop.test.ts"
---

# Chat panel, chat history store and chat rendering

Long conversations froze the app before (a subagent's 277 MB of image reads flowed into UI
messages; one history save blocked the main process for 124 ms). These rules keep a 564-message,
~8 MB history responsive; `client/tests/perf/` holds the numbers (`testing.md`). Agent behaviour
is in `chat-and-agents.md`. Full text: `docs/architecture/chat-and-agents.md`, `chat-panel.md`
(internal).

## Chat panel layout (R6)

`src/features/chat/components/`: `ChatPanel.tsx` (tabs, sidebar, settings overlay) → `ChatConversation.tsx`
(one tab, `ChatPanelChat`, memo: hooks + composition) → `ChatHeader.tsx` (the list toggle, the
consultation's name, its state while a turn runs, stop, ＋ and 「…」 — nothing else; 「…」 holds
引き継ぎメモ, the Markdown display, 「別ウィンドウで開く」 and the settings; the name truncates first, so
the buttons stay inside the pane down to 280 px), `ModelMenu.tsx` (the one switch of the model,
「考える強さ」 and 「返事の形」 (ふつう／リッチ, per consultation, "Diagrams in a reply"), per agent, beside the input; never clipped), the usage meter (in the input's row; its details on `document.body`, fixed, kept in the window: `src/shared/ui/HoverTooltip.tsx`, `tests/ui/chat-usage-popover.spec.ts`), `ChatMessageList.tsx`
(`MessageList`, `MessageItem`, `UserMessageBubble`), `ChatComposer.tsx` (`ChatInput`: voice input,
dropped files and images in `ComposerAttachments.tsx`, and the text input
`CodeMirrorChatInput.tsx` — its editor setup in `chatInputEditor.ts` — or the debug
`LegacyTextareaChatInput.tsx`), `ToolApprovalBanner.tsx`, `QueuedSendList.tsx`,
`ChatAuthGate.tsx`, `ChatAuthSettings.tsx`. Per-agent UI (sign-in cards, model pickers) is the
one place an added agent brings its own controls; everything else asks the registry (`agentCan`).

- **A quiet screen** (owner FB 2026-11-27, like the Claude and ChatGPT apps): the list of
  consultations starts closed (`ChatPanel` `listOpenAtStart`, only preview pages pass it; opened
  with the header's toggle, it sits beside the conversation, or over it in a pane under 680 px);
  the header shows only the above; the input's frame holds one bottom row (`ComposerRow.tsx`: voice
  input on the left, the usage meter, `ModelMenu` and send on the right; it wraps instead of
  clipping); how to send is said once, in the placeholder (the row shows the suggestion's keys only
  while one is offered); the voice input's explanation is its button's tooltip, and what needs the
  member's eyes (recording, the level, the microphone settings, a problem) opens above the input
  (`VoiceInputControl` `panelHost`); 「引き継ぎメモ：…」 shows under the header only once a memo
  exists or is being made (`HandoffControl`, opened from 「…」 otherwise); the AI's reply is plain
  text (no bubble), the member's own words a `surface-sunken` bubble; tool rows are drawn at full
  strength (no fade) in `text` / `text-muted`. `useAgentModelSelection` returns one object while
  nothing changes, so the composer's switch (memoised in `ChatPanelChat`) does not re-render
  `ChatInput` per streamed chunk. Tests: `tests/ui/chat-screen.spec.ts` (list closed at the start,
  the header's contents and fit at 280–720 px with a running turn, the switch whole and working
  for both agents, the memo line, one line about sending, no bubble, tool rows' contrast);
  `chat-header-ui.html?list=open` opens the list for the specs that test it, `?handoff=saved` gives
  a memo, `?voice=1` a working microphone.

- State lives in `hooks/`, one concern each: `useConversation`, `useChatDraft`,
  `useChatRequestContext` + `useChatTransport`, `useMessageAttachments` +
  `useAttachToLatestUserMessage`, `useChatHistory`, `useTitleGeneration`, `useAgentInteractions`
  + `useToolApprovals`, `useSteering` + `useQueuedSendFlush`, `usePromptSuggestion`,
  `useStreamingChat` + `useRateLimitsRefresh`, `useChatAutoScroll`, `useConsultationStatus`, `useAgentModelSelection`,
  `useChatTabs`, `useAgentAuth`, `useChatServer`; the composer's `useComposerAttachments` and
  `useSlashCommands`.
- The composer fills `apiRef` (`ChatInputApi` in `useChatDraft.ts`, through
  `useImperativeHandle` in `ChatComposer.tsx`: the text input's own `ChatTextInputApi` plus the
  attachments, `getAttachments` / `setAttachments`); the conversation writes drafts, voice text and
  `chat.insertText` (`replaceText`) through it. The CodeMirror editor is made once and reads props through
  `useLatestRef` (`src/shared/hooks/`); only editability, placeholder and suggestion are pushed in.
  `useComposerAttachments` reports the attachment count when it changes (`onAttachmentsChange`,
  read when the member leaves a tab). Tests: `tests/ui/chat-composer.spec.ts`.
- **A message that did not go out comes back whole** (text, images, file references): 取り消す on
  a waiting message, a stop or an error with messages waiting (`useSteering` `returnToInput`), and
  a send cut short because a new conversation started in the tab while its images were read. The
  rule is `queuedSends.ts` `returnedToInput`: what the composer holds first, then each message in
  order, every image kept (past the 4-image drop limit: it was accepted once), file references once
  each. The drop limit counts only what is dropped now (`useComposerAttachments`: the room left,
  the rest refused with 「画像は最大4枚までです」) and never removes an attached image; a send takes
  all attached images (no count limit after the composer). Tests: `tests/chat-panel-helpers.test.ts`,
  `tests/ui/chat-panel.spec.ts` 「a waiting message comes back whole…」, 「images returned past the
  drop limit…」.
- Other features reach the chat only through commands: `chat.newConsultation` (a skill's 実行)
  and `chat.insertText`, handled per pane in `ChatPanel.tsx` and passed to the shown tab as
  `inputRequest` (`commands.md`), which `ChatPanelChat` carries out; there is no store field for
  chat input. The one request a tab takes while not shown is `aiTurn`: the automatic 「AI の番」
  in a fresh background tab (`ai-turns.md`). `chat.askToFix` (「AI に直してもらう」, `chat-and-agents.md` "In-place
  fixes") is the request `inlineFix`: the shown tab sends it into **its current consultation** (not a new one) unless
  anything of the tab runs or waits (`tabBusy`; then answered `busy`), waits for the turn that carried it to end
  (`inlineFixRef`, settled in `onFinish` with `inlineFixTurnAnswer`) and answers the command with the reply; a send that
  never went out (its save failed) is answered `failed`, and the member's draft in the composer is neither cleared nor
  replaced by it (`besideComposer`). Any request that replaces one still waiting for the tab answers that one `busy`.
- **Several chat panes** (refactor 5-7, preparing D8's split screen; one pane today). Nothing
  assumes one chat on screen:
  - `isShown` (was `isActive`): the tab its pane shows. Scrolling to new messages, the save on
    leaving a tab, 「新着」 (a turn that ends while not shown) and blank-tab discarding go by it;
    two panes each show one tab.
  - The input in use is the chat pane the member used last (the command registry's active
    target, fed by focus): `chat.*` commands without `pane` and the voice key
    (`chat.toggleVoiceInput`, caught once per page by `hooks/useVoiceShortcut.ts`) go there.
    Esc and leaving the window cancel only a recording in progress.
  - A consultation is open in one pane at most (`chatPanes.ts`; panes publish their open
    consultations): opening one another pane has shows it there. Test: `chatPanes.test.ts`.
  - Tabs are remembered per pane: `chatTabs:<company>` for `chat` (unchanged),
    `chatTabs:<company>:<pane>` for another (`chatTabsStorageId`).
  - The consultation windows close when the last chat pane goes (`useChatWindows`).
  UI tests: `tests/ui/chat-panel.spec.ts` 「two chat panes」 (`chat-header-ui.html?panes=2`),
  `tests/ui/voice-input.spec.ts` (`voice-input-ui.html?panes=2`).
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
  `src/features/chat/consultationStatus.ts` — needs-you (pending approval or agent question, which wins over
  working; or, once the turn has ended, a 「確認をお願いします」 request in the latest reply — kind
  `review`, eye icon, see `chat-and-agents.md`), working (with a plain-Japanese line for the running tool or the subagent progress
  line; never the command text or message bodies), failed, unseen (a turn ended while the tab was
  not active; cleared when the member leaves the tab after looking, which clears the 新着 mark) or idle — and publishes it to
  `consultationStatusStore` (keyed by tab id) only when it changes, so streaming does not
  re-render the list per chunk. `groupConversationRows` orders the groups あなたの番 › ピン留め ›
  止まりました (a failure, red) › AIが作業中 › 開いている相談 (idle open tabs: new ones, unread replies first with a
  「新着」 mark — the primary dot named 新着, design-system.md P2b —, and ones read and possibly continued) › 終わったもの (closed conversations only — closing ends one; a
  conversation closed with nothing sent and no draft is deleted, and such leftovers are not listed);
  a pinned conversation leaves ピン留め only for あなたの番. An automatic 「AI の番」 consultation closes
  by itself when its run ends well, or when the member ends its record, unless it holds anything of
  the member's (`ai-turns.md` "Closing the consultation"). Tests:
  `client/src/features/chat/consultation-status.test.ts`, `tests/ui/chat-panel.spec.ts`.
- A row's second line while no turn runs (`conversationLine`, `conversationRows.ts`): the draft
  (「下書き：…」), else the last words (`sessionPreview` skips a reply that was only tool work);
  「（まだ何も書いていません）」 only while the member has sent nothing; a consultation already had with no
  words to show (one the app started) has no line — never an invitation to start. A new consultation is
  titled 「新しい相談」 (`chat.newChat`; saved titles stay). Test: `src/features/chat/conversation-line.test.ts`.
- Each group heading except あなたの番 folds its rows (owner, 2026-10-30): a button with
  `aria-expanded` and a chevron, the count still shown. あなたの番 never folds, so what the AI waits
  for cannot be folded away; a folded group with an unread reply shows 新着 on its heading.
  Folded groups are remembered per company in localStorage (`chatCollapsedGroups:<companyId>`,
  `src/features/chat/hooks/useCollapsedGroups.ts`; unreadable → all open); while the search box
  has text every group is open (`features/chat/conversationGroups.ts`), so a match is never
  hidden. Folding only hides rows: pagination counts all rows, and 「続きを読み込む」 hides while
  終わったもの is folded. Tests: `src/features/chat/conversationGroups.test.ts`,
  `tests/ui/chat-panel.spec.ts`.
- **「この件の相談」: the record open in the middle** (owner 2026-11-26, replacing the narrowed list of
  2026-11-02 and its 「表示中の相談（このことについての相談ではありません）」 box: the whole list disappearing read as odd).
  Opening a record (AppShell's `activeRecordId`, given as `focus`) never hides the list and never switches the
  consultation on screen. Above the full list, a small section 「この件の相談（N）」 lists the consultations whose
  stored main topic (`topicRecordId`) is that record itself — never those of the things inside it (a 案件's やること's
  consultations show when that やること is open) — from all rows, not only the loaded page (`rowsAboutRecord` in
  `conversationRows.ts`; one line each: state, title, date; pressing it opens it like its row). The full list below is
  unchanged; the same rows carry a small 「この件」 mark (`StatusBadge` `selected`). None → one quiet line
  「この件の相談はまだありません」 (no box); no record open, or text in the search box → no section.
  **A new consultation started while a record is open** (「AIに相談する」 or the header's ＋; `ChatPanel` `startNew`)
  takes that record as its topic from the start (`initialTopicRecordId` → `useChatHistory`'s `setTopic`, the same
  `topicRecordId` the first save stores, as 「相談する」 does: no new link). Until the member's first message this starting topic's
  chip sits above the input (a dropped record's stays under the header) (`TopicChip place="composer"`: 「このやること：<title>」, on by default); its × takes it off
  (`setTopic(null)`, plus `patch { topicRecordId: null }` if a copy is stored), so the consultation is not linked. After
  the first message the chip is the header's as for any topic. Each chat pane does this with its own `focus` and tabs,
  so stacked panes (later) each get their own chip. Tests: `src/features/chat/conversation-rows.test.ts`,
  `tests/ui/chat-panel.spec.ts` (「a record open in the middle…」, 「a record with no consultation…」, 「「AIに相談する」
  while a record is open…」; preview `chat-header-ui.html?history=record&focus=task-0000aa|task-0000cc`,
  `SCREENSHOTS=<dir>` shoots the five states).
- **A record dropped on the input** (owner, 2026-11-03 「使い心地のメモ」 #5). A record drag (a task row,
  a 探す row, a record tab in the middle; `tasks-ui.md` "Drag sources") onto the composer:
  - **The drop frame says what will happen** (`features/chat/recordDrop.ts` `composerDragOf` /
    `dropFrameText`, read from the drag types only): a file (the tree, a file tab, a found file, an
    image) 「ここに落とすと、AI が読みます」 — the reference behaviour is unchanged —, a record
    「ここに落とすと、この<やること／案件／会議の記録…>の相談になります」. A consultation drag is not taken.
  - **The topic**: none → the record becomes it (`setTopic`, plus `patchChatSession { topicRecordId }`
    when the conversation is already stored — this clears `topicDetached`, the member chose it; an
    unsaved one takes it with its first save). The same record → nothing to change. Another →
    asked inline above the input (`TopicSwitchAsk.tsx`): 「『A』の相談を『B』の相談に切り替えますか？」
    ［切り替える］［このまま］. The chip names the topic's kind (`TopicChip.tsx`).
  - **Read once, with the next message** (chosen over an immediate one-off turn: no AI turn the
    member did not ask for, and the member says what they want to know): the record waits as a chip
    in the composer (「やること『…』を AI に渡します」, × takes it off; ≤ 5, once each) — whichever
    way the topic question went —; the next send puts the ids in the request (`droppedRecordIds`,
    consumed once by `chatRequestBody.ts`) and in the message's metadata (`droppedRecords`, stored
    with the message, the bubble's 「…を AI に渡しました」). An edit, an app instruction or a send
    while the AI works (steering) does not take them; they wait for the next real request.
  - **Main** (`chat-server.ts`, not in an unattended step, only with record tools — Claude Code and
    Codex, Codex's read token included) reads each with the turn's token
    (`RecordTools.readDroppedRecord`: `GET /item/:id`, so only what the member may read, `people`
    for names) and builds the summary (`client/shared/record-drop.ts` `droppedRecordSummary`: kind,
    title, id, state, whose turn for a やること, the card's fields, summary, linked files with
    folder / broken marks, まとまり, 相手, other linked records, this PC's consultations about it
    (`consultationsAbout`)). `droppedRecordsContext` wraps it (「このとき1回だけ読んだ要約」: answer from it
    without tools when it is enough; it is not given again; use records_get / records_history for
    more) and it goes first in **the latest user message only** (`withTextBeforeLatestUserMessage`),
    so it stays in the agent's own session and is never re-sent. Unreadable or no record tools →
    nothing is added. Every turn of a consultation about a record that is not a やること gets only
    one line naming it (`recordTopicInstructions`); a task's is `taskTopicInstructions`.
  Tests: `src/features/chat/recordDrop.test.ts` (frame words per drag, topic decision, waiting list),
  `tests/record-drop.test.ts` (summary contents, once-only wrapper, latest message only, id filter),
  `tests/chat-panel-helpers.test.ts` (request body consumes them once; `droppedRecords` round trip),
  `tests/ui/chat-record-drop.spec.ts` (real drags from the middle's tabs, `chat-header-ui.html?tabs=1`:
  record → topic + one request only; switching asks; file tab → read, no topic; `SCREENSHOTS=<dir>`).
- **Searching the list** (owner, 2026-11-03). The box at the top of 「AIへの相談」 narrows as the
  member types (no Enter; 200 ms after the last key; an IME's unconfirmed text never narrows,
  confirming does; Esc or × empties it, and empty is the normal list, 「この件の相談」 included). It matches the consultation's title, its draft, its body (main's
  `searchChatSessions`) and the title of the record it is about: its own やること (the topic
  record), else its 案件 (the topic when that is a 案件) — `consultationLinkedRecord` in
  `client/shared/consultation-topics.ts`, the same rule 探す uses; a task consultation is not found
  by its task's 案件. Each row shows that record under its title (link mark, `ThingIcon`, title),
  with the matched part marked (`markMatches`, NFKC + case-folded as the search), and 「N件」 under
  the box. Records come from the company server through main (`recordViews:topics`: a plain
  `GET /records/item/:id` per topic id, never the card's 「開いた」 signal; not found / not allowed →
  null, never shown or matched; unreachable → left out and asked again), cached per company in
  `features/chat/consultationTopicsStore.ts` (all asked again when the list shows after a minute).
  Order and states stay as without a search. Tests: `src/features/chat/conversation-rows.test.ts`,
  `tests/consultation-topics.test.ts`, `tests/ui/chat-panel.spec.ts` 「the search box finds …」.
- Group headings are sticky within their section (owner, 2026-10-30): while a group's rows scroll,
  its heading stays at the top of the list until the next group's heading takes over. The sticky
  wrapper has the sidebar's opaque background so rows never show through. Test: the
  `history=many` preview in `tests/ui/chat-panel.spec.ts`.
- Empty conversations are deleted in two cases, by one rule (`isEmptyConversation`: never sent,
  no draft, not renamed, not pinned): closing one (`closeConversation` in `ChatSidebar.tsx`), and
  leaving one for another conversation (owner, 2026-10-30: a blank new one left behind is in the
  way). The second is `src/features/chat/hooks/useDiscardBlankOnLeave.ts`, called in
  `ChatPanelChat` after `useChatHistory` (its synchronous save on leaving lands first): when a
  mounted tab stops being the active one — which only a switch to another conversation does
  (a row, 「AIに相談する」, opening a conversation); quitting, other panels and company switches
  unmount it or keep it active — and the tab's live state is blank (`features/chat/model.ts`
  `discardWhenLeft`: history restored, no message besides the greeting, no draft text, no
  attached images or files, no running turn, send still reading its images, waiting send, approval,
  question or hand-off request — `tabBusy` in `ChatConversation.tsx`, the same rule that keeps an
  automatic run's tab open) and its stored summary is empty, its tab closes and its stored copy is deleted. It
  re-checks after reading the summaries (the member may have come back), never deletes the last
  tab (`closeTab`), and fails silently like closing. Tests: `src/features/chat/model.test.ts`,
  `tests/ui/chat-panel.spec.ts`.
- Pure helpers with tests (`client/tests/chat-panel-helpers.test.ts`): `chatSessionMessages.ts`
  (UIMessage ↔ history, conversion cache, title transcript), `chatRequestBody.ts` (the
  `/api/chat` body: same fields and order, pending attachments consumed once),
  `chatTabsStorage.ts` (remembered tabs), `queuedSends.ts` (merging waiting messages).
- A send with images reads them before anything is staged (`readImages`, then `stageImages`):
  if the tab closed meanwhile nothing more is done; if a new conversation started in the tab
  (`chat.newConsultation`; the conversation id is compared) the message is not sent into it,
  nothing stays staged for its requests, and the words and images go back into the input with
  「画像の準備中に新しい相談を始めたため、…」. Tests: `tests/ui/chat-panel.spec.ts` 「a first message
  with an image still goes out…」, 「a new consultation started in the tab while an image is read…」.
- Editing a message and resending goes through the normal send path (`sendTurn` in
  `ChatConversation.tsx`): a synchronous save of the conversation cut before the edited message +
  the new one, then send. The edited message's file references are sent again; images are not
  (history keeps thumbnails only).

## 「別ウィンドウで開く」: a consultation in a window of its own (owner, 2026-10-30)

One consultation per window still holds: a member can show 2–3 consultations side by side (two
monitors) by opening each in its own window. Pure parts: `client/shared/chat-windows.ts` (the
request / status shapes and their checks, `closeStopsTheAI`), the window registry
`electron/features/chat-windows/registry.ts`, renderer `src/features/chat/chatWindows.ts`.

- Entry points: 「別ウィンドウで開く」 on each row of 「AIへの相談」 (next to pin / rename /
  delete), the same item in the chat header's 「…」, and the command `chat.openInWindow { sessionId }`
  (`commands.md`). All run `useMoveToWindow` (`features/chat/hooks/`), handled in `ChatPanel.tsx`.
- **Never in two places.** Main keeps which window shows which conversation
  (`createChatWindowRegistry`: `claim` refuses a second window); opening one already shown
  focuses that window. In the main window: a consultation shown here leaves first (`detachSession`
  in `useChatTabs`, inside `flushSync`, so its unmount saves synchronously before the window reads
  it; the next tab shows, or a new one when it was the last); its row stays listed as open with
  「別ウィンドウで表示中」 (`windowTabs`: stand-in tabs `window:<id>`, never mounted), and clicking
  it, opening it from history or a consultation reference focuses that window instead. Tests:
  `client/tests/chat-windows.test.ts` (registry, mutation-checked), `tests/ui/chat-panel.spec.ts`
  「a consultation in its own window」.
- **Statuses cross windows.** The window publishes its tab's status as usual and reports it to
  main (`chatWindow:reportStatus`, `features/chat/hooks/useReportWindowStatus.ts`); main broadcasts `chatWindow:changed`
  to the main window, whose list groups the row by that status (あなたの番, AIが作業中, 新着 count as
  for a tab; `statusOfTab`). Test: `src/features/chat/chatWindows.test.ts`.
- **Moving needs a quiet consultation.** Turns are driven by the page (its `/api/chat` request;
  history is saved by the page), so a consultation whose AI works or waits for an approval or an
  answer cannot move (buttons disabled, `canMoveToWindow`), and **closing a window mid-turn asks**
  「AIが作業中です。閉じると止まります」 (閉じる / キャンセル, `electron-adapter.ts`): closing stops
  the AI there; what was said so far is saved on unload. A 「確認をお願いします」 wait does not ask.
  Keeping the turn alive after its page goes would need main-side turns (not built).
- A closed window's consultation returns to the main window as an open tab, not shown in front
  (`onReturned` in `useChatWindows`). Company switch, sign-out (main's `onSignedOut` too) and the
  main window closing close every window without asking; quitting closes all.
- The window (`src/app/ChatWindowApp.tsx`, `?window=chat` in `src/main.tsx`) shows only that
  consultation's chat (`ChatPanelChat` with `standalone`: no new-chat or list buttons): header,
  messages, composer, voice input, cards, review requests. Company, department and slash commands come from main (`chatWindow:getContext`,
  what the main window had when it opened); the title follows the consultation; a deleted
  conversation closes the window. Preview `client/tests/chat-window-ui.html`, spec
  `tests/ui/chat-window.spec.ts`.
- **File links open in the main window** (owner decision 3 of 「別ウィンドウで開く」). The window
  has no editor, so its own `file.open` handler (`features/chat/hooks/useOpenFileInMainWindow.ts`)
  asks main (`chatWindow:openFile`, a file-open-only channel, no generic command relay); main
  accepts it only from a registered consultation window and only for a file of that window's
  company folder (allowed roots by real location, no `..`, not in a folder left out on this
  computer, present on disk: a private folder the member cannot read is not, and no refusal names
  the path), brings the main window to the front and sends it `chatWindow:fileRequested`, which
  the main window runs as `file.open` (`useFilesFromChatWindows`, in `AppShell.tsx`). A refusal
  shows in the window for a few seconds. Tests: `tests/chat-windows.test.ts`,
  `tests/ipc-chat-windows.test.ts`, `tests/ui/chat-window.spec.ts`, `tests/ui/skill-layout.spec.ts`.

## Talking to the chat server

- The embedded chat server's HTTP contract is `client/shared/chat-server-api.ts`
  (`CHAT_SERVER_PATHS` + request/response types); `electron/chat-server.ts` parses and answers
  with it.
- It listens on `127.0.0.1`, the first port of 3300–3399 that binds: binding is the check (a
  probe-then-listen let a parallel process take the port in between, and requests reached that
  one). Tests pass `listenPort: 0` (any free port) so parallel runs never share one.
- The renderer talks to it only through `src/features/chat/chatServerClient.ts`
  (`useChatServer()` returns one client per address, memoised by port + token). Build
  `http://127.0.0.1:<port>` URLs and the bearer header only there: add a method and its test in
  `src/features/chat/chat-server-client.test.ts`. Each method keeps its caller's error behaviour
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
- **The topic is metadata** (`topicRecordId`, `topicDetached`; `consultation-task.ts`): a save
  keeps what `patch` set — main's topic (the task the AI made) survives a save that lacks it, and
  once the member took it off (`patch { topicRecordId: null }` → `topicDetached: true`) no save
  brings it back and no task becomes the topic again. The renderer's first save still brings the
  topic of 「相談する」. A tab re-reads it on a `patch` of its own conversation (`useChatHistory`
  `topicRecordId` state) for the topic chip (`TopicChip.tsx`; `tasks-ui.md` "Consultations centre
  on the task"). A reply's linked files are stored as `linkedFiles` (`data-file-linked`). Test:
  `client/tests/consultation-task.test.ts`. The line 「この回は、会社の記録…の道具なしで答えています」
  (`data-record-tools-missing`, `records.md` "When the record tools are missing") is live only: never stored.
- A message stores its tool calls only as `[Tool: name]` text (plus `toolLines`, see 「Tool rows」); what must survive a restart is a
  record next to `content`: `choicePrompts`, `steerInstructions` (both with `at`),
  `consultationReferences`, `droppedRecords` (records dropped on the input that went with it,
  kept in the user message's metadata), `reviewRequests` (restored as `data-review-request` parts after the
  text), `pluginOperations` (an outside system's write and its 「変更前の値を書き戻す」, restored as
  `data-plugin-operation` parts; `plugins.md` "The app"), `secondOpinions` (the other AI's answer,
「Codex の答えを全部見る」, `chat-and-agents.md`), `minutesDealChoices`
  (「どの案件の議事録ですか？」, `minutes.md` "The app"), `mailDrafts` (the mail card, `data-mail-draft`,
  `outbound-mail.md`), `shareProposals` (「部署に出す案」, `data-share-proposal`, a reference only: the press reads the task
  again, `records.md` "Owner-only records"), `browserPlans` (a 「ブラウザ操作」 plan's card, `data-browser-plan`, a reference only:
  the card reads the server, `agent-browser.md`), `browserInspections` (a 「ブラウザ操作」 inspection's card,
  `data-browser-inspection`, a reference only: main holds the card in memory, so after a restart it says the result is
  gone, `agent-browser.md` "The inspection in the chat"). The app's cards come back after the text in
  the order the tools produced them (`cardOrder`: their part ids, stored when a reply has two or
  more; `inCardOrder` in `chatSessionMessages.ts`). A conversation started from minutes keeps
  `minutesId` (and its title, not generated). One started by 「相談する」 keeps `topicRecordId`
  (its main topic, 主な話題), also in its summary, so the next 「相談する」 finds it
  (`tasks-ui.md` "Consulting about a task"). A message the app wrote for the AI keeps
  `appInstruction` (`client/shared/app-instruction.ts`): restored as `metadata.appInstruction`,
  never drawn as a bubble, previewed or searched (`tasks-ui.md`). A message the app sent in the member's place to start a
  consultation (`chat.newConsultation`'s first message, an automatic 「AI の番」's) or into it (`chat.askToFix`'s request:
  the in-place fix stays in the consultation's history, followed by the AI's reply) keeps `appSent` (`metadata.appSent`,
  `appSentOf`): drawn as a bubble as before, but never the member's own request (`records.md` "The AI at the member's
  request").
- **`updatedAt` is when the conversation changed** (staging 2026-11-02: every conversation showed the
  time a new app version first opened, and the list lost its order): `save()` keeps the stored time
  unless a message (id, role, words) or the draft differs — a save of the same words with other fields
  (a newer app's, a restore) never moves it (`sameConversation`). Times an earlier version stamped that
  way are put back once at load: no draft and saved more than 15 minutes after the last message → the
  last message's time (`repairedUpdateTimes`), written with the next save. Tests:
  `client/tests/chat-history-store.test.ts` (「a save of the same words in another shape…」, 「times an
  earlier version stamped…」).
- Autosave every 4 s (unload and leaving a tab still flush synchronously); it skips building the
  session when nothing changed; converted messages are cached per UIMessage object.
- Attached images: the AI gets the full image; bubble and history keep a ≤ 320 px WebP thumbnail
  (`features/chat/historyThumbnail.ts`). Old full-size data URLs still load. An image that
  cannot be read stops the send: the typed text goes back into the composer with
  「添付した画像を読み込めなかったため、送信しませんでした。…」 (`useMessageAttachments.ts`
  rejects; `tests/ui/chat-panel.spec.ts` 「an attached image that cannot be read…」).
- Tests: `client/tests/chat-history-store.test.ts`.

## Rendering (`client/src/features/chat/`)

- `MessageList` renders the latest 50 messages (`messageWindow.ts`, anchored by message id so
  streaming messages append); 「以前のメッセージを表示」 adds 50 and keeps the scroll position.
  Messages older than the latest 20 use `content-visibility: auto`; hidden tabs use
  `content-visibility: hidden`; `ChatPanelChat` (`ChatConversation.tsx`), `MessageList`,
  `MessageItem` and `ChatInput` are memoised with stable props.
- While a reply streams, the list follows the bottom unless the member scrolled up to read:
  only a move up that leaves the view more than 120 px from the bottom stops following
  (`hooks/useChatAutoScroll.ts`). The browser's scroll anchoring also moves the view (down) when
  the reply grows; counting that as reading stopped the follow under load. Content that grows after its
  render (a rich reply's frame taking its height) asks the same rule through `ChatFollowContext`
  (`chatFollow.ts`, `followIfFollowing`), never a rule of its own. Test:
  `tests/ui/chat-panel.spec.ts` 「a streaming reply follows the bottom …」, `tests/ui/chat-rich-reply.spec.ts`.
- The scrolling list (`MessageList`) is `relative`, the containing block of anything absolutely
  positioned inside it (Tailwind `sr-only`, overlays). Without it a card's `sr-only` text was
  laid out against the page ~10 000 px down and the whole window painted shifted (staging,
  milestone 3). Test: `tests/ui/chat-panel.spec.ts` 「a card with screen-reader-only text …」.
- Markdown renders per top-level block (`markdownBlocks.ts`: split only at blank lines outside
  fences before a non-indented, non-list line; a reply with link/footnote definitions stays one
  block), so streaming re-parses only the last block; an unclosed fence shows plain until it
  closes. The stream throttle is 150 ms once a reply passes 8,000 characters.
- Syntax highlighting is PrismLight with a curated language set (`codeHighlighter.tsx`:
  ts/tsx/js/jsx, python, bash/sh/zsh, json, yaml, markdown, html/xml, css/scss, sql, diff, go,
  rust, java, kotlin, swift, c/cpp/csharp, ruby, php, powershell, toml, ini, docker, graphql);
  others render plain. This keeps the renderer bundle under its budget (2.48 MB → 1.97 MB).
- A finished reply is searched once (not per streamed chunk) for the key broker's "no key" marker
  (`features/chat/brokerKeyNeeds.ts`); each service found gets a 「<サービス> の鍵がありません」
  card after the parts (`features/chat/components/BrokerKeyNeededCard.tsx`, `key-broker.md`
  「自分の鍵」 is the one place for keys). Tool outputs are not stored in history, so a restored
  conversation shows the card only when the AI's text kept the marker.
- **Tool rows** are plain Japanese for non-engineers (owner, 2026-11-02): never a raw tool id
  (`mcp__acb_records__…`), not even in brackets. `client/shared/tool-display.ts` (pure):
  `ToolDisplay` = `label` (finished, 「決めたことを残しました」), `running` (「…しています」), `many`
  (`{n}`, 「決めたことを {n} 件残しました」) and an optional `describe(input)` detail.
- **The renderer names every ACB tool by its name alone** (`client/shared/acb-tool-displays.ts`),
  in every kind of consultation — normal, a person-started step, an unattended 「AI の番」, restored
  history — without depending on a line from main (staging, 2026-11-02: every row of a minutes
  reading read 「道具を使いました（acb_records・minutes_read）」). Fixed tools are listed in
  `ACB_TOOL_DISPLAYS`, and their definitions take `display` from there (`recordToolDisplay`,
  `fixedToolDisplay`; `RecordToolDescriptor.display` is required, so a provider's new tool in
  `records/tool-providers.ts` needs an entry). A record type's action (`<type>__<action>`) reads
  its Japanese action label in the past tense (`actionToolDisplay`: 「議事録を読み終える」 →
  「議事録を読み終えました」; core types in the renderer, the company's definition in main); a
  plugin operation reads `pluginOperationDisplay` (main) or a sentence from its name. Built-in
  agent tools are in `tool-display.ts`. Anything else reads 「ほかの道具を使いました」, muted; its
  server and tool show only in the expanded row (「道具の名前：…」). `tests/tool-display.test.ts`
  fails when a tool a turn can get has no Japanese name in the renderer.
- A detail is a title, a count or a company-relative path (outside the company folder: the file
  name only), ≤ 40 characters with key/token-looking strings masked (`shortText`): never command
  text (Bash shows Claude's own `description` only), mail addresses or subjects, URL paths.
- Main adds what only it knows (`electron/tool-display-stream.ts`, after the payload limits): the
  company's own type / plugin labels and the detail with the company folder, on the part as
  `callProviderMetadata.acb.display` (never for an unknown tool). Consecutive finished, successful
  calls of one tool become one expandable row (`SameItem`). A failed call reads
  「できませんでした：<reason>」 where the reason is only the app's own Japanese refusal (`{ error }`
  answer, `failureOf`), never raw English. History keeps calls as `\n[Tool: name]` markers (the
  hand-off compares that text; `recovery-context.ts` reads restored calls as the same markers) plus
  `toolLines` (label and `many` of a company's own type / plugin tools, never a detail);
  restoring turns each marker into a `data-tool-call` part drawn as a row. The rows are
  `components/ToolRows.tsx`. A finished write of an HTML file in the company folder carries
  ［見る］ (`documentLink.ts`, `editor.viewDocument`; doc-frame.md "The chat's ［見る］ (A3)"): the
  viewer never opens by itself. Tests: `tests/tool-rows-real-path.test.ts` (the real main → renderer
  path of an AI turn, with and without main's lines, restored), `tests/tool-display.test.ts`,
  `src/features/chat/tool-rows.test.ts`, `tests/chat-panel-helpers.test.ts`.
- **The approval banner** (`ToolApprovalBanner.tsx`, owner 2026-11-23: members never see developer
  words) is titled 「AI がこの操作をしてよいか確認しています」 and says what will happen in plain Japanese
  (`client/shared/tool-approval-words.ts` `approvalWordsOf`): a command the hook asks about by its
  entry in `client/shared/dangerous-commands.ts` (the list `agents/claude.ts` asks with, so the two never
  drift: 「ファイルを消すコマンドを実行します」), any other command 「コマンドを実行します」, another tool its row label
  as 「…します」, an unknown one 「ほかの道具を使います」. Under it, Claude's own one-line `description` of the
  command (the hook passes it in the request's `toolInput` for display only), masked by `shortText`.
  The tool's name and the exact command / path stay behind 「くわしく」 (`<details>`). The list's
  「許可を待っています：…」 uses the same words. Presentation only: what is asked and what 許可 allows are
  unchanged. Tests: `src/features/chat/tool-approval.test.ts`, `tests/dangerous-command-hook.test.ts`
  (one example per entry through the real hook asks; the list's length pinned at 20; the description).
- Per-turn tool payload cap (`electron/ui-stream-limits.ts` `turnBudget`): after 2 MB of tool
  inputs/outputs in one turn (api-key mode 8 MB), later payloads are cut to 1 KB and input deltas
  stop; rows, states, errors, answer text and data parts are untouched.
- **Diagrams in a reply** (owner decision 2026-11-28, step ① of 「図とページで返す」; ② is "Page cards in a reply"
  below). A closed ```` ```mermaid ```` block, or a ```` ```svg ```` / ```` ```xml ```` / unlabelled block that is one
  whole `<svg>` (`diagrams.ts` `diagramOf`; ```` ```html ```` stays code; over 60,000 characters — mermaid 20,000 — stays code), is drawn as a
  picture (`components/ChatDiagram.tsx`) with 「図のもとの書き方」 folded under it; while drawing, 「図を描いています…」; a block
  that cannot be drawn (or takes over 15 s) is the code it was. **Nothing in a diagram runs or reaches the network** (the text is the AI's,
  which may have read a planted instruction; `diagramRenderer.ts`): **mermaid runs in a hidden same-origin frame whose
  own CSP allows scripts from the app's files and images from `data:` only** (review of this change: mermaid draws in a
  live document before anything is sanitised, and a node's `img:` runs `new Image()`, a sequence actor's icon inserts an
  `<image>` — the app page's CSP still lets some image hosts in), with `securityLevel: 'strict'`, no HTML
  labels, its `%%{init}%%` directives and front matter removed (`mermaidWithoutConfig`) and its settings `secure`; every
  SVG — mermaid's and the AI's — keeps only drawing elements (no script, foreignObject, image, a — unwrapped to a group —,
  animate / set, feImage), no `on*`, no reference but `#id`, no outside `url()`, no CSS with `@import`, fonts or
  escapes (`svgCleaning.ts` `sanitizeSvg`, on the walk shared with a rich reply's HTML, "Cleaning the AI's markup"
  below); and the result is an `<img src="data:image/svg+xml">`,
  so even what a sanitiser missed cannot run or load. Diagrams are drawn whatever 「返事の形」 (it only says whether the
  AI is told they are welcome: `client/shared/reply-style.ts`; `chat-and-agents.md` "What ACB tells the AI"). Each
  picture is drawn once per text and theme and kept (`watchDiagram`, ≤ 100 unwatched kept), one mermaid at a time.
  **mermaid is not in the renderer bundle**: `@mermaid-js/tiny` (~2.8 MB, one file) goes to `dist/vendor/` (`vite.config.ts`
  `assetFileNames`) and is loaded (into that frame) only when the first mermaid diagram is drawn; `scripts/check-bundle-size.mjs`
  measures it against its own budget and fails on any other file there (`testing.md` "Performance baselines").
  「返事の形」 is stored with the consultation (`replyStyle: 'rich'`, absent = ふつう; saved by the renderer with the
  draft, `useChatHistory`), read by each request through a ref (`chatRequestBody.ts`), offered only to an agent with
  `capabilities.richReplies` (Claude Code, Codex), and may change while a turn runs (it is for the next message).
  Tests: `src/features/chat/diagrams.test.ts` (which blocks are diagrams; directives removed),
  `tests/ui/chat-diagrams.spec.ts` (drawn as pictures and mermaid loaded only then; a planted SVG and mermaid run nothing,
  make no outside request — a mermaid image node and actor icon included —, and leave no script, handler, link,
  foreignObject or outside reference in the picture — mutation-checked with the sanitiser off, with the frame's CSP off
  and with mermaid's directives honoured; an undrawable block stays code; the
  switch and the request; `SCREENSHOTS=<dir>`), `tests/chat-panel-helpers.test.ts` (the request reads it per request),
  `tests/chat-standing-instructions.test.ts` (the one line with the turn, only for リッチ and an agent that takes it).
- **Cleaning the AI's markup** (one walk, two allowlists; owner 2026-11-28: the rule lives in one place).
  `markupCleaning.ts` holds what every cleaner of the AI's markup shares: the text is parsed in an inert DOMParser
  document (`parseInert`: nothing runs or loads while it is cut); `cleanTree` walks it once, removes comments and
  processing instructions and every `on*` attribute whatever the allowlist says, and asks the allowlist's
  `CleaningRules` only what to keep (an element kept, unwrapped — its words stay —, removed with its contents, or
  replaced; an attribute's kept value or none; a last check once its inside is clean); `cssLoadsOrRuns` is the one
  list of CSS that loads or runs something (an outside `url()`, `@import`, `@font-face`, `image-set` / `image()`,
  `expression()`, `javascript:`, any escape). The two allowlists: a diagram's picture (`svgCleaning.ts`
  `sanitizeSvg`, "Diagrams in a reply" — unchanged by the move, except that comments inside a picture now go too,
  which draws the same) and a rich reply's HTML (`replyHtmlCleaning.ts` `sanitizeReplyHtml`, below). A gap found in
  the walk is fixed there, for both.
- **Rich replies: the cleaning of the AI's HTML** (owner decisions 2026-11-28, 「リッチな返信」; PR1 of 4: the
  function and its tests; PR2 draws it in the reply's closed frame, below; PR3 the AI's line; PR4 the buttons, below).
  `sanitizeReplyHtml(markup) → { html, css }`, the first of the two guards (the second is the closed frame, PR2): what
  it returns runs nothing, loads nothing, sends nothing, cannot leave the reply's box and does not move for ever,
  **even drawn in a frame that would allow it** (the spec checks exactly that). Kept: text, headings, lists, tables,
  emphasis, quotes, `details` / `summary`, sections, `class` / `style` / `title` / `lang` / `dir` / `role` /
  `aria-label` / `aria-hidden` and a few per-element attributes (`colspan`, `open`, …). **Newly allowed** (owner):
  `input` of type `radio` / `checkbox` only (`type`, `name`, `id`, `checked`, `value`) and `label` (`for`) — tabs and
  toggles through `:checked`; every other input type, `form`, `button`, `select`, `textarea`, … go with their
  contents, so nothing can be typed or sent —; `a` with an `http(s)` address only, with no user name or password
  (`https://app.acb@evil.example/` reads as one place and goes to another; written back as the browser reads it; any
  other link — `javascript:`, `data:`, `file:`, no scheme — keeps its words, not itself; `ping`, `target`, `download`
  go); CSS `animation-*` / `transition-*` and `@keyframes`, cleaned like any declaration, **at most 3 animations on an
  element, each at most 10 runs of at most 10 s, starting at most 10 s late** (`infinite`, longer, later and more are
  dropped: no endless motion, not even a chain of delayed runs — independent review). Pictures:
  a raster `data:image/(png|jpeg|gif|webp);base64` only; an inline `<svg>` or an SVG `data:` image goes through
  `sanitizeSvg` with its CSS animation and transition taken out first (a reply's picture does not move: an SVG image
  runs its own CSS motion, past the limits above — Codex review; the diagrams are not touched), must be well-formed
  XML, and becomes `<img src="data:image/svg+xml;charset=utf-8,…">` in one spelling. Removed with contents: script, noscript, template, style (its CSS is read separately), link, meta, base,
  title, head, xmp, noembed, noframes, iframe / frame / frameset, object, embed, portal, fencedframe, media, picture, canvas, map, dialog,
  MathML; any other element (marquee, a custom element) is unwrapped. **CSS** (`<style>` text and `style`
  attributes) is read by the browser's own parser (a constructed `CSSStyleSheet`, which loads nothing; escapes are
  undone, custom properties keep theirs and are refused by `cssLoadsOrRuns`) and written back as listed properties
  (or their longhands) — **a custom property only with a plain name (`--[A-Za-z0-9_-]{1,64}`) and a plain value
  (colours, numbers, `var()`, `calc()`: no quotes, braces or semicolons)**, since the parser hands its name back with
  escapes undone (independent review: an escaped name spelled `}` or `</style>` and ended the rule or the element) —
  with values that hold no `url()` at all, `cross-fade`, `element()`, `paint()`, `src()`,
  `attr()`, escapes or `<` (so the CSS can never end the `<style>` it is put in), no viewport units, `position` only
  `static` / `relative` / `absolute`, `content` only a plain string, no viewport or container units (`vh`, `dvw`,
  `cqw`, …); only style rules (their nested rules dropped),
  `@media` / `@supports` around them and `@keyframes` stay — `@import`, `@font-face`, `@layer` and every other
  at-rule go —, and no selector naming the document (`:root`, `:scope`, a top-level `&`, `:host`, `html`, `body`,
  `::backdrop`, …; `*` and the like still match the frame's root, which the closed frame keeps apart — the frame
  puts its own CSS in a `<style>` before the reply's and clips what it shows to its box). **What is kept must read back
  the same**: the sheet and each `style` are parsed again and must clean to themselves, and the sheet holds no `<`;
  otherwise it is dropped whole (so nothing is left open to swallow the CSS that follows). Raster pictures may be
  animated (GIF, APNG, WebP): the motion limits are CSS's only.
  **A piece still being written** is cleaned the same way: the parsers close what is open, a tag cut inside an
  attribute is no element. Anything that throws gives `{ html: '', css: '' }` (nothing rather than half cleaned).
  Tests: `tests/ui/chat-reply-cleaning.spec.ts` (preview `chat-reply-cleaning-ui.html`, which exposes the function;
  traps in `tests/ui/fixtures/reply-html-traps.ts` — both demo versions' and the parsers' corners): a reply as the AI
  writes it keeps its look and scriptless parts; an independent audit of the allowlist finds nothing in the cleaned
  traps and the result reads the same when cleaned again (no markup that changes on a second reading); the cleaned
  traps drawn in an unsandboxed frame, pressed, hovered, checked and tabbed through run nothing, make no outside
  request, stay in the frame, fix nothing over the app and run no endless animation — and the same frame with the
  traps as written does all four (the checks can fail); every piece cut every 3 characters is as clean; CSS put after
  the reply's (a sentinel rule, a sentinel declaration) still reads as its own.
  Mutation-checked guard by guard (the PR lists them).
- **Rich replies: the reply's closed frame** (PR2 of 「リッチな返信」, owner decisions 2026-11-28 「シームレス版」).
  A text part with a ```` ```acb-html ```` (an explanation) or ```` ```acb-slide ```` (one 1280×720 page) block
  (`richReply.ts` `hasRichBlock` / `richPiecesOf`: the fence at a line's start, its info exactly that, case-insensitive,
  not inside another fence; ```` ```html ```` and every other fence stay code) is drawn **whole — its Markdown too — in
  one frame with no line or background of its own** (`components/ChatRichReply.tsx`), whatever 「返事の形」; with the
  Markdown display off it stays plain text. Tool rows and cards stay outside: each such text part is its own frame.
  - **Two guards, each enough alone.** (1) Every piece — the AI's blocks and the chat's own Markdown (drawn the
    chat's way into static HTML, `richReplyMarkdown.tsx`: raw HTML skipped, pictures as words, code by the chat's
    highlighter) — goes through `sanitizeReplyHtml`, each on its own, and the pieces are joined as one tree
    (`richReplyFrame.ts` `frameContentOf`: a block cannot close the frame's wrappers; the CSS is refused if it holds
    `<`); a block still being written is cut back to its last whole tag, outside an open `<style>` or table row
    (`writtenSoFar`), and cleaned like the rest. (2) **The frame the member sees has `sandbox="allow-popups"` only — no
    `allow-scripts`, no `allow-same-origin` (an opaque origin: the chat cannot reach into it, it cannot reach the
    chat) — and its document starts with its own policy** `FRAME_CSP` (`default-src 'none'; img-src data:;
    style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'`) and
    `x-dns-prefetch-control: off`, before anything of the reply. Neither is to be widened for a convenience (no script for the height, no same origin for
    the links): this is the owner's line.
  - **Links**: the frame's `<base target="_blank">` makes a pressed web link (only `http(s)` survive the cleaning)
    ask for a new window — the one thing `allow-popups` permits —, which the app's window-open handler opens in the
    member's browser (`electron-adapter.ts` `keepAppPageInWindow`, `webLinkForBrowser`: the path of every chat link).
    The frame itself never navigates (no `target` is kept, `_top` is refused by the sandbox), and **main refuses it
    too**: `keepAppPageInWindow`'s `will-frame-navigate` lets a frame showing a srcdoc (also after an in-page jump,
    `about:srcdoc#…`), a frame inside one and a navigation one starts go only to a srcdoc again
    (`client/shared/srcdoc-frames.ts`; `ipc-and-main-process.md` "Windows"; `tests/reply-frame-electron.test.ts`).
  - **Height** (no scroll inside): nothing can leave the shown frame to say how tall it is, so the chat lays the same
    document out in **one hidden copy** (`measureReply`, one per window, one reply at a time): `sandbox="allow-same-origin"`
    (still no script), the same policy, `inert`, `aria-hidden`, off screen and invisible — never pressed, hovered or
    focused —, reads its height there (pictures decoded first) and is emptied again. **The box is as tall as the reply
    can become** (Codex review: the shown frame cannot say it grew): once written, the copy is also laid out with
    every `<details>` open, check boxes both ways and each radio choice (`tallestState`, at most 24 inputs: the
    layouts run on the app's thread), so a step opened or a tab switched is never cut off — a reply that can be
    opened keeps that room below it while closed. Heights are kept per width, theme and text, only once written
    (`knownHeights`, ≤ 200). The copy is made again if it left the page; an unmeasured reply keeps the ordinary
    rendering. **Owner condition for the copy (2026-11-28): no frame of the app is ever sandboxed with both
    `allow-scripts` and `allow-same-origin`** — `tests/frame-sandbox.test.ts` reads every string of the app's code
    (renderer, main, shared; comments left out) and fails on a file holding both, and pins the two sandboxes here
    exactly; the spec checks every frame on the chat page. Over **20,000 px** as written (`RICH_MAX_HEIGHT`) the frame stops there and 「この返事は長いため、
    途中までを表示しています。続きは［大きく見る］で見られます。」 follows, with a ［大きく見る］ button when the conversation can keep pages (`onOpenLarge`, below).
  - **Being written**: drawn again at most every 80 ms (`RICH_UPDATE_MS`), one drawing at a time. The shown frame is
    never rewritten: the next one loads out of sight and takes the old one's place once drawn (two animation frames
    after its `load`), so there is no empty moment; until the first frame has drawn, the chat's ordinary rendering
    holds the place. A new height makes the list follow the bottom only when it was following (`ChatFollowContext`).
  - **The look is the chat's**: the app's tokens (`:root` / `.dark` custom properties) and its Markdown typography
    (the `prose` rules, `CHAT_MARKDOWN_CLASS` shared with `MarkdownMessage`) are read from the app's own style sheets
    into the frame, then a few resets and the ready-made boxes (`acb-key`, `acb-note`, `acb-warn`, `acb-ok`,
    `acb-steps`, `acb-compare`, `acb-tabs`, `acb-tip`, `acb-bar`, `acb-muted`: tokens only). **The AI is told about
    them** (PR3) only with 「返事の形：リッチ」 (`reply-style.ts` `RICH_HTML_INSTRUCTION`, its markup in `RICH_HTML_PIECES`,
    `chat-and-agents.md` "What ACB tells the AI"); ふつう and the API key add nothing, and such a block is drawn
    either way. Nothing was added to the cleaning for them: `class` is kept on any element, and only the frame's own
    CSS gives these names a look. Test: `tests/ui/chat-rich-reply.spec.ts` 「the ready-made pieces the AI is told
    about…」 (every piece kept by the cleaning, each class has a frame rule, the boxes have their own background, and
    boxes and marks reach a contrast of 4.5 in light and dark), `tests/chat-standing-instructions.test.ts`. The reply's CSS sits in a
    `<style>` of its own after the frame's. **Light / dark** follows the app, not the computer: the frame's `<html>`
    gets `dark`, and the reply's own `prefers-color-scheme` queries are rewritten to always / never hold
    (`cssForTheme`); a switch loads the next frame the same way (no empty moment). A slide is scaled to the reply's
    width by CSS alone (`container-type` + `calc(100cqw / 1280px)`).
  - **Long conversations**: a frame is drawn only within 600 px of the list's view (one IntersectionObserver per
    list, disconnected with its last reply) and taken down farther away, its box keeping its height; on top of
    `MessageList`'s latest-50 window.
  - Selection and copy across the reply's words, tables and boxes work inside the one frame. A ```` ```mermaid ````
    block or a page card inside such a reply stays code / a plain link (the frame draws neither).
  Tests: `src/features/chat/richReply.test.ts` (which replies and pieces, cut-off pieces, the theme rewrite),
  `tests/ui/chat-rich-reply.spec.ts` (real chat `chat-header-ui.html?turn=manual`, and the frame alone on
  `chat-rich-reply-ui.html`): the sandbox, policy and hidden copy as above, words and HTML in one frame, selection,
  ```` ```html ```` stays code; the demo's traps streamed 400 characters at a time then pressed, hovered, checked and
  tabbed: nothing ran, no request and no window left, nothing fixed, no endless motion; the uncleaned traps and raw CSS
  measured in the hidden copy run and load nothing and are not left there; a web link leaves only as one
  new window to its address; every piece cleaned and kept in its place; height = content, the 20,000 px stop; a step
  opened, a tab switched and a taller dark layout never cut off; no empty
  moment and at most about one frame per 80 ms while written; following / not moving the reader; light / dark with the
  reply's own dark colours; a slide scaled whole; `?history=long&rich=1` keeps ≤ 8 frames live while scrolling and the
  list's height unchanged; **the frame alone with uncleaned traps** runs and loads nothing, shares no origin and cannot
  move the app — and with its policy off the traps load, with its sandbox off a link moves the app (the checks can
  fail). The policy is pinned whole. Mutation-checked: the sandbox, the policy, following, the double frame,
  near-screen drawing, the height, the tallest state, heights per theme and the theme rewrite each fail a test when
  taken out. `SCREENSHOTS=<dir>` shoots a reply light and dark.
- **Rich replies: ［大きく見る］［ページとして残す］［コードとして見る］** (PR4 of 「リッチな返信」, owner decisions 2026-11-28 ①④).
  `components/ChatRichReplyView.tsx` wraps every rich reply: three small icon buttons at its top right (a `toolbar`
  「この返事の表示」), transparent until the pointer is over the reply or one of them has the keyboard's focus (always in
  the tab order, after the reply; placed after the frame in the page's order, so drawn over it without a z-index).
  - **［大きく見る］** keeps the reply as a page and runs `editor.viewDocument` on it (in a consultation's own window
    `file.open`, as the page cards): the HTML viewer opens it (doc-frame.md: its own view, no network, an opaque origin,
    that folder only). **［ページとして残す］** keeps the same page and shows it under the reply as a page card
    (「ページとして残しました」, 「ページ・あなただけに見えます・<name>」), which opens it the same way. The same reply in the
    same conversation keeps one file (remembered per conversation and text, ≤ 100) while it is still there (`fs:exists`;
    moved or deleted → kept again under a free name); while the reply is still being written the two are disabled; a
    refusal shows as an alert line.
  - **The page is the AI's HTML as written** (owner ④): `richReplyPage.ts` `replyPageDocument` — the reply's Markdown as
    the chat draws it, each ```` ```acb-html ```` / ```` ```acb-slide ```` block uncleaned, the app's tokens, typography and
    ready-made boxes (`appCss`, `FRAME_CSS`); a small script of its own sets `.dark` from the computer's setting (the
    reply's own `prefers-color-scheme` follows the computer there too). Only the viewer may hold it: the chat's frame
    still draws the cleaned reply.
  - **Main writes it** (`electron/features/reply-pages/ipc.ts`, `replyPage:save(rootPath, todayFolder, consultation,
    html)`; `files-and-editor.md`): the renderer hands the company folder (checked by the allowed roots), the today
    folder the chat requests already carry, which consultation (company and conversation id) and the page — never a
    file path. Main builds `<root>/<today folder>/ページ/<name>.html` with `replyPageFolderOf` (only a today folder of the
    app's shape: never the top level, never another place), refuses a department not on this computer, a folder not
    downloaded and a reserved name (the folder's and the file's), checks the folder by real location before and after
    making it and refuses a link anywhere from the department down to `ページ/` (Codex review: a link to a shared folder
    inside the company folder passes the root check, and the page would be synced), names the page after
    the consultation's stored title (`client/shared/reply-pages.ts` `replyPageBaseName`: path, Windows, control,
    invisible and direction characters out, ≤ 40 characters, else 「AI の返事」) and creates it with `wx`, trying
    「名前 (2).html」… up to 50: nothing is ever replaced. The buttons that keep a page show only where the conversation has
    a today folder (`ReplyPagesContext`, given by `ChatConversation`): not in a consultation's own window.
  - **［コードとして見る］** shows the reply as the chat's ordinary Markdown (its blocks as code, no frame); pressed again
    (「整えた表示に戻す」, `aria-pressed`) the frame comes back.
  Tests: `tests/ipc-reply-pages.test.ts` (the page in ページ/ named after the consultation, as written; a taken name gets
  (2), (3) and the member's file is untouched; another root, a climb, another shape, the top level, a department not
  here, a link out of the company folder and a link to a shared folder inside it are refused with nothing written
  there; not a page refused; the name rule; mutation-checked: `wx`, the folder shape, the real-location check, the link
  check), `tests/ipc-path-guard.test.ts` (`rootPath`
  GUARDED), `tests/ui/chat-rich-reply.spec.ts` 「the reply's buttons」 (`chat-header-ui.html?pages=1`: hidden until
  hover or focus, three buttons only with a today folder; disabled while written; ［大きく見る］ asks main once with the
  uncleaned block and opens the viewer, the chat's frame still without the script, and a deleted page is kept again; ［ページとして残す］'s card and a refusal; ［コードとして見る］;
  the 20,000 px line's button; mutation-checked: the focus rule, the one file per reply).
- **Page cards in a reply** (step ② of 「図とページで返す」, 2026-11-28). A link in a reply to one `.html` / `.htm` file of the
  company folder (`pageCards.ts` `pageCardOf`: an absolute path under the company root or a path relative to it, below a
  folder — never the top level —, no `.` / `..` / empty segment, no scheme, query or fragment, no control, invisible or direction character (a shown name cannot lie), not hidden) is drawn as a
  card (`components/ChatPageCard.tsx`: the link's words, 「ページ・あなただけに見えます」 for a page in a `.personal/`
  folder, the file name, 「見る」), a `<button>` inside the paragraph. Pressing it runs `editor.viewDocument` (in a
  consultation's own window `file.open`, which asks the main window; there `useFilesFromChatWindows` runs an `.html`
  file as `editor.viewDocument`, so a tab showing 中身 comes back as 見る — Codex review): the page opens in **the HTML viewer as it is**
  (doc-frame.md: its own view, no network, nothing of the app) — no new viewer; the card reads nothing of the page and
  draws no frame. Every other link stays a link. Cards are drawn whatever 「返事の形」, like diagrams. **Where the AI puts a
  page**: リッチ adds one sentence (`reply-style.ts` `replyPageInstruction`) naming
  `<company root>/<今日のフォルダ>/ページ/` (`REPLY_PAGE_FOLDER`) — the member's own, never synced
  (`[PERSONAL_PATH]`), so what the AI makes is first the member's alone; a folder of its own so a page's scripts (which may
  read their folder, doc-frame.md) reach only other pages. Only a today folder of the app's shape (`isTodayFolderPath`)
  gives the line; none (a consultation's own window, no department here) → no page line. The write guard treats
  `.personal/` as never shared (`chat-write-guard.md`). Tests: `src/features/chat/pageCards.test.ts` (which links are
  cards), `tests/ui/chat-page-cards.spec.ts` (`editor-tabs-ui.html?view=html`: two cards among planted links, a press
  opens exactly that page's tab as 見る — also from 中身 —, no frame, the page's script never runs in the app, no outside
  request), `tests/ui/skill-layout.spec.ts` 「an HTML page asked for from a consultation's own window…」,
  `tests/chat-standing-instructions.test.ts` (the page line names the today folder; none for another shape, no
  folder, ふつう or the API key), `tests/doc-frame-electron.test.ts` 「a page the AI made in the 今日のフォルダ…」 (real
  Electron: a planted page there loads its own folder's image but not the day's files, other personal files, the
  company's, a key file by `file:` / `local-file:`, the app, storage or the web).
- Preview `client/tests/chat-header-ui.html?history=long` (a restored 240-message conversation);
  tests `src/features/chat/chat-rendering.test.ts`. UI specs drive replies through `window.__acbChat`
  (`chat-header-ui.html?turn=manual`; see `testing.md`).
