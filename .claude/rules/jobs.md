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
  - "shared/core/job-words.ts"
  - "admin/src/components/jobs/**"
  - "admin/src/lib/jobs.ts"
  - "admin/tests/jobs.test.tsx"
  - "client/electron/features/jobs/**"
  - "client/src/features/jobs/**"
  - "client/shared/jobs.ts"
  - "client/tests/jobs-ipc.test.ts"
  - "server/src/services/job-runs.ts"
  - "client/shared/ai-turn-steps/job.ts"
  - "client/electron/features/ai-turns/job-runs.ts"
  - "client/electron/features/ai-turns/job-report-tool.ts"
  - "client/tests/job-runs.test.ts"
  - "server/src/services/job-retry.ts"
---

# Scheduled jobs (定期の仕事, B 「実行を記録から分ける」)

A job is work that is not a record's turn: 「毎週火曜の1営業日前の 09:00 に」. Design: the owner's memo
「実行を記録から分ける（B）設計メモ」 (2026-11-10, decisions D1–D10 as recommended). Job → occurrence (回)
→ run (`ai_runs`, `subject_kind: 'occurrence'`, `ai-turns.md`).

**PR 3a: definitions and approval. PR 3b: the clock makes occurrences and the server does a job's (e)
operation (a やること) — no AI, no claim. PR 4: the screens (admin 「定期の仕事」, the app's 「受け取る」) and
the notice 「受け取りが要ります」. PR 5a: the PC's (a) claim and the grant at every call (design memo §4-2) on the
server, and a Skill pinned from the Skill shelf. PR 5a-2: the clock makes PC occurrences, the app runs them ("The app's
runner"), the meeting check ("The meeting check"), and the admin form makes PC jobs. PR 5a-3: a deliverable place
outside ("A deliverable place outside": a Drive folder the responsible person picks). PR 5b: 「もう一度」 ("「もう一度」"
below).**

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
  (due / running / done / nothing / needs_person / skipped / expired / held), `run_id`, `outcome_code`, and (5a-2, additive: `migrateJobOccurrenceCheckedUntil`) `checked_until` — where its check
  stopped looking, set once at the first claim (`moveOccurrence`'s `checkedUntil`, `COALESCE`: never moved), and
  `checked_commit` — the commit a `new_files` check in the shared folder looked up to (the app's, with that claim),
  and (5b, additive: `migrateJobOccurrenceRetries`) `retries` (0 = never), `retried_by`, `retried_at` — 「もう一度」.
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
- `check`: `none` | `new_files` (`path`, one of the grant's read paths) | `new_meetings` (`titleWords`, 0–5 words
  of ≤ 40, PR 5a-2: "The meeting check"; needs `JOB_MINUTES_ROUTE` in the grant's routes, `check.NEEDS_MINUTES_ROUTE`,
  so reading minutes is part of what the responsible person accepts, never of the check alone). **A procedure needs a
  check** (D6: the clock alone never runs the AI).
- `run`: `operation` `create_task` (`title`, `dueBusinessDays`) — placement `e`, takes no AI tools,
  routes or reads, `creates: ['task']`; or `procedure` — placement `a`, a Skill pinned by what the
  **server** read when the version was made (the caller's fingerprint and name are replaced): `company_skill`
  — the shared folder's `.claude/skills/<name>` at its tree id; `shelf_skill` (PR 5a) — a company without
  the shared folder: the Skill shelf's item `item` (its place) at its current version (sha256, 64 hex),
  `skill` its name then ("A Skill from the shelf" below).
- `placement`: `e` | `a` only. `missed`: `latest_only` | `skip` + `expiresAfterMinutes` (5 min – 7 days).
- `grant` (memo §4-1): `tools` from `PLUGIN_STEP_TOOLS` minus `web_research` and `plugin_operations`
  (`JOB_GRANT_TOOLS`), `creates` (`task`), `routes` (names from `AI_ROUTES`, no conditions), `reads`
  (`paths`, `calls: []` — connector reads stay refused to runs), `writes` (`none` | `deliverable`
  `place` + `folder`), `outbound` (`none` | `draft_only`), `limits` (minutes 1–120, runs a day 1–24), and optionally
  `deliverTo` (`{ connector, kind, ref: null }`, "A deliverable place outside"; absent = none, so a definition without it
  is byte for byte what it was — an older build's strict parser refuses one with it, so it never runs such a job).
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
- **A Skill from the shelf** (PR 5a, owner decision: companies without the shared folder must work too): in a
  company without the shared folder a procedure names `{ source: 'shelf_skill', item }` and the server fills
  `skill` and `fingerprint` from the shelf (`services/skill-shelf.ts` `jobSkill`, the shelf's own read check:
  the item exists, is a Skill, and **the responsible person reads its place** — else 409 `JOB_SKILL_MISSING`,
  the same answer as a Skill that is not there). A `company_skill` there, or a `shelf_skill` in a company with
  the folder, is 409 `JOB_SKILL_NOT_HERE` (each with its own plain sentence). Approval, acceptance and a
  resume check the item's current version is still the pinned one (`JOB_SKILL_CHANGED`, as for a tree), and
  the Skill's place counts among the places the version names (`readsAll`): one the person no longer reads
  hides the version's definition and the job's name from them and fails the rights check
  (`OWNER_RIGHTS_CHANGED`). The claim checks the pinned version is still stored (`pinnedSkillKept`; a newer
  current version does not matter: the pinned one runs); removed → 409 `JOB_SKILL_MISSING`. **Jobs only**:
  plugin steps keep `STEP_SKILL_NOT_HERE` (`plugin-steps.md`) — their Skill pin is a step setting per company
  (`plugin_step_skills`, a name on the shared branch), read by `readPluginProcedure` from a tree and by the
  app with `cat-file`; moving it to the shelf changes the admin's step-skill screen, the pin type every
  released app parses (`parseProcedurePin`) and the app's procedure reader, so it is its own PR on top of
  `jobSkill`. The app fetches the pinned version with `GET /skill-shelf/:itemId/versions/:version` (5a-2).
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
- **Rights lost elsewhere** (a permission rule, a group, 所属 or a private folder's readers changing) do not
  pause a job at the moment of the change (only leaving the company and a role change do, here). They are
  found **when they matter** (PR 5a): a PC job's claim and every call of its run's token re-check the
  responsible person's rights with the pinned version (`runnerRefusal`) and then pause the job
  (`OWNER_RIGHTS_CHANGED`, `job_paused` to owners / admins, as above) and hold the occurrence; the server's
  runner does the same for a placement-`e` job. `GET /me/job-turns` only leaves such a turn out (a read
  changes nothing).

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
- **Which jobs**: approved, `active` or `paused`, placement `e` and (since 5a-2, with the app that claims them)
  `a`. Only the **newest slot at or before now**, and never one before the approved version's `approved_at`. An
  unclaimed PC occurrence (the app closed, 自動で進める off) expires at `expires_at` and is told, as any other.
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
  still `due` becomes `held` (`JOB_PAUSED` / `COMPANY_STOPPED`) — and one a PC is **running** (PR 5a) too,
  its run ended in the same transaction (`endPcRun`: `waiting_person` with that code, no holder), so its
  token (fenced: 409 `RUN_SUPERSEDED`), renew and finish are refused at once and a resume or lifting the stop
  brings nothing back (the occurrence stays `held`; a 「もう一度」 of the ended run claims nothing).
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
PC job — placement `a` — is left as it is, not tried, and never takes a place in the batch: `dueIds` /
`runDue` read the company's waiting occurrences and keep the server's own, `serverDue`):

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
responsible person who left are not written to). Key `<kind>:<job>:<occurrence>` (once per occurrence and member; `…:<retries>` after a 「もう一度」, 5b). Text built
when read (`notifications.ts` `jobOccurrenceText`, through `jobs.occurrenceNotice`): shown only while
the reader may see the job (owner / admin, or its responsible person), its name 「定期の仕事」 when a
place the newest version names is not theirs to read. **No `subject_kind` column on `notifications`**:
a recordless notice with the job and occurrence in its key is enough while no notice is about a record
and a job at once (add it, additive, when one is). While the company's records are off the bell is not
shown at all (the occurrence's state says it: `GET /jobs/:jobId/occurrences`).

## The PC's claim (PR 5a, `services/job-runs.ts`, design memo §3-3 / §3-5 / §4-2)

The AI runs **only on the responsible person's PC**; the server lists, keeps the run and checks. The run is
the execution run of 「AI の番」 (`services/ai-runs.ts`, `ai-turns.md` "Execution runs on the server"): subject
kind `occurrence`, step `job-procedure` (`JOB_PC_STEP`), its resolver `createJobRuns(...).subjects` behind the
same port (`runSubjectsByKind` in `services/run-subjects.ts`). Generations, the lease and renew, fencing,
idempotency keys, failure places, reconcile and the emergency stop are the run core's, unchanged.

```
GET  /me/job-turns                                          the caller's PC-job occurrences to claim now (JobTurnView)
POST /job-run-claims { occurrenceId, deviceId, conversationId, checks }   → 201 { run, created, turn } (200 on a re-claim)
POST /ai-runs/:runId/renew | finish | retry | …/reconcile        as for any run; finish takes `jobResult` (below)
```

- **Whose turn** (the list leaves out, the claim refuses, in this order): an occurrence of a placement-`a`
  job whose version names **the caller** as responsible person — anyone else, an owner / admin included,
  another company's id, a server job's occurrence: the one 404 `JOB_NOT_FOUND`; `due`, or `running` with its
  run claimable again (the claim then answers the run core's `RUN_CLAIMED` / `RUN_WAITING` /
  `RUN_NEEDS_RECONCILE`), else 409 `JOB_TURN_GONE`; a `due` one not while an earlier occurrence of the job is `running`
  (`JOB_EARLIER_RUNNING`, 5b "Never side by side"); not past `expires_at` (`JOB_TURN_EXPIRED`); the
  company's jobs not stopped (`JOB_STOPPED`); the job `active` (`JOB_PAUSED`); the occurrence's version
  still the approved one (`JOB_VERSION_CHANGED`, the `due` occurrence held); its consent accepted
  (`JOB_NOT_ACCEPTED`); the responsible person's rights cover every place it names
  (`JOB_GRANT_EXCEEDS`: the job paused `OWNER_RIGHTS_CHANGED`, owners / admins told, the occurrence held);
  not absent that day (`JOB_OWNER_ABSENT`: skipped and told — D5, as the server's runner); a shelf Skill's
  pinned version still stored (`JOB_SKILL_MISSING`). **Before all of it** the emergency stop answers 503
  `AI_STOPPED` (`STOPS_UNATTENDED_RUN`): nothing is read or written. Right after "whose" (5a-2): **the app names
  the checks it runs** (`checks`, `JOB_PC_CHECK_KINDS`; carried to the resolver on the claim's subject,
  `RunSubject.checks`) and an occurrence whose check is not among them → 409 `JOB_CHECK_NOT_SUPPORTED`, nothing
  written — an app that cannot honour a check (an older one, or a later check kind) never runs it. The app's own
  refusals (main window, Claude Code, the stop policy confirmed by the server) are "The app's runner" below; the
  server's 503 holds whatever app calls.
- **The claim takes the occurrence** (`claimed`, in the claim's transaction): `due` → `running` with the run's
  id; a re-claim keeps it; anything else rolls the claim back. The run's procedure keeps `job: { id, version,
  fingerprint }` (`AiRunProcedure.job`); the claim's `turn` carries what the app runs: the check, `checkSince`
  (where the previous occurrence that ran — done / nothing — stopped looking, its `checked_until`, else its `dueAt`;
  else the approval), `checkUntil` (5a-2: this occurrence's own `dueAt`, or what its first claim fixed), the pinned
  procedure and the grant.
  Its places are the caller's to read (else it would not be theirs), its name follows `HIDDEN_JOB_NAME`.
- **The grant at every call** (`routeRefusal`, asked by the record-token guard for every route a token
  bound to such a run calls, **whatever build calls** — no released-app gate here): the run still holds a
  `running` occurrence, the job still runnable as above (stopped, paused, another version, not accepted →
  refused; the rights lost → refused, the job paused and told, the occurrence held), and the route within
  the pinned grant: `jobRunRouteAllowed` (`shared/core/jobs.ts`) — the turn start's reads
  (`AI_TURN_BASE_ROUTES`), else a route the grant names **and** within `JOB_RUN_ROUTE_CEILING` (the
  member's own record reads; mail drafts only with `outbound: draft_only`; since 5a-2 the minutes
  of a meeting its `new_meetings` check finds **at that call** — `jobRunRouteAllowed`'s `meetingFound`, the route's
  `recordId` among `meetingsFor`; the subject's `routeRefusal` now gets the route's parameters). **Never a create**: a grant may
  name `POST /item` (schema 1's shape, the memo's first job does), but the run's token is refused it; the one
  やること comes with the finish. Every refusal is 403 `NOT_IN_STEP`, naming nothing. A record token binds to
  such a run (`bindsTokens`); to a run of any other non-record kind (the server's own `job-operation`) still
  not.
- **The finish** (`finishing`, in the finish's transaction): `done` needs `jobResult` — `'nothing'` (the
  check found nothing: occurrence `nothing`, no やること) or `{ title, summary? }` (`parseJobRunResult`):
  **the one やること** — only when the grant `creates` `task` (else 400 `JOB_TASK_NOT_GRANTED`) — made by the
  service writer: id `occurrenceTaskId` (one per occurrence by construction), owner-only for the responsible
  person, assignee them, actor `JOB_ACTOR` with the run's id, quiet (D9), the run's operation key
  `create_task`; then the occurrence `done`. No `jobResult` → 400 `JOB_RESULT_REQUIRED` (the whole finish
  rolls back, the run stays running). The やること is checked by the writer **before** the finish
  (`beforeFinish`), as the server's runner does: refused → the run ended, the occurrence `needs_person`
  `RECORDS_OFF` / `TASK_NOT_CREATED`, told, and 409 `RECORDS_DISABLED` / `JOB_TASK_NOT_CREATED` — never left
  running (a refusal after that check is a race and rolls the finish back). The job checked again first: no
  longer runnable → nothing made, the occurrence held with the reason (the rights lost also pause it). A finish
  that sends the run to a person (`waiting_person` / `waiting_setup`) → `needs_person` `RUN_FAILED`, told
  (`job_failed`); a temporary failure or an unknown outside result leave it `running` — claimable again after
  its wait, or once reconciled, until it expires. A record run's finish with `jobResult` → 400.
- **Ending a run from outside its finish** (`endPcRun`, the deadline, a pause / stop, the clock's expiry, a
  task refusal): from `running`, `open` or `retry_later`; an outside operation still in flight becomes
  `unknown` first, as at a finish, and then the run waits for reconciliation (`waiting_reconcile`), else for a
  person (`waiting_person`) — either way with the code, no holder, its token fenced.
- **The approved minutes are a hard deadline** (`grant.limits.minutes`, `pcRunDeadlineMs`): the run's first
  claim (its creation — renewals and re-claims never move it) + those minutes. After it: every call of its
  token is refused, the finish answers 409 `JOB_TIME_LIMIT` and makes nothing, a re-claim (also after a
  temporary failure's wait) answers the same, and the turn is not listed; the first of these — or the clock,
  also while the app still renews its lease — ends the run (`endPcRun`, `TIME_LIMIT`) and makes the occurrence
  **`needs_person` `TIME_LIMIT`**, told (`job_failed`): a person looks at what an overrun run may have left
  (chosen over `expired`, which says nothing happened). The limit counts the whole occurrence, retries
  included.
- **The clock**, for a `running` occurrence, in this order: past the deadline → as above; its run waiting for
  a person to reconcile an outside operation and out of time (deadline or `expires_at`) → `needs_person`
  `RESULT_UNKNOWN`, told — the run stays `waiting_reconcile` for that person (an upper bound instead of a
  reconcile entry point for the app: `GET /ai-runs` lists record runs only; an owner / admin reconciles it on the
  occurrence, 5b "「もう一度」"); past `expires_at`
  with its run held by nobody (lease over, retried later, given back) → `expired`, told, the run ended. A run
  held within its deadline finishes as it will.
- A `needs_person` occurrence stays so even when its run is given back (a run-level 「もう一度」 claims nothing: the
  claim refuses an occurrence that is not `due` / `running`); only the occurrence's 「もう一度」 (5b, below) runs it again.

## A deliverable place outside (PR 5a-3, owner decisions 2026-11-11)

The first real job (面談報告書の下書き) leaves its draft as a Google document in the Drive folder where the mentor keeps
reports.

- **Connector + place, never one service's field** (decision 1): `grant.deliverTo = { connector, kind, ref }`, the
  kinds a built-in connector declares (`BUILTIN_CONNECTORS[…].deliveryPlaces`, `connector-roles.md`: Google's
  `drive_folder`, its words, routes, tools and one sentence for the run). The core names no service: `jobs.ts` reads the
  declaration (`jobDeliveryRoutes`, `jobDeliveryTools`, `jobDeliveryLabel`, `jobDeliveryHowTo`); the server asks the
  connector through `composition.ts` `deliveryPlaces` (`live`, `linkToTask`). `writes` stays the PC's deliverable
  folder: what goes outside is made there first (`grant.deliverTo.NEEDS_DELIVERABLE`). The ledger's `kind: 'drive'`
  file links are unchanged.
- **Who picks the folder** (`chosenBy: 'responsible'`): the responsible person, **when accepting**. Under `drive.file`
  the run's calls use their own grant, and Google lets that grant open only what *they* picked (or ACB made with it): a
  folder an admin picks in their own Picker would never open for the responsible person. So a definition's `ref` is
  always null (`grant.deliverTo.ref.CHOSEN_WHEN_ACCEPTING`), the admin form only offers 「できたものを外にも置く：Google
  Drive のフォルダ」, and `POST /me/jobs/:jobId/accept { version, fingerprint, place: { connector, kind, ref } }` carries
  the place: needed for such a version (409 `JOB_PLACE_NEEDED`), of its connector and kind (`parseJobAcceptedPlace`,
  else 400), the member's **own live pick** now (`places.live` → the Drive service's `folderPlace`: their folder pick
  within its 90 days — another member's pick, a file, an expired or unknown one → 409 `JOB_PLACE_NOT_USABLE`); a version
  naming none takes none (400). Kept on the job (`ai_jobs.accepted_place`, additive `migrateJobAcceptedPlace`); accepting
  again with another place replaces it. The place is part of the consent (`jobConsentCanonical` covers the grant), so a
  version that adds, removes or changes the kind asks for a new acceptance; the folder itself is the person's own choice.
  An owner/admin approving their own such job does **not** accept it with the same press (the admin console has no
  Picker): the dialog says to choose it in the app.
- **What the person sees**: `JobView.deliverTo` (`label`, `chosen`, `usable`; the folder's `name` and `expiresAt` only
  to the responsible person — a Drive folder's name is theirs, owners / admins see neither); the grant's words say
  「できたものを置く先：Google Drive のフォルダ（責任者が受け取るときに選ぶ1か所だけ…）」. The app's 「受け取る」 reads the job
  as the server answers it and, when it names a place, opens the connector's chooser first (`choosePlace`, composed in
  `main.ts`: Google Picker in folder mode, in the member's browser, `google-drive.md`), then sends the acceptance with it — cancelled, nothing is
  accepted. The app's 「定期の仕事」 shows the place line (`placeLine`) and, once it is not usable, 「置き先を選び直す」
  (`toAccept.why: 'place'`).
- **The run** (decision 2: the scope stays `drive.file`): the claim's turn carries `deliverTo` (with `ref`), the app's
  parser takes it only of the grant's own connector and kind. The route ceiling is widened narrowly: only a grant with a
  `deliverTo` reaches its connector's declared routes (`GET /google/drive/status`, `POST /google/drive/put`,
  `GET /google/drive/puts/:putId` — never a read, the file list or a pick), checked by `jobRunRouteAllowed` at every
  call; the app gives the run only `drive_picked` and `drive_put` (`jobToolAccess(…, deliverTo)`) and its first message
  says where (`jobDeliveryHowTo`). **The connector's route checks the folder at every call**: `routes/google-drive.ts`
  `jobScope` asks `jobRuns.deliveryPlace(member, runId)` (the run holds its occurrence, the job runnable as pinned, the
  accepted place) and the put refuses any other folder (403 `DRIVE_FOLDER_NOT_GRANTED`, nothing sent) — an update
  only of a file ACB made in that folder (`google-drive.md` "Overwriting"); the status shows only that folder and the
  files put there. Every other Drive check holds (a live pick, nobody outside the company sees the folder or the file).
  A body's `recordId` is never linked from a run. **Review of #678**: the app's `drive_put` in a job run reads a local
  file **only from the run's deliverable area** (`<place>/.personal/<folder>/`, by name and by real location —
  `LocalFileDeps.onlyUnder`, given by `recordToolProviders` from main's held run, `jobWriteArea`; no area — or a
  run-bound token whose area is not known (`runBound`) — → nothing; real paths compared exactly), so
  a prompt cannot send another company file out; a run updates **only files runs of the same job put**
  (`jobRuns.sameJob`, from each run's pinned `job.id`; 403 `DRIVE_FILE_NOT_THIS_JOB`) and its status lists only those;
  a receipt of another folder is not there for it (`GET /puts/:putId` → 404, Google not asked); the status selects the
  folder's picks and puts in SQL (never cut off by the member's other files).
- **The finish**: after a `done` finish (`afterDone`), what the run put (`googleDrive.runDeliverables`: its own receipts
  of that run, and a receipt it was answered with again — a repeat of an earlier put, nothing uploaded twice, named by the
  run's S10b operation `drive-put` — once per file, the receipt's facts) is linked to the occurrence's やること. A place
  that lapsed while the run worked does not stop its finish (the work is done; what was put is linked); the next
  occurrence goes to a person (`recordEngine.linkDrivePut`,
  as the AI with the run's id); a refusal (a company with the shared folder has no Drive links, records off…) is logged
  with its code and never fails anything. In a company with the shared folder the AI's `summary` carries the link.
- **The 90-day pick** (decision 3, decision for the owner): a folder pick is never renewed by itself while a job names
  it (that would keep ACB's permission alive with nobody looking). When the chosen place is not usable — past 90 days,
  or no longer the person's pick — the clock makes the slot's occurrence `needs_person` `PLACE_NOT_USABLE` at once, told
  (`job_failed`, `makeOccurrences`' `placeUsable`) — **once**: a slot after one that already said so is made
  `needs_person` without a second notice — and a claim finding it so does the same (409 `JOB_PLACE_NOT_USABLE`; a
  running one's run is ended). No warning before the 90 days end (not built: the app's place line shows the date). The
  words of how long a place lasts are the connector's (`lapseNote`); the core's say only 「使える期間が過ぎたか、消されました」.
  An app that cannot choose a place (before 5a-3) never runs such a job (its parser refuses the turn); the acceptance
  notice and `JOB_PLACE_NEEDED` say the app must be updated. The person picks the folder again with 「受け取る」 (a re-pick renews the pick) and the
  next occurrence runs. The list (`GET /me/job-turns`) leaves such an occurrence out.

## The meeting check (PR 5a-2, owner decision: option A — the 面談 are recorded in Google Meet)

- **What it finds** (`job-runs.ts` `meetingWindow`, `minutes.attendedSince`): `meeting` records (`minutes.md`) whose
  **people-only** list names the responsible person (`listedRecordIds` — never through a group or department: someone
  who reads through one did not attend), that they read now (`recordReader`) and attended (`isAttendee`), **recorded**
  in [`checkSince`, `checkUntil`) — a meeting is recorded once its minutes exist, so one whose minutes come late falls
  in the next occurrence's window instead of being missed — and held before `checkUntil`, and, when the check names
  words, whose title holds one (NFKC, case-folded; filtered before any limit). Oldest arrival first, at most
  `JOB_MEETINGS_PER_RUN` (10): with more, the window ends at the first one left over (`checked_until`), so the next
  occurrence takes the rest — none dropped, none taken twice. Nothing while the records or 「会議と議事録」 are off.
- **The window ends at the occurrence's own `dueAt`** (`checkUntil`): an app opened two hours after the slot does not
  take what the next occurrence will look at. `checked_until` is fixed at the first claim, and the next occurrence's
  check starts there (`checkSince`).
- **Only in the claim's answer** (`JobTurnView.meetings`, `turnOf`): the list (`GET /me/job-turns`) never carries
  titles. Empty → the app finishes `nothing` without the AI.
- **The run reads those minutes only**: `GET /minutes/:recordId/text` (`JOB_MINUTES_ROUTE`) only when the grant
  names it **and** the meeting is among what the check finds at that call; any other meeting (not hers, before the
  previous occurrence, another title, not held yet) and every other minutes route (`…/bundle`) → 403 `NOT_IN_STEP`.
  The text route keeps its own rules on top (the reader's own Google, `MINUTES_NOT_YOURS`): the job widens nothing a
  person could not do. Meeting titles are outside text: the app quotes them with `outsideTitle`.

## The app's runner (PR 5a-2, `client/shared/ai-turn-steps/job.ts`, `client/electron/features/ai-turns/job-runs.ts`)

The record AI turns' machinery, not a copy (`ai-turns.md`): the same runner (`useAiTurnRunner`, main window only,
「自動で進める」 on, the stop policy confirmed, Claude Code, one at a time, the daily limit), the same hidden
consultation, claim / hold / renew / finish (`claims.ts`), the same unattended Claude options.

- **Queue**: `useJobTurns` (`src/features/jobs/hooks/`) reads `aiTurns:jobTurns` (main: `GET /me/job-turns`,
  parsed through the one definition parser, `parseJobTurns`; remembered for the claim) on mount and every minute;
  AppShell passes them to `aiTurnQueue` (`jobs`) as candidates `{ id: <occurrence id>, job: true, notUrgent: true }`
  — never handed to the person for their slot's time. A record's step is never chosen for an occurrence id.
- **Claim** (`claims.ts` → `job-runs.ts`): main's refusals first, with no server call (`not-allowed`): main window,
  the emergency stop, an agent without `recordActions`, the stop policy not confirmed, the member's 「自動で進める」 off
  (read now; a job has no person who asked). For `new_files` in the shared folder, **before the claim**
  (`gitCheckPoint`): this PC must have what the server has — fetched since `checkUntil` (`FETCH_HEAD`'s time) **and**
  the server's tip (`@{upstream}`, else `FETCH_HEAD`) in `HEAD` (`merge-base --is-ancestor`: a fetch-only path or a
  sync stopped on a conflict leaves it out) — else nothing is claimed and it is asked again after `NOT_SYNCED_RETRY_MS`
  (30 s; `retryAfterMs` on the answer), never `nothing` on a guess. **Not a start** (`ai-turns.md`): it does not use
  up the runner's pass, and its hidden consultation, which never ran, is deleted. Then `POST /job-run-claims` with `checks` and `checkedCommit` (this PC's `HEAD` in the place's repository;
  the server keeps it on the occurrence, `checked_commit`, once — a re-claim looks up to the same); then **the check,
  before any AI** (D6): `new_files` — in the shared folder, files added in `sinceCommit..checkedCommit`
  (`newFilesByGit`: `log --diff-filter=A`, by what is reachable, **never by commit dates** — an old-dated commit that
  reaches the server late is still new; `sinceCommit` is the previous occurrence's commit; unknown here or none — the
  first occurrence, a build before it — the dates after `checkSince` decide), in the innermost repository (a private
  folder's clone, found from the place's on-disk spelling); a commit not on this PC → `temporary` `NOT_SYNCED`. In a
  working folder (no git): by modification time in [`checkSince`, `checkUntil`) (`newFilesByTime`). **The place is
  followed only when no link is on the way** (`placeOnDisk`: its real location is exactly the place inside the company
  folder's real location, compared as the disk folds names, `diskKey`) — a link committed at the place or above it
  never lists another folder's files or uses another repository. A place not on this PC (not downloaded, a link) →
  `bad-input` `CHECK_NOT_POSSIBLE` (a person looks);
  `new_meetings` — the claim's `meetings`. **Nothing found → the run is finished `done` with `jobResult: 'nothing'`**
  and no message is sent (the tab closes before anything). Then the pinned procedure: a company Skill's `SKILL.md` from
  the pinned tree (`readProcedure`, no lazy fetch), a shelf Skill fetched at the pinned version and checked against it
  (`verifyShelfContent`); not here → `temporary` `PROCEDURE_NOT_HERE` (tried later). The first message
  (`jobFirstMessage`): what was found, the procedure, the places, no shell, the time it must end by, and to end with
  `job_report`.
- **Only while the run is this app's**: a run taken away while the check or the procedure was read starts nothing
  (claimed: false); the ceiling (`jobTools`) is answered only while the run is still held (registered, not lost), so
  the chat server refuses a turn of a job consultation without one (400 `AI_TURN_NOT_SUPPORTED`); and its record token
  is asked only with the run (`openTurn`'s `requireRun`: no run registered → no token at all), a turn with no record
  tools being refused the same way — it never runs as an ordinary consultation with an ordinary token.
- **Only the grant's tools** (`jobToolAccess`, asked by the chat server as `pluginStepTools(conversation,
  'job-procedure')`): record tools whose route the grant names within the server's ceiling (`jobRunRouteAllowed`;
  `records_create` never), `minutes_read` only with the meeting check, mail drafts only with `outbound_draft`,
  `job_report` always; Claude Code's file tools only for `files_read` / `files_write`.
- **Writes and reads** (`jobWriteArea` → the write guard, `chat-write-guard.md`): writes only under
  `<place>/.personal/<folder>/` of the grant (`insideDeliverableAt`), or nowhere (`NOWHERE_TO_WRITE_MESSAGE`); Claude
  Code's reads (Read, Glob, Grep) only inside the grant's read paths or that area, as written and as resolved
  (`readArea`, `checkReadArea`; Glob / Grep must name a `path`, a Glob pattern may not climb out).
- **The one やること**: `job_report { title, summary? }` (`job-report-tool.ts`, a record-tool provider made only for a
  consultation main holds a job run for) **finishes the run right there** with it as `jobResult`, so the tool's answer
  is the server's: 「やることを作りました」, or — the run taken away meanwhile (a pause, the stop, its time; staging
  2026-11-11: the AI said it had made one after a pause) — an error the consultation shows on the tool's row
  (`JOB_REPORT_REFUSED` 「仕事が止められていたか、時間が来ていたため、やることは作られませんでした。…」), so the AI never
  claims it. Asked again, the same answer; nothing is finished twice; settle then only reports the outcome. No report
  → `temporary` `UNFINISHED` (the server retries, then a person); the AI never reports `nothing` (only the check
  decides that).
- **Time and the server**: main stops the AI `JOB_STOP_BEFORE_MS` (1 min) before the approved minutes from the run's
  first claim (`run.createdAt`, on the server's clock: shifted by the difference between the claim's `updatedAt` and
  this PC's time) end — not started at all with less left —, through the chat turns' `abort` with
  reason `job-ended` (the reply says 「※ 定期の仕事の時間が来たか、仕事が止められたため、AI を止めました。」); settle then
  finishes `bad-input` `TIME_LIMIT` (→ `needs_person` `RUN_FAILED`, told). A renew answered 409 (a pause, the
  company's stop, the deadline, another PC) stops the AI the same way and settle gives the run back (`RUN_LOST`; the
  server already ended it). A refused finish leaves the consultation open (outcome `failed`).
- **Closing the consultation** (`ai-turns.md`, #674): done → closed when nothing of the member's is there; a
  failure, a stop or the time limit keep it open (listed by the job's name; ending its やること does not close it —
  the automatic consultations are remembered by the occurrence's id, which no record has).
- **Beside the records' turns, never at their cost** (`aiTurns.ts`): jobs are ordered after records (their slot is
  in the past by nature), do not count toward nor wait for the records' daily limit (`recordStarted(…, job)`), and
  their failures are the server's to place — no hand-off, not one of the records' failures in a row
  (`jobOutcome`); Claude's usage limit still pauses everything. Each occurrence is tried at most twice a day on this PC
  (`MAX_ATTEMPTS_PER_RECORD`) — per press of 「もう一度」 (`attemptKey`, 5b). A claim that wins after the runner gave up waiting (`START_TIMEOUT_MS`) is settled at
  once (records too), instead of a run held with no AI.
- **Not enforced (decision)**: `grant.limits.runsPerDay` (one occurrence per slot; a retried run is the same one).
- **Known limit (decision)**: a member invited to a meeting **after** its record was made (「招待する」, or the calendar
  adding them later) is never found by a later meeting check — the window counts when the record was made.
- **An unknown outside result** (`RESULT_UNKNOWN`, decision for the owner): a job's run reaches outside only by a
  mail **draft** (`outbound: draft_only`), so an unknown result means "a draft may or may not have been made". No
  screen is added: the occurrence's state and the bell's `job_failed` tell the responsible person and the job's
  creator; the person looks at 送るもの (the drafts) themselves, and an owner / admin records what they found on the
  occurrence (5b, "「もう一度」": 作られていた／作られていなかった) before pressing 「もう一度」.

## Occurrences in the API (3b)

`GET /jobs/:jobId/occurrences` — the same people as `GET /jobs/:jobId` (anyone else, another company's
id: the same 404 `JOB_NOT_FOUND`; permission matrix row + `CROSS`): ≤ 100, newest slot first —
`JobOccurrenceView` (id, `jobVersion`, `dueSlot`, `timeZone`, `dueAt`, `expiresAt`, `state`,
`outcomeCode`, `ran`, `updatedAt`): slots, states and codes only, never a name, a place or the task.

## The screens (PR 4)

Everything below only shows and asks; the API above decides. The words are one copy,
`shared/core/job-words.ts` (trigger, what runs, the grant line by line, the missed policy, where it runs,
pause reasons, `waiting`, each occurrence state and outcome code, a slot) — the person accepting reads the
sentences the admin approved.

- **What a view adds** (additive, absent from an older server): `trigger` + `placement` (the approved
  version's, else the newest's — a trigger names no place, so it is answered whenever the job is, also
  with `definition` hidden), `nextSlot` (`nextJobSlot` of the approved trigger in company time with the
  clock's zone and days off, `JobServiceDeps.timeZoneOf` / `holidaysOf`; null when nothing is approved or
  it is retired; a paused or stopped job still answers it — the screen says it would not run),
  `lastOccurrence` (slot, state, code); `approved` (`responsibleUserId`, and `name` — 「定期の仕事」 for a
  non-admin who cannot read every place that version **or the newest** names: never more than the job's
  own `name` and the bell show), `latestConsentAccepted` (the newest
  version's consent is the accepted one: approving it runs without a new 受け取る — the screens never
  re-derive this), `you` (`named` / `controls` / `mustAccept`: the caller by the API's own rules, answered
  also while a version's `definition` is hidden). Ids, booleans and names only, never a place. No new endpoint.
- **Admin console 「定期の仕事」** (`/companies/:id/jobs`, menu item for owners / admins after つなぎ先;
  `admin/src/components/jobs/`): the list (name, 責任者, いつ, a badge and `jobWaitingText` — paused with
  its reason, 承認待ち, 受け取り待ち, すべて止めています —, a newer version waiting for approval, for placement `a` that it
  needs the responsible person's app (5a-2), 次の回, 前の回), 作る / 直す, 承認する, 止める / 再開する, 回の記録 (≤ 100,
  `jobOccurrenceText`), and 「すべて止める」 (asks first) / 「動かせるようにする」. Anyone else: the page says it
  is for owners and admins and reads nothing.
  - **The form** (`admin/src/lib/jobs.ts`) makes the server's operation — placement `e`, check `none`,
    `create_task`, a grant with no tools, routes, reads, writes or outbound — or (PR 5a-2, 「すること」 → 「Skill を
    責任者の PC の AI で動かす」, `pc-job-fields.tsx`) a PC job: a company Skill by its folder name, or in a company
    without the shared folder a Skill of the shelf (`GET /skill-shelf`; the server pins the version and the name), the
    check (`new_files` with its place / `new_meetings` with words), other read places, 「やることや記録を読む」 (the
    record read routes), 「メールの下書きを作る」 (`outbound_draft` + its routes), the deliverable place and folder, the
    minutes per run; `records` and `creates: ['task']` always (the one やること), the meeting check adds
    `JOB_MINUTES_ROUTE`. It runs the shared parser before sending (`definitionFromForm`; problems as plain sentences,
    never values). Editing the server's operation keeps the version's `limits` (the form does not offer them), so a
    name / time / due / missed change keeps the consent and needs no new acceptance.
  - **The list's 責任者** is who it runs as now (`approved.responsibleUserId`); a newer draft naming someone
    else says 「次の版では責任者が…さんになります（未承認）」. Whether it runs is `jobRunsText` (a PC job: 「動いています
    （責任者のアプリが開いていて「自動で進める」が入っているときに動きます）」, badge 「PC で動きます」).
  - **Approval** shows the newest version's words and sends its `fingerprint` (the server refuses another).
    It says whether the responsible person must accept again from `latestConsentAccepted`, and its message
    afterwards comes from the answer (`approvedText`: 受け取り待ち, or what `jobRunsText` says now). **Approving one's own job also accepts it** in the approver's own
    name (`POST /me/jobs/:jobId/accept` with the same version and fingerprint; the dialog says so before
    the press) — the server would not tell them (below).
- **The app** — Settings → 仕事 → 「定期の仕事」 (`client/src/features/jobs/`, IPC `jobs:mine` / `accept` /
  `pause` / `resume`, `client/electron/features/jobs/ipc.ts`, with the member's session): `jobs:mine` reads
  `GET /jobs` and keeps, **first**, the jobs the server says are the member's (`you`: named, controls or
  must accept — never re-derived from a definition, which may be hidden; an owner / admin's list holds every
  job, so filtering comes before any cap), then reads the detail only of those waiting for their
  「受け取る」 (≤ 50). The heading is the approved version's name (`approved.name`, the server's hiding rule).
  It shows what it will do, on whose rights (theirs), where, the grant's lines and the missed policy; a
  version whose definition is hidden says it cannot be shown (the server would refuse the acceptance too).
  受け取る sends the version and fingerprint shown; its message is chosen from the job as re-read
  (`client/src/features/jobs/model.ts` `acceptedText`: 「次の回から動きます」 only when it now runs — not paused or
  stopped; a PC job 「次の回から、このアプリが開いていて「自動で進める」が入っているときに動きます」). 止める for a job they run, 再開する for their own pause (`BY_RESPONSIBLE`; the server
  checks it was theirs). Renderer values never change the server path (`isJobId`, `sha256:<hex>`). A server
  that answers jobs without `you` (before PR 4) is said as such (`SERVER_TOO_OLD`, 「サーバーの更新が必要です」),
  never as 「ありません」. In the
  bell (`jobNoticeTarget`, `client/shared/jobs.ts`): `job_accept_needed` opens this section; an occurrence's
  notice and `job_paused` open nothing (they also reach the creator / admins, who have nothing here).

## The acceptance notice (PR 4)

`job_accept_needed` (「定期の仕事「…」の責任者になりました。内容を確かめて「受け取る」を押してください（受け取るまで動きません）」,
or, when they had accepted an earlier version as its responsible person, 「あなたが責任者の定期の仕事「…」の内容が
変わりました。確かめて「受け取る」を押してください…」; recordless, on by default): written in the approval's transaction to the approved version's responsible
person when its consent is not the one accepted — **never the approver themself** — key
`job_accept_needed:<job>:<version>` (once per version), then the bare `notifications` push to them. Built
when read (`jobs.acceptNotice`): shown only while that version is still the approved one, the reader is
its responsible person and has not accepted it, the job not retired — so an old ask (accepted, handed to
someone else, a newer version approved) is not shown. Its name follows `HIDDEN_JOB_NAME` (the newest
version names a place they cannot read → 「定期の仕事」).

## 「もう一度」 (PR 5b, `services/job-retry.ts`, owner decisions 2026-11-12)

```
POST /jobs/:jobId/occurrences/:occurrenceId/retry                          owner/admin → { occurrence: JobOccurrenceView }
POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile { done }   owner/admin → { occurrenceId }
```

- **On the occurrence, not the run** (unlike `POST /ai-runs/:runId/retry`, the run's own member's): an occurrence may
  have no run (expired unclaimed, a server job's refusal), the press acts on the occurrence (its deadline, its one
  やること), and the person pressing is not the run's. **Who**: owner / admin only — the responsible person who is a
  member, a 部署の管理役, anyone else: 403 `JOBS_FORBIDDEN` before anything is read (permission matrix rows); another
  job's or company's occurrence, or none: the one 404 `JOB_NOT_FOUND` (`CROSS`).
- **When** (`blockOf`, one order for the view and the press; 409 with the code and `jobRetryBlockText`): the state
  `needs_person` / `expired` (`JOB_RETRY_STATES`; never `skipped` — an absence or a newer occurrence decided it —, `held`,
  or one that ran: `NOT_RETRYABLE`); pressed fewer than `JOB_RETRY_MAX` (3) times (`RETRY_LIMIT`, decision for the
  owner: each press gives a fresh run with its own approved minutes, so the cap bounds what one slot can cost;
  `runsPerDay` stays not enforced); **the job's newest occurrence, and no later slot arrived** (`NOT_LATEST`, also when
  the clock has not made the later slot's occurrence yet — `slotsOf().latest`, the clock's own `latestJobSlot`: a later
  one's check starts where the last one that ran stopped, so it covers this window — running it again would hand the
  same files or meetings to a second run); **time for a whole run before the next slot** (`NEXT_SLOT_SOON`
  「次の回が近いため、もう一度はできません」: the new deadline below would leave less than `JOB_RETRY_MIN_CLAIM_MINUTES` (5) to
  claim it); the version still the approved one (`JOB_VERSION_CHANGED`); the company's jobs not stopped (`JOB_STOPPED`), the job `active` (`JOB_PAUSED`), the approved consent accepted (`JOB_NOT_ACCEPTED`), the
  responsible person's rights now (`runnerRefusal` → `JOB_GRANT_EXCEEDS`; nothing is paused here, the claim finds it
  as always), for a PC job the emergency stop covering them (`unattendedRunStopped`, the claim's own check →
  `AI_STOPPED`; a server job runs no AI), a shelf Skill's pinned version kept (`JOB_SKILL_MISSING`), the chosen place
  outside usable (`JOB_PLACE_NOT_USABLE`), and **no outside operation of its run whose result nobody knows**
  (`JOB_RESULT_UNKNOWN`: 結果が分からないうちは再開しない). Both state checks (here and the write's compare-and-set) stop
  a wrong state alone, so removing one is not caught by a test.
- **The press** (one transaction, read and checked inside it): its previous run (if any) is **closed** — `done`,
  event `finished` `RETRIED`, its tokens fenced and its own 「もう一度」 `RUN_DONE` — so the next claim makes a **new
  run**: its hard deadline (`pcRunDeadlineMs`) counts from that claim (a person's press is a fresh chance; the old
  "retries included" holds for the run's own retries). The occurrence `due`, no run, no outcome, **`expires_at` = the earlier of now
  + the pinned `missed.expiresAfterMinutes` and the job's next slot − the approved `limits.minutes`**
  (`jobRetryExpiresAt`; `slotsOf().nextAt` from composition, the clock's zone and days off): a run claimed by that
  deadline ends by the next slot — its approved minutes are a hard limit from its claim. `due_at`, the slot and
  `checked_until` / `checked_commit` stay, so it looks at the same window; `retries` + 1, `retried_by` / `retried_at`
  (who pressed it, as `approved_by` / `paused_by` keep theirs).
  Then the server's runner (placement `e`) or the responsible person's app (`GET /me/job-turns` → `POST
  /job-run-claims`, every claim check again — an absence that day still skips it) takes it; the やること is still
  `occurrenceTaskId` (one per occurrence). Nobody is told of the press (the app polls its turns every minute).
- **Never side by side** (enforced at the claim, for every occurrence, not only a pressed one): a `due` occurrence of a
  job is not claimable while an earlier occurrence of the same job is `running` (409 `JOB_EARLIER_RUNNING`
  「前の回がまだ動いているため…」, nothing written; `GET /me/job-turns` leaves it out) — the earlier one ends within its hard
  deadline (the clock ends it after), and the later one's check then starts where it stopped. This also closes the
  older case of a run whose app held its lease past the next slot. A later occurrence the clock makes while an earlier
  one is only `due` supersedes it, as before (`latest_only`). A later occurrence waiting behind a running earlier one can
  expire while it waits: safe — the responsible person and the creator are told (`job_expired`), and it is the job's
  newest occurrence, so an owner / admin can press 「もう一度」 on it. The app treats `JOB_EARLIER_RUNNING` as "try later"
  (`EARLIER_RUNNING_RETRY_MS`, 1 minute), never as taken.
- **What earlier runs made** (`madeBefore`, `job-retry.ts`): the outside operations of the occurrence's earlier runs
  (`ai_runs` of that subject, closed ones too: `AiRunRepository.runsOf`) that are known `done` — answered, or reconciled
  as done (作られていた) — one per thing made (a draft's later versions are the same draft). A new run starts with an
  empty operation table, so nothing stops it making them again: the owner / admin's view counts them by kind
  (`madeBefore: [{ kind, count }]`, no id, title or place — they are the responsible person's own, an owner-only draft, a
  file in their picked folder) and the confirmation says 「前回すでにメールの下書きを1件作っています。もう一度すると、また作られる
  ことがあります。」 (`jobMadeBeforeText`); the next run's turn carries them with their ids (`JobTurnView.madeBefore`, the
  responsible person's own things; the first `JOB_MADE_BEFORE_LISTED` (20), with `madeBeforeTotal` when there are more)
  and its first message says 「前回すでに次のものを作りました（同じものをもう一つ作らないでください…）」 (`jobFirstMessage`, 「（ほか
  N 件）」 for the rest; the app takes ids only, `SHORT_ID`, and trims a longer list instead of dropping the turn).
- **A file it made in the place, resolvable** (follow-up of #679, staging 2026-11-12: the turn named only ACB's put id
  `drive-put-…`, which `drive_picked` does not show, so a Skill that said "update the report" could not find it):
  in the responsible person's turn only (`job-runs.ts` `madeBeforeOf`), a made thing that is a file in the job's
  chosen place carries `file: { id, name }` — resolved by the place's connector (`JobRunDeps.places.madeFile`,
  composed in `deliveryPlaces.madeFile` → `googleDrive.madeFile`): the member's own **done** receipt, **written by one
  of this occurrence's runs** (`runsOf`: a consultation's receipt a run was answered with again — the same request — is
  not the job's file, and its update would be refused `DRIVE_FILE_NOT_THIS_JOB`), whose **receipt folder is the place
  chosen now** (the folder the receipt records, compared with the accepted place; Google is not asked where the file is
  in Drive today — the put route checks that when it updates), with a Drive file id → that file id (what `updateFileId`
  takes) and the name it was put with; else no `file`. Two puts of one file (made, then updated) are one entry, so
  they count once against `JOB_MADE_BEFORE_LISTED` / `madeBeforeTotal`. The owner /
  admin view is unchanged (`viewOf`: kinds and counts — never a file id, a name, a folder or a receipt id). The app
  takes `file` only on a turn with a place (the id checked by the place kind's own rule, `jobDeliveryFileId` → the connector's `isFileId`, Drive: `isDriveId`;
  name ≤ 500; a malformed one is left out, never
  the turn), lists it as 「Google Drive に置くファイル 「<name>」（fileId: …）」 (the name through `outsideTitle` with
  `OUTSIDE_TITLE_NOTE`) and then says the connector's `howToUpdateMadeBefore` (`jobDeliveryUpdateHowTo`,
  `builtin-connectors.ts`): when the procedure says to update, pass that fileId as `updateFileId` instead of making a
  new file; a refused overwrite (changed in Drive, …) → put a new file and say so in the summary. Every Drive guard
  stays the put route's: the chosen folder only (`DRIVE_FOLDER_NOT_GRANTED`), files of the same job only
  (`DRIVE_FILE_NOT_THIS_JOB`), `DRIVE_FILE_CHANGED_SINCE`, `DRIVE_FILE_NOT_VERIFIABLE` (a Google document whose state since its put
  cannot be proven — e.g. every document put before that rule: the first run after it writes a new file), `keepForever` /
  `DRIVE_FILE_FIXED` (`google-drive.md`).
- **Reconcile** (`reconcile`): only on a `needs_person` / `expired` occurrence (else 409 `NOT_RETRYABLE`), the body
  `{ done: boolean }` (400), an operation of its PC run whose result is unknown (else 404 `OPERATION_NOT_FOUND`; one
  still marked in flight on a run that no longer runs is made `unknown` first, as a finish does — never stuck); the
  run core's reconciliation (`aiRuns.reconcileFor`, shared with `reconcile`: `reconciled_by` = the owner / admin, a run
  `waiting_reconcile` with nothing unknown left → `open`). The admin console asks them to have the responsible person
  look first (an owner / admin cannot see the person's drafts). The in-flight mark and the answer are one transaction.
- **The view** (`GET /jobs/:jobId/occurrences`, owners / admins only, `JobServiceDeps.occurrenceRetry` → `viewOf`):
  `retries`, `retriedBy`, `retriedAt`, and on a `needs_person` / `expired` one `retry` (`{ allowed: true }` or
  `{ allowed: false, why }`), `unknownOperations` (key and kind only) and `madeBefore` (kinds and counts). The responsible
  person's view has none.
- **Told again, in its own words**: an occurrence notice's key is `<kind>:<job>:<occurrence>:<retries>:<code>`, read
  from the occurrence as written in that transaction — a second failure after a press is told once more, and the bell
  words an older notice by the code it was written with (a press clears the occurrence's own code); a key without a code
  (written before 5b) reads the occurrence's. The bell reads the job and occurrence from the first two parts, an older
  build too.
- **The app** (`client/shared/ai-turn-steps/job.ts`): the turn's `retries` (additive) makes the queue's `attemptKey`
  `<occurrence>#<retries>`, so today's attempts count per occurrence and press (`attemptsOf` in `aiTurns.ts`) — an
  occurrence that used up its two tries today runs again after a press (the member's own 「もう一度」 on the row clears
  those too) — and the candidate's `version` is `1 + retries`
  (a job claim names no record version), so a PC that saw it taken by another before the press asks again after it.
- **Admin console** (`admin/src/components/jobs/job-occurrences.tsx`, 回の記録): ［もう一度］ only where the server says
  `allowed`, after a confirmation saying what happens (a PC job: when the responsible person's app is open with
  「自動で進める」; the deadline counted again; still one やること); otherwise 「「もう一度」はできません：…」; who pressed it
  and when; what earlier runs made (「前回すでに…作っています。」, also in the confirmation); an unknown outside result as
  「メールの下書きが作られたか分かりません…」 with ［作られていた］［作られていなかった］ (asked first).

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
  the job); `skip` late → skipped; superseded; a PC job's occurrence made, never run by the server; exactly one owner-only やること with
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
- `server/tests/integration/jobs.test.ts` "PR 4" — the acceptance notice to the responsible person only,
  once per version, not for a consent already accepted, never the self-approver, gone once accepted /
  handed over / superseded by a newer approved version, the neutral name; a view's trigger, next slot and
  last occurrence (the approved trigger, not a newer draft's). `acceptNotice`'s responsible-person check
  survives its mutation: a notice row is only ever written to that person, and someone no longer
  responsible no longer sees the job at all (by construction).
- `server/tests/integration/jobs.test.ts` "PR 4" (review fixes) — back to an accepted consent (v1 A
  accepted, v2 B approved, v3 A) runs without a new ask; the content-changed wording, and 「責任者になりました」
  for someone a hand-over names; `you` and `approved` answered while the approved definition is hidden,
  without the place; `approved.name` hidden when a newer draft names an unreadable place.
- `server/tests/unit/job-words.test.ts` — every state, code and pause reason has words; a held occurrence's
  heading claims no cause.
- `client/src/features/jobs/model.test.ts` — 「次の回から動きます」 only for a job that now runs.
- `admin/tests/jobs.test.tsx` — the form makes the operation only and the parser accepts it; editing a name
  or time keeps the consent; a PC job through the same parser (5a-2); approval sends the version shown and its fingerprint,
  says whether acceptance is needed from the server's answer (also back to an accepted consent), does not
  accept for someone else, accepts one's own, and says what will happen; the list's 責任者 is the approved
  version's and a PC job says it needs the app; the stop asks first; a pause reason and occurrences in words;
  nobody else reads the page.
- `server/tests/integration/job-runs.test.ts` (PR 5a) — the turns and the claim the responsible person's
  alone (another member, an admin, the owner, another company's id, a server job's occurrence: 404); the
  claim's run (generation 1) taking the occurrence, another PC `RUN_CLAIMED`; the emergency stop's 503 first;
  the jobs stop, a pause, another version (held), expired, not accepted, absent (skipped, told), the pinned
  shelf version removed, the rights lost (paused, told, held); at every call only granted routes within the
  ceiling, never a create, an old build scoped too, the rights lost / a pause / the stop / an ended
  occurrence refusing the next call; a token binds to a PC job's run only; the finish's one owner-only
  やること (also finished twice), `nothing`, no result, a grant without `creates`, `needs_person` told, a
  temporary failure claimable again (generation 2); records off at the finish (run ended, `needs_person`,
  told); a pause / the company's stop holding a running occurrence and ending its run, nothing back after
  resume or lifting (the exact sequence claim → pause → call → resume → call → finish → re-claim →
  「もう一度」), a stop or pause written without holding still refused, the rights lost found only at the
  finish (paused, told); the hard deadline (renewing never moves it, the next call / the finish / a
  re-claim / the clock end the run → `TIME_LIMIT`); a reconcile wait bounded (`RESULT_UNKNOWN`, never
  `expired`); the turn's hidden name; the clock's expiry of an unheld run; the server runner never starved
  by PC occurrences; the shelf pin (filled by the server, `JOB_SKILL_NOT_HERE` both ways, an unreadable place
  missing / hiding the version, `JOB_SKILL_CHANGED`); ending a run (`endPcRun`) from `retry_later` and `open`
  too, an operation in flight made unknown (→ `waiting_reconcile`), the clock's expiry ending the run.
  Mutation check: 76 mutations were run, each removing or inverting exactly one of the guards named in this
  section (the checks of `job-runs.ts`, the hooks and dispatch in `ai-runs.ts` / `run-subjects.ts`, the
  clock's and `holdDue`'s PC branches and `endPcRun` in `job-occurrences.ts`, the shelf pin in `jobs.ts` /
  `skill-shelf.ts`, `jobRunRouteAllowed`), and each of the 76 fails this file. Lines outside that list
  (texts, view fields, the defensive checks below) were not mutated. Not reachable by a test, kept as defence: the `claimed` hook's refusal when the
  occurrence is no longer `due` (the claim's check and write are one synchronous stretch), the finish's
  `GONE` when the occurrence moved inside its own transaction, and a writer refusal after `beforeFinish`'s
  check (a race; it rolls the finish back).
- PR 5a-2: `server/tests/integration/job-runs.test.ts` "the app says which checks it runs" (no `checks`, another
  kind: 409, nothing written) and "a meeting check" (the claim answers only the meetings she attended since, with the
  title's words; the run reads those minutes and no other meeting's — before, another title, not hers, not held yet —
  nor another minutes route; none found → `nothing`); `job-occurrences.test.ts` (a PC job's occurrence made, never run
  by the server); `jobs-definition.test.ts` "the meeting check" (the minutes route in the grant, title words,
  `jobRunRouteAllowed` without `meetingFound` refuses), review fixes: each meeting one occurrence's (an app opened late,
  minutes recorded late), more than one run takes (the rest next time, none dropped or twice, non-matching titles never
  hide matching ones; the 10th and 11th recorded at the same moment both wait), the commit kept from the first claim
  and handed to the next occurrence; `client/tests/job-runs.test.ts` (also: an old-dated commit arriving late is new,
  fetched-but-not-merged is not yet, a commit not here is not yet, the token only with the run and the chat server
  refusing a job turn without it) (no server call while this PC
  may not run unattended AI; the claim's `checks`; nothing found → `nothing` and no message; the meeting titles
  quoted; the tool ceiling; the procedure not here; no report → retried, never `nothing` from the AI; the time limit
  and the renew's 409 stop the AI; the write and read areas, a link cannot lead out; new files by git's history
  (added only, within the window) and by time; a link at or above the place never followed; not synced → given back;
  taken away while preparing → nothing starts and no ceiling; the server's clock for the deadline; 「自動で進める」 off →
  no claim; the queue never hands a job early); `src/features/chat/aiTurns.test.ts` (a job after the records, outside
  their daily limit and failures in a row); `admin/tests/jobs.test.tsx` (the PC form through the
  shared parser; the meeting check names the minutes route). Mutation check: 12 + 5 server and 24 + 14 client
  mutations (the second numbers: the review fixes), one guard each; all fail their test file except: a meeting she is
  not on is stopped by `listedRecordIds` and by `isAttendee` (each alone suffices, so neither single removal fails); the
  `recordReader` check in `attendedSince` is defence only and **not reachable by a test** — a members-only meeting's
  listed member always reads it (the reader's members-only branch comes before every other rule), and a meeting that is
  not members-only is never in `listedRecordIds`; a check kind the app does not know is refused by the shared parser
  itself (its own filter was dropped as redundant); and the runner's settle of a claim that won after it gave up
  (a hook line, no test).
- PR 5b: `server/tests/integration/job-retry.test.ts` (owner / admin only — the responsible member and another member
  403, the view's fields only for them; another company's or job's occurrence = missing; only `needs_person` /
  `expired`; only the newest; stopped, paused, another version, not accepted, rights, the responsible person's AI stopped,
  the pinned Skill removed, the place not usable; an unknown result refused until reconciled — who, which operation, the
  body, only a looked-at occurrence —; the press: `due` with the new deadline, who and when kept, the old run closed and
  its own retry `RUN_DONE`, a new run with a fresh deadline, one `occurrenceTaskId`; an expired unclaimed one claimed
  after; a second failure told again; a server job's run again; a later slot that came but was not made yet, too
  little time before the next slot, the deadline leaving the run's minutes, at most three presses; a claim waiting while
  an earlier occurrence runs; what an earlier run made — counted for the admin without ids, named to the next run —;
  a refused reconciliation leaving the in-flight mark; an older notice keeping its reason after a press), `server/tests/unit/job-words.test.ts` (every block has
  words), `client/src/features/chat/aiTurns.test.ts` + `client/tests/job-runs.test.ts` (a press is tried again today;
  the count parsed strictly; what was made before reaches the first message, ids only), `admin/tests/jobs.test.tsx` (the button only where allowed, asked first, the reason
  otherwise; reconcile sends the answer chosen), permission matrix rows + `CROSS`, `admin-contract.test.ts`. Mutation
  check: 43 server, 13 client and 5 admin guards (all review rounds), each removed or inverted alone, fail their test file — except the
  state check in `blockOf`, which the write's compare-and-set also stops (each alone suffices).
- `client/tests/jobs-ipc.test.ts` — an older server without `you` reported as such; only the member's jobs (by the server's `you`), never dropped behind 80
  other jobs, a hidden approved definition still waiting for them, the approved version's name, the version
  and fingerprint sent, renderer values never change the path, which notices open the section.
- `server/tests/integration/admin-contract.test.ts` — the admin's calls and requests.
- `permission-matrix.test.ts` rows + `CROSS`; `company-scoped-sql.test.ts` (`HANDLE_TABLES`).
- PR 5a-3: `server/tests/integration/job-deliverables.test.ts` (fake Google: the place needed when accepting, of its
  kind, the member's own live pick — not someone else's, not unknown —, none for a version without one; the name to
  the responsible person only; the claim's turn names it; the run's token reaches the place's routes only with a place,
  never a read; a put into another picked folder refused with nothing sent; the status shows only its folder; a body's
  `recordId` never linked; the finish links the put to its やること; a pause refuses the next call; past 90 days: the
  claim and the clock make it `needs_person` `PLACE_NOT_USABLE`, told, and choosing again makes the next one run;
  「もう一度」 after a put: the responsible person's turn names the Drive file (id, name) and the retried run updates it,
  the owner's view and press name none of it; made, updated and pressed again it is one entry, also against the cap of
  20 (no `madeBeforeTotal`); a receipt of another folder, not done, or a consultation's receipt a run was answered with
  is never named as a file — each mutation-checked);
  `jobs-definition.test.ts` "a deliverable place outside" (declared kinds only, `ref` null, needs the deliverable folder,
  part of the consent, the accepted place's shape, the routes and tools only with a place); `client/tests/job-runs.test.ts`
  (the turn's place only of the grant's kind, the tools only with a chosen place, never a Drive read or pick, the first
  message; after 「もう一度」 the made file's fileId and the update sentence in it, a malformed file or one without a
  place left out — mutation-checked); `client/tests/jobs-ipc.test.ts` (the place chosen before accepting, cancelled → nothing accepted, an expired
  place asks again); `admin/tests/jobs.test.tsx` (the form's place with `ref` null, one's own such job approved only).
  Mutation check: 22 guards of this section (server, core, app, admin), each removed or inverted alone, fail their test
  file. Not reachable by a test, kept as defence: `deliveryPlace`'s runnable check (the record-token guard's
  `routeRefusal` already refuses a paused / stopped / changed job's call before the route asks it).
