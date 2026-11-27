import type Database from 'better-sqlite3'
import { rebuildTableFor } from './table-rebuild'

/**
 * Writes within frames (redesign step ⑤a; agent-browser.md "Writes within frames"; `model/browser-plan/FramesLife.tla`):
 * a run's frames and the writes actually permitted. **New tables only** — separate from the opened lines'
 * (`browser_line_*`) and the old path's; nothing there changes. Behind the company handle (ports/browser-frames.ts); the
 * rules are services/browser-frames.ts (one owner of every state move).
 *
 * - `browser_frame_runs`: who, which registered domain, from which PC, where the frames came from (a Skill's approved
 *   declaration: its hash, folder version and the approval row it rested on; or the ad-hoc plan the person approves), the
 *   plan's hash the card shows, the sha256 of the card's one-time approval value, the state (`waiting` → `open` → `locked`
 *   → `ended`; `ended` is final) and its times. **At most one run not ended per company × domain** (partial unique index:
 *   design memo D10) and **at most one waiting run per member**. The trigger keeps the fixed columns and lets the state
 *   move only forward.
 *
 * `CREATE TRIGGER IF NOT EXISTS` never replaces a trigger already there: a changed trigger body needs an explicit
 * `DROP TRIGGER` + `CREATE TRIGGER` in a migration, or databases made before keep the old one.
 * - `browser_frames`: one row per write target of the run (method, path, fixed fields, `max`) and `used`, the units the
 *   permits took. **`used <= max` is a CHECK** and the trigger lets `used` only grow by one: a frame can never be exceeded,
 *   whatever the code does.
 * - `browser_frame_writes`: one row appended per permit, with the frame it used, its state and both clocks' readings.
 *   **At most one `permitted` write per run** (partial unique index: the second page write waits until the first's
 *   result is recorded). The trigger allows only the state table's moves: `permitted` → `done` / `verified` / `not_sent`
 *   / `unknown` / `refused` (the site answered that it did not take it: a 4xx; agent-browser.md "Recovering from a failed
 *   write"), `unknown` → `done` / `verified` / `refused` (a late sure answer); nothing else ever changes. `verified` is
 *   reserved for the safe patterns (nothing sets it yet). `refused` came later: `migrateBrowserFrameWriteRefused` rebuilds
 *   a table made before it (its CHECK cannot widen in place).
 * - `browser_frame_write_confirms`: the person's answer about a write in doubt (「済んでいた」 `done` /
 *   「されていなかった」 `not_done`), who and when; once per write (primary key), never changed or removed while its run
 *   exists. It never moves the write or the run (a locked run stays locked).
 * - `browser_frame_made` (agent-browser.md "Writes only to what this run made"): the id a `done` write's answer named, for a
 *   frame a later frame's `{made:<n>}` refers to — **the only value of a site's page the server keeps**, so a later permit
 *   can fit only that id. Once per write, only beside a `done` write of that same frame (trigger), never changed or
 *   removed while its run exists; a plain token of at most 64 characters (CHECK).
 * - `browser_write_ledger` (agent-browser.md "The write ledger across requests"): one row per permitted write, keyed
 *   company × registered domain × outside account × **target** (the sha256 of the write's method, `_method` and path —
 *   never the path as text), with its run and write. Written only in the permit's transaction, beside its `permitted`
 *   write and with its run's member and domain (trigger); never changed, never removed while its run exists. What became
 *   of each write is its row in `browser_frame_writes` and `browser_frame_write_confirms`: a target with a write still
 *   `permitted` / `unknown` and no answer is **in doubt** for every later run, with no time limit.
 * - `browser_frame_promises` / `browser_frame_promise_adds` (agent-browser.md "The run's promise"): the run's promise as the
 *   app sent it once before the first permit (digests only: never a value or a label), and each addition the person made
 *   on the card while the run wrote. Never changed, never removed while their run exists.
 * - `browser_frame_refusal_checks` (agent-browser.md "Sent is not done"): a `refused` write the app read again and found
 *   unchanged — only then is it known "not saved"; a refused write without one is in doubt for every later run.
 */

/** The writes table, its in-flight index and its moves: one text for a new database and the rebuild. */
const BROWSER_FRAME_WRITES_TABLE = `CREATE TABLE IF NOT EXISTS browser_frame_writes (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      frame_idx INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('permitted', 'done', 'verified', 'not_sent', 'unknown', 'refused')),
      reason TEXT,
      permitted_at TEXT NOT NULL,
      permitted_mono_ms REAL,
      permitted_boot TEXT,
      settled_at TEXT,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id, frame_idx) REFERENCES browser_frames(company_id, run_id, idx) ON DELETE CASCADE
    );`
const BROWSER_FRAME_WRITES_IN_FLIGHT = `CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_frame_writes_in_flight ON browser_frame_writes(company_id, run_id) WHERE state = 'permitted'`
const BROWSER_FRAME_WRITES_MOVES = `CREATE TRIGGER IF NOT EXISTS browser_frame_writes_moves BEFORE UPDATE ON browser_frame_writes
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.run_id IS NOT OLD.run_id OR NEW.seq IS NOT OLD.seq OR NEW.frame_idx IS NOT OLD.frame_idx
        OR NEW.permitted_at IS NOT OLD.permitted_at OR NEW.permitted_mono_ms IS NOT OLD.permitted_mono_ms OR NEW.permitted_boot IS NOT OLD.permitted_boot
        OR NOT (
          (OLD.state = 'permitted' AND NEW.state IN ('done', 'verified', 'not_sent', 'unknown', 'refused'))
          OR (OLD.state = 'unknown' AND NEW.state IN ('done', 'verified', 'refused'))
        )
    BEGIN
      SELECT RAISE(ABORT, 'a frames write only moves as its state table allows');
    END`
/**
 * What a run made is kept only beside its done write. It names `browser_frame_writes`, so the rebuild of that table drops
 * it first and makes it again (SQLite would otherwise point it at the renamed old table, which is then dropped).
 */
const BROWSER_FRAME_MADE_DONE = `CREATE TRIGGER IF NOT EXISTS browser_frame_made_done BEFORE INSERT ON browser_frame_made
      WHEN NOT EXISTS (SELECT 1 FROM browser_frame_writes WHERE company_id = NEW.company_id AND run_id = NEW.run_id AND seq = NEW.seq
        AND frame_idx = NEW.frame_idx AND state = 'done')
    BEGIN
      SELECT RAISE(ABORT, 'what a run made is kept only beside its done write');
    END`
/**
 * A ledger row only beside its write while that write is `permitted` (the permit's own transaction), with its run's member
 * and domain. Names `browser_frame_writes`, so the writes table's rebuild drops it first and makes it again (as above).
 */
const BROWSER_WRITE_LEDGER_BESIDE_WRITE = `CREATE TRIGGER IF NOT EXISTS browser_write_ledger_beside_write BEFORE INSERT ON browser_write_ledger
      WHEN NOT EXISTS (SELECT 1 FROM browser_frame_writes WHERE company_id = NEW.company_id AND run_id = NEW.run_id AND seq = NEW.seq
        AND state = 'permitted')
        OR NOT EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = NEW.company_id AND id = NEW.run_id AND user_id = NEW.user_id AND host = NEW.host)
    BEGIN
      SELECT RAISE(ABORT, 'a ledger row is written only beside its permitted write, with its run''s member and domain');
    END`
/**
 * A refused write found unchanged is kept only beside its `refused` write. Names `browser_frame_writes`, so the writes table's
 * rebuild drops it first and makes it again (as the two above).
 */
const BROWSER_FRAME_REFUSAL_CHECK_BESIDE = `CREATE TRIGGER IF NOT EXISTS browser_frame_refusal_checks_beside BEFORE INSERT ON browser_frame_refusal_checks
      WHEN NOT EXISTS (SELECT 1 FROM browser_frame_writes WHERE company_id = NEW.company_id AND run_id = NEW.run_id AND seq = NEW.seq AND state = 'refused')
    BEGIN
      SELECT RAISE(ABORT, 'a refused write read again is kept only beside its refused write');
    END`
/** A run's promise only before its first permit. Names `browser_frame_writes`: the rebuild drops it and makes it again. */
const BROWSER_FRAME_PROMISES_BEFORE_WRITES = `CREATE TRIGGER IF NOT EXISTS browser_frame_promises_before_writes BEFORE INSERT ON browser_frame_promises
      WHEN EXISTS (SELECT 1 FROM browser_frame_writes WHERE company_id = NEW.company_id AND run_id = NEW.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'a run''s promise is made before its first permit');
    END`
export const browserFrameSchema = `
    CREATE TABLE IF NOT EXISTS browser_frame_runs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('skill', 'adhoc')),
      skill TEXT,
      declaration_hash TEXT,
      files TEXT,
      approval_seq INTEGER,
      plan_hash TEXT NOT NULL CHECK (plan_hash GLOB 'sha256:*'),
      approval_token_hash TEXT,
      state TEXT NOT NULL CHECK (state IN ('waiting', 'open', 'locked', 'ended')),
      approval TEXT CHECK (approval IN ('card', 'pre_approved')),
      approved_at TEXT,
      end_reason TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (company_id, id),
      CHECK ((source = 'skill') = (skill IS NOT NULL AND declaration_hash IS NOT NULL AND files IS NOT NULL AND approval_seq IS NOT NULL)),
      CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
      CHECK (state = 'waiting' OR state = 'ended' OR approval IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_frame_runs_domain ON browser_frame_runs(company_id, host) WHERE state <> 'ended';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_frame_runs_waiting ON browser_frame_runs(company_id, user_id) WHERE state = 'waiting';
    CREATE INDEX IF NOT EXISTS idx_browser_frame_runs_user ON browser_frame_runs(company_id, user_id, state);
    CREATE TRIGGER IF NOT EXISTS browser_frame_runs_fixed BEFORE UPDATE ON browser_frame_runs
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.host IS NOT OLD.host
        OR NEW.device_id IS NOT OLD.device_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.source IS NOT OLD.source
        OR NEW.skill IS NOT OLD.skill OR NEW.declaration_hash IS NOT OLD.declaration_hash OR NEW.files IS NOT OLD.files
        OR NEW.approval_seq IS NOT OLD.approval_seq
        OR NEW.plan_hash IS NOT OLD.plan_hash OR NEW.approval_token_hash IS NOT OLD.approval_token_hash OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.approval IS NOT NULL AND (NEW.approval IS NOT OLD.approval OR NEW.approved_at IS NOT OLD.approved_at))
        OR (OLD.state = 'ended' AND (NEW.state IS NOT OLD.state OR NEW.end_reason IS NOT OLD.end_reason OR NEW.ended_at IS NOT OLD.ended_at))
        OR (OLD.state = 'open' AND NEW.state = 'waiting')
        OR (OLD.state = 'locked' AND NEW.state IN ('waiting', 'open'))
    BEGIN
      SELECT RAISE(ABORT, 'a frames run only moves forward');
    END;

    CREATE TABLE IF NOT EXISTS browser_frames (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL CHECK (idx >= 1),
      method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
      path TEXT NOT NULL,
      fields TEXT NOT NULL,
      max INTEGER NOT NULL CHECK (max >= 1),
      used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= max),
      PRIMARY KEY (company_id, run_id, idx),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_frames_fixed BEFORE UPDATE ON browser_frames
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.run_id IS NOT OLD.run_id OR NEW.idx IS NOT OLD.idx OR NEW.method IS NOT OLD.method
        OR NEW.path IS NOT OLD.path OR NEW.fields IS NOT OLD.fields OR NEW.max IS NOT OLD.max OR NEW.used IS NOT OLD.used + 1
    BEGIN
      SELECT RAISE(ABORT, 'a frame only gives one more unit at a time');
    END;

    ${BROWSER_FRAME_WRITES_TABLE}
    ${BROWSER_FRAME_WRITES_IN_FLIGHT};
    ${BROWSER_FRAME_WRITES_MOVES};

    CREATE TABLE IF NOT EXISTS browser_frame_write_confirms (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      answer TEXT NOT NULL CHECK (answer IN ('done', 'not_done')),
      confirmed_by TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_frame_write_confirms_no_update BEFORE UPDATE ON browser_frame_write_confirms
    BEGIN
      SELECT RAISE(ABORT, 'a person''s answer about a write is kept as given');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_frame_write_confirms_no_delete BEFORE DELETE ON browser_frame_write_confirms
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'a person''s answer about a write is kept as given');
    END;

    CREATE TABLE IF NOT EXISTS browser_frame_made (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      frame_idx INTEGER NOT NULL,
      made TEXT NOT NULL CHECK (length(made) BETWEEN 1 AND 64 AND made NOT GLOB '*[^A-Za-z0-9_-]*'),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    ${BROWSER_FRAME_MADE_DONE};
    CREATE TRIGGER IF NOT EXISTS browser_frame_made_no_update BEFORE UPDATE ON browser_frame_made
    BEGIN
      SELECT RAISE(ABORT, 'what a run made is kept as reported');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_frame_made_no_delete BEFORE DELETE ON browser_frame_made
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'what a run made is kept as reported');
    END;

    CREATE TABLE IF NOT EXISTS browser_write_ledger (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      host TEXT NOT NULL,
      account TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target GLOB 'sha256:*'),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_browser_write_ledger_target ON browser_write_ledger(company_id, host, account, target);
    ${BROWSER_WRITE_LEDGER_BESIDE_WRITE};
    CREATE TRIGGER IF NOT EXISTS browser_write_ledger_no_update BEFORE UPDATE ON browser_write_ledger
    BEGIN
      SELECT RAISE(ABORT, 'the write ledger is kept as written');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_write_ledger_no_delete BEFORE DELETE ON browser_write_ledger
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'the write ledger is kept as written');
    END;

    CREATE TABLE IF NOT EXISTS browser_frame_promises (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_frame_promises_no_update BEFORE UPDATE ON browser_frame_promises
    BEGIN
      SELECT RAISE(ABORT, 'a run''s promise is kept as made');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_frame_promises_no_delete BEFORE DELETE ON browser_frame_promises
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'a run''s promise is kept as made');
    END;
    ${BROWSER_FRAME_PROMISES_BEFORE_WRITES};

    CREATE TABLE IF NOT EXISTS browser_frame_promise_adds (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      content TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_promises(company_id, run_id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS browser_frame_promise_adds_no_update BEFORE UPDATE ON browser_frame_promise_adds
    BEGIN
      SELECT RAISE(ABORT, 'what the person added to a promise is kept as given');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_frame_promise_adds_no_delete BEFORE DELETE ON browser_frame_promise_adds
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'what the person added to a promise is kept as given');
    END;

    CREATE TABLE IF NOT EXISTS browser_frame_refusal_checks (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES browser_frame_runs(company_id, id) ON DELETE CASCADE
    );
    ${BROWSER_FRAME_REFUSAL_CHECK_BESIDE};
    CREATE TRIGGER IF NOT EXISTS browser_frame_refusal_checks_no_update BEFORE UPDATE ON browser_frame_refusal_checks
    BEGIN
      SELECT RAISE(ABORT, 'a refused write read again is kept as found');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_frame_refusal_checks_no_delete BEFORE DELETE ON browser_frame_refusal_checks
      WHEN EXISTS (SELECT 1 FROM browser_frame_runs WHERE company_id = OLD.company_id AND id = OLD.run_id)
    BEGIN
      SELECT RAISE(ABORT, 'a refused write read again is kept as found');
    END;
`

/**
 * A frame's exact query (agent-browser.md "A write with an exact query"): a nullable column added to `browser_frames` —
 * additive, so an older build still inserts without it and a row made before reads null = "the address carries no query",
 * exactly what it meant then. The CHECK repeats the query's alphabet (`browserSkillQueryProblem`: plain words, `=`, `&`;
 * no `%`, `+`, `;`, `#`, space) as a second layer; fixed like the rest of the frame by a trigger of its own (the first one
 * cannot be changed in place). Idempotent.
 */
export function migrateBrowserFrameQuery(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(browser_frames)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('query')) {
    conn.exec(`ALTER TABLE browser_frames ADD COLUMN query TEXT CHECK (query IS NULL OR (length(query) BETWEEN 1 AND 100 AND query NOT GLOB '*[^A-Za-z0-9._~=&-]*'))`)
  }
  conn.exec(`CREATE TRIGGER IF NOT EXISTS browser_frames_fixed_query BEFORE UPDATE ON browser_frames
    WHEN NEW.query IS NOT OLD.query
  BEGIN
    SELECT RAISE(ABORT, 'a frame''s query never changes');
  END`)
}

/**
 * A frame's promise fields (agent-browser.md "The run's promise"): the `body` and `bind` its Skill's `browser.yaml` declared,
 * as canonical JSON, or null (none declared; an ad-hoc plan; a row made before the column). Additive and nullable, fixed by
 * a trigger of its own like the query. Idempotent.
 */
export function migrateBrowserFramePromise(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(browser_frames)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('promise')) conn.exec('ALTER TABLE browser_frames ADD COLUMN promise TEXT')
  conn.exec(`CREATE TRIGGER IF NOT EXISTS browser_frames_fixed_promise BEFORE UPDATE ON browser_frames
    WHEN NEW.promise IS NOT OLD.promise
  BEGIN
    SELECT RAISE(ABORT, 'a frame''s promise fields never change');
  END`)
}

/**
 * The write state `refused` ("Recovering from a failed write"): a `browser_frame_writes` made before it is rebuilt once
 * with the wider CHECK and the trigger that allows `permitted` / `unknown` → `refused` (every row kept). Idempotent.
 */
export function migrateBrowserFrameWriteRefused(conn: Database.Database): boolean {
  return rebuildTableFor(conn, {
    table: 'browser_frame_writes',
    marker: "'refused'",
    create: BROWSER_FRAME_WRITES_TABLE,
    after: [BROWSER_FRAME_WRITES_IN_FLIGHT, BROWSER_FRAME_WRITES_MOVES, BROWSER_FRAME_MADE_DONE, BROWSER_WRITE_LEDGER_BESIDE_WRITE, BROWSER_FRAME_REFUSAL_CHECK_BESIDE, BROWSER_FRAME_PROMISES_BEFORE_WRITES],
    drop: ['DROP TRIGGER IF EXISTS browser_frame_writes_moves', 'DROP INDEX IF EXISTS idx_browser_frame_writes_in_flight', 'DROP TRIGGER IF EXISTS browser_frame_made_done',
      'DROP TRIGGER IF EXISTS browser_write_ledger_beside_write', 'DROP TRIGGER IF EXISTS browser_frame_refusal_checks_beside',
      'DROP TRIGGER IF EXISTS browser_frame_promises_before_writes'],
    columns: ['company_id', 'run_id', 'seq', 'frame_idx', 'state', 'reason', 'permitted_at', 'permitted_mono_ms', 'permitted_boot', 'settled_at'],
  })
}
