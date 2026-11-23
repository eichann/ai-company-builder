/**
 * The holding place for a member's unsent work in a private folder they can no longer read
 * (private-folders.md "Access removed: holding tickets"). Part of the one schema run by
 * db/index.ts initDatabase (tables before every migration).
 */
export const holdingSchema = `
    -- One row per (member × private folder) whose read access ended: the only thing that lets
    -- that member hand over what they never sent (holding_items / holding_files below). Written in the
    -- same transaction as the change (services/holding-tickets.ts). Behind the company handle
    -- (ports/holding.ts). folder_path is server-only: never answered to the ticket's member.
    -- scope_id has no foreign key: a deleted folder's scope row is gone, its tickets stay.
    CREATE TABLE IF NOT EXISTS holding_tickets (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      repo_id TEXT,
      folder_path TEXT NOT NULL,
      cause TEXT NOT NULL CHECK (cause IN ('readers', 'left-company', 'folder-deleted', 'role', 'rules')),
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'used', 'cancelled', 'expired')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holding_tickets_open ON holding_tickets(company_id, user_id, scope_id) WHERE state = 'open';
    CREATE INDEX IF NOT EXISTS idx_holding_tickets_user ON holding_tickets(user_id, state);
    CREATE INDEX IF NOT EXISTS idx_holding_tickets_expiry ON holding_tickets(company_id, state, expires_at);

    -- One item per (ticket × the member's PC): what that PC handed over (private-folders.md
    -- "Holding: the member's upload"). folder_path is copied from the ticket (server-only).
    -- state: receiving (contents arriving) → waiting (finished, for the managers) → taking /
    -- taken / discarded (later PRs) or expired (the server clock, 30 days after arrival).
    -- total_bytes = the distinct contents stored now (what counts against the ticket's and the company's
    -- room). Rows stay after the blobs are deleted (blobs_deleted_at): who, when, names.
    CREATE TABLE IF NOT EXISTS holding_items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL REFERENCES holding_tickets(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      device_key TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      base_commit TEXT,
      state TEXT NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving', 'waiting', 'taking', 'taken', 'discarded', 'expired')),
      total_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      decided_at TEXT,
      decided_by TEXT,
      decision_commit TEXT,
      blobs_deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holding_items_device ON holding_items(company_id, ticket_id, device_key);
    CREATE INDEX IF NOT EXISTS idx_holding_items_state ON holding_items(company_id, state);
    CREATE INDEX IF NOT EXISTS idx_holding_items_user ON holding_items(company_id, user_id);

    -- The entries of an item's manifest, in order (idx). kind: changed / deleted / backup /
    -- personal / names-only; sha256 only for content (kept on an entry dropped as a secret, never
    -- its bytes); stored = its blob arrived; dropped = why it is not held ('too-large', 'secret': a
    -- name only; 'company-full': the company's room was full, the app keeps its copy and retries).
    CREATE TABLE IF NOT EXISTS holding_files (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES holding_items(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('changed', 'deleted', 'backup', 'personal', 'names-only')),
      size INTEGER NOT NULL,
      sha256 TEXT,
      label TEXT,
      stored INTEGER NOT NULL DEFAULT 0,
      dropped TEXT CHECK (dropped IS NULL OR dropped IN ('too-large', 'secret', 'company-full')),
      PRIMARY KEY (item_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_holding_files_company ON holding_files(company_id, item_id);
`
