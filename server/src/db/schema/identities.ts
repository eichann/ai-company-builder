/**
 * Matching people and companies (名寄せ, `.claude/rules/identity.md`,
 * shared/core/identity.ts). Part of the one schema run by db/index.ts
 * initDatabase (tables before every migration). Behind the company handle
 * (ports/identities.ts). Record ids and matching keys only — never a title.
 */
export const identitySchema = `
    -- An identity (背番号): the 相手 records that are one company or person.
    CREATE TABLE IF NOT EXISTS identities (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('company', 'person')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id)
    );

    -- A 相手 record's membership: at most one identity per record, with the keys it was matched by.
    CREATE TABLE IF NOT EXISTS identity_members (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('company', 'person')),
      email TEXT,
      domain TEXT,
      held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
      how TEXT NOT NULL CHECK (how IN ('new', 'email', 'domain', 'approved', 'split')),
      joined_at TEXT NOT NULL,
      joined_by TEXT,
      PRIMARY KEY (company_id, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identity_members_identity ON identity_members(company_id, identity_id);
    CREATE INDEX IF NOT EXISTS idx_identity_members_email ON identity_members(company_id, email);
    CREATE INDEX IF NOT EXISTS idx_identity_members_domain ON identity_members(company_id, domain);

    -- "These two are the same?": from the AI (or a person), decided by a person.
    CREATE TABLE IF NOT EXISTS identity_proposals (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      a_record TEXT NOT NULL,
      b_record TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL,
      proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('human', 'ai')),
      proposed_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      PRIMARY KEY (company_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_identity_proposals_status ON identity_proposals(company_id, status);

    -- Append-only history: who joined which identity, how, and who decided.
    CREATE TABLE IF NOT EXISTS identity_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('joined', 'proposed', 'approved', 'rejected', 'split')),
      how TEXT,
      proposal_id TEXT,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('auto', 'human', 'ai')),
      actor_id TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identity_history_record ON identity_history(company_id, record_id);
`
