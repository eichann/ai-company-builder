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
  - "client/src/features/records/**"
  - "client/src/shared/ui/RecordPage.tsx"
  - "client/src/shared/ui/LinkedColumn.tsx"
  - "client/src/shared/lib/linkGroups*"
  - "client/tests/tasks-*.test.ts"
  - "client/tests/tasks-*-ui.*"
  - "client/tests/ui/tasks-*.spec.ts"
  - "client/shared/today-folder.ts"
  - "client/tests/today-folder.test.ts"
  - "client/src/shared/lib/todayFolderSetting.ts"
  - "client/src/shared/lib/googlePermission.ts"
  - "client/src/features/workspace/hooks/useTodayFolder.ts"
  - "client/src/features/settings/components/TodayFolderSetting.tsx"
  - "client/shared/consultation-task.ts"
  - "client/tests/consultation-task.test.ts"
  - "client/src/features/chat/components/TopicChip.tsx"
  - "client/shared/link-drop.ts"
  - "client/src/shared/hooks/useLinkDrop.ts"
  - "client/src/shared/ipc/link-drop.ts"
  - "client/src/shared/ui/LinkDropNotice.tsx"
  - "client/tests/link-drop.test.ts"
  - "client/tests/ui/fixtures/link-drop.ts"
  - "shared/core/turn-timing.ts"
  - "client/src/shared/hooks/useDismiss.ts"
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
- `tasks:create(companyId, { title, due?, tags?, assignee?, whenDone?, folder?, bundleId?, meetingId? })`: the
  list's one line makes a task **only the member sees** (`personal: true`, assignee = the member;
  `records.md` "Owner-only records"). With another member as `assignee` it is **「頼む」** (task v9):
  never owner-only (they could not read it), shown to the readers of `folder` (the department on
  screen; 全社 = none, the whole company), `when_done` (`notify` = 知らせるだけ by default, `check` =
  確かめてから with the member as `reviewer`). `bundleId` links what it belongs to; 「頼む」 with one sends
  no folder (the server gives it the 案件's 見える範囲, `records.md` "A task and its 案件・プロジェクト").
  `meetingId` (the meeting card's 「やることを足す」, "Similar items" below) links `meeting` and is never
  owner-only and sends no folder (the meeting's people see it). The answer carries the new record's
  `state` and the server's `similar`, checked by `similarOf` (a record id and a title, else dropped);
  `tasks:share` / `tasks:shareToBundle` carry `similar` the same way. Main
  sends only a member id, a `fileLinkPath`-checked folder and record ids.
- `tasks:bundleKinds(companyId)` → `BundleKindsAnswer`: `GET /records/bundle-kinds` as the server
  answered it (`records.md` "Bundle kinds": what each department makes and the names — a plugin's
  案件・番組, the core's 「プロジェクト」 or the company's name). Renderer port `BundleKindReads`
  (`getBundleKinds`, `src/features/tasks/api.ts`); an older server → a failure to fall back from.
- `tasks:act(companyId, recordId, { action, expectedVersion, note?, args?, links?, ok? })`: one
  engine action with the session; the engine decides who may (`who`, `ok_from`). An action name
  that is not `[a-z][a-z0-9_]*` or a malformed record id never reaches the server's URL.
- Refusals: the engine's own words for members (`VERSION_CONFLICT` 「ほかの人が先に変えました…」);
  ≥ 500 / unreachable → `TASKS_OFFLINE_TEXT`. Logged: the route and status, never a title.

## Renderer (`client/src/features/tasks/`)

- The left tab 「やること」 (registered in `AppShell.tsx`, between ファイル and 検索; **no count** — the
  count of あなたの番 is the title bar's alone (owner 2026-11-02) — but a dot while something of あなたの番
  or 引き受け待ち came that the member has not seen in the tab: `useSeenTasks`, per company in
  localStorage `tasks-seen:<company id>`, marked when the tab is opened or left; formerly badge = あなたの番
  + 引き受け待ち). Shown when records are on and the company setting `taskListDepartmentIds` names
  the department on screen (`null` = every department; 全社 = any department shows it:
  `listShownFor`). The list itself is the member's, across the company (records carry no
  department the app could filter by).
- `TaskListPanel`: the list, in the narrow column where the file tree sits. A row opens its item
  in a tab in the middle, next to the open files (`onOpen`; `files-and-editor.md` "Files and
  records share the middle's tabs"), and switching the left tab keeps it; the row of the active
  tab is marked (`activeRecordId`). A まとまり chip opens that まとまり the same way. AppShell keys
  the card **by record id only** and passes the version the list knows (`knownVersion`): a newer one
  makes the card read again (`useTaskCard`; a change made from the list shows on the card), and a
  re-read never blanks the card or closes its folds — the shown card stays until the new one comes, and
  an answer older than the version shown never replaces it (`nextCard`: two reads can race)
  (owner 2026-11-03, 使い心地のメモ #3: keying by version remounted the card on every change the
  consultation's AI made, and the whole screen flickered). The list keeps its last answer while it
  reads again too (`useTaskList`). Test: `tests/ui/tasks-layout.spec.ts` (「the AI changing the task
  updates its open card in place」: same node, 経緯 still open, no 「読み込んでいます」).
  A card mounted again (its tab switched back to) starts from the card it showed last and reads
  again (owner FB #14; `useShown`, `records.md` "What was shown comes back at once"); the list never
  remounts (it lives in AppShell, the left panels stay mounted), so it needs no cache.
- `useTaskList` (in AppShell): read at mount, on `notifications:changed` and `records:changed` for
  the company (`onTasksMayHaveChanged`, `src/features/tasks/api.ts`), every 2 minutes and after the
  member's own change. `records:changed` (no content) is sent by main **at once when the member's
  own consultation AI wrote a record** in this app (a record tool's write the server accepted:
  `RecordToolsOptions.onRecordChanged` → `server-config.ts` `recordsChanged` → main, which also
  asks the title bar's 「あなたの番」 again) and on every `records` push signal (others' changes that
  reach this member — every change to a record the member reads, named on it or not,
  `notifications.md` "The push signal"; 「かもしれない運転」). Tests: `client/tests/records-tools.test.ts` (a write tells,
  a look-up or refusal does not), `src/features/tasks/api.test.ts`.
- **A task only the member sees shows whatever department is on screen**: the list is read per
  company (no folder in any of its requests) and owner-only tasks come in 「あなたの番」 like any
  other; a department tab never narrows it (`tests/tasks-list.test.ts`). Where the company hides
  the tab for that department (`taskListDepartmentIds`), the title bar's 「あなたの番」 still
  counts it. `useCalendarToday`:
  at mount, every 10 minutes, and **at once when the app sees the member's Google permission
  change** (owner FB 2026-11-04: 「Google の設定を全部終えたのに、今日の予定が出ない」 — the list said
  「許可をすると…」 for up to 10 minutes). Settings' Google reads (`features/settings/api.ts`
  `getGoogleStatus`, `disconnectGoogle`: 設定 →「Google」 and 「仕事の道具をつなぐ」) tell
  `src/shared/lib/googlePermission.ts`, which signals only when connected / status / features /
  featuresOff differ from the last read for that company (the first read is silent). Test:
  `tests/ui/connect-tools.spec.ts` 「today's calendar is read again as soon as Google is allowed…」.
- `model.ts` (pure, `model.test.ts`): "today" is the company's day (`companyNow`, Japan time until a
  setting exists). **By turn**: 引き受け待ち, あなたの番 (today's meetings still to come mixed in),
  AI の番, ほかの人の番・返事待ち, 先のこと (a task resting in the member's turn due after this week —
  folded until opened), **いつか** (a resting task with no due — folded), 今日終わったこと (today's meetings that are over too; 「あしたの朝に空になります」).
  **By date**: 期限切れ, 今日 (meetings to come), 明日, 今週, あとで (folded), 期限なし, 今日終わったこと.
  **By bundle** (「〇〇ごと」): each bundle with open items (its name opens it), then 「〇〇なし」, then
  今日終わったこと; 〇〇 is the kinds actually in the list (`bundleListWord`: 「案件」, 「案件・プロジェクト」),
  since the list crosses departments; with none linked, the department on screen's kind (営業部 →
  案件ごと; 全社 → the company's own kind). The names come
  from `GET /records/bundle-kinds` (read with the list: `TaskListData.bundleKinds`, and
  `bundleKindNames` for each row's chip — the core's kind under the company's name); an older
  server → the types' own labels. The one line's ［〇〇］ is the department on screen's kind and
  offers only bundles of that type (全社: every kind). An AI proposal put away (`dismissed`) and an
  archived task (`cancelled`, "The archive" below) are never in 今日終わったこと.
  In every view the folded **「アーカイブ」** closes the list ("The archive").
- **This week's turn** (owner decision 2026-11-03, 使い心地のメモ #2: 「足しただけであなたの番になるのか？」):
  one rule, `turnTiming` in `shared/core/turn-timing.ts`, for the list, the title bar's count and the
  server's morning summary. A record of 「あなたの番」 is **resting** (`restingTask`; the list item's
  `resting`) when it is a task in 未着手 (`todo`) with nothing to press — not given back by the clock
  (`waitCameBack`), not a minutes check (`task_kind`), nothing the AI prepared (`prep_summary`);
  whoever asked it. A resting task with no due → 「いつか」, due after this week (`weekEndOf`) →
  「先のこと」; neither is counted. Everything else is this week's turn and counted: due this week or
  overdue, started (進めている, 返事待ち…), and whatever waits for a press (引き受け待ち, 確かめる,
  承認・返事のお願い, 議事録の確認, 受けられないと返された). Tests: `model.test.ts` (いつか, a started
  far-future task stays), `tasks-list.test.ts` (the list's あなたの番 is exactly the title bar's items),
  `notifications.test.ts` (client and server).
  "This week" ends on Sunday; on a Saturday or Sunday it runs to next Sunday, so tomorrow never
  folds. A due with a time today that has passed is 期限切れ. Meetings are read, never made into
  tasks (`calendar.md`); a tag filter hides them.
- **Icons in the left column** (owner 2026-11-02): a square box only means ☐ = pressable (`check`),
  green ✓ = done (press: やり直す), and the amber eye box = being checked. A task the member asked of
  someone else, not finished (`askedOfOthers`, `classifyTasks`: requested_by = them, assignee
  another) shows the grey 「人に頼んだもの」 mark (User + ArrowBendUpRight) — the task icon there read
  as 「もう済んだ」. The task kind's icon (`ThingIcon` `task`) is `ListChecks` (the やること tab's
  icon), not a ticked box, everywhere (card chip, ⌘K, search, links). Tests: `tasks-list.test.ts`,
  `tasks-list.spec.ts` (「人に頼んだもの」, not a box).
- Rows (言葉の決まり 3b: what to do next, never a state word): ☑ or the kind's icon (`ThingIcon`), title,
  「あなただけ」, the small chip of the 案件 / プロジェクト it belongs to (opens it), due (期限切れ in red),
  whose turn / what it waits for, 「〇〇さんの代わり」 for a delegate, up to 3 tags; a finished one is
  struck through. A kind finished elsewhere gets its one button (確かめて送る, 確かめる: opens it).
  引き受ける on 引き受け待ち rows. The ☑ is `TaskListItem.check` (`checkOf`, task v9): 完了にする from
  any state but 準備中 (no made-up start), on the member's rows (and a check waiting for them as
  確かめる人), never on what they asked of someone else; asked of them with 確かめてから →
  「終わったので見てもらう」 (`request_review` to the 確かめる人); a finished one they asked or checked →
  やり直す. The list never states someone's OK; that is the card's. **A 来た連絡** (owner FB #20,
  interaction v6, `inbox.md` "Core types"; `checkOf` via `incomingClose`, `record-details.ts`): ☐
  「済んだ」 (`settle`) on a 確認待ち message that is the member's (assignee); main also asks the
  messages they settled today (`POST /records/query { type: interaction, finishedSince, fields:
  { settled_by: me } }`; an older server's refusal = none, the list still shows), which sit in
  今日終わったこと with the green ✓ 「元に戻す」 (`undo` of that entry at the row's version: the server
  refuses when something changed since). What the AI judged is never there. Tests:
  `tasks-list.test.ts` (「a 来た連絡: ☑ …」, 「今日終わったこと asks …」), `tasks-list.spec.ts`
  (「a 来た連絡 to confirm …」).
  **Ended (完了にする, or a 来た連絡's 済んだ) here, its tab in the middle closes** (owner FB #15, 2026-11-04;
  `onCompleted` → AppShell `recordEnded`: `closeTabs([recordTabKey(id)])`, the tidy's path, so 固定
  marks and named groups follow): only that record's tab (a card holds nothing unsaved), only after the
  server accepted it; not for 見てもらう or やり直す, and やり直す / 元に戻す do not reopen it.
  **The card's own end button does the same** (owner FB #29, 2026-11-11; this replaced 「a press on the
  card keeps it open」): a task card's ［完了にする］ — any press whose last step is `complete`, also
  in a dialog or the 返事待ち band (`TaskCard` `onEnded`) — and a 来た連絡's ［済んだ］, a 返事のお願い's
  ［終わりにする］ / ［もう返した］ or a 案件・プロジェクト's ［終える］ / ［やめる］ (any action of its type into a final
  state, `BundleAction.ends`; owner FB #30) (`RecordCard` `onEnded`; not ［取り込まない］, which only moves it
  aside, nor ［もう一度始める］).
  The card's ［取り消す］ goes with it; the list's 元に戻す / やり直す stays. **Every such end also closes
  the record's automatic 「AI の番」 consultations** (`chat.closeRecordConsultations`, `ai-turns.md`
  "Closing the consultation"), never one the member wrote in. Tests: `tests/ui/tasks-layout.spec.ts`
  (「checking a task off…」: the other task's tab in the same named group stays; 「completing a task with
  its card's button…」, 「ending a プロジェクト…」), `tests/ui/record-card.spec.ts` (済んだ / 終わりにする / 終える / やめる tell
  the screen, 取り込まない / もう一度始める do not). An AI-turn
  row shows the automatic runner's state and reason (`AiTurnItemView`, `ai-turns.md`) with
  「もう一度」 / 「人に渡す」 when stopped.
- `QuickAdd` + `quickAdd.ts` (no window, owner 2026-11-02): while the line has the focus, chips show
  under it — ［期限］ (today / tomorrow / a date, a time) ［担当 自分］ (the company's members:
  `TaskListData.members`) ［〇〇］ (the bundles the member reads, `tasks:bundles`) and, once someone
  else is 担当, ［終わったら：知らせるだけ／確かめてから］; 「Enter で足す／頼む」. 「見積を直す 明日15時まで #営業」
  → title, due (今日・明日・あさって・来週[曜日]・曜日・M/D, a time N時[半] / H:MM) and tags, shown in the
  chips; words not understood stay in the title.
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

1. Header: state, tags, due (期限切れ in red), 目的 — **「あなただけ」 is said once, top right** (見られる人,
   `SeenBy`; `ONLY_YOU` when the server gave no viewers), never also as a chip beside the state
   (owner 2026-11-03, 使い心地のメモ #9; `RecordMarks personal={false}` on both cards' heads); a task done on someone's OK says
   so — 「佐藤さんが阿部さんの了承を得たとして完了にしました（電話で）」 (`okWords`: an OK is never
   called an approval), in the header and in 経緯. An owner-only task offers **「部署に出す」**
   (`ShareToDepartment.tsx`): the member picks one of the departments they can write to
   (`shareFolders`, composed by AppShell from the departments and `useWriteAccess`), is told it
   cannot be made 「あなただけ」 again, and `tasks:share` → `POST …/share { folder, expectedVersion }`
   (`records.md` "Owner-only records"; main sends only a `fileLinkPath`-checked company folder; the
   server checks the owner and the folder). A task already shared offers nothing.
2. **AI が用意したもの** (a business plugin step's やること is also shown at the top of its record's —
   the deal's — card, with its files: `StepDeliverables`, `plugin-steps.md` "What the step made";
   one an automatic run made also gets 「続きをする」 above the card, `ContinueStepButton`):
   `prep_summary` and each `prepared` link drawn by the screen with the
   consultation's own cards (`renderPrepared`): a mail draft through `PreparedMailCard` (chat
   feature: reads the draft now, so the latest version is checked and sent — the person sends), an
   approval request through `ApprovalCard`.
3. Runs waiting for a person (`GET /ai-runs`, `needsPerson`): the state in words; an operation
   whose outside result is unknown asks 「届いていた」/「届いていなかった」 (`tasks:reconcile` →
   `…/operations/:key/reconcile`), and only with nothing unknown 「もう一度」 (`tasks:retryRun`).
   Run ids and operation keys that could reshape the URL (`.`/`..`, separators) never reach the
   server.
4. Actions (`TaskActions.tsx`, placed by `src/features/tasks/cardActions.ts`), offered from the
   type (`recordActionChoices`) and the member's place: a `who` person field holding the member (after the action's
   `who_unless`, `actionWho`), or `ok_from` (then the member must say whose OK: a member, or a note
   for an OK from outside ACB — since task version 9 only on a task to be checked first, `records.md`
   "Task version 9").
   Never the AI's own steps (`who: [ai]`: finish_prep, hand_over) nor actions needing a record
   chooser (set_bundle) or their own editors (tags; wait_until: 「返事待ち and its 見込み」 below). **One main button** beside
   the title (新しい画面のデモ C, J; `placeActions`): 自分で進める (AI が用意している) → 引き受ける →
   終わったので見てもらう (確かめてから, the assignee) → 完了にする — but on a task returned to its requester
   (受けられないと返した) the requester's main action is 担当を替える, with 「やり直す（同じ人にもう一度）」 and
   「アーカイブ」 in 「…」; while someone else checks it, a word
   instead (「田中さんが確かめています」), done = 「完了」. Everything else is behind **「…」**, each with
   one line on what it does (`actionHint`). **チームの進め方** (the company's `teamMode`, off by default: `tasks:card` reads `GET /me/work-switches` `teamMode.on`, unreadable = off; `card.teamMode`):
   off, or a task nobody else is in (no requester, or one's own), drops 進めている印をつける,
   見てもらう and 差し戻す — how the card looks, not a permission (the server allows them either way);
   **返事待ちにする is always in 「…」** (owner decision 2026-11-03), never the main button, for whom
   the type's `wait` allows (assignee, AI) in its states;
   引き受ける and 受けられない stay on any task someone asked of the member. **The 「…」 of owner decision
   2026-11-03** (`placeActions`, `cardActions.ts`; labels are the app's, the type's actions and
   version are unchanged): `cancel` reads **「アーカイブ」** in every state, normal colour, line
   「一覧から外します。消しません。［戻す］で元に戻せます」; an archived task's chip is 「アーカイブ済み」
   (`stateWord`, task only — another type's `cancelled` stays 「やめた（しまった）」), its main button
   **［戻す］** (`reopen`; 「やり直す」 stays for a done task) and 経緯 says 「佐藤さんがアーカイブしました
   （理由）」 / 「…アーカイブから戻しました」 (`archiveLine`, `task-card.ts`). 「要らない（AI の案を外す）」
   only on `proposed` (the type also allows `dismiss` from 未着手 / 引き受け待ち; the card hides it there).
   確かめる人を決める and 終わったらを決める are one item **「終わったら」** (its line says how it is now):
   a window with 「知らせるだけ」 / 「〇〇さんに確かめてもらう」 + a person (the member too, 「自分」);
   `whenDoneSteps` sends `set_reviewer` then `set_when_done` (only what changes) in one press.
   With **no assignee** (`card.assigneeId` null) and `assign` allowed, **「自分が担当する」** heads the
   「…」: one press, `assign` to the member with the note 「自分が担当します」 (the type requires a
   note on `assign`; a type change was not worth it — it reads well in 経緯) and ［取り消す］.
   Actions that take the task off the member's turn (受けられない,
   返事待ち, 人に頼む, アーカイブ, 見てもらう) open a window that says **何が起きるか** and **知らせる人**
   first (`leavingWords`); a reason where the type requires one. After a press the card says what
   happened with **［取り消す］** (`tasks:undo` → `POST …/undo { version, expectedVersion }` of that
   one entry; the server allows only its actor and refuses when something changed since). Since task
   version 9 完了 starts from every state but 準備中; a company's own type that still completes only
   what was started runs 着手 first (`startFirst`), each step at the version the previous one moved
   to (no 取り消す for such a two-step press). **延ばす** sits on the
   due (owner 2026-11-03, 使い心地のメモ #7: more choices, no date picker; `postponeChoices`, `model.ts`):
   1時間あと / 今日の夕方 / あしたの朝 / あさって / 今週の金曜 / 来週の月曜 / 来週の金曜 / 2週間後 /
   来月のはじめ — a weekend or holiday (Japan's and the company's, `card.holidays`) moves to the next
   business day, one already past or on the same day (time) as an earlier one is left out. It closes
   on Esc and a press outside (`useDismiss`, `src/shared/hooks/`; so does ［＋ファイル・フォルダをつなぐ］'s
   picker). The server tells the requester. Tests: `model.test.ts`, `task-card.spec.ts` (「延ばす」). **Someone changed it first** (`VERSION_CONFLICT`, plan H): the card reads the latest
   and says 「〇〇さんが先に変えました。最新を読み込みました。もう一度押してください」 with each change
   since the version shown (経緯's lines, `RecordCardHistoryLine.version` / `who`) and that the press
   did not happen. Under the title: where it came from (`origin`: 「会議『…』（11/5）から AI が作りました」
   + ［根拠を見る］, the creating entry's note), 「終わったら：…」 (`whenDoneLine`), the 案件 (`bundle`, not
   repeated on the right), the due and the tags. The server decides every action.
5. `RecordSourcePanel`: the place for a task's source (the original mail / Slack thread and the
   reply draft) that stage 3's connectors fill — asked only for a task that links the 来た連絡 it
   came from (`card.fromIncoming`, an out `interaction` link): a task made by hand shows no もとの連絡
   block and makes no read (owner decision 2026-11-03: no mail / chat parts where there is none). The card takes `renderSource(record)` from the
   screen: `src/app/recordSource.tsx` `renderRecordSource` returns the connector feature's part
   (under its lane marker, `ipc-and-main-process.md` "Lane markers"), so `tasks` imports no other
   feature; nothing given = hidden. Test: `task-card.spec.ts` ("the source slot …": shown only with the 来た連絡 linked).
6. Fields and 経緯 folded at the bottom (`FieldsFold`, `HistoryFold`), and 「つながっているもの」 on
   the right with the record card's rows (`records/components/linkRows.tsx`, registered import):
   decisions marked 例外（この件だけ） and owner-only records marked あなただけ (`RecordMarks`).
   **One word for "only you can see it": 「あなただけ」** (`ONLY_YOU`, `thing-words.ts`) — rows, cards,
   linked rows, the archive, 部署に出す, a private skill; 「自分」 stays where it names the member as a
   person (担当 自分, 「自分が担当する」), never for who can see.

Every record opens in one layout (`src/shared/ui/RecordPage.tsx`: the kind's icon and name, short
chips, the big title with the actions beside it, where it came from, the body, folded fields and
経緯) with 「つながっているもの」 as a table of contents on the right (`src/shared/ui/LinkedColumn.tsx`):
what is linked **directly**, one group per kind by its plain name (`typeLabel` = `thingName`, so
案件 and プロジェクト stay two groups and 「まとまり」「やりとり」 never show), in a fixed order (`groupLinks`,
`src/shared/lib/linkGroups.ts`; a bundle's やること first), three rows per kind and the rest under
「ほか n 件」 (`foldLinks`). Rows show the name, not the state; a finished request (`finished`) is
faint and struck through. A file's own 「つながっているもの」 uses the same column. Its 「AIへの相談」
group lists this PC's consultations whose main topic is the record (`topicRecordId`;
`features/chat/recordConsultationsStore.ts`, read when a screen first asks and on every history
change, given by AppShell) — each opens with `chat.openConsultation` — and offers **one** button
(owner 2026-11-02): with ≥ 1 consultation listed only ［＋新しい相談］ (`chat.consultAbout` with
`fresh`; the rows open the existing ones), with none only ［相談する］ (starts one;
`src/shared/ui/consultationLinks.tsx`). The list row's hover 「相談する」 (latest, else new) is
unchanged. Tests: `record-card.spec.ts`, `task-card.spec.ts`.

A **meeting** and a **来た連絡** get their own parts in the record card (`RecordDetails.tsx`, built by
main with `recordDetailOf`, `client/shared/record-details.ts`; the fields they show are not repeated
under ほかの項目): a meeting's thin line (when, members who attended + 社外 n人, 担当), the summary as
the body, 決めたこと / やること apart (its linked decisions and tasks, not its 「議事録を確認する」:
`minutesReview`), and in 「つながっているもの」 the group 「Google で開く」: 「文字起こしを開く」「Gemini のメモを
開く」 (Google Docs by the ids in `source_ref`) and 「カレンダーの予定を開く」 (the meeting's day: ACB keeps
no calendar id to build the event's own link). **A meeting's order** (owner 2026-11-05, 「ごちゃついてるな」;
`minutes.md` "In the app" has the card): title, when, people (+ 見られる人) → 要約 → 決めたこと・やることの案 →
the actions and the 案件 → 「つながっているもの」, 経緯 (`bottomLast`: also when narrow). A 来た連絡: who and where it came from,
返事が要る, 「要約（本文は Slack にあります）」 — ACB keeps no body — 「Slack で開く」 / 「Gmail で開く」
(only from a well-formed `slack:<channel>:<ts>` / `gmail:<id>` pointer), and the screen's thread slot
(`renderSource`: the thread around it and the reply draft). Beside its title, where a task has 完了
(owner FB #20, `IncomingActions` in `RecordDetails.tsx`, `IncomingDetailView.close` decided in main
for the member): on a 確認待ち message that is theirs the main button **［済んだ］** (`settle`) and in
「…」 **［取り込まない］** (`drop` → やることにしなかった一覧), each at the card's version with
［取り消す］ after; once they closed it 「済んだ」 and **［元に戻す］** (the undo of that entry). An open
返事のお願い of it is not ended by ［済んだ］: a line says to press ［もう返した］ there. The ［返事する］
(AI draft) button is on hold (owner). Test: `record-card.spec.ts` (「a 来た連絡 to confirm …」). Links out go through `shell:openExternal`.
**A 返事のお願い's card** (owner report 2026-11-05: one sat in 「AI が確かめている」 after the member's reply,
with nothing to press; `ReplyRequestActions`, `ReplyRequestDetailView` from `recordDetailOf` with the
server's type): for its assignee the main button **［終わりにする］** (`close`, state 「終わった」) in every
state the server's type allows it from — reply_request v5: every open state, the AI's 準備中 / 確かめ中
included; an older server's type (返事をする / 返事待ち only) shows it only there — and in 「…」
**［もう返した］** (`replied_elsewhere`), each at the card's version (refused → the card reads again);
［取り消す］ after 終わりにする (not after もう返した, whose drafts were put away). Tasks-list rows have no menu
for it. Test: `record-card.spec.ts` (「a 返事のお願い in the AI's turn …」, `?record=reply`, `&type=v4`).
A **案件・プロジェクト** (any type implementing `bundle`, `bundleDetailOf`): なんのため (`purpose`), 責任者
(`owner`, else `assignee`), 進み具合 (its やること done of all), its approval requests still waiting as
the approval card (`renderApproval`, AppShell's `ApprovalCard`), and **みんなのやること** by whose turn —
あなたの番 (the member's id from `/api/me`), AI の番, ほかの人の番・返事待ち, 終わったこと — each row saying
whose turn and the due and opening the task; the right column starts with its やること, each with
whose turn. **Its buttons** (owner FB #30, 2026-11-11: a プロジェクト could not be ended in the app;
`BundleDetailView.actions` from `bundleActionsOf`, `client/shared/record-details.ts`, built by main with the
server's type; `BundleActions.tsx`): the core プロジェクト shows **［終える］** beside the title (one press) and in
「…」 **［やめる］** (a window with an optional reason; 「一覧から外れ、このタブは閉じます。消しません（経緯は残ります）」),
責任者を替える (the members, 自分 first), 期限を変える, なんのためを書く (each prefilled); a done or cancelled one only
**［もう一度始める］**. Generic over the type: any type implementing `bundle` (a business plugin's 案件 too) gets its
own actions the same way — the main button is the first action into a final state (on a finished one, the first
back out of it), the rest in 「…」; never the AI's own steps (`who: [ai]`), actions setting record links, or
arguments other than person / date / text. **Offered only as the task card decides** (`personInWho`,
`client/shared/record-actions.ts`, shared with `task-card.ts`): a person field of the record holding the member
(the 責任者 `owner`), `anyone`, or a `link:` the server answered — never a role: an admin or a 部署の管理役 who is
not the 責任者 sees no button although the server would allow them (the app knows no roles; never offering
what the server refuses). Each press at the card's version, the type's words after it with ［取り消す］
(`bundleDoneWords`); a refusal is said where it was pressed and the card reads again. 見るだけ (feature off):
none. Tests: `client/tests/record-details.test.ts` (the 責任者 only, ［終える］ / 「…」, a finished one, a plugin
type's own actions and what is left out), `tests/ui/record-card.spec.ts` (`?record=project`, `&owner=other`),
`tests/ui/tasks-layout.spec.ts` (the tab closes) — mutation-checked. **The AI on a record** (plan I.4, every record card; `aiOnRecord`): a run of it held or
open → 「AI が反映しています…（あと少し）」; otherwise, when the newest change in 経緯 is the AI's,
「AI が反映しました（11/2 09:56）」 — one line in fixed words, never the AI's step names; what it did is in
経緯, opened by the band's ［経緯で見る］. On a meeting only the working line shows: its state chip
(「AI が読み終えた」) already says it. **見られる人** at the top right of a record's card
(`SeenBy`, the lock only for 「あなただけ」): main asks `POST …/viewers { records: [id] }` with the card
and passes only what the server answered for that record (`viewers`); a record left out shows
nothing (`client/tests/record-card-viewers.test.ts`).
Tests: `client/tests/record-details.test.ts`, `tests/ui/record-card.spec.ts`.

## The minutes review card (「議事録を確認する」, `MinutesReview.tsx`; owner decision 2026-11-06 「出どころの枠」 §10)

The AI's proposals of a meeting, on the review task's card and the meeting's card (`minutes.md` "In
the app"), from `tasks:proposals` (`minutes.md` "The AI's proposals"):

- Under the list's title: **「〇〇さんの AI が読みました・案 N 件」** (`proposalsHeadline`: the meeting's
  assignee — who had it read — and the proposals still open).
- Each proposal: title, 担当・期限, then a quiet line with **its basis quote** 「…」 (`basis`) and, when
  another attendee's consultation added it (`addedBy` ≠ the reader), **「〇〇さんの AI が追加」**.
- **「似ている案があります：「…」」** (an amber note on the newer one, `similarTo`, while nobody said
  別のもの): ［同じ］ = `dismiss` of this one with the note 「「…」と同じ案のため」 (the older kept),
  ［別のもの］ = `keep_apart` (both kept, the note goes).
- **Buttons only where the server would allow them** (`may`, `proposalMay` in `client/shared/tasks.ts`
  over the type's `who` with `actionWho`): on task version 13 every reader of the meeting gets 足す・
  要らない・戻す・同じ・別のもの (the list came through the meeting); an older server's type shows them to
  the proposal's requester only (roles are not known to the app) and never 別のもの. ［全部足す］
  ［選んで足す］［要らない］ act on the proposals the member may press. The server decides each press.
- **The decisions** (decision version 6, `records.md` "A person confirms it"): **「決めたことの案」**
  (unconfirmed) apart from **「決めたこと」** (confirmed, chip 決まった). Each 案 has ［そうです］ (`confirm`)
  and ［違う］ (`reject`, no note) only where the server's `decisionChecks` says the member may
  (`reviewOf` → `MinutesReviewDecision.may`; an older server sends none: the decision's `owner` may
  confirm, as before), else the chip 「責任者の確認待ち」; ［まとめてそうです］ with two or more. A 責任者 who
  cannot read the meeting: 「〇〇さんはこの会議を見られません。…」 (`cannotReadLine`, names from the members
  list — main asks it only then, `meetings.ts` `namesOf`). The record card and the meeting's plain lists
  name an unconfirmed one 「決めたことの案」 too (`thingName`, `MeetingOutputs`).
- Tests: `client/tests/tasks-list.test.ts` (「a meeting's proposals: the buttons follow the type's who…」),
  `tests/ui/task-card.spec.ts` (「議事録を確認する」: the headline, the basis, 「〇〇さんの AI が追加」, ［同じ］
  with its note, ［別のもの］; 決めたことの案 apart, ［そうです］［違う］ only where allowed, 「…見られません」;
  `?proposals=none`: no button), `client/tests/task-card.test.ts` (`reviewOf`).

## Similar items (「似ているやることがあります」, 出どころの枠 §10 step 4, owner decision 2026-11-06)

A person's create and share are free; when the server names a live item of the same meeting with a
close title (`similar`, `minutes.md` "Outputs made once"), one quiet amber line — never a dialog —
says 「似ているやることがあります：「…」」 with ［まとめる］［このまま］ (`SimilarHint.tsx`):

- **Where**: the meeting card's 「やることの案」 list gains 「＋ やることを足す」 (`MeetingTaskAdd.tsx`, given by
  `src/app/meetingCard.tsx` through `MinutesReview`'s `onCreate` / `onUndo`; the review task's card has
  none): one line, Enter makes the member's task of that meeting (`tasks:create` with `meetingId`).
  And the task card after 「部署に出す」 / ［〇〇の人に見せる］ (`TaskCard`'s notice). The list's one line
  (`QuickAdd`) makes 「あなただけ」 tasks with no meeting: never compared, so no hint there.
- **［まとめる］**: the **new** item is put away — `mergeActionFor(state)` (`client/shared/tasks.ts`):
  `dismiss` (要らない) from 案・未着手・引き受け待ち, `cancel` (アーカイブ) from the other open states, none
  once finished (then only ［このまま］) — with the note 「「<既存の件名>」とまとめたため」 (`slotMergedNote`),
  then the earlier item opens (`record.open`). Reversible: the card's ［取り消す］, the add line's
  ［元に戻す］ (`tasks:undo` of that one entry). The earlier item is never changed.
- **［このまま］** (or nothing): both stay; nothing is stored, so the hint is not asked again for that
  press. The `keep_apart` / `similar_to` marks are not used: they are the AI's proposals' (`proposed`
  only; a create naming `similar_to` is refused).
- Tests: `client/tests/tasks-list.test.ts` (「やることを足す」 sends the meeting link, never owner-only;
  `similar` passed only as an id and a title; ［まとめる］'s action allowed from every open state of the
  core task, none when finished), `tests/ui/meetings.spec.ts` (「やることを足す」: no line when nothing is
  close, the line without a dialog, ［このまま］, ［まとめる］ with its note and the earlier one opened,
  ［元に戻す］), `tests/ui/task-card.spec.ts` (「部署に出す」 then ［まとめる］ with ［取り消す］).

## The archive (アーカイブ, owner decision 2026-11-03)

- The bottom of the list, in every view: a folded section 「アーカイブ」 (`ArchiveSection.tsx`). Nothing
  is read while folded; opening it reads the first page (each opening starts again), 20 archived
  tasks newest first (`ARCHIVE_PAGE`), and 「さらに読み込む」 reads 20 more until none are left. A row
  (archive icon, title, 「11/3 アーカイブ」, 「あなただけ」) opens its card, where ［戻す］ brings it back.
- **Only the last 30 days** (`ARCHIVE_SHOWN_DAYS`, owner 2026-11-03, 使い心地のメモ #1: 「残り続けるのが
  嫌」): a task archived longer ago is left out of the fold — never deleted; it stays findable in 探す
  and its 経緯. The end of the section says so: 「30日より前のものは、探すタブから見つかります」.
- `tasks:archived(companyId, cursor)` (main): two `POST /records/query` — `{ type: 'task', state:
  ['cancelled'], fields: { assignee | requested_by: me }, finishedSince: now − 30 days, limit: 20,
  offset }` (`finishedSince`: entered 「アーカイブ」 since then, `records.md` "Reading") — merged by
  `archivePage` (`client/shared/tasks.ts`): the server's order (most recently changed first, then
  the id; `records.md` "Reading"), a task in both (one's own) once, never past a window whose query
  has more; the cursor `{ assignee, requester }` is each query's offset (`isArchiveCursor`: integers
  0–10000, else nothing is sent); `next: null` when both are read. The server answers only what the
  member reads (someone's own task to its owner alone).
- Tests: `client/tests/tasks-archive.test.ts` (pages of 20 in order, each once, the end; only
  archived tasks of the member are asked; only the last 30 days; a bad cursor; not in 今日終わったこと),
  `server/tests/unit/record-query-order.test.ts` (an action's time orders the query; offsets page;
  someone's own archived task in nobody else's answer), `src/features/tasks/cardActions.test.ts`
  (labels, ［戻す］, 経緯, 要らない only on a proposal, 「終わったら」 as one item, 「自分が担当する」),
  `tests/ui/task-card.spec.ts` (`?task=unassigned|archived`), `tests/ui/tasks-list.spec.ts`
  (「アーカイブ」: folded, 20 / 40 / 45, a row opens). `SCREENSHOTS=<dir>` writes the menu, the
  「終わったら」 window, the archived card and the section.

## 返事待ち and its 見込み (task version 12, owner decision 2026-11-03 「②」; server `records.md` "Task version 12")

- **Making it wait** (the card's 返事待ちにする in 「…」 — always, チームの進め方 or not, one's own task
  too: owner decision 2026-11-03 — and 「もう少し待つ」): `WaitDialog` (`components/WaitParts.tsx`): 何が起きるか / 知らせる人,
  「何を待っていますか」 (`waiting_on`, prefilled) and 「いつごろ来そうか」 (`WaitChooser`): ［明日］ (the next
  business day; 「次の営業日」 when that is not tomorrow) ［3日後］ (3 business days) ［来週］ (same weekday,
  or the next business day) ［日を選ぶ］ — each chip with its date (`waitChoices`, `client/shared/tasks.ts`,
  from the company's today and holidays: `tasks:card` reads `GET /task-settings` → `card.holidays`).
  One `wait` with both args; **nothing chosen sends no date** and the server sets 3 business days
  (「選ばなければ 3営業日後（11/6）にします」, `defaultWaitUntil`).
- **While waiting** (`card.wait`, `WaitBand`): 「返事待ち：先方からの返事（11/6 ごろまで）」 (`waitingLine`) and
  ［見込みを変える］ (`set_wait_until`, a date must be chosen; `card.wait.canChange`: who the type allows).
  The list's row says the same (`waitingWords`).
- **Given back by the clock** (`card.wait.cameBack`, from the 経緯 with core `waitCameBack`; the list from
  the server's `waitCameBack` on 「あなたの番」): row and card read 「先方からの返事が来ていません（3日）」
  (`cameBackLine`: `waiting_on` + business days since the wait began, up to today; 「返事が来ていません」
  without it), the card adds 「返事の見込み（11/6）を過ぎたので、あなたの番に戻りました。」 and ［催促の下書きを作る］
  (`onNudge` → `chat.consultAbout` with `purpose: 'nudge'`: always a new consultation 「<title> の催促」 whose
  first message (`taskConsultFirstMessage(…, 'nudge')`) has the AI read the task and draft a short nudge —
  a reply draft when the original mail is linked — that the member checks and sends; the AI never sends)
  ［もう少し待つ］ (the same window, a new 見込み) ［完了にする］. 経緯 shows the clock's note as one line
  (「ACB の時計：返事の見込み（11/6）を過ぎました」, `historyLines`).
- Tests: `client/tests/tasks-list.test.ts` (the row words, business days, the chips' dates),
  `task-card.test.ts` (`card.wait`), `src/features/tasks/cardActions.test.ts` (返事待ちにする in 「…」
  without チームの進め方, never main, not for the requester), `tests/ui/task-card.spec.ts`
  (`?task=todo-own`: in 「…」 with team mode off; `SCREENSHOTS` writes the menu; `?task=todo-team|waiting|back`: chips
  set the date, nothing chosen sends none, ［見込みを変える］, the came-back band and its three buttons;
  `SCREENSHOTS=<dir>` writes the chooser and the came-back card), `task-consult.test.ts` (the nudge
  message never lets the AI send).

## Without mail or chat (owner decision 2026-11-03)

The list and the card are complete without Gmail / Slack; following mail and chat up (来た連絡,
返事のお願い, 返事を待つ) is a bonus when the company has them, never something to log by hand.
- **Company level** — `GET /me/work-switches` `channels` (`tasks.md`; a usable connector for the
  `mail` / `chat` role): neither → 設定 → 自分の設定 shows no 受信を読む switch, only
  「Gmail・Slack をつなぐと、返事の追いかけを AI がします」 (the one entry; the Google / Slack sections
  stay). The task screens carry no mail / chat parts of their own to hide: the card's もとの連絡 shows
  only on a task linking a 来た連絡 (above), 「返事を待つ」 only on a mail draft being sent
  (`outbound-mail.md`), and 探す's kind chips only for kinds found (`search/find.ts`).
- **Records are never hidden**: a 返事のお願い or a 来た連絡 to confirm in someone's turn stays in the
  list (and the title bar) after a disconnect until it is finished — the list never asks about
  connections (`tasks-list.test.ts` "a 返事のお願い or a 来た連絡 to confirm …").
- **Member level** (company connected, this member not, or 受信を読む off): nothing is hidden —
  自分の設定 is where they turn it on / 「Google で許可する」, and what others asked of them stays.

## Consulting about a task (S12, owner decision 2026-11-01: 「一覧から相談する」)

- 「相談する」 on the card (its 「AIへの相談」 group on the right: 「相談する」 while none exists, else only 「＋新しい相談」 = `fresh`, and the consultations about it listed there; the card also shows 見られる人 top right — `tasks:card` asks `POST …/viewers` for that task and passes only its answer) and on a list row (on hover) run `chat.consultAbout`
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

## Consultations centre on the task (owner decision 2026-11-03)

- **The task the AI makes becomes the topic** of a consultation that has none: `records_create`
  answers a task → `RecordToolsOptions.onRecordCreated` → main (`server-config.ts`) patches the
  history (`topicAfterTaskMade`, `client/shared/consultation-task.ts`) and tells the chat
  (`chatHistory:changed` `patch`). The card's 「AIへの相談」 lists it, the conversation list shows
  its やること, and the chat shows **the topic chip** under the header (`TopicChip.tsx`:
  「このやることについての相談：<title>」 — the topic's own kind word for a 案件, 会議… dropped on the
  input, `chat-ui-and-history.md` "A record dropped on the input" —, opens the card; it replaces the task instruction chip for
  the same task). A record the member cannot read shows no chip.
- **Taking it off**: the chip's × or the card's consultation row 「…」→「このやることから外す」
  (`consultationLinks(…, onDetach)`, composed by AppShell) → `patchChatSession { topicRecordId: null }`
  → `topicDetached`: no topic is set by itself again, no more automatic links (`chat-ui-and-history.md`
  "History store"). The consultation and the links already made stay.
- **New files are linked** (`chat-server.ts`, a consultation whose topic is a `task-` record; not an
  unattended step): each file the AI **newly creates** in the company folder in a turn
  (`toolEventContext.onFileCreated`, `chat-and-agents.md` "AI action log") is linked with
  `RecordTools.linkNewFile` (the turn's act token, as the AI; `records.md` "Linking files later":
  a private folder's file for a task outside it is refused, `.personal/` files link and read as
  「あなたの Mac だけにあるファイル」). The topic is read at each file, so a task the AI made earlier in
  the turn counts. Never linked: edits of a file that exists, files outside the company folder,
  `.workspace/` / `.backups/` / `.git`, temporary save files, what a script / `cp` / a shell variable
  writes, files the member makes by hand. A failure says nothing and never stops the chat; a link
  shows one line in the reply, 「『見積メモ.md』をやること「…」につなぎました」 (`data-file-linked`,
  stored as the message's `linkedFiles`). Codex (read token) links nothing.
- **What the AI is told** (`taskTopicInstructions`, read at the turn's start with `RecordTools.readTask`):
  new files are linked by the app, to create them with the Write tool; for a task only the member
  sees, new files go to the member's 今日のフォルダ unless told where (the chat request's
  `todayFolder`, from AppShell's `useTodayFolder`; main accepts only an app-built path,
  `isTodayFolderPath`).
- Tests: `client/tests/consultation-task.test.ts` (topic only without one and never after taking it
  off, kept through saves; only created files, after an ok finish; the link as the AI at the version,
  retried once, never thrown, none with a read token; the instructions), `tests/ui/chat-panel.spec.ts`
  (「the topic chip」: the line, ×; `SCREENSHOTS=<dir>`), `tests/ui/task-card.spec.ts`
  (「このやることから外す」). Real-agent check: Claude through the app's connection and record tools
  against local staging (the PR says what ran).

## Tags on the card (owner 2026-11-02: あとから足す・外す; 2026-11-03 redesign, 使い心地のメモ #6)

- The card's 「タグ」 field (`TagField.tsx`, pure rules `tagEditor.ts` + `tagEditor.test.ts`), in the
  same look as the due beside it: the tags as **pills** in the field, × on each (for who may set
  tags: `canSetTags` — the type's `set_tags` allows the member: requester, assignee; not a finished
  task; otherwise read only). Pressing the field or its ＋ pill opens a **popover combobox** anchored
  to it (like Linear / Notion): a search box on top (「タグを探す・作る」), then the task's tags (✓) and
  the tags in use, most used first, filtered loosely (`tagOptions`: `tagKey`, the exact spelling
  first); ↑↓ Enter picks — a ✓ one is taken off — and 「『〇〇』を作る」 is the last row only when no
  row is that word (`newTagOffer`). A word spelled like a tag in use is added as that tag
  (`tagToAdd`). Esc or a press outside closes it (`useDismiss`; Esc during IME conversion only ends the
  conversion); Backspace in an empty box takes the last tag off. Checked like the server
  (`normalizeTag`, 40 characters, 20 tags) before sending; the server's refusal shows inside the
  popover in its words. Each change is one `set_tags` with the whole list.
- When the typed word is the whole name of a 案件・プロジェクト the member reads (`tasks:bundles`, of
  the department's kind; not the one linked), a quiet line inside the popover says 「『〇〇』は案件の名前です。」
  with ［案件につなぐ］ — the same `bundle` link as ［〇〇につなぐ］ (offered only while `canSetBundle`);
  adding it as a tag stays possible.
- **Tag changes are not in 経緯** (they organise, they are not work): `labelOnlyEntry` /
  `historyEntries` (`client/shared/record-views.ts`) leave out an entry of an action that only sets
  `tags` fields (no state, no link) from the card's and the record card's 経緯 and from 「AI が反映
  しました」. The ledger keeps the entry (undo, audit, replay; `records.md` "Tags"). Test:
  `task-card.test.ts`.
- Tests: `task-card.spec.ts` (「タグ」: × on a pill, the popover's ✓ rows, ↑↓ Enter, 作る, the refusal,
  the AI row, Esc / a press outside, read only when done; the 案件 hint; `SCREENSHOTS=<dir>` writes
  the popover), `tagEditor.test.ts` (rows, the exact spelling first, 作る only when nothing is that word).

## Tag suggestions (owner 2026-11-02: 「haikuとか使って」)

- Where: the one line (`QuickAdd`, `useTagSuggestions`: asked 0.7 s after typing pauses, only the
  newest answer kept, typing never waits) and inside the card's tag popover (`TagField.tsx`: asked
  when the member opens the popover — once per card — while some tag in use is not on the task;
  shown as one quiet row 「✨ 合いそうなタグ：#見積 #A社」; a picked tag runs `set_tags` with the task's
  tags plus it). Tags in use =
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
  picked), `task-card.spec.ts` (asked when the popover opens, `set_tags` with the existing tags).

## 今日のフォルダ (owner decision 2026-11-03, the Obsidian daily-note idea)

- **Where**: `<department>/.personal/inbox/日付別/YYYY/YYYYMMDD/` (`todayFolderPath`,
  `client/shared/today-folder.ts`) — on the member's Mac only (`.personal/` is never synced; push
  checker `[PERSONAL_PATH]`). The date is **the company's day** (`dayWindow`, Japan time until a
  company setting exists), the same "today" as the task list, so a note written at 00:30 lands in
  the day the list calls today.
- **Which department** (`todayFolderDepartment`): the member's choice in 設定 → 自分の設定 「今日のフォルダ」
  (`TodayFolderSetting.tsx`, per company on this PC: localStorage `acb.todayFolder:<company id>`,
  `src/shared/lib/todayFolderSetting.ts`) while that department is downloaded here; otherwise
  おまかせ = the first department the member belongs to (所属, `getMyDepartments`, in the tabs' order)
  that is downloaded, else the first downloaded one (所属 unknown offline). A choice not downloaded
  now is said in the row and おまかせ is used meanwhile. `useTodayFolder` (`features/workspace`)
  composes it for AppShell; the settings row is AppShell's (`SettingsPanel` `todayFolder` slot).
- **「今日のフォルダを開く」**: the file panel header's calendar button and the command
  `files.openToday` (⌘⇧T, `commands.md`), from any department: makes the folder when missing
  (`ensureTodayFolder`, `fs:createDirectory` = `mkdir -p`; main refuses a folder not downloaded),
  switches to that department's files and reveals it in the tree (parents opened, selected,
  dot files shown: `FileTreePanel` `controls.reveal`). None downloaded → a notice.
- Tests: `client/tests/today-folder.test.ts` (path and company day, default department, the
  choice, made only when missing, what main accepts), `tests/ui/skill-layout.spec.ts`
  (「今日のフォルダを開く」 from another department: made once, selected; the settings row;
  `SCREENSHOTS=<dir>`).

## A new file on a task only the member sees (owner decision 2026-11-03)

- **［＋ 新しいファイル］** next to ［ファイルをつなぐ］ on an owner-only task's card (`record.personal`);
  department / company tasks keep only ［ファイルをつなぐ］. The name window is the file tree's
  (`InputDialog`, `fileNameProblem`, main's `wx` create: a taken name keeps it open with
  `NAME_TAKEN_MESSAGE`), offering the task's title (`fileNameFromTitle`, `.md`). The screen's
  `createTodayFile` (AppShell) makes the empty file in today's folder; the card links it
  (`tasks:linkFile` at the version shown) and opens it with `file.open` (the active tab).
- **A linked file inside a `.personal/` folder** (`isPersonalPath`, any depth, one copy in
  `shared/core/records.ts`): **only the member who linked it ever gets the row** — the server leaves
  the link out of every answer to anyone else, file name included (owner decision 2026-11-03;
  `records.md` "Links into .personal/"), so nobody else sees a line about it, even after 部署に出す.
  The server never has the file, so its `broken` is ignored; the row says 「あなたの Mac だけにあるファイル」
  when the file is on this computer (`useTaskCard` checks with `exists`), else — the same member on
  another Mac of theirs — 「ほかの Mac で作ったファイルです（この Mac にはありません）」 and does not
  open (`fileRow`, `PERSONAL_FILE_WORDS`).
- Tests: `tests/ui/task-card.spec.ts` (only on an owner-only task; the name offered; a taken name;
  made, linked at the version, opened; the `.personal` row words; `SCREENSHOTS=<dir>`).

## Linking files (the core's, owner decision 2026-11-01; `records.md` "Linking files later")

Three entrances (`tasks:linkFile` / `tasks:unlinkFile` → `POST …/file-links` /
`…/file-links/remove`, the version the screen shows): the file tree's right-click
「やることにつなぐ…」 (shown only while the task list shows for the department on screen, also on a
folder not downloaded; the chooser `LinkToTaskDialog` lists the member's open tasks from the list), a
file or folder dropped on a task row or a card's 「つながっているもの」 ("Dropping links" below), and the
card's 「＋ファイル・フォルダをつなぐ」 (the company's file names on this computer, `git:listFiles`, and
every folder above them: `linkCandidates`, `model.ts`). **A company without the shared folder**
(`folderKind: none`, owner 2026-11-07/08; server `records.md` "File links without the shared folder"):
company paths are refused, so the card has neither ［＋ファイル・フォルダをつなぐ］ nor ［新しいファイル］
(`TaskCard` `sharedFolder`, from AppShell's `companyHasSharedFolder`; test `tests/ui/skill-layout.spec.ts`
「a task card in a git / none company」), and its 「ファイル」 note is `TYPED_FILES_NOTE` (PC files are the member's
alone). **In every company** (owner decision 2026-11-13) the 「ファイル」 group (`typedFiles`, always given;
`typedFiles.localFiles` = no shared folder) offers **［Google Drive のファイルをつなぐ］** — in a company with the
shared folder beside ［＋ファイル・フォルダをつなぐ］, with the note `COMPANY_AND_DRIVE_FILES_NOTE`, a tree file
dropped there stays a company path and nothing of this PC is offered. The button (`DriveLinkAction.tsx` +
`DriveFiles.tsx`; owner decisions 2026-11-09): pressed, it first offers the member's own Drive files (`tasks:driveChoices` → the connector's
`GET /me/google/drive/files`: their live picks and what their AI put, by name — theirs only) to tick one or
several, those already linked marked 「つないであります」 and not choosable, ［つなぐ］ and ［Google Drive から探す］;
with none listed the Picker opens at once. `tasks:linkDriveFiles(companyId, recordId, version, options?)`,
`TaskDriveLinkOptions`: `{ chosen }` — the ticked files (main checks the ids, ≤ 30), no Picker; `{ fileIds }`
— a Drive link **pasted** into the box under the button or **dragged from the browser** onto
「つながっているもの」 (`mayCarryLink` / `droppedText` in `model.ts`): straight to the Picker showing just that
file (`google-drive.md`; the bare id array of an unreleased build is read as `fileIds`); neither — the
Picker as it opens. Then each is linked at the version the previous link moved to; 「「…」をつなぎました」.
Anything pasted that is not a Drive file link says 「Google Drive のファイルのリンクではないため、つなげません。」;
when the Picker opened on a pasted / dropped link ends with nothing chosen (it may have shown no file:
not visible to the member, or a type ACB cannot read), a quiet line under the box says what to check
(`DRIVE_LINK_EMPTY_HINT`, `model.ts`) until the next action — never after a plain Picker's cancel;
the button (list included) is off with a plain note while Drive is not set up for the company, and says
before the first press that Google will ask (`useDriveLinkSetup`, `driveLinkView`); while the Picker is open
(busy) neither the list nor a pasted link starts another. A file the consultation's AI put into Drive is
linked by the server already (`google-drive.md`). It lists
`card.localFiles` — files of the member's own PC, each with the small 「あなただけ」 (`data-only-you`;
opens on this PC with `file.open`; not here (`exists`) → 「このパソコンに見つかりません（動かしたか、消した
かもしれません）」, said again on a press, nothing opened) — and `card.driveFiles` — the member's own by
its name, anyone else's as 「Google Drive のファイル」 (`DRIVE_FILE_NEUTRAL`), opened in the browser
(`driveFileUrl`). 「…」→「つながりを外す」 is `tasks:unlinkTarget` (main sends only a `fileLinkPath`-checked
path or a Drive id; ［取り消す］ for a PC file). **A file dragged from the tree onto the card or a list
row is linked as the member's own** (`useLinkDrop` `localFiles`, `DroppedThing.local`; 「…をつなぎました
（あなただけに見えます）」), and the drop zone says 「このパソコンのファイル（あなただけ）」. Tests:
`client/tests/typed-file-links.test.ts`, `tests/ui/task-card.spec.ts` (`?kind=none`; `&drive=list`: 「the
member's own Drive files offered first」; 「a company with the
shared folder: the Drive button beside company files; a dropped tree file stays a company file, a dropped Drive
link opens the chooser」; 「…a pasted or dropped Drive link…」;
`&drive=cancel`: 「…explains why it may be empty; a plain cancel does not」) — mutation-checked. Each linked file's
「…」 offers 「つながりを外す」, then 「「<name>」とのつながりを外しました［取り消す］」 (取り消す links it again).

**Links between records** (owner 2026-11-02; server `records.md` "Linking records later"): each row
of 「つながっているもの」 whose link the server did not mark `fixed` (where the task came from — もとの
会議・もとの連絡・AI が用意したもの — or a service's) has 「…」→「つながりを外す」 (`removable`:
`removableOf`, `client/shared/record-views.ts`; the record holding the link is the one changed — an
incoming link is taken off the other record at its version). The task's 案件・プロジェクト sits at its
head (`BundleField.tsx`), not on the right: linked → ［変える］ (a chooser of the unfinished ones the
member reads, `tasks:bundles`; a `one` link is replaced) ［外す］; none → ［〇〇につなぐ］, offered while
the type's `bundle` link is not an origin one and the task is not finished (`canSetBundle`). 〇〇 is
the department's kind's name (`bundleKind` from AppShell, `tasks:bundleKinds`; 「プロジェクト」 until known). While none is linked the
task also offers ［新しい〇〇にする］ (`NewBundleDialog`, the name from its title, no 宿題): `tasks:createBundle` of that kind in
the chosen department's folder, then the task's `bundle` link to it. **Which department** (owner decision 2026-11-06,
`records.md` "A task and its 案件・プロジェクト"): the dialog says 「開発部のプロジェクト」 — by default the member's own
department (所属: the one on screen when it is theirs, else their first in the tabs' order; none or not known → the one on
screen, 全社 offered then) — with ［変える］ among the departments (`bundlePlacesOf` in `model.ts`, composed by AppShell
from the departments, `bundleKinds` and `useTodayFolder`'s `myDepartmentIds`; also on a meeting's / 来た連絡's field).
**見られる人** in the same window (owner decision 2026-11-06, `records.md` "Private 案件・プロジェクト"): 「公開（会社のみんな）」 /
「非公開（参加者だけ）」 — the latter only for who may create a private folder in the chosen department (`mayMakePrivateBundle`:
owner / admin, that department's managers; rights read from `privateFolders:createContext` when the window opens), else
disabled with 「非公開の〇〇は、部署の管理役か管理者に作ってもらってください」. 非公開 first makes the private folder
(`createPrivateBundleFolder`, names from `privateBundleFolderNames`), then the 案件 in it. **A 非公開 案件's card**
(`ProjectParticipants.tsx` in the records feature): 「見られる人：『〇〇』の参加者（N人）」, the participants' names
(「ほかに管理者 N人」), and for whoever the server gave the full list ［参加者を足す］ (any member of the company) and
×「〇〇さんを外す」 after 「…パソコンにあるこの〇〇のフォルダも消えます（同期していない変更も消えます）」.
**A task seen by more people than the 案件** (the server's `WIDER_THAN_BUNDLE` on ［〇〇につなぐ］, ［変える］, the tag
hint's ［案件につなぐ］ or a new one): the card asks 「このやることは、〇〇より多くの人に見えています。〇〇と同じ人たちだけに
見えるようにしますか？」 — ［同じ人たちだけにする］ links again with `narrow` (no ［取り消す］: it is never undone), ［つながない］
leaves it unlinked. **［〇〇の人に見せる］** (`ShowToBundle.tsx`) on an owner-only or members-only task with a 案件: after
「あとから元には戻せません」, `tasks:shareToBundle` → `POST …/share { toBundle: true }`.
`tasks:linkRecord` / `tasks:unlinkRecord` → `POST …/record-links[/remove] { link, target,
expectedVersion }` (main checks the link name and both ids before any request) and answer the ledger
entry's version; each change says what it did with ［取り消す］ (`tasks:undo` of that entry, on the
record that holds the link). Tests: `client/tests/task-card.test.ts`, `tests/ui/task-card.spec.ts` The **record card** does the same
(`recordViews:card` marks `removable` and the record's own `bundle` link, and answers its `version`):
「…」→「つながりを外す」 with ［取り消す］ on every row not `fixed`, and on a meeting or a 来た連絡 the
same 案件・プロジェクト field — at its head on a 来た連絡, with the actions on a meeting — (the screen's `renderBundleField`, `src/app/recordBundleField.tsx`:
a meeting is linked through `minutes:linkBundle` so its 案件's step follows, anything else through
`tasks:linkRecord`; ［外す］ only where the link can be removed). Tests: `client/tests/record-card-links.test.ts`,
`tests/ui/record-card.spec.ts`. **〇〇** is what the department on screen makes (`tasks:bundleKinds`,
the list's `bundleKinds`: its business plugin's kind, else the company's own name; 全社 → the company's).
**「新しい〇〇にする」** (meeting / 来た連絡, while none is linked; `NewBundleDialog.tsx`): the name from the
meeting's or the 連絡's title, the 相手 from its `counterpart` link, 「この会議の宿題（n）も入れる」 (its
unfinished tasks; on at first), and 「似た〇〇があります」 with ［そちらにつなぐ］ — existing ones the
member reads sharing a word of the name (`similarBundles`; the server's own check answers only inside
an approval). 作る → `tasks:createBundle` (`POST /records/item { type: kind.type, title, fields: { owner:
the member }, folder: the department's, links: { counterpart } }`; the server does not fill in the
責任者), then the record is linked (a meeting through `minutes:linkBundle`) and each 宿題 gets the new one
as its `bundle` at its version. Tests: `client/tests/bundle-create.test.ts`,
`src/features/tasks/similarBundles.test.ts`, `tests/ui/record-card.spec.ts` (`?field=real`). Main sends only a path inside the
company folder (`fileLinkPath`: no absolute path, no `..`); the server decides the rest — both
readable by the member, never a private folder's file for a task outside it (one refusal,
`FILE_NOT_LINKABLE`, shown as the server words it). Each link and removal is in 経緯.

## Dropping links (owner decision 2026-11-03: 「ドラッグ＆ドロップで全部つなげる」)

One rule: **something dropped on a record's 「つながっているもの」 (`LinkedColumn`, every card: the task
card, the record card, a 案件's page) or on a task row of the list links it.** Without a drag every
link stays possible (［＋ファイル・フォルダをつなぐ］, ［〇〇につなぐ］, ［相談する］).

- **Drag sources** (`src/shared/lib/dragTypes.ts`): the file tree (files and folders,
  `application/x-file-paths`, `linkMove`; a folder not downloaded drags for linking only, `link`),
  a task row of the list, a 探す row (a record, a file, a consultation), a tab in the middle (its
  record, or its file) — records as `application/x-acb-record` `{ id, title }`, plus the kind's
  word (やること, 案件…: `word`, else from the id's type) in a type of its own
  (`application/x-acb-record-word.<UTF-8 hex>`, `draggedRecordWord`: only types are readable while
  dragging, and the chat's drop frame says it, `chat-ui-and-history.md` "A record dropped on the
  input") — and a row of
  「AIへの相談」 or a consultation under a 探す row as `application/x-acb-consultation`
  `{ sessionId, title, topicRecordId? }`. Record and consultation drags allow `link` only, so they
  never move anything in the tree. Malformed ids are not a drag (`draggedRecord`,
  `draggedConsultation`).
- **What the drop becomes** (`useLinkDrop`, `src/shared/hooks/`): a file or folder (the first
  dragged path inside the company folder) or a record goes to main's **`tasks:dropLink(companyId,
  targetId, dropped, link?)`**, which reads both records and the types now and decides with the pure
  `dropLinkPlan` (`client/shared/link-drop.ts`): a link of the record dropped on whose target is the
  dropped type or an interface it implements, else a link of the dropped record back to it (a やること
  dropped on a 案件 becomes that やること's `bundle`; the link is held, and undone, there). Never an
  `origin` link, never on a `SERVICE_STATE_TYPES` record. Several fit → a tiny chooser
  (「…を、どのつながりにしますか？」 + the links' names, 「まとまり」 never shown: an interface link says
  the kind it reaches); none → one line, 「やることには決めたことはつなげません」 (`typeWord` names
  both). A file needs a non-origin `file` link (「決めたことにはファイルやフォルダはつなげません」). The
  link is made at the version just read; the answer's entry gives 「…をつなぎました［取り消す］」
  (`tasks:undo` of that entry on the record holding it); already linked → 「…はもうつながっています」.
- **A consultation dropped on a record** becomes one about it (its topic, as 「相談する」 and the
  AI's task do: `patchChatSession { topicRecordId }`, through the one wrapper `setConsultationTopic`,
  `src/shared/ipc/link-drop.ts`). **A consultation already about another record asks first** (owner
  decision 2026-11-03, the chat's own rule and words: `topicOnDrop` / `switchTopicQuestion`,
  `client/shared/consultation-topics.ts`): 「『A』の相談を『B』の相談に切り替えますか？」 ［切り替える］
  ［このまま］ at the drop zone (titles via `recordViews:topics`); no topic yet → at once — 「「見積の相談」をこのやることについての相談に
  しました［取り消す］」, 取り消す putting the earlier topic back (none → taken off). Setting a topic
  clears `topicDetached`, so the next save keeps it (`chat-history-store.ts` `patch`).
- **Wording**: the card's zone says what happens — 「ここに落とすと、つながります」 with what may be
  dropped under it; the chat input's drop keeps its own 「ファイルをドロップして参照」 (the AI reads it).
- **Where the drop answers** (owner 2026-11-03, 使い心地のメモ #4): at the place dropped on — on a card
  inside the zone's frame, above 「ここに落とすと、つながります」 (`LinkedDrop.notice`); on the list right
  under the row (`useLinkDrop` `target`). A refusal (「同じものどうしはつなげません。」, 「やることには決めた
  ことはつなげません」) fades after `DROP_REFUSAL_MS` (5 s); 「…をつなぎました［取り消す］」 and a question stay
  until the next drop. Tests: `task-card.spec.ts`, `tasks-list.spec.ts` (refused at the zone / under
  the row, then gone).
- **Folders** (server `records.md` "Links to files": the detail's `folder: true`, links follow a
  member's folder move): a folder row (`fileRow` with `PathFacts`, `linkRows.tsx`; group 「フォルダ」,
  `ThingKind` `folder`) opens the folder in the file tree (command `folder.reveal`, AppShell: its
  department, the ファイル tab, `reveal`). A folder left out on this computer stays linkable and says
  「この Mac には未ダウンロード」 (the screen's `notDownloadedFolderOf`; a link to the left-out folder
  itself is a folder before the server says); a file inside one says the same and does not open.
- **Who cannot open it**: the cards ask `POST /viewers { linked: { record, paths } }` with the file
  links shown and draw `cannotOpen` as 「2人はこのファイルを開けません」 / 「…このフォルダを…」
  (`linkedPathOf`: only a positive count from the server — never who, never a private folder's name).
- Tests: `client/tests/link-drop.test.ts` (per type: related / bundle both ways / refusal text /
  origin never / service types / files; main links at the version read, on the holder, refused drops
  never reach the server; the count), `src/shared/lib/dragTypes.test.ts` (drag data read back,
  malformed ids refused), `consultation-task.test.ts` (a dropped topic survives a save),
  `src/features/tasks/model.test.ts` (`linkCandidates`); UI `tests/ui/task-card.spec.ts` (a record
  dropped with ［取り消す］, the refusal, a consultation and its 取り消す, a folder dropped, folder rows:
  count, not downloaded, opens in the tree — `?folders=1`, `SCREENSHOTS=<dir>`), `record-card.spec.ts`
  (a やること dropped on a 案件), `tasks-list.spec.ts` (a file, a record, a consultation on a row; a row
  drags as its record). Preview pages answer drops with the real `dropLinkPlan`
  (`tests/ui/fixtures/link-drop.ts`).

## Features on and off (「使う機能」, owner decisions 2026-11-07; `records.md` "Features on and off")

`tasks:list` answers `features` (from `GET /records/types`, all on when absent) and
`decisionsToConfirm` (`POST /records/query { type: decision, state: [unconfirmed], fields: { owner: me } }`,
asked only while 決めたこと is on). AppShell reads them with `featuresFrom`:

- **やることの一覧 off**: no やること tab anywhere (`tasksShown` also needs `features.taskList`;
  `taskListDepartmentIds` still narrows when on). Instead the tab **「確かめること」** (`CorePressPanel.tsx`):
  「今日の予定」 (while 会議 is on), the arrived minutes (`MeetingBanners`, ［AI に読ませる］), then
  「確かめること」 — approvals waiting for the member and what the AI prepared for them
  (`corePressItems`, `client/shared/tasks.ts`; `aiPrepared`: a handed-over `prep_summary` or
  「議事録を確認する」), and 決めたこと to confirm. Rows open the card where the press happens. The
  morning summary opens 「確かめること」. The title bar counts the arrived minutes too
  (`arrivedMeetingTurns`, `notifications.md`), whoever may see the meeting, until someone presses
  ［AI に読ませる］.
- **会議と議事録 off**: no 「今日の予定」 (the list's `showCalendar`; `useCalendarToday` reads nothing),
  no 「議事録が届きました」, no 「議事録を確かめる」, no ［自分で読み取る］.
- **決めたこと off**: the meeting lines say only やることの案 (`madeWords`, `MeetingBanners`'s title), the
  manual reading's first message asks for no decision (`startMinutesReading(…, features)`).
- **プロジェクト off**: `departmentBundleKind` gives null for the core's kind (`coreOff`), so nothing
  offers 「新しいプロジェクトにする」; a business plugin's kind is unchanged.
- **A record whose feature is off** (`recordViews:card` `featureOff`): the record card says
  「この機能は今オフです」 with one line on what it means (`FeatureOffBand`) and draws no actions, no
  案件 field and no meeting buttons.

## Minutes and AI turns (S11, owner decision 2026-11-01: 議事録の帯をやめる)

Since 2026-11-04 (meetings for their attendees, design §4-5) one compact block sits above the list
— 「議事録が届きました」 / 「AI が読んでいます…」 / 「読み終わりました」, two one-line rows, the rest behind
「ほか N 件」, at most 45% of the pane so the list always keeps its place and scroll — from the
server's arrivals, with ［AI に読ませる］［読まない］: `minutes.md` "In the app". The rows below are
unchanged.

- No banner: a received meeting is a row of 「AI の番」 (the server's `ai-turn`), showing the automatic
  runner's state in words and its reason (「AI が進めています」「AI では始められません：…」…), with
  「もう一度」 / 「人に渡す」 when stopped and, while the AI has not started it, 「自分で読み取る」 (a
  consultation the person starts, `startMinutesReading`) and 「今は読まない」 (`minutes:skip`) —
  `meetingActions`, from the minutes feature's `useMinutesSlots`, passed on by `AppShell`.
- What the AI made shows where the member works: homework tasks in the list, drafts and approval
  requests in a task's card (「AI が用意したもの」), and the server's notices.
- **No 「まとまり」 on screen** (owner 2026-11-02, concrete kind names only): every word of this
  question names the department on screen's kind (`departmentBundleKind` in `model.ts` — the
  department's kind else the core kind under the company's name, default 「プロジェクト」 — the same
  as ［〇〇につなぐ］), through `meetingBundleWords(word)` (`client/shared/tasks.ts`): 営業部 →
  「どの案件の会議ですか？」「案件を選ぶ」「案件はない（社内の会議など）」「案件を選ぶ会議 3件」. The list,
  `BundleChooser`, the meeting card's field and the title bar's buttons take it from the screen; main's
  `MEETING_NEEDS_BUNDLE_TEXT` (it knows no department) is said again by the list. The chat's card
  (`MinutesBundleChoiceCard`) names its candidates' kinds (`bundleWords`). Below, 〇〇 = that word.
- 「どの〇〇の会議ですか？」 is an item of あなたの番: `tasks:list` reads the server's
  `GET /me/minutes/bundle-questions` (`minutes.md` "The まとまり question": the server decides — the
  assignee's meetings with someone from outside, read within the company's days, no bundle, not
  closed) and each becomes `needsBundle` (「どの〇〇の会議か選んでください」) with its
  `bundleGroup`, offering 「〇〇を選ぶ」 — `BundleChooser` lists the unfinished bundles the member
  reads (`tasks:bundles`, final states of each type left out) and links the chosen one
  (`minutes:linkBundle`; nothing goes outside) — and 「〇〇はない」 (`minutes:noBundle`, also in
  the chooser). Two or more of one group are one row 「〇〇を選ぶ会議 n件」 that opens (`listRows`,
  `model.ts`). Tests: `tasks-list.spec.ts` (案件 in 営業部, no 「まとまり」), `notifications.test.ts`,
  `minutes.spec.ts`.
- **A department without the list** (`tasksShown` false): the same meetings reach the title bar
  instead (`notifications.md` "The app"): `meetingTurns` (`client/shared/notifications-app.ts`)
  picks the `needsBundle` items and the received meetings in 「AI の番」 from the list AppShell already
  reads, with the runner's state (`meetingTurns(…, word)`); the minutes feature's `useMinutesSlots` gives each its buttons (〇〇を選ぶ → `BundleChooser`,
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
assignee completes from 未着手, or on a stated OK when the task is to be checked first; the AI's steps and what the member's
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
the real `AppShell`): the list is the narrow column, a task opens as a tab beside the open files,
stays when the left tab changes, ← → go between them and a restart brings it back.
With `&plugin=1` (a fifth tab, 番組) it also holds the left tabs' rule at 1440×900: every name
shown on one line, under its icon in the narrow column (also at its 200 px minimum), beside it
when スキル covers the left side (`renderer-structure.md`, panel registry).
