---
paths:
  - "shared/types/notifications.ts"
  - "server/src/services/notifications.ts"
  - "server/src/routes/notifications.ts"
  - "server/src/ports/notifications.ts"
  - "server/src/adapters/sqlite/notifications.ts"
  - "server/tests/unit/notifications.test.ts"
  - "server/src/services/server-clock.ts"
  - "server/src/lib/server-clock-schedule.ts"
  - "server/tests/unit/server-clock.test.ts"
  - "client/shared/notifications-app.ts"
  - "client/electron/features/notifications/**"
  - "client/src/features/notifications/**"
  - "client/tests/notifications.test.ts"
  - "client/tests/title-bar-notices-ui.*"
  - "client/tests/ui/title-bar-notices.spec.ts"
  - "shared/core/turn-timing.ts"
---

# Notices (知らせ) and the title bar's 「あなたの番」 (stage 2 S5)

Owner design: 節目5 §11-29 (知らせの欄), §11-28 / §11-32 (タイトルバーの「あなたの番 N」),
E-25 (kinds on / off), E-27 (Mac notifications), A-2 (overdue), C-18 (24 h stuck AI turn).
「あなたの番」 = what waits for the member and stays until it is done (`GET /records/my-turn`,
`records.md`); 知らせ = what happened, gone once read. Both are drawn by the **core app only**;
a plugin can never draw a notice (§2-2).

## Server

- Tables (`db/schema/notifications.ts`, behind the company handle `notifications`, `ports/notifications.ts`):
  `notifications` (company, id, member, kind, record id, record version, ledger action, actor id
  + kind, `dedupe_key`, created, read) and `notification_settings` (company, member, kinds JSON).
  **No text, title, note or value is stored**: the text is built when the member reads.
- Written at the engine's existing notify points: the engine's `notify(companyId, userIds,
  change?)` now carries the ledger entry (`RecordChange`, `services/record-engine/types.ts`: engine
  create / act / undo, the service writer, the external writer). `composition.ts`
  `notifyRecords` sends the `records` signal as before and hands the entry to
  `services/notifications.ts` `recordChange`, which writes one notice per named member — **never
  the entry's actor (except their own AI handing them what someone else asked: `asked` below; the
  engine's `tell` names the member for an AI actor's entry for that), and only a member who can
  read the record now** (an owner-only record's
  notice reaches its owner alone, owners/admins included; `records.md`) — and pushes `{ kind: 'notifications', version }` to those who have that
  kind on. A failure there is logged and never fails the engine's write.
- **Absence** (`records.md` "Absence and the delegate"; `coverOf` / `managersOf` injected): a
  notice to a member who is absent today is also written for their delegate (`for_user_id` =
  the absentee, additive; the text starts 「（Xさんの代わり）」) when the delegate can read the
  record. When the delegate cannot, or is absent too (no chains), and the entry now waits for the
  absentee, the managers of the absentee's departments who can read it get `delegate_stopped`
  (once per record × absentee × reason: 「Xさんの不在中、代わりの人が「…」を見られないため止まって
  います（権限が足りない）」 / 「Xさんも代わりの人も不在のため、「…」を受け持つ人がいません」). The
  server clock's `sweep` runs the same check over today's absences (an absence that began, a
  delegate who became absent), and so does adding an absence that has begun.
- Kinds (`shared/types/notifications.ts`, `noticeKind`; generic over types — final states and the
  `request` fields decide, plus the core `approval` type):
  `approval_result` (an approval's state changed, to its requester), `request_accepted` (what you
  asked left 引き受け待ち for the assignee's work — 「引き受ける」 or a change that accepted it; task v7,
  `records.md` "Acceptance"), `acceptance_waiting` (the server clock, below), `ok_completed` (completed on
  your OK), `request_done` (what you asked reached a final state), `request_returned` (what you
  asked came back to your turn — task v5 「受けられない」 — counted as its result), `due_changed`
  (`due` changed on what you asked), `overdue`, `ai_turn_stuck`, `wait_over` (the server clock, below), `reply_arrived` (the inbox: their reply came to a 返事待ち, to its assignee) and `intake_unsure` (an interaction entered 確認待ち, to its owner; `inbox.md`, both on by default),
  `delegate_stopped` (an absentee's item reaches nobody, to the department manager; above),
  `asked`, `morning_summary`, `due_tomorrow` (below), `others` (everything else: the AI's
  「用意ができた」 / 「先に渡す」 when it is not a first hand-over, 「自分で進める」 of task v5, sent back,
  cancelled…). While a task is the AI's (`preparing`) nobody is told on create (engine rule); the
  assignee hears at the hand-over. **Defaults (E-25)**: all on except `others` (CC and others' affairs). A
  member switches kinds (`PUT /me/notifications/settings`); kept per company × member on the
  server, so both PCs agree. Kinds filter at read time (notices are always stored).
- **Noticing one's own turn without Slack** (owner decision 2026-11-03; all on by default, each
  switchable like the other kinds; no new counter — they are bell notices, the title bar's count
  stays 「あなたの番」's):
  - `asked` 「Aliceさんから「…」を頼まれました」 (`askedOf`): a request type's entry that leaves the
    member its assignee in a person's turn and either made them the assignee (a create, an
    `assign`; by a person or anyone's AI) or handed it over from a turn that told nobody
    (`noTurnStates`: the AI's preparation — also by the member's own AI —, a proposal; text +
    「（AI が用意しました）」). The asker is `requested_by`, else whoever made them the assignee —
    never the member. In 引き受け待ち the text adds 「引き受けるか、受けられないかを決めてください」.
    **Once per assignment**: dedupe key `asked:<record>:<version that made them the assignee>`,
    so a hand-over after a create that already told them, or a retried notify, writes nothing;
    the row's actor is the asker.
  - `morning_summary` 「今日のあなたの番 5件（期限が今日 2件・期限を過ぎた 1件）」: the server clock,
    on a company business day (weekends, Japanese holidays, the company's days off: none) from
    `MORNING_SUMMARY_FROM` 08:30 until `MORNING_SUMMARY_UNTIL` 15:00 company time, one per member
    (`membersOf`) who is not absent today and has something in **this week's** 「あなたの番」
    (`waitingFor` with whom they cover, read with their reader, kept by `turnTiming` `now` —
    `shared/core/turn-timing.ts`, the title bar's items: a task not started with nothing to press and
    no due or a due after this week is not counted, owner decision 2026-11-03), key `morning_summary:<day>`. A
    server down until after 15:00 skips the day (no evening greeting). **No record and no counts
    stored** (`recordId` ''; `RECORDLESS_NOTIFICATION_KINDS`): the counts are built when read —
    today's shows 「あなたの番」 as it is now, an older one only 「11月4日の「今日のあなたの番」（朝の知らせ）」.
    Opening it shows the task list.
  - `due_tomorrow` 「「…」は明日（11月5日）が期限です」: the server clock, from `DUE_TOMORROW_FROM`
    09:00 of **the last business day before the due's day** (`dueTomorrowDays`: today a business
    day, the due's day after today and not after the next business day — a Monday or
    after-holiday due is told on the business day before), to the assignee who can read it, the
    request not final (done / cancelled never), once per due value (`due_tomorrow:<record>:<due>`
    — a moved due is told again on its own eve).
  - Fresh ones carry `desktop: { title, body }` in the list answer — the server's clock decides
    what may still be a Mac notification: the morning summary of today, unread, before 15:00 and
    with something in the turn; 「明日が期限」 unread, before the due's day, the due unchanged, not
    final; `asked` unread within `ASKED_DESKTOP_FRESH_MS` (12 h). The new kinds are not handed to
    `outside` (Slack) from the clock; `asked` rows go there like the engine's other notices.
- Written by the server clock (below, `notifications.sweep`), with the same rule run again when
  the member reads as a safety net (same dedupe keys, so never twice): **overdue** (A-2) — a
  request the member asked of **someone else** (assignee set and not them), not final, to the
  requester **the next business morning in company time**: from 09:00 (`OVERDUE_NOTICE_HOUR`) of
  the first business day after the due's day (date-only or with a time alike; weekends, Japanese
  holidays and the company's holidays from the task settings skipped — `overdueMorning`; the zone
  from `timeZoneOf`, today `DEFAULT_COMPANY_TIME_ZONE` = Asia/Tokyo for every company, as
  `calendar.md`), once per due value (`overdue:<record>:<due>`); **stuck AI turn** (C-18) — same
  requester rule, the current state is an AI turn (`aiTurnStates`), and the record has not
  changed for 24 h; once per version. Types without `requested_by` (meeting) give no stuck
  notice. Only a requester who can read the record now gets either (an owner-only record's
  requester is its owner).
- `acceptance_waiting` (on by default): a request still in 引き受け待ち one business day after it
  began to wait — from the same time of day on the first business day after that day, company time,
  weekends and holidays skipped (`acceptanceReminderAt`) — to the requester (who can read it),
  once per wait (`acceptance_waiting:<record>:<version of the entry that began it>`). The sweep
  looks at up to `limit` waiting records per company; the read-time safety net uses the same rule.
- `wait_over` (on by default): the clock moved a wait that is over to the follow-up's turn — to
  the assignee (「…見込みの日時が過ぎました。追いかけてください」 / 「AI が追いかけを用意します」).
- `outside`: stage 3's Slack DMs (E-26) — called with the notices just written (kind, record,
  member; no text), bound in `composition.ts` to lane A's `services/slack-notices.ts`, which DMs
  only notices whose record now waits for the member (`slack-connector.md` "Notice DMs").
- Read access is checked **when read** (`recordReader` with today's rules): a record the member
  can no longer read (rules changed, private folder) or that was removed drops out of the list
  and of `unread`; nothing of it is shown. Records off → `{ available: false }` (no bell).
- Notices older than 90 days are forgotten when the member next reads (`NOTIFICATION_KEEP_DAYS`).

```
GET  /me/notifications            any member: their own → { available, unread, items ≤ 50 }
POST /me/notifications/read       { ids: [≤ 200] } | { all: true } — only the caller's rows change
GET  /me/notifications/settings   { kinds }
PUT  /me/notifications/settings   { kinds: { <kind>: boolean } } (unknown kind → 400)
```

No user id in any path or body: the member comes from the session; another member's or another
company's notice id changes nothing (`changed: 0`). Marking read and changing settings push a bare
`notifications` signal to the member's own connections (their other PC re-reads).

## The server clock (stage 2 S14, owner decision 2026-11-01)

`services/server-clock.ts` (`createServerClock`, built in `composition.ts` as `serverClock`),
run by `lib/server-clock-schedule.ts` from `index.ts` — one scheduler per server process, 30 s
after start then every 5 minutes (`CLOCK_INTERVAL_MS`). **The AI never runs on the server**: the
clock only notices that a time has come, moves the turn through the service writer (its checks,
compare-and-set and ledger), and writes notices.

- **A wait that is over** (`WAIT_OVER` in `shared/core/core-types.ts`; today `task`): a record
  still in `waiting` whose `wait_until` has passed (a day: once it is over; a time: that minute,
  company time) moves — to `preparing` (the AI's turn: the AI drafts the follow-up, then
  「用意ができた」/「先に渡す」 as for any preparation) when the record's
  **assignee**'s own 自動で進める is on (their PC runs it: `autoRunFor`, within the company's
  `autoRun.enabled`; no assignee → the company's 初めの値; `tasks.md` "Each member's switches") and `preparing` is an AI turn of the type, else to `todo`
  (the assignee's turn); `next_actor` = the assignee; the assignee is told (`wait_over`). Ledger
  action `wait_over`, actor `CLOCK_ACTOR` (kind `external`, id `acb:clock`, source 「ACB の時計」
  — the history shows the source), note 「返事の見込み（11/6）を過ぎました」 (`waitOverNote`; the 経緯 shows
  it as the line). Since task version 12 every new 返事待ち has a `wait_until` (`records.md` "Task
  version 12"); a waiting task without one is never moved. No new action or state in the task type: the moves are listed
  in `SERVICE_TRANSITIONS.task`, and the service writer allows a type that is not service-owned
  only those state changes (never a field-only change). A task someone moved meanwhile is
  `stale` and left alone.
- **Notices**: `notifications.sweep(companyId, limit)` (overdue, stuck AI turns, acceptance
  waiting, 「明日が期限」 and 「今日のあなたの番」, above; at most `limit` members per run for the
  summary, the ones already told today skipped through `usersWithKey`).
- **Expired content**: `expireContent` — the content store's retention, per company
  (`RecordContentEraser.eraseExpired`, reason `retention`; `records.md` "The content store").
- **Incoming mail**: `pollInbox` — the inbox's `pollCompany` (`inbox.md` "Connections"):
  connects the members the mail source can read, then reads each one's new mail as header facts
  and pointers (never the text), yielding between members; `ClockRun.mailRead` counts them.
- **Safe to run again and after a restart**: everything is derived from stored rows (a moved
  task is no longer waiting; a notice's dedupe key is already there), so a second run writes
  nothing. A run while one is going returns `ran: false`. Per company and run at most 50 moves
  and 500 records looked at per notice kind (`CLOCK_LIMITS`; newest dues first, oldest waits
  first), a yield to the event loop between companies, each company through its own handle; one
  company's failure is logged (error name only) and the others run.

## The push signal

`PUSH_EVENT_KINDS` (`shared/types/agent-stop.ts`) gained `notifications`: kind + a fresh version
only, like `records` (`agent-stop.md` "The push channel"). Released apps know only `policy` /
`records`: `parsePushEvent` returns null for any other kind, the SSE parser reports it as
`dropped` and keeps reading (only an over-long line closes the connection), so they log it and
carry on. The app never acts on the signal itself: it only asks the server again.

## The app

- Main: `electron/features/notifications/watcher.ts` (`createNotificationsWatcher`) reads
  `/records/my-turn` and `/me/notifications` for the company on screen with the session in the
  Cookie header — at `notifications:watch`, every 5 minutes, and on a `records` or `notifications`
  signal for that company (`agent-push-channel.ts` `onNotifications`, wired in `main.ts`). IPC
  (`features/notifications/ipc.ts`): `notifications:watch` / `state` / `markRead` / `settings` /
  `setSetting`, event `notifications:changed`. A `records` signal also sends `records:changed`
  (the task list re-reads, `tasks-ui.md`); so does the member's own AI writing a record in this
  app, which also asks this watcher again at once. Sign-out and quit forget everything.
- **Mac notifications (E-27)** only for an approval request, an item new in 「あなたの番」, or a
  notice the server marks fresh (`desktop`, above) — `desktopNoticesOf` in
  `client/shared/notifications-app.ts`: a fresh notice is shown **also on the first look** (the
  server decides freshness: the app opened at 10:00 gets that morning's summary) and **once per
  PC** — the ids shown are kept in `<userData>/notices-shown.json` (`shown-store.ts`, ids only),
  so a restart does not greet twice; a new turn item whose record has a fresh `asked` notice is
  not notified again (one notification per request, the asker's words). Clicking the morning
  summary's notification focuses the window and sends `notifications:openTasks` (the renderer
  shows the task list; `useOpenTasksRequest`), the others only focus. An app released before this
  drops a notice with `recordId` '' (its parser wants a record id), so it only sees the bell's
  unread number include it. Otherwise for turn items — a
  返事待ち task given back by the clock counts as new (`turnItemKey`: the server's `waitCameBack`; it was
  in the list while it waited), worded 「返事の見込みを過ぎました（あなたの番に戻りました）」 —
  computed from what the server answered (never from a signal), through the shell layer
  (`DesktopShell.notify`, Electron's `Notification` in `electron-adapter.ts`; a click focuses the
  main window). The first look at a company notifies no turn item; at most 3 per check. Words in
  `client/shared/notifications-app.ts` `desktopNoticeFor` (the record's title as the body).
- Renderer: `src/features/notifications/` — `TitleBarNotices` in the title bar (`TitleBar`
  `notices` slot, composed by `AppShell`). **Two roles, never mixed** (新しい画面のデモ I.1 / I.2):
  「あなたの番 N」 = what the member presses, until it is done — grouped by kind with what to do
  (`turnGroups`: 「承認のお願い 3件 — 承認してください」, 「送るメールの下書き 1件 — 確かめて送ってください」,
  `thing-words.ts`), due shown, 「起きたことはベルに出ます。ここは押すものだけです。」; N is the list's
  count. **Only this week's turn** (owner decision 2026-11-03): main reads the whole
  `/records/my-turn` (unchanged: a released app still counts it all) and keeps the items whose
  `turnTiming` is `now` (`thisWeeksTurn`, `client/shared/notifications-app.ts`, the company's today);
  the others (`resting`) get one line, 「…は、やることの一覧の「先のこと」「いつか」にあります」. The
  list's 「あなたの番」 and the morning summary use the same rule, so the three agree. The bell = 「起きたこと」 (読むだけ): a dot only for unread notices, the list, 「すべて読んだ」,
  「知らせの設定」 (one checkbox per kind, `NOTIFICATION_KIND_LABELS`). Opening a notice marks only
  that notice read.
- **Meetings where the department shows no task list** (`tasks-ui.md` "Minutes and AI turns"):
  `TitleBarNotices` takes `meetings` (AppShell, only while the task list is hidden) — a まとまり to
  choose and received minutes with the automatic runner's state, each with its buttons, in a 「会議」
  part: those waiting for the member (`needsPerson`: a まとまり to choose; minutes the AI is not
  reading or about to read) at the top of 「あなたの番」 and in its count; the others (the AI reading)
  in the bell, as news. They never light the bell's dot. Nothing is stored or sent for them: they
  come from the list main already read.
- Opening an item runs `record.open` (`commands.md`): the record's card in the editor area, the
  same as a search hit. The consultation a record belongs to opens from there once S12 links them.

## Tests

`server/tests/unit/notifications.test.ts` (one morning summary per business day per member with
a turn — none on a holiday, a weekend, before 08:30 or first run after 15:00, never twice, counts
built when read, gone when the kind is off; only this week's turn counted — a member with only
resting tasks is not greeted; 「明日が期限」 once per due value to the assignee on the
last business day before it, not for a cancelled task, again for a moved due; `asked` once per
assignment for a person, someone's AI, the own AI's hand-over and 引き受け待ち, never the requester —
mutation-checked; a member never receives nor marks another's;
cross-company; the push is kind + version only, to the told members, never the actor; gone when
access is lost; read state shared by two service instances = two PCs; default kinds and switches;
overdue once, the next business morning, only for the requester; stuck AI turn after 24 h),
`server/tests/unit/record-task-acceptance.test.ts` (accepted → the requester told; still waiting
a business day later → told once, not before, nobody else),
`server/tests/unit/absences.test.ts` (the delegate's copy only when they can read; the stops to
the manager; no chains),
`server/tests/unit/server-clock.test.ts` (nothing moves before its time; a second run does
nothing more; the AI's turn only with the assignee's 自動で進める; an owner-only record's notices only to its
owner; another company untouched and still run when one fails; one company's backlog capped per
run; no overlapping runs), permission-matrix rows,
owner-only record's notices only to its owner (not other members, not owners/admins; no row, no
signal), `client/tests/notifications.test.ts` (signal only refetches, content-carrying event dropped, an
unknown kind dropped without closing, session in the header, Mac notification only for new items;
a fresh notice once per PC across a restart, also on the first look, the morning summary opening
the task list, `asked` speaking for its new turn item; the title bar counts only this week's turn),
`client/tests/ui/title-bar-notices.spec.ts` (opening a notice marks only it read and opens its
record; the dot goes; 「あなたの番」 lists what waits; the morning summary opens the task list) —
each mutation-checked.

## Not yet

Opening the consultation a record belongs to
(S12); a per-company time zone (none in S6 either: `timeZoneOf` is the one place); notices for a reply to an
interaction or a stopped HubSpot exchange (their events come with stage 3).
