/**
 * Scheduled jobs (定期の仕事, B 「実行を記録から分ける」 PR 3a, `.claude/rules/jobs.md`): definitions, their
 * versions, occurrences (made by the clock and the runner from PR 3b, services/job-occurrences.ts) and the company's stop switch.
 * Part of the one schema run by db/index.ts initDatabase. New tables only (additive): an older build
 * never reads them, and `CREATE … IF NOT EXISTS` makes a second start change nothing.
 * Test: tests/unit/jobs-schema.test.ts (the frozen database before them, upgraded twice).
 */
import type Database from 'better-sqlite3'

/**
 * B PR 5a-2: where an occurrence's check stopped looking (`checked_until`, UTC ISO): the next occurrence's check
 * starts there, so nothing is looked at twice or never. Set once, at the first claim. Additive (an older build
 * neither reads nor writes it); every startup, idempotent.
 */
export function migrateJobOccurrenceCheckedUntil(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(ai_job_occurrences)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('checked_until')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN checked_until TEXT')
  // The commit a `new_files` check looked up to (the app's, sent with its first claim): the next one starts there.
  if (!cols.has('checked_commit')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN checked_commit TEXT')
}

/**
 * B PR 5b, 「もう一度」: who last sent an occurrence back to `due` and when (`retried_by`, `retried_at`), and how often
 * (`retries`, 0 = never; part of its notices' key, so a second failure after a press is told again). Additive (an
 * older build neither reads nor writes them); every startup, idempotent.
 */
export function migrateJobOccurrenceRetries(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(ai_job_occurrences)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('retries')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN retries INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('retried_by')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN retried_by TEXT')
  if (!cols.has('retried_at')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN retried_at TEXT')
}

/**
 * Where a job's deliverables go outside ACB (jobs.md "A deliverable place outside"): the place the responsible
 * person chose when accepting (`accepted_place`, JSON `{ connector, kind, ref }`; NULL = none chosen). Additive:
 * an older build neither reads nor writes it (it never accepts a version naming such a place — its parser refuses
 * the definition). Every startup, idempotent.
 */
export function migrateJobAcceptedPlace(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(ai_jobs)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('accepted_place')) conn.exec('ALTER TABLE ai_jobs ADD COLUMN accepted_place TEXT')
}

/**
 * Stage 4a, event-triggered jobs (jobs.md "Event-triggered jobs"; owner memo 「出来事で動く定期の仕事」). Additive: a
 * build before it (4-0, the oldest one production may go back to) neither reads nor writes any of it.
 *
 * - On an occurrence: the event it was made for — `event_seq` (the ledger's delivery number; one occurrence per job and
 *   event: the partial unique index, beside `UNIQUE (company, job, due_slot)` whose `due_slot` is `ev:<seq>`),
 *   `event_record_id` / `event_version` (the record and its ledger version: who may see the occurrence is who reads
 *   that record now), `event_day` (the company's day it was made: the day's limit counts these).
 * - `ai_job_event_cursors`: per job, the delivery number its scan has looked at up to (`seen_seq`), set when its
 *   responsible person accepts (never back in time) and moved in the transaction that makes its occurrences; and its
 *   **watch target** — the one record it watches (`watch_record_id`, server-managed: the accepted `startRecord`
 *   (`watch_start`), then, with `followMadeTask`, the やること an occurrence made), and whether that target fired already
 *   (`watch_fired`: each target makes one occurrence, however often it is completed again); and what this build last
 *   wrote of the job and of the company's stop (`job_stamp` = `ai_jobs.updated_at`, `stop_stamp` = `ai_job_settings.
 *   updated_at`): a build before 4a (the rollback build, 4-0) pauses and stops without gaps, and a difference tells the
 *   scan to look at nothing from before (jobs.md "Event-triggered jobs", Codex review of #700); and, when the chain of
 *   watched records stopped (owner decision ①), why (`chain_stop_code`), on which record (`chain_stop_record`: the stop
 *   exists only for who reads it, and for the responsible person — D7) and when (`chain_stop_at`, the notice's key) — cleared when the watch moves.
 * - `ai_job_event_gaps`: the stretches no event of a job runs in (a pause; `job_key` '' = the company's stop):
 *   delivery numbers in (`from_seq`, `until_seq`], `until_seq` NULL while it lasts. Several per job (owner decision ③).
 *   Its id is the server's own (TEXT), never a rowid: a company archive restores it beside other companies.
 */
export function migrateJobEvents(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(ai_job_occurrences)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('event_seq')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN event_seq INTEGER')
  if (!cols.has('event_record_id')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN event_record_id TEXT')
  if (!cols.has('event_version')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN event_version INTEGER')
  if (!cols.has('event_day')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN event_day TEXT')
  conn.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_job_occurrences_event ON ai_job_occurrences(company_id, job_id, event_seq) WHERE event_seq IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_job_occurrences_event_day ON ai_job_occurrences(company_id, job_id, event_day) WHERE event_day IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ai_job_event_cursors (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      seen_seq INTEGER NOT NULL CHECK (seen_seq >= 0),
      watch_record_id TEXT NOT NULL,
      watch_start TEXT NOT NULL,
      watch_fired INTEGER NOT NULL DEFAULT 0 CHECK (watch_fired IN (0, 1)),
      job_stamp TEXT NOT NULL DEFAULT '',
      stop_stamp TEXT NOT NULL DEFAULT '',
      chain_stop_code TEXT,
      chain_stop_record TEXT,
      chain_stop_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, job_id),
      FOREIGN KEY (company_id, job_id) REFERENCES ai_jobs(company_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_job_event_gaps (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      from_seq INTEGER NOT NULL CHECK (from_seq >= 0),
      until_seq INTEGER CHECK (until_seq IS NULL OR until_seq >= from_seq),
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_job_event_gaps_job ON ai_job_event_gaps(company_id, job_key);
  `)
}

export const jobSchema = `
    -- A job (behind the company handle, ports/jobs.ts). acting_user_id: the responsible person of the
    -- newest version (whom it runs as: owner decision D3). approved_version / approved_fingerprint: the
    -- version an owner/admin approved, pinned by its fingerprint. accepted_consent: the consent
    -- fingerprint the responsible person accepted (owner decision D4: a version keeping it needs no new
    -- acceptance). paused_reason: a short code (JOB_PAUSE_REASONS), never text.
    CREATE TABLE IF NOT EXISTS ai_jobs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL CHECK (length(id) = 36 AND substr(id, 1, 4) = 'job.' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'paused', 'retired')),
      acting_user_id TEXT NOT NULL,
      latest_version INTEGER NOT NULL,
      approved_version INTEGER,
      approved_fingerprint TEXT,
      accepted_version INTEGER,
      accepted_consent TEXT,
      paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('ADMIN', 'BY_RESPONSIBLE', 'OWNER_LEFT', 'OWNER_RIGHTS_CHANGED')),
      paused_by TEXT,
      paused_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      CHECK ((approved_version IS NULL) = (approved_fingerprint IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_acting ON ai_jobs(company_id, acting_user_id);

    -- A job's definitions, append-only: a change is a new version, a version's definition is never
    -- rewritten (triggers below). definition: the canonical JSON (shared/core/jobs.ts);
    -- fingerprint / consent_fingerprint: sha256 of the whole / of the consented part.
    -- approved_* / accepted_*: who approved / accepted this version and when, set once.
    CREATE TABLE IF NOT EXISTS ai_job_versions (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      schema INTEGER NOT NULL,
      definition TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      consent_fingerprint TEXT NOT NULL,
      acting_user_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      accepted_by TEXT,
      accepted_at TEXT,
      PRIMARY KEY (company_id, job_id, version),
      FOREIGN KEY (company_id, job_id) REFERENCES ai_jobs(company_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_job_versions_acting ON ai_job_versions(company_id, acting_user_id);
    CREATE TRIGGER IF NOT EXISTS ai_job_versions_append_only
      BEFORE UPDATE OF company_id, job_id, version, schema, definition, fingerprint, consent_fingerprint, acting_user_id, created_by, created_at ON ai_job_versions
      BEGIN SELECT RAISE(ABORT, 'a job version is never rewritten'); END;
    CREATE TRIGGER IF NOT EXISTS ai_job_versions_approved_once
      BEFORE UPDATE OF approved_by, approved_at ON ai_job_versions
      WHEN OLD.approved_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a job version is approved once'); END;
    CREATE TRIGGER IF NOT EXISTS ai_job_versions_accepted_once
      BEFORE UPDATE OF accepted_by, accepted_at ON ai_job_versions
      WHEN OLD.accepted_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a job version is accepted once'); END;

    -- A job's occurrences (回): one per job and due slot (company time, "2026-11-16T09:00"), however
    -- often the clock runs. The id is "occ." + 32 hex, never a record id (shared/core/jobs.ts): it is
    -- what a run's subject id holds. Nothing writes these until B PR 3b.
    CREATE TABLE IF NOT EXISTS ai_job_occurrences (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL CHECK (length(id) = 36 AND substr(id, 1, 4) = 'occ.' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
      job_id TEXT NOT NULL,
      job_version INTEGER NOT NULL,
      due_slot TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      due_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('due', 'running', 'done', 'nothing', 'needs_person', 'skipped', 'expired', 'held')),
      run_id TEXT,
      outcome_code TEXT CHECK (outcome_code IS NULL OR (length(outcome_code) BETWEEN 1 AND 60 AND outcome_code NOT GLOB '*[^A-Z0-9_]*')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      UNIQUE (company_id, job_id, due_slot),
      FOREIGN KEY (company_id, job_id, job_version) REFERENCES ai_job_versions(company_id, job_id, version) ON DELETE CASCADE
    );
    -- The runner's and the clock's look-up of what is still due (held / done rows pile up, one per job and slot).
    CREATE INDEX IF NOT EXISTS idx_ai_job_occurrences_due ON ai_job_occurrences(company_id, state, due_at);

    -- 「定期の仕事をすべて止める」 (owner decision D8: its own switch, apart from the AI's emergency stop).
    -- No row = not stopped.
    CREATE TABLE IF NOT EXISTS ai_job_settings (
      company_id TEXT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
`
