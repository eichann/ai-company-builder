---
paths:
  - "shared/core/jobs.ts"
  - "shared/types/jobs.ts"
  - "server/src/**/jobs.ts"
  - "server/src/db/schema/jobs.ts"
  - "server/tests/**/jobs*.test.ts"
---

# Scheduled jobs (定期の仕事, B 「実行を記録から分ける」)

A job is work that is not a record's turn: 「毎週火曜の1営業日前の 09:00 に」. Design: the owner's memo
「実行を記録から分ける（B）設計メモ」 (2026-11-10, decisions D1–D10 as recommended). Job → occurrence (回)
→ run (`ai_runs`, `subject_kind: 'occurrence'`, `ai-turns.md`).

**PR 3a (this): definitions and approval only — nothing runs.** No clock, no occurrence is written,
no claim, no AI, no app or admin screen. Next: 3b (the clock makes occurrences, the server's (e)
operation, `held` / `expired`), 4 (admin screen 「定期の仕事」, the app's accept button), 5 (the PC's (a)
claim and the grant at every call, design memo §4-2).

## Tables (`server/src/db/schema/jobs.ts`, handle `jobs`, `ports/jobs.ts`, `adapters/sqlite/jobs.ts`)

New tables only (additive; `CREATE … IF NOT EXISTS`, nothing else changes):

- `ai_jobs`: id `job.` + 32 hex (CHECK), name (the newest version's), `state` draft / active / paused /
  retired, `acting_user_id` (the newest version's responsible person), `latest_version`,
  `approved_version` + `approved_fingerprint` (both or neither), `accepted_version` +
  `accepted_consent`, `paused_reason` (`ADMIN`, `BY_RESPONSIBLE`, `OWNER_LEFT`, `OWNER_RIGHTS_CHANGED`) /
  `paused_by` / `paused_at`.
- `ai_job_versions`: **append-only** — `definition` (canonical JSON), `fingerprint` (sha256 of it),
  `consent_fingerprint`, `acting_user_id`, `schema`; triggers refuse any update of those
  (`ai_job_versions_append_only`) and set `approved_*` / `accepted_*` once.
- `ai_job_occurrences`: id `occ.` + 32 hex (CHECK: never a record id's shape — `RECORD_ID_RE` has no
  `.` — so the kept `idx_ai_runs_open` on `record_id` never sees two kinds collide),
  `UNIQUE (company_id, job_id, due_slot)`, `time_zone`, `due_at`, `expires_at`, `state`
  (due / running / done / nothing / needs_person / skipped / expired / held), `run_id`, `outcome_code`.
  **Nothing writes it in 3a.**
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
  scheduled jobs`, before the body). The responsible person (of the newest or the approved version)
  sees their own jobs; for anyone else a job does not exist — the same 404 `JOB_NOT_FOUND` as a missing
  one or another company's (permission matrix rows + `CROSS`). No delegate acts for them (D5).
- **Approval re-checks** (memo §4-3), inside the write's transaction: the responsible person is a member
  now (409 `JOB_OWNER_NOT_MEMBER`) and reads every place the version names (`recordReader(...).file`:
  rules and private folders; 409 `JOB_GRANT_EXCEEDS`, naming no place); a pinned Skill is still the
  company's at that tree (409 `JOB_SKILL_MISSING` / `JOB_SKILL_CHANGED`: make a new version). A
  `fingerprint` that is not the version's → 409 `JOB_VERSION_FINGERPRINT`. Acceptance and an
  owner/admin's resume run the same rights check.
- **Pinned**: approval stores the version and its fingerprint; a later `PUT` adds a version and changes
  neither. `waiting` says why it would not run: `PAUSED`, `COMPANY_STOPPED`, `NOT_APPROVED`, `NOT_ACCEPTED`
  (the approved version's consent ≠ the accepted one).
- **Names never leak**: a responsible person who is not owner/admin gets a version's `definition: null`
  when it names a place they cannot read now.
- **Leaving / rights**: `companies.removeMember` (its transaction, `onMemberLeft`) pauses every job whose
  newest or approved version names them (`OWNER_LEFT`); `changeRole` (`onRoleChanged`) pauses a job whose
  approved version names a place the new role no longer reads (`OWNER_RIGHTS_CHANGED`). Each writes the
  notice `job_paused` (recordless, `notifications.md`) to every owner / admin; its text is built when read
  and shown only while the reader is owner / admin. A permission rule changed elsewhere is not looked at
  here (the run's own checks, PR 5).

## Tests (each guard mutation-checked)

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
- `permission-matrix.test.ts` rows + `CROSS`; `company-scoped-sql.test.ts` (`HANDLE_TABLES`).
