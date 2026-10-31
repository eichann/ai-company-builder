-- app.sqlite schema as created by initDatabase() before company_id on
-- scope_rules / department_managers (server/src/db/index.ts at d6d9f91, PR #331).
-- Frozen: do not update.
CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, company_id)
    );

CREATE TABLE ssh_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      device_name TEXT,
      is_active INTEGER DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE invitations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      created_by TEXT NOT NULL,
      used_by TEXT,
      used_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    , signup_claimed_at TEXT, signup_user_id TEXT);

CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES departments(id) ON DELETE CASCADE,

      name TEXT NOT NULL,
      name_en TEXT,
      folder TEXT NOT NULL,

      icon TEXT NOT NULL DEFAULT 'Folder',
      color TEXT NOT NULL DEFAULT '#6366f1',
      description TEXT,

      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,

      UNIQUE(company_id, folder),
      UNIQUE(company_id, parent_id, name)
    );

CREATE TABLE client_activity (
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      client_version TEXT,
      client_platform TEXT,
      last_seen_at TEXT,
      last_fetch_at TEXT,
      last_push_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, company_id)
    );

CREATE TABLE scopes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('company', 'department', 'folder')),
      department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
      repo_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(company_id, path)
    );

CREATE TABLE scope_rules (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'role', 'user')),
      subject_id TEXT,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

CREATE TABLE department_managers (
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (department_id, user_id)
    );

CREATE TABLE push_rejections (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      paths TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

CREATE TABLE orphaned_scopes (
      scope_id TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      detected_at TEXT NOT NULL,
      commit_id TEXT NOT NULL
    );

CREATE TABLE scope_repos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

CREATE TABLE company_path_salts (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

CREATE TABLE private_folder_archives (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('delete', 'make-public')),
      file TEXT NOT NULL,
      head TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

CREATE TABLE agent_events (
      seq INTEGER PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      at TEXT NOT NULL,
      client_at TEXT NOT NULL,
      at_adjusted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      duration_ms INTEGER,
      conversation_id TEXT,
      turn_id TEXT,
      department TEXT,
      department_key TEXT,
      agent TEXT NOT NULL,
      model TEXT,
      subagent_type TEXT,
      tool TEXT NOT NULL,
      category TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      target_text TEXT NOT NULL DEFAULT '',
      target_roots TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      guard_reason TEXT,
      outcome TEXT,
      client_version TEXT, sandbox TEXT, skill TEXT,
      UNIQUE (company_id, id)
    );

CREATE TABLE agent_event_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      retention_days INTEGER NOT NULL DEFAULT 180,
      viewers TEXT NOT NULL DEFAULT 'admins' CHECK (viewers IN ('admins', 'admins-and-managers')),
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

CREATE TABLE agent_event_settings_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT NOT NULL
    );

CREATE TABLE agent_sandbox_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

CREATE TABLE agent_sandbox_overrides (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('off', 'observe', 'enforce')),
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );

CREATE TABLE agent_sandbox_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      change TEXT NOT NULL
    );

CREATE TABLE agent_stops (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT,
      tool TEXT CHECK (tool IS NULL OR tool IN ('command', 'write', 'web', 'mcp-external')),
      reason TEXT NOT NULL DEFAULT '',
      stopped_at TEXT NOT NULL,
      stopped_by TEXT NOT NULL,
      released_at TEXT,
      released_by TEXT
    );

CREATE TABLE agent_stop_clients (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      client_version TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );

CREATE TABLE broker_keys (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('company', 'user')),
      owner_user_id TEXT,
      service TEXT NOT NULL,
      display_name TEXT NOT NULL,
      last4 TEXT NOT NULL,
      cipher_scheme TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      tag TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      kek_id TEXT NOT NULL,
      destinations TEXT NOT NULL,
      audience TEXT NOT NULL,
      caps TEXT NOT NULL,
      allow_private_content INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      secret_updated_at TEXT NOT NULL,
      CHECK ((scope = 'company') = (owner_user_id IS NULL))
    );

CREATE TABLE broker_services (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      service TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('person', 'tool', 'system')),
      rule TEXT NOT NULL CHECK (rule IN ('company-only', 'user-only', 'company-first')),
      own_key_hosts TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL, relay TEXT,
      PRIMARY KEY (company_id, service)
    );

CREATE TABLE broker_usage (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, key_id, user_id, day)
    );

CREATE TABLE broker_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      member_keys_allowed INTEGER NOT NULL,
      -- JSON array of hosts the relay may reach although they resolve to a
      -- private / internal address (the admin's explicit exception, K4).
      internal_hosts TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

CREATE TABLE broker_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      key_id TEXT,
      action TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      change TEXT NOT NULL
    );

CREATE TABLE broker_tokens (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      services TEXT NOT NULL,
      department TEXT,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

CREATE INDEX idx_agent_events_company_at ON agent_events(company_id, at);

CREATE INDEX idx_agent_events_company_user_at ON agent_events(company_id, user_id, at);

CREATE INDEX idx_agent_events_company_conversation_at ON agent_events(company_id, conversation_id, at);

CREATE INDEX idx_agent_event_settings_history_company ON agent_event_settings_history(company_id, changed_at);

CREATE INDEX idx_agent_sandbox_history_company ON agent_sandbox_history(company_id, changed_at);

CREATE INDEX idx_agent_stops_company ON agent_stops(company_id, released_at, stopped_at);

CREATE INDEX idx_broker_keys_company ON broker_keys(company_id, service);

CREATE INDEX idx_broker_history_company ON broker_history(company_id, changed_at);

CREATE INDEX idx_broker_tokens_member ON broker_tokens(company_id, user_id, expires_at);

CREATE INDEX idx_broker_tokens_expires ON broker_tokens(expires_at);

CREATE INDEX idx_scope_repos_company_id ON scope_repos(company_id);

CREATE INDEX idx_scopes_department_id ON scopes(department_id);

CREATE INDEX idx_scope_rules_scope_id ON scope_rules(scope_id);

CREATE INDEX idx_department_managers_user_id ON department_managers(user_id);

CREATE INDEX idx_push_rejections_company_created ON push_rejections(company_id, created_at);

CREATE INDEX idx_client_activity_company_id ON client_activity(company_id);

CREATE INDEX idx_memberships_user_id ON memberships(user_id);

CREATE INDEX idx_memberships_company_id ON memberships(company_id);

CREATE INDEX idx_ssh_keys_user_id ON ssh_keys(user_id);

CREATE INDEX idx_ssh_keys_fingerprint ON ssh_keys(fingerprint);

CREATE INDEX idx_invitations_token ON invitations(token);

CREATE INDEX idx_invitations_company_id ON invitations(company_id);

CREATE INDEX idx_departments_company_id ON departments(company_id);

CREATE INDEX idx_departments_parent_id ON departments(parent_id);

CREATE UNIQUE INDEX idx_departments_company_folder ON departments(company_id, folder);

CREATE INDEX idx_agent_events_company_sandbox ON agent_events(company_id, at) WHERE sandbox IS NOT NULL OR guard_reason IN ('denied-read', 'sandbox');
