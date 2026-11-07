---
paths:
  - "shared/core/business-days.ts"
  - "shared/core/task-settings.ts"
  - "shared/types/task-settings.ts"
  - "server/src/services/task-settings.ts"
  - "server/src/services/task-acceptance.ts"
  - "server/src/routes/task-settings.ts"
  - "server/src/ports/task-settings.ts"
  - "server/src/adapters/sqlite/task-settings.ts"
  - "server/tests/integration/task-settings.test.ts"
  - "server/tests/unit/task-settings-core.test.ts"
  - "admin/src/app/companies/*/advanced/work/**"
  - "admin/src/app/companies/*/advanced/calendar/**"
  - "admin/src/components/advanced/task-settings-page.tsx"
  - "admin/src/lib/task-settings.ts"
  - "admin/src/components/departments/department-members-dialog.tsx"
  - "admin/tests/task-list.test.tsx"
  - "shared/core/work-switches.ts"
  - "shared/types/work-switches.ts"
  - "server/src/services/work-switches.ts"
  - "server/tests/unit/work-switches.test.ts"
  - "client/shared/work-switches.ts"
  - "client/electron/features/work-switches/**"
  - "client/tests/work-switches-ipc.test.ts"
  - "client/src/features/settings/components/MySwitchesSection.tsx"
  - "client/src/features/settings/hooks/useWorkSwitches.ts"
---

# Tasks: company task settings, business days, department membership

Stage 2 (やることの一覧・本体), S6. Owner decisions of 2026-11-01 (plan「段階2・3 作業の分け方」).
The task list screen, the AI's turn running by itself and the shared inbox come in later PRs
(S7b, S10, C6); this is what they read.

## Company task settings (`GET|PUT /api/companies/:id/task-settings`)

- One JSON document per company (`task_settings`, behind the company handle:
  `companyData.forCompany(id).tasks`), shape and validation in `shared/core/task-settings.ts`
  (`parseTaskSettings`, re-run on every read; a stored document that no longer validates falls
  back to the defaults). Every member reads it (the app needs it); only owner/admin change it —
  department managers do not. `PUT` takes the whole document.
- `taskListDepartmentIds`: departments that show the task list; `null` = every department (the
  default, also departments created later). Ids must be departments of the company (another
  company's id is refused exactly like one that exists nowhere); departments deleted later are
  dropped on read.
- `reply` (返事の目安 of a message that names no deadline): `next-business-day` (翌営業日, the
  default) or `same-day` (当日中) with `sameDayCutoff` (`HH:MM`, default 17:00). Only `same-day`
  uses the cutoff.
- `autoRun` (自動で進める): `enabled` = 使ってよいか (default **on**, owner decision 2026-11-01; an
  admin turns it off for everyone), `memberDefault` = 各自の初めの値 (default **on**, 2026-11-02;
  missing in an older document → on), `dailyLimit` per member per day (default 30,
  1–500), `stopAfterFailures` in a row (default 3, 1–20). Sending and approving are always pressed
  by a person whatever this says (approvals.md, outbound-mail.md); the runner (S10) enforces the
  limits. Whether it is on for a member: "Each member's switches" below.
- `readIncoming` (受信を読む, 2026-11-02): `allowed` (default **on**) and `memberDefault` (default
  **off**); missing in an older document → those defaults. It is the company's **one** switch for
  reading members' mail and Slack: Google's company `inbox` feature reads and writes it
  (`google-connector.md` "One consent"; `setReadIncomingAllowed`).
- `meetingTasks` (会議から AI が作るやること, owner decision 2026-11-02, plan F): `propose` (案として出す,
  the default) — the AI's homework of a meeting is a proposal a person adds or puts away — or
  `create` (自動で作る) — a task at once, as before (`records.md` "Task version 11"). A document
  without it reads the default. Admin: the card 「会議から AI が作るやること」.
- `acceptance` (引き受け, owner decision 2026-11-01; `records.md` "Acceptance"): when a request
  someone else is asked to do counts as accepted by itself — `sameDepartment` (the asker and the
  assignee belong to a common department), `managerToMember` (the asker manages a department the
  assignee belongs to), `meetingHomework` (the AI made it as homework of a meeting the assignee
  attended: the task's `meeting` link); default all **on**, so only asking someone in another
  department (or someone who belongs nowhere yet — membership starts empty) waits in 引き受け待ち.
  Owner-only and one's own tasks never wait. `services/task-acceptance.ts` answers through the
  company's handle only. A stored document (or an older admin console's `PUT`) without
  `acceptance` takes these defaults rather than failing.
- `bundleName` (束ねるものの名前, owner decision 2026-11-02): what the core's ordinary 束ねるもの
  (`project`) is called in this company — one name for the company, default 「プロジェクト」, one
  line of 1–20 characters (NFC, trimmed). A document (or an older admin console's `PUT`) without
  it reads the default. Departments with a business plugin's kind use that kind's own name
  (`records.md` "Bundle kinds"). Admin: the card 「やることを束ねるものの名前」.
- `companyHolidays`: the company's own days off (`{ date: YYYY-MM-DD, name }`, ≤ 400, years
  2000–2100), stored sorted.

- `teamMode` (チームの進め方, owner decision 2026-11-02): default **off**; missing in an older
  document → off. On: the team's steps on a task are offered (引き受け待ち, 確かめる人・レビューと
  差し戻し, 受けられない, 代わりの人; only on tasks with someone else involved). Off: one's
  own task (未着手 → 進めている → 完了 / やめる) and 人に頼む. 返事待ちにする is in the card's 「…」
  either way (owner decision 2026-11-03, `tasks-ui.md`). The company's alone (no member choice);
  the app reads it as `teamMode.on` of `GET /me/work-switches` (`workSwitches:get`). The task card
  reading it is the screen's (画面乙); the server does not refuse team actions by it yet.

## Each member's switches (自分の設定, owner decision 2026-11-02)

- 受信を読む and AI が自動で進める are each member's own, within the company's (rule:
  `shared/core/work-switches.ts`; the company's side: `workSwitchPoliciesOf` over `autoRun` and
  `readIncoming`). On = the company allows it **and** (the member's choice, else the 初めの値). A
  switch the company does not allow is off for everyone and cannot be turned on (409
  `WORK_SWITCH_COMPANY_OFF`, nothing stored); turning off is always kept.
- Stored per member behind the handle (`member_work_switches`, `tasks.workSwitches` /
  `saveWorkSwitches`; a leaver's row goes with `removeMember`). When the table is first made
  (`migrateMemberWorkSwitches`, once), a member who read incoming messages — Google's 受信を読む
  granted and not turned off, or Slack's reading granted and not turned off — gets 受信を読む
  chosen on (Google's own toggle turned off → chosen off), so the 初めの値 "off" changes nothing
  for them.
- `GET|PUT /api/companies/:id/me/work-switches` (`{ switch: 'readIncoming' | 'autoRun', on }`, any
  member, their own only) → `MyWorkSwitches` (`shared/types/work-switches.ts`: per switch `on`,
  `allowed`, `companyDefault`, `chosen` (null = never chose); 受信を読む adds `connected: { mail,
  chat }` — what Google / Slack let ACB read, so the app can offer 「Google で許可」), plus the
  company's `teamMode: { on }` (read only here; `PUT` takes only the two switches) and
  `channels: { mail, chat }` — whether a usable connector serves the company's `mail` / `chat`
  role now (`connector-roles.md`; `choice-needed` counts as connected; asked per request through
  `channelsOf`, late-bound in `composition.ts`; a failure leaves the field out). App: IPC
  `workSwitches:get` / `workSwitches:set` (`client/electron/features/work-switches/ipc.ts`,
  `client/shared/work-switches.ts`). The screen: 設定 → 自分の設定 (the settings open on it;
  `client/src/features/settings/components/MySwitchesSection.tsx`, `hooks/useWorkSwitches.ts`): a switch
  the company does not allow is greyed out with 「会社の設定で止まっています」 and cannot be turned on;
  **a company with neither mail nor chat** (`companyHasMailOrChat`, `client/shared/work-switches.ts`:
  `channels` both false; absent = connected, as before) shows no 受信を読む switch, only the line
  「Gmail・Slack をつなぐと、返事の追いかけを AI がします」 (`CONNECT_MAIL_CHAT_TEXT`; owner decision
  2026-11-03: tasks are complete without Gmail / Slack, the follow-up is a bonus when connected,
  and this is the one place that says so — nothing on the task screens; the Google / Slack sections
  where one connects stay);
  a refused change shows the server's words and reads the switches again
  (`client/tests/ui/my-switches.spec.ts`).
- Who follows it: **自動で進める** — the AI's turn runs on the assignee's PC, so the PC asks its
  member's own (`aiTurns:settings`, `ai-turns.md`) and the server clock moves a wait that is over
  to the AI's turn only when the record's **assignee** has it on (`autoRunFor`; no assignee → the
  初めの値; `notifications.md` "The server clock"). Off: work still arrives (a minutes check is
  still delivered), only the AI's work waits for ［AI に進めてもらう］. **受信を読む** — the Google
  client refuses `gmail.readonly` calls (`off` when the company does not allow it, `feature-off`
  when the member's own is off; `google-connector.md`), Slack's signals are dropped
  (`slack-events.ts` `readsIncoming`), and the one consent does not ask `gmail.readonly` of a member
  whose own is off. Google's member toggle `PUT /me/google/features { feature: 'inbox' }` writes this
  switch (one switch, not two).
- Tests: `server/tests/unit/work-switches.test.ts` (the carry-over once, company off refuses,
  choices apart, `channels` per company and left out on a failure), `google-inbox.test.ts`
  (`channels` follows Google switched off / on, another company without Google),
  `client/tests/ui/my-switches.spec.ts` (no 受信を読む switch without mail / chat), `task-settings-core.test.ts` (the rule, older documents), `server-clock.test.ts`
  (the assignee's own decides), `slack-connector.test.ts`, `google-inbox.test.ts`,
  `google-one-consent.test.ts`, `client/tests/ai-turn-claims.test.ts`,
  `client/tests/work-switches-ipc.test.ts`.

## Business days and the reply 目安 (`shared/core`)

- `business-days.ts`: weekends + Japanese public holidays + company holidays are off.
  Public holidays are **calculated** from the current law (fixed dates, Happy Mondays, the
  equinox approximation valid 1980–2099, 国民の休日, 振替休日) — no network call and no yearly
  table. Year-specific changes by law (as for the 2020/2021 Olympics) go into `LAW_EXCEPTIONS`
  with a test row of the published list. `tests/unit/task-settings-core.test.ts` pins 2026–2030
  against the published lists.
- `replyTarget(receivedAt, settings.reply, holidayDates)` → `{ date, dueAt }`, in **Japan time**
  (UTC+9), not the server's zone: 翌営業日 = the first business day after the day it arrived;
  当日中 = that day when it arrived on a business day strictly before the cutoff (17:00 sharp is
  "after"), else the next business day. `dueAt` is the end of that day in Japan.

## Department membership (所属する部署, `GET|PUT …/departments/:id/members`)

- A new, explicit concept: who belongs to a department. One person may belong to several
  departments. Used for: which departments' task lists a person sees, the shared inbox being
  the department's turn, managers moving a leaver's tasks (S13) — and **who writes** in a
  department created since 2026-11-06 (owner decision): `POST /departments` gives its scope
  `everyone: read` + `department <id>: read + write` (rule subject `department`,
  `shared/core/permissions.ts`; `seedDepartmentMemberWriting`), so everyone reads, only the
  people who belong (plus owner/admin) write, and changing who belongs changes who writes.
  Nobody belongs at first, so until someone is added only owner/admin write there. Departments
  created before, and the company's default departments, keep their rules (none: they inherit
  `everyone: read + write`); nothing was migrated.
- `department_members` (behind the handle; a trigger refuses a row whose company is not its
  department's; `ON DELETE CASCADE` with the department). Any member reads; owner/admin and
  **that department's** managers replace the set (`{ userIds }`, members of the company only,
  ≤ 1000, `force?`). Check order: who → department exists → body. The change runs under the
  permission editor's outdated-app guard over the whole company (`guardWrite`, roots `['']`:
  a department rule may sit on any folder), so taking someone out of a department where only
  its people write answers 409 `OUTDATED_CLIENTS` while their app cannot recover from
  `[WRITE_DENIED]`; `force: true` is owner/admin only (a manager's → 403 `FORCE_NOT_ALLOWED`).
  A member removed from the company is removed from every department of it
  (`services/companies.ts` `removeMember`).
  Every change of who belongs (this route, an invitation's 所属, a member leaving) is recorded in
  `permission_history` (`department-members`; `server.md` "Groups and read-restricted places").
- Starts empty for every department: nobody belongs until an admin or manager says so.
- Absences (代わりの人, `records.md` "Absence and the delegate") are stored next to it
  (`member_absences`, same repository) and use it: a department's managers set the absences of
  the people who belong to it.

## Admin console

「詳しい設定 › 仕事の進め方」 `/companies/[id]/advanced/work` and 「会社の暦」 `/advanced/calendar` (owner/admin;
管理画面の見直し 2-3, `admin/src/components/advanced/task-settings-page.tsx`; the old `/task-list` redirects;
who belongs to a department — 所属, 不在と代わりの人 — is on 「部署」, for department managers too):
plain questions in Japanese, no builder words (型・プラグイン・つなぎ先). 仕事の進め方 opens with the
records switch 「記録とやることの一覧を使う」 (`records.md` "Off per company"). Owners/admins answer the
company questions (one save for all, with a sticky bar; 「人に頼んだとき、相手が「引き受ける」を押すまで待ちますか？」 is one
checkbox per automatic case; the reply card shows today's example
due date from `replyTarget`); everyone on the page sees who belongs to each department and gets
「所属する人を変える」 where the server says `canEdit`; there, each member also gets
「不在・代わりの人」 (their absences, the delegate, add / remove; `/absences` with `userId`). Managers set membership here rather than in
the desktop app: the admin console already serves managers (permissions, private folders), so it
was the smaller change. The card and the dialog say that in a new department only the people
who belong edit; a 409 `OUTDATED_CLIENTS` opens the outdated-app dialog (「それでも保存する」 for
owners/admins). Creating a department (「部署を追加」, `department-form-dialog.tsx`
`NEW_DEPARTMENT_ACCESS_TEXT`) says in one line who reads, who edits, that nobody belongs yet,
and that secrets go into a private folder inside the department; right after creating, the
page opens 「所属する人を変える」 for it. Tests: `admin/tests/task-list.test.tsx`,
`admin/tests/pages.test.tsx` (部署).

## Tests

`server/tests/integration/task-settings.test.ts` (roles, manager only in their own department,
cross-company, leaver), `department-member-writing.test.ts` (a new department: who belongs
writes, anyone else is refused at push and by `/me/write-access`, everyone reads; adding /
removing changes it behind the outdated-app guard; an older department is unchanged; another
company's department or membership never counts), `tests/unit/task-settings-core.test.ts` (holidays 2026–2030, every
`replyTarget` case), `tests/unit/company-data.test.ts` (handle isolation), permission-matrix rows
and `CROSS` rows for both member routes, admin contract.
