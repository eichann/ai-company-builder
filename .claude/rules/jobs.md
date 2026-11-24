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
  - "client/shared/ai-turn-steps/set-watch.ts"
  - "client/electron/features/ai-turns/set-watch-run.ts"
  - "client/electron/features/ai-turns/set-watch-tools.ts"
  - "client/tests/job-set-watch-run.test.ts"
  - "client/tests/job-runs.test.ts"
  - "client/tests/job-runs-fail-closed.test.ts"
  - "client/electron/features/ai-turns/claims.ts"
  - "server/src/services/job-retry.ts"
  - "server/src/services/job-events.ts"
  - "server/src/services/job-set-watch.ts"
  - "server/src/services/ai-runs.ts"
  - "admin/src/lib/api.ts"
  - "server/src/**/job-proposals.ts"
  - "shared/core/job-proposals.ts"
  - "shared/types/job-proposals.ts"
  - "client/shared/job-proposals.ts"
  - "client/electron/records/job-proposal-tools.ts"
  - "client/src/features/chat/components/JobProposalCard.tsx"
  - "client/tests/job-proposal*.test.ts"
  - "client/shared/job-repeat-asks.ts"
  - "client/electron/features/jobs/repeat-asks.ts"
  - "client/src/features/settings/components/JobRepeatAskSetting.tsx"
  - "client/tests/job-repeat-asks.test.ts"
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
below). Event-triggered jobs: 4a (server only), 4b-0.5 (the rollback floor), 4b-1 (the server side of the PC's AI on events,
"Event jobs on the PC"), 4b-2 (the app runs them, fails closed, and shows 「もう一度」 / 「後始末」: "The app's runner"), 4b-3 (the admin
console makes, approves and presses them: "Event jobs on the PC" "The admin console (4b-3)").**

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
  and (5b, additive: `migrateJobOccurrenceRetries`) `retries` (0 = never), `retried_by`, `retried_at` — 「もう一度」, and
  (4b-0.5, additive: `migrateJobWatchGenerations`) `watch_generation` — the watch an event occurrence was made for
  ("Event-triggered jobs" "Watch generations"), and (4b-4 PR2, additive: `migrateJobSetWatch`) `event_meeting_id` — the meeting
  a set watch's occurrence was made for ("The set watch (schema 5)").
  Written by the clock and the runner (3b, below).
- `ai_job_meeting_reviews` (4b-4 PR2): the set watch's 「使った」 mark, one per record in the company ("The set watch (schema 5)");
  `ai_job_event_cursors.set_boundary_seq` (same PR): a set watch's switch boundary.
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
- **The deliverable folder's name** (`writes.folder`, owner decision 2026-11-23, every job — time and event, every
  schema): one folder name by **the department folder rule** (`isValidFolderName`, `shared/core/names.ts`: ASCII word
  characters, hiragana, katakana, kanji, then also `.` `_` `-`; never a leading `.` / `-`, a `/`, `\`, space, control,
  zero-width / bidi or full / half width character — the hiragana block's bare combining marks U+3099 / U+309A are taken,
  as for a department: no escape, the guard and the disk fold them alike; a trailing `.` too, which Windows drops, so there
  every write is refused, fail closed, as for a step's folder), in NFC (an NFD spelling is refused, not normalized: the admin form sends NFC),
  at most `DELIVERABLE_FOLDER_MAX` (60) — `deliverableFolderProblem` (`shared/core/plugin-step-runs.ts`), the same check a
  plugin step's folder and the app's write guard (`insideDeliverableAt`) apply, so the parser and the guard cannot drift.
  Until then `^[a-z0-9][a-z0-9_-]{0,63}$`; a stored 61–64 letter name could never be written to (the guard already
  held 60) and a new app no longer runs it (its turn is refused: the occurrence expires, told). The schema number did not
  change (owner: 「広げないメリットがない」), so the builds before this one meet a Japanese folder as follows: **an older
  server** never re-parses a stored version (`storedJobDefinition`) — it keeps, shows, approves and runs such a saved
  version as is (the approval's rights check names the place, not the folder) — but refuses to save one newly
  (`grant.writes.folder.BAD`: an older admin console cannot create or edit it); **an older app** parses every turn with its
  own copy of the parser (`parseJobTurn`) and so never claims or runs it (the occurrence expires, the responsible person
  and the creator told); **a newer app on an older server** runs it with the same write guard, which already took the
  department rule. Tests: `jobs-definition.test.ts` "the deliverable folder's name", `client/tests/job-runs.test.ts` 「a
  Japanese deliverable folder」 (the turn parsed; NFC / NFD of one name are one folder; `..`, a link, another place or
  name refused), `admin/tests/jobs.test.tsx` (the form sends NFC, plain words for a bad name).
- `jobConsentCanonical`: who (`actingUser`), `run`, `placement`, `grant` — what the responsible person
  accepts (D4). A name, trigger, check or missed policy change needs no new acceptance. An event job adds its trigger
  (schema 2) and, run by the PC (schema 3), its trigger and its check (the done mark decides when the AI is called).
- Schema 4 (member proposals, "Member proposals" below): schema 1's content — a time trigger, a procedure (`run.PROPOSAL_PC_ONLY`)
  on the PC — plus the mark `origin: 'member_proposal'` (required on 4, refused on any other schema: `definition.UNKNOWN_KEY` /
  `origin.BAD`); its consent is schema 1's (the mark is not consented to).
- Schema 3 (stage 4b-1, "Event jobs on the PC"): a record trigger, a procedure on the PC, and the check
  `source_record { doneMark: none | file_linked }` — that check is schema 3's alone (`check.SOURCE_RECORD_EVENTS_ONLY`), a
  schema-3 run is a procedure (`run.EVENT_PC_ONLY`) checked by it (`check.EVENT_NEEDS_SOURCE_RECORD`); schema 2 stays the
  server's operation (`trigger.EVENT_SERVER_ONLY`).
- Schema 5 (4b-4 PR1, "The set watch (schema 5)" below): the trigger `record_set` (a combination of fixed words, only an
  opened one), a department Skill (`run.procedure.source: department_skill`), the Skills it reads (`grant.reads.skills`),
  the check `matched_record` and `decision` (the Skill's reasons) — each schema 5's alone; its consent adds the trigger, the
  check and the reasons. Schemas 1–4 are byte for byte what they were (definition and consent).

## API (`routes/jobs.ts` → `services/jobs.ts`, contract `shared/types/jobs.ts`)

```
GET  /jobs                          owner/admin: all (+ stopped, canManage); others: jobs they are responsible for
GET  /jobs/:jobId                   the same people, with every version (newest first)
POST /jobs { definition }           owner/admin → 201 (draft, version 1)
PUT  /jobs/:jobId { definition }    owner/admin → a new version (same definition: changed false); the approved one stays
POST /jobs/:jobId/approve { version, fingerprint? }     owner/admin
POST /me/jobs/:jobId/accept { version, fingerprint? }   the version's responsible person only, an approved version only,
                                                        its own press (X-ACB-Job-Accept: separate, or the desktop app)
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
  version's → 409 `JOB_VERSION_FINGERPRINT` — compared only where the caller's view shows the fingerprint
  (`fingerprintShown`, stage 4b-0.5, independent review): a shape this server does not know answers
  `JOB_SCHEMA_UNKNOWN` **before** the comparison, and a version hidden from the caller (a place or start record they
  cannot read) never compares it — its other refusal comes whatever was sent, so a guess never tells the hidden sha256
  (approve and accept alike; `job-rollback-floor.test.ts` F1). **Acceptance and every resume of an approved job run the
  same rights and Skill checks.**
- **Approving is not accepting — two presses, also for the same person** (owner decision 2026-11-18, memo 「AI が自動化を
  提案する」 ⑦): an owner/admin who approves a job they are themselves the responsible person of has approved it as an
  admin only; their consent to it running with their rights is their own 「受け取る」 afterwards, checked like any
  acceptance (responsible person, approved version, fingerprint, rights, Skill, place, the consent canonical). Until then
  it is `NOT_ACCEPTED` and nothing runs (held, as for anyone). The server holds the split: **an acceptance is refused**,
  as the last check before the write (409 `JOB_ACCEPT_SEPARATELY`, 「承認はできました。…「受け取る」を別に押してください（この画面は
  古いため、画面を新しくしてください）」, `JOB_ACCEPT_SEPARATELY` in `shared/core/jobs.ts`), unless the request says its
  「受け取る」 is a press of its own — header `X-ACB-Job-Accept: separate` (`JOB_ACCEPT_HEADER`,
  sent by the admin console's 受け取る and every job call of the desktop app) — or comes from the desktop app
  (`X-ACB-Client-Version`: every released app's 受け取る always was its own press). An admin console from before the split
  (a tab left open) approved and then accepted with the same press without the header: its approval stays, its
  acceptance is refused and shown as 「承認しましたが、受け取れませんでした」 with that sentence. An older server ignores the
  header. Not judged by who approved: `approved_by` keeps a version's first approver, so an old tab re-approving a version
  someone else approved first would pass such a check (independent review of #702); no caller but the old console's
  approval press sends neither header. **Not** split: an event
  job's 「見張るやることを選び直す」 (`POST /me/jobs/:jobId/watch`), where the responsible person alone chooses the next
  watched やること and no admin approval is involved ("Event-triggered jobs").
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
  reader is owner / admin. While the company's records are off the inbox shows none of them (`list`
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
  place in `composition/jobs.ts` `wireJobOccurrences`), kept on the row.
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
(`JobServiceDeps.occurrenceHolds`, bound in `composition.ts` (`wireJobs`) to `jobOccurrences.holdDue` /
`holdPassedSlot`):

- **When it begins** — `POST /jobs/:jobId/pause`, a pause the server makes (`OWNER_LEFT`,
  `OWNER_RIGHTS_CHANGED`), `PUT /jobs-stop { stopped: true }`: every occurrence of the job (of the company)
  still `due` becomes `held` (`JOB_PAUSED` / `COMPANY_STOPPED`) — and one a PC is **running** (PR 5a) too,
  its run ended in the same transaction (`endPcRun`: `waiting_person` with that code, no holder), so its
  token (fenced: 409 `RUN_SUPERSEDED`), renew and finish are refused at once and a resume or lifting the stop
  brings nothing back (the occurrence stays `held`; a 「もう一度」 of the ended run claims nothing). **Every one**
  (stage 4b-0.5): batch after batch of the job's own (`dueOccurrences` / `runningOccurrences` with the job), until none
  is left — before, the first 10,000 only — and the frozen ones too ("Shapes this build does not know").
- **When it ends** — a resume (only of the pause it read: "Resume checks again"), `PUT /jobs-stop { stopped: false }` (only when it was on): the newest slot
  at or before now, if not made yet (no clock ran meanwhile), is written `held`, so the clock never makes
  it `due`. A slot from before the pause that no clock had reached yet is held too (the safe side).
- The runner's own stop / pause checks stay for a stop written without holding (a build before 3b,
  rolled back to and forward again).
- **After a restore** (`deployment.md` "After a restore"): `restorePause.pauseAfterRestore` sets the company's stop
  (`updated_by` `acb:restore`) and holds what is due or running, as the stop does — so a slot whose occurrence the
  restore took away is made `held` again, never run twice, also after an owner lifts the stop. Test:
  `restore-pause.test.ts`, `job-runs.test.ts` 「after a restore」.

## Resume checks again (SERVERCORE-1, 2026-11-23)

`POST /jobs/:jobId/resume` reads the pause it lifts, awaits the pinned Skill (git, `skillPinned`), then writes. A stop
that lands in that await must win, so (`services/jobs.ts` `resume`):

- **The pause as read** (`JobPauseSnapshot`: `pausedReason`, `pausedBy`, `pausedAt`, `approvedVersion`) is what the press
  lifts. Inside the write's transaction **who presses** is read again first (`memberships.roleOf`: an owner / admin
  demoted or removed during the await is answered as a press arriving now — the one 404 `JOB_NOT_FOUND` when the job is
  no longer theirs to see, else as a member — and the answer's view is built for them as they are now); then the job: no
  longer paused (resumed, retired) → nothing written, the current job answered (as a press arriving after: a double
  resume writes once); a non-admin whose pause is no longer their own → 403
  `JOB_PAUSED_BY_OTHER` (the answer of a later press); any other change of the four → 409 `JOB_PAUSE_CHANGED`
  (「再開の確認をしている間に、…ほかの理由で止められたか、内容が変わりました…」; the admin console shows the sentence); then the
  rights (`withinRights`) as before.
- **The write is a compare-and-set** (`JobRepository.resume(jobId, from, to, at)`, the precedent `records.writeState(row,
  expectedVersion)`): only while the row still holds exactly that pause; false → `JOB_PAUSE_CHANGED`, nothing written,
  no slot held. The re-read and the compare-and-set each stop a changed pause alone (the transaction is synchronous), so
  removing one is not caught by a test; both removed fail three.
- **A stop stays unconditional**: `setState` takes only `paused` / `retired` (a resume cannot be written through it) and
  needs no expected version — an admin's pause, the server's (`OWNER_LEFT`, `OWNER_RIGHTS_CHANGED`) and the company's stop
  always apply to the latest row (owner decision 1 of 「TOCTOUとTLA+の進め方」: versions only for operations built on what
  was read before).
- Test: `tests/integration/jobs.test.ts` "SERVERCORE-1" — the Skill port wrapped with `tests/helpers/hold.ts`
  `stopAfter`: an admin's stop during the responsible person's resume (still paused by the admin), the server's pause
  with another reason, another stopper, another approved version (each refused), retired meanwhile (stays retired, the
  retired job answered, nothing written), an admin demoted meanwhile (not their job now: 404; their job: 403, still
  paused), a double resume (one write, one slot held), a plain resume. Mutation check: the "no longer paused" answer, the
  in-transaction who-check, the role read again and the visibility check in the transaction each fail a test; the re-read
  and the compare-and-set, as above. Not caught alone: the view built for the member as they are now (defence: a demoted
  caller who still sees the job only reaches it on the "no longer paused" answer).

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
and a job at once (add it, additive, when one is). While the company's records are off the inbox does
not show them (the occurrence's state says it: `GET /jobs/:jobId/occurrences`).

## The PC's claim (PR 5a, `services/job-runs.ts`, design memo §3-3 / §3-5 / §4-2)

The AI runs **only on the responsible person's PC**; the server lists, keeps the run and checks. The run is
the execution run of 「AI の番」 (`services/ai-runs.ts`, `ai-turns.md` "Execution runs on the server"): subject
kind `occurrence`, step `job-procedure` (`JOB_PC_STEP`), its resolver `createJobRuns(...).subjects` behind the
same port (`runSubjectsByKind` in `services/run-subjects.ts`). Generations, the lease and renew, fencing,
idempotency keys, failure places, reconcile and the emergency stop are the run core's, unchanged.

```
GET  /me/job-turns                                          the caller's PC-job occurrences to claim now (JobTurnView)
POST /job-run-claims { occurrenceId, deviceId, conversationId, checks }   → 201 { run, created, turn } (200 on a re-claim)
POST /ai-runs/:runId/renew | finish                         as for any run; finish takes `jobResult` (below)
POST /ai-runs/:runId/retry | …/reconcile                    a job's run: 404 RUN_NOT_FOUND (stage 4b-1, D11: on the occurrence only)
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
  connector through `deliveryPlaces` (`live`, `linkToTask`; built in `composition/google.ts`). `writes` stays the PC's deliverable
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
  An owner/admin approving their own such job accepts it in the app (the admin console has no Picker, so its
  「責任者として受け取る」 is not offered for such a job): the dialog and the list say to choose it there.
- **What the person sees**: `JobView.deliverTo` (`label`, `chosen`, `usable`; the folder's `name` and `expiresAt` only
  to the responsible person — a Drive folder's name is theirs, owners / admins see neither); the grant's words say
  「できたものを置く先：Google Drive のフォルダ（責任者が受け取るときに選ぶ1か所だけ…）」. The app's 「受け取る」 reads the job
  as the server answers it and, when it names a place, opens the connector's chooser first (`choosePlace`, composed in
  `main.ts`: Google Picker in folder mode, in the member's browser, `google-drive.md`), then sends the acceptance with it — cancelled, nothing is
  accepted. A folder seen outside the company (or whose sharing could not be read) is refused there in words (「…定期の仕事は
  ここに置けません…選び直してください」, the pick's `sharing`, owner FB 2026-11-14) — the run's put would refuse it anyway. The app's 「定期の仕事」 shows the place line (`placeLine`) and, once it is not usable, 「置き先を選び直す」
  (`toAccept.why: 'place'`).
- **The run** (decision 2: the scope stays `drive.file`): the claim's turn carries `deliverTo` (with `ref`), the app's
  parser takes it only of the grant's own connector and kind. The route ceiling is widened narrowly: only a grant with a
  `deliverTo` reaches its connector's declared routes (`GET /google/drive/status`, `POST /google/drive/put`,
  `GET /google/drive/puts/:putId` — never a read, the file list or a pick), checked by `jobRunRouteAllowed` at every
  call (and `POST /read` refuses any run-bound token by itself, `google-drive.md`); the app gives the run only `drive_picked` and `drive_put` (`jobToolAccess(…, deliverTo)`) and its first message
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
  as the AI with the run's id; also in a company with the shared folder, owner decision 2026-11-13, `records.md` "Drive and PC file
  links"); a refusal (records off, the record gone…) is logged with its code and never fails
  anything. The AI's `summary` may carry the link as well.
- **The 90-day pick** (decision 3, changed by the owner 2026-11-14 「自動で接続し直す」, `google-drive.md` "How long a pick
  lasts"): a folder pick is not renewed by the clock while a job names it, but **every put that is done into it renews
  it for 90 days** — a run's too — so a job that delivers at least every 90 days keeps its place; 90 days without a put
  end it. A run whose folder lapsed is told it cannot put this time and to report it (`DRIVE_FOLDER_NOT_PICKED`, never
  「drive_pick_folder で選んでもらって」). When the chosen place is not usable — 90 days without a put,
  or no longer the person's pick — the clock makes the slot's occurrence `needs_person` `PLACE_NOT_USABLE` at once, told
  (`job_failed`, `makeOccurrences`' `placeUsable`) — **once**: a slot after one that already said so is made
  `needs_person` without a second notice — and a claim finding it so does the same (409 `JOB_PLACE_NOT_USABLE`; a
  running one's run is ended). No warning before the 90 days end (not built — a follow-up: a recordless notice to the responsible person about a week
before; the app's place line shows the date). The
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
  (`gitCheckPoint`): this PC must have what the server has — **fetched after the server listed the occurrence, told
  without any clock**: at the occurrence's first check (always after the server listed it, which it does only once its
  time has come) the app takes `FETCH_HEAD`'s identity (`gitFetchMark`: device, inode, size, modification and change
  times to the nanosecond; `none` when never fetched) and keeps it; a check counts as synced only when the identity
  has changed since (git rewrites `FETCH_HEAD` on every fetch, also one that brings nothing new). So the first check
  always waits for the next fetch (the automatic 受け取る, `sync.md`). No mark (it could not be taken), the same
  identity, or `FETCH_HEAD` gone → not synced; a mark that could not be taken is not kept (the next check takes it);
  forgotten when the occurrence leaves this app's list, however it leaves (listed again, a new mark). Timestamps were
  tried first and each failed a Codex review (2026-11-18): `FETCH_HEAD`'s time against `checkUntil` compared the PC's
  clock with the server's; against the listing's arrival, a clock set back after the listing either kept every fresh
  fetch waiting or — rebased or reset — let a fetch from before the listing through once the clock caught up **and** the server's tip (`@{upstream}`, else `FETCH_HEAD`) in `HEAD` (`merge-base --is-ancestor`: a fetch-only path or a
  sync stopped on a conflict leaves it out) — else nothing is claimed and it is asked again after `NOT_SYNCED_RETRY_MS`
  (30 s; `retryAfterMs` on the answer), never `nothing` on a guess. **Not a start** (`ai-turns.md`): it does not use
  up the runner's pass, and its hidden consultation, which never ran, is deleted. Then `POST /job-run-claims` with `checks` and `checkedCommit` (this PC's `HEAD` in the place's repository;
  the server keeps it on the occurrence, `checked_commit`, once — a re-claim looks up to the same); then **the check,
  before any AI** (D6): `new_files` — in the shared folder, files added in `sinceCommit..checkedCommit`
  (`newFilesByGit`: `log --diff-filter=A`, by what is reachable, **never by commit dates** — an old-dated commit that
  reaches the server late is still new; `sinceCommit` is the previous occurrence's commit; unknown here or none — the
  first occurrence, a build before it — the dates after `checkSince` decide), in the innermost repository (a private
  folder's clone, found from the place's on-disk spelling); a commit not on this PC → `temporary` `NOT_SYNCED`. In a
  working folder (no git): by modification time in [`checkSince`, `checkUntil`) (`newFilesByTime`) — the server's
  instants, so the file times (this PC's clock) are read through the clock difference measured at the claim (the
  server's `run.updatedAt` against the request's departure and the answer's arrival: a range, and a file counts when
  it may fall in the window, so the travel time never hides one; the start is moved back by a further
  `JOB_CLOCK_TOLERANCE_MS`, so a file stamped while the clock was off by less than that and corrected since is seen —
  possibly by two occurrences — rather than missed). Only while that difference is known and within
  `JOB_CLOCK_TOLERANCE_MS` (5 min, range included): unknown (no `updatedAt`) or further off → **no check**, the run is
  finished `temporary` `CLOCK_NOT_TRUSTED` (retried by the server, then a person is told) — never `nothing` on a
  clock's say-so (a clock that far off may also have been set differently when the files were written). **The place is
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
  `job_report` always; Claude Code's file tools only for `files_read` / `files_write`. **No key broker pass** (owner
  decision D3): the chat server asks no broker token for a turn with a step ceiling, so a job's AI has no relay
  variables (`key-broker.md` "Unattended turns get no pass").
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
  this PC's time **when the claim was sent** — so the answer's travel never moves the end later; the server refuses
  every call after the deadline anyway) end — not started at all with less left —, through the chat turns' `abort` with
  reason `job-ended` (the reply says 「※ 定期の仕事の時間が来たか、仕事が止められたため、AI を止めました。」); settle then
  finishes `bad-input` `TIME_LIMIT` (→ `needs_person` `RUN_FAILED`, told). A renew answered 401 / 403 / 404 / 409 (a pause,
  the company's stop, the deadline, another PC, an event's condition, a run the server no longer shows — "Fail closed"
  below) stops the AI the same way and settle gives the run back (`RUN_LOST`; the server already ended it). A refused
  finish leaves the consultation open (outcome `failed`).
- **Fail closed** (stage 4b-2, owner memo 「段4b 設計メモ」 §6 / D12 — time jobs and event jobs alike; `claims.ts` `hold`'s
  `guard`, `renewOnce`, `arm`; constants in `job-runs.ts`): a job's run has nobody watching, so its AI goes on only while
  the server keeps confirming it. **The renew has a deadline** (`JOB_RENEW_TIMEOUT_MS`, 30 s, owner decision 2026-11-22). A confirmation is a renew
  answered 2xx **within that deadline, naming this run and generation**, counted from when that renew **was sent**; the
  claim's own send counts as the first. **Age = the larger of the monotonic and the wall elapsed time** (`since` over a
  `ClockStamp`): a wall clock set back never extends it, and the time a Mac slept — which `performance.now` does not count
  (review of 4b-2, M2) — or a wall clock moved forward always counts. The watch reads the age at least every
  `JOB_WATCH_TICK_MS` (15 s), so after a wake (timers pause in sleep) the run stops within a tick; the deadline check of a
  renew uses the same age. **A run past the window is never revived** (Codex re-review of 4b-2): asleep longer than the
  window but within the server's lease (or a clock moved forward), the renew timer may fire before the watch looks and the
  server still answers 200 — so a renew is not sent, and its answer not accepted, when the confirmation it would replace was
  already older than the window at its send (`ageAt`); the hold is lost instead. The only other place a confirmation is set
  is `hold`'s first one (the claim's own send). Test: `job-runs-fail-closed.test.ts` "waking after more than the window";
  the check before sending and the one before accepting compare the same instant, so each alone suffices — both removed,
  the test fails. **No two renews race on one hold**: the deadline (30 s) is shorter than the renew interval
  (`AI_RUN_RENEW_EVERY_MS`, 60 s), a hold sends no timed renew while its previous one is still out (`guard.renewing`), and
  a confirmation only ever moves forward (a slower answer to an earlier send never moves it back); the claim's last check
  may run beside a timed renew of the same hold — both are that hold's, so either answer is a true confirmation of it.
  **When the last confirmation is older than `JOB_CONFIRM_MAX_AGE_MS` (3 min)** — offline, the server unreachable or hung,
  renews failing with 5xx — the run is lost here: released (its tokens unbound) and its AI stopped through the same path as
  the time limit (`stopTurn` → the chat turns' `abort`, reason `job-ended`; never an ad-hoc kill). Renewed every minute, so
  two renews may fail in a row; well inside the server's 5-minute lease (after which it refuses the token anyway); a run
  lost so is listed again and re-claimed once the server answers (D12: 「あとで」, tried again). **Stop at once** on a renew
  answered 401 / 403 / 404 / 409 (`jobRunGoneOnRenew`; 404 = the rollback floor, which freezes schema 3, or a record the
  member no longer reads), also when that answer came late; and on a call of the run's token refused for a reason that ends
  the run (`jobRunGoneOnCall`: any 401; 403 / 404 / 409 / 503 only with `NOT_IN_STEP`, `RUN_SUPERSEDED`, `RUN_NOT_FOUND`,
  `JOB_EVENT_ENDED`, `JOB_NOT_FOUND`, `RECORD_TOKEN_INVALID`, `AI_STOPPED`, `ACB_STOPPED`) — the records API reports every
  refused run-bound call (`onRunRefused`, wired in `main.ts`) and `claims.runRefused` decides. Other refusals of a call are
  the tool's answer and the run goes on (a Drive overwrite refused `DRIVE_FILE_CHANGED_SINCE` → "put a new file"; a record
  not found). **Late answers never extend a newer run**: an answer counts only for the hold that sent it (a run released,
  or held again by a later claim, is neither extended nor stopped by an older request's answer — compared by the hold
  itself, not the run id, so a re-claim of the same run is a new hold); a success past its deadline, or naming another run
  or generation, confirms nothing. The same for the claim itself (review L1): `hold` answers an opaque handle and
  `holds` / `confirm` take it, so an older claim still preparing never takes a newer claim's hold of the same run as its
  own — it starts nothing and finishes nothing (its give-backs, the `NOT_SYNCED` and `nothing` finishes only while its own
  hold is live).
- **Lost while its turn is prepared** (review of 4b-2, M1; `chat-server.ts`): a run lost during the awaits between the
  ceiling check and the turn's registration found no turn to stop; once the turn is tracked the chat server asks the job's
  ceiling again (`pluginStepTools`) and, gone, stops it at once with `job-ended` (as the emergency stop's re-check does).
- **No start after the cutoff** (Codex re-review of 4b-2): the time limit's timer can stop nothing while the claim's last
  check is out or before the turn is tracked. So after the last check the claim looks again — the timer fired or no time
  left before `JOB_STOP_BEFORE_MS` → nothing starts, the run is finished `bad-input` `TIME_LIMIT` (as with too little
  left before the claim); and a run past its stop time has no ceiling (`toolsOf`), so the chat server's re-check after
  tracking stops a turn that slipped through. Tests: `job-runs-fail-closed.test.ts` "the stop time coming while the last
  check is out" / "…before the turn is tracked"; the whole check and the ceiling's `timedOut` each fail a test, the two
  halves of the check (`timedOut`, the time recomputed) each alone suffice (the timer fires when that time reaches zero). **The last check right before the AI starts** (`deps.confirm`): after the check and the
  procedure, one renew now (it runs an event's conditions on the server, `renewRefusal`); refused → lost, nothing starts;
  not answered in time → given back `temporary` `NOT_CONFIRMED`, nothing starts. Record runs and plugin steps are
  unchanged (their renew's 409 only). Decision on the safe side: a `NOT_IN_STEP` from a route outside the grant stops the
  run too (the gate names nothing, so it cannot be told from a condition that failed; the tool ceiling already keeps the AI
  to granted routes).
- **Event occurrences** (stage 4b-2, schema 3, "Event jobs on the PC"): the list asks `GET /me/job-turns?kinds=time,event`
  (an older server ignores it or lists `time`); a time turn may also say `kind: 'time'` / `source: null`; an event turn
  (`kind: 'event'`, `source.recordId`) is parsed in an event
  frame (`EVENT_FRAME`: the `source_record` check only on an event turn, an event turn only with it, its grant creating the
  one やること), a time turn as before; a malformed `kind` / `source` drops the turn. **Only an event's claim** names
  `kinds: ['time','event']` and adds `source_record` to `checks` (the server's two locks); a time slot's claim stays byte for
  byte what every earlier app sent (no `kinds`), so a server before stage 4-0 never sees the key. The claim's turn must be
  of the listed kind (else given back `TURN_NOT_READABLE`). No check runs on the PC: the server checked the record at the
  claim and does at every call and renew; the first message starts from the record (`found.kind: 'record'`, its id;
  `records_get` named only when the grant lets it read it). Never `nothing` (the server refuses it for an event).
  Compatibility (§7): against the floor server (4b-0.5) no event turn is listed and a claim is refused; a run held across a
  rollback gets 404 on its next renew and stops. An older app is never handed one (it names neither lock).
- **「もう一度」 and 「後始末」 in the app** (stage 4b-2, D11, owner memo §4-3; `features/jobs/components/JobOccurrences.tsx`,
  IPC `jobs:occurrences` / `jobs:retryOccurrence` / `jobs:reconcileOccurrence`): Settings → 「定期の仕事」 lists 「AI が動いた回で、
  確かめが要るもの」 from `GET /me/job-occurrences` (the event occurrences pinned to a version naming the member, also after a
  hand-over) — **only what the server answered**: an occurrence is shown only when it carries `retry` or
  `unknownOperations` (the server leaves them out where the member's rights do not reach); 「もう一度」 only where `retry` is
  `allowed` (else 「「もう一度」はできません：」 + `jobRetryBlockText`), ［作られていた］［作られていなかった］ for each unknown
  operation (also on a held one); each asks first (`ConfirmDialog`, saying a reconcile never starts it and what earlier runs
  made), then posts to the occurrence's own route; a refusal shows the server's words. Main checks every id before it
  reaches a path (`isJobId`, `isOccurrenceId`, the operation key `^[A-Za-z0-9._:-]{1,100}$`); everything else is lenient
  so a later server's words never hide 「後始末」 (`parseMyJobOccurrence`, review L2): an entry without valid ids is left out,
  an operation without a valid key alone, at most 50 operations; an unknown state is shown as 「このアプリでは表示できない状態
  です」, an unknown 「もう一度」 reason as blocked (`UNKNOWN`, generic words), a malformed `retry` as no button. A server
  before 4b-1 (404) shows nothing (`supported: false`), never an error. Time jobs: owner / admin only, as before (the admin
  console).
- **Closing the consultation** (`ai-turns.md`, #674): done → closed when nothing of the member's is there; a
  failure, a stop or the time limit keep it open (listed by the job's name; ending its やること does not close it —
  the automatic consultations are remembered by the occurrence's id, which no record has).
- **Beside the records' turns, never at their cost** (`aiTurns.ts`): jobs are ordered after records (their slot is
  in the past by nature), do not count toward nor wait for the records' daily limit (`recordStarted(…, job)`), and
  their failures are the server's to place — no hand-off, not one of the records' failures in a row
  (`jobOutcome`); Claude's usage limit still pauses everything. Each occurrence is tried at most twice a day on this PC
  (`MAX_ATTEMPTS_PER_RECORD`) — per press of 「もう一度」 (`attemptKey`, 5b). A claim that wins after the runner gave up waiting (`START_TIMEOUT_MS`) is settled at
  once (records too), instead of a run held with no AI.
- **Not enforced for time jobs (decision)**: `grant.limits.runsPerDay` (one occurrence per slot; a retried run is the same
  one). An event job's day limit is enforced ("Event-triggered jobs" below).
- **Known limit (decision)**: a member invited to a meeting **after** its record was made (「招待する」, or the calendar
  adding them later) is never found by a later meeting check — the window counts when the record was made.
- **An unknown outside result** (`RESULT_UNKNOWN`, decision for the owner): a job's run reaches outside only by a
  mail **draft** (`outbound: draft_only`) or a put into its chosen place, so an unknown result means "it may or may not
  have been made". The occurrence's state and the inbox's `job_failed` (the notice) tell the responsible person and the job's
  creator; the person looks at 送るもの (the drafts) themselves; for a time job an owner / admin records what they found on
  the occurrence (5b, "「もう一度」": 作られていた／作られていなかった) before pressing 「もう一度」; for an event job its
  pinned responsible person can record it in the app (stage 4b-2, "「もう一度」 and 「後始末」 in the app" above).

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
  own `name` and the inbox show), `latestConsentAccepted` (the newest
  version's consent is the accepted one: approving it runs without a new 受け取る — the screens never
  re-derive this), `you` (`named` / `controls` / `mustAccept`: the caller by the API's own rules, answered
  also while a version's `definition` is hidden). Ids, booleans and names only, never a place. No new endpoint.
- **Admin console 「定期の仕事」** (`/companies/:id/jobs`, menu item for owners / admins after つなぎ先;
  `admin/src/components/jobs/`): the list (name, 責任者, いつ, a badge and `jobWaitingText` — paused with
  its reason, 承認待ち, 受け取り待ち, すべて止めています —; the badge splits 「止まっている」 by meaning
  (`jobBadge`, design-system.md P2b): 止めています (grey, an admin or the responsible person paused it),
  止まりました (red, the server paused it because the responsible person left or lost rights), すべて止めています
  (grey), 承認を待っています / 受け取りを待っています (amber) —, a newer version waiting for approval, for placement `a` that it
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
    name / time / due / missed change keeps the consent and needs no new acceptance. An event job (4a: the server's
    operation; 4b-3: the PC's AI, schema 3 — "Event jobs on the PC" "The admin console (4b-3)") is the same form with
    「いつ動くか」 → 出来事.
  - **The list's 責任者** is who it runs as now (`approved.responsibleUserId`); a newer draft naming someone
    else says 「次の版では責任者が…さんになります（未承認）」. Whether it runs is `jobRunsText` (a PC job: 「動いています
    （責任者のアプリが開いていて「自動で進める」が入っているときに動きます）」, badge 「PC で動きます」).
  - **Approval** shows the newest version's words and sends its `fingerprint` (the server refuses another).
    It says whether the responsible person must accept again from `latestConsentAccepted`, and its message
    afterwards comes from the answer (`approvedText`: 受け取り待ち, or what `jobRunsText` says now). **Approving one's own
    job never accepts it** (owner decision 2026-11-18, "Approving is not accepting" above): the dialog says before the
    press that the approval is an admin's and the consent to run it with their rights is pressed separately
    (`JOB_OWN_APPROVAL_NOTE`), and the message afterwards says it does not run until their 「受け取る」.
  - **The owner/admin's own 「受け取る」**: a row whose `you.mustAccept` is true says 「あなたが責任者です。…「責任者として
    受け取る」を押すまで動きません」 and offers 「責任者として受け取る」 (`JobAcceptDialog`): the approved version's words,
    「責任者として、この仕事をあなたの権限で動かすことに同意します。承認とは別の操作です。」, one 受け取る that sends that
    version and its fingerprint with `X-ACB-Job-Accept: separate` (`jobsApi.accept`). A job that puts into a place outside is
    not accepted here (no Picker): the row says to choose the place in the app.
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
  inbox (`jobNoticeTarget`, `client/shared/jobs.ts`): `job_accept_needed` opens this section; an occurrence's
  notice and `job_paused` open nothing (they also reach the creator / admins, who have nothing here).

## The acceptance notice (PR 4)

`job_accept_needed` (「定期の仕事「…」の責任者になりました。内容を確かめて「受け取る」を押してください（受け取るまで動きません）」,
or, when they had accepted an earlier version as its responsible person, 「あなたが責任者の定期の仕事「…」の内容が
変わりました。確かめて「受け取る」を押してください…」; recordless, on by default): written in the approval's transaction to the approved version's responsible
person when its consent is not the one accepted — **also when they approved it themself** (approving is not
accepting, owner decision 2026-11-18; before, the self-approver was never told) — key
`job_accept_needed:<job>:<version>` (once per version), then the bare `notifications` push to them. Built
when read (`jobs.acceptNotice`): shown only while that version is still the approved one, the reader is
its responsible person and has not accepted it, the job not retired — so an old ask (accepted, handed to
someone else, a newer version approved) is not shown. Its name follows `HIDDEN_JOB_NAME` (the newest
version names a place they cannot read → 「定期の仕事」).

## 「もう一度」 (PR 5b, `services/job-retry.ts`, owner decisions 2026-11-12)

```
POST /jobs/:jobId/occurrences/:occurrenceId/retry                          owner/admin → { occurrence: JobOccurrenceView }
POST /jobs/:jobId/occurrences/:occurrenceId/operations/:key/reconcile { done }   owner/admin → { occurrenceId }
GET  /me/job-occurrences                                                   any member: the event PC occurrences they ran (4b-1)
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
- **Reconcile** (`reconcile`): only on a `needs_person` / `expired` / **`held`** occurrence (`JOB_RECONCILE_STATES`, else
  409 `NOT_RETRYABLE`; `held` since stage 4b-0.5, owner memo 「段4b 設計メモ」 §4-1: a pause / the company's stop / a restore
  that ended a run while a Drive put or a draft was in flight left it held with its run `waiting_reconcile`, and before
  nobody could record what happened — today's time jobs too), the body `{ done: boolean }` (400), an operation of its PC
  run whose result is unknown (else 404 `OPERATION_NOT_FOUND`; one still marked in flight on a run that no longer runs is
  made `unknown` first, as a finish does — never stuck); the run core's reconciliation (`aiRuns.reconcileFor`, shared
  with `reconcile`: `reconciled_by` = the owner / admin). **Reconciling never resumes**: a job's run waiting for it goes
  back to `open` only while its occurrence is `running` (`ai-runs.ts` `mayGoOn`, also on the run's own
  `…/reconcile`); otherwise it stays `waiting_reconcile` (stopped: its token fenced, renew refused), a held occurrence
  stays held (a resume runs nothing; 「もう一度」 stays `NOT_RETRYABLE`), and a `needs_person` / `expired` one runs again
  only by 「もう一度」. A frozen occurrence (a later build's shape) is the one 404 here; back on its build it can be
  reconciled the same way. Who: owner / admin, and since 4b-1 for an event PC occurrence its pinned responsible person
  ("Event jobs on the PC" "Who reconciles and presses"). The admin
  console asks them to have the responsible person look first (an owner / admin cannot see the person's drafts). The
  in-flight mark and the answer are one transaction. Test: `job-runs.test.ts` "a held occurrence whose run waits for
  reconciliation" (F5 / F6).
- **The view** (`GET /jobs/:jobId/occurrences`, owners / admins only, `JobServiceDeps.occurrenceRetry` → `viewOf`):
  `retries`, `retriedBy`, `retriedAt`, and on a `needs_person` / `expired` one `retry` (`{ allowed: true }` or
  `{ allowed: false, why }`), `unknownOperations` (key and kind only) and `madeBefore` (kinds and counts); on a `held` one
  `unknownOperations` only (stage 4b-0.5: the admin console's ［作られていた］［作られていなかった］ then show for it, no
  ［もう一度］). The responsible person's view of a time job has none; of an event PC occurrence, what their rights cover
  (4b-1, `viewFor`).
- **Told again, in its own words**: an occurrence notice's key is `<kind>:<job>:<occurrence>:<retries>:<code>`, read
  from the occurrence as written in that transaction — a second failure after a press is told once more, and the server
  words an older notice by the code it was written with (a press clears the occurrence's own code); a key without a code
  (written before 5b) reads the occurrence's. The notice list reads the job and occurrence from the first two parts, an older
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

## Shapes this build does not know (stage 4-0 of event-triggered jobs, owner memo §3-11 / §10-7 / §11)

Event-triggered jobs (4a) store `schema: 2`. Production may run 4-0 again after 4a wrote such versions (a rollback,
`deployment.md` "Rolling back production"), and an admin tab or an app from before stays open. So:

- **Every read of a stored version is schema-checked** (`storedJobDefinition`, `shared/core/jobs.ts`): its
  definition only when its `schema` column is one this build knows (`JOB_SCHEMAS`, `[1, 2]` since 4a) and the stored text
  says the same schema; else null. A null definition is **never** made into an occurrence by the clock, approved,
  accepted or resumed (409 `JOB_SCHEMA_UNKNOWN`), and a job whose newest version is one is not edited (a new version over
  it: 409 `JOB_SCHEMA_UNKNOWN`, whatever the screen reads); a role change does not pause it for a reason this build
  cannot judge. Its occurrences are **frozen** (next bullet). Schema 1 is read exactly as stored.
- **Frozen occurrences** (stage 4b-0.5, the rollback floor: owner memo 「段4b 設計メモ」 第4版 §5-1 / §5-2): an occurrence
  pinned to a version of a shape this build does not know (a later build — 4b-1's PC AI on events, `schema: 3` — made
  it) does not exist for this build. The job repository leaves it out **in SQL, before every limit** (`KNOWN` in
  `adapters/sqlite/jobs.ts`: the pinned version's `schema` in `JOB_SCHEMAS` and its text saying the same schema —
  `occurrence`, `occurrences`, `dueOccurrences`, `runningOccurrences`, `occurrencesOf`, `eventRecordsOf`,
  `moveOccurrence`, `retryOccurrence`), so it is not listed or counted (`GET …/occurrences`, `lastOccurrence`), no notice
  of it is shown — also one written before (the notice list's `occurrenceNotice` finds no occurrence) — or written, the clock
  neither expires nor ends it (**changed from 4-0**: its expiry no longer applies here; its own build decides when it
  comes back), the server's runner and the PC's list never see it (no batch place taken: 10,000 frozen ones ahead of a
  known one hold nothing up), a claim, 「もう一度」 and reconcile answer the one 404 `JOB_NOT_FOUND`, and a PC run on one
  is a missing run (`isHiddenOccurrence` → `ai-runs.ts` `ownRun`). A version of such a shape is answered with
  `fingerprint` / `consentFingerprint` null to everyone, owners and admins included (`view`), and its
  `job_accept_needed` is not shown (`acceptNotice`). **Only stopping reaches it**: a pause, the company's stop and a
  restore (`holdDue`) hold every frozen `due` / `running` one of the job (company) — `holdFrozen`, **no limit** — and end
  its run (`endPcRun`: an operation in flight becomes unknown and the run waits for reconciliation); nothing is told and
  no chain is stopped (the later build reads them as held). Test: `job-rollback-floor.test.ts` (F1–F4; F10 the screens
  of a later server; F11 a database as 4b-1 leaves it, `tests/fixtures/stage4b1-shaped-jobs.sql`: nothing leaks or runs,
  the stop holds, what 4b-1 reads on return — versions, watch, receipts, notices, known outcomes, its own column —
  unchanged). Mutation check: 18 guards of this bullet, each fails a test.
- **A client gets a definition only in a shape it announced**: header `X-ACB-Job-Schemas` (`JOB_SCHEMAS_HEADER`,
  `parseJobSchemasHeader`: schema 1 always, the rest as named; none = schema 1 — every admin console and app before
  4-0, and a tab left open). A version of another shape (or one this server does not know) is answered without its
  definition and with `needsUpdate: true` (`JobVersionView`); the job's view drops `trigger` / `placement` and says
  `needsUpdate` when the version it shows is one (an older admin calls `trigger.at.split`). Approving, accepting it
  or editing a job whose newest version is one, from that client: 409 `JOB_NEEDS_NEWER_SCREEN` (what a screen
  cannot show, it must not write over or consent to). The admin console (`admin/src/lib/api.ts` `JOB_READS`) sends
  the header on every job call; since 4a so does the desktop app (`client/electron/features/jobs/ipc.ts`, `1,2`).
  **A screen announces what it can show, edit and accept, never what the shared parser reads** (stage 4b-0.5, owner memo
  §5-1): `ADMIN_JOB_SCHEMAS` (`admin/src/lib/jobs.ts`; also asked by `editableDefinition` / `needsNewerScreen`, so a
  form is never built from a shape the core reads but the form cannot) and `APP_JOB_SCHEMAS` (`client/shared/jobs.ts`;
  the 受け取る shows a definition only of such a shape, `appReadsJobDefinition`) — the admin `[1, 2, 3]` since 4b-3 (with the
  form that makes and reads schema 3 back) and `[1, 2, 3, 4]` since member proposals' PR B (the form reads a proposal's job back
  exactly and keeps it schema 4: "Member proposals" "The admin console (PR B)"), the app `[1, 2, 3]`
  since 4b-2 (its words for schema 3: `jobCheckText`'s `source_record`; shipped in the same build that runs such jobs and
  fails closed) and `[1, 2, 3, 4]` since member proposals' PR C (schema 4 is schema 1's content: the same words, its 受け取る
  as any: "Member proposals" "The app (PR C)"). The core reads `schema: 3` since 4b-1 (`JOB_SCHEMAS` `[1, 2, 3]`) and `schema: 4` since member proposals (`[1, 2, 3, 4]`; the
  screens announce 4 since their PRs B / C) and `schema: 5` since 4b-4 PR1 (`[1, 2, 3, 4, 5]`, "The set watch (schema 5)";
  no screen announces it yet). The server's tests of "a shape this build does not know" stand in `schema: 6`
  since then (`schema: 5` before 4b-4 PR1, `schema: 4` before that) (`job-schemas.test.ts`, `job-rollback-floor.test.ts` reads the frozen 4b-1 fixture's version one shape later;
  the floor build runs it as written). Tests
  `admin/tests/job-screen-schemas.test.ts` (the core stood in by one reading `schema: 6` since 4b-4 PR1 — `schema: 5` since PR B, `schema: 4` since 4b-3,
  `schema: 3` before; every announced schema round-trips through the form: for 3 the smallest grant and one with every choice,
  both done marks, a shelf Skill, a kept `from`; for 4 a proposal as `proposalDefinition` builds it, the smallest and one with
  every choice — reads listed before the check's place, the server's deliverable folder, a shelf Skill) and `client/tests/job-screen-schemas.test.ts` (every announced schema has its words). An app
  before it gets an event job without its definition and its 受け取る is refused — the same code, but the app (a request
  carrying `X-ACB-Client-Version`) is told 「…アプリを新しくしてください」 (`JOB_NEEDS_NEWER_APP`, `routes/jobs.ts`), a screen
  「画面を新しくしてください」.
- **The admin console** never builds a form or words from a definition it does not know (`editableDefinition`,
  `needsNewerScreen`, `knownJobDefinition`, `isKnownJobTrigger`): the list, the edit form and the approval say
  「この画面では編集できません。画面を新しくしてください」 (`JOB_NEEDS_NEWER_SCREEN`), 直す and 承認する are off.
- **Occurrence kinds** (`jobOccurrenceKind`: `ev:<delivery number>` slots are `event`, 4a; everything today is
  `time`): a claim names the kinds its app runs (`kinds`, additive; absent = `time`) and `GET /me/job-turns?kinds=`
  lists only those — an app before 4a is never handed an event occurrence (409 `JOB_KIND_NOT_SUPPORTED` on a claim).
  Kinds this build does not know are left out; a list naming none it knows (or an empty one) is 400.
  The app sends neither, also after 4a: every event occurrence of 4a is the server's (placement `e`); the PC's AI for
  events (4b) names `event`.
- **Event occurrences on the rollback floor (stage 4-0.1)**. 4-0.1 (deployment.md "Rolling back production") cannot
  check who reads an event occurrence's source record, so its job repository leaves every one out (`occurrence`,
  `occurrences`, `dueOccurrences`, `runningOccurrences`, `moveOccurrence`, `retryOccurrence`, `insertOccurrence`;
  `NOT_EVENT`, `isEventOccurrenceSlot`), except `holdEventOccurrences` (a pause holds the waiting ones) and
  `isHiddenOccurrence` (a PC run on one is a missing run, `ai-runs.ts` `ownRun`). **4a lifts that rule in the
  repository** — its clock, runner and 「もう一度」 need event occurrences — and applies its own reader check wherever an
  answer reaches a person (`eventShown`: the occurrence list via `occurrencesOf`, a job's `lastOccurrence`, the
  notices' recipients and words, 「もう一度」 / reconcile's 404; "Event-triggered jobs" below). Kept from 4-0.1:
  `isHiddenOccurrence` (4a runs every event occurrence on the server: none has a PC run) and `holdEventOccurrences`
  (`holdDue` calls it after its own loop, which holds the waiting event occurrences and stops their chains). A PC never
  lists or claims an event occurrence in 4a (`job-runs.ts` `own` and the turn list: the one 404), and an `ev:` slot
  naming no record is seen by nobody (`eventShown` fails closed; the runner skips it `EVENT_RECORD_GONE`). Test:
  `job-schemas.test.ts` "4-0.1's event occurrences as 4a reads them" — each reader path, the record-less slot, the PC
  refusal and the repository mutation-checked; the turn list's own event check (also stopped by `own`) and the hold
  after `holdDue`'s loop (a net beyond its limit) each alone add nothing a test can see.
- Test: `server/tests/integration/job-schemas.test.ts` (stored-version reader; the clock, the runner and its batch,
  the PC's list and claim, 「もう一度」, approve / accept / resume, list and detail without a crash, a role change;
  the client gate with a later server as fixture (`knownSchemas: [1, 2, 3]`, schema 3 standing in for a shape after 4a) —
  approve, accept, edit, list, detail; schema 1 byte for byte with any header; kinds on turns and claims; 4-0.1's event
  occurrences as 4a reads them — readers see them, non-readers (owners and admins included) do not, the hold, `ownRun`'s
  refusal) and `admin/tests/jobs.test.tsx` "a definition of
  a shape this console does not read" — each guard mutation-checked (the form's own `editableDefinition` is covered by
  the dialog's `needsNewerScreen` check before it, so removing it alone changes nothing).

## Event-triggered jobs (stage 4a, owner memo 「出来事で動く定期の仕事」 §3 / §10 / §11 / §12, the watched-record narrowing of 2026-11-18)

**No AI** (4a): an event makes an occurrence and the server's runner makes the responsible person's やること, as for a
time slot. Code: `services/job-events.ts` (the scan, the checks), `job-occurrences.ts` (the clock calls the scan, the runner
acts), `jobs.ts` (save, approve, accept, what each viewer sees).

- **The definition** (`schema: 2`, `JobRecordTrigger`; schema 1 keeps time triggers only, schema 2 record triggers only):
  `{ kind: 'record', type: 'task', event: 'state', to, from?, assignee: 'responsible', startRecord, followMadeTask }`.
  Only `task` and its non-AI, non-proposal states (`JOB_EVENT_STATES`); `run` must be the server's operation
  (`trigger.EVENT_SERVER_ONLY`). Made only by a client announcing schema 2 (409 `JOB_NEEDS_NEWER_SCREEN` otherwise).
- **One watched record, never "every task of the person"** (owner decision 2026-11-18 after a Codex review): the job
  watches the record the server keeps in `ai_job_event_cursors.watch_record_id` — it starts at `startRecord` (required:
  a trigger without it is 400 `BAD_JOB_DEFINITION` `trigger.startRecord.REQUIRED` with a plain sentence) and, with
  `followMadeTask`, moves to the やること its occurrence made, **set by the runner in the same transaction**
  (`moveWatch`); no tag, edit, duplicate or re-creation moves it, and a title is never compared (a rename still counts).
  Replacing it is a new version the responsible person accepts (the trigger is in the consent; `startEventCursor`
  restarts the watch when the accepted start record differs). **Each target fires once** (`watch_fired`): an undo and a
  second completion of it make nothing more (also when the day's limit skipped it). `assignee: 'responsible'` is checked
  on the record (its assignee at the event's version and right before acting), not on who completed it (the requester
  and the checker may).
- **Watch generations** (stage 4b-0.5, owner memo 「段4b 設計メモ」 第4版 §5-3 with Codex's 4th review #1): the cursor's
  `watch_generation` says which watch it is — 1 when first watched, + 1 each time the watch starts over (`restartWatch`,
  `startEventCursor` on a new start record) or moves (`moveWatch`) — and an event occurrence pins the generation it was
  made for (`ai_job_occurrences.watch_generation`, the scan). **Only an occurrence of the watch now moves, stops or clears
  it** (`moveWatch` / `clearChainStop` take its generation in SQL; the chain-stopping paths — the clock's expiry, the
  runner's held / skipped / needs-person, a refused やること, `holdDue` — ask `ownsWatch`): the same record chosen again,
  an occurrence of the earlier watch that expires, is held (its version is no longer the approved one), fails or runs
  stops and moves nothing (F7). A NULL generation (a time occurrence, or one the migration could not place) is
  **isolated**. The startup migration (`migrateJobWatchGenerations`, additive, only cursors without a generation)
  gives 4a's data generation 1 and pins it on an occurrence only when its provenance is certain — the watch fired, its
  chain is not stopped, and the job's **one** occurrence of the watched record is still `due` / `running` (F8) — never
  from which pending one is newest (`watch_fired` is also set without an occurrence, and the newest may have ended while
  an older one waits) — or, for a chain **stopped by its own occurrence** (the stop on the watched record, the job's one
  occurrence of it `needs_person` / `expired` with that very code, of the approved version: a restarted watch is always a
  new version, and no firing without an occurrence writes those codes), that occurrence, so its 「もう一度」 still lets the
  chain go on (independent review). A watch that fired, is not stopped and has no occurrence of its own is an **orphan**
  — for a job that follows what it made (`followMadeTask`; one that does not ends after its one firing, its occurrence
  done being its normal end, and is left as it is): stopped once (`WATCH_RESET`, 「仕組みの入れ替えのため、止まりました」) and its
  responsible person (not the creator: whether they read the record cannot be judged there, D7) told once, so they
  choose again (F9). Tests: `job-events.test.ts` "watch
  generations", `tests/unit/job-watch-generations.test.ts` (on `tests/fixtures/app-schema-before-watch-generations.sql`).
  Mutation check: 25 mutations, 22 fail a test (and 8 more after the independent review — the follow-only orphan, the
  own-occurrence pin and each of its six conditions — all fail); not alone: the `ownsWatch` null-generation check (a cursor always has
  a generation once the migration ran, so the comparison alone refuses) and the migration's schema check on the column
  and on the text (each alone suffices, as in `storedJobDefinition`; both removed together fails).
- **The start record**: read by whoever saves it **and** by the responsible person (one problem code,
  `trigger.startRecord.NOT_FOUND`, for missing / unreadable: an answer never tells them apart); a viewer who does not
  read it gets the version without definition, fingerprints and trigger — owners and admins too (`readsStart`). The admin
  console offers the responsible person's open やること the admin reads (`POST /records/query`, `jobsApi.startChoices`).
- **The scan** (`scan`, inside `makeOccurrences`, every company, each tick): **each** approved, active, accepted event job
  on its own (`scanJob`, its own transaction and `try`: a job that throws is logged once while it keeps failing and holds
  no other back; a job paused for long delays nobody), reading **only its watched record's** ledger rows after its cursor
  **by delivery number** (`watchedEvents`, indexed by the record; records.md "Delivery order"; never by `at`), at most
  `EVENT_ROWS_PER_TICK` (500) per job and tick — the rest next tick from the cursor; with nothing more of that record the
  cursor moves straight up to the company's newest number (nothing else concerns the job: the runner moves the watch only
  after the tick). The occurrence
  (`due_slot` `ev:<seq>`, `due_at` the event's time, `expires_at` from now, `event_seq` / `event_record_id` /
  `event_version` / `event_day`) and the cursor's move are one transaction (compare-and-set on the cursor); `UNIQUE
  (company, job, due_slot)` and the partial unique `(company, job, event_seq)` make one per event over two ticks or a
  restart. The cursor starts at acceptance (the newest delivery number then: never back in time); a version with a new
  consent approved and not accepted moves it to now each tick (what happens before its 受け取る never runs).
- **Never an event** (`ledgerRowIsEvent`, `triggerMatches`): a row with an origin mark (migration, any `acb:` actor), a
  row with `run_id` (a job's run, an AI turn — **the origin mark alone is not enough**: a PC run's or an AI turn's row has
  none), an `external` actor's row (a plugin's import, the minutes intake, the inbox — stage 4-0's decision 7), **a row
  written through a business plugin's screen** (`via`, `plugin-bridge.ts`: a person's press and the plugin's code cannot
  be told apart; owner decision ②, 2026-11-18), a row whose state did not change. A person's change counts, and so does their own consultation AI's (`ai` with no run); a
  person's completion of a やること a job made counts like any other. Also not: the responsible person cannot read the
  record now, its assignee then was someone else, its state then is 「AI の番」 (⑧: the type's own AI-only states or a
  business plugin's `ai_turn` / auto-started step, `plugin-steps.ts` `aiStepStates`).
- **Right before acting** (`recheck`, the runner): the responsible person still reads it, its assignee is them now, it is
  still the watched record, its state then is not 「AI の番」 now — else `skipped` `EVENT_RECORD_GONE` /
  `EVENT_NOT_ASSIGNEE` / `EVENT_NOT_WATCHED` / `EVENT_AI_TURN`, told to nobody. **A refusal of the responsible person's
  rights skips the occurrence only; an event job is never paused for it** (⑥). Not advanced: the source record (④).
  The やること's due counts from the event's company day.
- **Paused / stopped** (③): `holdDue` opens a gap (`ai_job_event_gaps`, from the delivery number then; `job_key` '' =
  the company's stop, also after a restore) and `holdPassedSlot` closes it; several per job. The scan looks at nothing
  while paused or stopped; afterwards rows inside a gap never run, rows before the pause that were not looked at yet do.
  **A gap still open while the job runs** was lifted by an older build (a round trip: paused here, resumed there): on a
  job whose stamps differ it ends now and nothing from it runs; on a job made since (its stamps match: it began looking
  after the lift) the company's stale gap ends where that job began, so its own events run (review of #700).
  **A pause or a stop the rollback build (4-0 / 4-0.1) made has no gap** (Codex review of #700): a resume or a lift that closes no
  gap moves the cursor to now (`resyncEventCursors`), and one made and lifted entirely there is found by the stamps —
  every write this build makes to `ai_jobs` / `ai_job_settings` copies their `updated_at` onto the cursor (`job_stamp`,
  `stop_stamp`); a difference at the scan means another build wrote it, and the cursor moves to now (logged). Safe side:
  what happened before then never runs. Accepting the same consent again moves nothing (`startEventCursor` only for a new
  consent or a first cursor).
  A `due` event occurrence is held by the pause like any other.
- **The day's limit** (⑦ ⑨): occurrences made per job and company day (`event_day`, company time) up to
  `grant.limits.runsPerDay`; beyond it nothing is made (the target counts as fired) and the job is never paused for it:
  the chain stops, and its one notice (`job_chain_stopped`, below) says the limit was the cause (owner decision: one
  notice, no other kind). 「もう一度」 makes no occurrence, so it never counts.
- **A stopped chain** (owner decision ①, 2026-11-18): when the watched record's turn cannot go on — the day's limit
  (`DAY_LIMIT`), reached while paused / stopped / an older build ran (`PAUSED_EVENT`), while a new content waited for its
  受け取る (`VERSION_EVENT`), reached the watched state **at the event** while unreadable for the responsible person, with
  someone else as assignee, or in 「AI の番」 (`EVENT_RECORD_GONE` / `EVENT_NOT_ASSIGNEE` / `EVENT_AI_TURN` — never a silent
  skip), or its occurrence ended without its やること (held, skipped — absent, assignee changed,
  unreadable, 「AI の番」 —, expired, needs a person) — the cursor keeps why, on which record and when
  (`chain_stop_code` / `_record` / `_at`, `stopChain`: once per stop), and it is told once (`job_chain_stopped`,
  recordless, key `job_chain_stopped:<job>:<at>`, shown while that very stop stands; brought back once to the responsible
  person when it stands for 3 days, below). **Who learns of a stop** (stage
  4b-0.2, owner decision D7 = A, 2026-11-21 — before it, the creator and every owner / admin were shown it, in plain
  words when they did not read the record, which still told them that something happened to it and when): **every stop
  is record-side** — each happens because the watched record reached the watched state, so even the day's limit, an
  absence, a pause or an expiry says the record had an event; no cause is shown as job-side. So a stop exists only for
  (a) someone who **reads the stop's record now** — the job's creator (while an owner / admin) is written the notice only
  when they read it at that moment (`chainStopped` in `job-events.ts`), and for anyone the notice's text
  (`jobs.chainStopNotice`) and `JobView.chainStopped` are there only while they still read it (checked again when read:
  a notice already written disappears once access is lost — a rule, a members-only list, owner-only, a removed record);
  and (b) **the approved version's responsible person, always** (an explicit, owner-approved exception to ⑥: they must
  choose the next watched やること) — in full while they read the record, else only
  「見張っていたやることの都合で止まりました」 whatever the cause (`jobChainStopText` with no title). For anyone else
  (an owner / admin who does not read an owner-only やること included) nothing differs before and after: no notice row, no
  unread count, no push signal, `chainStopped: null` in the list and the detail — the job looks as if it goes on, as an
  event occurrence they cannot see. Nothing of the record is stored in a notice. Rolling back to a build before 4b-0.2
  brings the old reach back (known). The chain goes on again when the
  watch moves (the runner) or when a 「もう一度」 makes its やること; else **the responsible person chooses the next watched
  やること**: `POST /me/jobs/:jobId/watch { version, recordId }` (the approved version's responsible person only; the
  version shown; not while a newer draft waits; **only on top of content they have accepted** — an approved version
  whose consent is not the accepted one is 409 `JOB_NOT_ACCEPTED` 「…先に内容を確かめて「受け取る」を押してから…」, checked in
  the write's transaction, because this press also accepts and would otherwise consent to what they never saw (stage
  4b-0, `job-events.test.ts` 「…had not accepted yet is refused」 / 「a new content approved but not accepted…」); the record
  checked as any start record) adds a version that differs only
  in `startRecord`, approved and accepted by that one press (`approved_by` = them: the change is of what they alone
  consented to), and the watch starts over there (`restartWatch` — also when it is the start record it began from).
  Accepting a new consent first checks what the watched record did since the cursor (`dropUntilNow`, `VERSION_EVENT`),
  so a completion between approval and acceptance stops the chain even before the clock looked. The app's 「定期の仕事」 shows the stop and 「見張るやることを選び直す」
  (`jobs:watchChoices` — their own open やること by name — and `jobs:rewatch`); the admin list shows it to an owner / admin who reads the stop's record now (D7 = A; an admin may also
  「直す」 the start record; the responsible person then accepts).
- **A chain that stays stopped is reminded once** (owner-approved, its own PR after 4b-2; `remindStoppedChains` in
  `job-events.ts`, run by the clock after the scan): `CHAIN_STOP_REMIND_AFTER_MS` (**3 days**: a stop on a Friday evening
  comes back on Monday evening, after a weekend nobody reads the inbox; a daily chain is not silently off for a week)
  after the stop, the responsible person's **own stop notice comes back** — unread again, dated now (on top), its
  `action` set to `reminded` (`CHAIN_STOP_REMINDED`), worded 「定期の仕事「…」は11月18日から止まったままです（cause）。次に見張るやることを選び直してください」
  (the cause as `chainOf` words it when read: no title once they no longer read the record). **Nothing new is written**
  — no row, kind or key — so a build that does not know the reminder (the rollback floor 4b-0.5 included) shows and
  hides that row exactly as the stop notice it always was (its key's `<at>` still the standing stop). **Only while they
  can act on it and nothing changed since the stop**: the job `active` (not paused, retired or under the company's
  stop), **not written since the stop** (`ai_jobs.updated_at` ≤ the stop's time: no approval — also an older version
  approved again, which leaves that version's `approved_at` as it was, so the versions cannot say who was responsible at
  the stop (independent review / Codex of this PR) —, no edit, acceptance, pause or resume after it; so the approved
  version and its responsible person are the ones the stop was told about, and a new responsible person — also the
  creator, who was told as creator — is never reminded; decision on the safe side: a pause and resume after the stop,
  or an admin's draft, also ends the reminder, and the stop stays shown in 「定期の仕事」), the approved content accepted,
  the responsible person a member who **reads the stop's record now** (decision on the safe side: narrower than D7's
  exception for the first notice — someone who cannot read it is not reminded), and that very stop still standing. A
  cheap look at the stop's age first, then **every check again inside the write's transaction** with the compare-and-set.
  **While the company's records are off** nothing is looked at: the reminder is not used up and comes once they are on
  again, if the chain is still stopped. **Once per stop**: `remindOnce` brings the row back only while its `action` is
  still '' (compare-and-set in SQL: two clocks, a restart or two servers bring it back once); a choice made again or a
  moved watch ends the stop, and a later stop has its own key, notice and reminder. Nobody else's row is touched (the
  creator's stays as it was); the push signal goes to the responsible person only. Each job on its own (one that throws
  holds none back, logged once; not while its scan's failure is logged already — and logged once that has passed, if
  the reminder still fails). **The first clock pass after this build is deployed** reminds, at once, every stop that is
  already older than 3 days and still meets the checks (known and left so: production had no event jobs when it
  shipped). Test: `job-events.test.ts` "a chain that stays stopped: one reminder to the responsible person" (not before
  3 days; once, on top, unread, the words, pushed to her alone; never again after two passes and a restart; not after a
  choice made again, and a second stop reminded again; not while paused, retired, a content not accepted — nor after the
  resume; not under the company's stop; records off waits and then comes; not to a new responsible person who was the
  creator; an older version approved again around the stop (v1 Alice, v2 the owner, v1 again, the stop, v2 again): no
  reminder to the owner's creator row; not when the record is no longer hers to read, or she left — once reminded, a
  record lost since worded plainly; a stop ended by another server before the write; a job that throws; a reminder
  failing while the scan fails, logged after the scan recovers), and the cross-build check (`server/tests/cross-build/`:
  a schema-2 job reminded by this build is shown by the floor as the plain stop notice, to alice only, and is not
  reminded again on return). Mutation check: 18 guards removed or inverted one at a time (the age, active, the
  company's stop, records off, accepted, written since the stop, reading the record, the compare-and-set, unread, on
  top, the push, the words, the per-job catch, its log once, quiet while the scan's failure is logged, not marked while
  quiet, the stop read again in the write, the clock's call); each fails a test.
- **Who sees an event occurrence** (⑥, `eventShown`): only someone who reads its record now — owners and admins too.
  `GET /jobs/:jobId/occurrences` leaves the others out **before** the limit (page by page), the job's `lastOccurrence` is
  the newest the viewer may see, a notice is written only to those who read it then and shown only while they still do,
  「もう一度」 / reconcile answer the same 404. The list's check is one batch per request (`shownOccurrences`: the job's
  event records, newest first, at most `EVENT_RECORDS_CHECKED` (2000), read with one reader; SQL then leaves the others
  out before the limit — `occurrencesOf`), so the work never depends on how many are hidden; event occurrences of older
  records are left out (fails closed). Answers never carry `ev:<seq>`: `dueSlot` is the event's time in company
  time, with `kind: 'event'`. An event job has no `nextSlot`; 「もう一度」 of an event occurrence has no slot rule
  (`NOT_LATEST` / `NEXT_SLOT_SOON` do not apply).
- **Order of a job's occurrences** (`OCCURRENCE_ORDER`, adapters/sqlite/jobs.ts): newest first by when each came — a time
  slot by its `due_at`, an event one by when it was made — and events made together by delivery number (numerically: never
  `ev:9` after `ev:10`), so a job whose trigger changed shows its newest occurrence first and 「もう一度」's `NOT_LATEST` sees
  the right one. A job of time slots only reads exactly as before. 「もう一度」's `NOT_LATEST` compares with the newest **time**
  occurrence only (`occurrencesOf(job, [], 1)`): an event occurrence — maybe of a record the viewer cannot read — never
  changes the answer (review of #700).
- **Screens**: the admin form's 「いつ動くか」 → 「見張っているやることが終わったときなどに」: 見張るやること (a list searched by name and paged, `JOB_START_PAGE` 50 at a time), きっかけ (a state),
  「作ったやることも続けて見張る」, 1日の上限; the words are `job-words.ts` (`jobRecordTriggerText` — never the record's title
  —, `JOB_EVENT_NOTE`, the grant's day-limit line, the expiry line). The app shows the same sentences in 「受け取る」.
- **Rolling back**: once 4b-0.5 is in production, never below it (`deployment.md` "Rolling back production", owner D8):
  4b-0.5 freezes 4b-1's shapes ("Shapes this build does not know"), reconciles held occurrences without resuming them and
  keeps watch generations. Between 4-0.1 and 4a (before 4b-0.5 shipped): 4-0 reads schema 2 as nothing; a `due` event
  occurrence left behind expires there and 4-0 tells its responsible person and the creator without this section's reader
  check (known; event occurrences are due for minutes only — the runner takes them right after the clock).
- Test: `server/tests/integration/job-events.test.ts` (the memo's 4a tests 1–9 and the narrowing: unrelated task,
  duplicate, someone's tag, rename, undo and complete again, a missing target refused, the start record's readers, ⑧, ⑤,
  a new consent not accepted, the consent), `jobs-definition.test.ts` "an event trigger", `job-schemas.test.ts` (now with a
  later `schema: 3` as the unknown shape), `admin/tests/jobs.test.tsx` "an event job", `client/tests/jobs-ipc.test.ts`
  (the header), `admin-contract.test.ts` (`startChoices`). After the review of #700 also: a job paused while thousands of
  rows came delays no other, a job that throws holds none back (logged once), two clocks (a pass whose cursor moved keeps
  nothing), re-accepting the same start record keeps the chain, a limit-skipped target never fires later, the
  still-watched recheck, the order of a mixed history, acceptance's trigger check, the limit notice shown to the
  responsible person only, the start list's search and pages. Stage 4b-0.2 (D7 = A): "D7 = A: a stopped chain of a
  record the viewer cannot read" (non-reader creator and admin identical before and after — rows, unread, notice list, push,
  list and detail —; a reader admin; the responsible person in plain words; checked again when read after a members-only
  list, owner-only or a removed record), and (1)'s comparison now includes the stop — 5 guards mutation-checked, each
  fails; the removed-record check in `chainOf` is defence only (`records.byIds` never returns a removed record).
  Mutation check: 51 guards removed or inverted one at a time
  (`job-events.test.ts` + `jobs-definition.test.ts`); each fails except the `ev:<seq>` slot, which the partial unique
  index on `event_seq` also guards (each alone suffices). The still-watched recheck is a defence (only the runner moves
  the watch, after acting); its test sets the watch directly.

## Event jobs on the PC (stage 4b-1, owner memo 「段4b 設計メモ」 第4版 §4 / §6, D2–D12; Codex review 4 #2 / #3)

The server side of 「見張っているやることが完了したら、責任者の PC の AI が会社の Skill を動かす」. **4b-1 promises server-side
effects only**: a failed condition ends the run, fences its tokens and refuses every later call, outside operation, finish
and やること. Stopping the AI on the PC when the server cannot be reached (an authorisation deadline, stopping on 404 /
403) is the app's, 4b-2 (done: "The app's runner" "Fail closed", "Event occurrences"). The admin console makes such a job
since 4b-3 ("The admin console (4b-3)" below); it and the app announce `1,2,3`.

- **What runs** (`schema: 3`, D2): the event of 4a (one watched record, `followMadeTask`, each target once, the scan, the
  day's limit, gaps, generations — "Event-triggered jobs") makes the occurrence; the responsible person's app claims it
  (`POST /job-run-claims`), as a time PC job, with every rule of "The PC's claim" (the grant at every call, the hard
  deadline, the one やること at the finish, a place outside) plus the ones below. The server's runner never takes it
  (placement `a`). `missed.expiresAfterMinutes` is how long it waits for the app (D6: one day is the admin form's default,
  `JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES`).
- **Old apps never run it** (two locks, §7): a claim must name the kind `event` (`kinds`) and the check `source_record`
  (`checks`). The list (`GET /me/job-turns?kinds=event`) is gated by the kind only — the check lock is the claim's. `JOB_EVENT_CHECK_KINDS` is kept out of `JOB_PC_CHECK_KINDS`, which every app build
  sends, so a rebuilt app of today never names it (`JOB_KIND_NOT_SUPPORTED` / `JOB_CHECK_NOT_SUPPORTED`, nothing written).
  A screen announcing `1,2` gets no definition, and its create / approve / accept is `JOB_NEEDS_NEWER_SCREEN` (the app is
  told to update).
- **The turn** (`JobTurnView`): `kind: 'event'`, `source: { recordId }` (the record the event happened to), `dueSlot` the
  event's time in company time (never `ev:<seq>`); `checkSince` / `checkUntil` are its `dueAt` (no window: it looks at
  its own record).
- **The conditions** (`job-occurrences.ts` `eventCondition`, owner memo §5-2), in this order: C1 the job runs as pinned
  (the company's stop, a pause, the approved version, the consent accepted); C7 records on; C2 the responsible person a
  member with the pinned version's rights (`runnerRefusal`); C3 the record theirs to read now (`eventShown`); C8 still
  the watch it was made for (`ownsWatch`: its generation, the watched record); C4 the record still in the trigger's
  `to` state; C5 its assignee them; C6 that state not 「AI の番」 now (a business plugin's step since: `aiTurnState`); C9 no
  done mark (`file_linked`: a link from the record with a target path — a company file or a `drive:` file; the server
  reads links only). Before a run starts (the list, a `due` claim, and the clock's look at a waiting one) also D5: absent
  on the event's company day (never the `ev:` slot read as a date).
- **Where they are checked**: the list (left out, nothing written), the claim (`resolve`), every call of the run's token
  (`routeRefusal`), every renew (the run subject's new `renewRefusal`, asked by `ai-runs.ts` `renew` after its lease
  check: the app renews every minute), the finish (`beforeFinish`; `finishing` refuses a race and rolls back), and the
  clock (`makeOccurrences` → `endFailedEvents`, for running ones and for waiting ones not yet expired — a run nobody
  renews ends too). A failure answers 409 `JOB_EVENT_ENDED` with `reason` (the code) — a call 403 `NOT_IN_STEP` — and
  ends it (`endEventIn`, one transaction).
- **How it ends** (§4-4, D4 + D9): the run first (`endPcRun`: tokens fenced, an operation in flight made `unknown`); then
  the occurrence — an outside operation whose result nobody knows → `needs_person` `RESULT_UNKNOWN`, told (`job_failed`),
  the run `waiting_reconcile`; something made outside that is known (this run's or an earlier run's, `madeBefore`) →
  `needs_person` `MADE_THEN_STOPPED`, told; else by the condition (`eventEndState`): C1 `held` (as a pause; never told),
  C4 / C9 `nothing` (no longer needed; not told), C7 `needs_person` `RECORDS_OFF` (told), D5 `skipped` `OWNER_ABSENT` (told),
  C2 / C3 / C5 / C6 / C8 `skipped` (not told; **an event job is never paused for the responsible person's rights**, ⑥).
  C1 holds whatever was made (as a pause does; a held occurrence is reconciled on the occurrence, 4b-0.5). Every end
  without its やること stops this watch's chain once (`job_chain_stopped`, D7's recipients) — also the deadline
  (`TIME_LIMIT`), a reconcile wait out of time (`RESULT_UNKNOWN`), the clock's expiry of a running one (`EXPIRED`), a
  finish to a person (`RUN_FAILED`), a pause / the stop holding a running one. **A finish `nothing` is refused** for an
  event run (400 `JOB_EVENT_NOTHING_REFUSED`, the whole finish rolled back, the run still running — as `JOB_RESULT_REQUIRED`):
  whether it is still needed is the server's conditions' to say, never the AI's (coordinator decision 2026-11-22); so a
  schema-3 grant must create `task` (`grant.creates.EVENT_NEEDS_TASK`, Codex review of 4b-1: else no finish could succeed). A
  done finish moves the watch to the やること it made (`followMadeTask`) or lets a stopped chain go on (`eventEnded`), in
  the finish's transaction, its own generation only — as the server's runner does.
- **Never side by side**: a `due` event occurrence waits (409 `JOB_EARLIER_RUNNING`, nothing written, nothing told) while
  **any other** occurrence of the job is `running` — `otherRunning`, one `EXISTS` without a limit or a slot comparison
  (time occurrences keep 5b's earlier-slot rule). The occurrence itself is never counted.
- **A run on it** (`ai-runs.ts` `ownRun` asks the subject's new `hides`): a frozen occurrence's run and an event
  occurrence's run are missing runs, except a schema-3 one whose record the member reads now (⑥) — get, renew, finish,
  token binding. When the member's own running event run is hidden for that reason (C3), `hides` **ends it there**
  (`EVENT_RECORD_GONE`): a renew or a finish answered 404 never reaches the conditions, so without it the run would stay
  unfenced until the next call or clock pass (independent review of 4b-1). A claim of an event occurrence the claimer
  cannot read answers the one 404 **before** the kind and check locks; it ends the occurrence only when the claiming app
  runs event occurrences (an app of the wrong kind writes nothing). The run-level 「もう一度」 and reconcile (`POST /ai-runs/:runId/retry`, `…/operations/:key/reconcile`) answer
  404 `RUN_NOT_FOUND` for **every** job's run, time ones too (D11: the occurrence's are the only ones; no released app
  used them for a job's run — `aiTurns:retry` does nothing for an occurrence, `ai-turns.md`).
- **Who reconciles and presses** (D11 table, `job-retry.ts` `rightsOf`; Codex review 4 #2 / #3): an owner / admin who
  sees the occurrence (an event one only while they read its record: else the one 404); for an event PC occurrence also
  **its pinned version's responsible person** while they read its record (reconcile, and ask for 「もう一度」) and **the
  job's current responsible person** (ask for 「もう一度」). **Allowed to ask is not able to run**: an occurrence stays
  pinned to its version and that version's responsible person, so after another version was approved — a hand-over
  included — the press answers 409 `JOB_VERSION_CHANGED`, whoever asks; it never moves whose rights run it. A member
  without such a right gets 403 `JOBS_FORBIDDEN` whatever the ids (missing, unreadable, someone else's: one answer).
  Time jobs: owner / admin only, as before. The views (`GET /jobs/:jobId/occurrences`, `viewFor`) carry the 「もう一度」
  fields only to someone whose rights cover them: an owner / admin and the pinned person all of them; the current
  responsible person on an occurrence pinned to the one before only `retry` (its answer, `JOB_VERSION_CHANGED`) — never what
  that person's run sent or made (`unknownOperations`, `madeBefore`, who pressed).
- **Finding one's own after a hand-over** (`GET /me/job-occurrences`, `jobRetry.mine`): every member; the event PC
  occurrences pinned to a version naming them (`eventRecordsPinnedTo` / `occurrencesPinnedTo`: their records, newest event
  first, checked a page of `EVENT_RECORDS_CHECKED` at a time — up to `MINE_PAGES` (5) pages, until 100 readable occurrences —
  the unreadable left out in SQL before the limit; beyond the pages, fails closed), with `jobId` and the name of **the version they ran**
  (`jobs.pinnedNameOf`: 「定期の仕事」 when it names a place they cannot read) — never the job's newer versions or name.
- **「もう一度」 of an event PC occurrence** (§4-2): `blockOf` as for any, plus its conditions now (`eventCondition` without
  D5): C7 → `RECORDS_OFF`, C2 → `JOB_GRANT_EXCEEDS`, any other → `SOURCE_CHANGED` — refused without changing the state, the
  deadline or the count. Its deadline is the press's own (after an expiry or the time limit it is pressed as usual).
- **Choosing the watched やること again** (`rewatch`, §6 「選び直しの残り」): before the write it checks the pinned Skill
  (`skillPinned`, asynchronous: a shelf Skill whose current version moved → `JOB_SKILL_CHANGED`), then **everything that
  can change meanwhile is checked again inside the write's transaction** (`rewatchChecks`: still the approved version's
  responsible person, not retired, the version shown and no draft waiting, the record a start record both read, for
  schema 3 its assignee them — else `trigger.startRecord.NOT_FOUND`, one code —; then membership and rights, the consent
  accepted, a place outside still theirs and usable → `JOB_PLACE_NOT_USABLE`).
- **Rolling back** to 4b-0.5 (the floor, D8): schema-3 versions and their occurrences are frozen there (not shown, run,
  told or expired; a stop holds them and ends their runs; reconciled again here). F11 across builds — this build writes the
  database, the floor's code (the commit pinned in `.github/rollback-floor-commit`) runs on it, this build again — is
  `.github/scripts/rollback-floor-check.sh` (`server/tests/cross-build/`, a step of the "Server tests" job;
  `deployment.md` "Rolling back production").
- Test: `server/tests/integration/job-event-runs.test.ts` (S1–S10 of §8, the compatibility rows of §7, D5),
  `jobs-definition.test.ts` "an event run by the PC AI (schema 3)", `job-words.test.ts` (every new code has words),
  `job-runs.test.ts` / `job-retry.test.ts` (the closed run-level routes), permission matrix row `GET /me/job-occurrences`.
  Mutation check: 84 guards removed or inverted one at a time (the core parser and consent, `job-runs.ts`, the renew
  and hide hooks and the closed routes in `ai-runs.ts` / `run-subjects.ts`, `eventCondition` / `endEventIn` /
  `eventEnded` and the clock's and `holdDue`'s chain stops in `job-occurrences.ts`, `otherRunning` and the pinned queries,
  `rightsOf` / `mine` / `blockOf` in `job-retry.ts`, `pinnedNameOf`, the rewatch's re-checks); 79 fail a test. Not alone:
  the list's and `turnOf`'s reader check (`seen`: the responsible person is the reader, so C3 in the conditions refuses the
  same), `mine`'s two reader checks (the readable-records batch and `eventShown`: each alone suffices), and the clock
  leaving an expired waiting one to its expiry instead of the conditions (an ordering choice: expired and told, as any).
  Not reachable: `finishing`'s event re-check (`beforeFinish` checked in the same synchronous stretch: a race only), the
  self-exclusion in `otherRunning` (only a `due` one asks, never running itself), `own`'s fail-closed without `eventRuns`,
  and `end` answering null when nothing moved (its callers then stop no chain: the move and its check are one synchronous
  stretch). `deliveryPlace`'s event conditions (`stillRuns`) are behind the record-token guard's `routeRefusal`, which ends
  the run at the Drive route's call first, so removing them alone changes nothing (as its time-job check, "A deliverable
  place outside"). After the independent review: `hides` ending the run, the claim's 404 before the locks and its
  write only for an app of the kind, `viewFor`'s retry-only view, `mine`'s paging — 5 mutations, each fails.

- **The admin console (4b-3)** (`admin/src/lib/jobs.ts`, `components/jobs/`; owner memo 「段4b 設計メモ」 §6 / D6, decisions
  2026-11-21). Everything below only shows and asks; the server decides.
  - **The form**: 「いつ動くか」 → 出来事 with 「すること」 → 「Skill を責任者の PC の AI で動かす」 makes schema 3 — the watched やること
    (the same list as 4a: the responsible person's open やること this viewer reads, `startChoices`), きっかけ, 「作ったやることも続けて
    見張る」, 1日の上限, the Skill (a company Skill, or the shelf's in a company without the shared folder), **済みの印**
    (`doneMark`: なし / 「見張っているやることにファイルがもうつながっていたら、AI を動かさない」, with `jobCheckText`'s sentence),
    read places, 「やることや記録を読む」, mail drafts, the deliverable folder and the place outside, the minutes per run. The check is
    always `source_record` — a time job's check left on the form (a place, meeting words) grants nothing (`pcGrant(f, true)`:
    no check place in the reads, no minutes route). **`grant.creates.EVENT_NEEDS_TASK` by construction**: every PC grant
    the form makes creates `task` with `records`. A **new** job becoming an event run by the PC (`switchJobForm`, `newJob`)
    sets the wait for the app to **one day** (`JOB_EVENT_PC_EXPIRES_DEFAULT_MINUTES`, D6; still a choice); editing never
    changes a version's own wait, also when すること is switched away and back. A PC job's minutes become at least 15.
    **The form never widens a grant** (`jobEditForm`, independent review): a schema-3 version is given the edit form only
    when `definitionFromForm(formFromDefinition(d))` is `d` (the pinned fingerprint and a shelf Skill's name — the server's —
    left out of the comparison); one made otherwise (e.g. one record route instead of the four 「やることや記録を読む」 gives)
    says `JOB_FORM_CANNOT_EDIT` and has no 保存. Schemas 1 and 2 keep their behaviour (their round-trip widening, e.g. the
    record routes of a time PC job made through the API, is known and left as it was). Under the trigger the form says the sentence the approval and the app say
    (`jobRecordTriggerText`), with 「最初は「…」を見張ります。」 — that name only from this viewer's own list, never from a definition.
  - **Words**: the approval and 受け取る show schema 3 through the shared words (`jobTriggerText`, `jobCheckText`,
    `jobGrantLines` — for an event run by the PC the minutes per run too: 「上限：1回 15分・1日 1回まで（…）」, told apart by
    the grant having tools, which the server's operation never has —, `jobMissedText`). The list says an approved event
    job's next occurrence as 「見張っているやることが、きっかけの状態になったとき」 (no slot); a version hidden from the viewer as
    「表示できません」, and its 「もう一度」 confirmation (placement unknown to them) in words naming neither the server nor the PC.
  - **A hidden version** (`hiddenVersion`: a shape this console reads, answered without definition and fingerprints — a
    start record this owner / admin cannot read, `readsStart`): the list, 直す, 承認する and 受け取る say `JOB_VERSION_HIDDEN`
    (「この版には、あなたが見られないものが含まれているため、内容を表示・編集できません。」 — never what it names, nor that it is a
    やること); no form is built over it and nothing is approved or accepted (no fingerprint to send; none is guessed — the
    server would not compare it either, `fingerprintShown`). Decision on the safe side: an owner / admin cannot write a new
    version over a version hidden from them here, though the server would take one.
  - **Refusals in plain Japanese** (`describeJobError`, `admin/src/lib/errors.ts`): `BAD_JOB_DEFINITION` by its problem codes
    (`jobProblemText`: also `schema.UNKNOWN` — the rollback floor refusing schema 3 — 「…いまのサーバーではまだ作れません（サーバー
    の更新が必要です）」, `EVENT_NEEDS_TASK`, the schema-3 pairing codes, `doneMark`), the job codes whose server sentence is
    fixed Japanese (`JOB_SENTENCE_CODES`) as the server wrote them, a 「もう一度」 refusal by its code (`jobRetryBlockText`), any
    other as `describeError`'s sentence for its status (401, 403, 404, 409, 5xx) — and an unknown code or none on any other
    status (400, 422, 429…) as `JOB_REFUSED_GENERAL`, never the server's text (`describeError`'s fallback would print it). Used by every job dialog, the list's presses and 回の記録.
  - **Occurrences**: exactly the server's list and fields (D11 decides who sees an event occurrence and which 「もう一度」 fields
    it carries); an event one is marked 「出来事」 (its slot is the event's time), its 「もう一度」 confirmation says it runs only
    while the watched やること still asks for it, and every press goes to the occurrence routes (`…/occurrences/:id/retry`,
    `…/operations/:key/reconcile`), never `/ai-runs`.
  - **Compatibility**: a tab left open from before (announcing `1,2`) gets schema 3 without its definition, says
    「画面を新しくしてください」 and offers no 直す / 承認する (the server refuses them too: `job-event-runs.test.ts` 「a screen that
    announces 1,2 …」). This console on the rollback floor (6760eef3, which knows `[1, 2]`): a schema-3 version is
    `needsUpdate` there (said as 「画面を新しくしてください」 — safe, though the cause is the server), and creating one is refused
    `BAD_JOB_DEFINITION` `schema.UNKNOWN`, said as above.
  - Test: `admin/tests/jobs.test.tsx` "an event run by the responsible person’s PC AI (schema 3)" and
    `admin/tests/job-screen-schemas.test.ts`. Mutation check: 22 guards removed or inverted one at a time (the announced `3`, the done
    mark read back, `creates: ['task']`, the event grant ignoring a left-over check — place, minutes route, the flag —, the
    one-day default and only on becoming one, the hidden version in the form, the approval and the list, each branch of
    `describeJobError` and showing an unknown code's text, the form using it, the event retry sentence and mark, the minutes
    line, the event next-occurrence words, the PC fields offered for events, the form making schema 3); each fails a test.
    After the independent review: 9 more (an unknown code on 400 / 422 / 429 general and 409 kept, the round-trip
    comparison, schema 3 only, the pin left out of it, the dialog's gate, the hidden next occurrence, the neutral 「もう一度」
    words, the one-day default for a new job only); each fails a test.
    Not alone: `hidden` in the approve / accept buttons' `disabled` (a hidden version has no fingerprint, which disables
    them already); the accept dialog's hidden sentence (same code path as the approval's, not tested separately).
- Test (4b-2): `client/tests/job-runs-fail-closed.test.ts` (A1: renew 404 / 403 / 409 / 401, a renew that hangs, no server, 5xx
  past the window, a token call refused for a run-ending reason — and not for a tool's own refusal; A2: a late success, a
  success naming another run, an older hold's late 200 / 409 after a re-claim; A3: the list's and the event claim's names, a
  time claim unchanged, the last check refused / unanswered, a claim turn of another kind; the event turn's parsing; a
  record's run unchanged), `client/tests/job-runs.test.ts` (the renew answer now names the run; a 409 after the start),
  `client/tests/jobs-ipc.test.ts` (「AI が動いた回」: the server's list, malformed entries left out, 404 not an error; the
  occurrence's routes, renderer values never in the path; the header `1,2,3`), `client/tests/job-screen-schemas.test.ts`
  (schema 3's words, both done marks), `client/src/features/jobs/model.test.ts` (rows only from the server's fields).
  Mutation check: 27 guards removed or inverted one at a time; each fails a test except the hold identity check in
  `renewOnce` and the one in `lose` — each alone suffices (an answer's confirmation and loss both land on its own hold); both
  removed together fail A2's re-claim test. After the review (M1, M2, L1–L4): `job-runs.test.ts` "a job's run lost while
  its turn was being prepared never runs", `job-runs-fail-closed.test.ts` M2 (asleep: the wall clock counts, read within a
  tick; set back: the monotonic one counts) and L1 (only one of two claims of the same run starts), the time turn's harmless
  forms, the time claim's whole body, `jobs-ipc.test.ts` (unknown state / reason / long lists keep the entry and its
  「後始末」, keys still strict), `model.test.ts`. Not caught alone, kept as defence: the `arm` inside `hold` (review L5 —
  every job claim confirms before its AI starts, and `confirm` arms the watch; the hold's own arm only covers the
  preparation, where nothing runs yet); `confirm`'s own hold comparison (the claim checks `live` — the same comparison — in
the same synchronous stretch right before it). The rest — the clocks' max (each direction), the watch tick, the chat
server's re-check, `holds` by the hold, the give-backs only for the own hold, the time turn's two forms, each lenient field
of `parseMyJobOccurrence` and the key still strict — each fails a test (16 mutations). The 30 s deadline (owner decision):
the deadline shorter than the interval and the window holding two renews, and no second timed renew while one is out —
each fails a test; the confirmation moving only forward is defence (the only overlap left, the claim's last check beside a
timed renew of the same hold, moves it by milliseconds).

## The set watch (schema 5, 4b-4 PR1; owner memo 「4b-4 商談から提案書」 第6版 §2 / §3 / §4 / 付録 B)

「これから来る、条件に合うもの全部」 — a second way to watch, beside the one watched record of schemas 2 / 3 (which stay exactly
as they are). **PR1: the definition, the consent and the approval. PR2: the server finds the records and makes occurrences**
("The scan and its occurrences" below) — no released app names its check (`matched_record`), so nothing is claimed or run until
PR5, and no screen announces 5 yet (`ADMIN_JOB_SCHEMAS` / `APP_JOB_SCHEMAS` stay `[1, 2, 3, 4]`: such a version is answered
without its definition, `needsUpdate`, and a create, approval or acceptance from them is `JOB_NEEDS_NEWER_SCREEN`). **PR3: how a
run ends** (the judgement, its やること or notice, corrections: "How a run ends" below). PR4 the plugin steps' side, **PR5: the app
runs it** ("The app runs it" below; no screen announces schema 5 yet — that, and every button, is PR6), PR7 the admin console.

- **The trigger is words, not a condition language** (owner decision 2026-11-23, §2-1): `{ kind: 'record_set', recordType,
  taskKind, origin, causes, causeRule, assignee, event, unit, guards }`, each key from its own list (`JOB_SET_WATCH_WORDS`,
  else `trigger.<key>.BAD`; `causes` never empty), and **the whole combination exactly one of `JOB_SET_WATCH_OPENED`**
  (`shared/core/jobs.ts`, `jobSetWatchOpened`: every key, every list in the order written there), else
  `trigger.NOT_OPENED`. The one line today is 4b-4's: a やること (`task`) of kind 「議事録を確認する」 (`minutes_review`) that came
  from a meeting (`meeting`: its one `links.meeting` and the id `meetingOutputId` gives — never a title), counted causes
  `human` under `ledger_v1` (exactly `ledgerRowIsEvent`: a person or their own consultation AI; never a migration, `acb:`
  actor, run, outside writer or business plugin screen), `responsible_from_creation` (its assignee was the responsible
  person from its first version), `first_done` (the first `done` of its whole ledger), `unit: record` (one occurrence per
  record, over versions and jobs), and the guards `after_acceptance`, `attendee_responsible`, `outside_attendee`,
  `people_only_meeting`, `plugin_step_exclusive` (§2-3 / §2-5 / §3: what PR2 enforces; written into the definition so the
  responsible person consents to them and a changed list is another combination). Opening another combination is one more
  line with its own guards and tests; **a line taken out stops its jobs** (the parser refuses them, and approval,
  acceptance and resume ask `jobSetWatchOpened` again on the stored version: `JOB_SET_WATCH_NOT_OPENED`). Words:
  `jobSetTriggerText` (a combination not opened is never described as the opened one).
- **What runs** (§4, 案A): a department Skill `run.procedure = { source: 'department_skill', place, skill, fingerprint }`
  (`place` one department folder, `isValidFolderName`, NFC; `skill` the ASCII rule) and the Skills it reads
  `grant.reads.skills = [{ place, skill, fingerprint }]` (1–4, each once; absent elsewhere, so every other grant is byte for
  byte what it was), both at their git trees (`<place>/.claude/skills/<skill>`, `lib/skill-trees.ts` `departmentSkill`); the
  check `matched_record` (kept out of `JOB_PC_CHECK_KINDS` / `JOB_EVENT_CHECK_KINDS`, so no released app claims one);
  `creates: ['task']` (`grant.creates.SET_WATCH_NEEDS_TASK`), no mail draft (`grant.outbound.SET_WATCH_NONE`), no place
  outside (`grant.deliverTo.SET_WATCH_NONE`), and the minutes route alone (`grant.routes.SET_WATCH_MINUTES_ONLY`). Each piece
  is schema 5's alone (`run.procedure.DEPARTMENT_SKILL_SET_WATCH_ONLY`, `grant.reads.skills.SET_WATCH_ONLY`,
  `check.MATCHED_RECORD_SET_WATCH_ONLY`, `decision` an unknown key elsewhere) and schema 5 takes only them
  (`run.SET_WATCH_DEPARTMENT_SKILL`, `check.SET_WATCH_NEEDS_MATCHED_RECORD`). Both Skills' paths are places the responsible
  person must read (`jobDefinitionPaths`: rights, hiding, `OWNER_RIGHTS_CHANGED` as for any place). What judges behind the
  app's one gate (Claude now, a local model later, §5-0) is in neither the definition nor the consent.
- **The server pins, never the caller** (`services/jobs.ts` `pinDepartmentSkills`): when a version is made, the trees read now
  replace every fingerprint sent, and `decision` is the run's Skill's `decision.json` (`parseJobDecisionFile`: `{ reasons:
  [{ code, label }] }`, 1–20, codes `^[a-z][a-z0-9_]{0,39}$` unique — ACB's own outcomes such as `GATE_UNAVAILABLE` are upper
  case —, labels one NFC line ≤ 40, ≤ 16 KB) — the caller's is replaced. A Skill that is not there → 409 `JOB_SKILL_MISSING`; no
  valid `decision.json` → 409 `JOB_SKILL_DECISION_MISSING`; a company without the shared folder → `JOB_SKILL_NOT_HERE`.
  Approval, acceptance and a resume check every pinned tree is still the current one (`skillPinned` → `JOB_SKILL_CHANGED`:
  a changed Skill is a new version, a new consent and a new 受け取る, O5; `decision.json` is inside the tree), **as the
  responsible person reads it** (as for a shelf Skill, independent review): a Skill at a place they do not read answers
  `JOB_SKILL_MISSING` whether it changed or not, so the answer never tells them anything about it.
- **The consent** (§2-6, T8): `jobConsentCanonical` of schema 5 is who, `run`, `placement`, `grant` (with the Skills read),
  the whole `trigger` (words, causes and their rule, unit, guards), the `check` and `decision` — any change asks for a new
  受け取る; the name does not. Schemas 1–4 consent byte for byte what they did (sha256 pinned in the test).
- **Approval, acceptance and resume** (`setWatchRefusal`, inside each write's transaction, after the rights): the combination
  still opened (`JOB_SET_WATCH_NOT_OPENED`); **one per responsible person** — no other `active` job whose approved version is
  schema 5 names the same person (`JobRepository.activeApprovedOf`; 409 `JOB_SET_WATCH_ONE_PER_PERSON`: one meeting never
  runs twice and the day's limit is never doubled, §2-4; a paused one does not count, so the second is approved once the
  first is paused, and the first is then not resumed or accepted); **no business plugin step set to run one of its Skills**
  (`plugin_step_skills` naming the run's or a read Skill's name, wherever its folder is — told by the name, on the safe side;
  409 `JOB_SET_WATCH_STEP_SKILL`, §3 ④: removing the setting is enough, so nothing is stuck). **The approval closes the
  steps' open requests** pinned to one of those Skills (`plugin_step_pins` `company_skill`; `closeRequestsForSkills`) in its
  own transaction, whenever they were asked — not `answerRequest`'s time condition, so a request a later meeting opened again
  is closed too — marking `done_by_job` (additive, `migratePluginStepRequestCloser`; 「定期の仕事が受け持つため閉じました」);
  it waits for no request or run (§3 ③: a run already going ends within its deadline, and its meeting is before the
  boundary PR2 enforces). Refused for any other reason → nothing closed (one transaction). The steps' side (PR4:
  choosing, enabling, asking and claiming the Skill refused while such a job is approved and not retired) is `plugin-steps.md`
  "While a set watch takes the Skill over".
- **The scan and its occurrences** (4b-4 PR2; `services/job-events.ts` `scanSetJob` — the cursor, gaps, stamps, day's limit and
  mark, shared with the event jobs' scan through `cursorReady` —, `services/job-set-watch.ts` — the combination's own rules, one
  place: what is the event, the guards, the conditions while it runs, who sees it):
  - **The cursor** is an event job's row (`ai_job_event_cursors`, `watch_record_id` '' — it watches no one record, so no watch,
    fire, move, generation or chain stop ever applies), made by the acceptance of a new consent (`startSetCursor`: at the
    company's newest delivery number, never back; `set_boundary_seq` = that number, **the switch boundary**). Paused / the
    company's stop, a gap still open, a pause an older build made (the stamps), a consent not accepted: as for an event job
    (`cursorReady`); a change an older build made also moves the switch boundary to now (`startSetCursor` again: such a build
    may have accepted a new consent without moving it — nothing read or made before now counts as after an acceptance). Each tick, each approved, active, accepted set watch on its own reads the company's ledger rows **into
    `done` of a やること** after its cursor, by delivery number (`ledgerInto`, index `idx_record_ledger_into (company_id, to_state,
    delivery_seq)`; "into" = a state change: a field-only change of a done やること writes `done → done` and is not read — it
    never is a first done anyway, so this keeps the tick's budget for real completions and holds no rule of its own), at most
    `EVENT_ROWS_PER_TICK`; the occurrences, the marks and the cursor's move (compare-and-set) are one
    transaction. A combination no longer opened (`jobSetWatchOpened` on the stored version) reads nothing and its cursor follows
    now (compare-and-set), so what was completed while the line was out never runs late if it comes back; a task type that no
    longer has `task_kind: minutes_review` and a `meeting` link (T9) reads nothing, logs once and **its cursor follows now the
    same way** (4b-4 PR3, owner-approved safe side: what was completed meanwhile is dropped, never run late; no pause reason
    exists for it — the job looks as if nothing came; an owner notice is a follow-up).
  - **The event** (`minutesReviewEvent`): `ledgerRowIsEvent` (`causes: human`, `ledger_v1`); a やること whose first version was
    written by the minutes intake (`MINUTES_ACTOR`) with `task_kind: minutes_review`, exactly one `links.meeting`, and its id
    `meetingOutputId(meeting, MINUTES_REVIEW_KEY)` (composition's `minutesReviewId`; never a title); the row its **first** `done`
    (no earlier one in its ledger); its assignee at version 1 the job's responsible person. Anything else is not this job's and
    is **not marked** (someone else's record is that person's job's to judge, T18).
  - **The mark** (`ai_job_meeting_reviews`, `PRIMARY KEY (company_id, record_id)`, `JOB_SET_MARK_OUTCOMES`): for the job's own
    record, written in the scan's transaction whatever comes of it — `made` (with the occurrence), `paused` (a gap), and the
    guards' (`setGuardRefusal`): `not_matched` (its assignee at the event not the responsible person; `people_only_meeting`: the
    meeting not members-only — one with a folder, before 2026-11-04; `attendee_responsible`: the responsible person does not read
    the record or the meeting now or is not one of its people; `outside_attendee`: `external_count` 0), `before_acceptance`
    (`after_acceptance`: the record's first ledger row **and** the meeting's first row into `read` must both carry a delivery
    number after the boundary — a NULL one is out, no later reading stands in, T21), `step_busy` (`plugin_step_exclusive`, §3 ②:
    the meeting's まとまり has an open step request naming that meeting, or a run of a step going on (`running`, its lease
    live — PR4), whose pin or company setting names one of the job's Skills — `PluginStepRepository.stepBusyWithSkills`), `day_limit`. A record with a mark (any
    job's, any outcome) never makes anything: a new version or a new job never runs the same meeting again. The mark is a plain
    insert, never `OR IGNORE`: the scan asks first in the same transaction, and a mark found there anyway (a second clock) throws,
    so that job's pass — its occurrence included — is rolled back rather than an occurrence beside another job's mark. Each guard is named
    in the definition and checked by its name; an unknown name never holds.
  - **The day's limit**: occurrences made per job and company day up to the consented `grant.limits.runsPerDay` (the memo's 10
    is what the admin form will offer, PR7); beyond it `day_limit` and the notice `job_day_limit` to the responsible person only,
    once per job and day (`job_day_limit:<job>:<day>`, built when read by `jobs.dayLimitNotice`: the job's name and the day from
    its key — never 「今日」, it may be read later —, no meeting's name, no count, shown only while they are the approved version's responsible person). The job is never paused for it.
  - **The occurrence**: `ev:<seq>` (an event occurrence: the pause, the stop, the floor's freezing, the expiry and its notices
    all apply as for any), `event_record_id` the record, `event_meeting_id` the meeting, no watch generation, due at the event,
    expiring `missed.expiresAfterMinutes` from now.
  - **Who sees it** (§2-5, I8; `eventShown` → `setOccurrenceShown`): someone who reads the record **and** reads the meeting and is
    one of its people (on its list as a person, its assignee or an attendee: `services/meeting-people.ts`, the minutes service's
    one copy) — an owner / admin who did not attend never: the occurrence list (`shownOccurrences` leaves them out before the
    limit, with the job's event records and their meetings in one batch), `lastOccurrence`, the occurrence notices' recipients
    and words, 「もう一度」 / reconcile (its responsible person may, as for an event PC occurrence, D11) and `GET
    /me/job-occurrences`. The responsible person's 「止まった」 exception of a watched record does not exist here (no chain).
  - **The PC** (the run is PR5's): an event PC occurrence for every rule of "Event jobs on the PC" (`isEventPcOccurrence` takes
    it), with its conditions (`eventCondition` → `setWatchCondition`, after C1 / C7 / C2): its combination still opened
    (`SET_WATCH_NOT_OPENED`), the record and the meeting still the responsible person's to read and the meeting's people still
    include them (`EVENT_RECORD_GONE`), the record's meeting still the pinned one (`SET_WATCH_MEETING_CHANGED`), the record still
    `done` (`EVENT_NOT_NEEDED`), its assignee still them (`EVENT_NOT_ASSIGNEE`); before a run starts also D5. Checked at the list,
    the claim, every call and renew, the finish and the clock; a failure ends it as an event PC occurrence's (skipped / nothing,
    not told). **Two locks**: a claim names the kind `event` and the check `matched_record`; `GET /me/job-turns` lists such a turn
    only with `?checks=matched_record` (an app of 4b-2 lists `event` turns and would drop one it cannot parse). The turn's
    `source` names the record and `meetingId`. **The minutes it reads**: `JOB_MINUTES_ROUTE` only for `recordId` = the pinned
    meeting (`routeRefusal`'s `meetingFound`), checked after the conditions; any other meeting → 403 `NOT_IN_STEP`.
  - **The rollback floor** (4b-0.5) knows no schema 5: the occurrence is frozen there (not listed, told, claimed, run or expired;
    a stop holds it), the mark untouched — `server/tests/cross-build/` S1.
- **How a run ends: the judgement, its やること or notice, and corrections** (4b-4 PR3; owner memo §5 / §5-0 / §5-1 / §5-2,
  I6 / I8, T12 / T15 / T17; `job-runs.ts` `finishSet`, `job-set-watch.ts` `setWatchTaskInput` / `ownSetOccurrence` /
  `setDeclinedNotice`, `job-retry.ts` `feedback`):
  - **The report** (`POST /ai-runs/:runId/finish { outcome: 'done', jobResult }`, `parseJobSetReport`): `{ decision: proceed |
    decline | ask, reason, confidence, unconfirmed?, updates? }` — `reason` one of the **pinned** definition's `decision.reasons` codes, a
    number 0–1 stored in hundredths, `unconfirmed` 0–5 distinct words of `JOB_SET_UNCONFIRMED` (人数・予算・企業規模・助成金・月額;
    fixed words: a free code could carry a name) and none with `decline`, `updates` (PR3b) an integer 0–`JOB_SET_UPDATES_MAX` (20;
    absent = 0) — or exactly `{ decision: 'gate_failed' }` (no count either; the app's
    gate could not judge; the server stores ACB's own `GATE_UNAVAILABLE`, never one of the Skill's). **Any other key** —
    `evidence` (the quotes stay on the PC: the app checks them, PR5), a title, a summary — and an unknown reason → 400
    `JOB_SET_REPORT_BAD`, the whole finish rolled back, the run still running; `nothing` → 400 `JOB_EVENT_NOTHING_REFUSED`. The
    conditions again first (a race: rolled back). Kept in `ai_job_set_reports` (one per occurrence, CHECKed kinds; additive in
    `migrateJobSetWatch`) in the finish's transaction; the occurrence `done`.
  - **進める / 人に聞く / 判断できなかった → one やること** (`setWatchTaskInput`): the service writer (not the AI's create, so no
    出どころの枠), id `occurrenceTaskId`, **owner-only** for the responsible person, assignee them, `links.meeting` the pinned
    meeting, quiet (D9), the run's operation key `create_task`. **Its name is the meeting's date only**
    (「11月23日の会議のたたき台を確かめる」, the meeting's `meeting_at` in the occurrence's zone): the やること outlives access to the
    meeting, so no meeting name or customer word is in it (T15); the meeting's name reaches only someone who reads the meeting,
    through the link. **The judgement, its reason and the unconfirmed words are never on it** (T17): only the occurrence's (I8)
    and the PC's.
  - **見送る → no やること, the notice `job_set_declined`** to the responsible person (recordless, key
    `job_set_declined:<job>:<occurrence>`, nothing else stored). Its words — 「「<会議名>」では、AI はたたき台を作りませんでした
    （<理由の言葉>）。…」 — are built **when read** (`setDeclinedNotice` → `jobSetDeclinedOf`), only while the reader is that
    occurrence's pinned responsible person **and** it is theirs to see now (`setOccurrenceShown`: the record and the meeting, one
    of its people); else the notice is not there at all (no row, no unread count). The reason's words are the pinned
    definition's label.
  - **Update proposals** (4b-4 PR3b, owner memo 「4b-4 挟む部分」 §G-1 / §F): the run may leave update proposals (更新案: HubSpot,
    a coefficient sheet…) as files in the responsible person's own `.personal`; the report says only **how many** (`updates`,
    a count — never what they are about). Whether a judgement makes the やること is decided in one place, `setWatchMakesTask`:
    every one does **except a 見送る with `updates` 0** (the notice above, as before). **見送る with `updates` ≥ 1 makes the same one
    やること and no 見送る notice**: named 「11月23日の会議の更新案を確かめる」 (the date only, T15), its description in fixed words
    「AI はたたき台を作りませんでした。更新案が N 件あります。」 (the description stands for the notice); 進める / 人に聞く with a count
    keep the たたき台 name and say 「更新案が N 件あります。」. **Decision for the owner (safe side of T17)**: such a やること tells, by its
    name and description, that the judgement was 見送る — the memo asks for it; the reason, the confidence and the unconfirmed
    words stay off it. Still the responsible person's alone (owner-only, §F #9), one per occurrence (its id), the writer's check
    before the finish (records off → `needs_person` `RECORDS_OFF`: the conditions' C7 already ends it, so the pre-check's own
    `setWatchMakesTask` in `finishTask` is defence — removing it alone fails no test). Stored as `ai_job_set_reports.updates` (additive in
    `migrateJobSetWatch`, `INTEGER NOT NULL DEFAULT 0`, CHECK 0–20 and 0 with `gate_failed`): a row from before reads 0. On the
    responsible person's own view `report.updates`. **Compatibility**: the build before (PR3) refuses the key (`JOB_SET_REPORT_BAD`,
    the run stays running and goes to a person — the app sends it from PR5 on, `job-report-tool.ts`); the rollback floor freezes
    the occurrence, so a report with or without a count is a missing run's 404 there, nothing made
    (`server/tests/cross-build/` 2-floor, on a run step 1 claimed).
  - **Corrections** (§5-2): `POST /me/job-occurrences/:occurrenceId/feedback { kind }` — `made_anyway` (［作ってもらう］ after
    見送る), `too_early` (［まだ早かった］ after 進める / 人に聞く), `went_ahead` (仕上げた after 人に聞く); `jobSetFeedbackFits`, else 409
    `JOB_FEEDBACK_NOT_FOR_DECISION`; no judgement yet → 409 `JOB_FEEDBACK_NO_REPORT`; another kind → 400 `BAD_FEEDBACK`. **Only
    the pinned version's responsible person while the occurrence is theirs to see** (`ownSetOccurrence`, I8) — anyone else, an
    owner / admin who did not attend, alice once off the meeting, another company's or no occurrence: the one 404
    `JOB_NOT_FOUND` (permission matrix row + `CROSS`). `ai_job_set_feedback` keeps the occurrence, the kind and the time only
    (no who column, once per kind: 201, again 200 `recorded: false`). **Not anonymous in storage**: only the pinned responsible
    person can write a row, so a join through the occurrence's version names them; 「人ごとに数えない」 is a promise of the readers —
    no route or screen may group corrections by person (independent review of PR3; the owner decides before PR7 reads it). Cancelling the やること on ［まだ早かった］ is
    the app's (PR6), with the records API. **For PR5 / PR6** (independent review of PR3b): ［作ってもらう］ after a 見送る **with
    update proposals** — that occurrence already has its やること (`occurrenceTaskId`), so whatever makes the たたき台 must not make
    a second やること under that id (update it, or make it elsewhere). The judgement and the corrections kept are on the responsible person's own
    `GET /me/job-occurrences` (`report`, only while shown — `reportOf`'s own check is defence: `mine` already leaves out an
    occurrence not shown, so removing it alone fails no test); never on an owner / admin's occurrence view.
  - **What the AI can still choose** (independent review of PR3): the fixed kinds carry about 18 bits a run (decision, reason,
    confidence in hundredths, unconfirmed words; PR3b adds about 4 more, the count) to the responsible person's own view — no free text. A `failed` finish's
    `failure.code` (`[A-Z0-9_]{1,60}`, older than this PR) is stored on the run and hidden from others (`hides`); PR5 should
    send only fixed codes there.
- **The app runs it** (4b-4 PR5; owner memo §4-4 / §5-0 / 付録 B2 / C2, 「本体を動かさない見直し」 §F / §G and its シナリオ集 S9 / S11;
  `client/shared/ai-turn-steps/set-watch.ts` (pure), `client/electron/features/ai-turns/job-runs.ts` (the runner's set branch),
  `set-watch-run.ts` (the files), `set-watch-tools.ts` (the two tools)). The same runner as every PC job ("The app's runner": claim,
  fail closed, the last check, the deadline, one at a time) with these additions:
  - **Two locks, named only by an app that runs it**: `GET /me/job-turns?…&checks=matched_record` and the claim's `checks` add
    `matched_record` only when main was given the set watch's file work (`JobRunDeps.setWatch`); without it a listed set turn is
    `not-allowed` with no server call. The turn is parsed in a schema-5 frame (`SET_FRAME`: the one opened combination and a
    stand-in reason — the turn carries neither; the reasons are read from the pinned `decision.json`); an event turn naming a
    `meetingId` without `matched_record`, or `matched_record` without one, is dropped.
  - **Before any AI** (`prepareSet`), in this order: every department folder it names (the procedure's, the read Skills', the
    write place) is a real folder on this PC with no link on the way, else `bad-input` `DEPARTMENT_NOT_HERE` (a person is told;
    4-T11); **the gate** (`DecisionGate`, §5-0: `CLAUDE_IN_RUN_GATE` today — the run's own AI judges inside the run; a later
    local model is a new gate, never part of the definition or the consent) answering `failed` → a PC record, then the finish
    `{ decision: 'gate_failed' }` alone: no draft, no copy, no file check, never Claude instead; **the pinned copy**
    (`makeCopy`): both pinned trees (`run.procedure` and `grant.reads.skills`) read from git (`ls-tree -r` of the pinned tree,
    `cat-file blob`; never the working tree, no lazy fetch) into `<userData>/job-skill-copies/<company>/<occurrence>.<generation>/
    <place>/.claude/skills/<skill>/`, files read-only (0444), links (`120000`) and sub-repositories never copied, ≤ 2,000 files /
    100 MB; a tree not here → `temporary` `PROCEDURE_NOT_HERE` (I9, 4-T10). `SKILL.md` and `decision.json` come from that copy.
    Copies an earlier launch left are removed before this launch's first listing.
  - **Reads** (`setWriteArea`, the write guard's `readArea` + `readOutside`, `chat-write-guard.md`): the grant's read paths,
    `<place>/.personal/<folder>/` whole (earlier proposals, read only), and the copy — the one folder outside the company folder,
    as written and as resolved (another run's copy, the app's other data, a link out of the copy: refused, 4-T26). Claude Code
    gets the copy as `additionalDirectories` (`unattended.readDirs`).
  - **Writes only in the run folder** (I1, 4-T6 / T12 / T21 / T23): `proposal_folder { company, meetingDate? }` makes
    `<place>/.personal/<folder>/<YYYY-MM-DD>_<company>` (`runFolderName`: the department folder rule, other characters `_`,
    ≤ 30; the day the AI gives, else the event's local day) **new for each claim** — `_2`, `_3`… when the name is taken, never
    reused; asked again in the same claim, the same folder — with `.acb-job.json` (occurrence, run, generation only) and a PC
    record `working`. Before it is made nothing is writable; afterwards only that folder (`writeArea.run`, read live).
  - **The report** (`job_report { decision, reason, confidence, unconfirmed?, evidence? }`, only in that consultation; the
    time job's `job_report` is not offered there), in this order before anything is sent (B2): ① the reason against the pinned
    list and the server's own parser (`parseJobSetReport`), every `evidence` quote found in the minutes this run read
    (`quoteAppearsIn`; the record tools tell main each fresh `minutes_read` of the pinned meeting — `onMinutesText` — and a
    quote without minutes read, or another meeting's, is refused: I7, 4-T9); ② 進める / 人に聞く: the four files there
    (`SET_WATCH_DRAFT_FILES`, plain non-empty files), the draft's images copied (`assets/<name>` only when the name is a plain
    one the pinned `tools/assets/` lists; into the run folder's own `assets/` — a real folder, never a link —, never over a
    file there: 4-T22 / T24); the update proposals counted from `更新案.json` (below); ③ the PC record
    (`<userData>/job-set-runs/<company>/<occurrence>/<run>.<generation>.json`: decision, reason, confidence, unconfirmed,
    evidence, images, folder, `updates`, `updatesFile`, `minutesDocVersion`) written through a temporary file and a rename and
    **read back** — not kept → nothing is sent, the AI is told 「この PC に結果を書き残せなかった…」 and settle gives the run back
    `temporary` `PC_RECORD_NOT_KEPT`; ④ then the finish with `setJobResult`: the fixed kinds only — no quote, company name,
    folder or path (I6) — and `updates` only when ≥ 1. Any refusal in ①–② is the tool's answer (the AI fixes it); nothing is
    finished twice; the copy is removed after ④.
  - **The update proposals' file** (§G, S9 / S11 #11; the card that applies them is PR6): `更新案.json` in the run folder,
    `{ "版": 1, "会議": <the pinned meeting>, "更新案": [{ 書き先: hubspot | 係数表, 取引, 項目 (HubSpot: 確度・金額・計上月・次のアクション・
    商談の記録・取引を作る; 係数表: one line ≤ 40), 値 (text ≤ 2,000, a number, or [{ 月: YYYY-MM, 金額 }]), 根拠? (found in the
    minutes), 理由? }] }` — ≤ 20 items, each 取引 + 項目 once (with the meeting, the key a later apply tells duplicates by — never
    "the same day"), ≤ 64 KB (`parseUpdateProposals`). **The app counts, the AI does not** (the tool takes no `updates`). A file not
    of the shape: the AI is told once what is wrong; reported again unchanged, the run ends with none counted (`updatesFile:
    invalid`, never a broken file counted). An older server (before PR3b) refuses a finish with `updates` (`JOB_SET_REPORT_BAD`):
    the AI is told it was not made, the record says `refused`, and the run ends at its deadline for a person (safe side).
  - **The minutes' version** (S11 #8, T7): the `docVersion` the run's `minutes_read` answered is kept on the PC record
    (`minutesDocVersion`); null when the run read no minutes or the answer did not say — PR6 then says 「確かめられません」, never
    「変わっていません」.
  - **A lost answer** (B2 ④): a record left `sending` is looked at on each listing (≤ 5 a pass): the run (`GET /ai-runs/:runId`)
    at a later generation → `not_adopted`; `done` at this generation → `sent`; anything else stays `sending`. **Known gap**: a
    「もう一度」 pressed after the lost answer also closes this generation `done`; the server does not yet say which finish it took
    (B2's "the finished generation on the run's answer" is a server follow-up).
  - **What the person can be shown** (for PR6; nothing here is a screen): per run on this PC, its record's state — `working` (the
    folder made, nothing reported: the app quit or the run stopped mid-way — 「途中」, the folder kept and never written again),
    `sending`, `sent`, `refused`, `not_adopted` — with its folder. The app closed past the occurrence's wait: the server expires
    it and tells the person (as any event PC occurrence); a re-claim or 「もう一度」 makes a new generation and a new folder. Two
    meetings at once: two occurrences, run one after the other (never side by side, the server's `JOB_EARLIER_RUNNING`), each with
    its own folder and record.
  - Tests: `client/tests/job-set-watch-run.test.ts` (on a real git repository and folders), `client/tests/ai-turn-unattended.test.ts`
    (the copy as `additionalDirectories`). Mutation check: see the PR.
- **Telling the record by its kind** (§2-2): `task_kind` is written by the minutes service only — a person's or an AI's
  create naming it is 400 `BAD_VALUE` (`record-engine/create.ts`), and no action takes it as an argument.
- **Compatibility** (T11): an older server (the floor, 4b-0.5, and every build before this) does not know schema 5 and
  freezes such a version ("Shapes this build does not know"); the server's tests of an unknown shape stand in `schema: 6` since
  this PR (`job-schemas.test.ts`, `job-rollback-floor.test.ts`, `admin/tests/job-screen-schemas.test.ts`,
  `client/tests/job-screen-schemas.test.ts`). An older app parses a turn in schema 1 / 3 frames, which refuse a department
  Skill (none is listed anyway). The admin form has none (`formFromDefinition` throws on one; `editableDefinition` never
  hands it one).
- Tests: `server/tests/unit/job-set-watch-definition.test.ts` (words key by key, a combination not opened, a line taken
  out, each piece schema 5's alone and schema 5 only those, the Skill pins, `decision.json`, the consent and schemas 1–4's
  sha256, the places, the words) and `server/tests/integration/job-set-watch.test.ts` (on a real bare repository: the pins and
  reasons replaced, missing Skill / reasons / folder, a combination not opened at save, approval, acceptance and resume, one
  per responsible person, the step setting and the requests closed without a time condition, a changed Skill, older screens,
  no occurrence made without a matching record, `task_kind` refused). Mutation check: see the PR.
- Tests (PR2): `server/tests/integration/job-set-watch-scan.test.ts` (the event: one occurrence and its mark, reopened / read again
  / two ticks nothing more, a mark of any job blocks, a task not made by the intake or not under the meeting's id, the meeting's
  own review whose first version another writer made or made as another kind, a run's row, first completed by a run then by her,
  completed before and reopened, made for bob and handed over; the guards: hers when made but handed to bob at the event, no
  longer one of the meeting's people when completed, no outside attendee, a folder meeting, read before the acceptance — also
  its review made after —, a NULL delivery number on the meeting's first reading or on the review's making, a step busy,
  paused, the day's limit and its one notice naming its day and no meeting, no longer shown to an admin who was its responsible person once
  it is handed over; bob's record unmarked; the owner who did not attend sees no
  occurrence nor last one, an attendee taken off the list neither (also in 「AI が動いた回」), nor one who still reads the
  meeting through a group but is not one of its people, expiry told to the responsible person only; 「もう一度」 and `GET /me/job-occurrences`; the two locks and the
  list's `checks`, the turn's meeting, one meeting's minutes only, the conditions ending it; an older build's change moving
  the boundary; a line taken out, and nothing from meanwhile run once it is back),
  `server/tests/cross-build/` (S1: the floor freezes it, back here unchanged). Mutation check: see the PR.
- Tests (PR3): the same file, "the judgement reaches the server as fixed kinds only" (an undeclared reason, `evidence` / a title /
  a summary, the unconfirmed words and 見送る, confidence 0–1, `nothing`, the hundredths), "進める / 人に聞く / 判断できなかった" (owner-only,
  the meeting linked, the date-only name, nothing of the judgement — also after she leaves the meeting; `gate_failed`'s one shape),
  "見送る" (no やること, words built when read, not shown nor counted once she is off the meeting, never to anyone else),
  "corrections of a judgement" (who, once per kind with no who, fits the judgement, her own view's `report` gone once off the
  meeting), and the T9 test (dropped, not run late). Mutation check: see the PR.
- Tests (PR3b): the same file, "updates is a small count only" (a string, a fraction, a negative, 21, null, a list refused; 20
  kept) and "gate_failed carries nothing else" (the parser); "update proposals (PR3b…)" (見送る with a count: the one owner-only
  やること, its date-only 更新案 name and fixed description, no 見送る notice, nothing of the reason — also off the meeting; 見送る
  with 0: the notice only; 進める with a count: the description and `report.updates`; records off — one やること per occurrence
  is PR3's: the task id from the occurrence, the report's primary key and the run's own end, no new test);
  `server/tests/unit/jobs-schema.test.ts` "a set watch’s report count" (a row from before reads 0; the CHECK); and
  `server/tests/cross-build/` (2-floor: the floor answers a report with a count 404 on a run step 1 claimed, nothing made).
  Mutation check: 17 mutations (the parser's key, integer, bounds and `gate_failed`; `setWatchMakesTask` both ways and in
  `finishSet`; the description, the name, owner-only; the stored and viewed count; the CHECK, its `gate_failed` half, the
  default) — each fails a test except `finishTask`'s pre-check (defence, above).

## Member proposals (「AIへの相談」から定期の仕事, PR A: the server; owner memo 2026-11-22 第1〜5版, decisions Q1–Q4)

A member asks their AI for a time job; the AI makes a **candidate** the server builds, the member presses 「管理者に出す」, an owner /
admin approves it (or it is withdrawn / returned), and the proposer still presses 「受け取る」 ("Approving is not accepting"). Only
existing Skills (Q1), every member (Q2), at most 5 waiting per member (Q4); "ask after 3 repeats" (Q3) is the app's (PR D, "Asking
after repeats (PR D)" below). The
admin console announces schema 4 since PR B ("The admin console (PR B)" below), the app since PR C ("The app (PR C)" below); an
app before PR C sees such a job as one it cannot show (`JOB_NEEDS_NEWER_SCREEN`, also for the proposer's 受け取る).

```
GET  /api/records-ai/job-proposals-ai/places?under=   the member's AI: the existing folders under `under` they read (+ write)
POST /api/records-ai/job-proposals-ai/candidates      (act) { skill, trigger, check, reads, deliverable, readRecords, mailDrafts, minutes, missed } → 201
GET  /me/job-candidates/:candidateId                  the session: the caller's own candidate (and its proposal once submitted)
POST /me/job-candidates/:candidateId/submit { fingerprint }   the session → 201 (200 when submitted already)
POST /me/job-candidates/:candidateId/discard          the session: 「やめる」, the creator's own not submitted yet (again: the same)
GET  /me/job-proposals                                the caller's proposals
POST /me/job-proposals/:proposalId/withdraw           the proposer, only while submitted
GET  /job-proposals?state=                            owner / admin
POST /job-proposals/:proposalId/return { reason }     owner / admin, a fixed reason code (JOB_PROPOSAL_RETURN_REASONS), only while submitted
```

Code: `shared/core/job-proposals.ts` (ids `jc.` / `jp.` + 32 hex, limits, states, return reasons and words,
`parseJobCandidateInput`, `proposalDefinition`, `proposalJobName`), `services/job-proposals.ts`, `routes/job-proposals.ts`, tables
`ai_job_candidates` / `ai_job_proposals` (additive, behind the `jobs` handle), and in `services/jobs.ts` the rules of a proposal's job.

- **A candidate** (owner memo §8-3 / §10-1): from a consultation's record token only — **a token bound to any execution run is
  refused before anything is read** (403 `JOB_PROPOSAL_NOT_IN_RUN`: nobody watches those). **This check is the only guard** for a
  business plugin step's run and for a record's 「AI の番」 run claimed by an older app (the route scope applies to neither:
  `ai-runs.ts` `routeRefusal`); a scheduled job's run is also refused first by its grant's route ceiling (`NOT_IN_STEP`). The
  route hands the service the token's run (`h.run`). The responsible person is the
  signed-in member, fixed **before** the Skill is read (no key can name anyone; a shelf Skill is read as theirs). **No free text**:
  every key from a list (an unknown key → 400 `BAD_JOB_CANDIDATE` `UNKNOWN_KEY`: no name, folder, title words, responsible person);
  `check` is `new_files` (a place) or `new_meetings` **without title words** (an owner / admin may add them later by an edit);
  the name 「<Skill>（<いつ>）」 (`proposalJobName`) and the deliverable folder `job-<8 hex of the candidate id>` are the server's.
  Places (reads, the check's place, the deliverable's place): never a hidden segment (`.claude`, … → 400); **existing folders the member reads** — the deliverable's also one
  they write — one answer for missing / unreadable / not writable (409 `JOB_CANDIDATE_PLACE`, naming nothing); the places route
  lists only readable, non-hidden folders (an unreadable private folder never named; `permissionEditor.subfolders`, unfiltered,
  filtered by the member's reader — **read again after the repository is asked** (Codex 4th pass: the membership and scopes
  reloaded after the existence / listing awaits, the parent and every child checked again, so a folder made private or a reader
  removed meanwhile is never named; a candidate's places likewise, and the approval's `rightsFit` runs inside the candidate's
  write). In a company **without the shared folder** a place exists only when its parent's listing
  names it — a department, or a place set up inside one (a scope with rules) — never any text below a department, which
  `permissionEditor.folderExists` would answer for permission rules (Codex re-review: free text into a proposal); `composition.ts`
  `placeExists`. A Skill that is not there → 409 `JOB_SKILL_MISSING` 「先に Skill を作ってから」 (Q1). The
  server pins the Skill (tree / shelf version) now, builds the definition (`proposalDefinition`: `records`, `creates: ['task']`,
  the record reads / minutes route / mail drafts only as chosen, `runsPerDay` 1) and parses it with the one parser (schema 4).
  Kept for its creator alone (`created_by` in SQL: another member's, another company's, an expired one answer the one 404) and
  **read again when read** (`GET /me/job-candidates/:id`, Codex review of PR A): a place it names — or its shelf Skill's place —
  that the member no longer reads (`jobs.readsAllFor`, the view's own rule) withholds it, content and fingerprint, as the same 404,
  24 hours (`JOB_CANDIDATE_TTL_MS`; content deleted when anyone's next candidate is made), at most 20 live a member (checked
  before and inside the write). Never a job: no job list, detail or version history shows it.
- **「やめる」** (owner decision 2026-11-22, `discard`): the session only (a record token alone is not signed in, 401); in one
  transaction: a candidate already submitted → 409 `JOB_CANDIDATE_SUBMITTED` (its proposal unchanged: 「取り下げる」 ends it);
  the creator's live candidate (another member's, another company's, a missing or an expired one: the one 404) is marked
  discarded — **no schema change**: its row stays until its 24 hours with the mark `discarded` in place of its fingerprint
  (`adapters/sqlite/jobs.ts` `DISCARDED_MARK`, never a `sha256:` value, so no fingerprint sent matches it; the floor build
  has no such table, PR A's build would refuse every submit of it) — and answers `{ discarded: true }`, again the same. Then
  the candidate's view answers 410 `JOB_CANDIDATE_DISCARDED` (naming nothing it held) and the submit the same, also when
  「やめる」 lands while a submit awaits the Skill (checked again inside the submit's write); after its 24 hours it is gone as
  any (the one 404). Still counted among the member's 20 live candidates until then (the safe side).
- **The zone** (owner decision 2026-11-22): the candidate's view says `timeZone` — the company's zone as the clock uses it
  (`JobProposalDeps.timeZoneOf`, today `DEFAULT_COMPANY_TIME_ZONE` for every company: there is no per-company setting yet) —
  additive and optional; an older app ignores it.
- **The submit** (the session only: no record-token route reaches it — a record token alone is not signed in, 401):
  `{ fingerprint }` exactly; the candidate **as stored**, never resolved again; **first** whether the member still reads every
  place it names (its shelf Skill's place too: `readsAllFor`) — else 409 `JOB_CANDIDATE_PLACE` whatever fingerprint was sent, as
  the candidate's own view withholds it (Codex 3rd pass: no guessing oracle) —, then the fingerprint the card showed (409
  `JOB_VERSION_FINGERPRINT`); the places and the Skill checked again (`JOB_CANDIDATE_PLACE`, `JOB_SKILL_CHANGED` → ask the AI for a
  new candidate); then **one transaction**: the idempotency record again, the member's rights (`jobs.rightsFit`, the approval's own
  check → 409 `JOB_GRANT_EXCEEDS`), at most `JOB_PROPOSALS_WAITING_MAX` (5) `submitted` (409 `JOB_PROPOSALS_WAITING_LIMIT`) and
  `JOB_PROPOSALS_PER_DAY` (10) submits a company day whatever became of them (409 `JOB_PROPOSALS_DAY_LIMIT`), the draft job
  (version 1 = the candidate's canonical text and fingerprint, `created_by` the member), the proposal record and the notices.
  **Idempotent** by `UNIQUE (company, proposer, candidate)`: a repeat (also at once, also after the content's 24 hours) answers
  the first result with `created: false` — no job, count or notice more; with another fingerprint 409. **A proposal's
  `submittedFingerprint`** is answered (to the proposer in every answer — `mine`, the candidate's view, the submit, a withdrawal)
  only while they read every place the submitted version names, the job view's own rule (`fingerprintShown`: owners / admins
  always; else null); a repeat submit then answers `JOB_CANDIDATE_PLACE` whatever fingerprint was sent (no guess confirmed).
- **Its states** (§8-4): `submitted` → `approved` (its first approval) / `withdrawn` (the proposer) / `returned` (an owner /
  admin, a fixed reason code, never text) — one wins: every move is a compare-and-set from `submitted` (`decideProposal`) inside
  its transaction; a loser is told 409 `JOB_PROPOSAL_DECIDED` (with the state) or, for an approval, `JOB_PROPOSAL_CLOSED`.
  Withdraw / return also set the job `retired` (so no build — the floor included — edits, accepts, pauses or runs it). Who: withdraw
  the proposer only (anyone else, another company's id: the one 404 `JOB_PROPOSAL_NOT_FOUND`), return owner / admin (403
  `JOBS_FORBIDDEN` before the body). **The proposer leaving the company** (`companies.removeMember`'s `onMemberLeft`, in its
  transaction, before the jobs' own pause) withdraws their waiting proposals (by the remover) and retires those jobs — nobody could
  approve or accept them; no `job_paused` is told for them.
- **A proposal's job in services/jobs.ts** (§8-2 / §10-2 / 第5版): `POST /jobs` never makes schema 4 (409 `JOB_PROPOSAL_ONLY`, whatever
  the screen announces); `PUT` keeps every version of a proposal's job schema 4 and makes no other job one (409
  `JOB_PROPOSAL_SCHEMA`), needs `baseVersion` for a proposal's job (400 without; accepted and checked on any job) and refuses a
  stale one inside the write (409 `JOB_VERSION_NOT_LATEST`); approval of a proposal's job needs the fingerprint (400 without) and
  the newest version (409 `JOB_VERSION_NOT_LATEST`), and inside the write — after the asynchronous Skill check — the newest version
  again and the proposal: `submitted` moves to `approved` (the first approval), `approved` lets a later version be approved as any,
  `withdrawn` / `returned` refuse (`JOB_PROPOSAL_CLOSED`, also for an edit under way). **Its responsible person stays the
  proposer** (owner decision 2026-11-22): an edit naming anyone else is refused inside the write (409
  `JOB_PROPOSAL_RESPONSIBLE_FIXED`, 「…責任者を変えられません…新しく定期の仕事を作ってください」). Approving still never accepts. A screen that
  announces `1,2,3` (the app until PR C, an admin tab from before PR B) gets `JOB_NEEDS_NEWER_SCREEN` for its approve / edit of a
  schema-4 job (the old-tab rule). `JobView.proposal`
  (additive): `id`, `proposerId` (stored), `submittedVersion`, `state`, `returnReason`.
- **Notices** (第5版 10-5): `job_proposal` (recordless, on by default) to every owner / admin but the proposer (an owner / admin's
  own proposal is not told to themself) in the submit's transaction, **one row
  per recipient** (its own id; `dedupe_key = job_proposal:<proposal id>`, unique per recipient — a resend adds none), then the
  push to them; text built when read (`jobProposals.proposalNotice`: the job's server-made name, the proposer as the notice's
  actor) and shown only while the proposal is `submitted` and the reader an owner / admin. 「すべて既読」 also reads a new one (as
  for every kind, decided in 第5版); the admin console's list of waiting proposals (PR B) keeps it. **A return is told to the
  proposer** (owner decision 2026-11-22): `job_proposal_returned` (recordless, on by default), written in the return's
  transaction to the proposer only, one per proposal (`job_proposal_returned:<proposal id>`), then the push to them; worded when
  read — 「出した定期の仕事の案「…」は差し戻されました（理由：…）…」 with the fixed reason's words (`jobProposalReturnReasonText`), the
  name by `HIDDEN_JOB_NAME`'s rule — and shown only to the proposer while the proposal is returned. A withdrawal tells nobody.
  The app's notice settings do not offer members the owner / admin-only kinds (`job_proposal`, and the existing
  `job_paused`; owner decision 2026-11-22, done in PR C: "The app (PR C)").
- **The admin console (PR B)** (`admin/src/components/jobs/job-proposals.tsx`, `admin/src/lib/job-proposals.ts`, the form in
  `admin/src/lib/jobs.ts`; owner memo §7 B, §6 #9, §8-2, §8-4, §10-2). Everything only shows and asks; the server decides.
  - **「届いた案」** (a card above the jobs, `GET /job-proposals?state=`, waiting first; a filter for 承認した / 差し戻した /
    取り下げられた): each proposal names its proposer **from the stored `proposerId`** (never the job's responsible person), the
    job's server-made name (the jobs list's; 「定期の仕事」 if absent), when, the state in an owner / admin's words
    (`proposalStateText`: 確認を待っています, 承認しました, 出した人が取り下げました, 差し戻しました（理由：<the fixed reason's words>）) and
    「中身を見る」: **the submitted version** (`submittedVersion`, not the newest) in the shared words through the job's detail — so
    the server's hiding holds (`JOB_VERSION_HIDDEN`, `JOB_NEEDS_NEWER_SCREEN`); never a fingerprint — and, when an owner / admin
    made a later version, that it exists. While `submitted`: 「承認する」 opens the job's own approval (the newest version with
    its fingerprint; **never an acceptance**) and 「差し戻す」 one of `JOB_PROPOSAL_RETURN_REASONS` (radio buttons, **no text
    box**; the press off until one is chosen; afterwards the jobs list is read again). A server without member proposals (404)
    shows no card (none can arrive there). The bell's `job_proposal` is the app's; this card keeps every proposal (第5版).
    **The card follows what happened elsewhere** (review L1 / Codex P2 of PR B): after any approval — from the card or from the
    job's row — and after a refusal saying the proposal was decided meanwhile (`proposalDecidedElsewhere`: 409
    `JOB_PROPOSAL_DECIDED` on a return, `JOB_PROPOSAL_CLOSED` on an approval; the jobs list is read again too) the page bumps
    `staleAfter` and the card reads its list again, so a decided proposal never stays shown as waiting with 承認する / 差し戻す.
  - **Which hands made a version** (`proposalVersionText`): the approval says 「第N版：社員が出した版（…さんが出した内容のままです）」
    for the submitted version and 「管理者が直した版（…さんが出したのは第M版です）」 for a later one (only owners / admins write
    versions after it); a version before the submitted one has no words and no line (never a bare 「第N版：」, review L3); the
    job's row 「…さんからの案（<state>）」.
  - **Withdrawn / returned** (`proposalClosed`): the job is retired (no 承認する, 直す off), and the approval and the form — which
    read the job again — say `PROPOSAL_CLOSED_TEXT` and send nothing, also when the list was read before the withdrawal.
  - **Editing a proposal's job**: `formFromDefinition` marks it (`JobForm.proposal`); `definitionFromForm` keeps it schema 4
    with `origin`, a time job run by the PC whatever 「いつ動くか」 / 「すること」 hold; the form offers neither of them nor the
    responsible person (shown as 「…（案を出した人のままです。変えられません）」 — the server would refuse
    `JOB_PROPOSAL_RESPONSIBLE_FIXED`). The edit sends `baseVersion` (the version the form was built from) **only for a
    proposal's job** — a server before member proposals takes `{ definition }` only. That version is **kept with the form when
    it is made** (`JobFormFields`' own state; the form is keyed by the newest version, so a newer version read again builds a
    new form): a version read later is never sent as the base of an edit made on an older one (review L2). `jobEditForm` gives schema 4 the form only
    when it round-trips exactly (as schema 3; otherwise `JOB_FORM_CANNOT_EDIT`), and the grant keeps the edited version's order
    of read places (`JobForm.readsOrder`, new places after them): a proposal lists its reads before the check's place and the
    form put the check's place first, so without it an edit of the name alone would change the consent. The order rule applies
    to every PC job's edit (versions the form made were in its order already; `jobs.test.tsx` 「editing a PC job keeps its read
    places in their order」 guards it for schema 1, review L4 — a schema-3 grant has no check place, so the form's order is
    already its own).
  - **The proposer's 受け取る is in the app**: an owner / admin who proposed it is not offered 「責任者として受け取る」 here; the row
    and their approval say to accept in the app (decision on the safe side, owner memo §1 例1-5). Until PR C the app refuses it
    (`JOB_NEEDS_NEWER_SCREEN`).
  - **Refusals**: the new codes (`JOB_PROPOSAL_ONLY`, `JOB_PROPOSAL_SCHEMA`, `JOB_PROPOSAL_CLOSED`,
    `JOB_PROPOSAL_RESPONSIBLE_FIXED`, `JOB_VERSION_NOT_LATEST`, `JOB_PROPOSAL_NOT_FOUND`, `JOB_PROPOSAL_DECIDED`) are in
    `JOB_SENTENCE_CODES` (fixed Japanese, no name or place); a malformed return body is `JOB_REFUSED_GENERAL`.
  - **Compatibility**: a server without #751 ignores the header's `4`, answers no `proposal` and 404 for `/job-proposals` (no
    card); edits send `{ definition }` as before. On the rollback floor (6760eef3) a schema-4 version is `needsUpdate` (said as
    「画面を新しくしてください」, no 直す / 承認する) and there is no card.
  - Test: `admin/tests/job-proposals.test.tsx`, `admin/tests/job-screen-schemas.test.ts` (schema 4, header `1,2,3,4`),
    `server/tests/integration/admin-contract.test.ts` (the list, a return's route, an edit with `baseVersion` and a stale one).
    Mutation check: 30 guards removed or inverted one at a time (the announced `4`, schema 4's round-trip check, the reads'
    order, the proposal mark read and kept, the shape kept whatever the form holds, the three fields not offered, `baseVersion`
    sent and only for a proposal, closed in the form / the approval / its button / the helper, the row's 受け取る and its words,
    the own approval's note, the stored proposer in the card and the row, the submitted version shown, the return's reason and
    its disabled press, the 404, approve / return only while waiting, the new codes, the version label, the later-version note,
    the return's words); each fails a test. Not alone: the approval's own `closed` check in `approve` (behind the disabled
    button). After the independent review and Codex: 11 more (the card reloading on the signal, an approval bumping it, an
    approval refusal bumping it and reading the jobs, the refusal reported by the dialog, each of the two decided codes, a
    return refusal reloading, the base version kept with the form, no bare version line, the reads' order for schema 1 alone
    with `jobs.test.tsx`); each fails a test.
- **The app (PR C)** (owner memo §1 例1 / 例3, §6 #3 / #4, §8-3, §8-6; "ask after 3 repeats" is PR D). Everything only shows
  and asks; the server decides.
  - **The AI's tools** (`client/electron/records/job-proposal-tools.ts`, merged by `createRecordTools`): `job_proposal_places
    { under? }` (`GET /job-proposals-ai/places`) and `job_proposal_create` (`POST /job-proposals-ai/candidates`, the candidate
    input as `parseJobCandidateInput` takes it — the zod schema mirrors it, the server checks again). **No submit tool.**
    Their words: existing Skills only (none fits → 「先に Skill を作る必要があります」 and stop), folders only from the places
    tool (an unreadable one is said before a candidate), no titles / quotes / names, mail drafts only, no event jobs, always a
    check, never 「毎回必ず動きます」, and that the candidate is not sent — only the member's press does it. **Offered only where
    a person is present**: `RecordToolsOptions.jobProposals` — the chat server passes `!aiTurnStep && !requestedPluginStep &&
    !stepArea && !requestedStep` (no 「AI の番」, job run, plugin step run or step consultation) — **and** an `act` token **not
    bound to a run** (`RecordTurnAccess.boundToRun`, set by `records/api.ts` from `runOf`); the server refuses a run-bound
    token too (`JOB_PROPOSAL_NOT_IN_RUN`). Codex (read token) gets neither. A server without #751 (404 without a job code) →
    the AI is told 「この会社のサーバーでは、まだ定期の仕事の案を作れません」 (`JOB_PROPOSALS_NOT_SUPPORTED`), no card.
  - **The card** (`client/shared/job-proposals.ts`, `src/features/chat/components/JobProposalCard.tsx`, store
    `jobProposalStore.ts` + `hooks/useJobProposal.ts`, loaded on first subscribe — no effect): the reply holds only a
    reference (data part `data-job-proposal`, `JobProposalCardRef` with the candidate id **the server answered**, never the
    AI's input; stored with the message as `jobProposals`, in `cardOrder`), and the card reads the candidate with the
    member's **session** each time it is shown — **never a cache across showings** (review of PR C, Codex P2):
    `src/shared/lib/jobProposalStore.ts` (shared by the card and 「出した案」) keeps an answer only while a card shows it, drops it
    when the last card goes (a reopened conversation reads again: an approval / return since, a candidate withheld since),
    keeps a failed read only on screen with 「読み直す」 (`reloadJobCandidate`), and a 「取り下げる」 in 「出した案」 makes a card on
    screen read again (`jobCandidateChanged`; a read on its way is followed by one more). **A read never overwrites the
    member's newer act** (Codex re-review): each read and each act on the card (submit, withdraw, discard: `putJobProposal`)
    takes the next number for its candidate, a read's answer counts only while its number is still the newest, and after an
    act the server is read once more (IPC `jobProposals:candidate` → `GET /me/job-candidates/:id`): only a
    definition the one parser reads as schema 4 with a `sha256:<hex>` fingerprint and the asked id is shown
    (`readShownCandidate`) — anything else is not shown and cannot be submitted. It says (§8-6, `jobCandidateLines` over the
    shared job words): when it checks, with the zone by name (`jobTimeZoneText`: Asia/Tokyo 「日本時間」 and other common zones in
    words, any other 「時間帯 <id>」; the server's `timeZone` kept only as a zone id; absent from an older server 「（会社の時刻で）」), what makes it run, what it does (the member is the responsible person),
    the grant's lines (tools, read places, the deliverable place, what it may make, the minutes route, mail drafts only, the
    limits — 1 run a day), missed runs, the deadline, and the notes (`JOB_CANDIDATE_NOTES`): nothing runs before an admin's
    approval and their own 受け取る, it runs only when something is new, the company's settings or their own 「AI が自動で進める」 (`WORK_SWITCH_NAMES.autoRun`, the name 自分の設定 shows) may
    stop it, an admin may change name / time / check (a new 受け取る only for a new consent). Never 「必ず毎週動きます」.
    「これで管理者に出す」 sends **the candidate's id and the fingerprint shown** (`jobProposalCardState`'s `submit`; IPC
    `jobProposals:submit` → `POST /me/job-candidates/:id/submit { fingerprint }`); 「やめる」 discards the candidate on the server
    (`jobProposals:discard`, session only; owner decision 2026-11-22): the card then says 「この案はやめました…」
    (`JOB_CANDIDATE_DISCARDED_TEXT`), also when reopened — the server answers 410 `JOB_CANDIDATE_DISCARDED` until the
    candidate's 24 hours, the plain gone message after them; a server before it (404 naming no code) only closes the buttons
    in this view. Afterwards the state (`jobProposalStateLine`: 管理者の確認待ち・まだ何も動いていません / 承認
    されました・「定期の仕事」で受け取る / 差し戻されました（理由：<the fixed reason's words>） / 取り下げました) and 「取り下げる」 only while
    `submitted` (`jobProposals:withdraw`). A refusal that means the candidate or proposal moved on (`JOB_VERSION_FINGERPRINT`,
    `JOB_PROPOSAL_DECIDED`, `JOB_CANDIDATE_NOT_FOUND`, `JOB_CANDIDATE_PLACE`, `JOB_CANDIDATE_DISCARDED`,
    `JOB_CANDIDATE_SUBMITTED`) reads it again. **Gone or withheld** (the one 404):
    main looks for its proposal in `GET /me/job-proposals` by the candidate's id, so a reopened conversation (or one older
    than 24 hours) still shows what became of it; none → 「この案はもう見られません（…24時間たったか、あなたが今は読めない場所が
    含まれています）」 — never which.
  - **The submit is the member's press only**: the handler (`client/electron/features/jobs/proposals.ts`, session cookies) is
    registered by that module alone; no chat-server route, AI tool or record token reaches it; in the renderer only the chat
    card's data layer (`src/features/chat/api.ts` `JobProposalCardPort`) and the card call it. Renderer values never shape
    the path (`isJobCandidateId`, `isJobProposalId`, the fingerprint's shape, the company id).
  - **The chat server's flag fails closed** (review L3): the step lookup (`stepWriteArea`) is asked whenever it exists — also
    without a write guard — and a lookup that threw or rejected (a timeout) counts as a step: no tools.
  - **Refusals** are the app's fixed words by code (`jobProposalRefusalText`: #751's codes, `JOB_NEEDS_NEWER_*`), an unknown
    code a general sentence — never the server's text; a proposal's `submittedFingerprint` is kept only as the server
    answered it (`readProposalView`: withheld → null, never shown anyway).
  - **「定期の仕事」** (`src/features/jobs/components/JobProposals.tsx`, `hooks/useMyJobProposals.ts`, `model.ts` `proposalRows`):
    「出した案」 from `GET /me/job-proposals` (`jobProposals:mine`; a server without it, 404 → nothing shown), each with the
    job's name from this member's jobs list (a retired one → 「定期の仕事」), when it was sent, its state and 「取り下げる」 only
    while it waits. After approval the existing 受け取る works for schema 4 (`APP_JOB_SCHEMAS` `[1, 2, 3, 4]`), also for an
    owner / admin who proposed it.
  - **Notices**: `job_proposal_returned` shows the server's words and opens 「定期の仕事」 (`jobNoticeTarget`, badge 「差し戻され
    ました」); `job_proposal` (an owner / admin's) opens nothing in the app. 「知らせの設定」 offers `job_proposal` / `job_paused` /
    `company_restored` only to owners / admins (`ADMIN_ONLY_NOTICE_KINDS`, `company_restored` by owner decision 2026-11-22, `noticeKindsForRole`; the role from `api:getCompanies`, not known →
    not offered; `notifications.md`).
  - **Compatibility**: a server without #751 — the tools answer 「まだ作れません」, no card, no 「出した案」; the header's `4` is
    ignored. The rollback floor (6760eef3): the same (no proposal routes), and a schema-4 job there is `needsUpdate` — the
    app's list says it cannot show it, as for any shape a server withholds.
  - Test: `client/tests/job-proposal-tools.test.ts` (offered / not offered: the flag, a read token, a run-bound token; the
    chat server's flag for a consultation, a job run, a built-in 「AI の番」 step and a step consultation, and failing closed; the card's id from the server; a 404; no file
    but the session module names the submit route or registers its IPC, only the card calls it), `job-proposals-ipc.test.ts`,
    `job-proposals-card.test.ts` (the press's values, states, the §8-6 words, stored / restored in order),
    `src/shared/lib/jobProposalStore.test.ts` (no failure sticks, re-read on reopen, 読み直す, a withdrawal elsewhere, a read on its
    way answered after a submit / withdrawal / discard),
    `job-screen-schemas.test.ts` (schema 4's words, header `1,2,3,4`), `jobs-ipc.test.ts`, `src/features/inbox/model.test.ts`,
    `src/features/jobs/model.test.ts`. Mutation check: 36 guards removed or inverted one at a time, then 12 after the reviews (the store's six, the settings keeping
    `fullAccess`, the flag's fail-closed lookup — its failure mark, the synchronous throw, asked without a guard —, the built-in
    step), then 3 for the read / act order (the read's number checked, an act taking one, the read after an act), then 18
    for the owner decisions (server: the view's and the submit's discarded checks — also inside the write —,
    discard refusing a submitted one and needing the creator's live row, its id check, the mark read and written, the zone,
    the route; app: the 410, a server before it only without a code, the ids, the zone kept as an id, its words and line, the
    discarded state, `company_restored`); each fails a test except the discard's own id check (an id of another shape finds
    no row: the same 404) and
    the forwarding of the flag in `features/chat/server-config.ts` (a pass-through; the option's default is off, so a dropped
    flag offers nothing), and — not node-tested, UI only — the card's 「読み直す」 button and the 「出した案」 hook calling
    `jobCandidateChanged` (the store functions themselves are). Of the chat server's flag, `!aiTurnStep` / `!requestedStep` / `!stepArea` each alone suffice for a
    job run (all three hold), `!stepArea` alone for a step consultation; `!requestedPluginStep` (a step consultation's first
    turn, whose binding is refused or binds it) is defence.
- **Asking after repeats (PR D)** (owner memo 例2 / Q3 / §6 #10: 「同じ頼みが3回続いたら1回だけ聞く。「いいえ」なら同じことは聞かない」;
  `client/shared/job-repeat-asks.ts` the rules, `client/electron/features/jobs/repeat-asks.ts` the store and the turn,
  `chat-server.ts` `repeatAskForTurn`). Only this PC; the server knows nothing of it (no route, no field).
  - **The same work = the same company Skill the AI loaded** (`skillLoadedBy`: Claude Code's `Skill` tool that ran — never
    free text compared). Only a company Skill reachable from the consultation (`locateCompanySkill` answers a folder: not a
    personal one of the same name, not a private folder's, not a missing one). Codex has no Skill tool (and no act token):
    nothing is counted or asked for it.
  - **Counted only where the member is present and the tools are offered**: the chat server connects the turn's Skill sink
    (`withSkillSightings`' third argument) only through `repeatAskForTurn` — the `job_proposal_create` tool really among the
    turn's record tools (the chat server's flag: no 「AI の番」, job run, plugin step run or step consultation; an `act` token
    not bound to a run), not an unattended step, and the turn's tool events reach the sink (`sightings`: a consultation id
    and company folder — without them a loaded Skill could never be marked asked, so the question would come every turn).
    Elsewhere nothing is counted or asked.
  - **Distinct days** (`localDay`, this PC's date): several uses a day count once; at most the 3 newest days are kept.
  - **The question**: a turn on a day when a Skill, not yet asked, was used on 2 **other** days carries a short instruction
    (`repeatAskInstructions`, by folder name only; at most `JOB_REPEAT_ASK_PER_TURN` Skills, **counted after** keeping only
    company Skills this consultation reaches — a removed or out-of-reach Skill never takes a place, Codex review of PR D),
    condition first: only if, for the work the member asked for, the AI loads that Skill in this reply and finishes it, ask
    once at the end `JOB_REPEAT_ASK_QUESTION` (the owner's words, 「この仕事は、これまでにも何度か同じように頼まれています。毎週
    （または毎日・毎月）同じ時間に、定期の仕事としてやりましょうか？」), and never load a Skill for this instruction;
    otherwise say nothing; on 「はい」 confirm when and what makes it run, then PR C's tools (the member still presses 出す); on
    「いいえ」 drop it. **Deviation from "the next turn" (decision on the simple side)**: the question goes with the turn that may
    do the 3rd day's work, so the AI asks right after it (the memo's 例2), instead of a turn after it.
  - **Asked for good**: a turn that carried the question for a Skill **and** loaded it marks it `asked` (whatever the AI said or
    the member answered; never counted again). Marked when the Skill loads, not when the turn ends: a turn stopped or failed
    afterwards is marked too and nothing was asked (fails quiet — never asked twice; decision on the simple side). A turn
    that carried it without loading it marks nothing (it is carried again). Known: two consultations at once on that day may
    both carry it before either marks it.
  - **The switch** 「AI から定期の仕事を提案してもらう」 (設定 → 自分の設定, `JobRepeatAskSetting.tsx`, IPC `jobRepeatAsks:get` /
    `jobRepeatAsks:set`; on unless turned off; per member and company, this PC only): off → no turn is asked or counted and
    the counts are forgotten (the asked marks stay, so turning it on again never re-asks). No reset of the asked marks (owner
    question).
  - **The store** `<userData>/job-repeat-asks.json` (atomic, 0600): `{ version: 1, members: { "<user>/<company>": { off?,
    skills: { <name>: { days } | { asked } } } } }` — Skill folder names and dates only, never a conversation id, text or path;
    read strictly (`readRepeatFile` drops anything else); never logged or sent. Entries are read as own properties only
    (`ownSkill`): a Skill folder name may be an `Object.prototype` name (`constructor`). Nobody signed in → nothing. A file
    that exists but cannot be read or parsed → nothing asked, counted or written over it (an asked mark may be in it) while
    it stays the same file: its identity (device, inode, size, times) is kept, and a later look reads it again once that
    differs (fixed, replaced, removed) — no restart needed.
    Bounded: `JOB_REPEAT_SKILLS_MAX` counted Skills, `JOB_REPEAT_ASKED_MAX` asked marks per member and company.
  - Test: `client/tests/job-repeat-asks.test.ts` (the 3rd distinct day once, same-day repeats, asked never again — also after
    more days —, carried without loading marks nothing, only company Skills, removed Skills never take the per-turn places,
    `constructor` and other prototype-like names, the instruction's order and wording, the switch, per member / company /
    nobody, the store's contents and mode, an unreadable store and its re-read once fixed, the sink only for a loaded Skill,
    `repeatAskForTurn`'s gate — also without sightings —, and the chat server asking only an ordinary consultation with a
    consultation id — not a job run, 「AI の番」, a step or a turn without the tools). Mutation check: 26 guards removed or
    inverted one at a time, 21 fail; after the reviews of PR D (Codex P2 ×2, L1, L2, L4) 33, 27 fail. Not alone:
    `repeatAskable`'s asked check (an asked entry has no days, so the count refuses it), its and `noteRepeatUse`'s off checks
    (no turn is answered while off, and off forgets the counts: defence for a turn that began before the switch), the
    handler's `unattended: !!aiTurnStep` (a step's record tools never include the create tool: the flag is off there), the
    unreadable store kept while unchanged (without it the same unreadable file is read again at each look and still
    refused: cost only); not node-tested: the handler passing the sink to `withSkillSightings` (one line of wiring — each
    half, the sink's call and `repeatAskForTurn` connecting it, fails a test).
- **The rollback floor** (6760eef3, knows `[1, 2]`): a schema-4 job is listed by name only, its versions without definition or
  fingerprints, approve / edit / accept refused (`JOB_SCHEMA_UNKNOWN`), no occurrence made, no `job_proposal` /
  `job_proposal_returned` shown (unknown kinds); it never reads the new tables. Coming back: nothing revived (a withdrawn proposal stays so, its job retired), nothing
  duplicated (the cross-build check, `deployment.md`).
- Test: `server/tests/integration/job-proposals.test.ts` (§9 / §11 / 第5版: another person as responsible, another company's ids,
  rights removed before the submit, unreadable / missing places, a free name / folder / title words, an old fingerprint / version,
  6 submits at once, the three-way race, a run-bound token, a non-session token submitting, candidates absent from admin lists, an
  old admin tab, the first approval and later versions, withdrawn / returned edits, a resend after expiry, 2 admins with their own
  read state), `jobs-definition.test.ts` "a member's proposal (schema 4)", permission matrix + `CROSS`, the cross-build check.
  Also (owner decisions and reviews of PR A): the proposer's return notice, the fixed responsible person, a candidate read again
  when read (a place / the shelf Skill's place lost), hidden segments refused, an owner / admin proposer not told, a leaver's
  proposals withdrawn (through the route), an older app's 「AI の番」 token refused at the route.
  And (owner decisions of PR C): 「やめる」 — discarded never read or submitted again, a submitted one refused, only the creator's
  live one, pressed while a submit awaits, through the route (a record token 401) — and the candidate's zone.
  Mutation check: 52 guards removed or inverted one at a time, then 7 for the owner decisions, 11 after the reviews, 5 after the Codex re-review, 2 after its 3rd pass and 4 after its 4th (the route handing the service the token's run now fails a test of its own); each fails
  a test except — each alone suffices, both removed fail:
  the places' reader / write checks and the approval's own `rightsFit` at the candidate (also their re-reads after the awaits:
  the places' fresh reader and `rightsFit` inside the write); the 20-candidate check before and inside
  the write; the proposal view's owner / admin branch of `fingerprintShown` (an owner / admin reads every place anyway; kept as the
  job view's rule); — behind another guard: the pre-checks `JOB_PROPOSAL_CLOSED` of edit / approve (a
  withdrawn / returned job is `retired`, refused first; the checks inside the write are tested by races); — defence: the stored
  candidate's responsible person compared with the submitter (a candidate is only ever found for its creator).

## Tests (each guard mutation-checked, with the exceptions named)

- Two presses (owner decision 2026-11-18): `server/tests/integration/jobs.test.ts` "approving one's own job is not
  accepting it" (approved, `NOT_ACCEPTED`, `mustAccept`; an acceptance without the header or with another value refused
  `JOB_ACCEPT_SEPARATELY`; the separate one still the responsible person's only, the fingerprint checked, then accepted)
  "an old admin tab re-approving a version someone else approved first", and "the desktop app's 受け取る"
  (`X-ACB-Client-Version` alone goes through); "PR 4" the self-approver's notice;
  `job-occurrences.test.ts` "an owner approving their own job does not run it" (held `NOT_ACCEPTED`, runs after the
  separate press); `job-events.test.ts` "an admin approving their own event job" (no watch until the separate press);
  `admin/tests/jobs.test.tsx` "approving one's own job is not accepting it" and the place-outside row;
  `client/tests/jobs-ipc.test.ts` (the header on every job call). Mutation-checked: the service's guard, the route's
  header value, the app-caller allowance, the route always allowing, the notice's old self-approver exclusion, the admin's
  header, its approval accepting again, the guard narrowed to the version's approver (the re-approval test), the row's button and its place-outside exclusion — each fails a test. The accept
  dialog's own `placeOutside` check is behind the row's (it is never opened for such a job), so removing it alone
  changes nothing.

3b's guards were each removed or inverted alone and the test file failed — except: the runner's early
"still `due`" exit (the compare-and-set and the task id each still stop a second やること), `latest_only`
(by construction: only the newest slot is ever computed, covered by "missed slots" but not a line to
remove), and `OWNER_RIGHTS_CHANGED` at run time (a placement-`e` job of schema 1 names no place, so only
membership can fail).

- `server/tests/unit/jobs-definition.test.ts` — strict parser (unknown keys / values at every level,
  tools and routes vocabulary, no connector reads, paths), what runs where, D6, the consent part, an
  occurrence id never a record id, the deliverable folder's name (the department folder rule).
- `server/tests/unit/jobs-schema.test.ts` — on `tests/fixtures/app-schema-before-jobs.sql` (frozen):
  additive and idempotent, same as a new database; one occurrence per slot; id CHECKs; versions never
  rewritten, approved / accepted once.
- `server/tests/integration/jobs.test.ts` — who may do what; another company's job; append-only and
  pinned approval; acceptance by the responsible person only and only again when the consent changed;
  approval refused for a place the person cannot read (private folder, rule) or a person who left, and
  for a Skill missing or changed; the definition hidden from a member who cannot read it; removeMember
  and a demotion pause and tell owners/admins (and a demoted admin's notice list drops it); pause / resume; the
  company stop.
- `server/tests/integration/job-occurrences.test.ts` (3b) — one occurrence per slot over two runs and a
  restart, none before its time or before approval; only the newest missed slot; expiry when made and
  when run (told to the responsible person and the creator, the notice's text, gone once they may not see
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
  once per version, not for a consent already accepted, the self-approver too (gone after their own 受け取る), gone once accepted /
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
  accept for someone else, never accepts one's own with the approval's press — its 「責任者として受け取る」 is a
  press of its own, sent with `X-ACB-Job-Accept: separate`, not offered for a place outside — and says what will happen; the list's 責任者 is the approved
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
  taken away while preparing → nothing starts and no ceiling; the server's clock for the deadline, the answer's travel
  not counted; "synced?" by `FETCH_HEAD`'s identity against the mark (Codex's case: no fetch since the mark is never
  synced, whatever times the file carries; a fetch bringing nothing new counts; never fetched → the first fetch counts;
  no mark, `FETCH_HEAD` gone → not synced; the mark taken once and kept, not kept when it could not be taken, a new
  one after the occurrence left the list); a working folder's files read on the server's clock, an unknown or far-off
  clock → `CLOCK_NOT_TRUSTED`, never `nothing`, the window widened the right way — 17 mutations, each fails; 「自動で進める」 off →
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
  `recordId` never linked; the finish links the put to its やること — also in a company with the shared folder, only
  that run's own receipts (not a consultation's put, not an earlier run's); a pause refuses the next call; past 90 days: the
  claim and the clock make it `needs_person` `PLACE_NOT_USABLE`, told, and choosing again makes the next one run — the
  clock through the composed `services.serverClock` (`wireJobOccurrences`' `placeUsable`); 「もう一度」 refused
  (`JOB_PLACE_NOT_USABLE`) while the place is not usable and pressed once it is chosen again, through the composed route
  (`wireJobRetry`'s `placeUsable`);
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
