/**
 * Scheduled jobs (定期の仕事, B 「実行を記録から分ける」 PR 3a, `.claude/rules/jobs.md`): definitions, their
 * versions, occurrences (made by the clock and the runner from PR 3b, services/job-occurrences.ts) and the company's stop switch.
 * Part of the one schema run by db/index.ts initDatabase. New tables only (additive): an older build
 * never reads them, and `CREATE … IF NOT EXISTS` makes a second start change nothing.
 * Test: tests/unit/jobs-schema.test.ts (the frozen database before them, upgraded twice).
 */
import { randomUUID } from 'crypto'
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

/**
 * Stage 4b-0.5 (the rollback floor; owner memo 「段4b 設計メモ」 第4版 §5-3, corrected by Codex's 4th review #1): **watch
 * generations**. An event job's watch can start over on the same record (「見張るやることを選び直す」 of the record it watched),
 * and an occurrence made for the earlier watch must then never move, stop or clear the new one. So:
 *
 * - `ai_job_event_cursors.watch_generation` — which watch this is: 1 when first watched, + 1 every time the watch starts
 *   over or moves (`startEventCursor` on a new start record, `restartWatch`, `moveWatch`);
 * - `ai_job_occurrences.watch_generation` — the watch an event occurrence was made for, pinned when made (the scan).
 *   NULL: a time occurrence, or an event occurrence whose watch is not known — it stays **isolated**: when it ends it
 *   moves, stops and clears no watch.
 *
 * Additive (an older build neither reads nor writes them) and idempotent: only cursors still without a generation are
 * looked at. For those (4a's data) the generation is 1, and an existing occurrence gets it **only when its provenance is
 * certain** — never inferred from which pending occurrence is newest (`watch_fired` is also set without an occurrence: a
 * paused gap, an assignee who is not the responsible person, the day's limit; and the newest occurrence may have ended
 * while an older one waits). Certain = the watch fired, its chain is not stopped (in 4a every firing that makes no
 * occurrence stops it, and only the occurrence of a record can clear that stop), and the job has exactly **one**
 * occurrence of the watched record, still waiting or running (no other could have made or cleared anything). Anything
 * else is ambiguous: every occurrence stays isolated, and a watch that fired, is not stopped and has no occurrence of
 * its own now is an **orphan** — its chain is stopped once (`WATCH_RESET`, 「仕組みの入れ替えのため、止まりました」) and the
 * approved version's responsible person (while a member) is told once (`job_chain_stopped`; the job's creator is not:
 * whether they read the record cannot be judged here, D7), so they choose the next watched やること. Only for a job whose
 * approved version is an event job of this build's shape (schema 2) that **follows what it made** (`followMadeTask`; one
 * that does not ends after its one firing — its occurrence done is its normal end, never an orphan) and is not retired.
 * One more certain case (independent review): a chain stopped **by its own occurrence** — the stop on the watched record,
 * the job's one occurrence of it needing a person or expired with that very code, of the approved version (every watch
 * started over is a new version; no firing without an occurrence writes those codes) — gets the generation, so its
 * 「もう一度」 still lets the chain go on.
 * Test: tests/unit/job-watch-generations.test.ts (on the frozen database before it), job-events.test.ts.
 */
export function migrateJobWatchGenerations(conn: Database.Database): void {
  const cols = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols('ai_job_event_cursors').has('watch_generation')) conn.exec('ALTER TABLE ai_job_event_cursors ADD COLUMN watch_generation INTEGER')
  if (!cols('ai_job_occurrences').has('watch_generation')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN watch_generation INTEGER')
  const companies = conn.prepare('SELECT id FROM companies').all() as Array<{ id: string }>
  for (const { id: companyId } of companies) {
    conn.transaction(() => {
      const cursors = conn.prepare(`SELECT job_id, watch_record_id, watch_fired, chain_stop_code, chain_stop_record FROM ai_job_event_cursors
          WHERE company_id = ? AND watch_generation IS NULL`)
        .all(companyId) as Array<{ job_id: string; watch_record_id: string; watch_fired: number; chain_stop_code: string | null; chain_stop_record: string | null }>
      for (const c of cursors) {
        const pin = (id: string) => conn.prepare(`UPDATE ai_job_occurrences SET watch_generation = 1 WHERE company_id = ? AND id = ? AND watch_generation IS NULL`).run(companyId, id)
        // The approved version, when it is a 4a event job (this build's shape): who to tell, and whether it follows what it made.
        const job = conn.prepare(`SELECT j.state, j.approved_version, v.acting_user_id, json_extract(v.definition, '$.trigger.followMadeTask') AS follows
            FROM ai_jobs j JOIN ai_job_versions v ON v.company_id = j.company_id AND v.job_id = j.id
            AND v.version = j.approved_version WHERE j.company_id = ? AND j.id = ? AND v.schema = 2 AND json_valid(v.definition)
            AND json_extract(v.definition, '$.schema') = 2 AND json_extract(v.definition, '$.trigger.kind') = 'record'`)
          .get(companyId, c.job_id) as { state: string; approved_version: number; acting_user_id: string; follows: number | null } | undefined
        const mine = c.watch_fired === 1
          ? conn.prepare(`SELECT id, state, outcome_code, job_version FROM ai_job_occurrences WHERE company_id = ? AND job_id = ? AND event_record_id = ?`)
            .all(companyId, c.job_id, c.watch_record_id) as Array<{ id: string; state: string; outcome_code: string | null; job_version: number }>
          : []
        const one = mine.length === 1 ? mine[0] : null
        if (c.chain_stop_code === null) {
          if (one && (one.state === 'due' || one.state === 'running')) pin(one.id)
          else if (c.watch_fired === 1 && job && job.state !== 'retired' && job.follows === 1) {
            // An orphan of a job that follows what it made (only such a chain goes on; one that does not follow ends after
            // its one firing — its occurrence done is its normal end): stopped once, its responsible person told once.
            const at = new Date().toISOString()
            conn.prepare(`UPDATE ai_job_event_cursors SET chain_stop_code = 'WATCH_RESET', chain_stop_record = watch_record_id, chain_stop_at = ?
                WHERE company_id = ? AND job_id = ? AND chain_stop_code IS NULL`).run(at, companyId, c.job_id)
            const member = conn.prepare(`SELECT 1 FROM memberships WHERE company_id = ? AND user_id = ?`).get(companyId, job.acting_user_id)
            if (member) {
              conn.prepare(`INSERT OR IGNORE INTO notifications (company_id, id, user_id, kind, record_id, record_version, action, actor_id, actor_kind, dedupe_key, created_at, read_at)
                  VALUES (?, ?, ?, 'job_chain_stopped', '', 0, '', NULL, NULL, ?, ?, NULL)`).run(companyId, randomUUID(), job.acting_user_id, `job_chain_stopped:${c.job_id}:${at}`, at)
            }
          }
        } else if (one && c.chain_stop_record === c.watch_record_id && one.outcome_code === c.chain_stop_code
          && (one.state === 'needs_person' || one.state === 'expired') && job && one.job_version === job.approved_version) {
          // Stopped by its own occurrence, which 「もう一度」 may still run (needs a person / expired, of the approved version —
          // every watch started over is a new version, so an earlier watch's occurrence is never of it; and no firing
          // without an occurrence writes these codes): it is the watch's, so its success lets the chain go on, as in 4a.
          pin(one.id)
        }
        conn.prepare(`UPDATE ai_job_event_cursors SET watch_generation = 1 WHERE company_id = ? AND job_id = ? AND watch_generation IS NULL`).run(companyId, c.job_id)
      }
    })()
  }
}

/**
 * 4b-4 PR2, the set watch's scan (jobs.md "The set watch (schema 5)"; owner memo 「4b-4 商談から提案書」 第6版 §2 / 付録 B). Additive: a
 * build before it (the rollback floor, 4b-0.5, freezes schema 5 anyway) neither reads nor writes any of it.
 *
 * - `ai_job_occurrences.event_meeting_id` — the meeting a set watch's occurrence was made for, pinned when made: its run reads
 *   that meeting's minutes only, and who sees the occurrence is who reads the record **and** is one of that meeting's people.
 * - `ai_job_event_cursors.set_boundary_seq` — a set watch's cursor (the same row and gaps as an event job's; its watched record
 *   is '') keeps the delivery number at which its current consent was accepted: only a meeting first read **and** a record made
 *   after it is ever a set watch's (the switch boundary, §2-3 / §3 ①). NULL for an event job's cursor.
 * - `ai_job_meeting_reviews` — the 「使った」 mark: **one per record in the company** (`PRIMARY KEY (company_id, record_id)`, never
 *   per job), written in the scan's transaction whether an occurrence was made or why not (`JOB_SET_MARK_OUTCOMES`); never
 *   deleted, so a new version or a new job never runs the same meeting again.
 * - `idx_record_ledger_into` — the ledger's rows by the state they went into, in delivery order: the scan reads 「やることが
 *   完了になった行」 of the whole company without reading every other row.
 * - `ai_job_set_reports` (4b-4 PR3) — a set watch's judgement, one per occurrence, written in its finish's transaction: fixed
 *   kinds only (the decision, the reason's code, the confidence in hundredths, the unconfirmed words as a JSON list) — never a
 *   title, a quote or a company's name (I6). Read only through the occurrence's own visibility (I8). `updates` (4b-4 PR3b,
 *   additive): how many update proposals the run left, 0–20, never with `gate_failed` (CHECK); a row from before reads 0.
 * - `ai_job_set_feedback` (4b-4 PR3) — a person's correction of a judgement (§5-2): the occurrence, the kind and the time only
 *   (never who: nobody is counted, 「人ごとに数えない」), once per kind (`PRIMARY KEY`).
 */
export function migrateJobSetWatch(conn: Database.Database): void {
  const occ = new Set((conn.prepare('PRAGMA table_info(ai_job_occurrences)').all() as Array<{ name: string }>).map(c => c.name))
  if (!occ.has('event_meeting_id')) conn.exec('ALTER TABLE ai_job_occurrences ADD COLUMN event_meeting_id TEXT')
  const cursors = new Set((conn.prepare('PRAGMA table_info(ai_job_event_cursors)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cursors.has('set_boundary_seq')) conn.exec('ALTER TABLE ai_job_event_cursors ADD COLUMN set_boundary_seq INTEGER')
  conn.exec(`
    CREATE TABLE IF NOT EXISTS ai_job_meeting_reviews (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      meeting_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('made', 'paused', 'before_acceptance', 'day_limit', 'not_matched', 'step_busy')),
      occurrence_id TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_record_ledger_into ON record_ledger(company_id, to_state, delivery_seq) WHERE delivery_seq IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ai_job_set_reports (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      occurrence_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('proceed', 'decline', 'ask', 'gate_failed')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 40),
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      unconfirmed TEXT NOT NULL DEFAULT '[]',
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, occurrence_id)
    );
    CREATE TABLE IF NOT EXISTS ai_job_set_feedback (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      occurrence_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('made_anyway', 'too_early', 'went_ahead')),
      at TEXT NOT NULL,
      PRIMARY KEY (company_id, occurrence_id, kind)
    );
  `)
  const reports = new Set((conn.prepare('PRAGMA table_info(ai_job_set_reports)').all() as Array<{ name: string }>).map(c => c.name))
  if (!reports.has('updates')) {
    conn.exec(`ALTER TABLE ai_job_set_reports ADD COLUMN updates INTEGER NOT NULL DEFAULT 0
      CHECK (updates BETWEEN 0 AND 20 AND (updates = 0 OR decision <> 'gate_failed'))`)
  }
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

    -- Member proposals (jobs.md "Member proposals"): a member's candidate — a schema-4 definition the server built and
    -- pinned, readable by its creator alone, its content kept 24 hours — and the permanent record of a submitted one (one
    -- per company, proposer and candidate: a repeated submit answers the first result, also after the content is gone).
    -- state: submitted / approved / withdrawn / returned (only from submitted, one wins); return_reason: a fixed code.
    -- An older build (the rollback floor) never reads either table; its job of schema 4 is frozen there.
    CREATE TABLE IF NOT EXISTS ai_job_candidates (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL CHECK (length(id) = 35 AND substr(id, 1, 3) = 'jc.' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
      created_by TEXT NOT NULL,
      definition TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_job_candidates_creator ON ai_job_candidates(company_id, created_by, expires_at);
    CREATE TABLE IF NOT EXISTS ai_job_proposals (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL CHECK (length(id) = 35 AND substr(id, 1, 3) = 'jp.' AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
      job_id TEXT NOT NULL,
      proposer_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      submitted_version INTEGER NOT NULL CHECK (submitted_version >= 1),
      submitted_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('submitted', 'approved', 'withdrawn', 'returned')),
      return_reason TEXT CHECK (return_reason IS NULL OR return_reason IN ('NOT_NEEDED', 'TOO_BROAD', 'SKILL_NOT_READY', 'TALK_FIRST', 'OTHER')),
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      UNIQUE (company_id, proposer_id, candidate_id),
      UNIQUE (company_id, job_id),
      FOREIGN KEY (company_id, job_id) REFERENCES ai_jobs(company_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_job_proposals_proposer ON ai_job_proposals(company_id, proposer_id, state, created_at);

    -- 「定期の仕事をすべて止める」 (owner decision D8: its own switch, apart from the AI's emergency stop).
    -- No row = not stopped.
    CREATE TABLE IF NOT EXISTS ai_job_settings (
      company_id TEXT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
`
