-- What a 4b-1 build (event jobs run by the responsible person's PC AI, owner memo 「段4b 設計メモ」 第4版 §6) leaves in the
-- database, as the rollback floor (4b-0.5) finds it after a rollback: an event job whose approved and accepted version is
-- of a shape the floor does not know (schema 3), its occurrences in every state (one running with a PC run and a Drive put
-- in flight, one waiting past its time, one needing a person with an outside result nobody knows, one held, one done), the
-- runs and their operations, the Drive receipt of a put, the watch with its generation and a stopped chain, and the
-- notices it wrote. Placeholders, filled by the test: {{CO}} company, {{ALICE}} responsible person, {{OWNER}} owner,
-- {{REC}} the watched やること, {{NOW}} / {{PAST}} / {{LATER}} times. A column 4b-1 might add (`ai_job_occurrences.
-- ai_claim_deadline`) is added by the test before loading. Test: tests/integration/job-rollback-floor.test.ts "F11".
-- Frozen: do not update (a later shape is added as a new fixture).

INSERT INTO ai_jobs (company_id, id, name, state, acting_user_id, latest_version, approved_version, approved_fingerprint, accepted_version, accepted_consent,
  paused_reason, paused_by, paused_at, created_by, created_at, updated_at, accepted_place)
VALUES ('{{CO}}', 'job.4b100000000000000000000000000001', '面談のあとの報告書', 'active', '{{ALICE}}', 2, 2, 'sha256:4b1v2', 2, 'sha256:4b1c2',
  NULL, NULL, NULL, '{{OWNER}}', '{{PAST}}', '{{PAST}}', '{"connector":"google","kind":"drive_folder","ref":"folder-1"}');

-- Version 1: a 4a event job (the server makes a やること). Version 2: 4b-1's, run by the PC's AI (schema 3).
INSERT INTO ai_job_versions (company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at,
  approved_by, approved_at, accepted_by, accepted_at)
VALUES
  ('{{CO}}', 'job.4b100000000000000000000000000001', 1, 2,
   '{"actingUser":"{{ALICE}}","check":{"kind":"none"},"grant":{"creates":["task"],"limits":{"minutes":5,"runsPerDay":3},"outbound":"none","reads":{"calls":[],"paths":[]},"routes":[],"tools":[],"writes":{"area":"none"}},"missed":{"expiresAfterMinutes":1440,"policy":"latest_only"},"name":"面談のあとの報告書","placement":"e","run":{"dueBusinessDays":null,"kind":"operation","operation":"create_task","title":"報告書を書く"},"schema":2,"trigger":{"assignee":"responsible","event":"state","followMadeTask":true,"kind":"record","startRecord":"{{REC}}","to":"done","type":"task"}}',
   'sha256:4b1v1', 'sha256:4b1c1', '{{ALICE}}', '{{OWNER}}', '{{PAST}}', '{{OWNER}}', '{{PAST}}', '{{ALICE}}', '{{PAST}}'),
  ('{{CO}}', 'job.4b100000000000000000000000000001', 2, 3,
   '{"actingUser":"{{ALICE}}","check":{"kind":"none"},"done":{"kind":"none"},"grant":{"creates":["task"],"deliverTo":{"connector":"google","kind":"drive_folder","ref":null},"limits":{"minutes":30,"runsPerDay":3},"outbound":"none","reads":{"calls":[],"paths":[]},"routes":["GET /item/:recordId"],"tools":["records","files_write"],"writes":{"area":"deliverable","folder":"報告書","place":"人事部"}},"missed":{"expiresAfterMinutes":1440,"policy":"latest_only"},"name":"面談のあとの報告書","placement":"a","run":{"kind":"procedure","procedure":{"fingerprint":"0000000000000000000000000000000000000000000000000000000000000000","item":"shelf-1","skill":"interview-report","source":"shelf_skill"}},"schema":3,"trigger":{"assignee":"responsible","event":"state","followMadeTask":true,"kind":"record","startRecord":"{{REC}}","to":"done","type":"task"}}',
   'sha256:4b1v2', 'sha256:4b1c2', '{{ALICE}}', '{{OWNER}}', '{{PAST}}', '{{OWNER}}', '{{PAST}}', '{{ALICE}}', '{{PAST}}');

-- The watch: generation 3 (chosen again twice), fired, its chain stopped by the day's limit.
INSERT INTO ai_job_event_cursors (company_id, job_id, seen_seq, watch_record_id, watch_start, watch_fired, job_stamp, stop_stamp,
  chain_stop_code, chain_stop_record, chain_stop_at, updated_at, watch_generation)
VALUES ('{{CO}}', 'job.4b100000000000000000000000000001', 42, '{{REC}}', '{{REC}}', 1, '{{PAST}}', '', 'DAY_LIMIT', '{{REC}}', '{{PAST}}', '{{PAST}}', 3);

INSERT INTO ai_job_occurrences (company_id, id, job_id, job_version, due_slot, time_zone, due_at, expires_at, state, run_id, outcome_code, created_at, updated_at,
  checked_until, checked_commit, retries, retried_by, retried_at, event_seq, event_record_id, event_version, event_day, watch_generation, ai_claim_deadline)
VALUES
  ('{{CO}}', 'occ.4b100000000000000000000000000001', 'job.4b100000000000000000000000000001', 2, 'ev:40', 'Asia/Tokyo', '{{PAST}}', '{{PAST}}', 'running', 'run-4b1-running', NULL, '{{PAST}}', '{{PAST}}',
   NULL, NULL, 0, NULL, NULL, 40, '{{REC}}', 3, '2026-11-20', 3, '{{LATER}}'),
  ('{{CO}}', 'occ.4b100000000000000000000000000002', 'job.4b100000000000000000000000000001', 2, 'ev:41', 'Asia/Tokyo', '{{PAST}}', '{{PAST}}', 'due', NULL, NULL, '{{PAST}}', '{{PAST}}',
   NULL, NULL, 0, NULL, NULL, 41, '{{REC}}', 4, '2026-11-20', 3, NULL),
  ('{{CO}}', 'occ.4b100000000000000000000000000003', 'job.4b100000000000000000000000000001', 2, 'ev:38', 'Asia/Tokyo', '{{PAST}}', '{{PAST}}', 'needs_person', 'run-4b1-unknown', 'RESULT_UNKNOWN', '{{PAST}}', '{{PAST}}',
   NULL, NULL, 1, '{{OWNER}}', '{{PAST}}', 38, '{{REC}}', 2, '2026-11-20', 2, NULL),
  ('{{CO}}', 'occ.4b100000000000000000000000000004', 'job.4b100000000000000000000000000001', 2, 'ev:37', 'Asia/Tokyo', '{{PAST}}', '{{PAST}}', 'held', NULL, 'JOB_PAUSED', '{{PAST}}', '{{PAST}}',
   NULL, NULL, 0, NULL, NULL, 37, '{{REC}}', 1, '2026-11-20', 2, NULL),
  ('{{CO}}', 'occ.4b100000000000000000000000000005', 'job.4b100000000000000000000000000001', 2, 'ev:36', 'Asia/Tokyo', '{{PAST}}', '{{PAST}}', 'done', NULL, NULL, '{{PAST}}', '{{PAST}}',
   NULL, NULL, 0, NULL, NULL, 36, '{{REC}}', 1, '2026-11-20', 1, NULL);

-- The PC runs (subject: the occurrence): one running with its lease, one waiting for a person to reconcile.
INSERT INTO ai_runs (company_id, id, record_id, step, user_id, state, generation, device_id, conversation_id, claim_expires_at, failure_class, failure_code,
  retry_at, attempts, plugin_version, steps_version, created_at, updated_at, closed_at, procedure, subject_kind, grant_fingerprint)
VALUES
  ('{{CO}}', 'run-4b1-running', 'occ.4b100000000000000000000000000001', 'job-procedure', '{{ALICE}}', 'running', 1, 'device-alice-1', 'conv-4b1', '{{LATER}}', NULL, NULL,
   NULL, 0, NULL, NULL, '{{PAST}}', '{{NOW}}', NULL, '{"step":"job-procedure","job":{"id":"job.4b100000000000000000000000000001","version":2,"fingerprint":"sha256:4b1v2"}}', 'occurrence', NULL),
  ('{{CO}}', 'run-4b1-unknown', 'occ.4b100000000000000000000000000003', 'job-procedure', '{{ALICE}}', 'waiting_reconcile', 2, NULL, 'conv-4b1-old', NULL, 'unknown-result', 'RESULT_UNKNOWN',
   NULL, 0, NULL, NULL, '{{PAST}}', '{{PAST}}', NULL, NULL, 'occurrence', NULL);

INSERT INTO ai_run_operations (company_id, run_id, key, fingerprint, kind, state, generation, ref_kind, ref_id, status, reconciled_by, created_at, updated_at)
VALUES
  ('{{CO}}', 'run-4b1-running', 'drive-1', 'f1', 'drive-put', 'in_progress', 1, NULL, NULL, NULL, NULL, '{{NOW}}', '{{NOW}}'),
  ('{{CO}}', 'run-4b1-running', 'drive-0', 'f0', 'drive-put', 'done', 1, 'drive-put', 'drive-put-4b1-0', 200, NULL, '{{PAST}}', '{{PAST}}'),
  ('{{CO}}', 'run-4b1-unknown', 'draft-1', 'f2', 'mail-draft', 'unknown', 2, NULL, NULL, NULL, NULL, '{{PAST}}', '{{PAST}}');

-- The Drive receipt of the run's earlier put.
INSERT INTO google_drive_puts (id, company_id, user_id, request_key, actor_kind, conversation_id, run_id, folder_id, folder_name, name, mime_type, bytes, sha256,
  state, file_id, revision_id, link, reason, created_at, finished_at)
VALUES ('drive-put-4b1-0', '{{CO}}', '{{ALICE}}', 'key-4b1-0', 'ai', 'conv-4b1', 'run-4b1-running', 'folder-1', '報告書', '面談報告書.docx',
  'application/vnd.google-apps.document', 1200, 'sha256-of-the-put', 'done', 'file-1', 'rev-1', 'https://docs.example/file-1', NULL, '{{PAST}}', '{{PAST}}');

-- The notices 4b-1 wrote: an occurrence's, the stopped chain's, an acceptance's.
INSERT INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at)
VALUES
  ('{{CO}}', 'n-4b1-1', '{{ALICE}}', 'job_failed', '', 0, '', NULL, NULL, 'job_failed:job.4b100000000000000000000000000001:occ.4b100000000000000000000000000003:1:RESULT_UNKNOWN', '{{PAST}}', NULL),
  ('{{CO}}', 'n-4b1-2', '{{OWNER}}', 'job_failed', '', 0, '', NULL, NULL, 'job_failed:job.4b100000000000000000000000000001:occ.4b100000000000000000000000000003:1:RESULT_UNKNOWN', '{{PAST}}', NULL),
  ('{{CO}}', 'n-4b1-3', '{{ALICE}}', 'job_chain_stopped', '', 0, '', NULL, NULL, 'job_chain_stopped:job.4b100000000000000000000000000001:{{PAST}}', '{{PAST}}', NULL),
  ('{{CO}}', 'n-4b1-4', '{{ALICE}}', 'job_accept_needed', '', 0, '', NULL, NULL, 'job_accept_needed:job.4b100000000000000000000000000001:2', '{{PAST}}', NULL);
