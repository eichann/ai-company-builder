-- app.sqlite schema as created by initDatabase() before scheduled jobs (B "separating AI runs from
-- records" PR 3a), at origin/main d973d9bf (PR #668). No ai_jobs / ai_job_versions /
-- ai_job_occurrences / ai_job_settings yet. Frozen: do not update. Test: tests/unit/jobs-schema.test.ts.
CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- The shared company folder (shared/core/company-folder.ts): git = repository + sync, none = no folder.
      folder_kind TEXT NOT NULL DEFAULT 'git' CHECK (folder_kind IN ('git', 'none'))
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
    , signup_claimed_at TEXT, signup_user_id TEXT, department_ids TEXT NOT NULL DEFAULT '[]');
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
      subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'role', 'department', 'group', 'user')),
      subject_id TEXT,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT
    , company_id TEXT REFERENCES companies(id) ON DELETE CASCADE);
CREATE TABLE department_managers (
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT, company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
      PRIMARY KEY (department_id, user_id)
    );
CREATE TABLE skill_editors (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );
CREATE TABLE skill_editing_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      everyone INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
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
CREATE TABLE member_groups (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      -- NFC + A–Z folded (shared/core/paths.ts nameKey): one name once per company.
      name_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      UNIQUE(company_id, name_key)
    );
CREATE TABLE member_group_members (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_id, user_id)
    );
CREATE TABLE permission_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
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
      updated_by TEXT NOT NULL, relay TEXT, read_only INTEGER NOT NULL DEFAULT 0, read_only_set INTEGER NOT NULL DEFAULT 0, default_key_id TEXT,
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
CREATE TABLE record_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    , minutes_folder TEXT, content_store INTEGER, meeting_intake TEXT, meeting_bundle_days INTEGER);
CREATE TABLE record_types (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('file', 'core', 'plugin')),
      commit_sha TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, name, version)
    );
CREATE TABLE records (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      type_version INTEGER,
      scope_id TEXT,
      path TEXT,
      folder TEXT,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      removed_at TEXT, personal_owner TEXT,
      PRIMARY KEY (company_id, id)
    );
CREATE TABLE record_links (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      target_id TEXT,
      target_path TEXT, created_by TEXT, target_meta TEXT,
      PRIMARY KEY (company_id, source_id, name, position)
    );
CREATE TABLE record_state (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      state TEXT,
      fields TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id)
    );
CREATE TABLE record_ledger (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai', 'external')),
      actor_source TEXT,
      at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      changes TEXT NOT NULL DEFAULT '[]',
      attachments TEXT NOT NULL DEFAULT '[]',
      decision TEXT,
      is_decision INTEGER NOT NULL DEFAULT 0,
      type_version INTEGER,
      reverses_version INTEGER, proposed_by TEXT, conversation_id TEXT, receipt TEXT, on_behalf_of TEXT, run_id TEXT, procedure TEXT, skills TEXT, via TEXT,
      PRIMARY KEY (company_id, record_id, version)
    );
CREATE TABLE record_turn_opens (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      turn_version INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id, turn_version)
    );
CREATE TABLE record_ai_tokens (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL CHECK (scope IN ('read', 'act')),
      agent TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    , run_id TEXT, run_generation INTEGER);
CREATE TABLE record_index_heads (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (company_id, repo)
    );
CREATE TABLE record_index_problems (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      found_at TEXT NOT NULL,
      PRIMARY KEY (company_id, repo, path, kind)
    );
CREATE TABLE plugin_installs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      -- The key broker's service the plugin talks to (kept even if the package leaves the shelf).
      service TEXT NOT NULL,
      -- The connection (review §5.7): a new id when the outside account changes; a key
      -- rotation keeps it. account_id = the outside account (HubSpot portal id), set by
      -- the connector on its first call; null until then.
      connection_id TEXT NOT NULL,
      account_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      -- First turned on: from then on the relay never writes to the service for this
      -- company (turning the plugin off does not undo it; plugins.md).
      managed_since TEXT,
      -- A deleted key leaves the plugin without one (problem no-key), never blocks the delete.
      key_id TEXT REFERENCES broker_keys(id) ON DELETE SET NULL,
      mapping_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id)
    );
CREATE TABLE plugin_access_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      call TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT,
      refs TEXT NOT NULL,
      status TEXT NOT NULL,
      dropped INTEGER NOT NULL DEFAULT 0,
      at TEXT NOT NULL
    );
CREATE TABLE plugin_call_paced (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (company_id, plugin_id, user_id, hour)
    );
CREATE TABLE plugin_mappings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, version),
      FOREIGN KEY (company_id, plugin_id) REFERENCES plugin_installs(company_id, plugin_id)
    );
CREATE TABLE plugin_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );
CREATE TABLE plugin_external_links (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      object TEXT NOT NULL,
      external_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      external_updated_at TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, connection_id, account_id, object, external_id),
      UNIQUE (company_id, record_id),
      FOREIGN KEY (company_id, record_id) REFERENCES records(company_id, id)
    );
CREATE TABLE plugin_read_scopes (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('department', 'user')),
      subject_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, connection_id, subject_type, subject_id),
      FOREIGN KEY (company_id, plugin_id) REFERENCES plugin_installs(company_id, plugin_id)
    );
CREATE TABLE plugin_policy_acks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      field TEXT NOT NULL,
      property TEXT NOT NULL,
      acknowledged_by TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, field)
    );
CREATE TABLE plugin_operations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      mapping_version INTEGER NOT NULL,
      connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      object TEXT NOT NULL,
      external_id TEXT,
      record_id TEXT,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai')),
      actor_source TEXT,
      conversation_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent-unknown', 'external-ok', 'applied', 'observed', 'failed')),
      fields TEXT NOT NULL,
      written TEXT NOT NULL,
      previous TEXT NOT NULL,
      reason TEXT,
      undo_of TEXT,
      undone_by TEXT,
      record_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      replaced_by TEXT,
      approved_by TEXT, run_id TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, record_id) REFERENCES records(company_id, id)
    );
CREATE TABLE google_oauth_clients (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      secret_last4 TEXT NOT NULL,
      client_secret_sealed TEXT NOT NULL,
      domain TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    , picker_api_key TEXT, picker_app_id TEXT, features_off TEXT NOT NULL DEFAULT '[]', features_on TEXT NOT NULL DEFAULT '[]', relay TEXT NOT NULL DEFAULT '{}');
CREATE TABLE connector_grants (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
      grant_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      scopes TEXT NOT NULL,
      features_off TEXT NOT NULL DEFAULT '[]',
      refresh_token_sealed TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'stopped')),
      status_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (company_id, user_id, provider),
      CHECK (status = 'active' OR refresh_token_sealed IS NULL)
    );
CREATE TABLE oauth_pending (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      state_hash TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'slack')),
      user_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      verifier_sealed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (company_id, state_hash)
    );
CREATE TABLE connector_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      user_id TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );
CREATE TABLE google_drive_picks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      picked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, file_id)
    );
CREATE TABLE google_drive_puts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ai', 'person')),
      conversation_id TEXT,
      run_id TEXT,
      folder_id TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sending', 'done', 'unknown')),
      file_id TEXT,
      revision_id TEXT,
      link TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT, skills TEXT,
      UNIQUE (company_id, user_id, request_key)
    );
CREATE TABLE connector_role_choices (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, role)
    );
CREATE TABLE connector_setup_seen (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      seen TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, provider)
    );
CREATE TABLE fixed_payloads (
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
CREATE TABLE task_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
CREATE TABLE company_features (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      features TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
CREATE TABLE department_members (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (department_id, user_id)
    );
CREATE TABLE member_absences (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_day TEXT NOT NULL,
      until_day TEXT NOT NULL,
      delegate_id TEXT NOT NULL,
      set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, removed_at TEXT, removed_by TEXT,
      PRIMARY KEY (company_id, id)
    );
CREATE TABLE admin_setup_marks (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      mark TEXT NOT NULL,
      done_at TEXT NOT NULL,
      done_by TEXT NOT NULL,
      PRIMARY KEY (company_id, mark)
    );
CREATE TABLE record_contents (
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
CREATE TABLE outbound_mails (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      from_email TEXT NOT NULL,
      minutes_id TEXT,
      deal_id TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      body_deleted_at TEXT,
      PRIMARY KEY (company_id, message_id)
    );
CREATE TABLE outbound_mail_versions (
      company_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'ai')),
      created_at TEXT NOT NULL, attachments_json TEXT,
      PRIMARY KEY (company_id, message_id, version),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );
CREATE TABLE outbound_typed_recipients (
      company_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (company_id, message_id, ref),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );
CREATE TABLE outbound_sends (
      company_id TEXT NOT NULL,
      id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      by_user TEXT NOT NULL,
      started_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'sent', 'unknown', 'not-sent', 'refused')),
      reason TEXT,
      provider_message_id TEXT,
      finished_at TEXT, source_key TEXT, resend_reason TEXT,
      PRIMARY KEY (company_id, id),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );
CREATE TABLE outbound_mail_attachments (
      company_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      name TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      content_type TEXT NOT NULL CHECK (content_type = 'application/pdf'),
      bytes BLOB,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      bytes_deleted_at TEXT,
      PRIMARY KEY (company_id, message_id, sha256),
      FOREIGN KEY (company_id, message_id) REFERENCES outbound_mails(company_id, message_id) ON DELETE CASCADE
    );
CREATE TABLE notifications (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_version INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_kind TEXT CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'ai', 'external')),
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT, for_user_id TEXT,
      PRIMARY KEY (company_id, id)
    );
CREATE TABLE notification_settings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      kinds TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );
CREATE TABLE ai_runs (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      step TEXT NOT NULL,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'open', 'retry_later', 'waiting_setup', 'waiting_person', 'waiting_reconcile', 'done')),
      generation INTEGER NOT NULL,
      device_id TEXT,
      conversation_id TEXT,
      claim_expires_at TEXT,
      failure_class TEXT,
      failure_code TEXT,
      retry_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      plugin_version TEXT,
      steps_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT, procedure TEXT, subject_kind TEXT NOT NULL DEFAULT 'record', grant_fingerprint TEXT,
      PRIMARY KEY (company_id, id)
    );
CREATE TABLE ai_run_operations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('in_progress', 'done', 'unknown', 'not_done')),
      generation INTEGER NOT NULL,
      ref_kind TEXT,
      ref_id TEXT,
      status INTEGER,
      reconciled_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, run_id, key),
      FOREIGN KEY (company_id, run_id) REFERENCES ai_runs(company_id, id) ON DELETE CASCADE
    );
CREATE TABLE consultation_skill_uses (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      tree TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      first_used_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, conversation_id, skill, tree, dirty)
    );
CREATE TABLE security_alerts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      user_id TEXT,
      facts TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (company_id, dedupe_key)
    );
CREATE TABLE security_alert_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      slack_dm INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
CREATE TABLE member_download_hours (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      hour TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, user_id, hour)
    );
CREATE TABLE shelf_items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('skill', 'instructions', 'rule')),
      department_id TEXT REFERENCES departments(id),
      name TEXT NOT NULL,
      current_version TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      changed_by TEXT NOT NULL
    );
CREATE TABLE shelf_versions (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES shelf_items(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      files TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      autorun INTEGER NOT NULL DEFAULT 0 CHECK (autorun IN (0, 1)),
      published_at TEXT NOT NULL,
      published_by TEXT NOT NULL,
      PRIMARY KEY (item_id, version)
    );
CREATE TABLE shelf_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES shelf_items(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'unpublish', 'remove-version')),
      version TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
    , requested_by TEXT);
CREATE TABLE shelf_requests (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT REFERENCES departments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      version TEXT NOT NULL,
      files TEXT,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      autorun INTEGER NOT NULL DEFAULT 0 CHECK (autorun IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'declined')),
      decided_by TEXT,
      decided_at TEXT,
      reason TEXT,
      published_version TEXT
    );
CREATE TABLE slack_apps (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret_sealed TEXT NOT NULL,
      client_secret_last4 TEXT NOT NULL,
      signing_secret_sealed TEXT NOT NULL,
      bot_token_sealed TEXT,
      bot_user_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
CREATE TABLE slack_accounts (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      slack_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, slack_user_id)
    );
CREATE TABLE slack_events_seen (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (company_id, event_id)
    );
CREATE TABLE slack_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      user_id TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );
CREATE TABLE identities (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('company', 'person')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id)
    );
CREATE TABLE identity_members (
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
CREATE TABLE identity_proposals (
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
CREATE TABLE identity_history (
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
CREATE TABLE inbox_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
CREATE TABLE inbox_messages (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
      message_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      occurred_at TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      -- The connector's opaque pointer to this message (the AI reads it again on demand, B4).
      source_ref TEXT,
      -- Whose mailbox the pointer is in (the member who reported it; NULL before 2026-11-05).
      reporter_id TEXT,
      PRIMARY KEY (company_id, channel, message_id)
    );
CREATE TABLE inbox_connections (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
      connected_at TEXT NOT NULL,
      checked_until TEXT NOT NULL,
      -- Where the source's change log was last read (mail that left the inbox; NULL: not yet).
      left_cursor TEXT,
      PRIMARY KEY (company_id, user_id, channel)
    );
CREATE TABLE inbox_archived (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      interaction_id TEXT NOT NULL,
      entry_version INTEGER NOT NULL,
      source_refs TEXT NOT NULL,
      PRIMARY KEY (company_id, interaction_id, entry_version)
    );
CREATE TABLE inbox_gaps (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      gap_from TEXT NOT NULL,
      gap_to TEXT NOT NULL,
      noted_at TEXT NOT NULL
    );
CREATE TABLE plugin_step_pins (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('plugin', 'company_skill')),
      -- source plugin: the version + its v2 fingerprint; company_skill: the Skill's name + its tree id.
      version TEXT,
      skill TEXT,
      fingerprint TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id, plugin_id, step)
    );
CREATE TABLE plugin_step_consultations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, conversation_id)
    );
CREATE TABLE plugin_step_skills (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      skill TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, step)
    );
CREATE TABLE plugin_step_settings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0, 1)),
      deliverable_folder TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, step)
    );
CREATE TABLE plugin_step_requests (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      meeting_id TEXT,
      done_at TEXT,
      PRIMARY KEY (company_id, record_id, plugin_id, step)
    );
CREATE TABLE plugin_role_assignments (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      -- JSON array of member ids (at most 20).
      user_ids TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, role)
    );
CREATE TABLE plugin_role_overrides (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      user_ids TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, role, bundle_id)
    );
CREATE TABLE plugin_role_history (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      role TEXT NOT NULL,
      -- NULL: the company's assignment; else the まとまり whose override changed.
      bundle_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('assign', 'override', 'clear-override')),
      user_ids TEXT NOT NULL,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL
    );
CREATE TABLE record_viewers (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id, user_id)
    );
CREATE TABLE meeting_auto_series (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      series_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, series_key)
    );
CREATE TABLE meeting_events (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      record_id TEXT,
      private INTEGER NOT NULL DEFAULT 0,
      tries INTEGER NOT NULL DEFAULT 0,
      next_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, event_key)
    );
CREATE TABLE second_opinion_settings (
        company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
CREATE TABLE ai_run_events (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('claimed', 'finished', 'given_back', 'reconciled', 'refused_stopped')),
      generation INTEGER NOT NULL,
      state_after TEXT,
      code TEXT CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 60 AND code NOT GLOB '*[^A-Z0-9_]*')),
      PRIMARY KEY (company_id, run_id, seq),
      FOREIGN KEY (company_id, run_id) REFERENCES ai_runs(company_id, id) ON DELETE CASCADE
    );
CREATE TABLE record_viewer_sets (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('group', 'department')),
      subject_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      added_by TEXT NOT NULL,
      PRIMARY KEY (company_id, record_id, subject_type, subject_id)
    );
CREATE TABLE member_work_switches (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      choices TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id)
    );
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
CREATE UNIQUE INDEX idx_skill_editors_company ON skill_editors(company_id, user_id) WHERE department_id IS NULL;
CREATE UNIQUE INDEX idx_skill_editors_department ON skill_editors(company_id, department_id, user_id) WHERE department_id IS NOT NULL;
CREATE INDEX idx_member_group_members_company_user ON member_group_members(company_id, user_id);
CREATE INDEX idx_permission_history_company ON permission_history(company_id, seq);
CREATE INDEX idx_scope_repos_company_id ON scope_repos(company_id);
CREATE INDEX idx_scopes_department_id ON scopes(department_id);
CREATE INDEX idx_scope_rules_scope_id ON scope_rules(scope_id);
CREATE INDEX idx_department_managers_user_id ON department_managers(user_id);
CREATE INDEX idx_push_rejections_company_created ON push_rejections(company_id, created_at);
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
CREATE INDEX idx_records_company_type ON records(company_id, type);
CREATE INDEX idx_records_company_path ON records(company_id, path);
CREATE INDEX idx_record_links_target ON record_links(company_id, target_id);
CREATE INDEX idx_record_links_path ON record_links(company_id, target_path);
CREATE INDEX idx_record_ledger_company_at ON record_ledger(company_id, at);
CREATE INDEX idx_record_ai_tokens_member ON record_ai_tokens(company_id, user_id, expires_at);
CREATE INDEX idx_plugin_access_log ON plugin_access_log(company_id, plugin_id, at);
CREATE INDEX idx_plugin_operations_record ON plugin_operations(company_id, record_id, created_at);
CREATE INDEX idx_plugin_history_company ON plugin_history(company_id, plugin_id, at);
CREATE INDEX idx_connector_history_company ON connector_history(company_id, at);
CREATE INDEX idx_oauth_pending_expires ON oauth_pending(company_id, expires_at);
CREATE INDEX idx_department_members_company_user ON department_members(company_id, user_id);
CREATE INDEX idx_member_absences_company_until ON member_absences(company_id, until_day);
CREATE INDEX idx_record_contents_record ON record_contents(company_id, record_id);
CREATE INDEX idx_record_contents_hash ON record_contents(company_id, hash);
CREATE INDEX idx_record_contents_expires ON record_contents(company_id, expires_at) WHERE expires_at IS NOT NULL AND erased_at IS NULL;
CREATE INDEX idx_outbound_sends_message ON outbound_sends(company_id, message_id, started_at);
CREATE INDEX idx_outbound_mails_finished ON outbound_mails(company_id, finished_at);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(company_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_notifications_member ON notifications(company_id, user_id, created_at);
CREATE UNIQUE INDEX idx_ai_runs_open ON ai_runs(company_id, record_id, step) WHERE closed_at IS NULL;
CREATE INDEX idx_ai_runs_user ON ai_runs(company_id, user_id, closed_at);
CREATE INDEX idx_security_alerts_company ON security_alerts(company_id, created_at);
CREATE UNIQUE INDEX shelf_items_place ON shelf_items(company_id, kind, IFNULL(department_id, ''), name);
CREATE INDEX shelf_versions_company ON shelf_versions(company_id);
CREATE INDEX shelf_history_item ON shelf_history(company_id, item_id);
CREATE UNIQUE INDEX shelf_requests_place ON shelf_requests(company_id, requested_by, IFNULL(department_id, ''), name);
CREATE INDEX idx_slack_accounts_email ON slack_accounts(company_id, email);
CREATE INDEX idx_identity_members_identity ON identity_members(company_id, identity_id);
CREATE INDEX idx_identity_members_email ON identity_members(company_id, email);
CREATE INDEX idx_identity_members_domain ON identity_members(company_id, domain);
CREATE INDEX idx_identity_proposals_status ON identity_proposals(company_id, status);
CREATE INDEX idx_identity_history_record ON identity_history(company_id, record_id);
CREATE INDEX idx_inbox_messages_interaction ON inbox_messages(company_id, interaction_id);
CREATE INDEX idx_inbox_gaps_user ON inbox_gaps(company_id, user_id);
CREATE INDEX idx_plugin_step_pins_plugin ON plugin_step_pins(company_id, plugin_id);
CREATE INDEX idx_plugin_role_history ON plugin_role_history(company_id, plugin_id, role);
CREATE INDEX idx_record_viewers_user ON record_viewers(company_id, user_id);
CREATE INDEX idx_agent_events_company_sandbox ON agent_events(company_id, at) WHERE sandbox IS NOT NULL OR guard_reason IN ('denied-read', 'sandbox');
CREATE UNIQUE INDEX idx_ai_runs_open_subject ON ai_runs(company_id, subject_kind, record_id, step) WHERE closed_at IS NULL;
CREATE INDEX idx_outbound_sends_source ON outbound_sends(company_id, source_key);
CREATE INDEX idx_scope_rules_company ON scope_rules(company_id, scope_id);
CREATE INDEX idx_department_managers_company ON department_managers(company_id, user_id);
CREATE INDEX idx_record_viewer_sets_subject ON record_viewer_sets(company_id, subject_type, subject_id);
CREATE TRIGGER skill_editors_company_insert BEFORE INSERT ON skill_editors
    WHEN NEW.department_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'skill_editors.company_id must be the company of its department'); END;
CREATE TRIGGER member_group_members_company_insert BEFORE INSERT ON member_group_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM member_groups WHERE id = NEW.group_id)
    BEGIN SELECT RAISE(ABORT, 'member_group_members.company_id must be the company of its group'); END;
CREATE TRIGGER member_group_members_company_update BEFORE UPDATE OF company_id, group_id ON member_group_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM member_groups WHERE id = NEW.group_id)
    BEGIN SELECT RAISE(ABORT, 'member_group_members.company_id must be the company of its group'); END;
CREATE TRIGGER permission_history_no_update BEFORE UPDATE ON permission_history
    BEGIN SELECT RAISE(ABORT, 'permission_history is append-only'); END;
CREATE TRIGGER plugin_access_log_no_update BEFORE UPDATE ON plugin_access_log
    BEGIN SELECT RAISE(ABORT, 'plugin_access_log is append-only'); END;
CREATE TRIGGER plugin_access_log_no_delete BEFORE DELETE ON plugin_access_log
    WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days') AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_access_log is append-only'); END;
CREATE TRIGGER department_members_company_insert BEFORE INSERT ON department_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'department_members.company_id must be the company of its department'); END;
CREATE TRIGGER department_members_company_update BEFORE UPDATE OF company_id, department_id ON department_members
    WHEN NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'department_members.company_id must be the company of its department'); END;
CREATE TRIGGER shelf_items_department_company BEFORE INSERT ON shelf_items
    WHEN NEW.department_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_items.company_id must be the company of its department'); END;
CREATE TRIGGER shelf_versions_company BEFORE INSERT ON shelf_versions
    WHEN NEW.company_id IS NOT (SELECT company_id FROM shelf_items WHERE id = NEW.item_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_versions.company_id must be the company of its item'); END;
CREATE TRIGGER shelf_history_company BEFORE INSERT ON shelf_history
    WHEN NEW.company_id IS NOT (SELECT company_id FROM shelf_items WHERE id = NEW.item_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_history.company_id must be the company of its item'); END;
CREATE TRIGGER shelf_history_no_update BEFORE UPDATE ON shelf_history
    BEGIN SELECT RAISE(ABORT, 'shelf_history is append-only'); END;
CREATE TRIGGER shelf_requests_department_company BEFORE INSERT ON shelf_requests
    WHEN NEW.department_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
    BEGIN SELECT RAISE(ABORT, 'shelf_requests.company_id must be the company of its department'); END;
CREATE TRIGGER plugin_role_history_no_update BEFORE UPDATE ON plugin_role_history
    BEGIN SELECT RAISE(ABORT, 'plugin_role_history is append-only'); END;
CREATE TRIGGER plugin_installs_key_insert BEFORE INSERT ON plugin_installs
    WHEN NEW.key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM broker_keys WHERE id = NEW.key_id AND company_id = NEW.company_id AND scope = 'company')
    BEGIN SELECT RAISE(ABORT, 'plugin_installs.key_id must be a company key of the same company'); END;
CREATE TRIGGER plugin_installs_key_update BEFORE UPDATE OF key_id ON plugin_installs
    WHEN NEW.key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM broker_keys WHERE id = NEW.key_id AND company_id = NEW.company_id AND scope = 'company')
    BEGIN SELECT RAISE(ABORT, 'plugin_installs.key_id must be a company key of the same company'); END;
CREATE TRIGGER plugin_installs_company_update BEFORE UPDATE OF company_id ON plugin_installs
    WHEN NEW.company_id IS NOT OLD.company_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
CREATE TRIGGER plugin_mappings_company_insert BEFORE INSERT ON plugin_mappings
    WHEN NOT EXISTS (SELECT 1 FROM plugin_installs WHERE company_id = NEW.company_id AND plugin_id = NEW.plugin_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_mappings needs the install of the same company'); END;
CREATE TRIGGER plugin_mappings_company_update BEFORE UPDATE OF company_id, plugin_id ON plugin_mappings
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.plugin_id IS NOT OLD.plugin_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
CREATE TRIGGER plugin_read_scopes_subject_insert BEFORE INSERT ON plugin_read_scopes
    WHEN (NEW.subject_type = 'department' AND NOT EXISTS (SELECT 1 FROM departments WHERE company_id = NEW.company_id AND id = NEW.subject_id))
      OR (NEW.subject_type = 'user' AND NOT EXISTS (SELECT 1 FROM memberships WHERE company_id = NEW.company_id AND user_id = NEW.subject_id))
    BEGIN SELECT RAISE(ABORT, 'plugin_read_scopes names a department or member of the same company'); END;
CREATE TRIGGER plugin_read_scopes_company_update BEFORE UPDATE ON plugin_read_scopes
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
CREATE TRIGGER plugin_external_links_record_insert BEFORE INSERT ON plugin_external_links
    WHEN NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_external_links needs a record of the same company'); END;
CREATE TRIGGER plugin_external_links_company_update BEFORE UPDATE OF company_id, record_id, connection_id, account_id ON plugin_external_links
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.record_id IS NOT OLD.record_id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.account_id IS NOT OLD.account_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
CREATE TRIGGER plugin_operations_record_insert BEFORE INSERT ON plugin_operations
    WHEN NEW.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id)
    BEGIN SELECT RAISE(ABORT, 'plugin_operations needs a record of the same company'); END;
CREATE TRIGGER plugin_operations_company_update BEFORE UPDATE OF company_id, record_id, external_id, connection_id, account_id, written, previous ON plugin_operations
    WHEN NEW.company_id IS NOT OLD.company_id OR (OLD.record_id IS NOT NULL AND NEW.record_id IS NOT OLD.record_id)
      OR (OLD.external_id IS NOT NULL AND NEW.external_id IS NOT OLD.external_id) OR NEW.connection_id IS NOT OLD.connection_id
      OR NEW.account_id IS NOT OLD.account_id OR NEW.written IS NOT OLD.written OR NEW.previous IS NOT OLD.previous
      OR (NEW.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM records WHERE company_id = NEW.company_id AND id = NEW.record_id))
    BEGIN SELECT RAISE(ABORT, 'an operation record keeps its company, record, outside object, connection and values'); END;
CREATE TRIGGER plugin_history_company_update BEFORE UPDATE OF company_id ON plugin_history
    WHEN NEW.company_id IS NOT OLD.company_id
    BEGIN SELECT RAISE(ABORT, 'plugin rows never move to another company'); END;
CREATE TRIGGER fixed_payloads_immutable BEFORE UPDATE ON fixed_payloads
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.owner_kind IS NOT OLD.owner_kind OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.version IS NOT OLD.version OR NEW.hash IS NOT OLD.hash OR NEW.created_at IS NOT OLD.created_at
      OR (NEW.canonical IS NOT OLD.canonical AND NEW.canonical IS NOT NULL)
      OR (OLD.body_deleted_at IS NOT NULL AND NEW.body_deleted_at IS NOT OLD.body_deleted_at)
    BEGIN SELECT RAISE(ABORT, 'fixed content is never rewritten (only its text cleared by retention)'); END;
CREATE TRIGGER record_contents_immutable BEFORE UPDATE ON record_contents
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.record_id IS NOT OLD.record_id OR NEW.hash IS NOT OLD.hash
      OR NEW.retention_class IS NOT OLD.retention_class OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      OR (NEW.text IS NOT OLD.text AND NEW.text IS NOT NULL)
      OR (OLD.erased_at IS NOT NULL AND (NEW.erased_at IS NOT OLD.erased_at OR NEW.erased_reason IS NOT OLD.erased_reason))
    BEGIN SELECT RAISE(ABORT, 'content is never rewritten (only its text erased)'); END;
CREATE TRIGGER member_absences_append_only BEFORE UPDATE ON member_absences
    WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
      OR NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
      OR NEW.from_day IS NOT OLD.from_day OR NEW.until_day IS NOT OLD.until_day OR NEW.delegate_id IS NOT OLD.delegate_id
      OR NEW.set_by IS NOT OLD.set_by OR NEW.set_at IS NOT OLD.set_at
    BEGIN SELECT RAISE(ABORT, 'member_absences rows are history: only marking a live row removed is allowed'); END;
CREATE TRIGGER scope_rules_company_insert BEFORE INSERT ON scope_rules
      WHEN NEW.company_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM scopes WHERE id = NEW.scope_id)
      BEGIN SELECT RAISE(ABORT, 'scope_rules.company_id must be the company of its scope'); END;
CREATE TRIGGER scope_rules_company_fill AFTER INSERT ON scope_rules
      WHEN NEW.company_id IS NULL
      BEGIN UPDATE scope_rules SET company_id = (SELECT company_id FROM scopes WHERE id = NEW.scope_id) WHERE rowid = NEW.rowid; END;
CREATE TRIGGER scope_rules_company_update BEFORE UPDATE OF company_id, scope_id ON scope_rules
      WHEN NEW.company_id IS NULL OR NEW.company_id IS NOT (SELECT company_id FROM scopes WHERE id = NEW.scope_id)
      BEGIN SELECT RAISE(ABORT, 'scope_rules.company_id must be the company of its scope'); END;
CREATE TRIGGER department_managers_company_insert BEFORE INSERT ON department_managers
      WHEN NEW.company_id IS NOT NULL AND NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
      BEGIN SELECT RAISE(ABORT, 'department_managers.company_id must be the company of its department'); END;
CREATE TRIGGER department_managers_company_fill AFTER INSERT ON department_managers
      WHEN NEW.company_id IS NULL
      BEGIN UPDATE department_managers SET company_id = (SELECT company_id FROM departments WHERE id = NEW.department_id) WHERE rowid = NEW.rowid; END;
CREATE TRIGGER department_managers_company_update BEFORE UPDATE OF company_id, department_id ON department_managers
      WHEN NEW.company_id IS NULL OR NEW.company_id IS NOT (SELECT company_id FROM departments WHERE id = NEW.department_id)
      BEGIN SELECT RAISE(ABORT, 'department_managers.company_id must be the company of its department'); END;
CREATE TRIGGER scope_rules_department_insert BEFORE INSERT ON scope_rules
      WHEN NEW.subject_type = 'department' AND NOT EXISTS (
        SELECT 1 FROM departments WHERE id = NEW.subject_id
          AND company_id = COALESCE(NEW.company_id, (SELECT company_id FROM scopes WHERE id = NEW.scope_id)))
      BEGIN SELECT RAISE(ABORT, 'a department rule names a department of the same company'); END;
CREATE TRIGGER scope_rules_department_update BEFORE UPDATE OF subject_type, subject_id, company_id, scope_id ON scope_rules
      WHEN NEW.subject_type = 'department' AND NOT EXISTS (
        SELECT 1 FROM departments WHERE id = NEW.subject_id AND company_id = NEW.company_id)
      BEGIN SELECT RAISE(ABORT, 'a department rule names a department of the same company'); END;
CREATE TRIGGER scope_rules_group_insert BEFORE INSERT ON scope_rules
      WHEN NEW.subject_type = 'group' AND NOT EXISTS (
        SELECT 1 FROM member_groups WHERE id = NEW.subject_id
          AND company_id = COALESCE(NEW.company_id, (SELECT company_id FROM scopes WHERE id = NEW.scope_id)))
      BEGIN SELECT RAISE(ABORT, 'a group rule names a group of the same company'); END;
CREATE TRIGGER scope_rules_group_update BEFORE UPDATE OF subject_type, subject_id, company_id, scope_id ON scope_rules
      WHEN NEW.subject_type = 'group' AND NOT EXISTS (
        SELECT 1 FROM member_groups WHERE id = NEW.subject_id AND company_id = NEW.company_id)
      BEGIN SELECT RAISE(ABORT, 'a group rule names a group of the same company'); END;
CREATE TRIGGER record_viewer_sets_company_insert BEFORE INSERT ON record_viewer_sets
    WHEN NOT EXISTS (SELECT 1 FROM member_groups WHERE NEW.subject_type = 'group' AND id = NEW.subject_id AND company_id = NEW.company_id)
      AND NOT EXISTS (SELECT 1 FROM departments WHERE NEW.subject_type = 'department' AND id = NEW.subject_id AND company_id = NEW.company_id)
    BEGIN SELECT RAISE(ABORT, 'record_viewer_sets: the group or department must be of the same company'); END;
CREATE TRIGGER record_viewer_sets_no_update BEFORE UPDATE ON record_viewer_sets
    BEGIN SELECT RAISE(ABORT, 'record_viewer_sets rows are added or removed, never changed'); END;
CREATE TRIGGER record_viewer_sets_group_gone AFTER DELETE ON member_groups
    BEGIN DELETE FROM record_viewer_sets WHERE company_id = OLD.company_id AND subject_type = 'group' AND subject_id = OLD.id; END;
CREATE TRIGGER record_viewer_sets_department_gone AFTER DELETE ON departments
    BEGIN DELETE FROM record_viewer_sets WHERE company_id = OLD.company_id AND subject_type = 'department' AND subject_id = OLD.id; END;
