/**
 * 「ブラウザ操作」 の記録 (agent-browser.md "Recording"; owner decision D2): what a member recorded in the app's window and
 * sent to the company — patterns, labels and value symbols, never a value (shared/core/browser-recording.ts checks it
 * before it is stored). Behind the company handle (ports/browser-recordings.ts). **A new table only.**
 *
 * - `delete_at` = `created_at` + 30 days: the server clock deletes the row once it passed, and every read leaves out a
 *   row past it (so a late sweep never shows one).
 * - Deleting (the sender, an owner / admin, the 30 days) removes the whole row, content included; nothing else holds it.
 * - The content is fixed once stored (trigger).
 */
export const browserRecordingSchema = `
    CREATE TABLE IF NOT EXISTS browser_recordings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      lines INTEGER NOT NULL CHECK (lines >= 1),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delete_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      CHECK (delete_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_recordings_created ON browser_recordings(company_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_browser_recordings_user ON browser_recordings(company_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_browser_recordings_delete ON browser_recordings(company_id, delete_at);
    CREATE TRIGGER IF NOT EXISTS browser_recordings_fixed BEFORE UPDATE ON browser_recordings
    BEGIN
      SELECT RAISE(ABORT, 'a browser recording never changes (delete it instead)');
    END;
`
