/**
 * Drafts of a company Skill made from a member's own 「ブラウザ操作」 recordings (agent-browser.md "A Skill's draft from a
 * recording", PR 2 of 4). Behind the company handle (ports/browser-skill-drafts.ts). **A new table only.**
 *
 * - One row per draft, its author's alone (`user_id`): no other person — owners and admins included — lists, reads,
 *   changes or deletes it until it is requested (a later PR).
 * - `base_declaration` / `base_notes` are what the server made from the recordings it stored (`browserSkillDraftFrom`):
 *   fixed by trigger, so a later change of `declaration` can always be checked against them (never wider).
 * - `recording_ids` names the recordings it was made from (a JSON list); they go after 30 days, the names stay.
 * - `version` = sha256 of the canonical JSON of `{ name, declaration, steps }`; every change is a compare-and-set on it.
 * - `delete_at` = the last change (or trial, a later PR) + 30 days: every read leaves out a row past it and the server
 *   clock deletes it.
 */
export const browserSkillDraftSchema = `
    CREATE TABLE IF NOT EXISTS browser_skill_drafts (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      recording_ids TEXT NOT NULL,
      base_declaration TEXT NOT NULL,
      base_notes TEXT NOT NULL,
      declaration TEXT NOT NULL,
      steps TEXT NOT NULL,
      version TEXT NOT NULL CHECK (version GLOB 'sha256:*'),
      tried_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delete_at TEXT NOT NULL,
      PRIMARY KEY (company_id, id),
      CHECK (delete_at > updated_at),
      CHECK (length(CAST(steps AS BLOB)) <= 32768)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_skill_drafts_name ON browser_skill_drafts(company_id, user_id, name);
    CREATE INDEX IF NOT EXISTS idx_browser_skill_drafts_user ON browser_skill_drafts(company_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_browser_skill_drafts_delete ON browser_skill_drafts(company_id, delete_at);
    CREATE TRIGGER IF NOT EXISTS browser_skill_drafts_fixed BEFORE UPDATE ON browser_skill_drafts
      WHEN NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
        OR NEW.domain IS NOT OLD.domain OR NEW.recording_ids IS NOT OLD.recording_ids
        OR NEW.base_declaration IS NOT OLD.base_declaration OR NEW.base_notes IS NOT OLD.base_notes
        OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'a draft keeps its author, domain, recordings and what they gave');
    END;
`
