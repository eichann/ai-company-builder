-- browser_frame_writes and browser_run_writes as the build before the state `refused` / the outcome `site-refused`
-- made them (origin/main aa370dc0): tests/unit/browser-frames.test.ts "a database from before".
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

    CREATE TABLE IF NOT EXISTS browser_run_writes (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      after_step INTEGER NOT NULL CHECK (after_step >= 0),
      frame INTEGER,
      method TEXT NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE', 'OTHER')),
      page TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('done', 'not-sent', 'unknown', 'refused')),
      PRIMARY KEY (company_id, run_id, idx)
    );
    CREATE TRIGGER IF NOT EXISTS browser_run_writes_no_update BEFORE UPDATE ON browser_run_writes
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS browser_run_writes_no_delete BEFORE DELETE ON browser_run_writes
      WHEN EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN
      SELECT RAISE(ABORT, 'a browser run log is append-only');
    END;
