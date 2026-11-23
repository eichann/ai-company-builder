/**
 * A business plugin's steps (plan C5, `.claude/rules/plugin-steps.md`): what
 * each work is pinned to for a step (its first run's procedure), and the
 * company's choice of one of its Skills as an overridable step's procedure.
 * Part of the one schema run by db/index.ts initDatabase. Behind the company
 * handle (ports/plugin-steps.ts).
 */
import type Database from 'better-sqlite3'

export const pluginStepSchema = `
    -- One pin per record × plugin step, written at the step's first run (claim or a person's start).
    CREATE TABLE IF NOT EXISTS plugin_step_pins (
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
    CREATE INDEX IF NOT EXISTS idx_plugin_step_pins_plugin ON plugin_step_pins(company_id, plugin_id);

    -- A member's consultation started from a \`start: person\` step: its AI's plugin power is that step's, for good.
    CREATE TABLE IF NOT EXISTS plugin_step_consultations (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, conversation_id)
    );

    -- The company's Skill for an overridable step (owner / admin; the plugin's own procedure when absent).
    CREATE TABLE IF NOT EXISTS plugin_step_skills (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      skill TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, step)
    );

    -- How the company runs a step (owner decisions 2026-11-06): 「自動で始める」 for a \`start: person\` step
    -- (absent = the button) and the step's deliverable folder under <department>/.personal/ (absent = from its label).
    CREATE TABLE IF NOT EXISTS plugin_step_settings (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      auto_start INTEGER NOT NULL DEFAULT 0 CHECK (auto_start IN (0, 1)),
      deliverable_folder TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (company_id, plugin_id, step)
    );

    -- A person's step the company starts automatically waits for a reason: a meeting of its まとまり was read.
    -- One row per record × step; a later meeting asks again (done_at cleared), a finished run answers it.
    CREATE TABLE IF NOT EXISTS plugin_step_requests (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      step TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      meeting_id TEXT,
      done_at TEXT,
      PRIMARY KEY (company_id, record_id, plugin_id, step)
    );
`

/**
 * Who closed a step's request without a run (4b-4 PR1, jobs.md "The set watch (schema 5)"): `done_by_job` — the scheduled job
 * whose approval closed it because that job takes over the same Skill (「定期の仕事が受け持つため閉じました」); null for a request
 * a finished run answered. Additive: an older build neither reads nor writes it (a request such a build opens again keeps the
 * value, which then only says that a job once closed it).
 */
export function migratePluginStepRequestCloser(conn: Database.Database): void {
  const cols = new Set((conn.prepare('PRAGMA table_info(plugin_step_requests)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('done_by_job')) conn.exec('ALTER TABLE plugin_step_requests ADD COLUMN done_by_job TEXT')
}
