/**
 * The holding place for a member's unsent work in a private folder they can no longer read
 * (private-folders.md "Access removed: holding tickets"). Part of the one schema run by
 * db/index.ts initDatabase (tables before every migration).
 */
export const holdingSchema = `
    -- One row per (member × private folder) whose read access ended: the only thing that lets
    -- that member hand over what they never sent (later PRs: items and files). Written in the
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
`
