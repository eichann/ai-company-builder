/**
 * The content store of record texts (records.md "The content store"); its trigger and move run from db/index.ts migrateRecordContents.
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const contentStoreSchema = `
    -- The content store (中身の箱, records.md "The content store"): texts that easily
    -- hold personal data (titles, summaries, long_text fields, notes, reasons), one row
    -- per distinct text of a record (id = sha256(record id, hash)[:32]). records,
    -- record_state and record_ledger hold only references (acb-content:<id>:<hash>).
    -- Never rewritten (trigger in migrateRecordContents): erasing clears the text once,
    -- with erased_at / erased_reason; the hash and the row stay. Who reads it is who
    -- reads its record (no read of its own). expires_at: the retention class's end.
    CREATE TABLE IF NOT EXISTS record_contents (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      hash TEXT NOT NULL CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
      text TEXT,
      retention_class TEXT NOT NULL CHECK (retention_class IN ('standard', 'incoming_3y')),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      erased_at TEXT,
      erased_reason TEXT,
      PRIMARY KEY (company_id, id),
      CHECK ((text IS NULL) = (erased_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_record_contents_record ON record_contents(company_id, record_id);
    CREATE INDEX IF NOT EXISTS idx_record_contents_hash ON record_contents(company_id, hash);
    CREATE INDEX IF NOT EXISTS idx_record_contents_expires ON record_contents(company_id, expires_at) WHERE expires_at IS NOT NULL AND erased_at IS NULL;
`
