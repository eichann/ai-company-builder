---
paths:
  - "client/shared/tasks.ts"
  - "client/shared/task-card.ts"
  - "client/tests/task-card*"
  - "client/tests/ui/task-card.spec.ts"
  - "client/src/features/chat/components/PreparedMailCard.tsx"
  - "client/src/shared/lib/dragTypes.ts"
  - "client/src/features/files/contextMenuItems.tsx"
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
  (width, case, katakana / hiragana) is offered as that one (`similarTag`). There is no AI tag
  suggestion yet (the server has none).

## The card (S7c, `TaskCard.tsx`, `client/shared/task-card.ts`)

A task opens in its own card wherever a record opens (`AppShell` `recordCard`: an id starting
`task-` — ids start with their type — gets `TaskCard`; anything else the records feature's
read-only card; an `approval-` id also gets the chat's approval card on top, where approving is
the person's press). Main: `tasks:card` reads the record, its 経緯, the type definitions, the
members and the member's open execution runs, and tells the server it was opened (`POST …/opened`,
not awaited: `records.md` "Whose turn it was"). Order (owner: 成果物は相談をさかのぼらずに届く):

1. Header: state, 「自分だけ」, tags, due (期限切れ in red), 目的; a task done on someone's OK says
   so — 「佐藤さんが阿部さんの了承を得たとして完了にしました（電話で）」 (`okWords`: an OK is never
   called an approval), in the header and in 経緯.
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
   reply draft) that stage 3's connectors fill; empty and hidden today.
6. Fields, 経緯, and 「つながっているもの」 with the record card's rows (`RecordRows.tsx`, registered
   import): decisions marked 例外（この件だけ） and owner-only records marked 自分だけ
   (`RecordMarks`, also on the generic card and every record row).

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
shows); `tasks-list.test.ts` also: only a company path reaches the server.
