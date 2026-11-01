import type Database from 'better-sqlite3'

/**
 * The Slack connection (stage 3 A2, slack-connector.md). Not yet part of the
 * one schema run by db/index.ts initDatabase: A3 adds `slackSchema` there
 * (below the lane A marker of S2). Idempotent, unnumbered; columns added later
 * get a check-then-ALTER like the other schema modules.
 *
 * Members' grants live in connector_grants / oauth_pending (provider 'slack').
 * No message body is stored anywhere: only the event ids already received.
 */
export const slackSchema = `
    -- The company's Slack app (an internal app each company creates in its own
    -- workspace). Secrets only sealed by the key broker's vault (purpose
    -- acb-slack-app, bound to the company and the secret's name).
    CREATE TABLE IF NOT EXISTS slack_apps (
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

    -- Which Slack user signed in with which address (written when a member's
    -- 「Slack で許可」 is checked). It is used only together with an active grant
    -- whose account is that address, so a row left behind serves nobody.
    CREATE TABLE IF NOT EXISTS slack_accounts (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      slack_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (company_id, slack_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_accounts_email ON slack_accounts(company_id, email);

    -- Event ids already received (Slack re-sends an event it thinks was missed).
    CREATE TABLE IF NOT EXISTS slack_events_seen (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (company_id, event_id)
    );

    -- Every change of the app and its switch (JSON without any secret).
    CREATE TABLE IF NOT EXISTS slack_history (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      user_id TEXT,
      at TEXT NOT NULL,
      by_user TEXT NOT NULL,
      change TEXT NOT NULL
    );
`

/** Creates the Slack tables (idempotent): what initDatabase will run once A3 lists `slackSchema`; tests run it now. */
export function initSlackSchema(conn: Database.Database): void {
  conn.exec(slackSchema)
}
