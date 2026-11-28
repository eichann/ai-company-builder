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
  - "client/tests/ui/contact-card.spec.ts"
  - "shared/core/turn-timing.ts"
  - "shared/core/notification-settle.ts"
  - "server/tests/unit/notification-settle.test.ts"
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
  `agent-browser.md` "Plans of opened lines on the server"; since redesign step ⑥ it also carries 「Skill の承認」's notices,
  keys `browser_skill:waiting|text:<skill>:<hash>`, built by `browserSkills.noticeText` — `agent-browser.md` "A Skill's
  browser declaration and its approval"). **Also with records off**: `GET /me/notifications` then answers `available: false` with only
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
  switchable like the other kinds; no new counter — they are notices: the inbox's 新着, never its あなた待ち):
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
    keeps the actor only then). The inbox's row (新着) has **［元に戻す］** (`useInboxSlot`, `undoNoticedChange`
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
    「すべて確認した」) or the change was written back (by anyone). Opening the record elsewhere does not
    count (simple and visible: the inbox's 新着 is the same state). A member with no turn but such
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
- **Settled notices** (片付いた, 4b-4 「自動で読む・知らせ・受け箱の数」 第1.1版, owner decision D4: only the clear kinds):
  `GET /me/notifications` adds `settled: true` to an **unread** notice whose matter is over, by one table
  (`shared/core/notification-settle.ts`, `NOTICE_SETTLE_RULES`, pure) judged from the **current state** of what it tells
  of — never the ledger, nothing stored, the notice **not** marked read (`unread` unchanged), no row ever written or
  changed: `minutes_arrived` — the meeting was taken up: `received` / `reading` / `read` / `skipped` (someone pressed ［AI に読ませる］
  / ［読まない］; never `arrived` or `failed`, which waits for a person again; a meeting put back to `arrived` counts again;
  the records' states, one batch); `job_failed` / `job_expired` — that occurrence ran afterwards
  (`done` / `nothing`, only reached through 「もう一度」; `jobs.occurrenceNotice`'s `state`); `job_paused` — the job is
  `active` again (`jobs.noticeJob`'s `state`; retired or paused again stays). Every other kind (what a requester is told:
  `overdue`, `acceptance_waiting`, `ai_turn_stuck`, `request_returned`…, and any kind not known) and a state that could not
  be read never settle (the safe side). Judged only on notices already visible to the member: settling never shows nor hides
  one. An app released before it ignores the field (counted as before). Tests: `tests/unit/notification-settle.test.ts`
  (the table, each kind's condition, unread and the rows unchanged, a read notice never marked),
  `job-occurrences.test.ts` 「past its expiry…」 and `jobs.test.ts` 「removing the member pauses…」 (the jobs' real states) —
  mutation-checked.

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
- **「ブラウザ操作」 recordings**: `expireBrowserRecordings` — every company, records on or off, deletes the recordings past
  their 30 days (`agent-browser.md` "Recording"); `ClockRun.recordingsDeleted`.
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
  screen: the title bar's one ［受け箱］ replaced 「あなたの番 N」 and the bell ("The title bar's ［受け箱］" below).
  **Only this week's turn** (owner decision 2026-11-03): main reads the whole
  `/records/my-turn` (unchanged: a released app still counts it all) and keeps the items whose
  `turnTiming` is `now` (`thisWeeksTurn`, `client/shared/notifications-app.ts`, the company's today); the list's
  「今日」「このあと」 and the morning summary use the same rule. Since 2026-11-26 the inbox takes only the approvals and
  mail drafts of it (あなた待ち); tasks are the list's.
  「知らせの設定」 (one checkbox per kind, `NOTIFICATION_KIND_LABELS`; none for a kind of a feature
  that is off in 「使う機能」, `noticeKindsShown`, `records.md` "Features on and off"; none of the owner / admin-only kinds
  `job_proposal` / `job_paused` / `company_restored` unless the member is an owner / admin — `noticeKindsForRole`, the role read with the
  dialog through `api:getCompanies`, not known → not offered; switching one keeps it, `settingsAfterSwitch`) opens from the inbox's heading (`NoticeSettingsDialog`). Opening a row marks only its notices read.
- **Meetings** (owner decision 2026-11-26: the banner on やること is gone): the inbox takes `meetings` (the minutes
  feature's `useMinutesSlots` `inboxMeetings`, placed by AppShell; `inboxView`'s second argument) — every meeting of the
  arrivals (any department), and where the department shows no task list also a まとまり to choose and received minutes
  with the automatic runner's state (`meetingTurns` → `meetingNewsOfTurn`; merged by id, `mergeMeetingRows`), each row
  with its own buttons (`InboxItem.meetingId` → the feature's actions). Where each goes: "The inbox" below. A feature
  turned off writes none of its notices and hands no meeting (`records.md` "Features on and off"). Nothing is stored or
  sent for them but the minutes feature's closed list on this PC.
- Opening an item runs `record.open` (`commands.md`): the record's card in the editor area, the
  same as a search hit. The consultation a record belongs to opens from there once S12 links them.

## The inbox (受け箱; redesign of 2026-11-26, owner decisions in 「受け箱の作り直し_開発への依頼」 依頼1)
The bottom panel's content (`renderer-structure.md` "The bottom panel"). **Two things only** (owner decisions 2026-11-26, which
replaced I1's ① 「the number = あなた待ち = this week's turn」 and ③ 「no 済んだ, a row leaves when opened」):

- **あなた待ち** (red; named by why it waits, never 「すぐ」「急ぎ」): what is stopped until the member acts — an unread stop
  notice the server has not settled (`STOP_NOTICES` by `STOP_LOOK`: `job_failed` red, `job_paused`, `ai_turn_stuck`,
  `job_expired`, `job_chain_stopped`, `delegate_stopped`, `company_restored`, `browser_shape_changed` amber), an approval
  (pending, or sent back to its requester) and a mail draft to check (`waitingTurnRow`: only those types of the server's
  turn), a 「ブラウザ操作」 draft or a run due for its confirm, and a meeting this PC's AI stopped on (`stage: 'stopped'`).
  **It leaves only when done**: the turn no longer lists the record, the server settles the stop (`settled`, "Settled
  notices" above: then it is 新着 「片付きました」), or the member presses the stop's ［済んだ］ (marks it read). **Opening a stop
  never marks it read** (`InboxItem.stop`, `useInboxSlot` `openItem`; looking is not dealing with it). A stop the server can
  never settle stays until ［済んだ］ (owner 2026-11-26). Order: stopped → a run nobody knows the result of → approval → mail;
  then nearest due, newest.
- **新着** (blue): what the member has not looked at — every unread notice that is no row's news (any kind, also one this
  app does not know: 「お知らせ」), and a meeting's 「読み終わりました」 not yet looked at on this PC. **One thing is one row**:
  the notices about one record are one row (`record:<id>`, its newest unread notice the line; a recordless notice
  `notice:<id>`); a notice about a row of あなた待ち is that row's news (its dot), never a 新着 row. **Opening the row or
  ［確認した］ marks exactly its notices read** (`markNoticesRead`, both PCs agree) — the blue count goes down by exactly one;
  it grows only when a new notice (or a finished reading) comes. 「すべて確認した」 marks every 新着 row (`newsNoticeIds`,
  `newsMeetingIds`), never あなた待ち and never the server's 「すべて」. Pressing one of a row's own buttons (a meeting's
  ［AI に読ませる］…) marks its notices read too. Newest first.
- **「確認したもの」** (its own chip): what was looked at — read notices the server listed (its newest 50) and meetings looked at (finished and seen here, set aside by
  another attendee) — newest first, each with ［元に戻す］ where it offers one; unread notices past the server's list are one line
  there, 「ほかに未読 N 件（古いもの）」, never counted (they are older than every listed one).
- **Moving on without the member** (under 新着, no dot, never counted): a meeting the AI reads or will (`stage: 'reading'`),
  a meeting question only the member answers (`stage: 'ask'`, a department without the task list), a meeting still
  waiting to be read whose notice was already read, switched off or from before the first day (`arrived`: never hidden in
  確認したもの — it may run out, and a failed reading says so on its line), and approved
  browser plans waiting for their result.
- **Tasks are never rows or counts here** (decision ②/E4): the task list's 「今日」「このあと」「期限切れ」 hold them
  (`tasks-ui.md`); a task due today is not in the inbox. **案2** (owner decision 2026-11-28, 11番-1): beside あなた待ち's
  count, 「ほかに 今日が期限など N 件は『やること』で →」 (`data-inbox-elsewhere`, opens the task list) — N is
  `InboxView.counts.elsewhere`, this week's turn items that `waitingTurnRow` does not make a row: the complement of the red
  count over the same turn, in the same loop, so the red-count rule stays in one place and the two never disagree. Not
  shown at 0. The line at the bottom (「…受け箱では数えません。」) is gone (the difference is said once, here).
- **The first day** (decision Q4): `INBOX_NEWS_SINCE` (2026-11-26 00:00 Japan) — a notice (or a finished meeting) from before
  it starts in 「確認したもの」 (still unread on the server: opening it marks it read). **One fixed instant, nothing stored**:
  a 「first day of this PC」 marker would, on the member's second PC opened later, take notices that came after the first
  PC's first day; a fixed instant never takes a notice made after it, however often and wherever it runs. A release later
  than it shows those days as 新着 (the safe side); the constant is set to the release day just before shipping (owner
  2026-11-26). Stops have no cutoff. Only a preview on a fixed clock hands another (`useInboxSlot` `newsSince`,
  `AppShell` `inboxNewsSince`).
- **Meetings** (owner 2026-11-26: the banner above やること is gone): the minutes feature hands `MeetingNewsRow`s
  (`client/shared/notifications-app.ts`: `stage` arrived / reading / read / stopped / ask / skipped, `line`, `meetingAt`,
  `expiresSoon`, `seen`, their buttons; `minutes.md` "In the app"). One meeting is one row: its 「議事録が届きました」 notice is the
  row's news. An arrived (or skipped by another attendee) meeting with an unread notice is 新着, with ［AI に読ませる］［読まない］;
  reading it moves on uncounted (「AI が読んでいます…」); finished it is 新着 again until looked at on this PC
  (`onMeetingSeen`, the minutes feature's closed list); 「あと1日で読めなくなります」 on one still waiting from its second day.
  A notice kind 「読み終わりました」 does not exist on the server: none was added (the look is per PC, like the banner's ×).
- **「連絡」1枚** (UX stage 2 「5番」, `inbox.md` "One contact in the app"): the notices about a 来た連絡 and its 返事のお願い are
  one row `contact:<interaction id>` (source 「連絡」, the card's status as its badge) that opens the contact's card; never a
  row of the 返事のお願い alone once the contact is read (`GET …/inbox/items/:id/contact`, the only read the inbox adds: the
  records its newest notices name, ≤ 30). A contact whose reply is over with a やること left is in 「確認したもの」.
- **Visibility is the server's**: every row comes from `/records/my-turn`, `/me/notifications`, the arrivals and the plans,
  which already left out what the member cannot read (and the contacts, read the same way); the inbox never filters on the
  client instead. AppShell is keyed by company and `useNotices` drops another company's answer; a contact's read or press
  answered after a company change shows nothing (the company era). **Nothing is stored** (`inboxView` rebuilds every
  answer; no new server table; the contact IPC of `inbox.md` is the only addition).
- **Nothing irreversible from a row**: `InboxAction` has no approve or send — ［承認する…］ / ［開く…］ open the approval card
  (`ApprovalCard`), ［確かめて送る…］ the mail draft card, a plan's ［承認する…］ / ［確かめる…］ its card, beside the list
  ("Working through the inbox" below).
  The type test in `model.test.ts` and the hook's exhaustive switch fail to compile when an action kind that approves,
  sends, runs or confirms is added. The one blue button of a row is what あなた待ち asks for; news only opens.
- **［元に戻す］** (`replied_done`, `mail_*`, `ai_changed`): on whatever row its notice lands, the newest such notice of a
  row; then 「「…」を元に戻しました。」 above the list until the panel closes or opens again.
- With records off the server still sends the company's own notices (`bellOnly`): they are rows too. The panel stays reachable
  over a department not downloaded on this PC (`renderer-structure.md` "The bottom panel"); opening a record from there
  switches to 全社 first.

### The title bar's ［受け箱］ (owner decision 2026-11-26, look 「2」; the rest of the bar: `renderer-structure.md` "The title bar")
- **One button** (`components/InboxButton.tsx`, the slot's `titleBarButton`): the tray icon, **a soft blue count = 新着**
  (`selected-bg` / `selected-text`, `data-inbox-news`) and **a soft red count = あなた待ち** (`danger-bg` / `danger-text`,
  `data-inbox-waiting`), each exactly as the list counts it (`InboxView.counts`; 99+; the only place the two counts show,
  the chips carry none: "Working through the inbox"); no word 「受け箱」, no solid pill, no dot; a
  count of 0 is not shown. Its name (aria-label and tooltip alike, `inboxButtonName`): 「受け箱：新着 N 件・あなた待ち N 件 (⌘J)」.
  Pressing it opens or closes the bottom panel — the same state as ⌘J. No button when there is no inbox.
- The morning summary's Mac notification and ⌘K 「受け箱」 open the inbox (`useOpenTasksRequest`, `AppDialogs`).
- 「知らせの設定」 is in the inbox's heading (a late answer never reopens it once closed).

### Working through the inbox (UX 点検 11, owner decisions 2026-11-28 「11番」, all as recommended)
The list the member goes through one row after another — the same promises as the やること list (`tasks-ui.md` "Working
through a list", list key `inbox`). Pure parts in `features/inbox/workModel.ts`; the slot (`useInboxSlot`) holds the look.
Never a row's own approve or send (unchanged): only the card's buttons act.

- **The chips switch, the title bar counts** (decision 7): ［あなた待ち］［新着］ carry no number (the title bar's ［受け箱］ has
  both, the one place they show; 案4's left destination takes that place in stage 5); 「確認したもの N」 keeps its own. Each
  section's heading keeps its count (under the kind chosen); あなた待ち's is red only under すべて (narrowed it is a part,
  never a second red count).
- **Kinds** (`INBOX_KINDS`, `kindOf`): すべて・止まった (a stop)・承認 (anything about an approval, a browser plan's included)・
  連絡・メール (a 連絡, a 来た連絡 / 返事のお願い before its contact was read, a mail to send)・知らせ (the rest), each with its count
  over the chip's sections, counted as the headings count (what moves on by itself and a 新着 kept in place are shown,
  never counted). **On one line** (decision 6): under 440 px (`KINDS_FIT_PX`, measured with `useIsNarrowerThan`)
  すべて and the first two stay and the rest are one 「その他」 select (`foldKinds`), which shows the kind chosen when it is
  among them. Another chip or kind is a new look.
- **15 rows first** (decision 4, `INBOX_PAGE`): the first 15 rows across the sections in order (`paged`); reaching the end
  (`useWhenVisible`, an IntersectionObserver on a callback ref, no effect) or pressing 「続きを表示（あと N 件）」 draws 15 more.
  **The rows are what main already read**: going down asks the server nothing (`/records/my-turn` holds the turn's first
  200, `/me/notifications` the newest 50, as before; `inbox.spec.ts` counts the reads). 「左の『やること』で見てください」 is
  gone; past the turn's 200 a quiet line says some approvals or mail may not be shown yet (`turnNotListed`, no redirect).
- **新着 opened stays in place** (decision 3, `withLingering`): opening a row (a click, Enter, ↑ ↓) marks exactly its
  notices read as before — the blue count goes down by one — and the row stays where it was in 新着, without its dot or
  ［確認した］ and not counted (`InboxItem.seenHere`), until the chip or the kind changes or the panel opens again; then it is
  in 確認したもの. ［確認した］ on a row still takes it away at once. A kept row that became あなた待ち is that row only. The
  inbox keeps only the keys: a kept row is drawn from the server's row of now (`view.seen`), so one the server no longer
  lists (gone, or no longer the member's to read) is not shown.
- **Replies** (decision 2): a reply that came to a contact is 新着 (its `reply_arrived` notice), never あなた待ち; a contact that
  only waits for a reply has no unread notice and is no 新着 row (where 返事待ち lives — the 「連絡」 destination — is stage 5).
- **Beside the list** (`besideCardOf`): an approval, a mail draft, a browser plan or a 連絡 opens its card **beside the
  list inside the panel** (`region` named 「承認のお願い」 / 「送るメールの下書き」 / 「承認のお願い（ブラウザ操作）」 / 「連絡」, one line
  of why the card comes first), with `WorkThroughBar` (「3 / 9」, ［前の件］［次の件］, ［閉じる］); the list narrows to two
  fifths. A record, the task list or 定期の仕事 open where they live, as before (the middle's preview tab, the settings).
  `InboxCardDialog` is gone.
- **Keys** (`useWorkThrough`, commands `list.*` with target `inbox`): ↓ / j and ↑ / k open the next / previous row (a card
  beside, a record in the middle — and a 新着 row opened this way is read and kept in place), Enter moves into the card,
  Esc back to its row; never from a field, a menu or a dialog.
- **The next one after a press** (common decision): a card's own press that finished it there hands the inbox `onDone`
  (`ApprovalCard`: approved, sent back, withdrawn, 「同じ」 — only when the request's state says so, `DONE_STATE`: an approve
  answered `failed` or `stale` stays on its card; `MailDraftCard` / `PreparedMailCard`: sent with a known result,
  thrown away — also the draft opened from a 連絡's card, which stands for the contact's row (`Beside.rowKey` kept); `BrowserPlanCard`: cancelled, or 済んでいた / されていなかった — **not** after ［任せる］, whose result is read on
  the card first; `ContactCard` `onFinished`: a finish written). The next row takes its place (`work.ended`; the last
  one → the card goes) and the list says 「『…』を片づけました。次の件です」; ［取り消す］ only where the press can be taken back (a
  contact's finish, at the versions it answered); approvals and sends cannot. A send whose result nobody knows stays.
  A press answered after the member opened another card changes nothing on screen (that card stays). When the list was
  read again first and the finished row is already gone, the row now in its place comes next (`Beside.at`, the same line).
  The contact's undo from the list: not reached → its words and ［取り消す］ again (`WorkUndoAnswer` `{ again }`); whether
  Gmail keeps the mail not known → no Gmail line, never 「元に戻せませんでした」.
- **Another company**: AppShell is keyed by company (the look starts again), every list's order, place and line are
  forgotten (`forgetAllWork`) and the inbox's ［取り消す］ and a contact's press are bound to the company era — answered after
  the switch they change nothing on screen.
- **Not here (stage 5, 案4's skeleton)**: folding the consultation list when a card opens beside (decision 5: today the chat
  pane is beside the middle, the bottom panel under it — folding the list would give the inbox no room), the 「連絡」
  destination with ［返事待ち］, the counts on the left destination, 案B (the card large with 前へ・次へ) on a narrow window.
- Tests: `src/features/inbox/workModel.test.ts` (案2's complement, replies 新着, kept in place and not counted, never twice,
  kinds and counts, 15 and the next page, 「その他」, which rows open beside), `src/shared/lib/workThrough.test.ts` (an undo's own
  words), `tests/ui/inbox.spec.ts` (countless chips, the card beside, the next one after 承認 without ［取り消す］, the keys, 15
  rows and the rest with no read, kinds and 「その他」 at 360 px, 案2's line), `tests/ui/contact-card.spec.ts` (the next one
  after ［返した］, the list's ［取り消す］ with the Gmail line, refused undo), `tests/ui/title-bar-notices.spec.ts` (kept in
  place) — mutation-checked.


- Tests: `src/features/inbox/model.test.ts` (the red count holds only stops, approvals and mail — never a task due today, a
  resting turn item or a notice that only tells; opening one 新着 row lowers the count by one and only a new notice raises it;
  「すべて確認した」 never reaches あなた待ち; a stop is not done by being opened, settled it is 新着; one meeting one row; reading
  uncounted, finished 新着 until seen; the first day: before it 確認したもの, after it never taken however often it runs;
  no approving action; unknown kinds kept; unread past the list told, not counted; the plans), `src/features/minutes/model.test.ts`
  (a meeting's row, 「あと1日で読めなくなります」, one row per meeting), `tests/ui/title-bar-notices.spec.ts` (the two counts and the
  name, a task never counted, opening / ［確認した］ / 「すべて確認した」, a stop only by ［済んだ］ or settled, meetings, every
  ［元に戻す］, 確認したもの, 「知らせの設定」 by feature), `tests/ui/inbox.spec.ts` (order, approvals only through their card, a
  request approved elsewhere leaves, the bulk never reaches あなた待ち, offline, the plans), `tests/ui/meetings.spec.ts` (the
  meetings' rows), `skill-layout-state.spec.ts` (the button and ⌘J one panel, ⌘K, the Mac notification),
  `status-colours.spec.ts` (the two counts' tokens, the rows' dots `unread`) — mutation-checked.

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
