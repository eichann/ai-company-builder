/**
 * A business plugin's steps (plan C5, `.claude/rules/plugin-steps.md`): what
 * each work is pinned to for a step (its first run's procedure), and the
 * company's choice of one of its Skills as an overridable step's procedure.
 * Part of the one schema run by db/index.ts initDatabase. Behind the company
 * handle (ports/plugin-steps.ts).
 */
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
`
