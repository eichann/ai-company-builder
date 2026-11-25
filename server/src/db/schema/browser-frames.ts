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
 *   / `unknown`, `unknown` → `done` / `verified` (a late sure answer); nothing else ever changes. `verified` is reserved
 *   for the safe patterns (nothing sets it yet).
 */
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

    CREATE TABLE IF NOT EXISTS browser_frame_writes (
      company_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      frame_idx INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('permitted', 'done', 'verified', 'not_sent', 'unknown')),
      reason TEXT,
      permitted_at TEXT NOT NULL,
      permitted_mono_ms REAL,
      permitted_boot TEXT,
      settled_at TEXT,
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id, frame_idx) REFERENCES browser_frames(company_id, run_id, idx) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_frame_writes_in_flight ON browser_frame_writes(company_id, run_id) WHERE state = 'permitted';
    CREATE TRIGGER IF NOT EXISTS browser_frame_writes_moves BEFORE UPDATE ON browser_frame_writes
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.run_id IS NOT OLD.run_id OR NEW.seq IS NOT OLD.seq OR NEW.frame_idx IS NOT OLD.frame_idx
        OR NEW.permitted_at IS NOT OLD.permitted_at OR NEW.permitted_mono_ms IS NOT OLD.permitted_mono_ms OR NEW.permitted_boot IS NOT OLD.permitted_boot
        OR NOT (
          (OLD.state = 'permitted' AND NEW.state IN ('done', 'verified', 'not_sent', 'unknown'))
          OR (OLD.state = 'unknown' AND NEW.state IN ('done', 'verified'))
        )
    BEGIN
      SELECT RAISE(ABORT, 'a frames write only moves as its state table allows');
    END;
`
