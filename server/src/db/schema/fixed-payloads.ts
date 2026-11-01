import type Database from 'better-sqlite3'

/**
 * Fixed content of approvals and outbound mail, never rewritten (approvals.md).
 * Part of the one schema run by db/index.ts initDatabase (tables before every migration).
 */
export const fixedPayloadSchema = `
    -- Fixed content (固定した中身, milestone 4 design §3-2 / §4-3): what an approval request
    -- (owner_kind approval) or an outbound mail (outbound_message) fixes, one row per version,
    -- never rewritten (trigger in migrateFixedPayloads): the canonical text and its hash
    -- (sha256:<hex>, lib/content-hash.ts). Retention may later clear the text only
    -- (canonical → NULL with body_deleted_at); the hash, owner and version stay.
    CREATE TABLE IF NOT EXISTS fixed_payloads (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('approval', 'outbound_message')),
      owner_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      canonical TEXT,
      hash TEXT NOT NULL CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
      created_at TEXT NOT NULL,
      body_deleted_at TEXT,
      PRIMARY KEY (company_id, owner_kind, owner_id, version),
      CHECK ((canonical IS NULL) = (body_deleted_at IS NOT NULL))
    );
`

/**
 * Fixed content never changes (design §4-3): no UPDATE of the owner, version,
 * hash or time, and the text only cleared (retention: canonical → NULL together
 * with body_deleted_at, once). A new version is a new row. Idempotent.
 */
export function migrateFixedPayloads(conn: Database.Database): void {
  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS fixed_payloads_immutable BEFORE UPDATE ON fixed_payloads
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.version IS NOT OLD.version OR NEW.hash IS NOT OLD.hash OR NEW.created_at IS NOT OLD.created_at
      OR (NEW.canonical IS NOT OLD.canonical AND NEW.canonical IS NOT NULL)
      OR (OLD.body_deleted_at IS NOT NULL AND NEW.body_deleted_at IS NOT OLD.body_deleted_at)
    BEGIN SELECT RAISE(ABORT, 'fixed content is never rewritten (only its text cleared by retention)'); END;
  `)
}
