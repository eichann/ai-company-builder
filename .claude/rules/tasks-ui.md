---
paths:
  - "client/shared/tasks.ts"
  - "client/shared/task-card.ts"
  - "client/shared/tag-suggest.ts"
  - "client/tests/tag-suggest.test.ts"
  - "client/tests/task-card*"
  - "client/tests/ui/task-card.spec.ts"
  - "client/src/features/chat/components/PreparedMailCard.tsx"
  - "client/src/shared/lib/dragTypes.ts"
  - "client/src/features/files/contextMenuItems.tsx"
  - "client/src/features/minutes/startReading.ts"
  - "client/electron/features/tasks/**"
  - "client/src/features/tasks/**"
  - "client/tests/tasks-*.test.ts"
  - "client/tests/tasks-*-ui.*"
  - "client/tests/ui/tasks-*.spec.ts"
---

# The task list and the task card in the app (やることの一覧・カード, stage 2 S7b / S7c)

The standard list belongs to the core (owner decision 2026-11-01, 「タスクの一覧は本体に」): what
waits for the member, the AI and others, today's meetings and today's done, in one place. A plugin
may later add another look; the list, its data, states and rules stay the core's. Server side:
`records.md` (types, queries, turns), `tasks.md` (company settings), `calendar.md` (today's
meetings), `notifications.md` (the title bar's 「あなたの番」).

## Main (`client/electron/features/tasks/ipc.ts`, session only)

- `tasks:list(companyId)` reads, with the member's session (it stays in main): `/api/me` (who the
  member is, cached per session), `GET /records/my-turn`, `GET /records/ai-turn`, `POST
  /records/query` for unfinished tasks the member asked of someone (`requested_by` = them) and for
  tasks finished today (`finishedSince` = the start of the company's day, assigned to or asked by
  them), `/records/types` (labels), `/members` (names), `GET /task-settings` (which departments
  show the list), and each task's detail for its まとまり (cached per record version, at most 150
  per read). Nothing is filtered or added in main: the server answers only what the member may
  read (owner-only records included). Records off → `available: false` (no tab).
- `classifyTasks` (`client/shared/tasks.ts`) places each record **once**, first place wins:
  引き受け待ち (`awaiting_acceptance` in the member's turn) → あなたの番 (a task in `waiting` goes to
  ほかの人の番・返事待ち with what it waits for; `declined` says who returned it) → AI の番 → what
  others hold (「田中さんの番」, 「田中さんに頼んだ・引き受け待ち」, 「AI が用意しています」) → today's
  done. `own` = the member asked it of themselves (requester and assignee).
  Each item also carries the interfaces its type implements (`implements`, from `/records/types`):
  a plugin's peek lists by them (`plugin-frame.md` "The four slots").
- `tasks:create(companyId, { title, due?, tags? })`: the list's one line makes a task **only the
  member sees** (`personal: true`, assignee = the member; `records.md` "Owner-only records").
- `tasks:act(companyId, recordId, { action, expectedVersion, note?, args?, links?, ok? })`: one
  engine action with the session; the engine decides who may (`who`, `ok_from`). An action name
  that is not `[a-z][a-z0-9_]*` or a malformed record id never reaches the server's URL.
- Refusals: the engine's own words for members (`VERSION_CONFLICT` 「ほかの人が先に変えました…」);
  ≥ 500 / unreachable → `TASKS_OFFLINE_TEXT`. Logged: the route and status, never a title.

## Renderer (`client/src/features/tasks/`)

- The left tab 「やること」 (registered in `AppShell.tsx`, between ファイル and 検索; badge = あなたの番
  + 引き受け待ち). Shown when records are on and the company setting `taskListDepartmentIds` names
  the department on screen (`null` = every department; 全社 = any department shows it:
  `listShownFor`). The list itself is the member's, across the company (records carry no
  department the app could filter by).
- `TaskListPanel`: the list on the left, the opened item's card on the right (`renderCard`,
  composed by AppShell: the records feature's card). A まとまり chip opens that まとまり there too.
  On the main screen the card opens **where a file opens**: AppShell's `frame` puts the list and
  the card in the ファイル tab's split (`layout.files`: the list takes the file tree's width, the
  card the editor area's, one divider for both), so with the consultation open the card is never
  a strip between the list and the chat. Test: `tests/ui/tasks-layout.spec.ts` (the card area at
  least the editor area's width, 「＋ファイルをつなぐ」 left of the consultation).
- `useTaskList` (in AppShell): read at mount, on `notifications:changed` for the company (the title
  bar keeps main watching), every 2 minutes and after the member's own change. `useCalendarToday`:
  at mount and every 10 minutes.
- `model.ts` (pure, `model.test.ts`): "today" is the company's day (`companyNow`, Japan time until a
  setting exists). **By turn**: 引き受け待ち, あなたの番 (today's meetings still to come mixed in),
  AI の番, ほかの人の番・返事待ち, 先のこと (only the member's own items due after this week — folded
  until opened), 今日終わったこと (today's meetings that are over too; 「あしたの朝に空になります」).
  **By date**: 期限切れ, 今日まで (meetings to come), 今週, the far future (folded), 期限なし, 今日終わったこと.
  "This week" ends on Sunday; on a Saturday or Sunday it runs to next Sunday, so tomorrow never
  folds. A due with a time today that has passed is 期限切れ. Meetings are read, never made into
  tasks (`calendar.md`); a tag filter hides them.
- Rows: title, 「自分だけ」 lock, due (期限切れ in red), whose turn / what it waits for, 「〇〇さんの
  代わり」 for a delegate, the まとまり chip, up to 3 tags. 引き受ける on 引き受け待ち rows; 「終わった」
  only on the member's own tasks (`own`: start first when not started, then complete, each at
  the version it moved to — the list never states someone's OK; that is the card's). An AI-turn
  row shows the automatic runner's state and reason (`AiTurnItemView`, `ai-turns.md`) with
  「もう一度」 / 「人に渡す」 when stopped.
- `QuickAdd` + `quickAdd.ts`: 「見積を直す 明日15時まで #営業」 → title, due (今日・明日・あさって・来週
  [曜日]・曜日・M/D, a time N時[半] / H:MM) and tags; words not understood stay in the title.
  Tags in use are offered while typing after 「#」, and a tag spelled differently from one in use
  (width, case, katakana / hiragana) is offered as that one (`similarTag`); once typing pauses
  the title's 「タグの候補」 are offered too ("Tag suggestions" below).

## The card (S7c, `TaskCard.tsx`, `client/shared/task-card.ts`)

A task opens in its own card wherever a record opens (`AppShell` `recordCard`: an id starting
`task-` — ids start with their type — gets `TaskCard`; anything else the records feature's
read-only card; an `approval-` id also gets the chat's approval card on top, where approving is
the person's press). Main: `tasks:card` reads the record, its 経緯, the type definitions, the
members and the member's open execution runs, and tells the server it was opened (`POST …/opened`,
not awaited: `records.md` "Whose turn it was"). Order (owner: 成果物は相談をさかのぼらずに届く):

1. Header: state, 「自分だけ」, tags, due (期限切れ in red), 目的; a task done on someone's OK says
   so — 「佐藤さんが阿部さんの了承を得たとして完了にしました（電話で）」 (`okWords`: an OK is never
   called an approval), in the header and in 経緯. An owner-only task offers **「部署に出す」**
   (`ShareToDepartment.tsx`): the member picks one of the departments they can write to
   (`shareFolders`, composed by AppShell from the departments and `useWriteAccess`), is told it
   cannot be made 「自分だけ」 again, and `tasks:share` → `POST …/share { folder, expectedVersion }`
   (`records.md` "Owner-only records"; main sends only a `fileLinkPath`-checked company folder; the
   server checks the owner and the folder). A task already shared offers nothing.
2. **AI が用意したもの**: `prep_summary` and each `prepared` link drawn by the screen with the
   consultation's own cards (`renderPrepared`): a mail draft through `PreparedMailCard` (chat
   feature: reads the draft now, so the latest version is checked and sent — the person sends), an
   approval request through `ApprovalCard`.
3. Runs waiting for a person (`GET /ai-runs`, `needsPerson`): the state in words; an operation
   whose outside result is unknown asks 「届いていた」/「届いていなかった」 (`tasks:reconcile` →
   `…/operations/:key/reconcile`), and only with nothing unknown 「もう一度」 (`tasks:retryRun`).
   Run ids and operation keys that could reshape the URL (`.`/`..`, separators) never reach the
   server.
4. Actions (`TaskActions.tsx`), offered from the type (`recordActionChoices`) and the member's
   place: a `who` person field holding the member, or `ok_from` (then the member must say whose OK:
   a member, or a note for an OK from outside ACB). Never the AI's own steps (`who: [ai]`:
   finish_prep, hand_over) nor actions needing a record chooser (set_bundle) or the list's own
   editors (tags, wait_until). 完了 from 未着手 / 返事待ち runs 着手 first (complete starts from
   in_progress / review), each step at the version the previous one moved to. 受けられない needs a
   reason (to the requester). 延ばす: 1時間あと / 今日の夕方 / あしたの朝 / 来週の月曜 or a date and time
   (`postponeChoices`); the server tells the requester. The server decides every action.
5. `RecordSourcePanel`: the place for a task's source (the original mail / Slack thread and the
   reply draft) that stage 3's connectors fill. The card takes `renderSource(record)` from the
   screen: `src/app/recordSource.tsx` `renderRecordSource` returns the connector feature's part
   (under its lane marker, `ipc-and-main-process.md` "Lane markers"), so `tasks` imports no other
   feature; nothing given = hidden. Test: `task-card.spec.ts` ("the source slot …").
6. Fields, 経緯, and 「つながっているもの」 with the record card's rows (`RecordRows.tsx`, registered
   import): decisions marked 例外（この件だけ） and owner-only records marked 自分だけ
   (`RecordMarks`, also on the generic card and every record row).

## Consulting about a task (S12, owner decision 2026-11-01: 「一覧から相談する」)

- 「相談する」 on the card (next to the title) and on a list row (on hover) run `chat.consultAbout`
  (`commands.md`; composed by AppShell, `consultAbout`). The chat pane opens the member's most
  recent consultation whose main topic is the task (`topicRecordId` in the history and its
  summary: this PC's consultations, the member's own); without one it starts 「<title> の相談」
  with `topicRecordId` set.
- The AI gets the task through its record tools, not pasted text: the first message (the app's
  instruction, composed by `taskConsultFirstMessage`, `client/shared/task-consult.ts`) names the task
  by id and asks it to read it with `records_get` (state, whose turn, due, links, what the AI
  prepared) and `records_history`, then wait. An agent without the record tools (`recordsMcp`:
  the API key) is only told what the consultation is about. What the AI then does in it is
  recorded by the ledger with the consultation (provenance), as for any consultation.
- **That first message is never shown as the member's words** (owner staging FB 8, 2026-11-02):
  it is a user message marked `metadata.appInstruction` `{ kind: 'task', recordId, title }`
  (`client/shared/app-instruction.ts`; stored as the message's `appInstruction`). The AI receives
  its full text (live, after a restart, on another agent); the chat draws no bubble for it
  (`MessageItem`) and shows a chip at the top instead, 「このやることについての相談：<title>」
  (`AppInstructionChip.tsx`; pressing it runs `record.open` where the screen has it). The list's
  preview (`sessionPreview`), the title transcript and body search skip it. A business plugin's
  person step's procedure is the same (`kind: 'step'`, 「この手順についての相談：<title>」,
  `chat.newConsultation` with `pluginStep`). Tests: `client/tests/app-instruction.test.ts`,
  `chat-history-store.test.ts` (search), `tests/ui/chat-panel.spec.ts` (「相談する」, 「a person step's
  consultation …」).
- Not yet: a change to the task while its consultation exists as one new card in that
  consultation (batched) — the second part of S12.
- Tests: `client/tests/task-consult.test.ts` (the latest one about that task; found after a
  restart; the first message names the id, never the contents), `tests/ui/chat-panel.spec.ts`
  (「相談する」 starts one with the topic, then opens it instead), `task-card.spec.ts`,
  `tasks-list.spec.ts` (the buttons).

## Tag suggestions (owner 2026-11-02: 「haikuとか使って」)

- Where: the one line (`QuickAdd`, `useTagSuggestions`: asked 0.7 s after typing pauses, only the
  newest answer kept, typing never waits) and the card (`TagSuggestions.tsx`: 「タグの候補を出す」 on
  the member's press, offered when `canSetTags` — the type's `set_tags` allows the member and the
  task is not finished; a picked tag runs `set_tags` with the task's tags plus it). Tags in use =
  the member's list (`tagCounts`). **Only suggestions**: nothing is added until the member picks.
- `tasks:suggestTags(companyId, title, tagsInUse)` → `{ source: 'ai' | 'local', tags }` (main,
  `electron/features/tasks/tag-suggest.ts`; pure parts `client/shared/tag-suggest.ts`). Asked
  **in the member's app**, never on the server, of `COMPANY_KEY_MODELS.tagSuggest` (Claude Haiku,
  `client/shared/agents/registry.ts`) through **the company's key**: a broker token for the job
  `app:tag-suggest` (`BrokerTokenStore.envFor`, `ACB_ANTHROPIC_API_KEY` / `_BASE_URL`), so the relay
  uses the key the admin chose for anthropic (`key-broker.md` "Which company key a service uses")
  and records the call. **Text only**: one message, no tools, no files, no commands. **Sent**: the
  title (≤ 200 characters) and the tags in use (≤ 200) as JSON data — no other record content,
  no folder names. The answer may only name tags in use (`parseTagSuggestions`: a reading or
  spelling variant maps to the tag, anything else is dropped; at most 3).
- **Silent fallback** to the app's own matching (`localTagSuggestions`: tags in use whose folded
  spelling appears in the title): no token or the placeholder (no key for this member), the AI
  stopped by an administrator (`oneShotAiAllowed`), offline, an error, or no answer within 5 s.
  Logged without the title, the tags or the token. No tags in use → nothing is sent.
- Tests: `client/tests/tag-suggest.test.ts` (only the title and tags, the company token and
  relay, the registry's model; only tags in use; every fallback; nothing sent without tags),
  `task-card.test.ts` (`canSetTags`), `tasks-list.spec.ts` (a variant suggested, added only when
  picked), `task-card.spec.ts` (asked on the press, `set_tags` with the existing tags).

## Linking files (the core's, owner decision 2026-11-01; `records.md` "Linking files later")

Three entrances, one operation (`tasks:linkFile` / `tasks:unlinkFile` → `POST …/file-links` /
`…/file-links/remove`, the version the screen shows): the file tree's right-click
「やることにつなぐ…」 (shown only while the task list shows for the department on screen; the
chooser `LinkToTaskDialog` lists the member's open tasks from the list), a file dragged from the tree
onto a task row or onto the task card (`src/shared/lib/dragTypes.ts`; the first dragged path inside
the company folder), and the card's 「＋ファイルをつなぐ」 (the company's file names on this
computer, `git:listFiles`) with 「外す」 on each linked file. Main sends only a path inside the
company folder (`fileLinkPath`: no absolute path, no `..`); the server decides the rest — both
readable by the member, never a private folder's file for a task outside it (one refusal,
`FILE_NOT_LINKABLE`, shown as the server words it). Each link and removal is in 経緯.

## Minutes and AI turns (S11, owner decision 2026-11-01: 議事録の帯をやめる)

- No banner: a received meeting is a row of 「AI の番」 (the server's `ai-turn`), showing the automatic
  runner's state in words and its reason (「AI が進めています」「AI では始められません：…」…), with
  「もう一度」 / 「人に渡す」 when stopped and, while the AI has not started it, 「自分で読み取る」 (a
  consultation the person starts, `startMinutesReading`) and 「今は読まない」 (`minutes:skip`) —
  `meetingActions`, composed by `AppShell` from the minutes feature.
- What the AI made shows where the member works: homework tasks in the list, drafts and approval
  requests in a task's card (「AI が用意したもの」), and the server's notices.
- 「どのまとまりの会議ですか？」 is an item of あなたの番: `tasks:list` also reads the member's meetings
  read in the last 14 days (`finishedSince`), and one whose detail shows no `bundle` link — only when
  the company has any まとまり (`implements: bundle`, `countOnly`) and only for a meeting whose
  detail was read — becomes `needsBundle` (「どのまとまり（案件など）の会議か選んでください」) with
  「まとまりを選ぶ」: `BundleChooser` lists the unfinished まとまり the member reads (`tasks:bundles`,
  final states of each type left out) and links the chosen one (`minutes:linkBundle`; nothing goes
  outside).
- **A department without the list** (`tasksShown` false): the same meetings reach the title bar
  instead (`notifications.md` "The app"): `meetingTurns` (`client/shared/notifications-app.ts`)
  picks the `needsBundle` items and the received meetings in 「AI の番」 from the list AppShell already
  reads, with the runner's state; AppShell gives each its buttons (まとまりを選ぶ → `BundleChooser`,
  自分で読み取る / 今は読まない for a received meeting only, もう一度 / 人に渡す). The minutes first message
  tells the AI, when none is linked, to leave the まとまり's fields and the meeting log and finish the
  rest; choosing the まとまり afterwards gives just that part back to the AI once (`minutes.md` "A
  まとまり chosen later"; the row is 「AI の番」 again, without 「自分で読み取る」 / 「今は読まない」, which are
  only for a received meeting).

## Tests

`client/tests/tasks-list.test.ts` (each record once and in its place; only one's own task
finishes from the list; the one line is owner-only and assigned to the member; a bad action name
never reaches the server; records off = no list), `src/features/tasks/model.test.ts`,
`src/features/tasks/quickAdd.test.ts`, `client/tests/ui/tasks-list.spec.ts`
(`tests/tasks-list-ui.html`: sections, meetings mixed in, folding, date view, 引き受ける, finishing,
the one line, the tag filter, a row opening its card), `client/tests/task-card.test.ts` (the
assignee completes only on a stated OK and starts first; the AI's steps and what the member's
place does not allow never offered; the OK in words; prepared apart from links; an unknown result
offers reconciling only; run ids and keys never reshape the URL), `client/tests/ui/task-card.spec.ts` (also 「＋ファイルをつなぐ」,
「外す」 and a dropped file), `client/tests/ui/file-tree.spec.ts` (「やることにつなぐ…」 only where the list
shows); `tasks-list.test.ts` also: only a company path reaches the server; a meeting read without a まとまり
asks once, only when its link was read as missing and the company has まとまり; 「部署に出す」 sends only a
company folder (`tasks-list.test.ts`) and is offered only on an owner-only task (`task-card.spec.ts`);
a department without the list gets its meetings in the title bar (`notifications.test.ts`,
`title-bar-notices.spec.ts`). `tests/ui/ai-turns.spec.ts`
and `minutes.spec.ts` drive the AI-turn row (`chat-header-ui.html`, the list left of the
consultation as on the main screen). `tests/ui/tasks-layout.spec.ts` (`skill-layout-ui.html?tasks=1`,
the real `AppShell`): with the consultation open the やること tab fills the left side from the tab
strip to the bottom, the consultation stays where it is for ファイル and 検索, and a card opens
beside the list.
