---
paths:
  - "shared/core/business-days.ts"
  - "shared/core/task-settings.ts"
  - "shared/types/task-settings.ts"
  - "server/src/services/task-settings.ts"
  - "server/src/routes/task-settings.ts"
  - "server/src/ports/task-settings.ts"
  - "server/src/adapters/sqlite/task-settings.ts"
  - "server/tests/integration/task-settings.test.ts"
  - "server/tests/unit/task-settings-core.test.ts"
  - "admin/src/app/companies/*/task-list/**"
  - "admin/src/lib/task-settings.ts"
  - "admin/src/components/departments/department-members-dialog.tsx"
  - "admin/tests/task-list.test.tsx"
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
- `autoRun` (自動で進める): `enabled` (default off), `dailyLimit` per member per day (default 30,
  1–500), `stopAfterFailures` in a row (default 3, 1–20). Sending and approving are always pressed
  by a person whatever this says (approvals.md, outbound-mail.md); the runner (S10) enforces the
  limits.
- `companyHolidays`: the company's own days off (`{ date: YYYY-MM-DD, name }`, ≤ 400, years
  2000–2100), stored sorted.

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

- A new, explicit concept: who belongs to a department, separate from folder permissions
  (departments get an `everyone: read + write` rule on creation, so "can write" cannot mean
  "belongs"). Belonging changes nobody's access. One person may belong to several departments.
  Used later for: which departments' task lists a person sees, the shared inbox being the
  department's turn, managers moving a leaver's tasks (S13).
- `department_members` (behind the handle; a trigger refuses a row whose company is not its
  department's; `ON DELETE CASCADE` with the department). Any member reads; owner/admin and
  **that department's** managers replace the set (`{ userIds }`, members of the company only,
  ≤ 1000). Check order: who → department exists → body. A member removed from the company is
  removed from every department of it (`services/companies.ts` `removeMember`).
- Starts empty for every department: nobody belongs until an admin or manager says so.

## Admin console

`/companies/[id]/task-list` (menu 「やることの一覧」, owner/admin and department managers):
plain questions in Japanese, no builder words (型・プラグイン・つなぎ先). Owners/admins answer the
company questions (one save for all, with a sticky bar; the reply card shows today's example
due date from `replyTarget`); everyone on the page sees who belongs to each department and gets
「所属する人を変える」 where the server says `canEdit`. Managers set membership here rather than in
the desktop app: the admin console already serves managers (permissions, private folders), so it
was the smaller change. Test: `admin/tests/task-list.test.tsx`.

## Tests

`server/tests/integration/task-settings.test.ts` (roles, manager only in their own department,
cross-company, leaver), `tests/unit/task-settings-core.test.ts` (holidays 2026–2030, every
`replyTarget` case), `tests/unit/company-data.test.ts` (handle isolation), permission-matrix rows
and `CROSS` rows for both member routes, admin contract.
