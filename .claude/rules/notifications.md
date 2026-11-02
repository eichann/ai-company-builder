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
  the entry's actor, and only a member who can read the record now** (an owner-only record's
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
  `delegate_stopped` (an absentee's item reaches nobody, to the department manager; above), `others` (everything else: handed
  to you — also the AI's 「用意ができた」 / 「先に渡す」 and 「自分で進める」 of task v5 —, sent back,
  cancelled…). While a task is the AI's (`preparing`) nobody is told on create (engine rule); the
  assignee hears at the hand-over. **Defaults (E-25)**: all on except `others` (CC and others' affairs). A
  member switches kinds (`PUT /me/notifications/settings`); kept per company × member on the
  server, so both PCs agree. Kinds filter at read time (notices are always stored).
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
  — the history shows the source). No new action or state in the task type: the moves are listed
  in `SERVICE_TRANSITIONS.task`, and the service writer allows a type that is not service-owned
  only those state changes (never a field-only change). A task someone moved meanwhile is
  `stale` and left alone.
- **Notices**: `notifications.sweep(companyId, limit)` (overdue and stuck AI turns, above).
- **Expired content**: `expireContent` — the content store's retention, per company
  (`RecordContentEraser.eraseExpired`, reason `retention`; `records.md` "The content store").
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
  `setSetting`, event `notifications:changed`. Sign-out and quit forget everything.
- **Mac notifications (E-27)** only for an approval request or an item new in 「あなたの番」,
  computed from what the server answered (never from a signal), through the shell layer
  (`DesktopShell.notify`, Electron's `Notification` in `electron-adapter.ts`; a click focuses the
  main window). The first look at a company notifies nothing; at most 3 per check. Words in
  `client/shared/notifications-app.ts` `desktopNoticeFor` (the record's title as the body).
- Renderer: `src/features/notifications/` — `TitleBarNotices` in the title bar (`TitleBar`
  `notices` slot, composed by `AppShell`): 「あなたの番 N」 opens a simple list (an approval is
  named 「承認のお願い：…」, due shown), the bell shows an unread dot and the list, 「すべて既読にする」,
  「知らせの設定」 (one checkbox per kind, `NOTIFICATION_KIND_LABELS`). Opening a notice marks only
  that notice read.
- **Meetings where the department shows no task list** (`tasks-ui.md` "Minutes and AI turns"):
  `TitleBarNotices` takes `meetings` (AppShell, only while the task list is hidden) — a まとまり to
  choose and received minutes with the automatic runner's state, in a 「会議」 part at the top of
  「あなたの番」 and of the bell, each with its buttons. Those waiting for the member
  (`needsPerson`: a まとまり to choose; minutes the AI is not reading or about to read) add to the
  count and keep the bell's dot. Nothing is stored or sent for them: they come from the list main
  already read.
- Opening an item runs `record.open` (`commands.md`): the record's card in the editor area, the
  same as a search hit. The consultation a record belongs to opens from there once S12 links them.

## Tests

`server/tests/unit/notifications.test.ts` (a member never receives nor marks another's;
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
unknown kind dropped without closing, session in the header, Mac notification only for new items),
`client/tests/ui/title-bar-notices.spec.ts` (opening a notice marks only it read and opens its
record; the dot goes; 「あなたの番」 lists what waits) — each mutation-checked.

## Not yet

Opening the consultation a record belongs to
(S12); a per-company time zone (none in S6 either: `timeZoneOf` is the one place); notices for a reply to an
interaction or a stopped HubSpot exchange (their events come with stage 3).
