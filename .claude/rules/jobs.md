---
paths:
  - "shared/core/jobs.ts"
  - "shared/types/jobs.ts"
  - "server/src/**/jobs.ts"
  - "server/src/db/schema/jobs.ts"
  - "server/tests/**/jobs*.test.ts"
  - "server/src/services/job-occurrences.ts"
  - "shared/core/job-schedule.ts"
  - "server/tests/**/job-*.test.ts"
---

# Scheduled jobs (定期の仕事, B 「実行を記録から分ける」)

A job is work that is not a record's turn: 「毎週火曜の1営業日前の 09:00 に」. Design: the owner's memo
「実行を記録から分ける（B）設計メモ」 (2026-11-10, decisions D1–D10 as recommended). Job → occurrence (回)
→ run (`ai_runs`, `subject_kind: 'occurrence'`, `ai-turns.md`).

**PR 3a: definitions and approval. PR 3b: the clock makes occurrences and the server does a job's (e)
operation (a やること) — no AI, no claim, no app or admin screen.** Next: 4 (admin screen 「定期の仕事」,
the app's accept button), 5 (the PC's (a) claim and the grant at every call, design memo §4-2).

## Tables (`server/src/db/schema/jobs.ts`, handle `jobs`, `ports/jobs.ts`, `adapters/sqlite/jobs.ts`)

New tables only (additive; `CREATE … IF NOT EXISTS`, nothing else changes):

- `ai_jobs`: id `job.` + 32 hex (CHECK), name (the newest version's), `state` draft / active / paused /
  retired, `acting_user_id` (the newest version's responsible person), `latest_version`,
  `approved_version` + `approved_fingerprint` (both or neither), `accepted_version` +
  `accepted_consent`, `paused_reason` (`ADMIN`, `BY_RESPONSIBLE`, `OWNER_LEFT`, `OWNER_RIGHTS_CHANGED`) /
  `paused_by` / `paused_at`.
- `ai_job_versions`: **append-only** — `definition` (canonical JSON), `fingerprint` (sha256 of it),
  `consent_fingerprint`, `acting_user_id`, `schema`; triggers refuse any update of those
  (`ai_job_versions_append_only`) and set `approved_*` / `accepted_*` once. **The triggers block
  UPDATE only**: DELETE and `INSERT OR REPLACE` are not blocked (deleting a company must delete its
  rows, by cascade), so no code may use either on `ai_job_versions` — the adapter only INSERTs a new
  version and sets approved / accepted.
- `ai_job_occurrences`: id `occ.` + 32 hex (CHECK: never a record id's shape — `RECORD_ID_RE` has no
  `.` — so the kept `idx_ai_runs_open` on `record_id` never sees two kinds collide),
  `UNIQUE (company_id, job_id, due_slot)`, `time_zone`, `due_at`, `expires_at`, `state`
  (due / running / done / nothing / needs_person / skipped / expired / held), `run_id`, `outcome_code`.
  Written by the clock and the runner (3b, below).
- `ai_job_settings`: 「定期の仕事をすべて止める」 (`stopped`; no row = not stopped).

No feature switch in `shared/core/features.ts`: its rule is "every feature on by default", and a
job does nothing until an owner/admin creates, approves it and its responsible person accepts it (and
in 3a not even then). The company's stop switch is the off switch (D8).

## The definition (`shared/core/jobs.ts`, `parseJobDefinition`)

One strict parser for the server (and later the admin and the app): an unknown key at any level or an
unknown value is refused, problems are short codes (`trigger.at.BAD`), never the value. `schema: 1`
versions the shape (a later shape is `schema: 2`; stored versions are never re-read differently).

- `trigger` (company time, list shapes only — no cron, no expressions): `day` (+ `businessDaysOnly`),
  `week` (`weekday`, `businessDaysBefore` 0–5), `month` (`day` 1–28 | `last`, `ifHoliday`); `at` `HH:MM`
  on 5 minutes.
- `check`: `none` | `new_files` (`path`, one of the grant's read paths). **A procedure needs a check**
  (D6: the clock alone never runs the AI).
- `run`: `operation` `create_task` (`title`, `dueBusinessDays`) — placement `e`, takes no AI tools,
  routes or reads, `creates: ['task']`; or `procedure` — a company Skill pinned at the tree id the
  **server** read when the version was made (the caller's fingerprint is replaced) — placement `a`.
- `placement`: `e` | `a` only. `missed`: `latest_only` | `skip` + `expiresAfterMinutes` (5 min – 7 days).
- `grant` (memo §4-1): `tools` from `PLUGIN_STEP_TOOLS` minus `web_research` and `plugin_operations`
  (`JOB_GRANT_TOOLS`), `creates` (`task`), `routes` (names from `AI_ROUTES`, no conditions), `reads`
  (`paths`, `calls: []` — connector reads stay refused to runs), `writes` (`none` | `deliverable`
  `place` + `folder`), `outbound` (`none` | `draft_only`), `limits` (minutes 1–120, runs a day 1–24).
  Each power is named once where it is granted (`files_read` ⇔ read paths, `files_write` ⇔ deliverable,
  `outbound_draft` ⇔ `draft_only`, a procedure's `creates` needs `records`). Paths: company paths,
  never the root, `..`, `\`, `.personal` / `.backups` / `.workspace`.
- `jobConsentCanonical`: who (`actingUser`), `run`, `placement`, `grant` — what the responsible person
  accepts (D4). A name, trigger, check or missed policy change needs no new acceptance.

## API (`routes/jobs.ts` → `services/jobs.ts`, contract `shared/types/jobs.ts`)

```
GET  /jobs                          owner/admin: all (+ stopped, canManage); others: jobs they are responsible for
GET  /jobs/:jobId                   the same people, with every version (newest first)
POST /jobs { definition }           owner/admin → 201 (draft, version 1)
PUT  /jobs/:jobId { definition }    owner/admin → a new version (same definition: changed false); the approved one stays
POST /jobs/:jobId/approve { version, fingerprint? }     owner/admin
POST /me/jobs/:jobId/accept { version, fingerprint? }   the version's responsible person only, an approved version only
POST /jobs/:jobId/pause | resume    owner/admin; the responsible person their own (resume: only their own pause)
PUT  /jobs-stop { stopped }         owner/admin
```

- **Who** (D10): only owner/admin create, edit, approve, stop (403 `Only owners and admins can manage
  scheduled jobs`, before the body). A person the newest or the approved version names sees the job;
  for anyone else a job does not exist — the same 404 `JOB_NOT_FOUND` as a missing one or another
  company's (permission matrix rows + `CROSS`). **Control is the approved version's responsible person's
  only** (`controls`): someone named only in an unapproved draft sees it but cannot pause it (403
  `JOB_NOT_RESPONSIBLE`). A non-admin resumes only a pause they made themselves (`paused_by`), while
  still the approved version's responsible person (else 403 `JOB_PAUSED_BY_OTHER`); an owner/admin's
  pause replaces the responsible person's own. No delegate acts for them (D5).
- **Approval re-checks** (memo §4-3), inside the write's transaction: the responsible person is a member
  now (409 `JOB_OWNER_NOT_MEMBER`), reads every place the version names — read paths, the check's
  path, where deliverables go (`jobDefinitionPaths`; `recordReader(...).file`: rules and private
  folders) — and may **write** where the deliverables go (`writes.place`, `resolveAccess`); otherwise 409
  `JOB_GRANT_EXCEEDS`, naming no place. A pinned Skill is still the company's at that tree (409
  `JOB_SKILL_MISSING` / `JOB_SKILL_CHANGED`: make a new version). A `fingerprint` that is not the
  version's → 409 `JOB_VERSION_FINGERPRINT`. **Acceptance and every resume of an approved job run the
  same rights and Skill checks.**
- **A company without the shared folder** has no company Skill to pin yet: a procedure job is refused at
  creation and approval with 409 `JOB_SKILL_NOT_HERE` (plain Japanese, no folder instructions). Pinning a
  Skill from the Skill shelf comes later (like `STEP_SKILL_NOT_HERE`, `plugin-steps.md`).
- **Pinned**: approval stores the version and its fingerprint; a later `PUT` adds a version and changes
  neither. `waiting` says why it would not run: `PAUSED`, `COMPANY_STOPPED`, `NOT_APPROVED`, `NOT_ACCEPTED`
  (the approved version's consent ≠ the accepted one).
- **Names never leak**: a responsible person who is not owner/admin gets a version's `definition`,
  `fingerprint` and `consentFingerprint` as null when it names a place they cannot read now (a sha256 of a
  known shape would let them test guesses), and the job's name (the newest version's) as 「定期の仕事」
  (`HIDDEN_JOB_NAME`) unless they read every place the newest version names. A name typed by an admin
  that mentions a place no version names is not detected (owner/admin write it for that person).
- **Leaving / rights**: `companies.removeMember` (its transaction, `onMemberLeft`) pauses every job whose
  newest or approved version names them (`OWNER_LEFT`); `changeRole` (`onRoleChanged`) pauses a job whose
  approved version names a place the new role no longer reads (`OWNER_RIGHTS_CHANGED`). Each writes the
  notice `job_paused` (recordless, `notifications.md`) to every owner / admin and pushes the bare
  `notifications` signal to them (`noticesChanged`); its text is built when read and shown only while the
  reader is owner / admin. While the company's records are off the bell is not shown at all (`list`
  answers `available: false`), so there the pause is seen in the job list (`pausedReason`, PR 4's screen).
- **Not yet (PR 5)**: rights lost through a permission rule, a group, 所属 or a private folder's readers
  changing do **not** pause a job here; only leaving the company and a role change do. The run's own
  check at every call (memo §4-2) covers the rest.

## The clock (3b, `services/job-occurrences.ts` `makeOccurrences`, `shared/core/job-schedule.ts`)

The server clock (`notifications.md` "The server clock") runs it **first, for every company, records on
or off**, before any company's slower work, **with its own overlap guard, before the clock's shared
one** — a pass whose mail or calendar work still hangs never keeps a later run from making occurrences
and starting the runner. It reads no content and calls nothing outside.

- **Slots** (`job-schedule.ts`, pure): a trigger's slot dates in company time (`latestJobSlot`,
  `nextJobSlot`, `jobSlotDates`; business days from `business-days.ts` with the company's days off from
  the task settings, `previousBusinessDay`): `day` (+ business days only), `week` (the weekday moved
  `businessDaysBefore` business days earlier: 「火曜の1営業日前」 is the Friday before when Monday is a
  holiday), `month` (`last`, a day off kept or moved before / after — across a month or year end: the
  month before and the month after the window are always looked at, so 1 January moved back gives 31
  December on that day, not a month late). The
  slot text `YYYY-MM-DDTHH:MM` is the occurrence's identity; `companyTimeToUtc` gives `due_at`, and
  `expires_at` = `due_at` + `missed.expiresAfterMinutes`. The zone is `DEFAULT_COMPANY_TIME_ZONE` (one
  place in `composition.ts`), kept on the row.
- **Which jobs**: approved, `active` or `paused`, placement **`e` only** (a PC job's occurrences come with
  its claim, PR 5: until then nothing would take them and they would only expire). Only the **newest
  slot at or before now**, and never one before the approved version's `approved_at`.
- **Once**: `INSERT OR IGNORE` on `UNIQUE (company, job, due_slot)` — a second clock run, a restart or a
  second server write nothing more. Pinned: `job_version` = the approved version when made.
- **Its state, decided when made**: the job paused → `held` `JOB_PAUSED`; the company's stop →
  `held` `COMPANY_STOPPED`; the approved version not accepted → `held` `NOT_ACCEPTED` (held is never run,
  also not after resuming: 「再開しても動かさない」); past `expires_at` (the server was down) → `expired`
  (told); found more than `JOB_ON_TIME_MS` (10 min) late under `missed.policy: skip` → `skipped`
  `MISSED` (not told: the policy says so); else `due`. **Missed slots in between are never made**
  (`latest_only` = only the newest), and an older `due` one of the job becomes `skipped` `SUPERSEDED`.
- A `due` one whose `expires_at` passed (the runner never took it) → `expired`, told.
- Index `idx_ai_job_occurrences_due (company_id, state, due_at)` (additive): `held` / `done` rows pile up,
  one per job and slot; the clock and the runner look up only what is `due`.

## Held: a pause or the company's stop (3b)

「再開しても動かさない」 holds whatever happens between clock runs, in the pause's / stop's own transaction
(`JobServiceDeps.occurrenceHolds`, bound in `composition.ts` to `jobOccurrences.holdDue` /
`holdPassedSlot`):

- **When it begins** — `POST /jobs/:jobId/pause`, a pause the server makes (`OWNER_LEFT`,
  `OWNER_RIGHTS_CHANGED`), `PUT /jobs-stop { stopped: true }`: every occurrence of the job (of the company)
  still `due` becomes `held` (`JOB_PAUSED` / `COMPANY_STOPPED`).
- **When it ends** — a resume, `PUT /jobs-stop { stopped: false }` (only when it was on): the newest slot
  at or before now, if not made yet (no clock ran meanwhile), is written `held`, so the clock never makes
  it `due`. A slot from before the pause that no clock had reached yet is held too (the safe side).
- The runner's own stop / pause checks stay for a stop written without holding (a build before 3b,
  rolled back to and forward again).

## The runner (3b, `createJobRunner` + `runOccurrence`)

Started by the server clock right after the occurrences, **never awaited by it** (its own overlap
guard; a slow company's mail or calendar never holds an occurrence up); each company in turn,
`JOB_RUNNER_LIMIT` (50) per company and pass, **a yield after every occurrence** and after each company,
a company's failure logged (error name only). Each `due` occurrence, **in one transaction** (one of a
PC job — placement `a`, PR 5 — is left as it is, not tried):

1. still `due` (else nothing: another runner took it); past `expires_at` → `expired`, told;
2. the company's stop → `held` `COMPANY_STOPPED`; the job not `active` → `held` `JOB_PAUSED`; another
   version approved since it was made → `held` `JOB_VERSION_CHANGED` (D8; nothing made);
3. the pinned version's responsible person **re-checked like approval** (`jobs.runnerRefusal`: a member
   now, every place it names readable / writable) → else the job is paused (`OWNER_LEFT` /
   `OWNER_RIGHTS_CHANGED`, owners / admins told with 3a's `job_paused`) and the occurrence is `held`
   with that code (for a placement-`e` job of schema 1 only membership can fail: it names no place);
4. absent that day (an absence with `from ≤ the slot's date ≤ until`; one that begins later does not count)
   → `skipped` `OWNER_ABSENT`, told — **no delegate runs it** (D5);
5. the やること is checked first (`writer.check`): records off → `needs_person` `RECORDS_OFF`, any other
   refusal → `needs_person` `TASK_NOT_CREATED` (both told). 「使う機能」 does not stop it (`task` is the
   core's; with every feature off, it runs);
6. **the run**: an `ai_runs` row (`subject_kind: 'occurrence'`, subject id = the occurrence id, step
   `job-operation`, `user_id` = the responsible person, device `server`, generation 1), its events
   (`claimed`, then `finished` / `DONE`), the operation by its key `create_task` (`ai_run_operations`,
   ref the record); the やること through the service writer: id `task-<the occurrence's hex>`
   (`occurrenceTaskId`: one per occurrence by construction), **owner-only for the responsible person**
   (`personalOwner`: the job's words reach nobody else, owners / admins included), assignee and next
   actor them, `due` = `dueBusinessDays` business days after the slot's date, actor `JOB_ACTOR`
   (`acb:job`, kind `external`) with the run's id — 経緯 says cause `system` and `runId`; `quiet` (D9: no
   notice of success, the やること in 「あなたの番」 is it); then the run `done` and **closed**, the
   occurrence `done` with `run_id`.

All or nothing: a crash anywhere leaves the occurrence `due` and nothing made (no task, no run, no key);
the next pass does it once. A refusal by the writer after its check rolls back too and marks
`needs_person` `TASK_NOT_CREATED` in a second transaction. Exactly once rests on three things: the `due`
check, the compare-and-set to `done`, the task id from the occurrence — the last two each stop a second
やること by themselves, so the `due` check alone is not caught by a test (an early exit; see "Tests"). **A server run is opened and closed in one transaction, so no open occurrence run ever
exists** — and the record runs' paths never see one: `GET /ai-runs` lists record runs only (PR 2), a
claim naming an occurrence id is 400 (`recordId is a record id`), and the open-runs reads of a build
before `subject_kind` (PR 1) find nothing open.

**Rolling back** (to PR 3a or PR 2): nothing reads `ai_job_occurrences` there; the occurrence runs are
closed rows (an older `GET /ai-runs/:runId` would show one only to its responsible person, its
`recordId` the occurrence id, which no record has: `RECORD_ID_RE` has no `.`); the occurrence notices
are recordless rows of kinds that build does not know, which its bell drops (`isNotificationKind`).
Rolling forward again: a `due` one left behind expires (told) at the next clock run.

## Notices (3b)

`job_expired`, `job_skipped`, `job_failed` (`shared/types/notifications.ts`, recordless,
`JOB_OCCURRENCE_NOTIFICATION_KINDS`, on by default): to the responsible person (while a member) and the
job's creator (while an owner / admin), in the same transaction as the occurrence's change, then the
bare `notifications` push (both recipient checks are tested: a creator demoted to member and a
responsible person who left are not written to). Key `<kind>:<job>:<occurrence>` (once per occurrence and member). Text built
when read (`notifications.ts` `jobOccurrenceText`, through `jobs.occurrenceNotice`): shown only while
the reader may see the job (owner / admin, or its responsible person), its name 「定期の仕事」 when a
place the newest version names is not theirs to read. **No `subject_kind` column on `notifications`**:
a recordless notice with the job and occurrence in its key is enough while no notice is about a record
and a job at once (add it, additive, when one is). While the company's records are off the bell is not
shown at all (the occurrence's state says it: `GET /jobs/:jobId/occurrences`).

## Occurrences in the API (3b)

`GET /jobs/:jobId/occurrences` — the same people as `GET /jobs/:jobId` (anyone else, another company's
id: the same 404 `JOB_NOT_FOUND`; permission matrix row + `CROSS`): ≤ 100, newest slot first —
`JobOccurrenceView` (id, `jobVersion`, `dueSlot`, `timeZone`, `dueAt`, `expiresAt`, `state`,
`outcomeCode`, `ran`, `updatedAt`): slots, states and codes only, never a name, a place or the task.

## Tests (each guard mutation-checked, with the exceptions named)

3b's guards were each removed or inverted alone and the test file failed — except: the runner's early
"still `due`" exit (the compare-and-set and the task id each still stop a second やること), `latest_only`
(by construction: only the newest slot is ever computed, covered by "missed slots" but not a line to
remove), and `OWNER_RIGHTS_CHANGED` at run time (a placement-`e` job of schema 1 names no place, so only
membership can fail).

- `server/tests/unit/jobs-definition.test.ts` — strict parser (unknown keys / values at every level,
  tools and routes vocabulary, no connector reads, paths), what runs where, D6, the consent part, an
  occurrence id never a record id.
- `server/tests/unit/jobs-schema.test.ts` — on `tests/fixtures/app-schema-before-jobs.sql` (frozen):
  additive and idempotent, same as a new database; one occurrence per slot; id CHECKs; versions never
  rewritten, approved / accepted once.
- `server/tests/integration/jobs.test.ts` — who may do what; another company's job; append-only and
  pinned approval; acceptance by the responsible person only and only again when the consent changed;
  approval refused for a place the person cannot read (private folder, rule) or a person who left, and
  for a Skill missing or changed; the definition hidden from a member who cannot read it; removeMember
  and a demotion pause and tell owners/admins (and a demoted admin's bell drops it); pause / resume; the
  company stop.
- `server/tests/integration/job-occurrences.test.ts` (3b) — one occurrence per slot over two runs and a
  restart, none before its time or before approval; only the newest missed slot; expiry when made and
  when run (told to the responsible person and the creator, the bell's text, gone once they may not see
  the job); `skip` late → skipped; superseded; no PC-job occurrence; exactly one owner-only やること with
  its run, events, key and 経緯 (`acb:job`, `system`, `runId`), none on a second pass, all or nothing on a
  crash, `needs_person` on a refusal and with records off, still run with every feature off, no notice
  of success; held for the stop and the pause (when made, at run time — also a stop written without
  holding —, and with no clock run between pause / stop and resume, for a `due` one and for a slot that
  passed meanwhile; lifting a stop that was off holds nothing; a server pause holds too), not accepted,
  another version approved; the responsible person gone → paused + `job_paused`; absent → skipped + told,
  an absence beginning later not; recipients (demoted creator, departed responsible person); another
  company's occurrences untouched and 404; a company hung on pass 1 does not hold up another's on passes
  1–3; the jobs part never overlaps itself; the runner leaves a PC job's occurrence untried and yields
  after each occurrence; the record runs' paths see no occurrence run, which is closed; company time to UTC.
- `server/tests/unit/job-schedule.test.ts` (3b) — the slot's own minute, midnight, business days with
  holidays and company days off, 「火曜の1営業日前」 over a holiday Monday, five business days over the
  year end, `last` (February, a leap year), `ifHoliday` before / after across a month and a year —
  1 January moved back to 31 December found on that day (`latestJobSlot` at 12-31 09:05, `nextJobSlot`
  from 12-20).
- `permission-matrix.test.ts` rows + `CROSS`; `company-scoped-sql.test.ts` (`HANDLE_TABLES`).
