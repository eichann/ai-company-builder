---
paths:
  - "shared/types/notifications.ts"
  - "server/src/services/notifications.ts"
  - "server/src/routes/notifications.ts"
  - "server/src/ports/notifications.ts"
  - "server/src/adapters/sqlite/notifications.ts"
  - "server/tests/unit/notifications.test.ts"
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

- Tables (`db/index.ts`, behind the company handle `notifications`, `ports/notifications.ts`):
  `notifications` (company, id, member, kind, record id, record version, ledger action, actor id
  + kind, `dedupe_key`, created, read) and `notification_settings` (company, member, kinds JSON).
  **No text, title, note or value is stored**: the text is built when the member reads.
- Written at the engine's existing notify points: the engine's `notify(companyId, userIds,
  change?)` now carries the ledger entry (`RecordChange`, `services/record-engine.ts`: engine
  create / act / undo, the service writer, the external writer). `composition.ts`
  `notifyRecords` sends the `records` signal as before and hands the entry to
  `services/notifications.ts` `recordChange`, which writes one notice per named member — **never
  the entry's actor** — and pushes `{ kind: 'notifications', version }` to those who have that
  kind on. A failure there is logged and never fails the engine's write.
- Kinds (`shared/types/notifications.ts`, `noticeKind`; generic over types — final states and the
  `request` fields decide, plus the core `approval` type):
  `approval_result` (an approval's state changed, to its requester), `ok_completed` (completed on
  your OK), `request_done` (what you asked reached a final state), `due_changed` (`due` changed on
  what you asked), `overdue`, `ai_turn_stuck`, `others` (everything else: handed to you, sent
  back, cancelled…). **Defaults (E-25)**: all on except `others` (CC and others' affairs). A
  member switches kinds (`PUT /me/notifications/settings`); kept per company × member on the
  server, so both PCs agree. Kinds filter at read time (notices are always stored).
- Computed when the member reads (no timer on the server, owner decision): **overdue** (A-2) — a
  request the member asked of **someone else** (assignee set and not them), not final, whose due
  has passed on the company clock (date-only: the day is over; with a time: that minute;
  `COMPANY_UTC_OFFSET_MINUTES` = Japan until the company settings S6 bring a zone), once per due
  value (`overdue:<record>:<due>`); **stuck AI turn** (C-18) — same requester rule, the current
  state has an action only the AI may do, and the record has not changed for 24 h; once per
  version. Types without `requested_by` (minutes) give no stuck notice.
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
- Opening an item: there is no card screen yet (S7c), and consultations are not linked to records
  yet (S12), so `AppShell` starts a **new consultation** titled after the record with
  `「<title>」（<record id>）について、` in its input — nothing is sent
  (`chat.newConsultation { title, draft }`, `commands.md`). When the card screen exists, open it
  instead.

## Tests

`server/tests/unit/notifications.test.ts` (a member never receives nor marks another's;
cross-company; the push is kind + version only, to the told members, never the actor; gone when
access is lost; read state shared by two service instances = two PCs; default kinds and switches;
overdue once and only for the requester; stuck AI turn after 24 h), permission-matrix rows,
`client/tests/notifications.test.ts` (signal only refetches, content-carrying event dropped, an
unknown kind dropped without closing, session in the header, Mac notification only for new items),
`client/tests/ui/title-bar-notices.spec.ts` (opening a notice marks only it read and opens its
record; the dot goes; 「あなたの番」 lists what waits) — each mutation-checked.

## Not yet

Slack DM for important notices (E-26, stage 3); the card screen as the target (S7c); opening the
consultation a record belongs to (S12); a per-company time zone (S6); notices for a reply to an
interaction or a stopped HubSpot exchange (their events come with stage 3).
