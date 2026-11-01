---
paths:
  - "client/shared/tasks.ts"
  - "client/electron/features/tasks/**"
  - "client/src/features/tasks/**"
  - "client/tests/tasks-*.test.ts"
  - "client/tests/tasks-*-ui.*"
  - "client/tests/ui/tasks-*.spec.ts"
---

# The task list in the app (やることの一覧, stage 2 S7b)

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

## Tests

`client/tests/tasks-list.test.ts` (each record once and in its place; only one's own task
finishes from the list; the one line is owner-only and assigned to the member; a bad action name
never reaches the server; records off = no list), `src/features/tasks/model.test.ts`,
`src/features/tasks/quickAdd.test.ts`, `client/tests/ui/tasks-list.spec.ts`
(`tests/tasks-list-ui.html`: sections, meetings mixed in, folding, date view, 引き受ける, finishing,
the one line, the tag filter, a row opening its card).
