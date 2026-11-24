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
  - "client/src/features/inbox/**"
  - "client/tests/inbox-ui.*"
  - "client/tests/ui/inbox.spec.ts"
  - "shared/core/turn-timing.ts"
---

# Notices (知らせ), 「あなたの番」 and the inbox (受け箱) (stage 2 S5; the inbox I1 / I2)

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
  the entry's actor (except their own AI handing them what someone else asked, `asked`, or what it made them from a message, `from_message`, below; the
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
  (`due` changed on what you asked), `overdue`, `ai_turn_stuck`, `wait_over` (the server clock, below), `reply_arrived` (the inbox: their reply came to a 返事待ち, to its assignee), `intake_unsure` (an interaction entered 確認待ち, to its owner; `inbox.md`), `from_message` and `replied_done` (below; all four on by default),
  `delegate_stopped` (an absentee's item reaches nobody, to the department manager; above),
  `minutes_arrived` (「議事録が届きました：「…」」, on by default: a meeting recorded `arrived`, or
  attendees joining it while still there, to each member on its list — the minutes service names
  them; once per meeting and member, `minutes_arrived:<record>`; `minutes.md`),
  `job_paused` (「定期の仕事「…」を止めました：…」, on by default, recordless like the morning summary: a scheduled
  job paused because its responsible person left or lost rights, to every owner / admin; key
  `job_paused:<job>:<reason>:<at>`; shown only while the reader is owner / admin — `jobs.md`),
  `company_restored` (「会社のデータをバックアップから戻したため、定期の仕事と AI を止めました。…」, on by default,
  recordless: written by `restorePause` after a restore to every owner / admin, key `company_restored:<at>`; shown only
  while the reader is owner / admin; opening it opens nothing; a Mac notification while unread — `deployment.md`
  "After a restore"), `browser_shape_changed` (「ブラウザ操作：「…」の「…」の形が変わりました（…）。…地図の確かめが要ります」, on by
  default, recordless: a member's app could not read a site's thing whole by its map — to every owner / admin, once per
  company × site × map version × thing, key `browser_shape:<site>:<version>:<thing>`; built when read from the stored names
  and counts, never a key name; shown only while the reader is an owner / admin; the inbox's amber stop row —
  `agent-browser.md` "Plans of opened lines on the server"). **Also with records off**: `GET /me/notifications` then answers `available: false` with only
  these company notices (never a record's), and the app's watcher, seeing `/records/my-turn` 404, shows the inbox with
  those notices alone (`NoticesState.bellOnly`, no 「あなたの番」) when there is one, else nothing as before (`restore-pause.test.ts`,
  `client/tests/notifications.test.ts`),
  `job_expired` / `job_skipped` / `job_failed` (on by default, recordless: an occurrence of a scheduled job
  whose time ran out, skipped because its responsible person was absent, or whose やること could not be
  made — to the responsible person and the job's creator while an owner / admin; key
  `<kind>:<job>:<occurrence>`; text built when read, shown only while the reader may see the job, its
  name 「定期の仕事」 when not theirs to read — `jobs.md` "Notices"; no notice when it ran, D9),
  `job_set_declined` (「「<会議名>」では、AI はたたき台を作りませんでした（<理由>）。…」, on by default, recordless: a set watch's AI
  judged 見送る — to the occurrence's responsible person only, key `job_set_declined:<job>:<occurrence>`; built when read and
  shown only while they are that occurrence's responsible person and read the meeting as one of its people — else not shown
  nor counted; `jobs.md` "The set watch (schema 5)" "How a run ends"; an app before PR6 shows it as a notice that waits),
  `job_accept_needed` (「定期の仕事「…」の責任者になりました…「受け取る」を押してください」, on by default,
  recordless: a version approved that its responsible person must accept, to them only — never the
  approver —; 「…の内容が変わりました…」 when they had accepted an earlier version; key
  `job_accept_needed:<job>:<version>`; shown only while it still waits for them; opening it shows the app's
  「定期の仕事」 (so do a stopped chain, a returned proposal and a set watch's 見送る `job_set_declined`, whose ［作ってもらう］ is there: `jobs.md` "The set watch (schema 5)" "The app (PR6)"), while opening an occurrence's notice opens nothing — `jobs.md` "The acceptance notice"),
  `job_proposal` (「〇〇さんから定期の仕事の案「…」が届いています…」, on by default, recordless: a member submitted a proposal of a
  time job, to every owner / admin — one row per recipient, key `job_proposal:<proposal>`, a resend adds none; built when read,
  shown only while the proposal still waits and the reader is an owner / admin — `jobs.md` "Member proposals"),
  `job_proposal_returned` (「出した定期の仕事の案「…」は差し戻されました（理由：…）…」, on by default, recordless: to the proposer
  only, once per proposal, key `job_proposal_returned:<proposal>`; the reason a fixed code's words, never text; shown only to
  the proposer while it is returned — `jobs.md` "Member proposals"). The app's notice settings offer the owner /
  admin-only kinds (`job_proposal`, `job_paused`, `company_restored`, `browser_shape_changed`; `ADMIN_ONLY_NOTICE_KINDS`) to owners / admins only (member
  proposals' PR C, owner decisions 2026-11-22),
  `asked`, `morning_summary`, `due_tomorrow` (below), `others` (everything else: the AI's
  「用意ができた」 / 「先に渡す」 when it is not a first hand-over, 「自分で進める」 of task v5, sent back,
  cancelled…). While a task is the AI's (`preparing`) nobody is told on create (engine rule); the
  assignee hears at the hand-over. **Defaults (E-25)**: all on except `others` (CC and others' affairs). A
  member switches kinds (`PUT /me/notifications/settings`); kept per company × member on the
  server, so both PCs agree. Kinds filter at read time (notices are always stored).
- **Noticing one's own turn without Slack** (owner decision 2026-11-03; all on by default, each
  switchable like the other kinds; no new counter — they are notices, the title bar's ［受け箱］ count
  stays あなた待ち's):
  - `asked` 「Aliceさんから「…」を頼まれました」 (`askedOf`): a request type's entry that leaves the
    member its assignee in a person's turn and either made them the assignee (a create, an
    `assign`; by a person or anyone's AI) or handed it over from a turn that told nobody
    (`noTurnStates`: the AI's preparation — also by the member's own AI —, a proposal; text +
    「（AI が用意しました）」). The asker is `requested_by`, else whoever made them the assignee —
    never the member. In 引き受け待ち the text adds 「引き受けるか、受けられないかを決めてください」.
    **Once per assignment**: dedupe key `asked:<record>:<version that made them the assignee>`,
    so a hand-over after a create that already told them, or a retried notify, writes nothing;
    the row's actor is the asker.
  - `from_message` 「来た連絡から、やることを作りました：「…」」 (`fromMessageOf`, owner FB #13): the
    member's **own AI** made a request **from a message that came in** (its create entry is their
    AI, the record has an origin link to a message: `messageOriginLinks`) and this entry leaves
    them its assignee in a person's turn — the create, or the AI's hand-over of its preparation.
    Told although their AI was the actor. Not a person's own create, not the AI's other actions
    (a later `assign` to themselves, a due changed), not a task from a message made for someone
    else (that one is `asked`). **Once per record** (`from_message:<record>`); several messages
    in a short time are separate notices (grouping them is a later step). No `desktop`: its due
    (`inbox.md` "A task from a message") puts it in this week's 「あなたの番」, whose new item is
    the Mac notification. An app released before it shows the server's text (the watcher keeps
    any kind with a record) and has no switch for it.
  - `replied_done` 「返事をしたので完了にしました：「…」」 (`repliedDoneOf`, owner FB #19, `inbox.md` "Tasks
    made from that message"): the member's **own AI** completed their task because their own reply
    finished it (ledger action `replied_done`, the inbox's reply check through the service writer, which
    names them in `notify` so they are told although their AI was the actor — the writer's `tell`
    keeps the actor only then). The inbox's row (できた・未確認) has **［元に戻す］** (`useInboxSlot`, `undoNoticedChange`
    → `tasks:undo` of that entry at the notice's version: the server refuses when something changed
    since); then 「元に戻しました」. Not a person's own completion, not the AI's other actions.
    Tests: `notifications.test.ts` 「a task the member's reply finished」, `tests/ui/title-bar-notices.spec.ts`
    (`?undo=1`) — mutation-checked.
  - `mail_left_inbox` 「Gmail ではアーカイブ済みのため、閉じました：「…」」 and `mail_archived` 「Gmail でも
    アーカイブしました：「…」」 (2026-11-05, `inbox.md` "Mail archived in the mailbox"): the inbox closed the
    owner's 来た連絡 because the mail left their mailbox inbox, or archived it there after they closed it
    (actor `INBOX_ACTOR`, ledger actions `left_inbox` / `archived_there`; the text uses the entry's note).
    Both rows have **［元に戻す］** like `replied_done` (`UNDOABLE_NOTIFICATION_KINDS`): the assignee may
    undo those entries (`UNDO_BY_ASSIGNEE`); undoing `archived_there` puts the mail back. On by default.
    Test: `tests/ui/title-bar-notices.spec.ts` (`?undo=mail`), `google-inbox-archive.test.ts` (the words).
  - `ai_changed` 「AliceさんのAIが「A社 研修」を自動で変えました：確度 B（中） → A（高）、次のアクション … 。
    理由：…」 (owner decision 2026-11-06, `aiChangedOf`; on by default): an AI's plugin operation applied
    **without approval** (`receipt.kind: written` with its operation id, no `approvedBy`) on a record
    whose **assignee** is the member — told although it was their own AI (an automatic step ran with
    nobody there), only while they can read the record (checked when written and when read), once per
    operation (`ai_changed:<operation id>`). Text built when read from the ledger entry: each field
    by its label (choices by `option_labels`) before → after, the AI's note as the reason (≤ 120
    characters); an attached create (a meeting logged) says it recorded to the connected service. The
    item carries `aiChange { pluginId, operationId, undone }`; the inbox's row has **［元に戻す］** while
    not undone — the app's `pluginOperations:undo` with the member's session (`undoNoticedAiChange`),
    which the server allows the assignee for exactly such a change (`plugins.md` 「変更前の値を書き戻す」)
    and re-checks like any undo; once written back the text ends 「（元に戻しました）」. An app released
    before it shows the text without the button (its watcher drops nothing it does not know).
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
    Opening it shows the task list. **「AI が変えた・まだ確かめていない」** (owner decision 2026-11-06,
    `aiChangesToCheck`): today's text adds 「。AI が変えた・まだ確かめていない 2件：「A社」「B社」」 (up to
    `AI_CHANGES_NAMED` titles, then ほか) — the member's `ai_changed` notices since their last morning
    summary before today (all kept ones when there was none) that are not **確かめた**, about a record
    they read now. **確かめた** = the notice was read (its row opened in the inbox, which marks it read, or
    「まとめて確認済みにする」) or the change was written back (by anyone). Opening the record elsewhere does not
    count (simple and visible: the inbox's できた・未確認 is the same state). A member with no turn but such
    changes still gets the morning notice (and its Mac notification).
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
  and of `unread`; nothing of it is shown. Records off → `{ available: false }` (no inbox, unless the company's own notices).
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
- **Scheduled jobs** (`jobs.md` "The clock"): `makeOccurrences` — every company first of all, records on
  or off (fast: no content, nothing outside), then `startJobRunner` starts the jobs' runner, which the
  clock never awaits (a slow company's mail or calendar never holds an occurrence up). This part has its
  own overlap guard and runs before the shared one: a pass still hanging on a company's mail never stops
  a later run's occurrences; `ClockRun.occurrences`.
- **「気になる動き」**: `securitySweep` — every company first, records on or off
  (`security-alerts.md`); `ClockRun.alerts` counts what it wrote.
- **Notices**: `notifications.sweep(companyId, limit)` (overdue, stuck AI turns, acceptance
  waiting, 「明日が期限」 and 「今日のあなたの番」, above; at most `limit` members per run for the
  summary, the ones already told today skipped through `usersWithKey`).
- **Expired content**: `expireContent` — the content store's retention, per company
  (`RecordContentEraser.eraseExpired`, reason `retention`; `records.md` "The content store").
- **Incoming mail**: `pollInbox` — the inbox's `pollCompany` (`inbox.md` "Connections"):
  connects the members the mail source can read, then reads each one's new mail as header facts
  and pointers (never the text), yielding between members; `ClockRun.mailRead` counts them.
- **Meetings**: `pollMeetings` — the minutes' `pollCompany` (`minutes.md` "Meetings for their
  attendees"): each member's calendar of the last 3 days with their own grant (a member without a
  usable one is refused locally), one members-only record per conference, yielding between members;
  `ClockRun.meetingsFound` counts the records made. Never the minutes' text. Run **after** every
  company's moves, notices, content and mail (a second pass), so a slow calendar never holds them
  up; capped per company and run (`minutes.md`). Test: `server-clock.test.ts`.
- **Safe to run again and after a restart**: everything is derived from stored rows (a moved
  task is no longer waiting; a notice's dedupe key is already there), so a second run writes
  nothing. A run while one is going returns `ran: false`. Per company and run at most 50 moves
  and 500 records looked at per notice kind (`CLOCK_LIMITS`; newest dues first, oldest waits
  first), a yield to the event loop between companies, each company through its own handle; one
  company's failure is logged (error name only) and the others run.

- `job_chain_stopped` (stage 4a, `jobs.md` "Event-triggered jobs" "A stopped chain"): an event job's chain stopped (the
  day's limit included: its one notice) — to its responsible person (always; plain words when they do not read the
  watched record) and to the job's creator only while an owner / admin who reads that record at that moment; once per
  stop, recordless; built when read and shown to anyone but the responsible person only while they still read the record
  (stage 4b-0.2, D7 = A: every stop is record-side; a non-reader gets no row, count or push). **A stop that stands for
  3 days** (`CHAIN_STOP_REMIND_AFTER_MS`), with the job not written since and the company's records on, brings the
  responsible person's own row back once — unread, dated now, its
  `action` set to `reminded` (`CHAIN_STOP_REMINDED`, the repository's `remindOnce` compare-and-set) and worded
  「…は11月18日から止まったままです（…）」; no new row, kind or key (`jobs.md` "A stopped chain"). An
  occurrence notice of an event occurrence reaches only those who read its record (and is shown only while they do); of a
  set watch's (4b-4 PR2) only those who also read its meeting and are one of its people.
- `job_day_limit` (4b-4 PR2, `jobs.md` "The set watch (schema 5)"): a set watch went past its day's limit — to its responsible
  person only (while a member), once per job and company day (key `job_day_limit:<job>:<day>`), recordless; built when read
  (`jobs.dayLimitNotice`) and shown only while the reader is the approved version's responsible person; it names the day from its
  key (never 「今日」), never a meeting's name or a count. An app that does not know the kind keeps it as any recordless one.

## The push signal

`PUSH_EVENT_KINDS` (`shared/types/agent-stop.ts`) gained `notifications`: kind + a fresh version
only, like `records` (`agent-stop.md` "The push channel"). Released apps know only `policy` /
`records`: `parsePushEvent` returns null for any other kind, the SSE parser reports it as
`dropped` and keeps reading (only an over-long line closes the connection), so they log it and
carry on. The app never acts on the signal itself: it only asks the server again.

**Who hears a `records` signal** (owner 2026-11-04: 「A さんが期限を変えたら、B さんの方もすぐ
更新されるべき（名前の載っていない、見られるだけの人にも）」): every member who **can read the changed
record now**, not only the people named on it — `services/record-signal.ts` (`recordChanged`,
the engine dep `RecordEngineDeps.recordChanged`, wired in `composition.ts`). Who reads it is
exactly `recordReader` (`recordReaders` in `services/record-access.ts`): an owner-only record
reaches its owner alone (owners and admins included in "nobody else"), a members-only record the
members on its list alone (an invitation reaches the newly added this way — no notice kind of its
own; `record-members.test.ts`), a private folder's record
only its readers, a member closed out of the folder nobody; the channel is per company. Sent on
every ledger entry the engine and its service / external writers make (create, act, undo, links,
file links, share, invite; a `quiet` service write sends this signal and no notice), the actor's other
PCs included. The notices (`notify` with the `RecordChange`) still go to the named people only.
Cost: only members with an open connection are evaluated (`PushChannel.listeners`), one
`recordReader` each per change, memberships in one query. The event is unchanged — kind + a fresh
version, no record id. Test: `server/tests/unit/record-signal.test.ts` (a reader not named hears
it, also when the actor is the only person named; closed folder, private folder, someone's
owner-only record, another company hear nothing; content-free) — mutation-checked.

## The app

- Main: `electron/features/notifications/watcher.ts` (`createNotificationsWatcher`) reads
  `/records/my-turn` and `/me/notifications` for the company on screen with the session in the
  Cookie header — at `notifications:watch`, every 5 minutes, and on a `records` or `notifications`
  signal for that company (`agent-push-channel.ts` `onNotifications`, wired in `main.ts`). IPC
  (`features/notifications/ipc.ts`): `notifications:watch` / `state` / `markRead` / `settings` /
  `setSetting`, event `notifications:changed` (the inbox's only: the task list does not listen).
  Signals come once per burst (`push-signal-fanout.ts`, ≤ 250 ms after the first). A `records`
  signal also sends `records:changed` (the task list re-reads, `tasks-ui.md`); so does the member's
  own AI writing a record in this app, which also asks this watcher again at once. When the
  watcher's own look (the 5-minute timer, a `notifications` signal alone) finds 「あなたの番」 changed,
  it tells the list (`onTurnChanged` → `records:changed`); never for the notices alone or the first
  look. `/records/my-turn` is read through the shared `MyTurnReads` (one request with the task list
  at the same moment; an answer that arrives after sign-out is discarded); the 「もう 1 回」 loop stays
  (`ipc-and-main-process.md` "Shared reads"). Sign-out and quit forget everything.
- **Mac notifications (E-27)** only for an approval request, an item new in 「あなたの番」, or a
  notice the server marks fresh (`desktop`, above) — `desktopNoticesOf` in
  `client/shared/notifications-app.ts`: a fresh notice is shown **also on the first look** (the
  server decides freshness: the app opened at 10:00 gets that morning's summary) and **once per
  PC** — the ids shown are kept in `<userData>/notices-shown.json` (`shown-store.ts`, ids only),
  so a restart does not greet twice; a new turn item whose record has a fresh `asked` notice is
  not notified again (one notification per request, the asker's words). Clicking the morning
  summary's notification focuses the window and sends `notifications:openTasks` (the renderer
  opens the inbox since I2 — the task list when there is none; `useOpenTasksRequest`; the channel's name stays,
  released apps read it), the others only focus. An app released before this
  drops a notice with `recordId` '' (its parser wants a record id), so it only sees the bell's
  unread number include it. Otherwise for turn items — a
  返事待ち task given back by the clock counts as new (`turnItemKey`: the server's `waitCameBack`; it was
  in the list while it waited), worded 「返事の見込みを過ぎました（あなたの番に戻りました）」 —
  computed from what the server answered (never from a signal), through the shell layer
  (`DesktopShell.notify`, Electron's `Notification` in `electron-adapter.ts`; a click focuses the
  main window). The first look at a company notifies no turn item; at most 3 per check. Words in
  `client/shared/notifications-app.ts` `desktopNoticeFor` (the record's title as the body).
- Renderer: `src/features/notifications/` holds the notices' port (`api.ts`) and `useNotices` (what main read
  for the company on screen); since I2 the **inbox** (`src/features/inbox`, "The inbox" below) is their only
  screen: the title bar's one ［受け箱］ replaced 「あなたの番 N」 and the bell (owner decision ①, "The title bar's
  ［受け箱］" below). **Only this week's turn** (owner decision 2026-11-03): main reads the whole
  `/records/my-turn` (unchanged: a released app still counts it all) and keeps the items whose
  `turnTiming` is `now` (`thisWeeksTurn`, `client/shared/notifications-app.ts`, the company's today);
  the others (`resting`) get one line, 「…は、やることの一覧の「先のこと」「いつか」にあります」. The
  list's 「あなたの番」, the morning summary and the inbox's あなた待ち use the same rule, so they agree.
  「知らせの設定」 (one checkbox per kind, `NOTIFICATION_KIND_LABELS`; none for a kind of a feature
  that is off in 「使う機能」, `noticeKindsShown`, `records.md` "Features on and off"; none of the owner / admin-only kinds
  `job_proposal` / `job_paused` / `company_restored` unless the member is an owner / admin — `noticeKindsForRole`, the role read with the
  dialog through `api:getCompanies`, not known → not offered; switching one keeps it, `settingsAfterSwitch`) opens from the inbox's heading (`NoticeSettingsDialog`). Opening a row marks only its notices read.
- **Arrived minutes** (owner decision 2026-11-07): where the department shows no task list, the
  meetings that arrived and nobody asked the AI to read (`arrived`) are rows of the 「会議」 part too,
  needing a person, with ［AI に読ませる］ (`arrivedMeetingTurns`, `client/shared/notifications-app.ts`;
  AppShell reads them from the arrivals). A feature turned off writes none of its notices
  (`records.md` "Features on and off").
- **Meetings where the department shows no task list** (`tasks-ui.md` "Minutes and AI turns"):
  the inbox takes `meetings` (the minutes feature's `useMinutesSlots` `titleBarMeetings`, placed by AppShell, only
  while the task list is hidden; `inboxView`'s third argument) — a まとまり to choose and received minutes with
  the automatic runner's state, each row with its own buttons (`InboxItem.meetingId` → the feature's actions):
  those waiting for the member (`needsPerson`: a まとまり to choose; minutes the AI is not reading or about to
  read — a failed reading red, one the AI may not do amber, first) in あなた待ち and its count; the others (the
  AI reading or about to) in 作業中, not counted. One already in the server's turn stays that one row, with the meeting's buttons; an unread notice
  about a meeting (waiting or the AI's) is that row's news, never a second row. Nothing is
  stored or sent for them: they come from the list main already read.
- Opening an item runs `record.open` (`commands.md`): the record's card in the editor area, the
  same as a search hit. The consultation a record belongs to opens from there once S12 links them.

## The inbox (受け箱, I1; owner design 「下のパネルを「受け箱」1 つにする」 2026-11-22, decisions ①–⑧)
The bottom panel's content (`renderer-structure.md` "The bottom panel"): **one list** of what the server
already says concerns the member, by what it needs from them — no tabs by source, chips by state
(すべて / あなた待ち / 作業中 / できた・未確認, with counts, 99+). `src/features/inbox/model.ts` `inboxView`
(pure) builds it from the `NoticesState` main already reads (`useNotices`, this week's turn through
`thisWeeksTurn`); **no new server table, API or IPC, nothing stored**: rows are rebuilt from every answer.
- With records off the server still sends the company's own notices (`bellOnly`, `company_restored`): they are
  rows too (あなた待ち), and the inbox is there for them.
- **Visibility is the server's**: every row comes from `/records/my-turn` and `/me/notifications`, which
  already left out what the member cannot read; the inbox never filters on the client instead. AppShell is
  keyed by company and `useNotices` drops another company's answer, so a switch or sign-out shows nothing old;
  a row that a re-read no longer lists (removed, closed out, approved elsewhere) is gone.
- **あなた待ち** (never folded, never capped; >10 adds 「多いときは、期限の近いものから」; items past the
  server's first 200 are 「ほかに N 件」): this week's turn plus unread stop notices — by what the stop means
  for the member (`STOP_LOOK`): `job_failed` red 止まりました; `job_paused`, `ai_turn_stuck`, `job_expired`,
  `job_chain_stopped`, `delegate_stopped`, `company_restored` amber 止まっています — and every unread notice that
  **asks for something** whose record is not a listed row (`asked` for a later task, `overdue`,
  `acceptance_waiting`, `request_returned`, `intake_unsure`, `wait_over`, `reply_arrived`, `due_tomorrow`,
  `minutes_arrived`, `job_accept_needed`) **and any kind this app does not know** (the safe side:
  `noticePlace`). These rows **leave when opened** (today's read state, decision ③: no new 「済んだ」). Order:
  stopped → (AI questions, I3) → approval → mail draft → check (minutes check, review) → the rest; then
  nearest due, newest.
- **One job is one row**: an unread notice about a record in あなた待ち is that row's line and new mark
  (not a row; a stop makes the row a stop, first and with its badge); opening the row marks exactly those
  notices read (`markNoticesRead`, both PCs agree; a failure shows 「サーバーにつながりませんでした…」).
- **できた・未確認**: only the notices that tell of something finished (`request_done`, `ok_completed`,
  `request_accepted`, `approval_result`, `replied_done` / `mail_*` with ［元に戻す］, `job_skipped` grey
  止めています — skipped on purpose) or changed (`due_changed`, `others`, `ai_changed` 「変わりました」 — but
  while the server's turn is past its first 200 these may be about a waiting record: あなた待ち); off kinds
  never arrive (decision ④); `morning_summary` is no row. Older than `DONE_KEEP_DAYS` (14) → one line 「14 日より前のもの N 件」
  (decision ⑥). **Every read notice the server listed stays findable** (its newest 50, read ones included, as the
  bell showed them — also a read stop or ask, and one about a record that waits now), folded at the bottom: made
  today → 「きょう確認したもの」, earlier → 「前に確認したもの」 (`seenBefore`, newest first), each with ［元に戻す］ where
  it offers one; counted nowhere (there is no 「未確認に戻す」: the server has no unread). **Unread notices past the
  server's list** (`notices.unread` above the listed unread, `unreadNotListed`) are one line 「ほかに未読 N 件（古いもの）」
  and count in すべて, never dropped silently. **［元に戻す］ in every state**: a change that can be undone keeps its
  button on whatever row its notice lands — a waiting row it is the news of (the AI changed a task that is the
  member's turn; the newest such notice — 「元に戻しました」 is kept per notice, so a later change there can be undone
  again), a notice row in あなた待ち (the turn past its first 200), できた, or the
  folded lists. At most `INBOX_MAX_ROWS` (100) rows: the oldest できた go first, あなた待ち never.
- **「まとめて確認済みにする」 only for できた・未確認** (decision ⑦): `bulkSeenIds` gives every できた
  notice's id (shown, left out by the row limit, or folded; owner 2026-11-22: as the rule says) — never a stop,
  a notice that asks for something, a row's news, or the server's 「すべて」. No 「未確認に戻す」 for now (owner).
- **Nothing irreversible from a row** (decision on 承認): `InboxAction` has no approve or send —
  ［承認する…］ / a sent-back request's ［開く…］ open the approval card (`ApprovalCard`, which re-reads the
  request each time: approved elsewhere → 「承認されました」 and no button; the server's hash and CAS stop a
  stale press), ［確かめて送る…］ the mail draft card (`PreparedMailCard`), both composed by AppShell in
  `InboxCardDialog` (the shared `Dialog`). Other rows open their record (`record.open`'s tab), the task list
  or 「定期の仕事」, or only mark seen. A type test (`model.test.ts`) and the hook's exhaustive switch fail to
  compile when an action kind that approves, sends, runs or confirms is added.
- **「ブラウザ操作」 plans** (`agent-browser.md` "The inbox's rows"; a second source besides `NoticesState`, the
  member's own through `browserPlans:list`, **only while the build's switch is on** — off, AppShell hands no
  list: no row, nothing read): a draft waits with the approvals (amber 「承認を待っています」 ［承認する…］), a run
  nobody knows the result of waits right after the stops once the server says its confirm can be pressed (amber
  「届いたか分かりません」 ［確かめる…］), the rest is 作業中; each opens the plan's own card (`BrowserPlanCard`,
  composed by AppShell) in `InboxCardDialog`, never acts. Key `browser:<planId>`; no notice, so nothing to mark
  seen; a settled plan is in no list and gone. Rows count in あなた待ち (and the title bar's number) and are
  news for the dot like any row; the dot's baseline also waits for the plans' first answer.
- The panel stays reachable over a department not downloaded on this PC: its prompt covers the left side's
  top, the panel spans the side under it (`renderer-structure.md` "The bottom panel"); opening a record or the
  task list from there switches to 全社 first, so what was opened shows instead of the prompt.
- 作業中 holds only the meetings the AI is reading and unsettled browser plans (above) until I3 / I4 add the
  consultations and 「AI の番」, and says where to look meanwhile.

### The title bar's ［受け箱］ (I2, owner decisions ① and ②)
- **One button** where 「あなたの番 N」 and the bell were (`components/InboxButton.tsx`, the slot's `titleBarButton`,
  `TitleBar`'s `inbox`): 「受け箱」 with **the number = あなた待ち** exactly as the list counts it
  (`InboxView.counts.waiting`: this week's turn + waiting meetings + unread stops and asks + 「ほかに N 件」; the
  primary count, 99+) and **the dot = something new** (`NewDot`). Pressing it opens or closes the bottom panel —
  the same state as ⌘J (the 「画面の形」 panel button was removed as its duplicate, owner 2026-11-22: add one back
  when the panel holds something else). No count or dot when there is no inbox (records off without
  company notices: no button at all).
- **The dot** (`inboxNewsKeys` / `inboxNewsBaseline` / `hasInboxNews`, pure): every waiting / working row by key
  and state, every unread notice, and one key per unread notice past the server's list (more of them is news); a
  key not there when the inbox was last on screen is new. Before it was on screen in this window, the rows count as
  seen and unread notices do not — so at the start the dot is the old bell's (something unread on the server, the
  same on the member's PCs); that baseline follows the rows **until every source answered once** (the slot's
  `ready`: the task list behind the meetings, the arrivals — `useMeetingArrivals` `read`), so meetings that load late
  are not news. While the panel shows, **what the chosen chip shows** counts as seen (`seenWhileShown`: あなた待ち
  hidden by 「できた・未確認」 stays new), and a row that left meanwhile and comes back after it closed is new again;
  a row leaving is not news. Memory only (AppShell is keyed by company): nothing stored, a restart starts
  from the server's unread again.
- **Where each part of the bell and 「あなたの番」 went**: the turn list → あなた待ち; 「…は「先のこと」「いつか」にあります」
  → the same line there; the bell's list → rows by meaning (above); ［元に戻す］ → the row (then 「「…」を元に戻しました。」 above the list
  until the panel closes or opens again: marked seen, the row folds into 「きょう確認したもの」, as the bell's row said
  「元に戻しました」); the bell's read notices → 「きょう確認したもの」 / 「前に確認したもの」; 「知らせの設定」 → the
  inbox's heading (a late answer never reopens it once closed); the meetings and their buttons → rows (above); the morning summary's line (no row, decision) →
  its Mac notification opens the inbox; 「すべて読んだ」 → 「まとめて確認済みにする」 for できた・未確認 only (decision ⑦:
  a stop or an ask is opened one by one). ⌘K 「受け箱」 (also あなたの番 / 知らせ / 通知 / ベル) opens it
  (`AppDialogs` palette action, only while there is an inbox).
- Tests: `tests/ui/title-bar-notices.spec.ts` (`tests/title-bar-notices-ui.html`: the number equals あなた待ち with
  meetings, the dot goes once shown and comes back for the next new thing, opening marks only its notice, the
  meetings' buttons, every ［元に戻す］ and its line — also on a waiting row the AI changed —, 「前に確認したもの」 and
  「ほかに未読」, the dot only for the chip shown and not for meetings that load late, 「知らせの設定」 by feature),
  `model.test.ts` (meeting rows, the dot's keys, a できた notice the row limit left out still new, ［元に戻す］ in every
  state, the read lists, unread past the list),
  `skill-layout-state.spec.ts` (the button and ⌘J one panel, ⌘K, the Mac notification opens it),
  `status-colours.spec.ts` (the dot `unread`, the count `primary`) — mutation-checked.
- Tests: `src/features/inbox/model.test.ts` (order, one row per record, stops leave once read, the 14-day
  fold, the bulk only for できた, あなた待ち never capped, no approving action), `tests/ui/inbox.spec.ts`
  (`tests/inbox-ui.html`: order and chips, ［承認する…］ opens the real card and calls nothing, opening
  marks exactly its notices, a request approved elsewhere leaves, the fold and the bulk; `?plans=1|off`: a plan's rows open the real plan card and nothing runs, a plan approved elsewhere leaves on the next read, ［任せる］ on a card elsewhere moves the row at once, a read every minute while a plan is listed and a few minutes on through a run claimed elsewhere, then none, switched off no row and no read),
  `skill-layout-state.spec.ts` (⌘J, the wide tab, the real inbox in the screen — as shipped it never reads the plans), `model.test.ts` (the plans' order and states) — mutation-checked.

## Tests

`server/tests/integration/plugin-operations.test.ts` 「the stage moves by itself…」 (`ai_changed` to
the assignee only — also their own AI's, another member's AI's; its text, reason and operation; the
assignee's undo and another member's refusal; gone when they cannot read; the morning section listed,
cleared by reading and by undoing — mutation-checked), `client/tests/notifications.test.ts` (the
operation kept only as plain ids),
`server/tests/unit/notifications.test.ts` (one morning summary per business day per member with
a turn — none on a holiday, a weekend, before 08:30 or first run after 15:00, never twice, counts
built when read, gone when the kind is off; only this week's turn counted — a member with only
resting tasks is not greeted; 「明日が期限」 once per due value to the assignee on the
last business day before it, not for a cancelled task, again for a moved due; `asked` once per
assignment for a person, someone's AI, the own AI's hand-over and 引き受け待ち, never the requester —
mutation-checked; `from_message` once per record for the own AI's create or hand-over from a
message, not for a person's own create, the AI's task without a message, its later actions or a
later `assign` to the member, only to the assignee and gone when they cannot read it —
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
a fresh notice once per PC across a restart, also on the first look, the morning summary's click
sent as `notifications:openTasks`, `asked` speaking for its new turn item; the count is only this week's turn),
`client/tests/ui/title-bar-notices.spec.ts` (the title bar's ［受け箱］, "The title bar's ［受け箱］" above) —
each mutation-checked.

## Not yet

Opening the consultation a record belongs to
(S12); a per-company time zone (none in S6 either: `timeZoneOf` is the one place); notices for a reply to an
interaction or a stopped HubSpot exchange (their events come with stage 3).
